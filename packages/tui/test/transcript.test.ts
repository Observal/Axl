// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ConversationProjector } from "@axl/sdk";

import {
  type CanonicalEvent,
  EVENT_FORMAT_VERSION,
  type EventPayloadMap,
  type EventType,
  parseEvent,
  parseEventId,
  parseSessionId,
} from "@axl/protocol";

import { PLAIN_PALETTE, SessionView } from "../src/index.ts";

const conformanceEvents = (
  JSON.parse(
    await readFile(
      new URL("../../protocol/test/fixtures/conformance.json", import.meta.url),
      "utf8",
    ),
  ) as { readonly events: readonly unknown[] }
).events.map((value) => parseEvent(value));

let counter = 0;
function makeEvent<Type extends EventType>(
  type: Type,
  payload: EventPayloadMap[Type],
): CanonicalEvent<Type> {
  counter += 1;
  return parseEvent({
    version: EVENT_FORMAT_VERSION,
    id: `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`,
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    parentId: null,
    timestamp: counter,
    type,
    payload,
  }) as CanonicalEvent<Type>;
}

test("projects the conversation into transcript lines", () => {
  const view = new SessionView(80, PLAIN_PALETTE);
  assert.deepEqual(view.apply(makeEvent("session.created", { cwd: "/repo" })), []);
  const user = view.apply(makeEvent("user.message", { content: [{ type: "text", text: "hi" }] }));
  assert.equal(user[0], "");
  assert.match(user[1] ?? "", /╭─+╮/);
  assert.match(user.join("\n"), /│ hi\s+│/);
  assert.match(user.at(-1) ?? "", /╰─+╯/);
  assert.deepEqual(
    view.apply(
      makeEvent("assistant.message", {
        content: [
          { type: "thinking", text: "mull" },
          { type: "text", text: "hello" },
        ],
        stopReason: "stop",
      }),
    ),
    ["", "  ∴ Thinking · 1 line", "  hello"],
  );
});

test("leaves tool presentation to retained transactions and renders errors loudly", () => {
  const view = new SessionView(80, PLAIN_PALETTE);
  assert.deepEqual(
    view.apply(makeEvent("tool.call", { callId: "c", name: "shell", input: { command: "ls" } })),
    [],
  );
  assert.deepEqual(
    view.apply(
      makeEvent("tool.result", {
        callId: "c",
        name: "shell",
        content: [{ type: "text", text: "a\nb\nc\nd\ne\nf" }],
        isError: false,
      }),
    ),
    [],
  );
  assert.deepEqual(
    view.apply(
      makeEvent("assistant.message", {
        content: [],
        stopReason: "error",
        errorMessage: "boom",
      }),
    ),
    ["", "  ✖ boom"],
  );
  assert.deepEqual(
    view.apply(makeEvent("session.error", { code: "x", message: "y", retryable: false })),
    ["✖ x: y"],
  );
});

test("tracks profile, model, thinking, and sandbox without noisy startup rows", () => {
  const view = new SessionView(220, PLAIN_PALETTE);
  assert.deepEqual(view.apply(makeEvent("config.profile", { profile: "exec" })), []);
  assert.deepEqual(view.apply(makeEvent("config.model", { modelId: "gpt-5" })), []);
  const clamp = view.apply(
    makeEvent("config.thinking", { requested: "max", effective: "high", clamped: true }),
  );
  assert.deepEqual(clamp, ["· thinking high (clamped from max)"]);
  assert.deepEqual(
    view.apply(
      makeEvent("sandbox.configured", { provider: "bubblewrap", enforced: true, controls: [] }),
    ),
    [],
  );
  assert.deepEqual(view.apply(makeEvent("config.model", { modelId: "gpt-5.6" })), [
    "· model gpt-5 → gpt-5.6",
  ]);
  assert.deepEqual(
    view.apply(
      makeEvent("config.dialect", {
        dialectId: "openai-chat",
        rosterFingerprint: "fingerprint",
        reason: "reload",
      }),
    ),
    ["· tools reloaded · openai-chat"],
  );

  const status = view.statusLine("123e4567-e89b-42d3-a456-426614174000");
  assert.match(status, /idle/);
  assert.match(status, /session 123e4567/);
  assert.match(status, /profile exec/);
  assert.match(status, /model gpt-5\.6/);
  assert.match(status, /thinking high/);
  assert.match(status, /sandbox bubblewrap/);

  view.working = true;
  assert.match(view.statusLine("123e4567-e89b-42d3-a456-426614174000"), /working…/);

  const unsafe = new SessionView(80, PLAIN_PALETTE);
  assert.deepEqual(
    unsafe.apply(
      makeEvent("sandbox.configured", { provider: "none", enforced: false, controls: [] }),
    ),
    ["! sandbox is not enforced"],
  );
});

test("cycles compact, full, and focus transcript detail modes", () => {
  const view = new SessionView(80, PLAIN_PALETTE);
  assert.equal(view.toggleToolOutput(), "full");
  assert.equal(view.toggleToolOutput(), "focus");
  assert.equal(view.toggleToolOutput(), "compact");
});

test("reports cumulative usage, cache hit rate, cost, and local throughput", () => {
  const view = new SessionView(120, PLAIN_PALETTE);
  view.beginResponse();
  view.apply(
    makeEvent("assistant.message", {
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 20,
        cacheWriteTokens: 2,
        costUsd: 0.125,
      },
    }),
  );
  assert.equal(view.usageLabel(), "↑10 ↓5 R20 W2 CH62.5% $0.125");
  assert.match(view.tpsLabel(), /tok\/s$/);
});

test("renders permission lifecycle without relying on color", () => {
  const view = new SessionView(80, PLAIN_PALETTE);
  assert.deepEqual(
    view.apply(
      makeEvent("permission.requested", {
        capability: "filesystem.write",
        description: "Write outside workspace",
      }),
    ),
    ["? permission · filesystem.write · Write outside workspace"],
  );
  assert.deepEqual(
    view.apply(
      makeEvent("permission.resolved", {
        requestId: parseEventId("00000000-0000-4000-8000-000000000001"),
        decision: "deny",
        reason: "outside policy",
      }),
    ),
    ["· permission deny · outside policy"],
  );
});

test("renders compaction and session lifecycle entries distinctly", () => {
  const view = new SessionView(80, PLAIN_PALETTE);
  const compacted = view.apply(
    makeEvent("context.compacted", {
      summary: "## Continued work\n\n- keep the sandbox active",
      replacedEventIds: [parseEventId("00000000-0000-4000-8000-000000000001")],
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
      },
    }),
  );
  assert.match(compacted.join("\n"), /◇ Context compacted/);
  assert.match(compacted.join("\n"), /Continued work/);
  assert.match(compacted.join("\n"), /• keep the sandbox active/);
  assert.equal(view.totalTokens, 25);
  assert.equal(view.cacheReadTokens, 3);
  assert.equal(view.contextTokens, undefined);
  assert.deepEqual(view.apply(makeEvent("session.closed", { reason: "completed" })), [
    "· session completed",
  ]);
});

test("prompt sections contribute nothing and long lines wrap", () => {
  const view = new SessionView(10, PLAIN_PALETTE);
  assert.deepEqual(
    view.apply(makeEvent("prompt.section", { name: "identity", source: "core", content: "x" })),
    [],
  );
  const wrapped = view.apply(
    makeEvent("user.message", { content: [{ type: "text", text: "aaaaaaaaaaaa" }] }),
  );
  assert.equal(
    wrapped.every((line) => line.length <= 10),
    true,
  );
  assert.equal(wrapped.filter((line) => line.includes("aaaaaa")).length, 2);
});

test("presents the language-neutral corpus from the shared SDK projection", () => {
  const fixtureSessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");
  const projector = new ConversationProjector(fixtureSessionId);
  const view = new SessionView(80, PLAIN_PALETTE, [], undefined, projector);
  const rows: string[] = [];
  for (const canonicalEvent of conformanceEvents) {
    assert.equal(projector.applyEvent(canonicalEvent), true);
    rows.push(...view.present(canonicalEvent));
  }

  assert.equal(projector.state.records.length, conformanceEvents.length);
  assert.match(rows.join("\n"), /hello/);
  assert.equal(view.model, projector.state.model);
  assert.equal(view.thinking, projector.state.thinking);
  assert.equal(view.totalCostUsd, projector.state.usage.costUsd);
});
