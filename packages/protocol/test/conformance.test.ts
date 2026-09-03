// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  encodeWireMessage,
  EVENT_TYPES,
  parseEvent,
  parseServerMessage,
  parseWireRequest,
  RPC_ERROR_CODES,
  RPC_METHODS,
  WIRE_PROTOCOL_VERSION,
} from "../src/index.ts";

type ConformanceDocument = {
  readonly wireVersion: number;
  readonly requests: readonly unknown[];
  readonly successes: readonly unknown[];
  readonly errors: readonly unknown[];
  readonly serverMessages: readonly unknown[];
  readonly events: readonly unknown[];
};

const document = JSON.parse(
  await readFile(new URL("./fixtures/conformance.json", import.meta.url), "utf8"),
) as ConformanceDocument;

function methods(values: readonly unknown[]): readonly string[] {
  return values.map((value) => (value as { readonly method: string }).method).sort();
}

test("language-neutral fixtures cover and validate every RPC request and success", () => {
  assert.equal(document.wireVersion, WIRE_PROTOCOL_VERSION);
  const requests = document.requests.map((value) => parseWireRequest(value));
  const successes = document.successes.map((value) => parseServerMessage(value));
  assert.deepEqual(methods(requests), [...RPC_METHODS].sort());
  assert.deepEqual(methods(successes), [...RPC_METHODS].sort());
  assert.equal(new Set(methods(requests)).size, requests.length);

  for (const request of requests) {
    const roundTrip = JSON.parse(encodeWireMessage(request)) as unknown;
    assert.deepEqual(parseWireRequest(roundTrip), request);
  }
  for (const success of successes) {
    assert.equal(success.kind, "success");
    const roundTrip = JSON.parse(encodeWireMessage(success)) as unknown;
    assert.deepEqual(parseServerMessage(roundTrip), success);
  }
});

test("language-neutral fixtures cover and validate every canonical event", () => {
  const events = document.events.map((value) => parseEvent(value));
  assert.deepEqual(events.map((event) => event.type).sort(), [...EVENT_TYPES].sort());
  assert.equal(new Set(events.map((event) => event.type)).size, EVENT_TYPES.length);
  for (const event of events) {
    assert.deepEqual(parseEvent(JSON.parse(JSON.stringify(event)) as unknown), event);
  }
});

test("language-neutral fixtures cover every named structured error", () => {
  const errors = document.errors.map((value) => parseServerMessage(value));
  assert.deepEqual(
    errors.map((message) => (message.kind === "error" ? message.error.code : "not-an-error")),
    RPC_ERROR_CODES,
  );
});

test("language-neutral fixtures validate every non-success server message shape", () => {
  const messages = document.serverMessages.map((value) => parseServerMessage(value));
  assert.deepEqual(messages.map((message) => message.kind).sort(), [
    "activity",
    "error",
    "event",
    "hello",
    "presence",
  ]);
  for (const message of messages) {
    const roundTrip = JSON.parse(encodeWireMessage(message)) as unknown;
    assert.deepEqual(parseServerMessage(roundTrip), message);
  }
});
