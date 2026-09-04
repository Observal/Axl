// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  CanonicalEventSizeError,
  encodeCanonicalEvent,
  encodeWireMessage,
  MAX_CANONICAL_EVENT_BYTES,
  MAX_WIRE_MESSAGE_BYTES,
  parseEvent,
} from "../src/index.ts";

const envelope = {
  version: 1,
  id: "00000000-0000-4000-8000-000000000001",
  sessionId: "00000000-0000-4000-8000-000000000002",
  parentId: null,
  operationId: "00000000-0000-4000-8000-000000000003",
  timestamp: 1_767_225_600_000,
  type: "user.message",
} as const;

function eventWithText(text: string): unknown {
  return { ...envelope, payload: { content: [{ type: "text", text }] } };
}

test("encodes exactly the validated UTF-8 bytes persisted for an event", () => {
  const event = eventWithText("é😀");
  const encoded = encodeCanonicalEvent(event);
  const canonicalJson = JSON.stringify(parseEvent(event));
  assert.deepEqual(encoded, new TextEncoder().encode(canonicalJson));
  assert.equal(encoded.byteLength, canonicalJson.length + 3);
});

test("accepts the exact canonical event limit and rejects the next UTF-8 byte", () => {
  const emptyBytes = encodeCanonicalEvent(eventWithText("")).byteLength;
  const exact = eventWithText("a".repeat(MAX_CANONICAL_EVENT_BYTES - emptyBytes));
  assert.equal(encodeCanonicalEvent(exact).byteLength, MAX_CANONICAL_EVENT_BYTES);

  assert.throws(
    () =>
      encodeCanonicalEvent(eventWithText("a".repeat(MAX_CANONICAL_EVENT_BYTES - emptyBytes + 1))),
    (error: unknown) => {
      assert.ok(error instanceof CanonicalEventSizeError);
      assert.equal(error.encodedBytes, MAX_CANONICAL_EVENT_BYTES + 1);
      assert.equal(error.maximumBytes, MAX_CANONICAL_EVENT_BYTES);
      assert.equal(error.event.id, envelope.id);
      assert.equal(error.event.type, "user.message");
      return true;
    },
  );
});

test("reserves transport headroom for a maximum-size canonical event", () => {
  const emptyBytes = encodeCanonicalEvent(eventWithText("")).byteLength;
  const event = parseEvent(eventWithText("a".repeat(MAX_CANONICAL_EVENT_BYTES - emptyBytes)));
  const message = encodeWireMessage({
    kind: "event",
    subscriptionId: "s".repeat(128),
    sessionId: event.sessionId,
    sequence: Number.MAX_SAFE_INTEGER,
    cursor: "c".repeat(512),
    event,
  });
  assert.ok(new TextEncoder().encode(message).byteLength <= MAX_WIRE_MESSAGE_BYTES);
  assert.equal(MAX_WIRE_MESSAGE_BYTES - MAX_CANONICAL_EVENT_BYTES, 256 * 1024);
});

test("measures multibyte content by UTF-8 bytes rather than JavaScript length", () => {
  const emptyBytes = encodeCanonicalEvent(eventWithText("")).byteLength;
  const remaining = MAX_CANONICAL_EVENT_BYTES - emptyBytes;
  const text = `${"a".repeat(remaining - 1)}é`;
  assert.equal(text.length, remaining);
  assert.throws(() => encodeCanonicalEvent(eventWithText(text)), CanonicalEventSizeError);
});
