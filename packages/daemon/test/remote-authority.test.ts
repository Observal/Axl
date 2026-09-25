// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { type ModelPort, ToolRegistry } from "@axl/kernel";
import {
  decodeRemoteDaemonMessage,
  encodeRemoteE2eeEnvelope,
  hashCanonicalRequest,
  type ModelStreamEvent,
  parseDeviceId,
  parseInstallationId,
  parseOperationId,
  parseRemoteE2eeEnvelope,
  parseRemoteRequestId,
  parseRouteId,
  parseSessionId,
} from "@axl/protocol";

import { DeterministicFakeRemoteCryptoAdapter } from "../../protocol/test/support/fake-remote-crypto.ts";
import { CommandJournal, CommandJournalError } from "../src/command-journal.ts";
import { AxlDaemon } from "../src/daemon.ts";
import { RemoteAuthorityError, RemoteDeviceAuthorityStore } from "../src/remote-authority.ts";
import { type NativeDaemonE2eeEndpoint, WindowsRemoteE2eeBridge } from "../src/remote-e2ee.ts";
import { remoteRpcMethods, requiredRemoteScope } from "../src/remote-rpc.ts";
import {
  DaemonWitnessError,
  type DaemonWitnessOutcome,
  type DaemonWitnessResult,
} from "../src/remote-witness.ts";

const witnessCertificate = Uint8Array.of(0xc3);

/**
 * Scripted witness state for the fake daemon endpoints: every mutation commits as pending and
 * releases its exact result only from `continueWitness` with the transport's certificate.
 */
function witnessOperations(calls: string[]) {
  let pending: { operationId: Uint8Array; result: DaemonWitnessResult } | undefined;
  const commit = (operationId: Uint8Array, result: DaemonWitnessResult): DaemonWitnessOutcome => {
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
    async reconcileWitness(certificate: Uint8Array) {
      assert.deepEqual(certificate, witnessCertificate);
      calls.push("reconcile");
      return { tag: "ready" } as const;
    },
    async pendingWitness() {
      return null;
    },
    async continueWitness(operationId: Uint8Array, certificate: Uint8Array) {
      assert.deepEqual(certificate, witnessCertificate);
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

const witness = {
  async respond() {
    return witnessCertificate.slice();
  },
};

const installationId = parseInstallationId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const deviceId = parseDeviceId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const daemonEndpointId = parseDeviceId("cccccccc-cccc-4ccc-8ccc-cccccccccccc");

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "axl-remote-authority-"));
}

function replyPort(): ModelPort {
  return {
    stream() {
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield {
          type: "completed",
          stopReason: "stop",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        };
      })();
    },
  };
}

async function startDaemon(
  context: TestContext,
  securityMode: "sandboxed" | "unsafe" = "sandboxed",
) {
  const root = await directory();
  context.after(() => rm(root, { recursive: true, force: true }));
  const cwd = await realpath(root);
  const dataDirectory = join(root, "data");
  const daemon = new AxlDaemon({
    socketPath: join(root, "daemon.sock"),
    dataDirectory,
    securityMode,
    sandboxProvider: "fixture",
    runtime: () => ({
      model: replyPort(),
      tools: new ToolRegistry(),
      system: "test",
    }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  return { daemon, dataDirectory, cwd };
}

test("remote RPC scope mapping is explicit and excludes dangerous surfaces", () => {
  assert.equal(requiredRemoteScope("daemon.info"), "observe");
  assert.equal(requiredRemoteScope("session.send"), "steer");
  assert.equal(requiredRemoteScope("session.shell"), undefined);
  assert.equal(requiredRemoteScope("session.interaction.respond"), undefined);
  assert.equal(requiredRemoteScope("provider.auth.login"), undefined);
  assert.ok(remoteRpcMethods().length > 0);
});

test("the Windows E2EE bridge authenticates before daemon authorization and seals responses", async (context) => {
  const { daemon, dataDirectory } = await startDaemon(context);
  const authority = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  await authority.registerLocalDevice(deviceId, ["observe"]);
  await authority.applyHostedGrant(deviceId, 1, ["observe"]);
  const requestId = parseRemoteRequestId("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  const operationId = parseOperationId("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  const logicalMessageId = parseOperationId("ffffffff-ffff-4fff-8fff-ffffffffffff");
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ deviceId, requestId, method: "daemon.info", params: {} }),
  );
  const received: Uint8Array[] = [];
  const prepared: Uint8Array[] = [];
  const releasedOutbox: Uint8Array[] = [];
  const calls: string[] = [];
  const scripted = witnessOperations(calls);
  const endpoint: NativeDaemonE2eeEndpoint = {
    ...scripted.operations,
    async receiveApplication(receivedOperation, ciphertext, logicalId, generation) {
      assert.deepEqual(
        receivedOperation,
        Uint8Array.from(Buffer.from(operationId.replaceAll("-", ""), "hex")),
      );
      assert.deepEqual(
        logicalId,
        Uint8Array.from(Buffer.from(logicalMessageId.replaceAll("-", ""), "hex")),
      );
      assert.equal(generation, 1n);
      received.push(ciphertext.slice());
      return scripted.commit(receivedOperation, {
        tag: "plaintext",
        plaintext: { plaintext: plaintext.slice() },
      });
    },
    async prepareApplication(operation, logical, generation, value) {
      assert.equal(generation, 1n);
      prepared.push(value.slice());
      return scripted.commit(operation, {
        tag: "outbox",
        outbox: {
          operationId: operation,
          logicalMessageId: logical,
          messageClass: "application_delivery",
          ciphertext: value.slice(),
        },
      });
    },
    async acknowledgeOutbox(operation, target) {
      releasedOutbox.push(target.slice());
      return scripted.commit(operation, {
        tag: "outbox",
        outbox: {
          operationId: target.slice(),
          logicalMessageId: target.slice(),
          messageClass: "application_delivery",
          ciphertext: Uint8Array.of(0),
        },
      });
    },
    async acknowledgeReceive(operation) {
      return scripted.commit(operation, { tag: "accepted", accepted: { acknowledged: true } });
    },
    close() {},
  };
  const sent: Uint8Array[] = [];
  const bridge = new WindowsRemoteE2eeBridge({
    daemon,
    deviceId,
    authority,
    endpoint,
    witness,
    sender: {
      send(_route, envelope) {
        sent.push(envelope.slice());
      },
    },
  });
  context.after(() => bridge.close());
  assert.equal(await bridge.start(), "ready");
  await bridge.receive({
    sourceRouteId: parseRouteId("11111111-1111-4111-8111-111111111111"),
    opaqueEnvelope: encodeRemoteE2eeEnvelope({
      operationId,
      logicalMessageId,
      messageClass: "application_request",
      hostedGrantGeneration: 1,
      ciphertext: Uint8Array.of(1, 2, 3),
    }),
  });
  assert.deepEqual(received, [Uint8Array.of(1, 2, 3)]);
  assert.equal(sent.length, 1);
  const responseEnvelope = parseRemoteE2eeEnvelope(sent[0] ?? new Uint8Array());
  assert.equal(responseEnvelope.messageClass, "application_delivery");
  const response = decodeRemoteDaemonMessage(responseEnvelope.ciphertext);
  assert.equal(response.type, "daemon_result");
  if (response.type === "daemon_result") {
    assert.equal(response.requestId, requestId);
    assert.equal(response.method, "daemon.info");
  }
  assert.equal(prepared.length, 1);
  assert.deepEqual(
    releasedOutbox,
    [Uint8Array.from(Buffer.from(responseEnvelope.operationId.replaceAll("-", ""), "hex"))],
    "the sent response leaves the native outbox",
  );
  assert.deepEqual(
    calls,
    [
      "read",
      "reconcile",
      "read",
      "reconcile",
      "mutate",
      "continue",
      "read",
      "reconcile",
      "mutate",
      "continue",
      "read",
      "reconcile",
      "mutate",
      "continue",
      "read",
      "reconcile",
      "mutate",
      "continue",
    ],
    "start reconciled once; receive, response, outbox release, and receive acknowledgement each completed their own barrier in order",
  );
});

test("the Windows E2EE bridge releases no plaintext or ciphertext when the witness withholds a certificate", async (context) => {
  const { daemon, dataDirectory } = await startDaemon(context);
  const authority = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  await authority.registerLocalDevice(deviceId, ["observe"]);
  await authority.applyHostedGrant(deviceId, 1, ["observe"]);
  const calls: string[] = [];
  const scripted = witnessOperations(calls);
  const requestId = parseRemoteRequestId("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ deviceId, requestId, method: "daemon.info", params: {} }),
  );
  const endpoint: NativeDaemonE2eeEndpoint = {
    ...scripted.operations,
    async receiveApplication(operation) {
      return scripted.commit(operation, {
        tag: "plaintext",
        plaintext: { plaintext: plaintext.slice() },
      });
    },
    async prepareApplication() {
      throw new Error("not reached");
    },
    async acknowledgeOutbox() {
      throw new Error("not used");
    },
    async acknowledgeReceive() {
      throw new Error("not reached");
    },
    close() {},
  };
  const sent: Uint8Array[] = [];
  const errors: Error[] = [];
  let responses = 0;
  const bridge = new WindowsRemoteE2eeBridge({
    daemon,
    deviceId,
    authority,
    endpoint,
    witness: {
      async respond(request) {
        responses += 1;
        // The fresh read succeeds; the committed advance never receives its certificate.
        if (request[0] === 0x7d) return witnessCertificate.slice();
        throw new DaemonWitnessError("witness_unavailable", "witness offline");
      },
    },
    sender: {
      send(_route, envelope) {
        sent.push(envelope.slice());
      },
    },
    onError: (error) => errors.push(error),
  });
  context.after(() => bridge.close());
  assert.equal(await bridge.start(), "ready");
  await assert.rejects(
    bridge.receive({
      sourceRouteId: parseRouteId("11111111-1111-4111-8111-111111111111"),
      opaqueEnvelope: encodeRemoteE2eeEnvelope({
        operationId: parseOperationId("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
        logicalMessageId: parseOperationId("ffffffff-ffff-4fff-8fff-ffffffffffff"),
        messageClass: "application_request",
        hostedGrantGeneration: 1,
        ciphertext: Uint8Array.of(1, 2, 3),
      }),
    }),
    (cause) => cause instanceof DaemonWitnessError && cause.code === "witness_unavailable",
  );
  assert.deepEqual(
    calls,
    ["read", "reconcile", "read", "reconcile", "mutate"],
    "no continuation, no plaintext",
  );
  assert.equal(responses, 3);
  assert.deepEqual(sent, [], "the daemon never authorized or answered the request");
  assert.equal(errors.length, 1);
});

test("the Windows E2EE bridge prioritizes update commits and epoch readiness", async (context) => {
  const { daemon, dataDirectory } = await startDaemon(context);
  const authority = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  await authority.registerLocalDevice(deviceId, ["observe"]);
  await authority.applyHostedGrant(deviceId, 3, ["observe"]);
  const updateOperation = parseOperationId("11111111-1111-4111-8111-111111111111");
  const updateLogical = parseOperationId("22222222-2222-4222-8222-222222222222");
  const epochOperation = parseOperationId("33333333-3333-4333-8333-333333333333");
  const epochLogical = parseOperationId("44444444-4444-4444-8444-444444444444");
  const accepted: string[] = [];
  const acknowledgements: Uint8Array[] = [];
  const outboxAcknowledgements: Uint8Array[] = [];
  const calls: string[] = [];
  const scripted = witnessOperations(calls);
  const endpoint: NativeDaemonE2eeEndpoint = {
    ...scripted.operations,
    async prepareApplication() {
      throw new Error("not used");
    },
    async receiveApplication() {
      throw new Error("not used");
    },
    async receiveReplacementProposal(operation, ciphertext, _logical, generation) {
      assert.deepEqual(ciphertext, Uint8Array.of(7));
      assert.equal(generation, 3n);
      accepted.push("proposal");
      return scripted.commit(operation, { tag: "accepted", accepted: { acknowledged: false } });
    },
    async createUpdateCommit(operationId, logicalMessageId, generation) {
      assert.equal(generation, 3n);
      accepted.push("commit");
      return scripted.commit(operationId, {
        tag: "outbox",
        outbox: {
          operationId,
          logicalMessageId,
          messageClass: "commit",
          ciphertext: Uint8Array.of(8),
        },
      });
    },
    async acceptEpochReady(operation) {
      accepted.push("epoch_ready");
      return scripted.commit(operation, {
        tag: "epoch_ready",
        epochReady: { cryptoSessionId: new Uint8Array(16), commitId: new Uint8Array(48) },
      });
    },
    async prepareEpochReadyConfirmation(operationId, logicalMessageId, generation, acceptance) {
      assert.equal(generation, 3n);
      assert.equal(acceptance.commitId.byteLength, 48);
      accepted.push("confirmation");
      return scripted.commit(operationId, {
        tag: "outbox",
        outbox: {
          operationId,
          logicalMessageId,
          messageClass: "resync_control",
          ciphertext: Uint8Array.of(10),
        },
      });
    },
    async acknowledgeOutbox(operationId, targetOperationId) {
      outboxAcknowledgements.push(targetOperationId.slice());
      return scripted.commit(operationId, {
        tag: "outbox",
        outbox: {
          operationId: targetOperationId,
          logicalMessageId: targetOperationId,
          messageClass: "commit",
          retryState: "acknowledged",
          ciphertext: new Uint8Array(),
        },
      });
    },
    async acknowledgeReceive(operationId) {
      acknowledgements.push(operationId.slice());
      return scripted.commit(operationId, { tag: "accepted", accepted: { acknowledged: true } });
    },
    close() {},
  };
  const sent: Uint8Array[] = [];
  const bridge = new WindowsRemoteE2eeBridge({
    daemon,
    deviceId,
    authority,
    endpoint,
    witness,
    sender: {
      send(_route, envelope) {
        sent.push(envelope.slice());
      },
    },
  });
  context.after(() => bridge.close());
  assert.equal(await bridge.start(), "ready");
  const sourceRouteId = parseRouteId("55555555-5555-4555-8555-555555555555");
  await bridge.receive({
    sourceRouteId,
    opaqueEnvelope: encodeRemoteE2eeEnvelope({
      operationId: updateOperation,
      logicalMessageId: updateLogical,
      messageClass: "update_proposal",
      hostedGrantGeneration: 3,
      ciphertext: Uint8Array.of(7),
    }),
  });
  assert.deepEqual(accepted, ["proposal", "commit"]);
  assert.equal(sent.length, 1);
  assert.equal(parseRemoteE2eeEnvelope(sent[0] ?? new Uint8Array()).messageClass, "commit");
  await bridge.receive({
    sourceRouteId,
    opaqueEnvelope: encodeRemoteE2eeEnvelope({
      operationId: epochOperation,
      logicalMessageId: epochLogical,
      messageClass: "epoch_ready",
      hostedGrantGeneration: 3,
      ciphertext: Uint8Array.of(9),
    }),
  });
  assert.deepEqual(accepted, ["proposal", "commit", "epoch_ready", "confirmation"]);
  assert.equal(acknowledgements.length, 1);
  assert.deepEqual(outboxAcknowledgements, [
    Uint8Array.from(Buffer.from(epochLogical.replaceAll("-", ""), "hex")),
  ]);
  assert.equal(sent.length, 2);
  assert.equal(parseRemoteE2eeEnvelope(sent[1] ?? new Uint8Array()).messageClass, "resync_control");
  assert.equal(
    calls.filter((call) => call === "continue").length,
    6,
    "proposal, commit, proposal ack, epoch-ready, confirmation, and commit ack each completed",
  );
});

test("intersects local and hosted grants without allowing hosted widening", async () => {
  const dataDirectory = await directory();
  const store = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);

  await store.registerLocalDevice(deviceId, ["steer", "observe"]);
  assert.throws(
    () => store.authorize(deviceId, "observe"),
    (error) => error instanceof RemoteAuthorityError && error.code === "hosted_grant_missing",
  );

  const snapshot = await store.applyHostedGrant(deviceId, 1, [
    "manage_sessions",
    "observe",
    "steer",
  ]);
  assert.deepEqual(snapshot.effectiveScopes, ["observe", "steer"]);
  assert.deepEqual(store.authorize(deviceId, "steer"), {
    installationId,
    deviceId,
    localGrantGeneration: 1,
    hostedGrantGeneration: 1,
    effectiveScopes: ["observe", "steer"],
  });
  assert.throws(
    () => store.authorize(deviceId, "manage_sessions"),
    (error) => error instanceof RemoteAuthorityError && error.code === "scope_forbidden",
  );

  const narrowed = await store.narrowLocalGrant(deviceId, ["observe"]);
  assert.equal(narrowed.localGeneration, 2);
  assert.deepEqual(narrowed.effectiveScopes, ["observe"]);
  await assert.rejects(
    store.narrowLocalGrant(deviceId, ["observe", "steer"]),
    (error) => error instanceof RemoteAuthorityError && error.code === "grant_conflict",
  );
  await assert.rejects(
    store.authorizeAudited(deviceId, "steer"),
    (error) => error instanceof RemoteAuthorityError && error.code === "scope_forbidden",
  );
  assert.deepEqual(
    store.auditEntries().map((event) => [event.sequence, event.code]),
    [
      [1, "device_registered"],
      [2, "hosted_grant_narrowed"],
      [3, "local_grant_narrowed"],
      [4, "authorization_denied"],
    ],
  );
  const reopened = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  assert.deepEqual(reopened.auditEntries(), store.auditEntries());

  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
});

test("serializes hosted generations and rejects stale or conflicting updates", async () => {
  const store = await RemoteDeviceAuthorityStore.open(await directory(), installationId);
  await store.registerLocalDevice(deviceId, ["observe", "steer"]);

  const competing = await Promise.allSettled([
    store.applyHostedGrant(deviceId, 1, ["observe"]),
    store.applyHostedGrant(deviceId, 1, ["steer"]),
  ]);
  assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = competing.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.ok(rejected.reason instanceof RemoteAuthorityError);
  assert.equal(rejected.reason.code, "grant_conflict");

  await assert.rejects(
    store.applyHostedGrant(deviceId, 0, ["observe"]),
    /generation must be positive/,
  );

  await store.applyHostedGrant(deviceId, 2, ["observe", "steer"]);
  await assert.rejects(
    store.applyHostedGrant(deviceId, 1, ["observe"]),
    (error) => error instanceof RemoteAuthorityError && error.code === "stale_grant_generation",
  );
});

test("persists irreversible revocation and rechecks it after fake E2EE authentication", async () => {
  const dataDirectory = await directory();
  const store = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  await store.registerLocalDevice(deviceId, ["observe", "steer"]);
  await store.applyHostedGrant(deviceId, 1, ["observe", "steer"]);

  const deviceCrypto = new DeterministicFakeRemoteCryptoAdapter(deviceId, daemonEndpointId);
  const daemonCrypto = new DeterministicFakeRemoteCryptoAdapter(daemonEndpointId, deviceId);
  const envelope = await deviceCrypto.seal(
    daemonEndpointId,
    new TextEncoder().encode('{"method":"test.ping"}'),
  );
  const authenticated = await daemonCrypto.open(envelope);
  assert.equal(authenticated.authenticatedDeviceId, deviceId);
  assert.equal(store.authorize(authenticated.authenticatedDeviceId, "steer").deviceId, deviceId);

  await store.revokeLocalDevice(deviceId, 1_900_000_000_000);
  assert.throws(
    () => store.authorize(authenticated.authenticatedDeviceId, "steer"),
    (error) => error instanceof RemoteAuthorityError && error.code === "device_revoked",
  );

  const restored = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  assert.equal(restored.snapshot(deviceId)?.locallyRevoked, true);
  assert.throws(
    () => restored.authorize(deviceId, "observe"),
    (error) => error instanceof RemoteAuthorityError && error.code === "device_revoked",
  );
  await assert.rejects(
    restored.registerLocalDevice(deviceId, ["observe", "steer"]),
    (error) => error instanceof RemoteAuthorityError && error.code === "grant_conflict",
  );
});

test("authorizes before applying durable command idempotency behind fake E2EE", async () => {
  const dataDirectory = await directory();
  const store = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  await store.registerLocalDevice(deviceId, ["observe", "steer"]);
  await store.applyHostedGrant(deviceId, 1, ["observe", "steer"]);

  const deviceCrypto = new DeterministicFakeRemoteCryptoAdapter(deviceId, daemonEndpointId);
  const daemonCrypto = new DeterministicFakeRemoteCryptoAdapter(daemonEndpointId, deviceId);
  const sessionId = parseSessionId("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  const idempotencyKey = parseOperationId("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  const params = { sessionId };
  const envelope = await deviceCrypto.seal(
    daemonEndpointId,
    new TextEncoder().encode(JSON.stringify({ method: "session.interrupt", params })),
  );
  const opened = await daemonCrypto.open(envelope);
  const journal = await CommandJournal.open(dataDirectory);
  let executions = 0;
  const execute = () =>
    store.runAuthorizedUntilAccepted(opened.authenticatedDeviceId, "steer", () =>
      journal.start(
        {
          idempotencyKey,
          method: "session.interrupt",
          requestHash: hashCanonicalRequest("session.interrupt", params),
          targetSessionId: sessionId,
        },
        async () => {
          executions += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { interrupted: false };
        },
      ),
    );

  assert.deepEqual(await Promise.all([execute(), execute()]), [
    { interrupted: false },
    { interrupted: false },
  ]);
  assert.equal(executions, 1);
  await assert.rejects(
    store.runAuthorizedUntilAccepted(opened.authenticatedDeviceId, "steer", () =>
      journal.start(
        {
          idempotencyKey,
          method: "session.interrupt",
          requestHash: hashCanonicalRequest("session.interrupt", {
            sessionId: parseSessionId("ffffffff-ffff-4fff-8fff-ffffffffffff"),
          }),
        },
        async () => ({ interrupted: false }),
      ),
    ),
    (error) => error instanceof CommandJournalError && error.code === "idempotency_conflict",
  );
});

test("revocation waits for durable acceptance but not operation completion", async () => {
  const dataDirectory = await directory();
  const store = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  await store.registerLocalDevice(deviceId, ["steer"]);
  await store.applyHostedGrant(deviceId, 1, ["steer"]);
  const journal = await CommandJournal.open(dataDirectory);
  const sessionId = parseSessionId("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  const idempotencyKey = parseOperationId("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed = false;

  const completion = store
    .runAuthorizedUntilAccepted(deviceId, "steer", () =>
      journal.start(
        {
          idempotencyKey,
          method: "session.interrupt",
          requestHash: hashCanonicalRequest("session.interrupt", { sessionId }),
          targetSessionId: sessionId,
        },
        async () => {
          await hold;
          return { interrupted: false };
        },
      ),
    )
    .finally(() => {
      completed = true;
    });
  await store.revokeLocalDevice(deviceId, 1_900_000_000_000);
  assert.equal(completed, false);
  assert.throws(
    () => store.authorize(deviceId, "steer"),
    (error) => error instanceof RemoteAuthorityError && error.code === "device_revoked",
  );

  release();
  assert.deepEqual(await completion, { interrupted: false });
});

test("makes hosted revocation irreversible for one device identity", async () => {
  const store = await RemoteDeviceAuthorityStore.open(await directory(), installationId);
  await store.registerLocalDevice(deviceId, ["observe", "steer"]);
  await store.applyHostedGrant(deviceId, 1, ["observe", "steer"]);
  await store.applyHostedGrant(deviceId, 2, ["observe", "steer"], 1_900_000_000_000);

  assert.throws(
    () => store.authorize(deviceId, "observe"),
    (error) => error instanceof RemoteAuthorityError && error.code === "device_revoked",
  );
  await assert.rejects(
    store.applyHostedGrant(deviceId, 3, ["observe", "steer"]),
    (error) => error instanceof RemoteAuthorityError && error.code === "grant_conflict",
  );
});

test("internal dispatcher enforces scope, method allowlist, identity, and active revocation", async (context) => {
  const { daemon, dataDirectory } = await startDaemon(context);
  const authority = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  await authority.registerLocalDevice(deviceId, ["observe"]);
  await authority.applyHostedGrant(deviceId, 1, ["observe", "steer"]);
  const deliveries: unknown[] = [];
  const attachment = daemon.attachAuthenticatedRemoteDevice({
    deviceId,
    authority,
    send: (message) => deliveries.push(message),
  });

  const info = await attachment.request({
    deviceId,
    requestId: "11111111-1111-4111-8111-111111111111",
    method: "daemon.info",
    params: {},
  });
  assert.equal(info.method, "daemon.info");
  assert.deepEqual(info.result, {
    securityMode: "sandboxed",
    sandboxProvider: "fixture",
    remoteEndpoints: [],
  });
  assert.deepEqual(deliveries, []);

  await assert.rejects(
    attachment.request({
      deviceId,
      requestId: "22222222-2222-4222-8222-222222222222",
      method: "session.interrupt",
      params: { sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
      idempotencyKey: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    }),
    (error) => error instanceof RemoteAuthorityError && error.code === "scope_forbidden",
  );
  await assert.rejects(
    attachment.request({
      deviceId,
      requestId: "33333333-3333-4333-8333-333333333333",
      method: "connection.ping",
      params: {},
    }),
    (error) => error instanceof RemoteAuthorityError && error.code === "remote_method_forbidden",
  );
  await assert.rejects(
    attachment.request({
      deviceId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      requestId: "44444444-4444-4444-8444-444444444444",
      method: "daemon.info",
      params: {},
    }),
    (error) => error instanceof RemoteAuthorityError && error.code === "device_identity_mismatch",
  );

  await authority.revokeLocalDevice(deviceId);
  await assert.rejects(
    attachment.request({
      deviceId,
      requestId: "55555555-5555-4555-8555-555555555555",
      method: "daemon.info",
      params: {},
    }),
    (error) => error instanceof RemoteAuthorityError && error.code === "device_revoked",
  );
});

test("internal dispatcher rejects remote mutations in unsafe mode", async (context) => {
  const { daemon, dataDirectory } = await startDaemon(context, "unsafe");
  const authority = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  await authority.registerLocalDevice(deviceId, ["observe", "steer"]);
  await authority.applyHostedGrant(deviceId, 1, ["observe", "steer"]);
  const attachment = daemon.attachAuthenticatedRemoteDevice({
    deviceId,
    authority,
    send: () => undefined,
  });

  await assert.rejects(
    attachment.request({
      deviceId,
      requestId: "66666666-6666-4666-8666-666666666666",
      method: "session.interrupt",
      params: { sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
      idempotencyKey: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    }),
    (error) => error instanceof RemoteAuthorityError && error.code === "unsafe_remote_forbidden",
  );
});

test("rejects an oversized authority store before parsing", async () => {
  const dataDirectory = await directory();
  await writeFile(join(dataDirectory, "remote-authority.json"), new Uint8Array(1024 * 1024 + 1));

  await assert.rejects(
    RemoteDeviceAuthorityStore.open(dataDirectory, installationId),
    /exceeds 1048576 bytes/,
  );
});

test("rejects a symlinked authority store", async () => {
  const dataDirectory = await directory();
  const target = join(dataDirectory, "outside.json");
  await writeFile(target, "{}\n");
  await symlink(target, join(dataDirectory, "remote-authority.json"));

  await assert.rejects(
    RemoteDeviceAuthorityStore.open(dataDirectory, installationId),
    /must be a regular file/,
  );
});
