// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { type ModelPort, ToolRegistry } from "@axl/kernel";
import {
  encodeRemoteE2eeEnvelope,
  parseDeviceId,
  parseInstallationId,
  parseOperationId,
  parseRemoteRequestId,
  parseRouteId,
  type RemoteEndpointWitnessStatus,
} from "@axl/protocol";
import { connectUnixClient } from "@axl/sdk/unix";

import { AxlDaemon } from "../src/daemon.ts";
import { RemoteAuthorityError, RemoteDeviceAuthorityStore } from "../src/remote-authority.ts";
import { type NativeDaemonE2eeEndpoint, WindowsRemoteE2eeBridge } from "../src/remote-e2ee.ts";
import {
  type DaemonWitnessOutcome,
  type DaemonWitnessReconciliation,
  type DaemonWitnessResult,
  DaemonWitnessError,
  DEFAULT_WITNESS_RECOVERY_POLICY,
  HostedDaemonWitnessTransport,
  witnessRecoveryDelay,
  witnessRecoveryPolicy,
} from "../src/remote-witness.ts";

const installationId = parseInstallationId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const deviceId = parseDeviceId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const routeId = parseRouteId("11111111-1111-4111-8111-111111111111");
const certificate = Uint8Array.of(0xc3);
const fixtures = new URL("../../e2ee/fixtures/v1/", import.meta.url);

function idlePort(): ModelPort {
  return {
    async *stream() {
      yield { type: "message_end", stopReason: "stop" as const };
    },
  } as unknown as ModelPort;
}

async function startDaemon(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "axl-witness-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = join(root, "data");
  const authority = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  await authority.registerLocalDevice(deviceId, ["observe"]);
  await authority.applyHostedGrant(deviceId, 1, ["observe"]);
  const socketPath = join(root, "daemon.sock");
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory,
    securityMode: "sandboxed",
    sandboxProvider: "fixture",
    remoteAuthority: authority,
    runtime: () => ({ model: idlePort(), tools: new ToolRegistry(), system: "test" }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  return { daemon, authority, dataDirectory, socketPath };
}

function responseHeaders(contentType: string): { get(name: string): string | null } {
  return { get: (name) => (name === "content-type" ? contentType : null) };
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes.slice()]).stream() as ReadableStream<Uint8Array>;
}

/** Deterministic timer queue: `fire()` runs the earliest scheduled callback and returns its delay. */
function fakeTimers() {
  let nextHandle = 1;
  const scheduled = new Map<number, { run: () => void; delayMs: number }>();
  return {
    scheduled,
    timers: {
      setTimeout(run: () => void, delayMs: number) {
        const handle = nextHandle++;
        scheduled.set(handle, { run, delayMs });
        return handle;
      },
      clearTimeout(handle: unknown) {
        scheduled.delete(handle as number);
      },
    },
    fire(): number {
      const [handle, entry] = [...scheduled.entries()][0] ?? [];
      if (handle === undefined || entry === undefined) throw new Error("no timer scheduled");
      scheduled.delete(handle);
      entry.run();
      return entry.delayMs;
    },
  };
}

/**
 * Scripted endpoint whose reconciliation outcomes are dequeued from `reconciliations`. The
 * receive mutation commits as pending and releases plaintext from the continuation.
 */
function scriptedEndpoint(reconciliations: DaemonWitnessReconciliation[], calls: string[]) {
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      deviceId,
      requestId: parseRemoteRequestId("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
      method: "daemon.info",
      params: {},
    }),
  );
  let pending: { operationId: Uint8Array; result: DaemonWitnessResult } | undefined;
  const commit = (operationId: Uint8Array, result: DaemonWitnessResult): DaemonWitnessOutcome => {
    calls.push("mutate");
    pending = { operationId: operationId.slice(), result };
    return {
      tag: "pending",
      pending: {
        operationId: operationId.slice(),
        request: Uint8Array.of(0x7e),
        requestHash: new Uint8Array(48),
        kind: "advance",
      },
    };
  };
  const endpoint: NativeDaemonE2eeEndpoint = {
    async witnessReadRequest() {
      calls.push("read");
      return Uint8Array.of(0x7d);
    },
    async reconcileWitness() {
      calls.push("reconcile");
      const next = reconciliations.shift();
      if (next === undefined) throw new Error("unscripted reconciliation");
      return next;
    },
    async pendingWitness() {
      return null;
    },
    async continueWitness(operationId) {
      calls.push("continue");
      assert.ok(pending);
      assert.deepEqual(operationId, pending.operationId);
      const result = pending.result;
      pending = undefined;
      return result;
    },
    async receiveApplication(operationId) {
      return commit(operationId, { tag: "plaintext", plaintext: { plaintext: plaintext.slice() } });
    },
    async prepareApplication(operationId, logicalMessageId, _generation, value) {
      return commit(operationId, {
        tag: "outbox",
        outbox: {
          operationId,
          logicalMessageId,
          messageClass: "application_delivery",
          ciphertext: value.slice(),
        },
      });
    },
    async acknowledgeOutbox() {
      throw new Error("not used");
    },
    async acknowledgeReceive(operationId) {
      return commit(operationId, { tag: "accepted", accepted: { acknowledged: true } });
    },
    close() {},
  };
  return endpoint;
}

function delivery(): { sourceRouteId: typeof routeId; opaqueEnvelope: Uint8Array } {
  return {
    sourceRouteId: routeId,
    opaqueEnvelope: encodeRemoteE2eeEnvelope({
      operationId: parseOperationId("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
      logicalMessageId: parseOperationId("ffffffff-ffff-4fff-8fff-ffffffffffff"),
      messageClass: "application_request",
      hostedGrantGeneration: 1,
      ciphertext: Uint8Array.of(1, 2, 3),
    }),
  };
}

test("recovery backoff starts at one second, doubles to a thirty-second cap, and bounds jitter", () => {
  const policy = witnessRecoveryPolicy(undefined);
  assert.deepEqual(policy, DEFAULT_WITNESS_RECOVERY_POLICY);
  const centered = () => 0.5;
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 40].map((attempt) => witnessRecoveryDelay(policy, attempt, centered)),
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000],
  );
  assert.equal(
    witnessRecoveryDelay(policy, 0, () => 0),
    800,
  );
  assert.equal(
    witnessRecoveryDelay(policy, 0, () => 1),
    1_200,
  );
  assert.equal(
    witnessRecoveryDelay(policy, 9, () => 1),
    30_000,
    "jitter never exceeds the cap",
  );
  assert.throws(() => witnessRecoveryDelay(policy, 0, () => 2), TypeError);
  assert.throws(() => witnessRecoveryPolicy({ maximumDelayMs: 10 }), TypeError);
  assert.throws(() => witnessRecoveryPolicy({ jitterRatio: 1.5 }), TypeError);
});

test("the authority store records only witness transitions and persists them", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "axl-witness-authority-"));
  const store = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  await store.registerLocalDevice(deviceId, ["observe"]);
  const changes: string[] = [];
  store.onEndpointWitnessChanged((changed) => changes.push(changed));

  await assert.rejects(
    store.recordEndpointWitnessState(
      parseDeviceId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      "ready",
    ),
    (error) => error instanceof RemoteAuthorityError && error.code === "unknown_device",
  );
  assert.throws(() => store.recordEndpointWitnessState(deviceId, "quarantined"), TypeError);
  assert.throws(
    () => store.recordEndpointWitnessState(deviceId, "ready", "immediate_fork"),
    TypeError,
  );
  assert.deepEqual(store.endpointWitnessStatuses(), []);

  await store.recordEndpointWitnessState(deviceId, "recovering", undefined, 10);
  await store.recordEndpointWitnessState(deviceId, "recovering", undefined, 20);
  await store.recordEndpointWitnessState(deviceId, "recovering", undefined, 30);
  await store.recordEndpointWitnessState(deviceId, "ready", undefined, 40);
  await store.recordEndpointWitnessState(deviceId, "quarantined", "commitment_conflict", 50);
  await store.recordEndpointWitnessState(deviceId, "quarantined", "commitment_conflict", 60);
  assert.deepEqual(
    store.auditEntries().map((event) => [event.code, event.occurredAt, event.quarantineReason]),
    [
      ["device_registered", store.auditEntries()[0]?.occurredAt, undefined],
      ["endpoint_recovering", 10, undefined],
      ["endpoint_ready", 40, undefined],
      ["endpoint_quarantined", 50, "commitment_conflict"],
    ],
    "repeated recovering and quarantined states appended no audit events",
  );
  assert.deepEqual(changes, [deviceId, deviceId, deviceId]);
  const expected: RemoteEndpointWitnessStatus = {
    deviceId,
    state: "quarantined",
    reason: "commitment_conflict",
    changedAt: 50,
  };
  assert.deepEqual(store.endpointWitnessStatuses(), [expected]);
  assert.deepEqual(store.snapshot(deviceId)?.witness, {
    state: "quarantined",
    reason: "commitment_conflict",
    changedAt: 50,
  });

  const reopened = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  assert.deepEqual(reopened.endpointWitnessStatuses(), [expected]);
  assert.deepEqual(reopened.auditEntries(), store.auditEntries());
  await rm(dataDirectory, { recursive: true, force: true });
});

test("an unavailable witness gates new work, retries with backoff, and returns to ready once", async (context) => {
  const { daemon, authority, socketPath } = await startDaemon(context);
  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());
  const deliveries: number[] = [];
  client.onRemoteEndpointsChanged((message) => deliveries.push(message.generation));

  const calls: string[] = [];
  const reconciliations: DaemonWitnessReconciliation[] = [
    { tag: "witness_unavailable" },
    { tag: "witness_unavailable" },
    { tag: "witness_unavailable" },
    { tag: "ready" },
    // receive, response, and acknowledgement each reconcile once
    { tag: "ready" },
    { tag: "ready" },
    { tag: "ready" },
  ];
  const clock = fakeTimers();
  const transitions: string[] = [];
  const errors: Error[] = [];
  let now = 1_000;
  const bridge = new WindowsRemoteE2eeBridge({
    daemon,
    deviceId,
    authority,
    endpoint: scriptedEndpoint(reconciliations, calls),
    witness: { respond: async () => certificate.slice() },
    random: () => 0.5,
    timers: clock.timers,
    now: () => now,
    sender: { send() {} },
    onError: (error) => errors.push(error),
  });
  context.after(() => bridge.close());
  bridge.onWitnessState((status) => transitions.push(`${status.state}@${status.changedAt}`));

  // Before start() establishes a state, ordinary work is refused without touching the endpoint.
  await assert.rejects(
    bridge.receive(delivery()),
    (cause) => cause instanceof DaemonWitnessError && cause.code === "witness_unavailable",
  );
  assert.deepEqual(calls, []);

  assert.equal(await bridge.start(), "recovering");
  assert.deepEqual(transitions, ["recovering@1000"]);
  assert.equal(clock.scheduled.size, 1, "one retry is scheduled");

  // Work is refused without touching the endpoint while recovery is pending.
  const callsBefore = calls.length;
  await assert.rejects(
    bridge.receive(delivery()),
    (cause) => cause instanceof DaemonWitnessError && cause.code === "witness_unavailable",
  );
  assert.equal(calls.length, callsBefore);

  // Retries double from one second; repeated unavailability records nothing new.
  now = 2_000;
  assert.equal(clock.fire(), 1_000);
  // Work submitted after the timer fired but before the retry ran is still refused: the retry
  // itself finds the witness unavailable, so the state stays recovering.
  const raced = bridge.receive(delivery());
  await bridge.drain();
  await assert.rejects(
    raced,
    (cause) => cause instanceof DaemonWitnessError && cause.code === "witness_unavailable",
  );
  assert.deepEqual(calls.slice(callsBefore), ["read", "reconcile"], "only the retry touched it");
  assert.equal(clock.fire(), 2_000);
  await bridge.drain();
  assert.deepEqual(transitions, ["recovering@1000"], "no event per retry");
  assert.equal(
    authority.auditEntries().filter((event) => event.code.startsWith("endpoint_")).length,
    1,
  );

  // The next retry succeeds: exactly one ready transition, no timer left behind.
  now = 3_000;
  assert.equal(clock.fire(), 4_000);
  await bridge.drain();
  assert.deepEqual(transitions, ["recovering@1000", "ready@3000"]);
  assert.equal(clock.scheduled.size, 0);
  assert.equal(bridge.witnessStatus?.state, "ready");

  // Work is admitted again and completes its barrier.
  await bridge.receive(delivery());
  assert.equal(calls.filter((call) => call === "continue").length, 3);
  assert.deepEqual(reconciliations, [], "every scripted reconciliation was consumed");
  assert.deepEqual(errors, []);

  // The daemon reports the lifecycle through daemon.info and announced each transition.
  const info = await client.daemonInfo();
  assert.deepEqual(info.remoteEndpoints, [{ deviceId, state: "ready", changedAt: 3_000 }]);
  assert.deepEqual(deliveries, [1, 2]);
  assert.deepEqual(
    authority
      .auditEntries()
      .filter((event) => event.code.startsWith("endpoint_"))
      .map((event) => event.code),
    ["endpoint_recovering", "endpoint_ready"],
  );
});

test("quarantine and revocation are terminal: no retry timer, work refused, status reported", async (context) => {
  const { daemon, authority, socketPath } = await startDaemon(context);
  const clock = fakeTimers();
  const calls: string[] = [];
  const bridge = new WindowsRemoteE2eeBridge({
    daemon,
    deviceId,
    authority,
    endpoint: scriptedEndpoint(
      [{ tag: "ready" }, { tag: "quarantined", reason: "historical_fork" }],
      calls,
    ),
    witness: { respond: async () => certificate.slice() },
    timers: clock.timers,
    now: () => 77,
    sender: { send() {} },
  });
  context.after(() => bridge.close());
  assert.equal(await bridge.start(), "ready");
  await assert.rejects(
    bridge.receive(delivery()),
    (cause) => cause instanceof DaemonWitnessError && cause.code === "witness_quarantined",
  );
  assert.equal(clock.scheduled.size, 0, "terminal states schedule no retry");
  const before = calls.length;
  await assert.rejects(
    bridge.receive(delivery()),
    (cause) =>
      cause instanceof DaemonWitnessError &&
      cause.code === "witness_quarantined" &&
      cause.reason === "historical_fork",
  );
  assert.equal(calls.length, before, "a quarantined endpoint is never touched again");
  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());
  assert.deepEqual((await client.daemonInfo()).remoteEndpoints, [
    { deviceId, state: "quarantined", reason: "historical_fork", changedAt: 77 },
  ]);

  const revokedCalls: string[] = [];
  const revoked = new WindowsRemoteE2eeBridge({
    daemon,
    deviceId,
    authority,
    endpoint: scriptedEndpoint([{ tag: "revoked" }], revokedCalls),
    witness: { respond: async () => certificate.slice() },
    timers: clock.timers,
    now: () => 78,
    sender: { send() {} },
  });
  context.after(() => revoked.close());
  assert.equal(await revoked.start(), "revoked");
  await assert.rejects(
    revoked.receive(delivery()),
    (cause) => cause instanceof DaemonWitnessError && cause.code === "endpoint_revoked",
  );
  assert.equal(clock.scheduled.size, 0);
  assert.deepEqual((await client.daemonInfo()).remoteEndpoints, [
    { deviceId, state: "revoked", changedAt: 78 },
  ]);
  assert.deepEqual(
    authority
      .auditEntries()
      .filter((event) => event.code.startsWith("endpoint_"))
      .map((event) => [event.code, event.quarantineReason]),
    [
      ["endpoint_ready", undefined],
      ["endpoint_quarantined", "historical_fork"],
      ["endpoint_revoked", undefined],
    ],
  );
});

test("closing the bridge cancels the pending recovery timer", async (context) => {
  const { daemon, authority } = await startDaemon(context);
  const clock = fakeTimers();
  const bridge = new WindowsRemoteE2eeBridge({
    daemon,
    deviceId,
    authority,
    endpoint: scriptedEndpoint([{ tag: "witness_unavailable" }], []),
    witness: { respond: async () => certificate.slice() },
    timers: clock.timers,
    sender: { send() {} },
  });
  assert.equal(await bridge.start(), "recovering");
  assert.equal(clock.scheduled.size, 1);
  await bridge.shutdown();
  assert.equal(clock.scheduled.size, 0);
});

test("a failed status write faults the bridge closed instead of admitting work", async (context) => {
  const { daemon, authority } = await startDaemon(context);
  const clock = fakeTimers();
  const calls: string[] = [];
  let failWrites = false;
  const flaky = new Proxy(authority, {
    get(target, property, receiver) {
      if (property === "recordEndpointWitnessState") {
        return (...args: Parameters<RemoteDeviceAuthorityStore["recordEndpointWitnessState"]>) =>
          failWrites
            ? Promise.reject(new Error("disk full"))
            : target.recordEndpointWitnessState(...args);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const errors: Error[] = [];
  const bridge = new WindowsRemoteE2eeBridge({
    daemon,
    deviceId,
    authority: flaky,
    endpoint: scriptedEndpoint(
      [{ tag: "witness_unavailable" }, { tag: "ready" }, { tag: "ready" }],
      calls,
    ),
    witness: { respond: async () => certificate.slice() },
    timers: clock.timers,
    now: () => 5,
    sender: { send() {} },
    onError: (error) => errors.push(error),
  });
  context.after(() => bridge.close());
  assert.equal(await bridge.start(), "recovering");
  assert.equal(clock.scheduled.size, 1);

  // The retry reconciles ready, but the ready record cannot be written.
  failWrites = true;
  clock.fire();
  await bridge.drain();
  assert.equal(bridge.witnessStatus?.state, "recovering", "the unrecorded state never took effect");
  assert.deepEqual(authority.endpointWitnessStatuses(), [
    { deviceId, state: "recovering", changedAt: 5 },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /could not be recorded/u);
  assert.equal(clock.scheduled.size, 0, "a faulted bridge schedules no further recovery");

  // Every later call, including one after the store recovers, reports the fault.
  failWrites = false;
  const before = calls.length;
  await assert.rejects(bridge.receive(delivery()), /could not be recorded/u);
  await assert.rejects(bridge.start(), /could not be recorded/u);
  assert.equal(calls.length, before, "a faulted bridge never touches the endpoint");
  assert.equal(errors.length, 1, "the fault is reported once");
});

test("audit capacity exhaustion fails the transition closed at the store and the bridge", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-witness-capacity-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = join(root, "data");
  await mkdir(dataDirectory, { recursive: true });
  const capacity = 4_096;
  const audit = Array.from({ length: capacity - 1 }, (_, index) => ({
    sequence: index + 1,
    occurredAt: index,
    code: index === 0 ? "device_registered" : "authorization_denied",
    actorDeviceId: deviceId,
    ...(index === 0 ? { localGeneration: 1 } : { scope: "steer", reason: "scope_forbidden" }),
  }));
  await writeFile(
    join(dataDirectory, "remote-authority.json"),
    `${JSON.stringify({
      version: 2,
      installationId,
      devices: [
        {
          deviceId,
          createdAt: 0,
          local: { generation: 1, scopes: ["observe"] },
          hosted: { generation: 1, scopes: ["observe"] },
        },
      ],
      audit,
    })}\n`,
    { mode: 0o600 },
  );
  const authority = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  assert.equal(authority.auditEntries().length, capacity - 1);

  // The last free slot records one transition; the next transition has nowhere to go.
  await authority.recordEndpointWitnessState(deviceId, "recovering", undefined, 1);
  await authority.recordEndpointWitnessState(deviceId, "recovering", undefined, 2);
  await assert.rejects(
    authority.recordEndpointWitnessState(deviceId, "ready", undefined, 3),
    /audit capacity/u,
  );
  assert.deepEqual(authority.endpointWitnessStatuses(), [
    { deviceId, state: "recovering", changedAt: 1 },
  ]);
  const reopened = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  assert.deepEqual(reopened.endpointWitnessStatuses(), authority.endpointWitnessStatuses());

  const daemon = new AxlDaemon({
    socketPath: join(root, "daemon.sock"),
    dataDirectory,
    securityMode: "sandboxed",
    sandboxProvider: "fixture",
    remoteAuthority: authority,
    runtime: () => ({ model: idlePort(), tools: new ToolRegistry(), system: "test" }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  const calls: string[] = [];
  const errors: Error[] = [];
  const bridge = new WindowsRemoteE2eeBridge({
    daemon,
    deviceId,
    authority,
    endpoint: scriptedEndpoint([{ tag: "ready" }], calls),
    witness: { respond: async () => certificate.slice() },
    timers: fakeTimers().timers,
    sender: { send() {} },
    onError: (error) => errors.push(error),
  });
  context.after(() => bridge.close());
  await assert.rejects(bridge.start(), /could not be recorded/u);
  assert.equal(bridge.witnessStatus, undefined);
  await assert.rejects(bridge.receive(delivery()), /could not be recorded/u);
  assert.deepEqual(calls, ["read", "reconcile"], "the reconciliation ran; nothing after it did");
  assert.equal(errors.length, 1);
  const client = await connectUnixClient(join(root, "daemon.sock"));
  context.after(() => client.close());
  assert.deepEqual((await client.daemonInfo()).remoteEndpoints, [
    { deviceId, state: "recovering", changedAt: 1 },
  ]);
});

test("the daemon HTTP witness transport enforces HTTPS, bounds, content type, and timeouts", async () => {
  assert.throws(
    () =>
      new HostedDaemonWitnessTransport({
        controlPlaneOrigin: "http://witness.example",
        authenticationHeaders: async () => ({}),
        fetch: async () => {
          throw new Error("unreachable");
        },
      }),
    /HTTPS/u,
  );
  const seen: {
    url: string;
    headers: Record<string, string>;
    body: Uint8Array;
    sent: Uint8Array;
  }[] = [];
  const responseBody = new Uint8Array(await readFile(new URL("witness-quorum-v1.bin", fixtures)));
  const request = new Uint8Array(await readFile(new URL("witness-advance-v1.bin", fixtures)));
  const original = request.slice();
  const transport = new HostedDaemonWitnessTransport({
    controlPlaneOrigin: "https://witness.example",
    authenticationHeaders: async () => ({ authorization: "Bearer daemon-token" }),
    fetch: async (url, init) => {
      seen.push({ url, headers: { ...init.headers }, body: init.body.slice(), sent: init.body });
      return {
        ok: true,
        status: 200,
        headers: responseHeaders("application/vnd.axl.rollback-witness-v1"),
        body: stream(responseBody),
      };
    },
  });
  const received = await transport.respond(request);
  assert.deepEqual(received, responseBody);
  assert.equal(seen[0]?.url, "https://witness.example/v1/e2ee/witness");
  assert.equal(seen[0]?.headers.authorization, "Bearer daemon-token");
  assert.deepEqual(seen[0]?.body, original, "request bytes are forwarded unchanged");
  assert.deepEqual(
    seen[0]?.sent,
    new Uint8Array(original.byteLength),
    "the transport's private copy of the request is zeroed after the round trip",
  );
  assert.deepEqual(request, original, "the caller's request is not altered");

  const failing = (response: () => Promise<unknown>) =>
    new HostedDaemonWitnessTransport({
      controlPlaneOrigin: "https://witness.example",
      authenticationHeaders: async () => ({}),
      fetch: response as never,
      timeoutMs: 20,
    });
  await assert.rejects(
    failing(async () => ({
      ok: false,
      status: 503,
      headers: responseHeaders("application/json"),
      body: stream(
        new TextEncoder().encode(JSON.stringify({ error: { code: "witness_unavailable" } })),
      ),
    })).respond(request),
    (cause) => cause instanceof DaemonWitnessError && cause.code === "witness_unavailable",
  );
  await assert.rejects(
    failing(async () => ({
      ok: false,
      status: 401,
      headers: responseHeaders("application/json"),
      body: stream(
        new TextEncoder().encode(JSON.stringify({ error: { code: "witness_auth_failed" } })),
      ),
    })).respond(request),
    (cause) => cause instanceof DaemonWitnessError && cause.code === "witness_auth_failed",
  );
  await assert.rejects(
    failing(async () => ({
      ok: false,
      status: 401,
      headers: responseHeaders("application/json"),
      body: stream(
        new TextEncoder().encode(
          `{"error":{"code":"witness_auth_failed","padding":"${"x".repeat(8_192)}"}}`,
        ),
      ),
    })).respond(request),
    (cause) => cause instanceof DaemonWitnessError && cause.code === "witness_unavailable",
    "an oversized error body is not decoded and keeps the bounded code",
  );
  let pulled = 0;
  await assert.rejects(
    failing(async () => ({
      ok: true,
      status: 200,
      headers: responseHeaders("application/vnd.axl.rollback-witness-v1"),
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(1_024));
        },
      }),
    })).respond(request),
    (cause) => cause instanceof DaemonWitnessError && cause.code === "witness_receipt_invalid",
  );
  assert.ok(pulled <= 5, `reading stopped at the certificate bound after ${pulled} chunks`);
  await assert.rejects(
    failing(async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name === "content-type" ? "application/vnd.axl.rollback-witness-v1" : "1000000",
      },
      body: stream(responseBody),
    })).respond(request),
    (cause) => cause instanceof DaemonWitnessError && cause.code === "witness_receipt_invalid",
    "a declared oversized content length is rejected before reading",
  );
  await assert.rejects(
    failing(async () => ({
      ok: true,
      status: 200,
      headers: responseHeaders("text/plain"),
      body: stream(new Uint8Array(1)),
    })).respond(request),
    (cause) => cause instanceof DaemonWitnessError && cause.code === "witness_receipt_invalid",
  );
  await assert.rejects(
    failing(
      ((_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        })) as never,
    ).respond(request),
    (cause) => cause instanceof DaemonWitnessError && cause.code === "witness_unavailable",
  );
  await assert.rejects(
    transport.respond(new Uint8Array(0)),
    (cause) => cause instanceof DaemonWitnessError && cause.code === "witness_receipt_invalid",
  );
});
