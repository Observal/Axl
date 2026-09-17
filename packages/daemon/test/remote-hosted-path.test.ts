// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import test, { type TestContext } from "node:test";

import { type ModelPort, ToolRegistry } from "@axl/kernel";
import {
  MAX_RELAY_OPAQUE_PAYLOAD_BYTES,
  REMOTE_TRANSPORT_VERSION,
  encodeRemoteDaemonMessage,
  parseAuthenticatedRemoteRequest,
  parseCryptoSessionId,
  parseDeviceId,
  parseIdempotencyKey,
  parseInstallationId,
  parseRemoteRequestId,
  parseSessionId,
  parseTransportAttemptId,
  type AuthenticatedRemoteRequest,
  type ModelStreamEvent,
  type OpaqueOutboxRecord,
  type RemoteDaemonMessage,
  type RequestId,
  type RouteId,
} from "@axl/protocol";
import {
  HttpRelayTicketProvider,
  OpaqueOutbox,
  RemoteHostedDelivery,
  RemoteRelayConnection,
  type OpaqueOutboxStore,
  type OpaqueOutboxTransaction,
  type RemoteWebSocket,
  type RemoteWebSocketFactory,
  type TransportAttemptIdFactory,
} from "@axl/sdk";
import { DeterministicFakeRemoteCryptoAdapter } from "../../protocol/test/support/fake-remote-crypto.ts";
import {
  InMemoryRelayTicketStore,
  RelayTicketService,
  createControlPlaneHandler,
} from "../../../services/control-plane/src/index.ts";
import { AxlDaemon, type AuthenticatedRemoteAttachment } from "../src/daemon.ts";
import { RemoteDeviceAuthorityStore } from "../src/remote-authority.ts";

const repositoryRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const installationId = parseInstallationId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const deviceId = parseDeviceId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const daemonId = parseDeviceId("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
const cryptoSessionId = parseCryptoSessionId("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
const requestId = parseRemoteRequestId("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
const idempotencyKey = parseIdempotencyKey("ffffffff-ffff-4fff-8fff-ffffffffffff");

class MemoryOutboxStore implements OpaqueOutboxStore {
  private readonly records = new Map<RequestId, OpaqueOutboxRecord>();

  async transact<Result>(
    id: RequestId,
    operation: (current: OpaqueOutboxRecord | undefined) => OpaqueOutboxTransaction<Result>,
  ): Promise<Result> {
    const transaction = operation(this.records.get(id));
    if (transaction.record === undefined) this.records.delete(id);
    else this.records.set(id, transaction.record);
    return transaction.result;
  }

  async list(): Promise<readonly OpaqueOutboxRecord[]> {
    return [...this.records.values()];
  }
}

class LoopbackWebSocketFactory implements RemoteWebSocketFactory {
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  connect(): RemoteWebSocket {
    const Constructor = (globalThis as unknown as { WebSocket: new (url: string) => unknown })
      .WebSocket;
    return new Constructor(this.url) as RemoteWebSocket;
  }
}

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

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return port;
}

async function waitFor(
  description: string,
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startRelay(port: number, controlPlaneOrigin: string): Promise<ChildProcess> {
  const child = spawn("mix", ["run", "--no-halt", "test/support/hosted_path_server.exs"], {
    cwd: join(repositoryRoot, "services/relay"),
    env: {
      ...process.env,
      MIX_ENV: "test",
      AXL_RELAY_TEST_PORT: String(port),
      AXL_CONTROL_PLANE_TEST_ORIGIN: controlPlaneOrigin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Uint8Array) => {
    output += Buffer.from(chunk).toString("utf8");
  });
  child.stderr?.on("data", (chunk: Uint8Array) => {
    output += Buffer.from(chunk).toString("utf8");
  });
  await Promise.race([
    waitFor("relay startup", () => output.includes("AXL_RELAY_TEST_READY"), 30_000),
    once(child, "exit").then(([code]) => {
      throw new Error(`Relay exited during startup with ${String(code)}: ${output}`);
    }),
  ]);
  return child;
}

async function stopRelay(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit").then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function attempts(prefix: string): TransportAttemptIdFactory {
  let counter = 0;
  return {
    create() {
      counter += 1;
      return parseTransportAttemptId(
        `${prefix.slice(0, 24)}-${counter.toString().padStart(12, "0")}`,
      );
    },
  };
}

async function sealRequest(
  crypto: DeterministicFakeRemoteCryptoAdapter,
  request: AuthenticatedRemoteRequest,
): Promise<Uint8Array> {
  return crypto.seal(daemonId, new TextEncoder().encode(JSON.stringify(request)));
}

const runHostedIntegration =
  process.env.AXL_RUN_HOSTED_PATH_INTEGRATION === "1" &&
  spawnSync("mix", ["--version"], {
    cwd: join(repositoryRoot, "services/relay"),
    stdio: "ignore",
  }).status === 0;

test(
  "real hosted path retries exact fake ciphertext through new routes with one durable effect",
  {
    skip: runHostedIntegration ? false : "set AXL_RUN_HOSTED_PATH_INTEGRATION=1 with Mix installed",
  },
  async (context: TestContext) => {
    const root = await mkdtemp(join(tmpdir(), "axl-hosted-path-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const cwd = await realpath(root);
    const dataDirectory = join(root, "daemon-data");
    const socketPath = join(root, "daemon.sock");
    const relayPort = await freePort();
    let hostedGeneration: number | undefined = 1;
    let tokenCounter = 0;
    let routeCounter = 0;

    const tickets = new RelayTicketService({
      store: new InMemoryRelayTicketStore(),
      authorizer: {
        async currentGeneration(principal, requested) {
          if (
            principal.accountId !== "account-fixture" ||
            requested.installationId !== installationId
          ) {
            return undefined;
          }
          if (requested.role === "device" && requested.deviceId !== deviceId) return undefined;
          return hostedGeneration;
        },
      },
      proofVerifier: {
        async verify(_ticket, requested) {
          return Buffer.from(requested.possessionProof).equals(Buffer.from([0, 1, 2, 3, 255]));
        },
      },
      relayUrl: "wss://relay.invalid/v1/connect",
      randomToken: () => {
        tokenCounter += 1;
        return `hosted-path-ticket-${tokenCounter}`;
      },
      randomId: () => {
        routeCounter += 1;
        return `11111111-1111-4111-8111-${routeCounter.toString().padStart(12, "0")}`;
      },
    });
    const controlPlane = createServer(
      createControlPlaneHandler({
        tickets,
        publicAuthentication: {
          async authenticate(request) {
            return request.headers.authorization === "Bearer public-fixture"
              ? { accountId: "account-fixture" }
              : undefined;
          },
        },
        internalAuthentication: {
          async authenticate(request) {
            return request.headers.authorization === "Bearer internal-fixture";
          },
        },
      }),
    );
    controlPlane.listen(0, "127.0.0.1");
    await once(controlPlane, "listening");
    context.after(
      () =>
        new Promise<void>((resolve) => {
          controlPlane.closeAllConnections();
          controlPlane.close(() => resolve());
        }),
    );
    const controlAddress = controlPlane.address();
    assert.ok(controlAddress !== null && typeof controlAddress !== "string");
    const controlOrigin = `http://127.0.0.1:${controlAddress.port}`;

    let relay = await startRelay(relayPort, controlOrigin);
    context.after(() => stopRelay(relay));
    const sockets = new LoopbackWebSocketFactory(`ws://127.0.0.1:${relayPort}/v1/connect`);
    const proof = {
      async create() {
        return {
          connectionNonce: "hosted-path-nonce",
          possessionProof: Uint8Array.of(0, 1, 2, 3, 255),
        };
      },
    };
    const ticketProvider = (role: "daemon" | "device") =>
      new HttpRelayTicketProvider({
        controlPlaneOrigin: controlOrigin,
        request: {
          installationId,
          role,
          ...(role === "device" ? { deviceId } : {}),
        },
        authenticationHeaders: async () => ({ authorization: "Bearer public-fixture" }),
        proof,
        allowInsecureLoopbackForTests: true,
      });
    const connectionOptions = {
      sockets,
      reconnect: {
        maximumAttempts: 20,
        initialDelayMs: 50,
        maximumDelayMs: 200,
        jitterRatio: 0,
      },
      routeWaitMs: 5_000,
    } as const;
    const daemonConnection = new RemoteRelayConnection({
      ...connectionOptions,
      tickets: ticketProvider("daemon"),
    });
    const deviceConnection = new RemoteRelayConnection({
      ...connectionOptions,
      tickets: ticketProvider("device"),
      destinationCryptoSessionId: cryptoSessionId,
    });

    let daemon = new AxlDaemon({
      socketPath,
      dataDirectory,
      securityMode: "sandboxed",
      sandboxProvider: "fixture",
      runtime: () => ({ model: replyPort(), tools: new ToolRegistry(), system: "test" }),
    });
    await daemon.start();
    context.after(() => daemon.stop());
    let authority = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
    await authority.registerLocalDevice(deviceId, ["observe", "steer"]);
    await authority.applyHostedGrant(deviceId, 1, ["observe", "steer"]);
    const created = await daemon.sessions.create(cwd);
    const sessionId = parseSessionId(created.sessionId);
    let attachment: AuthenticatedRemoteAttachment = daemon.attachAuthenticatedRemoteDevice({
      deviceId,
      authority,
      send: () => undefined,
    });

    const deviceCrypto = new DeterministicFakeRemoteCryptoAdapter(deviceId, daemonId);
    const daemonCrypto = new DeterministicFakeRemoteCryptoAdapter(daemonId, deviceId);
    const daemonAttempts = attempts("22222222-2222-4222-8222");
    const deviceAttempts = attempts("33333333-3333-4333-8333");
    const receivedCiphertexts: Uint8Array[] = [];
    const receivedRoutes: RouteId[] = [];
    const relayDiagnostics: string[] = [];
    deviceConnection.onReceipt((receipt) =>
      relayDiagnostics.push(`receipt:${receipt.status}:${receipt.attemptId}`),
    );
    deviceConnection.onFailure((failure) =>
      relayDiagnostics.push(`failure:${failure.code}:${failure.attemptId}`),
    );
    daemonConnection.onFailure((failure) =>
      relayDiagnostics.push(`daemon-failure:${failure.code}:${failure.attemptId}`),
    );
    let dropNextResponse = false;
    let mutationDeliveries = 0;
    const bridgeErrors: Error[] = [];

    const sendDaemonMessage = async (
      destinationRoute: RouteId,
      message: RemoteDaemonMessage,
    ): Promise<void> => {
      const ciphertext = await daemonCrypto.seal(deviceId, encodeRemoteDaemonMessage(message));
      daemonConnection.send(destinationRoute, daemonAttempts.create(), ciphertext);
    };

    daemonConnection.onDelivery((delivery) => {
      void (async () => {
        const opened = await daemonCrypto.open(delivery.opaquePayload);
        const request = parseAuthenticatedRemoteRequest(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(opened.plaintext)),
        );
        const isMutation = request.requestId === requestId;
        if (isMutation) {
          receivedCiphertexts.push(delivery.opaquePayload.slice());
          receivedRoutes.push(delivery.sourceRouteId);
        }
        const response = await attachment.request(request);
        if (isMutation) mutationDeliveries += 1;
        if (dropNextResponse) {
          dropNextResponse = false;
          return;
        }
        if (request.idempotencyKey !== undefined) {
          await sendDaemonMessage(delivery.sourceRouteId, {
            version: REMOTE_TRANSPORT_VERSION,
            type: "daemon_accepted",
            requestId: request.requestId,
            idempotencyKey: request.idempotencyKey,
          });
        }
        await sendDaemonMessage(delivery.sourceRouteId, {
          version: REMOTE_TRANSPORT_VERSION,
          type: "daemon_result",
          requestId: response.requestId,
          method: response.method,
          result: response.result,
        });
      })().catch((error: unknown) => {
        bridgeErrors.push(error instanceof Error ? error : new Error(String(error)));
      });
    });

    await daemonConnection.start();
    const store = new MemoryOutboxStore();
    const outbox = new OpaqueOutbox(store, deviceAttempts, deviceConnection);
    const delivery = new RemoteHostedDelivery({
      connection: deviceConnection,
      outbox,
      attemptIds: deviceAttempts,
      expectedDaemonId: daemonId,
      opener: {
        async open(ciphertext) {
          const opened = await deviceCrypto.open(ciphertext);
          return { authenticatedPeerId: opened.authenticatedDeviceId, plaintext: opened.plaintext };
        },
      },
    });
    const messages: RemoteDaemonMessage[] = [];
    const deliveryErrors: Error[] = [];
    delivery.onMessage((message) => messages.push(message));
    delivery.onError((error) => deliveryErrors.push(error));
    await delivery.start();

    const sendEphemeralRequest = async (request: AuthenticatedRemoteRequest): Promise<void> => {
      await delivery.sendPreparedEphemeral(
        cryptoSessionId,
        await sealRequest(deviceCrypto, request),
      );
    };
    const waitForResult = async (id: RequestId, count = 1) => {
      await waitFor(
        `daemon result ${id}`,
        () =>
          messages.filter((message) => message.type === "daemon_result" && message.requestId === id)
            .length >= count,
      );
      const result = messages.findLast(
        (message) => message.type === "daemon_result" && message.requestId === id,
      );
      assert.ok(result?.type === "daemon_result");
      return result.result;
    };

    const subscribeId = parseRemoteRequestId("44444444-4444-4444-8444-444444444444");
    await sendEphemeralRequest({
      deviceId,
      requestId: subscribeId,
      method: "session.subscribe",
      params: { sessionId },
    });
    const initialSubscription = (await waitForResult(subscribeId)) as {
      readonly subscriptionId: string;
      readonly snapshot?: { readonly boundaryCursor: string };
    };
    const cursor = initialSubscription.snapshot?.boundaryCursor;
    assert.ok(cursor);
    const ackId = parseRemoteRequestId("55555555-5555-4555-8555-555555555555");
    await sendEphemeralRequest({
      deviceId,
      requestId: ackId,
      method: "session.ack",
      params: { subscriptionId: initialSubscription.subscriptionId, cursor },
    });
    await waitForResult(ackId);

    const mutation: AuthenticatedRemoteRequest = {
      deviceId,
      requestId,
      idempotencyKey,
      method: "session.interrupt",
      params: { sessionId },
    };
    const preparedCiphertext = await sealRequest(deviceCrypto, mutation);
    const preparedRecord: OpaqueOutboxRecord = {
      requestId,
      idempotencyKey,
      destinationCryptoSessionId: cryptoSessionId,
      opaqueEnvelope: preparedCiphertext,
      createdAt: Date.now(),
      state: "queued_local",
    };
    dropNextResponse = true;
    await delivery.enqueuePrepared(preparedRecord);
    try {
      await waitFor("first durable daemon execution", () => mutationDeliveries === 1);
    } catch (cause) {
      throw new Error(
        `Hosted request did not reach the daemon; diagnostics=${JSON.stringify(relayDiagnostics)} bridgeErrors=${bridgeErrors.map((error) => error.message).join("|")}`,
        { cause },
      );
    }

    await stopRelay(relay);
    relay = await startRelay(relayPort, controlOrigin);
    await waitFor("retry through restarted relay", () => mutationDeliveries >= 2, 20_000);
    await waitForResult(requestId);
    assert.deepEqual(receivedCiphertexts[1], receivedCiphertexts[0]);
    assert.notEqual(receivedRoutes[1], receivedRoutes[0]);

    const resumeId = parseRemoteRequestId("66666666-6666-4666-8666-666666666666");
    attachment.close();
    attachment = daemon.attachAuthenticatedRemoteDevice({
      deviceId,
      authority,
      send: () => undefined,
    });
    await sendEphemeralRequest({
      deviceId,
      requestId: resumeId,
      method: "session.subscribe",
      params: { sessionId, after: cursor },
    });
    const resumed = (await waitForResult(resumeId)) as { readonly resumedFrom?: string };
    assert.equal(resumed.resumedFrom, cursor);

    await daemon.stop();
    daemon = new AxlDaemon({
      socketPath,
      dataDirectory,
      securityMode: "sandboxed",
      sandboxProvider: "fixture",
      runtime: () => ({ model: replyPort(), tools: new ToolRegistry(), system: "test" }),
    });
    await daemon.start();
    authority = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
    attachment = daemon.attachAuthenticatedRemoteDevice({
      deviceId,
      authority,
      send: () => undefined,
    });
    await delivery.enqueuePrepared(preparedRecord);
    await waitFor("duplicate after daemon restart", () => mutationDeliveries >= 3);
    await waitForResult(requestId, 2);

    const journal = (await readFile(join(dataDirectory, "commands.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { readonly type: string; readonly idempotencyKey: string },
      );
    assert.equal(
      journal.filter(
        (record) => record.type === "accepted" && record.idempotencyKey === idempotencyKey,
      ).length,
      1,
    );

    const daemonRoute = await deviceConnection.resolve(cryptoSessionId);
    assert.throws(() =>
      deviceConnection.send(
        daemonRoute,
        deviceAttempts.create(),
        new Uint8Array(MAX_RELAY_OPAQUE_PAYLOAD_BYTES + 1),
      ),
    );

    hostedGeneration = undefined;
    await authority.applyHostedGrant(deviceId, 2, ["observe", "steer"], Date.now());
    const revocation = await fetch(`http://127.0.0.1:${relayPort}/internal/v1/revocations`, {
      method: "POST",
      headers: { authorization: "Bearer internal-fixture", "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        installationId,
        deviceId,
        generation: 2,
        effectiveAt: Date.now(),
      }),
    });
    assert.equal(revocation.status, 200);
    await waitFor(
      "revoked device disconnect",
      () => deviceConnection.state === "disconnected",
      20_000,
    );

    assert.deepEqual(bridgeErrors, []);
    assert.deepEqual(deliveryErrors, []);
    delivery.close();
    daemonConnection.close();
  },
);
