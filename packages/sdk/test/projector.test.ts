// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ConversationProjector,
  orderPendingTurnInputs,
  EVENT_FORMAT_VERSION,
  ProjectionError,
  parseEvent,
  parseOperationId,
  parseSessionId,
  type CanonicalEvent,
  type EventPayloadMap,
  type EventType,
} from "../src/index.ts";

const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");
const conformanceEvents = (
  JSON.parse(
    await readFile(
      new URL("../../protocol/test/fixtures/conformance.json", import.meta.url),
      "utf8",
    ),
  ) as { readonly events: readonly unknown[] }
).events.map((value) => parseEvent(value));
let counter = 0;
function event<Type extends EventType>(
  type: Type,
  payload: EventPayloadMap[Type],
  parentId: string | null = null,
): CanonicalEvent<Type> {
  counter += 1;
  return parseEvent({
    version: EVENT_FORMAT_VERSION,
    id: `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`,
    sessionId,
    parentId,
    timestamp: counter,
    type,
    payload,
  }) as CanonicalEvent<Type>;
}

test("projects messages, configuration, usage, interactions, and generic tools deterministically", () => {
  const events = [
    event("session.created", { cwd: "/workspace" }),
    event("config.model", { modelId: "fixture/model" }),
    event("config.provider", { providerId: "fixture" }),
    event("config.thinking", { requested: "high", effective: "medium", clamped: true }),
    event("tool.call", { callId: "future-1", name: "future_tool", input: { value: 1 } }),
    event("tool.result", {
      callId: "future-1",
      name: "future_tool",
      content: [{ type: "text", text: "done" }],
      isError: false,
    }),
    event("interaction.requested", {
      interactionId: "question-1",
      kind: "mcp_tool",
      source: "fixture",
      message: "Continue?",
    }),
    event("interaction.resolved", { interactionId: "question-1", action: "accept" }),
    event("assistant.message", {
      content: [{ type: "text", text: "complete" }],
      stopReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        reasoningTokens: 3,
        costUsd: 0.01,
      },
    }),
  ] as const;
  const one = new ConversationProjector(sessionId);
  const two = new ConversationProjector(sessionId);
  for (const item of events) {
    one.applyEvent(item);
    two.applyEvent(item);
  }
  assert.deepEqual(one.state, two.state);
  assert.equal(one.state.tools[0]?.renderIntent, "generic");
  assert.equal(one.state.tools[0]?.result?.content[0]?.type, "text");
  assert.equal(one.state.interactions[0]?.resolution?.payload.action, "accept");
  assert.deepEqual(one.state.usage, {
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    reasoningTokens: 3,
    costUsd: 0.01,
  });
});

test("derives operation and interaction lifecycle from canonical events", () => {
  const projector = new ConversationProjector(sessionId);
  const operationId = parseOperationId("00000000-0000-4000-8000-000000000098");
  projector.applyEvent({
    ...event("user.message", { content: [{ type: "text", text: "work" }] }),
    operationId,
  });
  assert.equal(projector.state.activeOperationId, operationId);
  assert.equal(projector.state.operations[0]?.status, "running");
  projector.applyEvent({
    ...event("interaction.requested", {
      interactionId: "approval-1",
      kind: "mcp_tool",
      source: "fixture",
      message: "Continue?",
    }),
    operationId,
  });
  assert.equal(projector.state.operations[0]?.status, "waiting_interaction");
  projector.applyEvent({
    ...event("interaction.resolved", { interactionId: "approval-1", action: "accept" }),
    operationId,
  });
  assert.equal(projector.state.operations[0]?.status, "running");
  projector.applyEvent({
    ...event("assistant.message", { content: [], stopReason: "aborted" }),
    operationId,
  });
  assert.equal(projector.state.activeOperationId, undefined);
  assert.equal(projector.state.operations[0]?.status, "aborted");
});

test("retains uncertain shell commands until canonical evidence arrives", () => {
  const projector = new ConversationProjector(sessionId);
  const operationId = parseOperationId("00000000-0000-4000-8000-000000000097");
  projector.markShellUncertain(operationId, "printf once");
  projector.reset(sessionId);
  assert.deepEqual(projector.state.uncertainShellOperations, [
    { operationId, command: "printf once" },
  ]);
  projector.applyEvent({
    ...event("user.shell", {
      command: "printf once",
      content: [{ type: "text", text: "once" }],
      isError: false,
      excluded: false,
    }),
    operationId,
  });
  assert.deepEqual(projector.state.uncertainShellOperations, []);
});

test("deduplicates identical events and rejects altered duplicates and tool conflicts", () => {
  const projector = new ConversationProjector(sessionId);
  const call = event("tool.call", { callId: "call-1", name: "shell", input: { command: "pwd" } });
  assert.equal(projector.applyEvent(call), true);
  assert.equal(projector.applyEvent(call), false);
  assert.throws(
    () => projector.applyEvent({ ...call, payload: { ...call.payload, name: "read" } }),
    (error) => error instanceof ProjectionError && error.code === "altered_duplicate",
  );
  assert.throws(
    () =>
      projector.applyEvent(
        event("tool.result", {
          callId: "missing",
          name: "shell",
          content: [],
          isError: true,
        }),
      ),
    (error) => error instanceof ProjectionError && error.code === "tool_identity_conflict",
  );
});

test("replaces activity by operation and clears it on canonical completion", () => {
  const projector = new ConversationProjector(sessionId);
  const operationId = parseOperationId("00000000-0000-4000-8000-000000000099");
  projector.applyActivity({ operationId, sequence: 1, type: "text_delta", text: "hel" });
  projector.applyActivity({ operationId, sequence: 2, type: "text_delta", text: "lo" });
  assert.equal(projector.state.activity?.text, "hello");
  projector.applyEvent({
    ...event("assistant.message", {
      content: [],
      stopReason: "tool_use",
    }),
    operationId,
  });
  assert.equal(projector.state.activity?.text, "hello");
  projector.applyActivity({ operationId, sequence: 3, type: "clear" });
  projector.applyActivity({ operationId, sequence: 4, type: "text_delta", text: "again" });
  assert.equal(projector.state.activity?.text, "again");
  projector.applyEvent({
    ...event("assistant.message", {
      content: [{ type: "text", text: "hello again" }],
      stopReason: "stop",
    }),
    operationId,
  });
  const clearedActivity = projector.state.activity;
  assert.equal(clearedActivity, undefined);

  const next = parseOperationId("00000000-0000-4000-8000-000000000100");
  projector.applyActivity({
    operationId: next,
    sequence: 8,
    type: "snapshot",
    text: "new",
    thinking: "",
    toolCalls: [],
  });
  const restoredActivity = projector.state.activity;
  assert.equal(restoredActivity?.text, "new");
  assert.throws(
    () =>
      projector.applyActivity({ operationId: next, sequence: 10, type: "text_delta", text: "!" }),
    (error) => error instanceof ProjectionError && error.code === "activity_sequence_gap",
  );
  assert.equal(projector.state.activity, undefined);
});

test("derives canonical queue lifecycle state", () => {
  const projector = new ConversationProjector(sessionId);
  const operationId = parseOperationId("00000000-0000-4000-8000-000000000077");
  const enqueued = {
    ...event("queue.enqueued", {
      content: [{ type: "text", text: "later" }],
      priority: "back",
    }),
    operationId,
  };
  projector.applyEvent(enqueued);
  assert.equal(projector.state.queue[0]?.status, "queued");
  projector.applyEvent(
    event("queue.paused", { queueItemId: enqueued.id, reason: "daemon_restart" }),
  );
  assert.equal(projector.state.queue[0]?.status, "paused");
  projector.applyEvent(event("queue.requeued", { queueItemId: enqueued.id, priority: "front" }));
  projector.applyEvent(event("queue.started", { queueItemId: enqueued.id }));
  assert.equal(projector.state.queue[0]?.status, "running");
  projector.applyEvent({
    ...event("assistant.message", { content: [], stopReason: "stop" }),
    operationId,
  });
  assert.equal(projector.state.queue[0]?.status, "completed");
});

test("projects the language-neutral canonical event corpus deterministically", () => {
  const first = new ConversationProjector(sessionId);
  const second = new ConversationProjector(sessionId);
  for (const canonicalEvent of conformanceEvents) {
    first.applyEvent(canonicalEvent);
    second.applyEvent(structuredClone(canonicalEvent));
  }
  assert.deepEqual(first.state, second.state);
  assert.equal(first.state.records.length, conformanceEvents.length);
});

test("overview reads remain history-free for a 100,000-event session", () => {
  const projector = new ConversationProjector(sessionId);
  const empty = projector.overview;
  for (let index = 0; index < 100_000; index++)
    projector.applyEvent(
      event("user.message", { content: [{ type: "text", text: `message ${index}` }] }),
    );
  const full = projector.state;
  const {
    records,
    tools: _tools,
    interactions: _interactions,
    operations: _operations,
    queue: _queue,
    uncertainShellOperations: _uncertain,
    ...metadata
  } = full;
  assert.deepEqual(projector.overview, { ...metadata, recordCount: records.length });
  assert.equal(empty.recordCount, 0);
  assert.ok(Object.isFrozen(projector.overview));
  Object.defineProperty(projector, "state", {
    get() {
      throw new Error("History materialized for status");
    },
  });
  for (let index = 0; index < 1_000; index++) assert.equal(projector.overview.recordCount, 100_000);
  projector.applyEvent(event("config.model", { modelId: "fixture/changed" }));
  assert.equal(projector.overview.model, "fixture/changed");
  projector.reset();
  assert.equal(projector.overview.recordCount, 0);
  assert.equal(projector.overview.model, undefined);
});

test("projects compacted membership across repeated summaries without deleting records", () => {
  const projector = new ConversationProjector(sessionId);
  const old = event("user.message", { content: [{ type: "text", text: "old" }] });
  const first = event(
    "context.compacted",
    { summary: "first", replacedEventIds: [old.id] },
    old.id,
  );
  const recent = event("user.message", { content: [{ type: "text", text: "recent" }] }, first.id);
  const second = event(
    "context.compacted",
    { summary: "second", replacedEventIds: [first.id, recent.id] },
    recent.id,
  );
  for (const item of [old, first, recent, second]) projector.applyEvent(item);
  for (const item of [old, first, recent]) assert.equal(projector.isEventCompacted(item.id), true);
  assert.equal(projector.isEventCompacted(second.id), false);
  assert.equal(projector.state.records.length, 4);
  projector.replace([old]);
  assert.equal(projector.isEventCompacted(old.id), false);
});

test("pending-input presentation follows steering FIFO before follow-up FIFO without mutating submissions", () => {
  const submitted = [
    { mode: "followUp", text: "f1" },
    { mode: "steer", text: "s1" },
    { mode: "followUp", text: "f2" },
    { mode: "steer", text: "s2" },
  ] as const;
  assert.deepEqual(
    orderPendingTurnInputs(submitted).map((item) => item.text),
    ["s1", "s2", "f1", "f2"],
  );
  assert.deepEqual(
    submitted.map((item) => item.text),
    ["f1", "s1", "f2", "s2"],
  );
});
