// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeWireMessage,
  ProtocolValidationError,
  parseServerMessage,
  parseWireRequest,
  WIRE_PROTOCOL_VERSION,
} from "../src/index.ts";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";

test("validates every request shape", () => {
  const requests = [
    { kind: "request", id: 0, method: "daemon.info", params: {} },
    { kind: "request", id: 1, method: "session.create", params: { cwd: "/repo" } },
    { kind: "request", id: 2, method: "session.resume", params: { sessionId } },
    { kind: "request", id: 11, method: "session.list", params: {} },
    {
      kind: "request",
      id: 12,
      method: "session.fork",
      params: { sessionId, fromEventId: "00000000-0000-4000-8000-000000000001" },
    },
    { kind: "request", id: 13, method: "session.clone", params: { sessionId } },
    {
      kind: "request",
      id: 3,
      method: "session.send",
      params: { sessionId, content: [{ type: "text", text: "hello" }] },
    },
    { kind: "request", id: 4, method: "session.interrupt", params: { sessionId } },
    { kind: "request", id: 5, method: "session.subscribe", params: { sessionId } },
    { kind: "request", id: 6, method: "session.reload", params: { sessionId } },
    { kind: "request", id: 7, method: "session.dispose", params: { sessionId } },
    {
      kind: "request",
      id: 8,
      method: "session.configure",
      params: { sessionId, modelId: "gpt-5", thinkingLevel: "high" },
    },
    {
      kind: "request",
      id: 9,
      method: "session.create",
      params: { cwd: "/repo", modelId: "gpt-5", thinkingLevel: "medium" },
    },
    {
      kind: "request",
      id: 10,
      method: "session.interaction.respond",
      params: {
        sessionId,
        interactionId: "interaction-1",
        action: "accept",
        content: { answer: "yes" },
      },
    },
  ];
  for (const request of requests) assert.deepEqual(parseWireRequest(request), request);
});

test("rejects malformed requests at the wire boundary", () => {
  for (const request of [
    { kind: "request", id: -1, method: "session.create", params: { cwd: "/repo" } },
    { kind: "request", id: 1, method: "daemon.info", params: { extra: true } },
    { kind: "request", id: 1, method: "unknown", params: {} },
    { kind: "request", id: 1, method: "session.create", params: { cwd: "" } },
    { kind: "request", id: 1, method: "session.resume", params: { sessionId: "bad" } },
    { kind: "request", id: 1, method: "session.list", params: { cwd: "/repo" } },
    { kind: "request", id: 1, method: "session.fork", params: { sessionId } },
    { kind: "request", id: 1, method: "session.send", params: { sessionId, content: "bad" } },
    { kind: "request", id: 1, method: "session.configure", params: { sessionId } },
    {
      kind: "request",
      id: 1,
      method: "session.configure",
      params: { sessionId, thinkingLevel: "extreme" },
    },
    {
      kind: "request",
      id: 1,
      method: "session.interaction.respond",
      params: { sessionId, interactionId: "interaction-1", action: "maybe" },
    },
  ]) {
    assert.throws(() => parseWireRequest(request), ProtocolValidationError);
  }
});

test("validates server messages and newline framing", () => {
  const hello = { kind: "hello", wireVersion: WIRE_PROTOCOL_VERSION } as const;
  assert.deepEqual(parseServerMessage(hello), hello);
  assert.equal(encodeWireMessage(hello), `${JSON.stringify(hello)}\n`);
  assert.deepEqual(parseServerMessage({ kind: "hello", wireVersion: 99 }), {
    kind: "hello",
    wireVersion: 99,
  });
  assert.throws(
    () => parseServerMessage({ kind: "hello", wireVersion: 0 }),
    ProtocolValidationError,
  );
});
