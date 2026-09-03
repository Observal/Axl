// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { open as openFile, appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  CanonicalEventSizeError,
  EVENT_FORMAT_VERSION,
  MAX_CANONICAL_EVENT_BYTES,
  type CanonicalEvent,
  type EventPayloadMap,
  type EventType,
  parseEvent,
  parseEventId,
  parseSessionId,
} from "@axl/protocol";

import {
  EventLogCorruptionError,
  EventLogMigrationRequiredError,
  type EventLogOptions,
  JsonlEventLog,
  REDACTED_VALUE,
  SECRET_FIELD_LIST_VERSION,
} from "../src/index.ts";

const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");

function makeEvent<Type extends EventType>(
  number: number,
  type: Type,
  payload: EventPayloadMap[Type],
): CanonicalEvent<Type> {
  const id = parseEventId(`00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`);
  return parseEvent({
    version: EVENT_FORMAT_VERSION,
    id,
    sessionId,
    parentId: null,
    timestamp: number,
    type,
    payload,
  }) as CanonicalEvent<Type>;
}

async function openTemporaryLog(
  context: TestContext,
  options: EventLogOptions = {},
): Promise<{
  path: string;
  log: JsonlEventLog;
}> {
  const directory = await mkdtemp(join(tmpdir(), "axl-event-log-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session.jsonl");
  const { log } = await JsonlEventLog.open(path, sessionId, options);
  return { path, log };
}

test("serializes appends and redacts structured secret fields before writing", async (context) => {
  const { path, log } = await openTemporaryLog(context, {
    secretValues: ["known-sensitive"],
  });
  assert.equal(SECRET_FIELD_LIST_VERSION, 1);

  const stored = await log.append(
    makeEvent(1, "tool.call", {
      callId: "call-1",
      name: "request",
      input: {
        apiKey: "sensitive-value",
        nested: { Authorization: "sensitive-header", visible: "kept" },
      },
    }),
  );
  assert.equal(stored.type, "tool.call");
  assert.deepEqual(stored.payload.input, {
    apiKey: REDACTED_VALUE,
    nested: { Authorization: REDACTED_VALUE, visible: "kept" },
  });

  await log.append(
    makeEvent(2, "tool.schema", {
      name: "request",
      description: "Request data",
      inputSchema: {
        properties: { apiKey: { type: "string", example: "known-sensitive" } },
      },
    }),
  );

  await Promise.all(
    [3, 4, 5].map((number) =>
      log.append(
        makeEvent(number, "user.message", {
          content: [{ type: "text", text: number === 3 ? "show known-sensitive" : String(number) }],
        }),
      ),
    ),
  );

  const raw = await readFile(path, "utf8");
  assert.equal(raw.includes("sensitive-value"), false);
  assert.equal(raw.includes("sensitive-header"), false);
  assert.equal(raw.includes("known-sensitive"), false);
  assert.equal(raw.endsWith("\n"), true);

  const { events, recoveredBytes } = await log.read();
  assert.equal(recoveredBytes, 0);
  assert.deepEqual(
    events.map((event) => event.id),
    [1, 2, 3, 4, 5].map(
      (number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`,
    ),
  );
  const schema = events[1];
  assert.equal(schema?.type, "tool.schema");
  if (schema?.type === "tool.schema") {
    assert.deepEqual(schema.payload.inputSchema, {
      properties: { apiKey: { type: "string", example: REDACTED_VALUE } },
    });
  }
  const message = events[2];
  assert.equal(message?.type, "user.message");
  if (message?.type === "user.message") {
    assert.deepEqual(message.payload.content, [{ type: "text", text: `show ${REDACTED_VALUE}` }]);
  }
});

test("discards only a torn final line before accepting another append", async (context) => {
  const { path, log } = await openTemporaryLog(context);
  await log.append(makeEvent(1, "session.created", { cwd: "/workspace" }));
  await log.append(makeEvent(2, "session.resumed", {}));
  const committed = await readFile(path);
  const torn = Buffer.from('{"version":1,"id":"partial');
  await appendFile(path, torn);

  const reopened = await JsonlEventLog.open(path, sessionId);
  assert.equal(reopened.recoveredBytes, torn.byteLength);
  assert.equal(reopened.events.length, 2);
  assert.deepEqual(await readFile(path), committed);

  await reopened.log.append(makeEvent(3, "session.closed", { reason: "completed" }));
  assert.equal((await reopened.log.read()).events.length, 3);
});

test("reports committed corruption without modifying the file", async (context) => {
  const { path, log } = await openTemporaryLog(context);
  await log.append(makeEvent(1, "session.created", { cwd: "/workspace" }));
  await appendFile(path, "{}\n");
  const corrupt = await readFile(path);

  await assert.rejects(
    JsonlEventLog.open(path, sessionId),
    (error) => error instanceof EventLogCorruptionError && error.line === 2,
  );
  assert.deepEqual(await readFile(path), corrupt);
});

test("rejects oversized appends without modifying the log", async (context) => {
  const { path, log } = await openTemporaryLog(context);
  await log.append(makeEvent(1, "session.created", { cwd: "/workspace" }));
  const before = await readFile(path);
  const oversized = makeEvent(2, "user.message", {
    content: [{ type: "text", text: "é".repeat(MAX_CANONICAL_EVENT_BYTES) }],
  });

  await assert.rejects(log.append(oversized), CanonicalEventSizeError);
  assert.deepEqual(await readFile(path), before);
});

test("quarantines oversized committed legacy events without modifying the log", async (context) => {
  const { path, log } = await openTemporaryLog(context);
  await log.append(makeEvent(1, "session.created", { cwd: "/workspace" }));
  const oversized = makeEvent(2, "user.message", {
    content: [{ type: "text", text: "é".repeat(MAX_CANONICAL_EVENT_BYTES) }],
  });
  await appendFile(path, `${JSON.stringify(oversized)}\n`);
  const before = await readFile(path);

  await assert.rejects(JsonlEventLog.open(path, sessionId), (error: unknown) => {
    assert.ok(error instanceof EventLogMigrationRequiredError);
    assert.equal(error.sessionId, sessionId);
    assert.equal(error.eventId, oversized.id);
    assert.equal(error.eventType, "user.message");
    assert.equal(error.encodedBytes, Buffer.byteLength(JSON.stringify(oversized)));
    assert.equal(error.maximumBytes, MAX_CANONICAL_EVENT_BYTES);
    return true;
  });
  assert.deepEqual(await readFile(path), before);
});

test("rolls back a failed durable append and keeps the queue usable", async (context) => {
  const { path, log } = await openTemporaryLog(context);
  await log.append(makeEvent(1, "session.created", { cwd: "/workspace" }));
  const before = await readFile(path);

  const probe = await openFile(path, "r+");
  const prototype = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
  await probe.close();
  const originalSync = prototype.sync;
  let failNextSync = true;
  context.mock.method(prototype, "sync", async function (this: typeof prototype) {
    if (failNextSync) {
      failNextSync = false;
      throw new Error("simulated sync failure");
    }
    await originalSync.call(this);
  });

  await assert.rejects(log.append(makeEvent(2, "session.resumed", {})), /simulated sync failure/);
  assert.deepEqual(await readFile(path), before);

  await log.append(makeEvent(3, "session.closed", { reason: "completed" }));
  assert.equal((await log.read()).events.length, 2);
});
