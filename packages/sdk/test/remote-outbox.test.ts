// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseIdempotencyKey,
  parseRemoteRequestId,
  parseRouteId,
  parseTransportAttemptId,
  type OpaqueOutboxRecord,
  type RequestId,
} from "@axl/protocol";

import {
  OpaqueOutbox,
  OpaqueOutboxError,
  type OpaqueOutboxStore,
  type OpaqueOutboxTransaction,
} from "../src/remote-outbox.ts";

class MemoryOutboxStore implements OpaqueOutboxStore {
  private readonly records = new Map<RequestId, OpaqueOutboxRecord>();
  private tail: Promise<void> = Promise.resolve();

  transact<Result>(
    requestId: RequestId,
    operation: (current: OpaqueOutboxRecord | undefined) => OpaqueOutboxTransaction<Result>,
  ): Promise<Result> {
    const result = this.tail.then(() => {
      const transaction = operation(this.records.get(requestId));
      if (transaction.record === undefined) this.records.delete(requestId);
      else this.records.set(requestId, transaction.record);
      return transaction.result;
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async list(): Promise<readonly OpaqueOutboxRecord[]> {
    await this.tail;
    return [...this.records.values()];
  }
}

const requestId = parseRemoteRequestId("11111111-1111-4111-8111-111111111111");
const idempotencyKey = parseIdempotencyKey("22222222-2222-4222-8222-222222222222");
const destinationRouteId = parseRouteId("33333333-3333-4333-8333-333333333333");

function record(bytes = Uint8Array.of(0, 1, 2, 255)): OpaqueOutboxRecord {
  return {
    requestId,
    idempotencyKey,
    destinationRouteId,
    opaqueEnvelope: bytes,
    createdAt: 1_900_000_000_000,
    state: "queued_local",
  };
}

function outbox(): OpaqueOutbox {
  let attempt = 0;
  return new OpaqueOutbox(new MemoryOutboxStore(), {
    create() {
      attempt += 1;
      return parseTransportAttemptId(
        `44444444-4444-4444-8444-${attempt.toString().padStart(12, "0")}`,
      );
    },
  });
}

test("retries exact opaque bytes under new transport attempt IDs", async () => {
  const queue = outbox();
  await queue.enqueue(record());

  const first = await queue.beginAttempt(requestId);
  const second = await queue.beginAttempt(requestId);
  assert.notEqual(first.attemptId, second.attemptId);
  assert.deepEqual(first.opaqueEnvelope, Uint8Array.of(0, 1, 2, 255));
  assert.deepEqual(second.opaqueEnvelope, first.opaqueEnvelope);
  assert.equal((await queue.list())[0]?.state, "sending");

  await queue.resetSendingAfterDisconnect();
  assert.equal((await queue.list())[0]?.state, "queued_local");
});

test("rejects conflicting request IDs and removal before daemon acceptance", async () => {
  const queue = outbox();
  await queue.enqueue(record());
  await queue.enqueue(record());
  await assert.rejects(
    queue.enqueue(record(Uint8Array.of(9))),
    (error) => error instanceof OpaqueOutboxError && error.code === "outbox_conflict",
  );
  await assert.rejects(
    queue.removeAccepted(requestId),
    (error) => error instanceof OpaqueOutboxError && error.code === "not_daemon_accepted",
  );
});

test("removes a mutation only after daemon acceptance", async () => {
  const queue = outbox();
  await queue.enqueue(record());
  await queue.beginAttempt(requestId);

  await queue.markDaemonAccepted(requestId);
  assert.equal((await queue.list())[0]?.state, "daemon_accepted");
  await assert.rejects(queue.beginAttempt(requestId), /must not be resent/);

  await queue.removeAccepted(requestId);
  assert.deepEqual(await queue.list(), []);
  await queue.removeAccepted(requestId);
});
