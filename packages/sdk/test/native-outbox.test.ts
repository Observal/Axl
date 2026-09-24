// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCryptoSessionId,
  parseOperationId,
  parseRemoteE2eeEnvelope,
  parseRemoteRequestId,
  parseRouteId,
  parseTransportAttemptId,
} from "@axl/protocol";

import { type NativeDurableOutboxRecord, NativeEndpointOutbox } from "../src/remote-outbox.ts";
import { WitnessedEndpoint } from "../src/witness.ts";

function bytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.replaceAll("-", ""), "hex"));
}

const requestId = parseRemoteRequestId("44444444-4444-4444-8444-444444444444");
const operationId = parseOperationId("55555555-5555-4555-8555-555555555555");
const cryptoSessionId = parseCryptoSessionId("33333333-3333-4333-8333-333333333333");
const routeId = parseRouteId("66666666-6666-4666-8666-666666666666");
const attemptId = parseTransportAttemptId("77777777-7777-4777-8777-777777777777");

function nativeRecord(): NativeDurableOutboxRecord {
  const logical = bytes(requestId);
  logical[0] = (logical[0] ?? 0) ^ 0x41;
  return {
    operationId: bytes(operationId),
    cryptoSessionId: bytes(cryptoSessionId),
    logicalMessageId: logical,
    messageClass: "application_request",
    hostedGrantGeneration: 7n,
    retryState: "pending",
    ciphertext: Uint8Array.of(1, 2, 3),
  };
}

test("native endpoint outbox recovers exact committed bytes and acknowledges in native storage", async () => {
  let records: readonly NativeDurableOutboxRecord[] = [nativeRecord()];
  const acknowledgements: Uint8Array[][] = [];
  const witnessCalls: string[] = [];
  let pendingAcknowledgement: NativeDurableOutboxRecord | undefined;
  const adapter = new NativeEndpointOutbox(
    new WitnessedEndpoint(
      {
        async witnessReadRequest() {
          witnessCalls.push("read");
          return Uint8Array.of(1);
        },
        async reconcileWitness() {
          witnessCalls.push("reconcile");
          return { tag: "ready" as const };
        },
        async pendingWitness() {
          return null;
        },
        async continueWitness(operationId) {
          witnessCalls.push("continue");
          assert.ok(pendingAcknowledgement);
          assert.deepEqual(operationId, Uint8Array.of(0xa0));
          const released = pendingAcknowledgement;
          pendingAcknowledgement = undefined;
          records = [];
          return { tag: "outbox", outbox: released };
        },
        async pendingOutbox() {
          return records;
        },
        async acknowledgeOutbox(acknowledgement, target) {
          acknowledgements.push([acknowledgement.slice(), target.slice()]);
          const record = records[0];
          assert.ok(record);
          pendingAcknowledgement = { ...record, retryState: "acknowledged" };
          return {
            tag: "pending",
            pending: {
              operationId: Uint8Array.of(0xa0),
              request: Uint8Array.of(2),
              requestHash: new Uint8Array(48),
              kind: "advance",
            },
          };
        },
      },
      {
        async respond() {
          return Uint8Array.of(0xcc);
        },
      },
    ),
    { create: () => attemptId },
    {
      resolve: async (destination) =>
        destination === cryptoSessionId ? routeId : Promise.reject(),
    },
  );

  const recovered = await adapter.list();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.requestId, requestId);
  assert.equal(recovered[0]?.idempotencyKey, operationId);
  const envelope = parseRemoteE2eeEnvelope(recovered[0]?.opaqueEnvelope ?? new Uint8Array());
  assert.equal(envelope.hostedGrantGeneration, 7);
  assert.deepEqual(envelope.ciphertext, Uint8Array.of(1, 2, 3));

  const recoveredRecord = recovered[0];
  assert.ok(recoveredRecord);
  await adapter.enqueue(recoveredRecord);
  const attempt = await adapter.beginAttempt(requestId);
  assert.equal(attempt.destinationRouteId, routeId);
  assert.equal(attempt.attemptId, attemptId);
  await adapter.resetSendingAfterDisconnect();
  assert.equal((await adapter.list())[0]?.state, "queued_local");

  await adapter.markDaemonAccepted(requestId);
  assert.equal(acknowledgements.length, 1);
  assert.deepEqual(acknowledgements[0]?.[1], bytes(operationId));
  assert.deepEqual(
    witnessCalls,
    ["read", "reconcile", "continue"],
    "the acknowledgement completed its own witness barrier",
  );
  await adapter.removeAccepted(requestId);
  assert.deepEqual(await adapter.list(), []);
});
