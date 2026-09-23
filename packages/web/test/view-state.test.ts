// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { type ConversationState, parseSessionId, type SessionSummary } from "@axl/sdk";
import { editDiffRows } from "@axl/ui";
import {
  anyModalOverlayOpen,
  compactNumber,
  consumePendingPromptDeliveries,
  directShellInput,
  findSessionInCatalog,
  isScrolledToBottom,
  matchesSession,
  messageBlobs,
  nextSelectableSlashIndex,
  previewSessionSummary,
  type OverlayFlags,
  promptDeliveryShortcut,
  restoreDraft,
  selectableSlashCommand,
  sessionStateHistory,
  sessionTitle,
  sessionUsageStats,
  topLightOverlay,
  transcriptMessageMatches,
  transcriptPromptBreakpoints,
  workspaceTotals,
} from "../src/view-state.ts";

const NO_OVERLAYS: OverlayFlags = {
  requeue: false,
  sessionLifecycle: false,
  newSession: false,
  commandPalette: false,
  transcriptSearch: false,
  usage: false,
  controlCenter: false,
  mobileDock: false,
  sidebar: false,
};

const session = {
  cwd: "/workspace/مرحبا",
  firstUserMessage: "First prompt",
  lastUserMessage: "Fix 🚀 launch",
} as SessionSummary;

test("direct shell input preserves include and exclude semantics", () => {
  assert.deepEqual(directShellInput("! printf once "), {
    command: "printf once",
    excluded: false,
  });
  assert.deepEqual(directShellInput("!! git status"), {
    command: "git status",
    excluded: true,
  });
  assert.deepEqual(directShellInput("!!! literal-bang"), {
    command: "! literal-bang",
    excluded: true,
  });
  assert.equal(directShellInput("ordinary prompt"), undefined);
  assert.deepEqual(directShellInput("!"), { command: "", excluded: false });
});

test("prompt delivery uses keyboard modifiers without a mode selector", () => {
  assert.equal(
    promptDeliveryShortcut({ altKey: false, ctrlKey: false, metaKey: false }),
    undefined,
  );
  assert.equal(
    promptDeliveryShortcut({ altKey: true, ctrlKey: false, metaKey: false }),
    "follow_up",
  );
  assert.equal(
    promptDeliveryShortcut({ altKey: false, ctrlKey: true, metaKey: false }),
    "interrupt",
  );
  assert.equal(
    promptDeliveryShortcut({ altKey: false, ctrlKey: false, metaKey: true }),
    "interrupt",
  );
});

test("canonical user messages consume one matching pending delivery", () => {
  const content = [{ type: "text" as const, text: "Keep going" }];
  const pending = [
    {
      id: 1,
      mode: "steer" as const,
      text: "Keep going",
      contentKey: JSON.stringify(content),
      afterRecord: 0,
    },
    {
      id: 2,
      mode: "follow_up" as const,
      text: "Keep going",
      contentKey: JSON.stringify(content),
      afterRecord: 0,
    },
  ];
  const conversation = {
    records: [
      { kind: "event", event: { id: "delivered", type: "user.message", payload: { content } } },
    ],
  } as unknown as ConversationState;

  assert.deepEqual(consumePendingPromptDeliveries(pending, conversation), [pending[1]]);
});

test("session presentation handles fallbacks, Unicode search, and failed drafts", () => {
  assert.equal(sessionTitle(session), "Fix 🚀 launch");
  assert.equal(sessionTitle({ ...session, title: "Release work" }), "Release work");
  assert.equal(sessionTitle({} as SessionSummary), "New session");
  assert.equal(matchesSession(session, "🚀 LAUNCH"), true);
  assert.equal(matchesSession(session, "مرحبا"), true);
  assert.equal(matchesSession(session, "missing"), false);
  assert.equal(restoreDraft("failed", ""), "failed");
  assert.equal(restoreDraft("failed", "new draft"), "failed\nnew draft");
});

test("transcript navigation uses user prompts and searches messages", () => {
  const conversation = {
    compactedEventIds: ["prompt-1"],
    records: [
      {
        kind: "event",
        event: {
          id: "prompt-1",
          type: "user.message",
          payload: { content: [{ type: "text", text: "First prompt" }] },
        },
      },
      {
        kind: "event",
        event: {
          id: "answer-1",
          type: "assistant.message",
          payload: { content: [{ type: "text", text: "Useful answer" }] },
        },
      },
      {
        kind: "event",
        event: {
          id: "prompt-2",
          type: "user.message",
          payload: { content: [{ type: "blob", blob: {} }] },
        },
      },
    ],
  } as unknown as ConversationState;

  assert.deepEqual(transcriptPromptBreakpoints(conversation), [
    { id: "prompt-2", text: "Attachment" },
  ]);
  assert.deepEqual(transcriptMessageMatches(conversation, "ANSWER"), ["answer-1"]);
  assert.deepEqual(transcriptMessageMatches(conversation, "FIRST"), []);
});

test("session usage derives cache rate, throughput, and missing cost", () => {
  const conversation = {
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      reasoningTokens: 8,
      costUsd: 0.01,
    },
    records: [
      { kind: "event", event: { type: "model.request_configured", timestamp: 1000 } },
      {
        kind: "event",
        event: {
          type: "assistant.message",
          timestamp: 3000,
          payload: {
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              cacheReadTokens: 100,
              cacheWriteTokens: 0,
            },
          },
        },
      },
    ],
  } as unknown as ConversationState;

  assert.deepEqual(sessionUsageStats(conversation), {
    cacheHitPercent: 50,
    tokensPerSecond: 10,
    unknownCostResponses: 1,
  });
});

test("edit presentation keeps replacement order and line sides", () => {
  assert.deepEqual(editDiffRows({ edits: [{ oldText: "one\ntwo", newText: "one\nthree" }] }), [
    { kind: "meta", text: "@@ replacement 1 @@" },
    { kind: "remove", text: "one", oldLine: 1 },
    { kind: "remove", text: "two", oldLine: 2 },
    { kind: "add", text: "one", newLine: 1 },
    { kind: "add", text: "three", newLine: 2 },
  ]);
  assert.deepEqual(editDiffRows({ edits: [null, "bad"] }), []);
});

test("message blobs are collected once across user and assistant messages", () => {
  const conversation = {
    records: [
      {
        kind: "event",
        event: {
          type: "user.message",
          payload: {
            content: [
              { type: "text", text: "see this" },
              { type: "blob", blob: { sha256: "a", mediaType: "image/png" } },
            ],
          },
        },
      },
      {
        kind: "event",
        event: {
          type: "assistant.message",
          payload: { content: [{ type: "blob", blob: { sha256: "a", mediaType: "image/png" } }] },
        },
      },
      {
        kind: "event",
        event: {
          type: "assistant.message",
          payload: { content: [{ type: "blob", blob: { sha256: "b", mediaType: "image/png" } }] },
        },
      },
      { kind: "activity" },
    ],
  } as unknown as ConversationState;

  assert.deepEqual(
    messageBlobs(conversation).map((blob) => blob.sha256),
    ["a", "b"],
  );
});

test("session state history keeps the last twenty configuration events newest first", () => {
  const records = Array.from({ length: 25 }, (_value, index) => ({
    kind: "event",
    event: {
      id: `model-${index}`,
      type: "config.model",
      timestamp: index,
      payload: { modelId: `model-${index}` },
    },
  }));
  const conversation = { records } as unknown as ConversationState;
  const history = sessionStateHistory(conversation);
  assert.equal(history.length, 20);
  assert.equal(history[0]?.id, "model-24");
  assert.equal(history[0]?.label, "Model");
  assert.equal(history.at(-1)?.id, "model-5");
});

test("compact number abbreviates thousands and keeps small values exact", () => {
  assert.equal(compactNumber(999), "999");
  assert.equal(compactNumber(1000), "1.0k");
  assert.equal(compactNumber(1240), "1.2k");
  assert.equal(compactNumber(12_800), "13k");
});

test("scroll stickiness tolerates a small gap but not a scrolled-up reader", () => {
  assert.equal(isScrolledToBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 }), true);
  assert.equal(isScrolledToBottom({ scrollTop: 850, scrollHeight: 1000, clientHeight: 100 }), true);
  assert.equal(
    isScrolledToBottom({ scrollTop: 835, scrollHeight: 1000, clientHeight: 100 }),
    false,
  );
  assert.equal(isScrolledToBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 }), false);
  assert.equal(
    isScrolledToBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 }, 1000),
    true,
  );
});

test("catalog scan confirms deletion only after a terminal page", async () => {
  const fetchPage = (
    cursor: string | undefined,
  ): Promise<{ sessions: { sessionId: string }[]; nextPageCursor?: string }> =>
    Promise.resolve(
      cursor === "p2"
        ? { sessions: [{ sessionId: "c" }] }
        : { sessions: [{ sessionId: "a" }, { sessionId: "b" }], nextPageCursor: "p2" },
    );

  assert.deepEqual(await findSessionInCatalog(fetchPage, "c"), {
    session: { sessionId: "c" },
    confirmedAbsent: false,
  });
  assert.deepEqual(await findSessionInCatalog(fetchPage, "z"), { confirmedAbsent: true });
});

test("catalog scan leaves absence unconfirmed when the page cap is hit", async () => {
  let pageCount = 0;
  const fetchPage = (): Promise<{ sessions: { sessionId: string }[]; nextPageCursor?: string }> => {
    pageCount += 1;
    return Promise.resolve({ sessions: [{ sessionId: "other" }], nextPageCursor: "more" });
  };
  assert.deepEqual(await findSessionInCatalog(fetchPage, "missing", 3), { confirmedAbsent: false });
  assert.equal(pageCount, 3);
});

test("modal dialogs suppress global shortcuts but light overlays do not", () => {
  assert.equal(anyModalOverlayOpen(NO_OVERLAYS), false);
  assert.equal(anyModalOverlayOpen({ ...NO_OVERLAYS, newSession: true }), true);
  assert.equal(anyModalOverlayOpen({ ...NO_OVERLAYS, requeue: true }), true);
  assert.equal(anyModalOverlayOpen({ ...NO_OVERLAYS, sessionLifecycle: true }), true);
  // Light overlays must not block shortcuts by themselves.
  assert.equal(anyModalOverlayOpen({ ...NO_OVERLAYS, commandPalette: true }), false);
  assert.equal(anyModalOverlayOpen({ ...NO_OVERLAYS, sidebar: true }), false);
});

test("Escape closes one light overlay at a time and never a modal dialog", () => {
  assert.equal(topLightOverlay(NO_OVERLAYS), undefined);
  // Modal dialogs own their Escape; they are not returned as closable here.
  assert.equal(topLightOverlay({ ...NO_OVERLAYS, newSession: true }), undefined);
  assert.equal(topLightOverlay({ ...NO_OVERLAYS, requeue: true }), undefined);
  // The most modal light overlay closes first.
  assert.equal(
    topLightOverlay({ ...NO_OVERLAYS, commandPalette: true, sidebar: true }),
    "commandPalette",
  );
  assert.equal(topLightOverlay({ ...NO_OVERLAYS, usage: true, sidebar: true }), "usage");
  assert.equal(topLightOverlay({ ...NO_OVERLAYS, sidebar: true }), "sidebar");
});

test("workspace totals combine additions and deletions across files", () => {
  assert.deepEqual(
    workspaceTotals([
      { hunks: [{ lines: [{ kind: "addition" }, { kind: "context" }] }] },
      { hunks: [{ lines: [{ kind: "deletion" }, { kind: "addition" }] }] },
    ] as never),
    { additions: 2, deletions: 1 },
  );
});

test("slash-command navigation and selection skip unavailable commands", () => {
  const commands = [
    { availability: { state: "available" } },
    { availability: { state: "unavailable" } },
    { availability: { state: "available" } },
  ] as const;
  // Arrow-down from the first available command skips the unavailable middle one.
  assert.equal(nextSelectableSlashIndex(commands, 0, 1), 2);
  // Arrow-up wraps past the unavailable entry back to the first available one.
  assert.equal(nextSelectableSlashIndex(commands, 2, -1), 0);
  // A highlighted unavailable command falls back to the first available command.
  assert.equal(selectableSlashCommand(commands, 1), commands[0]);
  assert.equal(selectableSlashCommand(commands, 2), commands[2]);
  // No selectable command yields undefined and a stable index.
  const unavailable = [{ availability: { state: "unavailable" } }] as const;
  assert.equal(selectableSlashCommand(unavailable, 0), undefined);
  assert.equal(nextSelectableSlashIndex(unavailable, 0, 1), 0);
});

test("preview session summary carries opened fields with placeholder counts", () => {
  const opened = {
    sessionId: parseSessionId("123e4567-e89b-42d3-a456-426614174777"),
    cwd: "/repo",
    title: "Cloned",
    runtime: { state: "idle" as const },
    profile: "chat" as const,
  };
  const summary = previewSessionSummary(opened, 1234);
  assert.equal(summary.sessionId, opened.sessionId);
  assert.equal(summary.cwd, "/repo");
  assert.equal(summary.title, "Cloned");
  assert.equal(summary.createdAt, 1234);
  assert.equal(summary.updatedAt, 1234);
  assert.equal(summary.userMessageCount, 0);
  assert.equal(summary.profile, "chat");
  // No title falls through to undefined rather than an empty string.
  const untitled = previewSessionSummary({ ...opened, title: undefined }, 1);
  assert.equal(untitled.title, undefined);
});
