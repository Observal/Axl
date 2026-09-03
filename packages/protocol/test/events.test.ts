// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT_FORMAT_VERSION,
  type EventPayloadMap,
  parseEvent,
  parseEventId,
  parseSessionId,
  ProtocolValidationError,
} from "../src/index.ts";

const eventId = parseEventId("018f47a5-4f18-7cc2-8000-123456789abc");
const secondEventId = parseEventId("018f47a5-4f18-7cc2-8000-123456789abd");
const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");

const validPayloads = {
  "session.created": { cwd: "/workspace" },
  "session.resumed": {},
  "session.closed": { reason: "completed" },
  "user.message": { content: [{ type: "text", text: "hello" }] },
  "user.shell": {
    command: "pwd",
    content: [{ type: "text", text: "/workspace" }],
    isError: false,
    excluded: false,
  },
  "assistant.message": {
    content: [
      { type: "thinking", text: "reasoning" },
      { type: "text", text: "answer" },
    ],
    stopReason: "stop",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      reasoningTokens: 3,
      costUsd: 0.01,
    },
  },
  "tool.call": { callId: "call-1", name: "read", input: { path: "README.md" } },
  "tool.result": {
    callId: "call-1",
    name: "read",
    content: [{ type: "text", text: "contents" }],
    isError: false,
    details: { lines: 1 },
  },
  "config.model": { modelId: "model-1" },
  "config.provider": { providerId: "provider-1" },
  "config.entitlement": { entitlementId: "credential-reference" },
  "config.thinking": { requested: "high", effective: "medium", clamped: true },
  "config.tools": { webFetch: true, webSearch: false },
  "config.dialect": {
    dialectId: "openai-chat",
    rosterFingerprint: "f".repeat(64),
    reason: "model_switch",
  },
  "prompt.section": { name: "identity", source: "core", content: "You are Axl." },
  "tool.schema": {
    name: "read",
    description: "Read a file",
    inputSchema: { type: "object", required: ["path"] },
  },
  "context.injected": { source: "skill", content: "Follow this procedure." },
  "context.extension": {
    extensionId: "example",
    source: "hook",
    content: "Additional context",
  },
  "permission.requested": { capability: "filesystem.write", description: "Write README.md" },
  "permission.resolved": { requestId: eventId, decision: "allow_once" },
  "interaction.requested": {
    interactionId: "interaction-1",
    kind: "mcp_elicitation_form",
    source: "mcp:example",
    message: "Choose a value",
    data: { requestedSchema: { type: "object" } },
  },
  "interaction.resolved": {
    interactionId: "interaction-1",
    action: "accept",
    content: { answer: "yes" },
  },
  "sandbox.configured": {
    provider: "bubblewrap",
    enforced: true,
    controls: ["filesystem"],
    details: { landlock: "full", seccompPolicy: "axl-linux-deny-v1" },
  },
  "sandbox.violation": { capability: "filesystem.write", reason: "outside workspace" },
  "context.compacted": { summary: "Earlier work", replacedEventIds: [secondEventId] },
  "session.error": { code: "provider_failed", message: "Provider unavailable", retryable: true },
  "child.result": { childSessionId: sessionId, status: "completed", result: { summary: "done" } },
} satisfies EventPayloadMap;

function event(type: string, payload: unknown): Record<string, unknown> {
  return {
    version: EVENT_FORMAT_VERSION,
    id: eventId,
    sessionId,
    parentId: null,
    timestamp: 1_725_000_000_000,
    type,
    payload,
  };
}

test("validates every canonical event variant", () => {
  for (const [type, payload] of Object.entries(validPayloads)) {
    assert.equal(parseEvent(event(type, payload)).type, type);
  }
});

test("rejects unknown event types", () => {
  assert.throws(
    () => parseEvent(event("unknown.event", {})),
    (error) => error instanceof ProtocolValidationError && error.path === "event.type",
  );
});

test("rejects invalid event payloads", () => {
  const cases = [
    event("session.resumed", { unexpected: true }),
    event("user.message", { content: [{ type: "thinking", text: "hidden" }] }),
    event("assistant.message", { content: [], stopReason: "error" }),
    event("context.compacted", { summary: "empty", replacedEventIds: [] }),
    event("permission.resolved", { requestId: "not-a-uuid", decision: "deny" }),
    event("child.result", { childSessionId: sessionId, status: "unknown" }),
  ];

  for (const candidate of cases)
    assert.throws(() => parseEvent(candidate), ProtocolValidationError);
});

test("validates blob references without embedding blob bytes", () => {
  const blobEvent = event("user.message", {
    content: [
      {
        type: "blob",
        blob: {
          sha256: "a".repeat(64),
          mediaType: "image/png",
          sizeBytes: 123,
          name: "image.png",
        },
      },
    ],
  });
  assert.deepEqual(parseEvent(blobEvent).payload, blobEvent.payload);

  const invalidBlob = structuredClone(blobEvent);
  const payload = invalidBlob.payload as { content: Array<{ blob: { sha256: string } }> };
  const [content] = payload.content;
  assert.ok(content);
  content.blob.sha256 = "raw image bytes";
  assert.throws(() => parseEvent(invalidBlob), ProtocolValidationError);
});
