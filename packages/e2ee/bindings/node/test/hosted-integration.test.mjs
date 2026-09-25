// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AxlDaemon, RemoteDeviceAuthorityStore, WindowsRemoteE2eeBridge } from "@axl/daemon";
import { ToolRegistry } from "@axl/kernel";
import {
  parseCryptoSessionId,
  parseDeviceId,
  parseInstallationId,
  parseOperationId,
  parseRemoteE2eeEnvelope,
  parseRemoteRequestId,
  parseRouteId,
  parseWitnessRequest,
} from "@axl/protocol";
import {
  HostedPairingClient,
  NativeEndpointOutbox,
  RemoteDeviceE2ee,
  WitnessedEndpoint,
} from "@axl/sdk";
import {
  InMemoryPairingRendezvousStore,
  InMemoryRelayTicketStore,
  PairingRendezvousService,
  RelayTicketService,
  createControlPlaneHandler,
} from "@axl/control-plane";

import * as fixture from "./fixture-loader.mjs";
import { complete, witnessed } from "./witness-driver.mjs";

// The pairing lifecycle below is driven directly against the binding. The SDK and daemon adapters
// then run their own witness barriers against the same in-process quorum through its `respond`.
const unwrap = (field) => (result) => {
  const value = result[field];
  if (value === undefined || value === null) throw new TypeError(`expected ${field}, got ${result.tag}`);
  return value;
};

function uuid(seed) {
  const value = Buffer.alloc(16, seed);
  value[6] = 0x70 | (seed & 0x0f);
  value[8] = 0x80 | (seed & 0x3f);
  return value;
}

const operation = (value) => uuid(value);
const uuidText = (value) => {
  const encoded = Buffer.from(value).toString("hex");
  return `${encoded.slice(0, 8)}-${encoded.slice(8, 12)}-${encoded.slice(12, 16)}-${encoded.slice(16, 20)}-${encoded.slice(20)}`;
};

async function activatedPair(root) {
  const account = Buffer.alloc(16, 20);
  const installation = uuid(21);
  const session = uuid(22);
  const deviceId = uuid(23);
  const witness = fixture.testWitness();
  const daemon = fixture.testDaemonEndpoint(join(root, "daemon-e2ee"), account, installation, session, witness);
  const invitation = unwrap("publication")(await complete(daemon, witness, await daemon.issue(operation(1))));
  const device = fixture.testDeviceEndpoint(
    join(root, "device-e2ee"),
    account,
    installation,
    session,
    deviceId,
    witness,
  );
  const prejoin = unwrap("publication")(
    await complete(device, witness, await device.prepare(invitation.bytes, operation(2))),
  );
  const pending = unwrap("publication")(
    await witnessed(daemon, witness, () => daemon.submitClaim(operation(3), prejoin.bytes)),
  );
  const reservationId = operation(4);
  await witnessed(daemon, witness, () => daemon.confirmClaim(operation(5), pending.hash, reservationId));
  const welcome = unwrap("welcome")(
    await witnessed(daemon, witness, () => daemon.createWelcome(operation(6), reservationId)),
  );
  await witnessed(device, witness, () => device.join(operation(7), welcome));
  const activation = unwrap("outbox")(
    await witnessed(device, witness, () => device.prepareActivation(operation(8), operation(9))),
  );
  const acceptance = unwrap("activation")(
    await witnessed(daemon, witness, () =>
      daemon.acceptActivation(operation(10), operation(9), activation.ciphertext),
    ),
  );
  await witnessed(device, witness, () => device.acknowledgeActivation(operation(11), acceptance));
  return {
    daemon,
    device,
    witness,
    installation,
    session,
    deviceId,
  };
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

function nextDelivery(deliveries) {
  return new Promise((resolve) => deliveries.push(resolve));
}

test("real native pairing crosses the hosted claim and Welcome rendezvous", async () => {
  const root = mkdtempSync(join(tmpdir(), "axl-hosted-pairing-"));
  const account = Buffer.alloc(16, 30);
  const installation = uuid(31);
  const session = uuid(32);
  const nativeDeviceId = uuid(33);
  const witness = fixture.testWitness();
  const daemonEndpoint = fixture.testDaemonEndpoint(
    join(root, "daemon"),
    account,
    installation,
    session,
    witness,
  );
  const deviceEndpoint = fixture.testDeviceEndpoint(
    join(root, "device"),
    account,
    installation,
    session,
    nativeDeviceId,
    witness,
  );
  const daemonRun = (mutate, field) => witnessed(daemonEndpoint, witness, mutate).then(unwrap(field));
  const deviceRun = (mutate, field) => witnessed(deviceEndpoint, witness, mutate).then(unwrap(field));
  const pairing = new PairingRendezvousService({
    store: new InMemoryPairingRendezvousStore(),
  });
  const server = createServer(
    createControlPlaneHandler({
      tickets: new RelayTicketService({
        store: new InMemoryRelayTicketStore(),
        relayUrl: "wss://relay.invalid/v1/connect",
        authorizer: { currentGeneration: async () => 1 },
        proofVerifier: { verify: async () => true },
      }),
      pairing,
      publicAuthentication: { authenticate: async () => ({ accountId: "account-fixture" }) },
      internalAuthentication: { authenticate: async () => true },
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new HostedPairingClient({
    origin: `http://127.0.0.1:${address.port}`,
    authorization: async () => "fixture",
    allowInsecureLoopbackForTests: true,
  });
  try {
    const invitation = unwrap("publication")(
      await complete(daemonEndpoint, witness, await daemonEndpoint.issue(operation(1))),
    );
    const prejoin = unwrap("publication")(
      await complete(deviceEndpoint, witness, await deviceEndpoint.prepare(invitation.bytes, operation(2))),
    );
    const claimHash = createHash("sha384").update(prejoin.bytes).digest();
    const binding = {
      version: 1,
      installationId: uuidText(installation),
      deviceId: uuidText(nativeDeviceId),
      cryptoSessionId: uuidText(session),
      claimHash,
    };
    await client.publishClaim({ ...binding, claim: prejoin.bytes });
    const reservationText = "34343434-3434-7434-b434-343434343434";
    const reserved = await client.reserveClaim({
      ...binding,
      reservationId: reservationText,
    });
    const pending = await daemonRun(() => daemonEndpoint.submitClaim(operation(3), reserved.claim), "publication");
    await daemonRun(
      () =>
        daemonEndpoint.confirmClaim(
          operation(4),
          pending.hash,
          Buffer.from(reservationText.replaceAll("-", ""), "hex"),
        ),
      "status",
    );
    const welcome = await daemonRun(
      () => daemonEndpoint.createWelcome(operation(5), Buffer.from(reservationText.replaceAll("-", ""), "hex")),
      "welcome",
    );
    const welcomeHash = createHash("sha384").update(welcome.bytes).digest();
    await client.publishWelcome({
      ...binding,
      reservationId: reservationText,
      welcome: welcome.bytes,
      welcomeHash,
    });
    const published = await client.fetchWelcome(binding);
    assert.equal(
      await deviceRun(
        () =>
          deviceEndpoint.joinPublishedWelcome(
            operation(6),
            published.welcome,
            claimHash,
            published.welcomeHash,
            BigInt(published.expiresAt),
          ),
        "status",
      ),
      "joined",
    );
    const activation = await deviceRun(() => deviceEndpoint.prepareActivation(operation(7), operation(8)), "outbox");
    const acceptance = await daemonRun(
      () => daemonEndpoint.acceptActivation(operation(9), operation(8), activation.ciphertext),
      "activation",
    );
    assert.equal(
      await deviceRun(() => deviceEndpoint.acknowledgeActivation(operation(10), acceptance), "status"),
      "active",
    );
    await client.acknowledgeWelcome({ ...binding, welcomeHash });
  } finally {
    daemonEndpoint.close();
    deviceEndpoint.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("real OpenMLS endpoints cross the daemon authority bridge", async () => {
  const root = mkdtempSync(join(tmpdir(), "axl-real-e2ee-hosted-"));
  const pair = await activatedPair(root);
  const installationId = parseInstallationId(
    "15151515-1515-7515-9515-151515151515",
  );
  const deviceId = parseDeviceId("17171717-1717-7717-9717-171717171717");
  const daemonDeviceId = parseDeviceId("18181818-1818-7818-9818-181818181818");
  const cryptoSessionId = parseCryptoSessionId(
    `${pair.session.toString("hex").slice(0, 8)}-${pair.session.toString("hex").slice(8, 12)}-${pair.session.toString("hex").slice(12, 16)}-${pair.session.toString("hex").slice(16, 20)}-${pair.session.toString("hex").slice(20)}`,
  );
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
  const waiters = [];
  const witnessCalls = { daemon: 0, device: 0 };
  const bridge = new WindowsRemoteE2eeBridge({
    daemon,
    deviceId,
    authority,
    endpoint: pair.daemon,
    witness: {
      async respond(request) {
        witnessCalls.daemon += 1;
        return pair.witness.respond(request);
      },
    },
    sender: {
      send(_route, envelope) {
        const waiter = waiters.shift();
        if (!waiter) throw new Error("Unexpected encrypted daemon delivery");
        waiter(envelope.slice());
      },
    },
  });
  const witnessedDevice = new WitnessedEndpoint(pair.device, {
    async respond(request) {
      witnessCalls.device += 1;
      return pair.witness.respond(request);
    },
  });
  const client = new RemoteDeviceE2ee({
    endpoint: witnessedDevice,
    localDeviceId: deviceId,
    daemonDeviceId,
    destinationCryptoSessionId: cryptoSessionId,
  });
  try {
    assert.equal(await bridge.start(), "ready");
    const requestId = parseRemoteRequestId("19191919-1919-7919-9919-191919191919");
    const outbound = await client.prepareEphemeral(
      { deviceId, requestId, method: "daemon.info", params: {} },
      1,
    );
    const responsePromise = nextDelivery(waiters);
    await bridge.receive({
      sourceRouteId: parseRouteId("20202020-2020-7020-a020-202020202020"),
      opaqueEnvelope: outbound,
    });
    const responseEnvelope = await responsePromise;
    const opened = await client.open(responseEnvelope);
    const response = client.decode(opened.plaintext);
    assert.equal(response.type, "daemon_result");
    if (response.type === "daemon_result") {
      assert.equal(response.requestId, requestId);
      assert.equal(response.method, "daemon.info");
    }
    await opened.acknowledge?.();

    const updateOperation = parseOperationId("21212121-2121-7121-a121-212121212121");
    const updateLogical = parseOperationId("22222222-2222-7222-a222-222222222222");
    const proposal = await client.prepareUpdateProposal(updateOperation, updateLogical, 1);
    const commitPromise = nextDelivery(waiters);
    await bridge.receive({
      sourceRouteId: parseRouteId("20202020-2020-7020-a020-202020202020"),
      opaqueEnvelope: proposal,
    });
    const commitEnvelope = await commitPromise;
    assert.equal(parseRemoteE2eeEnvelope(commitEnvelope).messageClass, "commit");
    const appliedCommit = await client.open(commitEnvelope);
    assert.equal(appliedCommit.controlOnly, true);

    const nativeOutbox = new NativeEndpointOutbox(
      witnessedDevice,
      { create: () => parseOperationId("23232323-2323-7323-a323-232323232323") },
      { resolve: async () => parseRouteId("20202020-2020-7020-a020-202020202020") },
    );
    const epochReadyRecord = (await nativeOutbox.list()).find(
      (record) => parseRemoteE2eeEnvelope(record.opaqueEnvelope).messageClass === "epoch_ready",
    );
    assert.ok(epochReadyRecord);
    const confirmationPromise = nextDelivery(waiters);
    await bridge.receive({
      sourceRouteId: parseRouteId("20202020-2020-7020-a020-202020202020"),
      opaqueEnvelope: epochReadyRecord.opaqueEnvelope,
    });
    const confirmationEnvelope = await confirmationPromise;
    assert.equal(parseRemoteE2eeEnvelope(confirmationEnvelope).messageClass, "resync_control");
    const confirmed = await client.open(confirmationEnvelope);
    assert.equal(confirmed.controlOnly, true);
    assert.equal(await pair.device.pairStatus(), "active");
    // Every adapter mutation went to the quorum twice: one fresh read and one committed advance.
    // The daemon bridge's start() adds one fresh read.
    assert.ok(witnessCalls.daemon >= 1 + 2 * 6, `daemon barrier calls: ${witnessCalls.daemon}`);
    assert.ok(witnessCalls.device >= 2 * 7, `device barrier calls: ${witnessCalls.device}`);
    assert.equal((witnessCalls.daemon - 1) % 2, 0);
    assert.equal(witnessCalls.device % 2, 0);
  } finally {
    bridge.close();
    pair.device.close();
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the daemon bridge recovers an accepted-but-lost barrier after restart and answers exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "axl-real-e2ee-recovery-"));
  const pair = await activatedPair(root);
  const installationId = parseInstallationId("25252525-2525-7525-9525-252525252525");
  const deviceId = parseDeviceId("27272727-2727-7727-9727-272727272727");
  const daemonDeviceId = parseDeviceId("28282828-2828-7828-9828-282828282828");
  const sessionHex = pair.session.toString("hex");
  const cryptoSessionId = parseCryptoSessionId(
    `${sessionHex.slice(0, 8)}-${sessionHex.slice(8, 12)}-${sessionHex.slice(12, 16)}-${sessionHex.slice(16, 20)}-${sessionHex.slice(20)}`,
  );
  const authority = await RemoteDeviceAuthorityStore.open(join(root, "daemon-data"), installationId);
  await authority.registerLocalDevice(deviceId, ["observe"]);
  await authority.applyHostedGrant(deviceId, 1, ["observe"]);
  const daemon = new AxlDaemon({
    socketPath: join(root, "daemon.sock"),
    dataDirectory: join(root, "daemon-data"),
    securityMode: "sandboxed",
    sandboxProvider: "fixture",
    remoteAuthority: authority,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry(), system: "test" }),
  });
  await daemon.start();
  const route = parseRouteId("30303030-3030-7030-a030-303030303030");
  const waiters = [];
  const sender = {
    send(_route, envelope) {
      const waiter = waiters.shift();
      if (!waiter) throw new Error("Unexpected encrypted daemon delivery");
      waiter(envelope.slice());
    },
  };
  const scheduled = [];
  const timers = {
    setTimeout: (run, delayMs) => scheduled.push({ run, delayMs }) && scheduled.length,
    clearTimeout: (handle) => scheduled.splice(handle - 1, 1),
  };
  // The quorum accepts the committed advance, but the certificate is lost before the daemon
  // endpoint sees it: the endpoint holds an accepted pending operation and no result.
  let loseNextAdvance = false;
  let quorumAdvances = 0;
  const lossyWitness = {
    async respond(request) {
      const kind = parseWitnessRequest(request).kind;
      const certificate = pair.witness.respond(request);
      if (kind === "advance") quorumAdvances += 1;
      if (kind === "advance" && loseNextAdvance) {
        loseNextAdvance = false;
        certificate.fill(0);
        const error = new Error("certificate lost in transit");
        error.code = "witness_unavailable";
        throw error;
      }
      return certificate;
    },
  };
  const witnessedDevice = new WitnessedEndpoint(pair.device, {
    respond: async (request) => pair.witness.respond(request),
  });
  const client = new RemoteDeviceE2ee({
    endpoint: witnessedDevice,
    localDeviceId: deviceId,
    daemonDeviceId,
    destinationCryptoSessionId: cryptoSessionId,
  });
  let firstBridge;
  let secondBridge;
  try {
    firstBridge = new WindowsRemoteE2eeBridge({
      daemon,
      deviceId,
      authority,
      endpoint: pair.daemon,
      witness: lossyWitness,
      timers,
      random: () => 0.5,
      sender,
    });
    assert.equal(await firstBridge.start(), "ready");

    const requestId = parseRemoteRequestId("29292929-2929-7929-9929-292929292929");
    const outbound = await client.prepareEphemeral(
      { deviceId, requestId, method: "daemon.info", params: {} },
      1,
    );
    loseNextAdvance = true;
    await assert.rejects(firstBridge.receive({ sourceRouteId: route, opaqueEnvelope: outbound }), {
      code: "witness_unavailable",
    });
    assert.equal(quorumAdvances, 1, "the quorum accepted the receive before the loss");
    assert.equal(firstBridge.witnessStatus.state, "recovering");
    assert.deepEqual(waiters, [], "no response was framed for an unreleased plaintext");
    assert.equal(scheduled.length, 1, "one recovery retry is scheduled");
    assert.equal(scheduled[0].delayMs, 1_000);
    assert.equal((await pair.daemon.pendingWitness()).kind, "advance");
    // Work is refused while recovery is pending, without touching the endpoint.
    await assert.rejects(firstBridge.receive({ sourceRouteId: route, opaqueEnvelope: outbound }), {
      code: "witness_unavailable",
    });

    // Daemon process crash: the endpoint closes with its pending operation on disk.
    firstBridge.close();
    assert.equal(scheduled.length, 0, "closing cancelled the retry timer");
    assert.equal(await pair.daemon.reopen(), "opened");

    // Restart: the new bridge completes the accepted operation before admitting work.
    secondBridge = new WindowsRemoteE2eeBridge({
      daemon,
      deviceId,
      authority,
      endpoint: pair.daemon,
      witness: lossyWitness,
      timers,
      random: () => 0.5,
      sender,
    });
    assert.equal(await secondBridge.start(), "ready");
    assert.equal(await pair.daemon.pendingWitness(), null, "recovery completed the pending advance");
    assert.equal(quorumAdvances, 2, "exact resend of the same advance");

    // The device retries the byte-identical request and receives exactly one answer.
    const responsePromise = nextDelivery(waiters);
    await secondBridge.receive({ sourceRouteId: route, opaqueEnvelope: outbound });
    const opened = await client.open(await responsePromise);
    const response = client.decode(opened.plaintext);
    assert.equal(response.type, "daemon_result");
    assert.equal(response.requestId, requestId);
    assert.deepEqual(response.result.remoteEndpoints.map((status) => status.state), ["ready"]);
    await opened.acknowledge?.();
    assert.deepEqual(waiters, [], "exactly one response");

    assert.deepEqual(
      authority
        .auditEntries()
        .filter((event) => event.code.startsWith("endpoint_"))
        .map((event) => event.code),
      ["endpoint_ready", "endpoint_recovering", "endpoint_ready"],
      "one durable transition per lifecycle change, none per retry",
    );
    assert.deepEqual(
      authority.endpointWitnessStatuses().map((status) => [status.deviceId, status.state]),
      [[deviceId, "ready"]],
    );
  } finally {
    secondBridge?.close();
    firstBridge?.close();
    pair.device.close();
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
