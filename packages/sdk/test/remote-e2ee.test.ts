// SPDX-FileCopyrightText: 2026 Lokesh
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

const localDeviceId = parseDeviceId("11111111-1111-4111-8111-111111111111");
const daemonDeviceId = parseDeviceId("22222222-2222-4222-8222-222222222222");
const cryptoSessionId = parseCryptoSessionId("33333333-3333-4333-8333-333333333333");
const requestId = parseRemoteRequestId("44444444-4444-4444-8444-444444444444");
const idempotencyKey = parseIdempotencyKey("55555555-5555-4555-8555-555555555555");

function fixtureEndpoint() {
  const prepared: Uint8Array[] = [];
  const received: Uint8Array[] = [];
  const acknowledgements: Uint8Array[] = [];
  const endpoint: NativeDeviceE2eeEndpoint = {
    async prepareApplication(operationId, logicalId, generation, plaintext) {
      assert.equal(generation, 7n);
      prepared.push(plaintext.slice());
      return {
        operationId,
        logicalMessageId: logicalId,
        messageClass: "application_request",
        ciphertext: plaintext.slice(),
      };
    },
    async receiveApplication(_operationId, ciphertext, _logicalId, generation) {
      assert.equal(generation, 7n);
      received.push(ciphertext.slice());
      return { plaintext: ciphertext.slice() };
    },
    async acknowledgeOutbox() {
      throw new Error("not used");
    },
    async acknowledgeReceive(operationId) {
      acknowledgements.push(operationId.slice());
      return "acknowledged";
    },
  };
  return { endpoint, prepared, received, acknowledgements };
}

test("prepares immutable native ciphertext for durable relay delivery", async () => {
  const fixture = fixtureEndpoint();
  const adapter = new RemoteDeviceE2ee({
    endpoint: fixture.endpoint,
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
});

test("opens daemon delivery and acknowledges only after SDK acceptance", async () => {
  const fixture = fixtureEndpoint();
  const adapter = new RemoteDeviceE2ee({
    endpoint: fixture.endpoint,
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
  await opened.acknowledge?.();
  await opened.acknowledge?.();
  assert.equal(fixture.acknowledgements.length, 1);
  assert.equal(fixture.received.length, 1);
});
