// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RELAY_LIMITS,
  REMOTE_TRANSPORT_VERSION,
  encodeRelayBinaryFrame,
  encodeRemoteDaemonMessage,
  parseCryptoSessionId,
  parseDeviceId,
  parseIdempotencyKey,
  parseInstallationId,
  parseRelayBinaryFrame,
  parseRemoteRequestId,
  parseRouteId,
  parseTransportAttemptId,
  type OpaqueOutboxRecord,
  type RequestId,
} from "@axl/protocol";

import {
  OpaqueOutbox,
  type OpaqueOutboxStore,
  type OpaqueOutboxTransaction,
} from "../src/remote-outbox.ts";
import {
  HttpRelayTicketProvider,
  RemoteHostedDelivery,
  RemoteRelayConnection,
  RemoteRelayError,
  type RelayAdmissionCredential,
  type RemoteRelayConnectionState,
  type RemoteWebSocket,
  type RemoteWebSocketEvent,
  type RemoteWebSocketFactory,
} from "../src/remote-relay.ts";

class MemoryOutboxStore implements OpaqueOutboxStore {
  readonly records = new Map<RequestId, OpaqueOutboxRecord>();

  async transact<Result>(
    requestId: RequestId,
    operation: (current: OpaqueOutboxRecord | undefined) => OpaqueOutboxTransaction<Result>,
  ): Promise<Result> {
    const transaction = operation(this.records.get(requestId));
    if (transaction.record === undefined) this.records.delete(requestId);
    else this.records.set(requestId, transaction.record);
    return transaction.result;
  }

  async list(): Promise<readonly OpaqueOutboxRecord[]> {
    return [...this.records.values()];
  }
}

type Listener = (event: RemoteWebSocketEvent) => void;

class FakeSocket implements RemoteWebSocket {
  binaryType = "";
  readyState = 0;
  readonly sent: Uint8Array[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  send(data: Uint8Array): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(data.slice());
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit({ type: "close", code, reason });
  }

  addEventListener(type: RemoteWebSocketEvent["type"], listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: RemoteWebSocketEvent["type"], listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit({ type: "open" });
  }

  message(data: unknown): void {
    this.emit({ type: "message", data });
  }

  fail(): void {
    this.emit({ type: "error" });
  }

  private emit(event: RemoteWebSocketEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }
}

class FakeSocketFactory implements RemoteWebSocketFactory {
  readonly sockets: FakeSocket[] = [];

  connect(): RemoteWebSocket {
    const socket = new FakeSocket();
    this.sockets.push(socket);
    return socket;
  }
}

const installationId = parseInstallationId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const cryptoSessionId = parseCryptoSessionId("11111111-1111-4111-8111-111111111111");
const deviceRoute = parseRouteId("22222222-2222-4222-8222-222222222222");
const firstDaemonRoute = parseRouteId("33333333-3333-4333-8333-333333333333");
const secondDaemonRoute = parseRouteId("44444444-4444-4444-8444-444444444444");
const requestId = parseRemoteRequestId("55555555-5555-4555-8555-555555555555");
const idempotencyKey = parseIdempotencyKey("66666666-6666-4666-8666-666666666666");
const daemonId = parseDeviceId("77777777-7777-4777-8777-777777777777");

function credential(maxFrameBytes = DEFAULT_RELAY_LIMITS.maxFrameBytes): RelayAdmissionCredential {
  return {
    ticket: "one-use-ticket",
    relayUrl: "wss://relay.invalid/v1/connect",
    expiresAt: Date.now() + 60_000,
    proofSchemeVersion: 1,
    limits: { ...DEFAULT_RELAY_LIMITS, maxFrameBytes },
    connectionNonce: "nonce",
    possessionProof: Uint8Array.of(1, 2, 3),
  };
}

function discovery(
  type: "route_snapshot" | "route_available" | "route_unavailable",
  route: string,
) {
  return new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      type,
      ...(type === "route_snapshot"
        ? { sourceRoute: { routeId: deviceRoute, role: "device", deviceId: daemonId } }
        : {}),
      peers: [{ routeId: route, role: "daemon" }],
    }),
  );
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function connect(
  factory: FakeSocketFactory,
  issuedCredential = credential(),
): Promise<{ readonly connection: RemoteRelayConnection; readonly socket: FakeSocket }> {
  const connection = new RemoteRelayConnection({
    tickets: {
      async acquire() {
        return issuedCredential;
      },
    },
    sockets: factory,
    destinationCryptoSessionId: cryptoSessionId,
    reconnect: { initialDelayMs: 1, maximumDelayMs: 1, jitterRatio: 0, maximumAttempts: 3 },
    routeWaitMs: 100,
    sleep: async () => undefined,
  });
  const starting = connection.start();
  await nextTurn();
  const socket = factory.sockets[0];
  assert.ok(socket);
  socket.open();
  socket.message(discovery("route_snapshot", firstDaemonRoute));
  await starting;
  return { connection, socket };
}

test("acquires tickets in an authenticated body request and rejects insecure production origins", async () => {
  assert.throws(
    () =>
      new HttpRelayTicketProvider({
        controlPlaneOrigin: "http://control.invalid",
        request: {
          installationId,
          deviceId: daemonId,
          role: "device",
        },
        authenticationHeaders: async () => ({}),
        proof: {
          async create() {
            return { connectionNonce: "nonce", possessionProof: Uint8Array.of(1) };
          },
        },
      }),
    /must use HTTPS/,
  );

  let requestedUrl = "";
  const provider = new HttpRelayTicketProvider({
    controlPlaneOrigin: "http://127.0.0.1:1234",
    request: {
      installationId,
      deviceId: daemonId,
      role: "device",
    },
    authenticationHeaders: async () => ({ authorization: "Bearer fixture" }),
    proof: {
      async create() {
        return { connectionNonce: "nonce", possessionProof: Uint8Array.of(1, 2, 3) };
      },
    },
    allowInsecureLoopbackForTests: true,
    fetch: async (url, init) => {
      requestedUrl = url;
      assert.equal(init.headers.authorization, "Bearer fixture");
      assert.doesNotMatch(url, /one-use-ticket/);
      return {
        ok: true,
        status: 201,
        async json() {
          const { connectionNonce: _nonce, possessionProof: _proof, ...issued } = credential();
          return issued;
        },
      };
    },
  });
  const acquired = await provider.acquire();
  assert.equal(requestedUrl, "http://127.0.0.1:1234/v1/relay/tickets");
  assert.equal(acquired.ticket, "one-use-ticket");
  assert.deepEqual(acquired.possessionProof, Uint8Array.of(1, 2, 3));
});

test("admits with a bounded first binary message and tracks route replacement", async () => {
  const factory = new FakeSocketFactory();
  const { connection, socket } = await connect(factory);

  assert.equal(socket.binaryType, "arraybuffer");
  const admission = JSON.parse(new TextDecoder().decode(socket.sent[0])) as Record<string, unknown>;
  assert.equal(admission.ticket, "one-use-ticket");
  assert.equal(admission.connectionNonce, "nonce");
  assert.equal(await connection.resolve(cryptoSessionId), firstDaemonRoute);

  socket.message(discovery("route_available", secondDaemonRoute));
  await nextTurn();
  assert.equal(await connection.resolve(cryptoSessionId), secondDaemonRoute);
  socket.message(discovery("route_unavailable", secondDaemonRoute));
  await nextTurn();
  await assert.rejects(connection.resolve(cryptoSessionId), /Daemon route is unavailable/);
  connection.close();
});

test("failed delivery startup can retry and concurrent starts share one connection attempt", async () => {
  const factory = new FakeSocketFactory();
  let acquisitions = 0;
  const connection = new RemoteRelayConnection({
    tickets: {
      async acquire() {
        acquisitions += 1;
        if (acquisitions === 1) throw new Error("control plane unavailable");
        return credential();
      },
    },
    sockets: factory,
    destinationCryptoSessionId: cryptoSessionId,
    reconnect: { initialDelayMs: 1, maximumDelayMs: 1, jitterRatio: 0, maximumAttempts: 1 },
    routeWaitMs: 100,
    sleep: async () => undefined,
  });
  const store = new MemoryOutboxStore();
  const attemptIds = {
    create: () => parseTransportAttemptId("88888888-8888-4888-8888-000000000001"),
  };
  const delivery = new RemoteHostedDelivery({
    connection,
    outbox: new OpaqueOutbox(store, attemptIds, connection),
    expectedDaemonId: daemonId,
    attemptIds,
    opener: {
      async open(ciphertext) {
        return { authenticatedPeerId: daemonId, plaintext: ciphertext };
      },
    },
  });

  await assert.rejects(delivery.start(), /attempts were exhausted/);
  assert.equal(connection.state, "disconnected");
  assert.equal(acquisitions, 1);

  const firstRetry = delivery.start();
  const concurrentRetry = delivery.start();
  assert.equal(firstRetry, concurrentRetry);
  await nextTurn();
  const socket = factory.sockets[0];
  assert.ok(socket);
  socket.open();
  socket.message(discovery("route_snapshot", firstDaemonRoute));
  await Promise.all([firstRetry, concurrentRetry]);

  assert.equal(acquisitions, 2);
  assert.equal(connection.state, "connected");
  delivery.close();
});

test("failed WebSocket startup can retry with a new ticket and socket", async () => {
  const factory = new FakeSocketFactory();
  let acquisitions = 0;
  const connection = new RemoteRelayConnection({
    tickets: {
      async acquire() {
        acquisitions += 1;
        return credential();
      },
    },
    sockets: factory,
    destinationCryptoSessionId: cryptoSessionId,
    reconnect: { initialDelayMs: 1, maximumDelayMs: 1, jitterRatio: 0, maximumAttempts: 1 },
    routeWaitMs: 100,
    sleep: async () => undefined,
  });

  const failedStart = connection.start();
  const concurrentFailedStart = connection.start();
  assert.equal(failedStart, concurrentFailedStart);
  await nextTurn();
  const failedSocket = factory.sockets[0];
  assert.ok(failedSocket);
  failedSocket.fail();
  await assert.rejects(failedStart, /attempts were exhausted/);

  const retry = connection.start();
  const concurrentRetry = connection.start();
  assert.equal(retry, concurrentRetry);
  await nextTurn();
  const retrySocket = factory.sockets[1];
  assert.ok(retrySocket);
  retrySocket.open();
  retrySocket.message(discovery("route_snapshot", firstDaemonRoute));
  await retry;

  assert.equal(acquisitions, 2);
  assert.equal(connection.state, "connected");
  connection.close();
});

test("enforces the negotiated frame limit before conversion and outbound send", async () => {
  const maximumBytes = 512;
  const factory = new FakeSocketFactory();
  const { connection, socket } = await connect(factory, credential(maximumBytes));
  const oversizedPayload = new Uint8Array(maximumBytes - 37);

  assert.throws(
    () =>
      connection.send(
        firstDaemonRoute,
        parseTransportAttemptId("88888888-8888-4888-8888-000000000001"),
        oversizedPayload,
      ),
    (error) => error instanceof RemoteRelayError && error.code === "frame_too_large",
  );

  let converted = false;
  const oversizedBlob = new Blob([new Uint8Array(maximumBytes + 1)]);
  Object.defineProperty(oversizedBlob, "arrayBuffer", {
    value: async () => {
      converted = true;
      return new ArrayBuffer(maximumBytes + 1);
    },
  });
  socket.message(oversizedBlob);
  await nextTurn();

  assert.equal(converted, false);
  assert.equal(socket.readyState, 3);
  connection.close();
});

test("rejects oversized discovery text before JSON parsing", async () => {
  const maximumBytes = 512;
  const factory = new FakeSocketFactory();
  const { connection, socket } = await connect(factory, credential(maximumBytes));

  socket.message("{".repeat(maximumBytes + 1));
  await nextTurn();

  assert.equal(socket.readyState, 3);
  connection.close();
});

test("startup retries a durable sending record with byte-identical ciphertext", async () => {
  const factory = new FakeSocketFactory();
  const { connection, socket } = await connect(factory);
  const store = new MemoryOutboxStore();
  const opaqueEnvelope = Uint8Array.of(0, 1, 2, 255);
  store.records.set(requestId, {
    requestId,
    idempotencyKey,
    destinationCryptoSessionId: cryptoSessionId,
    opaqueEnvelope,
    createdAt: 1_900_000_000_000,
    state: "sending",
  });
  let attempt = 0;
  const attemptIds = {
    create() {
      attempt += 1;
      return parseTransportAttemptId(
        `88888888-8888-4888-8888-${attempt.toString().padStart(12, "0")}`,
      );
    },
  };
  const outbox = new OpaqueOutbox(store, attemptIds, connection);
  const delivery = new RemoteHostedDelivery({
    connection,
    outbox,
    expectedDaemonId: daemonId,
    attemptIds,
    opener: {
      async open(ciphertext) {
        return { authenticatedPeerId: daemonId, plaintext: ciphertext };
      },
    },
  });

  await delivery.start();

  const retried = parseRelayBinaryFrame(socket.sent.at(-1) ?? new Uint8Array());
  assert.ok("destinationRouteId" in retried);
  assert.equal(retried.destinationRouteId, firstDaemonRoute);
  assert.deepEqual(retried.opaquePayload, opaqueEnvelope);
  assert.equal((await outbox.list())[0]?.state, "sending");
  delivery.close();
});

test("reconnect resolves a new route and retries byte-identical prepared ciphertext", async () => {
  const factory = new FakeSocketFactory();
  const { connection, socket: firstSocket } = await connect(factory);
  const store = new MemoryOutboxStore();
  let attempt = 0;
  const attemptIds = {
    create() {
      attempt += 1;
      return parseTransportAttemptId(
        `88888888-8888-4888-8888-${attempt.toString().padStart(12, "0")}`,
      );
    },
  };
  const outbox = new OpaqueOutbox(store, attemptIds, connection);
  const states: RemoteRelayConnectionState[] = [];
  connection.onState((state) => states.push(state));
  const updates: string[] = [];
  const delivery = new RemoteHostedDelivery({
    connection,
    outbox,
    expectedDaemonId: daemonId,
    attemptIds,
    opener: {
      async open(opaqueEnvelope) {
        return { authenticatedPeerId: daemonId, plaintext: opaqueEnvelope };
      },
    },
  });
  delivery.onDeliveryState((update) => updates.push(update.state));
  await delivery.start();

  const opaqueEnvelope = Uint8Array.of(0, 1, 2, 255);
  await delivery.enqueuePrepared({
    requestId,
    idempotencyKey,
    destinationCryptoSessionId: cryptoSessionId,
    opaqueEnvelope,
    createdAt: 1_900_000_000_000,
    state: "queued_local",
  });
  const firstSend = parseRelayBinaryFrame(firstSocket.sent.at(-1) ?? new Uint8Array());
  assert.ok("destinationRouteId" in firstSend);
  assert.equal(firstSend.destinationRouteId, firstDaemonRoute);
  assert.deepEqual(firstSend.opaquePayload, opaqueEnvelope);

  firstSocket.close(1006, "restart");
  await nextTurn();
  await nextTurn();
  const secondSocket = factory.sockets[1];
  assert.ok(secondSocket);
  secondSocket.open();
  secondSocket.message(discovery("route_snapshot", secondDaemonRoute));
  await nextTurn();
  await nextTurn();

  const secondSend = parseRelayBinaryFrame(secondSocket.sent.at(-1) ?? new Uint8Array());
  assert.ok("destinationRouteId" in secondSend);
  assert.equal(secondSend.destinationRouteId, secondDaemonRoute);
  assert.notEqual(secondSend.attemptId, firstSend.attemptId);
  assert.deepEqual(secondSend.opaquePayload, firstSend.opaquePayload);

  secondSocket.message(
    encodeRelayBinaryFrame({
      transportVersion: REMOTE_TRANSPORT_VERSION,
      attemptId: secondSend.attemptId,
      status: "admitted",
    }),
  );
  secondSocket.message(
    encodeRelayBinaryFrame({
      transportVersion: REMOTE_TRANSPORT_VERSION,
      attemptId: secondSend.attemptId,
      status: "forwarded",
    }),
  );
  secondSocket.message(
    encodeRelayBinaryFrame({
      transportVersion: REMOTE_TRANSPORT_VERSION,
      attemptId: parseTransportAttemptId("99999999-9999-4999-8999-999999999999"),
      sourceRouteId: secondDaemonRoute,
      opaquePayload: encodeRemoteDaemonMessage({
        version: REMOTE_TRANSPORT_VERSION,
        type: "daemon_accepted",
        requestId,
        idempotencyKey,
      }),
    }),
  );
  await nextTurn();
  await nextTurn();

  assert.ok(states.includes("reconnecting"));
  assert.ok(updates.includes("relay_admitted"));
  assert.ok(updates.includes("relay_forwarded"));
  assert.ok(updates.includes("daemon_accepted"));
  assert.deepEqual(await outbox.list(), []);
  delivery.close();
});
