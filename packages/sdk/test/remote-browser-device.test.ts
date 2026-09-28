// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  encodeRemoteDaemonMessage,
  encodeRemoteE2eeEnvelope,
  parseCryptoSessionId,
  parseDeviceId,
  parseInstallationId,
  parseOperationId,
  parseRemoteE2eeEnvelope,
  parseRouteId,
  parseTransportAttemptId,
  type RelayDelivery,
  type RemoteDaemonMessage,
} from "@axl/protocol";

import {
  type BrowserDeviceEndpoint,
  pairRemoteBrowserDevice,
  RemoteBrowserSession,
} from "../src/remote-browser-device.ts";
import type { HostedPairingClient } from "../src/remote-pairing.ts";
import {
  encodeRemotePairingLink,
  encodeRemotePairingNotice,
  openRemotePairingLink,
  parseRemotePairingLink,
  parseRemotePairingNotice,
  parseShortRemotePairingFragment,
  REMOTE_PAIRING_NOTICE_BYTES,
  type RemotePairingLink,
  sealRemotePairingLink,
} from "../src/remote-pairing-link.ts";
import type { RemoteRelayConnection, RemoteRelayConnectionState } from "../src/remote-relay.ts";
import { HttpRelayTicketProvider } from "../src/remote-relay.ts";
import { HostedWitnessClient } from "../src/witness.ts";

const link: RemotePairingLink = {
  invitation: Uint8Array.of(9, 8, 7, 6, 250, 251),
  accountId: "0f0e0d0c-0b0a-4908-8706-050403020100",
  installationId: parseInstallationId("01890a5d-ac96-774b-bcce-b302099a8057"),
  deviceId: parseDeviceId("01890a5d-ac96-774b-bcce-b302099a8058"),
  cryptoSessionId: parseCryptoSessionId("01890a5d-ac96-774b-bcce-b302099a8059"),
  accessToken: "test-token_with.symbols+/=",
  enrollmentSecret: Uint8Array.from({ length: 32 }, (_, index) => index),
};
const daemonRoute = parseRouteId("01890a5d-ac96-774b-bcce-b302099a8065");

test("pairing links round-trip through the fragment and never carry trust", () => {
  const encoded = encodeRemotePairingLink("https://stack.example/remote/", link);
  const url = new URL(encoded);
  assert.equal(url.origin + url.pathname, "https://stack.example/remote/");
  assert.equal(url.search, "");
  const parsed = parseRemotePairingLink(url.hash);
  assert.deepEqual(parsed, link);
  assert.equal(new URLSearchParams(url.hash.slice(1)).has("trust"), false);
  // Identities travel as 22-character base64url so the link fits a terminal QR code.
  assert.equal(new URLSearchParams(url.hash.slice(1)).get("d")?.length, 22);
  assert.equal(url.hash.includes(link.deviceId), false);
  assert.throws(() => parseRemotePairingLink(url.hash.replace(/&d=[^&]+/u, "&d=AAAA")), /device/u);
  assert.throws(() => encodeRemotePairingLink("http://stack.example/remote/", link), /HTTPS/u);
  // A version 1 link carried a shared relay proof; it must not be accepted as a device link.
  assert.throws(() => parseRemotePairingLink(url.hash.replace("v=2", "v=1")), /version/u);
  assert.throws(
    () => parseRemotePairingLink(url.hash.replace(/&e=[^&]+/u, "&e=AAAA")),
    /enrollment secret/u,
  );
});

test("short pairing links seal the full link under a key only the short link carries", async () => {
  const full = encodeRemotePairingLink("https://stack.example/remote/", link);
  const sealed = await sealRemotePairingLink(full);
  const url = new URL(sealed.shortLink);
  assert.equal(url.origin + url.pathname, "https://stack.example/remote/");
  assert.equal(url.search, "");
  assert.ok(sealed.shortLink.length < 120, `short link is ${sealed.shortLink.length} characters`);
  const short = parseShortRemotePairingFragment(url.hash);
  assert.ok(short !== undefined);
  assert.deepEqual(short.linkId, sealed.linkId);
  // The ciphertext alone reveals nothing of the invitation or the credentials.
  const text = Buffer.from(sealed.sealed).toString("latin1");
  assert.equal(text.includes(link.accessToken), false);
  assert.equal(sealed.shortLink.includes(link.accessToken), false);

  const fragment = await openRemotePairingLink(sealed.sealed, short.linkId, short.key);
  assert.equal(fragment, new URL(full).hash.slice(1));
  assert.deepEqual(parseRemotePairingLink(fragment), link);

  // A different ID, a different key, or a changed byte does not open it.
  const otherId = short.linkId.slice();
  otherId[0] = (otherId[0] ?? 0) ^ 1;
  await assert.rejects(openRemotePairingLink(sealed.sealed, otherId, short.key), /does not open/u);
  const otherKey = short.key.slice();
  otherKey[0] = (otherKey[0] ?? 0) ^ 1;
  await assert.rejects(
    openRemotePairingLink(sealed.sealed, short.linkId, otherKey),
    /does not open/u,
  );
  const tampered = sealed.sealed.slice();
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
  await assert.rejects(openRemotePairingLink(tampered, short.linkId, short.key), /does not open/u);

  // Two seals of one link never share an ID or ciphertext.
  const again = await sealRemotePairingLink(full);
  assert.notDeepEqual(again.linkId, sealed.linkId);
  assert.notDeepEqual(again.sealed, sealed.sealed);
});

test("only a well-formed short fragment parses as one", () => {
  assert.equal(parseShortRemotePairingFragment("v=2&i=AAAA"), undefined);
  assert.equal(parseShortRemotePairingFragment(""), undefined);
  const id = "A".repeat(22);
  const key = "B".repeat(43);
  assert.ok(parseShortRemotePairingFragment(`#p=${id}.${key}`) !== undefined);
  assert.throws(() => parseShortRemotePairingFragment(`p=${id}`), /short link key/u);
  assert.throws(() => parseShortRemotePairingFragment(`p=${id}.${key}.C`), /malformed/u);
  assert.throws(() => parseShortRemotePairingFragment(`p=${id.slice(1)}.${key}`), /short link ID/u);
  assert.throws(() => parseShortRemotePairingFragment(`p=${id}.${key}A`), /short link key/u);
});

test("pairing notices carry exactly one 48-byte claim hash", () => {
  const hash = new Uint8Array(48).fill(7);
  const notice = encodeRemotePairingNotice(hash);
  assert.equal(notice.byteLength, REMOTE_PAIRING_NOTICE_BYTES);
  assert.deepEqual(parseRemotePairingNotice(notice), hash);
  assert.equal(parseRemotePairingNotice(notice.slice(1)), undefined);
  const envelope = encodeRemoteE2eeEnvelope({
    operationId: parseOperationId("01890a5d-ac96-774b-bcce-b302099a8060"),
    logicalMessageId: parseOperationId("01890a5d-ac96-774b-bcce-b302099a8061"),
    messageClass: "application_request",
    hostedGrantGeneration: 1,
    ciphertext: Uint8Array.of(1),
  });
  assert.equal(parseRemotePairingNotice(envelope), undefined);
  assert.throws(() => encodeRemotePairingNotice(new Uint8Array(32)), /48-byte/u);
});

/** An endpoint whose "ciphertext" is its plaintext, so the adapter's framing is observable. */
function transparentEndpoint(calls: string[]): BrowserDeviceEndpoint {
  return {
    pairingClaim: async (invitation) => {
      calls.push("claim");
      return Uint8Array.from(invitation, (byte) => byte ^ 0xff);
    },
    joinPublished: async (_operation, welcome) => {
      calls.push(`join:${Buffer.from(welcome).toString("hex")}`);
      return { tag: "joined", epoch: 1n };
    },
    preparePairActivation: async (_operation, logical) => {
      calls.push("activation");
      return { tag: "envelope", bytes: Uint8Array.of(0xac), logicalMessageId: logical.slice() };
    },
    prepareApplication: async (_operation, logical, _generation, plaintext) => ({
      tag: "envelope",
      bytes: plaintext.slice(),
      logicalMessageId: logical.slice(),
    }),
    receiveApplication: async (_operation, logical, _generation, ciphertext) => ({
      tag: "plaintext",
      bytes: ciphertext.slice(),
      logicalMessageId: logical.slice(),
    }),
    close: async () => undefined,
  };
}

interface FakeRelay {
  readonly connection: RemoteRelayConnection;
  readonly sent: Uint8Array[];
  deliver(payload: Uint8Array): void;
  /** Move the connection through a state; sends fail while it is not connected. */
  setState(state: RemoteRelayConnectionState): void;
}

function fakeRelay(): FakeRelay {
  const sent: Uint8Array[] = [];
  const listeners = new Set<(delivery: RelayDelivery) => void>();
  const stateListeners = new Set<(state: RemoteRelayConnectionState) => void>();
  let state: RemoteRelayConnectionState = "connected";
  const connection = {
    get state() {
      return state;
    },
    routes: [{ routeId: daemonRoute, role: "daemon" }],
    resolve: async (session: string) => {
      assert.equal(session, link.cryptoSessionId);
      return daemonRoute;
    },
    send: (route: string, _attempt: unknown, payload: Uint8Array) => {
      assert.equal(route, daemonRoute);
      if (state !== "connected") throw new Error("Relay connection is not connected");
      sent.push(payload.slice());
    },
    onDelivery: (listener: (delivery: RelayDelivery) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onState: (listener: (state: RemoteRelayConnectionState) => void) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onRoutes: () => () => undefined,
    onFailure: () => () => undefined,
    onReceipt: () => () => undefined,
  } as unknown as RemoteRelayConnection;
  return {
    connection,
    sent,
    setState: (next) => {
      state = next;
      for (const listener of stateListeners) listener(next);
    },
    deliver: (payload) => {
      for (const listener of listeners) {
        listener({
          transportVersion: 1,
          attemptId: parseTransportAttemptId("01890a5d-ac96-774b-bcce-b302099a8062"),
          sourceRouteId: daemonRoute,
          opaquePayload: payload,
        } as RelayDelivery);
      }
    },
  };
}

test("browser pairing publishes the claim, notices the daemon, joins, and activates", async () => {
  const calls: string[] = [];
  const relay = fakeRelay();
  const welcome = Uint8Array.of(0xde, 0xad);
  const welcomeHash = new Uint8Array(createHash("sha384").update(welcome).digest());
  const published: unknown[] = [];
  let fetches = 0;
  const pairing = {
    publishClaim: async (request: unknown) => {
      published.push(request);
    },
    fetchWelcome: async () => {
      fetches += 1;
      if (fetches === 1) throw Object.assign(new Error("not yet"), { code: "not_found" });
      return { version: 1, welcome, welcomeHash, expiresAt: Date.now() + 60_000 };
    },
    acknowledgeWelcome: async (request: { readonly welcomeHash: Uint8Array }) => {
      calls.push(`ack:${Buffer.from(request.welcomeHash).equals(Buffer.from(welcomeHash))}`);
    },
  } as unknown as HostedPairingClient;
  const steps: string[] = [];
  await pairRemoteBrowserDevice({
    link,
    endpoint: transparentEndpoint(calls),
    pairing,
    relay: relay.connection,
    onStep: (step) => steps.push(step),
    sleep: async () => undefined,
  });

  const claim = Uint8Array.from(link.invitation, (byte) => byte ^ 0xff);
  const claimHash = new Uint8Array(createHash("sha384").update(claim).digest());
  assert.deepEqual(published, [
    {
      version: 1,
      installationId: link.installationId,
      deviceId: link.deviceId,
      cryptoSessionId: link.cryptoSessionId,
      claim,
      claimHash,
    },
  ]);
  assert.deepEqual(parseRemotePairingNotice(relay.sent[0] ?? new Uint8Array()), claimHash);
  const activation = parseRemoteE2eeEnvelope(relay.sent.at(-1) ?? new Uint8Array());
  assert.equal(activation.messageClass, "pair_activation");
  assert.deepEqual(activation.ciphertext, Uint8Array.of(0xac));
  assert.deepEqual(calls, ["claim", "join:dead", "activation", "ack:true"]);
  assert.deepEqual(steps.at(-1), "paired");
});

test("browser sessions seal requests and settle them from daemon replies", async () => {
  const relay = fakeRelay();
  const session = new RemoteBrowserSession({
    endpoint: transparentEndpoint([]),
    relay: relay.connection,
    deviceId: link.deviceId,
    cryptoSessionId: link.cryptoSessionId,
  });
  const reply = (message: RemoteDaemonMessage) =>
    relay.deliver(
      encodeRemoteE2eeEnvelope({
        operationId: parseOperationId("01890a5d-ac96-774b-bcce-b302099a8063"),
        logicalMessageId: parseOperationId("01890a5d-ac96-774b-bcce-b302099a8064"),
        messageClass: "application_delivery",
        hostedGrantGeneration: 1,
        ciphertext: encodeRemoteDaemonMessage(message),
      }),
    );
  const requestOf = async (index: number) => {
    while (relay.sent.length <= index) await new Promise((resolve) => setImmediate(resolve));
    const envelope = parseRemoteE2eeEnvelope(relay.sent[index] ?? new Uint8Array());
    assert.equal(envelope.messageClass, "application_request");
    return JSON.parse(Buffer.from(envelope.ciphertext).toString("utf8")) as {
      readonly requestId: string;
      readonly idempotencyKey?: string;
      readonly method: string;
      readonly deviceId: string;
    };
  };

  const listed = session.request("session.list", { scope: "all_local" });
  const listRequest = await requestOf(0);
  assert.equal(listRequest.method, "session.list");
  assert.equal(listRequest.deviceId, link.deviceId);
  assert.equal(listRequest.idempotencyKey, undefined);
  reply({
    version: 1,
    type: "daemon_result",
    requestId: listRequest.requestId as never,
    method: "session.list",
    result: { sessions: [] },
  });
  assert.deepEqual(await listed, { sessions: [] });

  const sent = session.request("session.send", { sessionId: "s" });
  const sendRequest = await requestOf(1);
  assert.equal(typeof sendRequest.idempotencyKey, "string");
  reply({
    version: 1,
    type: "daemon_error",
    requestId: sendRequest.requestId as never,
    code: "busy",
    message: "Session is busy",
    retryable: true,
  });
  await assert.rejects(sent, { code: "busy", retryable: true });

  // Steering is not a retryable mutation, so the daemon would reject an idempotency key on it.
  const steered = session.request("session.steer", { sessionId: "s" });
  assert.equal((await requestOf(2)).idempotencyKey, undefined);
  session.close();
  await assert.rejects(steered, { code: "closed" });
});

async function sentRequest(relay: FakeRelay, index: number) {
  while (relay.sent.length <= index) await new Promise((resolve) => setImmediate(resolve));
  const envelope = parseRemoteE2eeEnvelope(relay.sent[index] ?? new Uint8Array());
  return JSON.parse(Buffer.from(envelope.ciphertext).toString("utf8")) as {
    readonly requestId: string;
  };
}

function resultEnvelope(requestId: string, operation = "01890a5d-ac96-774b-bcce-b302099a8066") {
  return encodeRemoteE2eeEnvelope({
    operationId: parseOperationId(operation),
    logicalMessageId: parseOperationId("01890a5d-ac96-774b-bcce-b302099a8067"),
    messageClass: "application_delivery",
    hostedGrantGeneration: 1,
    ciphertext: encodeRemoteDaemonMessage({
      version: 1,
      type: "daemon_result",
      requestId: requestId as never,
      method: "session.list",
      result: { sessions: [] },
    }),
  });
}

test("unanswered requests are resent byte for byte after the relay reconnects", async () => {
  const relay = fakeRelay();
  const session = new RemoteBrowserSession({
    endpoint: transparentEndpoint([]),
    relay: relay.connection,
    deviceId: link.deviceId,
    cryptoSessionId: link.cryptoSessionId,
  });
  let reconnects = 0;
  session.onReconnect(() => {
    reconnects += 1;
  });
  const listed = session.request("session.list", { scope: "all_local" });
  const { requestId } = await sentRequest(relay, 0);
  assert.equal(session.unanswered, 1);

  relay.setState("reconnecting");
  relay.setState("connected");
  await sentRequest(relay, 1);
  assert.deepEqual(relay.sent[1], relay.sent[0], "the daemon recognizes the exact bytes");
  assert.equal(reconnects, 1);

  relay.deliver(resultEnvelope(requestId));
  assert.deepEqual(await listed, { sessions: [] });
  assert.equal(session.unanswered, 0);
  relay.setState("reconnecting");
  relay.setState("connected");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(relay.sent.length, 2, "answered requests are never resent");
  session.close();
});

test("requests sealed while the relay is away leave once it connects", async () => {
  const relay = fakeRelay();
  relay.setState("reconnecting");
  const session = new RemoteBrowserSession({
    endpoint: transparentEndpoint([]),
    relay: relay.connection,
    deviceId: link.deviceId,
    cryptoSessionId: link.cryptoSessionId,
  });
  const listed = session.request("session.list", { scope: "all_local" });
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(relay.sent.length, 0);
  relay.setState("connected");
  const { requestId } = await sentRequest(relay, 0);
  relay.deliver(resultEnvelope(requestId));
  assert.deepEqual(await listed, { sessions: [] });
  session.close();
});

test("replies the daemon replays for a resent request are ignored quietly", async () => {
  const relay = fakeRelay();
  const endpoint = transparentEndpoint([]);
  const seen = new Set<string>();
  const session = new RemoteBrowserSession({
    endpoint: {
      ...endpoint,
      receiveApplication: async (operation, logical, generation, ciphertext) => {
        const key = Buffer.from(operation).toString("hex");
        if (seen.has(key)) throw Object.assign(new Error("replayed"), { code: "replay_rejected" });
        seen.add(key);
        return endpoint.receiveApplication(operation, logical, generation, ciphertext);
      },
    },
    relay: relay.connection,
    deviceId: link.deviceId,
    cryptoSessionId: link.cryptoSessionId,
  });
  const errors: Error[] = [];
  session.onError((error) => errors.push(error));
  const listed = session.request("session.list", { scope: "all_local" });
  const { requestId } = await sentRequest(relay, 0);
  relay.deliver(resultEnvelope(requestId));
  relay.deliver(resultEnvelope(requestId));
  assert.deepEqual(await listed, { sessions: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, []);
  session.close();
});

test("an operation whose witness round trip failed is repeated with the same identity", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const relay = fakeRelay();
  const endpoint = transparentEndpoint([]);
  const operations: string[] = [];
  const session = new RemoteBrowserSession({
    endpoint: {
      ...endpoint,
      receiveApplication: async (operation, logical, generation, ciphertext) => {
        operations.push(Buffer.from(operation).toString("hex"));
        if (operations.length < 3) {
          throw Object.assign(new Error("witness down"), { code: "witness_unavailable" });
        }
        return endpoint.receiveApplication(operation, logical, generation, ciphertext);
      },
    },
    relay: relay.connection,
    deviceId: link.deviceId,
    cryptoSessionId: link.cryptoSessionId,
  });
  const listed = session.request("session.list", { scope: "all_local" });
  const { requestId } = await sentRequest(relay, 0);
  relay.deliver(resultEnvelope(requestId));
  for (let tick = 0; tick < 20 && operations.length < 3; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    context.mock.timers.tick(8_000);
  }
  assert.deepEqual(await listed, { sessions: [] });
  assert.equal(operations.length, 3);
  assert.equal(new Set(operations).size, 1, "every repeat completes the same operation");
  session.close();
});

test("browser pairing resends the activation until the daemon answers", async () => {
  const relay = fakeRelay();
  const welcome = Uint8Array.of(0xbe, 0xef);
  const pairing = {
    publishClaim: async () => undefined,
    fetchWelcome: async () => ({
      version: 1,
      welcome,
      welcomeHash: new Uint8Array(createHash("sha384").update(welcome).digest()),
      expiresAt: Date.now() + 60_000,
    }),
    acknowledgeWelcome: async () => undefined,
  } as unknown as HostedPairingClient;
  let confirmations = 0;
  await pairRemoteBrowserDevice({
    link,
    endpoint: transparentEndpoint([]),
    pairing,
    relay: relay.connection,
    confirm: async () => {
      confirmations += 1;
      if (confirmations < 3) throw new Error("no answer yet");
    },
    sleep: async () => undefined,
  });
  const activations = relay.sent.filter((bytes) => {
    try {
      return parseRemoteE2eeEnvelope(bytes).messageClass === "pair_activation";
    } catch {
      return false;
    }
  });
  assert.equal(confirmations, 3);
  assert.equal(activations.length, 3);
  assert.deepEqual(activations[2], activations[0]);
});

test("hosted clients call the global fetch unbound, as browsers require", async (context) => {
  const original = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = original;
  });
  const receivers: unknown[] = [];
  globalThis.fetch = function (this: unknown) {
    receivers.push(this);
    return Promise.resolve(new Response("{}", { status: 503 }));
  } as typeof fetch;
  const tickets = new HttpRelayTicketProvider({
    controlPlaneOrigin: "https://stack.example",
    request: { installationId: link.installationId, role: "device", deviceId: link.deviceId },
    authenticationHeaders: async () => ({}),
    proof: { create: async () => ({ connectionNonce: "n", possessionProof: Uint8Array.of(1) }) },
  });
  await assert.rejects(tickets.acquire());
  const witness = new HostedWitnessClient({
    controlPlaneOrigin: "https://stack.example",
    authenticationHeaders: async () => ({}),
  });
  await assert.rejects(witness.respond(Uint8Array.of(1)));
  assert.deepEqual(receivers, [undefined, undefined]);
});
