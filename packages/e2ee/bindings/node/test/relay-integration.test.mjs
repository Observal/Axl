// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AxlDaemon, RemoteDeviceAuthorityStore, WindowsRemoteE2eeBridge } from "@axl/daemon";
import { ToolRegistry } from "@axl/kernel";
import {
  parseCryptoSessionId,
  parseDeviceId,
  parseIdempotencyKey,
  parseInstallationId,
  parseOperationId,
  parseRemoteRequestId,
  parseTransportAttemptId,
} from "@axl/protocol";
import {
  HttpRelayTicketProvider,
  NativeEndpointOutbox,
  RemoteDeviceE2ee,
  RemoteHostedDelivery,
  RemoteRelayConnection,
} from "@axl/sdk";
import {
  InMemoryRelayTicketStore,
  RelayTicketService,
  createControlPlaneHandler,
} from "@axl/control-plane";

import * as fixture from "./fixture-loader.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const installationId = parseInstallationId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const deviceId = parseDeviceId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const daemonId = parseDeviceId("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
const cryptoSessionId = parseCryptoSessionId("dddddddd-dddd-7ddd-9ddd-dddddddddddd");

function uuid(seed) {
  const value = Buffer.alloc(16, seed);
  value[6] = 0x70 | (seed & 0x0f);
  value[8] = 0x80 | (seed & 0x3f);
  return value;
}

const operation = (value) => uuid(value);

async function activatedPair(root) {
  const account = Buffer.alloc(16, 20);
  const installation = uuid(21);
  const session = Buffer.from(cryptoSessionId.replaceAll("-", ""), "hex");
  const device = uuid(23);
  const daemonEndpoint = fixture.testDaemonEndpoint(
    join(root, "daemon-e2ee"),
    account,
    installation,
    session,
  );
  const invitation = await daemonEndpoint.issue(operation(1));
  const deviceEndpoint = fixture.testDeviceEndpoint(
    join(root, "device-e2ee"),
    account,
    installation,
    session,
    device,
  );
  const prejoin = await deviceEndpoint.prepare(invitation.bytes, operation(2));
  const pending = await daemonEndpoint.submitClaim(operation(3), prejoin.bytes);
  const reservation = operation(4);
  await daemonEndpoint.confirmClaim(operation(5), pending.hash, reservation);
  const welcome = await daemonEndpoint.createWelcome(operation(6), reservation);
  await deviceEndpoint.join(operation(7), welcome);
  const activation = await deviceEndpoint.prepareActivation(operation(8), operation(9));
  const acceptance = await daemonEndpoint.acceptActivation(
    operation(10),
    operation(9),
    activation.ciphertext,
  );
  await deviceEndpoint.acknowledgeActivation(operation(11), acceptance);
  return { daemonEndpoint, deviceEndpoint };
}

function replyPort() {
  return {
    stream() {
      return (async function* () {
        yield {
          type: "completed",
          stopReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      })();
    },
  };
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitFor(description, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startRelay(port, controlPlaneOrigin) {
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
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  await Promise.race([
    waitFor("relay startup", () => output.includes("AXL_RELAY_TEST_READY"), 30_000),
    once(child, "exit").then(([code]) => {
      throw new Error(`Relay exited during startup with ${code}: ${output}`);
    }),
  ]);
  return child;
}

async function stopRelay(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function attempts(prefix) {
  let counter = 0;
  return {
    create() {
      counter += 1;
      return parseTransportAttemptId(`${prefix}-${counter.toString().padStart(12, "0")}`);
    },
  };
}

class LoopbackWebSocketFactory {
  constructor(url) {
    this.url = url;
  }
  connect() {
    return new WebSocket(this.url);
  }
}

const enabled =
  process.env.AXL_RUN_REAL_E2EE_RELAY_INTEGRATION === "1" &&
  spawnSync("mix", ["--version"], {
    cwd: join(repositoryRoot, "services/relay"),
    stdio: "ignore",
  }).status === 0;

test(
  "real OpenMLS application and epoch traffic crosses the real relay",
  { skip: enabled ? false : "set AXL_RUN_REAL_E2EE_RELAY_INTEGRATION=1 with Mix installed" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "axl-real-relay-e2ee-"));
    const pair = await activatedPair(root);
    const daemon = new AxlDaemon({
      socketPath: join(root, "daemon.sock"),
      dataDirectory: join(root, "daemon-data"),
      securityMode: "sandboxed",
      sandboxProvider: "fixture",
      runtime: () => ({ model: replyPort(), tools: new ToolRegistry(), system: "test" }),
    });
    await daemon.start();
    const authority = await RemoteDeviceAuthorityStore.open(
      join(root, "daemon-data"),
      installationId,
    );
    await authority.registerLocalDevice(deviceId, ["observe"]);
    await authority.applyHostedGrant(deviceId, 1, ["observe"]);

    const controlPlane = createServer(
      createControlPlaneHandler({
        tickets: new RelayTicketService({
          store: new InMemoryRelayTicketStore(),
          relayUrl: "wss://relay.invalid/v1/connect",
          authorizer: { currentGeneration: async () => 1 },
          proofVerifier: { verify: async () => true },
        }),
        publicAuthentication: { authenticate: async () => ({ accountId: "account-fixture" }) },
        internalAuthentication: { authenticate: async () => true },
      }),
    );
    controlPlane.listen(0, "127.0.0.1");
    await once(controlPlane, "listening");
    const address = controlPlane.address();
    assert.ok(address && typeof address !== "string");
    const controlOrigin = `http://127.0.0.1:${address.port}`;
    const relayPort = await freePort();
    const relay = await startRelay(relayPort, controlOrigin);

    const sockets = new LoopbackWebSocketFactory(`ws://127.0.0.1:${relayPort}/v1/connect`);
    const proof = {
      create: async () => ({ connectionNonce: "real-e2ee", possessionProof: Uint8Array.of(1) }),
    };
    const tickets = (role) =>
      new HttpRelayTicketProvider({
        controlPlaneOrigin: controlOrigin,
        request: {
          installationId,
          role,
          ...(role === "device" ? { deviceId } : {}),
        },
        authenticationHeaders: async () => ({ authorization: "Bearer test" }),
        proof,
        allowInsecureLoopbackForTests: true,
      });
    const common = {
      sockets,
      reconnect: {
        maximumAttempts: 4,
        initialDelayMs: 20,
        maximumDelayMs: 100,
        jitterRatio: 0,
      },
      routeWaitMs: 5_000,
    };
    const daemonConnection = new RemoteRelayConnection({ ...common, tickets: tickets("daemon") });
    const deviceConnection = new RemoteRelayConnection({
      ...common,
      tickets: tickets("device"),
      destinationCryptoSessionId: cryptoSessionId,
    });
    const daemonAttempts = attempts("55555555-5555-4555-8555");
    const deviceAttempts = attempts("66666666-6666-4666-8666");
    const errors = [];
    const bridge = new WindowsRemoteE2eeBridge({
      daemon,
      deviceId,
      authority,
      endpoint: pair.daemonEndpoint,
      sender: {
        send(route, envelope) {
          daemonConnection.send(route, daemonAttempts.create(), envelope);
        },
      },
      onError: (error) => errors.push(error),
    });
    daemonConnection.onDelivery((delivery) => {
      void bridge
        .receive({ sourceRouteId: delivery.sourceRouteId, opaqueEnvelope: delivery.opaquePayload })
        .catch((error) => errors.push(error));
    });
    const deviceCrypto = new RemoteDeviceE2ee({
      endpoint: pair.deviceEndpoint,
      localDeviceId: deviceId,
      daemonDeviceId: daemonId,
      destinationCryptoSessionId: cryptoSessionId,
    });
    const nativeOutbox = new NativeEndpointOutbox(
      pair.deviceEndpoint,
      deviceAttempts,
      deviceConnection,
    );
    const delivery = new RemoteHostedDelivery({
      connection: deviceConnection,
      outbox: nativeOutbox,
      opener: deviceCrypto,
      expectedDaemonId: daemonId,
      attemptIds: deviceAttempts,
    });
    const messages = [];
    delivery.onMessage((message) => messages.push(message));
    delivery.onError((error) => errors.push(error));

    try {
      await daemonConnection.start();
      await delivery.start();
      const requestId = parseRemoteRequestId("77777777-7777-4777-8777-777777777777");
      await delivery.sendPreparedEphemeral(
        cryptoSessionId,
        await deviceCrypto.prepareEphemeral(
          { deviceId, requestId, method: "daemon.info", params: {} },
          1,
        ),
      );
      await waitFor(
        "real encrypted daemon response",
        () => messages.some((message) => message.type === "daemon_result"),
      );
      await delivery.drain();

      await deviceCrypto.prepareUpdateProposal(
        parseOperationId("88888888-8888-4888-8888-888888888888"),
        parseOperationId("99999999-9999-4999-8999-999999999999"),
        1,
      );
      await delivery.flush();
      await waitFor("epoch-ready confirmation", async () => {
        try {
          return (await pair.deviceEndpoint.pairStatus()) === "active";
        } catch (error) {
          if (error?.code === "lifecycle_busy") return false;
          throw error;
        }
      });
      await waitFor("control outbox acknowledgement", async () => {
        try {
          return (await nativeOutbox.list()).length === 0;
        } catch (error) {
          if (error?.code === "lifecycle_busy") return false;
          throw error;
        }
      });
      await bridge.drain();
      assert.deepEqual(errors, []);
    } finally {
      await delivery.shutdown();
      daemonConnection.close();
      await bridge.shutdown();
      pair.deviceEndpoint.close();
      await daemon.stop();
      await stopRelay(relay);
      controlPlane.closeAllConnections();
      await new Promise((resolve) => controlPlane.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
