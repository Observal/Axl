// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeRemoteDaemonMessage,
  encodeRemoteE2eeEnvelope,
  parseCryptoSessionId,
  parseDeviceId,
  parseIdempotencyKey,
  parseOperationId,
  parseRemoteE2eeEnvelope,
  parseRemoteRequestId,
} from "@axl/protocol";

import { type NativeDeviceE2eeEndpoint, RemoteDeviceE2ee } from "../src/remote-e2ee.ts";
import {
  WitnessedEndpoint,
  type WitnessMutationOutcome,
  type WitnessTypedResult,
} from "../src/witness.ts";

const localDeviceId = parseDeviceId("11111111-1111-4111-8111-111111111111");
const daemonDeviceId = parseDeviceId("22222222-2222-4222-8222-222222222222");
const cryptoSessionId = parseCryptoSessionId("33333333-3333-4333-8333-333333333333");
const requestId = parseRemoteRequestId("44444444-4444-4444-8444-444444444444");
const idempotencyKey = parseIdempotencyKey("55555555-5555-4555-8555-555555555555");

function uuidBytesForTest(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.replaceAll("-", ""), "hex"));
}

const certificate = Uint8Array.of(0xc3);

/**
 * Scripted witness state shared by the fake endpoints: every mutation commits as pending and
 * releases its exact result only from `continueWitness` with the transport's certificate.
 */
function witnessOperations(calls: string[]) {
  let pending: { operationId: Uint8Array; result: WitnessTypedResult } | undefined;
  const commit = (operationId: Uint8Array, result: WitnessTypedResult): WitnessMutationOutcome => {
    calls.push("mutate");
    pending = { operationId: operationId.slice(), result };
    return {
      tag: "pending",
      pending: {
        operationId: operationId.slice(),
        request: Uint8Array.of(0x7e, ...operationId),
        requestHash: new Uint8Array(48),
        kind: "advance",
      },
    };
  };
  const operations = {
    async witnessReadRequest() {
      calls.push("read");
      return Uint8Array.of(0x7d);
    },
    async reconcileWitness(received: Uint8Array) {
      assert.deepEqual(received, certificate);
      calls.push("reconcile");
      return { tag: "ready" } as const;
    },
    async pendingWitness() {
      return null;
    },
    async continueWitness(operationId: Uint8Array, received: Uint8Array) {
      assert.deepEqual(received, certificate);
      assert.ok(pending, "continuation without a pending operation");
      assert.deepEqual(operationId, pending.operationId);
      calls.push("continue");
      const result = pending.result;
      pending = undefined;
      return result;
    },
  };
  return { operations, commit };
}

function witnessed<E extends NativeDeviceE2eeEndpoint>(endpoint: E, requests: Uint8Array[] = []) {
  return new WitnessedEndpoint(endpoint, {
    async respond(request) {
      requests.push(request.slice());
      return certificate.slice();
    },
  });
}

function fixtureEndpoint() {
  const prepared: Uint8Array[] = [];
  const received: Uint8Array[] = [];
  const acknowledgements: Uint8Array[] = [];
  const calls: string[] = [];
  const witness = witnessOperations(calls);
  const endpoint: NativeDeviceE2eeEndpoint = {
    ...witness.operations,
    async prepareApplication(operationId, logicalId, generation, plaintext) {
      assert.equal(generation, 7n);
      prepared.push(plaintext.slice());
      return witness.commit(operationId, {
        tag: "outbox",
        outbox: {
          operationId,
          logicalMessageId: logicalId,
          messageClass: "application_request",
          ciphertext: plaintext.slice(),
        },
      });
    },
    async receiveApplication(operationId, ciphertext, _logicalId, generation) {
      assert.equal(generation, 7n);
      received.push(ciphertext.slice());
      return witness.commit(operationId, {
        tag: "plaintext",
        plaintext: { plaintext: ciphertext.slice() },
      });
    },
    async acknowledgeOutbox() {
      throw new Error("not used");
    },
    async acknowledgeReceive(operationId) {
      acknowledgements.push(operationId.slice());
      return witness.commit(operationId, { tag: "accepted", accepted: { acknowledged: true } });
    },
  };
  return { endpoint, prepared, received, acknowledgements, calls };
}

test("prepares immutable native ciphertext for durable relay delivery", async () => {
  const fixture = fixtureEndpoint();
  const requests: Uint8Array[] = [];
  const adapter = new RemoteDeviceE2ee({
    endpoint: witnessed(fixture.endpoint, requests),
    localDeviceId,
    daemonDeviceId,
    destinationCryptoSessionId: cryptoSessionId,
    now: () => 123,
  });
  const request = {
    deviceId: localDeviceId,
    requestId,
    idempotencyKey,
    method: "session.interrupt",
    params: { sessionId: "66666666-6666-4666-8666-666666666666" },
  };
  const record = await adapter.prepareDurable(request, 7);
  assert.equal(record.requestId, requestId);
  assert.equal(record.idempotencyKey, idempotencyKey);
  assert.equal(record.destinationCryptoSessionId, cryptoSessionId);
  assert.equal(record.createdAt, 123);
  assert.equal(record.state, "queued_local");
  const envelope = parseRemoteE2eeEnvelope(record.opaqueEnvelope);
  assert.equal(envelope.operationId, idempotencyKey);
  assert.notEqual(envelope.logicalMessageId, requestId);
  assert.equal(envelope.hostedGrantGeneration, 7);
  assert.equal(envelope.messageClass, "application_request");
  assert.deepEqual(envelope.ciphertext, fixture.prepared[0]);
  assert.deepEqual(
    fixture.calls,
    ["read", "reconcile", "mutate", "continue"],
    "the ciphertext is framed only after the witness continuation released it",
  );
  assert.deepEqual(
    requests.map((request) => request[0]),
    [0x7d, 0x7e],
    "the transport received the exact fresh read and pending request bytes",
  );
});

test("prepares update proposals and applies daemon commits before epoch readiness", async () => {
  const updateOperation = parseOperationId("66666666-6666-4666-8666-666666666666");
  const updateLogical = parseOperationId("77777777-7777-4777-8777-777777777777");
  const commitOperation = parseOperationId("88888888-8888-4888-8888-888888888888");
  const commitLogical = parseOperationId("99999999-9999-4999-8999-999999999999");
  const readyOperation = parseOperationId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const readyLogical = parseOperationId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  let confirmed = false;
  const acknowledgedOutbox: Uint8Array[] = [];
  const calls: string[] = [];
  const witness = witnessOperations(calls);
  const commitMetadata = {
    commitId: new Uint8Array(48).fill(0xc0),
    targetEpoch: 2n,
    epochAuthenticator: new Uint8Array(48).fill(0xea),
  };
  const endpoint: NativeDeviceE2eeEndpoint = {
    ...witness.operations,
    async prepareApplication() {
      throw new Error("not used");
    },
    async receiveApplication() {
      throw new Error("not used");
    },
    async prepareReplacement(operationId, logicalMessageId, generation) {
      assert.equal(generation, 7n);
      return witness.commit(operationId, {
        tag: "outbox",
        outbox: {
          operationId,
          logicalMessageId,
          messageClass: "update_proposal",
          ciphertext: Uint8Array.of(7),
        },
      });
    },
    async applyReceivedUpdateCommit(operationId, ciphertext, logicalMessageId, generation) {
      assert.deepEqual(ciphertext, Uint8Array.of(8));
      assert.deepEqual(logicalMessageId, uuidBytesForTest(commitLogical));
      assert.equal(generation, 7n);
      return witness.commit(operationId, { tag: "commit", commit: commitMetadata });
    },
    async prepareEpochReady(operationId, logicalMessageId, generation, commit) {
      assert.equal(generation, 7n);
      assert.deepEqual(commit, commitMetadata);
      assert.deepEqual(logicalMessageId, uuidBytesForTest(readyLogical));
      return witness.commit(operationId, {
        tag: "outbox",
        outbox: {
          operationId,
          logicalMessageId,
          messageClass: "epoch_ready",
          ciphertext: Uint8Array.of(9),
        },
      });
    },
    async acceptEpochReadyConfirmation(operationId, _logical, generation, ciphertext) {
      assert.equal(generation, 7n);
      assert.deepEqual(ciphertext, Uint8Array.of(10));
      confirmed = true;
      return witness.commit(operationId, { tag: "pair_state", status: "active" });
    },
    async acknowledgeOutbox(operationId, targetOperationId) {
      acknowledgedOutbox.push(targetOperationId.slice());
      return witness.commit(operationId, {
        tag: "outbox",
        outbox: {
          operationId: targetOperationId,
          logicalMessageId: targetOperationId,
          messageClass: "epoch_ready",
          retryState: "acknowledged",
          ciphertext: new Uint8Array(),
        },
      });
    },
    async acknowledgeReceive() {
      throw new Error("not used");
    },
  };
  const adapter = new RemoteDeviceE2ee({
    endpoint: witnessed(endpoint),
    localDeviceId,
    daemonDeviceId,
    destinationCryptoSessionId: cryptoSessionId,
  });
  const proposal = parseRemoteE2eeEnvelope(
    await adapter.prepareUpdateProposal(updateOperation, updateLogical, 7),
  );
  assert.equal(proposal.messageClass, "update_proposal");
  assert.deepEqual(proposal.ciphertext, Uint8Array.of(7));
  const commit = encodeRemoteE2eeEnvelope({
    operationId: commitOperation,
    logicalMessageId: commitLogical,
    messageClass: "commit",
    hostedGrantGeneration: 7,
    ciphertext: Uint8Array.of(8),
  });
  const ready = parseRemoteE2eeEnvelope(
    await adapter.applyUpdateCommit(commit, readyOperation, readyLogical),
  );
  assert.equal(ready.messageClass, "epoch_ready");
  assert.deepEqual(ready.ciphertext, Uint8Array.of(9));
  assert.equal(ready.logicalMessageId, readyLogical);
  assert.notEqual(ready.operationId, readyOperation, "epoch-ready is its own operation");
  assert.equal(
    calls.filter((call) => call === "continue").length,
    3,
    "proposal, commit application, and epoch-ready each completed their own barrier",
  );
  const confirmation = encodeRemoteE2eeEnvelope({
    operationId: parseOperationId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
    logicalMessageId: parseOperationId("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
    messageClass: "resync_control",
    hostedGrantGeneration: 7,
    ciphertext: Uint8Array.of(10),
  });
  const control = await adapter.open(confirmation);
  assert.equal(control.controlOnly, true);
  assert.equal(confirmed, true);
  assert.deepEqual(acknowledgedOutbox, [uuidBytesForTest("dddddddd-dddd-4ddd-8ddd-dddddddddddd")]);
  assert.equal(calls.filter((call) => call === "continue").length, 5);
});

test("opens daemon delivery and acknowledges only after SDK acceptance", async () => {
  const fixture = fixtureEndpoint();
  const adapter = new RemoteDeviceE2ee({
    endpoint: witnessed(fixture.endpoint),
    localDeviceId,
    daemonDeviceId,
    destinationCryptoSessionId: cryptoSessionId,
  });
  const message = encodeRemoteDaemonMessage({
    version: 1,
    type: "daemon_result",
    requestId,
    method: "daemon.info",
    result: { ok: true },
  });
  const envelope = encodeRemoteE2eeEnvelope({
    operationId: parseOperationId(idempotencyKey),
    logicalMessageId: parseOperationId(requestId),
    messageClass: "application_delivery",
    hostedGrantGeneration: 7,
    ciphertext: message,
  });
  const opened = await adapter.open(envelope);
  assert.equal(opened.authenticatedPeerId, daemonDeviceId);
  assert.deepEqual(adapter.decode(opened.plaintext), {
    version: 1,
    type: "daemon_result",
    requestId,
    method: "daemon.info",
    result: { ok: true },
  });
  assert.equal(fixture.acknowledgements.length, 0);
  assert.deepEqual(fixture.calls, ["read", "reconcile", "mutate", "continue"]);
  await opened.acknowledge?.();
  await opened.acknowledge?.();
  assert.equal(fixture.acknowledgements.length, 1);
  assert.equal(fixture.received.length, 1);
  assert.equal(fixture.calls.filter((call) => call === "continue").length, 2);
});

test("a witness that withholds the certificate withholds the ciphertext and plaintext", async () => {
  const fixture = fixtureEndpoint();
  const adapter = new RemoteDeviceE2ee({
    endpoint: new WitnessedEndpoint(fixture.endpoint, {
      async respond() {
        throw new Error("witness offline");
      },
    }),
    localDeviceId,
    daemonDeviceId,
    destinationCryptoSessionId: cryptoSessionId,
  });
  await assert.rejects(
    adapter.prepareEphemeral(
      { deviceId: localDeviceId, requestId, method: "daemon.info", params: {} },
      7,
    ),
    { message: "witness offline" },
  );
  assert.deepEqual(fixture.calls, ["read"], "no mutation runs without a fresh head");
  assert.equal(fixture.prepared.length, 0);
});
