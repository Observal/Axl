// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  ConversationProjector,
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
      content: [{ type: "text", text: "hello" }],
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
