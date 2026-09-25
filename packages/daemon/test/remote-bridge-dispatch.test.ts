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
    async acknowledgeOutbox() {
      throw new Error("not used");
    },
    async acknowledgeReceive(_operation, target) {
      acknowledged.push(Buffer.from(target).toString("hex"));
      return { tag: "released", result: { tag: "accepted", accepted: { acknowledged: true } } };
    },
    close() {},
  };
  return { endpoint, received, acknowledged };
}

type Handler = (
  request: AuthenticatedRemoteRequest,
  observer: AuthenticatedRemoteRequestObserver | undefined,
  send: (message: ServerMessage) => void,
) => Promise<AuthenticatedRemoteRequestResult>;

/** Stands in for the daemon so each test scripts acceptance, completion, and activation. */
function scriptedDaemon(handler: Handler): AxlDaemon {
  return {
    attachAuthenticatedRemoteDevice(
      options: AuthenticatedRemoteAttachmentOptions,
    ): AuthenticatedRemoteAttachment {
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

async function harness(context: TestContext, handler: Handler) {
  const root = await mkdtemp(join(tmpdir(), "axl-bridge-dispatch-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const authority = await RemoteDeviceAuthorityStore.open(join(root, "data"), installationId);
  await authority.registerLocalDevice(deviceId, ["observe", "steer"]);
  await authority.applyHostedGrant(deviceId, 1, ["observe", "steer"]);
  const fake = transparentEndpoint();
  const sent: { route: RouteId; bytes: Uint8Array; message: RemoteDaemonMessage }[] = [];
  const errors: Error[] = [];
  const bridge = new WindowsRemoteE2eeBridge({
    onError: (error) => errors.push(error),
    daemon: scriptedDaemon(handler),
    deviceId,
    authority,
    endpoint: fake.endpoint,
    witness: { respond: async () => Uint8Array.of(0xc3) },
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
  return { bridge, sent, errors, ...fake };
}

let sequence = 0;
function requestEnvelope(request: AuthenticatedRemoteRequest, forged = false): Uint8Array {
  sequence += 1;
  const suffix = sequence.toString(16).padStart(12, "0");
  const plaintext = new TextEncoder().encode(JSON.stringify(request));
  return encodeRemoteE2eeEnvelope({
    operationId: parseOperationId(`eeeeeeee-eeee-4eee-8eee-${suffix}`),
    logicalMessageId: parseOperationId(`ffffffff-ffff-4fff-8fff-${suffix}`),
    messageClass: "application_request",
    hostedGrantGeneration: 1,
    ciphertext: forged ? Uint8Array.of(FORGED, ...plaintext) : plaintext,
  });
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
