// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { type ModelPort, ToolRegistry } from "@axl/kernel";
import {
  type AuthenticatedRemoteRequest,
  decodeRemoteDaemonMessage,
  encodeRemoteE2eeEnvelope,
  type ModelStreamEvent,
  parseDeviceId,
  parseInstallationId,
  parseOperationId,
  parseRemoteE2eeEnvelope,
  parseRemoteRequestId,
  parseRouteId,
  parseSessionId,
  RemoteDaemonMessageAssembler,
  type RemoteDaemonMessage,
  type RouteId,
  type ServerMessage,
} from "@axl/protocol";

import {
  AxlDaemon,
  type AuthenticatedRemoteAttachment,
  type AuthenticatedRemoteAttachmentOptions,
  type AuthenticatedRemoteRequestObserver,
  type AuthenticatedRemoteRequestResult,
} from "../src/daemon.ts";
import { RemoteAuthorityError, RemoteDeviceAuthorityStore } from "../src/remote-authority.ts";
import { type NativeDaemonE2eeEndpoint, WindowsRemoteE2eeBridge } from "../src/remote-e2ee.ts";
import { DaemonWitnessError, type DaemonWitnessTransport } from "../src/remote-witness.ts";

const installationId = parseInstallationId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const deviceId = parseDeviceId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const firstRoute = parseRouteId("11111111-1111-4111-8111-111111111111");
const secondRoute = parseRouteId("22222222-2222-4222-8222-222222222222");
const FORGED = 0xff;

/**
 * Transparent fake endpoint: a ciphertext is its plaintext, and one starting with `FORGED` fails
 * authentication. Every mutation releases its result immediately.
 */
function transparentEndpoint() {
  const received: string[] = [];
  const acknowledged: string[] = [];
  const prepared: string[] = [];
  const released: string[] = [];
  const endpoint: NativeDaemonE2eeEndpoint = {
    async witnessReadRequest() {
      return Uint8Array.of(0x7d);
    },
    async reconcileWitness() {
      return { tag: "ready" } as const;
    },
    async pendingWitness() {
      return null;
    },
    async continueWitness() {
      throw new Error("not used");
    },
    async receiveApplication(operation, ciphertext) {
      if (ciphertext[0] === FORGED) throw new Error("MLS authentication failed");
      received.push(Buffer.from(operation).toString("hex"));
      return {
        tag: "released",
        result: { tag: "plaintext", plaintext: { plaintext: ciphertext.slice() } },
      };
    },
    async prepareApplication(operation, logical, _generation, plaintext) {
      prepared.push(Buffer.from(operation).toString("hex"));
      return {
        tag: "released",
        result: {
          tag: "outbox",
          outbox: {
            operationId: operation.slice(),
            logicalMessageId: logical.slice(),
            messageClass: "application_delivery",
            ciphertext: plaintext.slice(),
          },
        },
      };
    },
    async acknowledgeOutbox(_operation, target) {
      released.push(Buffer.from(target).toString("hex"));
      return {
        tag: "released",
        result: {
          tag: "outbox",
          outbox: {
            operationId: target.slice(),
            logicalMessageId: target.slice(),
            messageClass: "application_delivery",
            ciphertext: Uint8Array.of(0),
          },
        },
      };
    },
    async acknowledgeReceive(_operation, target) {
      acknowledged.push(Buffer.from(target).toString("hex"));
      return { tag: "released", result: { tag: "accepted", accepted: { acknowledged: true } } };
    },
    close() {},
  };
  return { endpoint, received, acknowledged, prepared, released };
}

type Handler = (
  request: AuthenticatedRemoteRequest,
  observer: AuthenticatedRemoteRequestObserver | undefined,
  send: (message: ServerMessage) => void,
) => Promise<AuthenticatedRemoteRequestResult>;

/** Stands in for the daemon so each test scripts acceptance, completion, and activation. */
function scriptedDaemon(
  handler: Handler,
  attached: { send?: (message: ServerMessage) => void } = {},
): AxlDaemon {
  return {
    attachAuthenticatedRemoteDevice(
      options: AuthenticatedRemoteAttachmentOptions,
    ): AuthenticatedRemoteAttachment {
      attached.send = options.send;
      return {
        request: (value, observer) =>
          handler(value as AuthenticatedRemoteRequest, observer, options.send),
        close() {},
      };
    },
  } as unknown as AxlDaemon;
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

async function waitFor(description: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function harness(
  context: TestContext,
  handler: Handler,
  options: {
    readonly deliveryFlushMs?: number;
    readonly witness?: DaemonWitnessTransport;
    readonly recovery?: { readonly initialDelayMs: number; readonly maximumDelayMs: number };
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "axl-bridge-dispatch-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const authority = await RemoteDeviceAuthorityStore.open(join(root, "data"), installationId);
  await authority.registerLocalDevice(deviceId, ["observe", "steer"]);
  await authority.applyHostedGrant(deviceId, 1, ["observe", "steer"]);
  const fake = transparentEndpoint();
  const sent: { route: RouteId; bytes: Uint8Array; message: RemoteDaemonMessage }[] = [];
  const errors: Error[] = [];
  const attached: { send?: (message: ServerMessage) => void } = {};
  const bridge = new WindowsRemoteE2eeBridge({
    ...options,
    onError: (error) => errors.push(error),
    daemon: scriptedDaemon(handler, attached),
    deviceId,
    authority,
    endpoint: fake.endpoint,
    witness: options.witness ?? { respond: async () => Uint8Array.of(0xc3) },
    sender: {
      send(route, bytes) {
        const envelope = parseRemoteE2eeEnvelope(bytes);
        sent.push({
          route,
          bytes: bytes.slice(),
          message: decodeRemoteDaemonMessage(envelope.ciphertext),
        });
      },
    },
  });
  context.after(() => bridge.close());
  assert.equal(await bridge.start(), "ready");
  const emit = (message: ServerMessage): void => {
    assert.ok(attached.send);
    attached.send(message);
  };
  return { bridge, sent, errors, authority, emit, ...fake };
}

let sequence = 0;
function requestEnvelope(
  request: AuthenticatedRemoteRequest,
  forged = false,
  hostedGrantGeneration = 1,
): Uint8Array {
  sequence += 1;
  const suffix = sequence.toString(16).padStart(12, "0");
  const plaintext = new TextEncoder().encode(JSON.stringify(request));
  return encodeRemoteE2eeEnvelope({
    operationId: parseOperationId(`eeeeeeee-eeee-4eee-8eee-${suffix}`),
    logicalMessageId: parseOperationId(`ffffffff-ffff-4fff-8fff-${suffix}`),
    messageClass: "application_request",
    hostedGrantGeneration,
    ciphertext: forged ? Uint8Array.of(FORGED, ...plaintext) : plaintext,
  });
}

function changed(generation: number): ServerMessage {
  return { kind: "sessions_changed", generation };
}

function sendRequest(id: string): AuthenticatedRemoteRequest {
  return {
    deviceId,
    requestId: parseRemoteRequestId(`${id}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`),
    method: "session.send",
    params: {},
    idempotencyKey: parseOperationId(`${id}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`),
  } as unknown as AuthenticatedRemoteRequest;
}

function infoRequest(id: string): AuthenticatedRemoteRequest {
  return {
    deviceId,
    requestId: parseRemoteRequestId(`${id}-cccc-4ccc-8ccc-cccccccccccc`),
    method: "daemon.info",
    params: {},
  } as unknown as AuthenticatedRemoteRequest;
}

function result(request: AuthenticatedRemoteRequest): AuthenticatedRemoteRequestResult {
  return {
    requestId: request.requestId,
    method: request.method as AuthenticatedRemoteRequestResult["method"],
    result: { ok: true },
  };
}

function types(sent: readonly { message: RemoteDaemonMessage }[]): string[] {
  return sent.map(({ message }) =>
    message.type === "daemon_delivery" ? `delivery:${message.message.kind}` : message.type,
  );
}

test("acceptance is sent at journal acceptance and a running turn does not block other requests", async (context) => {
  const turn = gate();
  const { bridge, sent, errors, acknowledged } = await harness(
    context,
    async (request, observer, send) => {
      if (request.method === "session.send") {
        observer?.accepted?.();
        await turn.opened;
      }
      const completed = result(request);
      observer?.completed?.(completed);
      if (request.method === "session.send") {
        send({ kind: "sessions_changed", generation: 1 });
      }
      return completed;
    },
  );

  const running = bridge.receive({
    sourceRouteId: firstRoute,
    opaqueEnvelope: requestEnvelope(sendRequest("10000000")),
  });
  await waitFor("acceptance", () => sent.length === 1);
  assert.deepEqual(types(sent), ["daemon_accepted"], "acceptance precedes the turn's completion");

  // An unrelated request is authenticated, executed, and answered while the turn still runs.
  await bridge.receive({
    sourceRouteId: firstRoute,
    opaqueEnvelope: requestEnvelope(infoRequest("20000000")),
  });
  assert.deepEqual(types(sent), ["daemon_accepted", "daemon_result"]);
  assert.equal(acknowledged.length, 1);

  turn.open();
  await running;
  await bridge.drain();
  assert.deepEqual(
    types(sent),
    ["daemon_accepted", "daemon_result", "daemon_result", "delivery:sessions_changed"],
    "the result is sealed before the deliveries its completion activated",
  );
  assert.equal(acknowledged.length, 2, "each receive is acknowledged after its replies");
  assert.deepEqual(errors, []);
});

test("a byte-exact replay re-sends cached replies on the new route without re-executing", async (context) => {
  const turn = gate();
  let executions = 0;
  const { bridge, sent, received } = await harness(context, async (request, observer) => {
    executions += 1;
    if (request.method === "session.send") {
      observer?.accepted?.();
      await turn.opened;
    }
    const completed = result(request);
    observer?.completed?.(completed);
    return completed;
  });

  const info = requestEnvelope(infoRequest("30000000"));
  await bridge.receive({ sourceRouteId: firstRoute, opaqueEnvelope: info });
  await bridge.receive({ sourceRouteId: secondRoute, opaqueEnvelope: info });
  assert.equal(executions, 1);
  assert.equal(received.length, 1, "the replay never reached the endpoint");
  assert.deepEqual(
    sent.map(({ route }) => route),
    [firstRoute, secondRoute],
  );
  assert.deepEqual(sent[1]?.bytes, sent[0]?.bytes, "the replay carries the exact sealed reply");

  // A replay of a request still running re-sends its acceptance and moves its result.
  sent.length = 0;
  const durable = requestEnvelope(sendRequest("40000000"));
  const running = bridge.receive({ sourceRouteId: firstRoute, opaqueEnvelope: durable });
  await waitFor("acceptance", () => sent.length === 1);
  await bridge.receive({ sourceRouteId: secondRoute, opaqueEnvelope: durable });
  turn.open();
  await running;
  assert.equal(executions, 2);
  assert.deepEqual(
    sent.map(({ route, message }) => [route, message.type]),
    [
      [firstRoute, "daemon_accepted"],
      [secondRoute, "daemon_accepted"],
      [secondRoute, "daemon_result"],
    ],
  );
});

test("an unauthenticated frame never moves the reply route", async (context) => {
  const turn = gate();
  const { bridge, sent, errors } = await harness(context, async (request, observer, send) => {
    observer?.accepted?.();
    await turn.opened;
    const completed = result(request);
    observer?.completed?.(completed);
    send({ kind: "sessions_changed", generation: 1 });
    return completed;
  });
  const running = bridge.receive({
    sourceRouteId: firstRoute,
    opaqueEnvelope: requestEnvelope(sendRequest("50000000")),
  });
  await waitFor("acceptance", () => sent.length === 1);
  await assert.rejects(
    bridge.receive({
      sourceRouteId: secondRoute,
      opaqueEnvelope: requestEnvelope(sendRequest("60000000"), true),
    }),
    /authentication failed/u,
  );
  turn.open();
  await running;
  await bridge.drain();
  assert.deepEqual(
    sent.map(({ route }) => route),
    [firstRoute, firstRoute, firstRoute],
    "the result and later deliveries still go to the authenticated route",
  );
  assert.equal(errors.length, 1, "the forged frame is reported, not answered");
});

test("live deliveries are batched and never overtake the result they follow", async (context) => {
  const { bridge, sent, emit, prepared, released, errors } = await harness(
    context,
    async (request, observer, send) => {
      for (const generation of [1, 2, 3]) send(changed(generation));
      const completed = result(request);
      observer?.completed?.(completed);
      for (const generation of [4, 5]) send(changed(generation));
      return completed;
    },
    // A long window proves the reply and drain flush the batch, not the timer.
    { deliveryFlushMs: 60_000 },
  );
  await bridge.receive({
    sourceRouteId: firstRoute,
    opaqueEnvelope: requestEnvelope(infoRequest("a0000000")),
  });
  emit(changed(6));
  await bridge.drain();
  assert.deepEqual(
    sent.map(({ message }) =>
      message.type === "daemon_deliveries"
        ? message.messages.map((delivery) =>
            delivery.kind === "sessions_changed" ? delivery.generation : delivery.kind,
          )
        : message.type,
    ),
    [[1, 2, 3], "daemon_result", [4, 5, 6]],
  );
  assert.deepEqual(released, prepared, "every sent envelope left the native outbox");
  assert.deepEqual(errors, []);
});

test("deliveries refused by an unavailable witness are sent in order once it recovers", async (context) => {
  let outage = 0;
  const { bridge, sent, emit, errors } = await harness(
    context,
    async (request, observer) => {
      const completed = result(request);
      observer?.completed?.(completed);
      return completed;
    },
    {
      deliveryFlushMs: 1,
      recovery: { initialDelayMs: 5, maximumDelayMs: 5 },
      witness: {
        async respond() {
          if (outage > 0) {
            outage -= 1;
            throw new DaemonWitnessError("witness_unavailable", "The witness restarted");
          }
          return Uint8Array.of(0xc3);
        },
      },
    },
  );
  await bridge.receive({
    sourceRouteId: firstRoute,
    opaqueEnvelope: requestEnvelope(infoRequest("c0000000")),
  });
  const before = sent.length;
  outage = 1;
  emit(changed(1));
  emit(changed(2));
  await waitFor("the refused batch", () => bridge.witnessStatus?.state === "recovering");
  emit(changed(3));
  const generations = () =>
    sent
      .slice(before)
      .flatMap(({ message }) =>
        message.type === "daemon_deliveries"
          ? message.messages.map((delivery) =>
              delivery.kind === "sessions_changed" ? delivery.generation : -1,
            )
          : message.type === "daemon_delivery" && message.message.kind === "sessions_changed"
            ? [message.message.generation]
            : [],
      );
  await waitFor("the held deliveries", () => generations().length === 3);
  assert.deepEqual(generations(), [1, 2, 3], "nothing lost, nothing reordered");
  assert.equal(bridge.witnessStatus?.state, "ready");
  assert.deepEqual(errors, [], "a witness outage is not reported as lost work");
});

test("a large result is fragmented, released, and replayed whole", async (context) => {
  const text = "z".repeat(150_000);
  const { bridge, sent, prepared, released } = await harness(context, async (request, observer) => {
    const completed = { ...result(request), result: { text } };
    observer?.completed?.(completed);
    return completed;
  });
  const envelope = requestEnvelope(infoRequest("b0000000"));
  await bridge.receive({ sourceRouteId: firstRoute, opaqueEnvelope: envelope });
  assert.equal(sent.length, 4);
  const assembler = new RemoteDaemonMessageAssembler();
  let whole: RemoteDaemonMessage | undefined;
  for (const { message, route } of sent) {
    assert.equal(route, firstRoute);
    assert.equal(message.type, "daemon_fragment");
    if (message.type === "daemon_fragment") whole = assembler.accept(message) ?? whole;
  }
  assert.ok(whole?.type === "daemon_result");
  assert.deepEqual(whole.result, { text });
  assert.deepEqual(released, prepared);
  assert.equal(new Set(prepared).size, 4, "each fragment is sealed under its own operation");

  await bridge.receive({ sourceRouteId: secondRoute, opaqueEnvelope: envelope });
  assert.equal(sent.length, 8);
  assert.deepEqual(
    sent.slice(4).map(({ bytes }) => bytes),
    sent.slice(0, 4).map(({ bytes }) => bytes),
    "a replay re-sends every fragment",
  );
});

test("a superseded grant generation is rejected once without moving the reply route", async (context) => {
  const { bridge, sent, authority, emit, received } = await harness(context, async (request) =>
    result(request),
  );
  await bridge.receive({
    sourceRouteId: firstRoute,
    opaqueEnvelope: requestEnvelope(infoRequest("c0000000")),
  });
  await authority.applyHostedGrant(deviceId, 2, ["observe", "steer"]);
  sent.length = 0;

  const stale = requestEnvelope(infoRequest("c0000001"), false, 1);
  await assert.rejects(
    bridge.receive({ sourceRouteId: secondRoute, opaqueEnvelope: stale }),
    /stale/u,
  );
  await assert.rejects(
    bridge.receive({ sourceRouteId: secondRoute, opaqueEnvelope: stale }),
    /stale/u,
  );
  assert.equal(received.length, 1, "the stale envelope was never decrypted");
  assert.deepEqual(
    sent.map(({ route, message }) => [route, message]),
    [
      [
        secondRoute,
        {
          version: 1,
          type: "daemon_rejected",
          operationId: parseRemoteE2eeEnvelope(stale).operationId,
          code: "stale_grant_generation",
          hostedGrantGeneration: 2,
        },
      ],
    ],
    "rejected once, sealed under the current grant, to the frame's source",
  );
  emit(changed(1));
  await bridge.drain();
  assert.equal(sent.at(-1)?.route, firstRoute, "the unauthenticated frame did not move the route");
});

test("deliveries follow the relay's route for the device after it reconnects", async (context) => {
  const { bridge, sent, emit } = await harness(context, async (request) => result(request));
  await bridge.receive({
    sourceRouteId: firstRoute,
    opaqueEnvelope: requestEnvelope(infoRequest("d0000000")),
  });
  bridge.observeRelayRoutes([
    {
      routeId: parseRouteId("33333333-3333-4333-8333-333333333333"),
      role: "device",
      deviceId: parseDeviceId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
    },
    { routeId: secondRoute, role: "device", deviceId },
  ]);
  emit(changed(1));
  await bridge.drain();
  assert.equal(sent.at(-1)?.route, secondRoute);
  bridge.observeRelayRoutes([]);
  emit(changed(2));
  await bridge.drain();
  assert.equal(sent.at(-1)?.route, secondRoute, "a vanished route keeps the last known one");
});

function replyPort(): ModelPort {
  return {
    stream() {
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield {
          type: "completed",
          stopReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      })();
    },
  };
}

async function startDaemon(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "axl-bridge-dispatch-daemon-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cwd = await realpath(root);
  const dataDirectory = join(root, "data");
  const daemon = new AxlDaemon({
    socketPath: join(root, "daemon.sock"),
    dataDirectory,
    securityMode: "sandboxed",
    sandboxProvider: "fixture",
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry(), system: "test" }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  const authority = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  await authority.registerLocalDevice(deviceId, ["observe", "steer"]);
  await authority.applyHostedGrant(deviceId, 1, ["observe", "steer"]);
  return { daemon, authority, cwd };
}

test("the daemon reports journal acceptance before the remote result", async (context) => {
  const { daemon, authority, cwd } = await startDaemon(context);
  const sessionId = parseSessionId((await daemon.sessions.create(cwd)).sessionId);
  await authority.shareSession(deviceId, sessionId);
  const attachment = daemon.attachAuthenticatedRemoteDevice({ deviceId, authority, send() {} });
  context.after(() => attachment.close());
  const order: string[] = [];
  const response = await attachment.request(
    {
      deviceId,
      requestId: "70000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      method: "session.send",
      params: { sessionId, content: [{ type: "text", text: "hello" }], delivery: "prompt" },
      idempotencyKey: "70000000-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    },
    {
      accepted: () => order.push("accepted"),
      completed: (completed) => order.push(`completed:${completed.method}`),
    },
  );
  order.push("returned");
  assert.equal(response.method, "session.send");
  assert.deepEqual(order, ["accepted", "completed:session.send", "returned"]);
});

test("losing observe ends a remote device's subscriptions", async (context) => {
  const { daemon, authority, cwd } = await startDaemon(context);
  const sessionId = parseSessionId((await daemon.sessions.create(cwd)).sessionId);
  await authority.shareSession(deviceId, sessionId);
  const deliveries: ServerMessage[] = [];
  const attachment = daemon.attachAuthenticatedRemoteDevice({
    deviceId,
    authority,
    send: (message) => deliveries.push(message),
  });
  context.after(() => attachment.close());
  const subscribed = await attachment.request({
    deviceId,
    requestId: "80000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    method: "session.subscribe",
    params: { sessionId },
  });
  const { subscriptionId, snapshot } = subscribed.result as {
    subscriptionId: string;
    snapshot: { boundaryCursor: string };
  };
  await attachment.request({
    deviceId,
    requestId: "80000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    method: "session.ack",
    params: { subscriptionId, cursor: snapshot.boundaryCursor },
  });

  await daemon.sessions.send(sessionId, [{ type: "text", text: "first" }]);
  await waitFor("live events while observe is held", () => deliveries.length > 0);

  await authority.narrowLocalGrant(deviceId, ["steer"]);
  const before = deliveries.length;
  await daemon.sessions.send(sessionId, [{ type: "text", text: "second" }]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(deliveries.length, before, "no event reaches a device that lost observe");
  await assert.rejects(
    attachment.request({
      deviceId,
      requestId: "80000002-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      method: "session.ack",
      params: { subscriptionId, cursor: snapshot.boundaryCursor },
    }),
    (error) => error instanceof RemoteAuthorityError && error.code === "scope_forbidden",
  );
});

const code = (expected: string) => (error: unknown) =>
  (error as { readonly code?: unknown }).code === expected;

test("a remote device reaches only the sessions shared with it", async (context) => {
  const { daemon, authority, cwd } = await startDaemon(context);
  const shared = parseSessionId((await daemon.sessions.create(cwd)).sessionId);
  const other = parseSessionId((await daemon.sessions.create(cwd)).sessionId);
  const unknown = parseSessionId("99999999-9999-4999-8999-999999999999");
  await authority.shareSession(deviceId, shared);
  const attachment = daemon.attachAuthenticatedRemoteDevice({ deviceId, authority, send() {} });
  context.after(() => attachment.close());
  let next = 0;
  const request = (method: string, params: Record<string, unknown>) =>
    attachment.request({
      deviceId,
      requestId: `90000000-aaaa-4aaa-8aaa-${(next++).toString(16).padStart(12, "0")}`,
      method,
      params,
      ...(method === "session.send" || method === "session.interrupt"
        ? { idempotencyKey: `90000000-bbbb-4bbb-8bbb-${next.toString(16).padStart(12, "0")}` }
        : {}),
    });

  // An unshared session and one that does not exist are refused the same way.
  for (const sessionId of [other, unknown]) {
    await assert.rejects(request("session.subscribe", { sessionId }), code("session_not_shared"));
    await assert.rejects(
      request("session.send", {
        sessionId,
        content: [{ type: "text", text: "hello" }],
        delivery: "prompt",
      }),
      code("session_not_shared"),
    );
    await assert.rejects(request("session.interrupt", { sessionId }), code("session_not_shared"));
  }
  await assert.rejects(
    request("session.list", { scope: "all_local", order: "recent", pageSize: 10 }),
    code("remote_method_forbidden"),
  );
  const listed = await request("remote.shares", {});
  const shares = (listed.result as { shares: { sessionId: string }[] }).shares;
  assert.deepEqual(
    shares.map((share) => share.sessionId),
    [shared],
  );
  const subscribed = await request("session.subscribe", { sessionId: shared });
  assert.equal(typeof (subscribed.result as { subscriptionId: unknown }).subscriptionId, "string");
  assert.ok(
    authority
      .auditEntries()
      .some(
        (event) => event.code === "authorization_denied" && event.reason === "session_not_shared",
      ),
  );
});

test("ending a share closes the device's subscriptions and sends the new set", async (context) => {
  const { daemon, authority, cwd } = await startDaemon(context);
  const sessionId = parseSessionId((await daemon.sessions.create(cwd)).sessionId);
  await authority.shareSession(deviceId, sessionId);
  const deliveries: ServerMessage[] = [];
  const attachment = daemon.attachAuthenticatedRemoteDevice({
    deviceId,
    authority,
    send: (message) => deliveries.push(message),
  });
  context.after(() => attachment.close());
  const subscribed = await attachment.request({
    deviceId,
    requestId: "a0000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    method: "session.subscribe",
    params: { sessionId },
  });
  const { subscriptionId, snapshot } = subscribed.result as {
    subscriptionId: string;
    snapshot: { boundaryCursor: string };
  };
  await attachment.request({
    deviceId,
    requestId: "a0000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    method: "session.ack",
    params: { subscriptionId, cursor: snapshot.boundaryCursor },
  });
  await daemon.sessions.send(sessionId, [{ type: "text", text: "first" }]);
  await waitFor("live events while shared", () =>
    deliveries.some((message) => "kind" in message && message.kind === "event"),
  );

  const generation = authority.sharesGeneration;
  assert.equal(await authority.endShare(deviceId, sessionId, "stopped"), true);
  await waitFor("the share notice", () =>
    deliveries.some((message) => "kind" in message && message.kind === "remote_shares"),
  );
  const notice = deliveries.find(
    (message) => "kind" in message && message.kind === "remote_shares",
  );
  assert.ok(notice !== undefined && "kind" in notice && notice.kind === "remote_shares");
  assert.deepEqual(notice.shares, []);
  assert.ok(notice.generation > generation);

  const before = deliveries.length;
  await daemon.sessions.send(sessionId, [{ type: "text", text: "second" }]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(deliveries.length, before, "no event reaches a device after its share ends");
  await assert.rejects(
    attachment.request({
      deviceId,
      requestId: "a0000002-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      method: "session.subscribe",
      params: { sessionId, after: snapshot.boundaryCursor },
    }),
    code("session_not_shared"),
  );
  await assert.rejects(
    attachment.request({
      deviceId,
      requestId: "a0000003-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      method: "session.ack",
      params: { subscriptionId, cursor: snapshot.boundaryCursor },
    }),
    code("unknown_subscription"),
  );
  const ended = authority.auditEntries().find((event) => event.code === "session_unshared");
  assert.equal(ended?.sessionId, sessionId);
  assert.equal(ended?.shareEnd, "stopped");
});

test("deleting a session ends its share", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-bridge-share-delete-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = join(root, "data");
  const authority = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  await authority.registerLocalDevice(deviceId, ["observe", "steer"]);
  await authority.applyHostedGrant(deviceId, 1, ["observe", "steer"]);
  const daemon = new AxlDaemon({
    socketPath: join(root, "daemon.sock"),
    dataDirectory,
    securityMode: "sandboxed",
    sandboxProvider: "fixture",
    remoteAuthority: authority,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry(), system: "test" }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  const sessionId = parseSessionId((await daemon.sessions.create(await realpath(root))).sessionId);
  await authority.shareSession(deviceId, sessionId);
  // Share a session that no longer exists, as if it was deleted while the daemon was stopped.
  const missing = parseSessionId("88888888-8888-4888-8888-888888888888");
  await authority.shareSession(deviceId, missing, Date.now() - 25 * 60 * 60_000);

  await daemon.sessions.delete(sessionId);
  await authority.endSessionShares(sessionId, "deleted");
  assert.deepEqual(
    authority.shares(deviceId).map((share) => share.sessionId),
    [missing],
  );
  await daemon.stop();
});

test("the daemon ends a day-old share of a missing session when it starts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-bridge-share-sweep-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = join(root, "data");
  const authority = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  await authority.registerLocalDevice(deviceId, ["observe", "steer"]);
  await authority.applyHostedGrant(deviceId, 1, ["observe", "steer"]);
  const day = 24 * 60 * 60_000;
  const missing = parseSessionId("88888888-8888-4888-8888-888888888888");
  const recent = parseSessionId("77777777-7777-4777-8777-777777777777");
  await authority.shareSession(deviceId, missing, Date.now() - day - 60_000);
  // A share with recent activity stays, whatever its session's log says.
  await authority.shareSession(deviceId, recent, Date.now() - 60_000);
  const daemon = new AxlDaemon({
    socketPath: join(root, "daemon.sock"),
    dataDirectory,
    securityMode: "sandboxed",
    sandboxProvider: "fixture",
    remoteAuthority: authority,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry(), system: "test" }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  await waitFor("the startup sweep", () =>
    authority.shares(deviceId).every((share) => share.sessionId !== missing),
  );
  assert.deepEqual(
    authority.shares(deviceId).map((share) => share.sessionId),
    [recent],
  );
  const ended = authority.auditEntries().find((event) => event.code === "session_unshared");
  assert.equal(ended?.sessionId, missing);
  assert.equal(ended?.shareEnd, "deleted");
});
