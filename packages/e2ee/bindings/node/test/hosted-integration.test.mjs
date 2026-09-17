// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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
} from "@axl/protocol";
import { NativeEndpointOutbox, RemoteDeviceE2ee } from "@axl/sdk";

import * as fixture from "./fixture-loader.mjs";

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
  const session = uuid(22);
  const deviceId = uuid(23);
  const daemon = fixture.testDaemonEndpoint(join(root, "daemon-e2ee"), account, installation, session);
  const invitation = await daemon.issue(operation(1));
  const device = fixture.testDeviceEndpoint(
    join(root, "device-e2ee"),
    account,
    installation,
    session,
    deviceId,
  );
  const prejoin = await device.prepare(invitation.bytes, operation(2));
  const pending = await daemon.submitClaim(operation(3), prejoin.bytes);
  const reservationId = operation(4);
  await daemon.confirmClaim(operation(5), pending.hash, reservationId);
  const welcome = await daemon.createWelcome(operation(6), reservationId);
  await device.join(operation(7), welcome);
  const activation = await device.prepareActivation(operation(8), operation(9));
  const acceptance = await daemon.acceptActivation(operation(10), operation(9), activation.ciphertext);
  await device.acknowledgeActivation(operation(11), acceptance);
  return { daemon, device, installation, session, deviceId };
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
  const bridge = new WindowsRemoteE2eeBridge({
    daemon,
    deviceId,
    authority,
    endpoint: pair.daemon,
    sender: {
      send(_route, envelope) {
        const waiter = waiters.shift();
        if (!waiter) throw new Error("Unexpected encrypted daemon delivery");
        waiter(envelope.slice());
      },
    },
  });
  const client = new RemoteDeviceE2ee({
    endpoint: pair.device,
    localDeviceId: deviceId,
    daemonDeviceId,
    destinationCryptoSessionId: cryptoSessionId,
  });
  try {
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
      pair.device,
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
  } finally {
    bridge.close();
    pair.device.close();
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
