// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { ModelPort } from "@axl/kernel";
import { ToolRegistry } from "@axl/kernel";
import {
  type DeviceId,
  parseDeviceId,
  parseInstallationId,
  parseSessionId,
  type RemotePairingStartResult,
  type RemoteStatusResult,
  type SessionId,
} from "@axl/protocol";
import { AxlClientError } from "@axl/sdk";
import { connectUnixClient } from "@axl/sdk/unix";

import {
  AxlDaemon,
  type RemotePairingService,
  RemoteDeviceAuthorityStore,
  requiredRemoteScope,
} from "../src/index.ts";

const model: ModelPort = {
  stream: () =>
    (async function* () {
      yield {
        type: "completed" as const,
        stopReason: "stop" as const,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    })(),
};

const pairing: RemotePairingStartResult = {
  link: "https://stack.example/remote/#v=1",
  cryptoSessionId: "01890a5d-ac96-774b-bcce-b302099a8059",
  deviceId: "01890a5d-ac96-774b-bcce-b302099a8058",
  expiresAt: 1_900_000_000_000,
};

const status: RemoteStatusResult = {
  phase: "paired",
  relay: "reconnecting",
  deviceOnline: false,
  cryptoSessionId: pairing.cryptoSessionId,
  deviceId: pairing.deviceId,
  lastError: { message: "remote: relay stopped answering", at: 1_900_000_000_000 },
};

const installationId = parseInstallationId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

/** A paired-or-not remote host with nothing behind it. */
function service(overrides: Partial<RemotePairingService> = {}): RemotePairingService {
  return {
    start: async () => pairing,
    status: () => status,
    pairedDevice: () => undefined,
    unpair: async () => false,
    ...overrides,
  };
}

async function start(
  context: TestContext,
  remotePairing?: RemotePairingService,
  remoteAuthority?: (dataDirectory: string) => Promise<RemoteDeviceAuthorityStore>,
) {
  const directory = await mkdtemp(join(tmpdir(), "axl-remote-pairing-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "axl.sock");
  const dataDirectory = join(directory, "data");
  const authority = await remoteAuthority?.(dataDirectory);
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory,
    ...(remotePairing === undefined ? {} : { remotePairing }),
    ...(authority === undefined ? {} : { remoteAuthority: authority }),
    runtime: async () => ({ model, tools: new ToolRegistry() }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());
  return Object.assign(client, { daemon, cwd: await realpath(directory) });
}

test("grants remote pairing only when the daemon hosts it", async (context) => {
  const without = await start(context);
  assert.equal(without.connection.grantedCapabilities.includes("remote.pairing.start"), false);
  await assert.rejects(
    without.startRemotePairing(),
    (error) => error instanceof AxlClientError && error.code === "unsupported_capability",
  );
  assert.equal(without.connection.grantedCapabilities.includes("remote.status"), false);

  let calls = 0;
  const hosted = await start(
    context,
    service({
      start: async () => {
        calls += 1;
        return pairing;
      },
    }),
  );
  assert.equal(hosted.connection.grantedCapabilities.includes("remote.pairing.start"), true);
  assert.deepEqual(await hosted.startRemotePairing(), pairing);
  assert.equal(calls, 1);
  assert.deepEqual(await hosted.remoteStatus(), status);
});

test("reports a failed pairing start as remote_unavailable", async (context) => {
  const client = await start(
    context,
    service({
      start: async () => {
        throw new Error("witness down: secret-detail");
      },
    }),
  );
  await assert.rejects(client.startRemotePairing(), (error) => {
    assert.ok(error instanceof AxlClientError);
    assert.equal(error.code, "remote_unavailable");
    assert.doesNotMatch(error.message, /secret-detail/u);
    return true;
  });
});

test("remote devices cannot start another pairing", () => {
  assert.equal(requiredRemoteScope("remote.pairing.start"), undefined);
  assert.equal(requiredRemoteScope("remote.status"), undefined);
});

const fails = (code: string) => (error: unknown) =>
  error instanceof AxlClientError && error.code === code;

test("/remote shares the current session with the paired phone until it stops", async (context) => {
  const deviceId = parseDeviceId(pairing.deviceId);
  let paired: DeviceId | undefined = deviceId;
  let authority!: RemoteDeviceAuthorityStore;
  const starts: unknown[] = [];
  const client = await start(
    context,
    service({
      start: async (options) => {
        starts.push(options);
        return pairing;
      },
      pairedDevice: () => paired,
      unpair: async () => {
        if (paired === undefined) return false;
        await authority.revokeLocalDevice(paired);
        paired = undefined;
        return true;
      },
    }),
    async (dataDirectory) => {
      authority = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
      await authority.registerLocalDevice(deviceId, ["observe", "steer"]);
      await authority.applyHostedGrant(deviceId, 1, ["observe", "steer"]);
      return authority;
    },
  );
  const sessionId: SessionId = parseSessionId(
    (await client.daemon.sessions.create(client.cwd)).sessionId,
  );
  const unknown = parseSessionId("99999999-9999-4999-8999-999999999999");

  await assert.rejects(client.shareRemoteSession(unknown), fails("unknown_session"));
  const shared = await client.shareRemoteSession(sessionId);
  assert.deepEqual(
    shared.shares.map((share) => [share.sessionId, share.cwd]),
    [[sessionId, client.cwd]],
  );
  assert.deepEqual(await client.remoteShares(), shared);

  const stopped = await client.unshareRemoteSession(sessionId);
  assert.deepEqual(stopped.shares, []);
  assert.ok(stopped.generation > shared.generation);

  await client.shareRemoteSession(sessionId);
  assert.deepEqual(await client.unpairRemote(), { unpaired: true });
  assert.deepEqual((await client.remoteShares()).shares, []);
  assert.deepEqual(authority.shares(deviceId), []);
  await assert.rejects(client.shareRemoteSession(sessionId), fails("remote_not_paired"));
  assert.deepEqual(await client.unpairRemote(), { unpaired: false });

  // Pairing a phone from a session shares that session once the phone pairs.
  await assert.rejects(
    client.startRemotePairing({ shareSessionId: unknown }),
    fails("unknown_session"),
  );
  await client.startRemotePairing({ shareSessionId: sessionId });
  await client.startRemotePairing();
  assert.deepEqual(starts, [{ shareSessionId: sessionId }, {}]);
});

test("remote devices reopen closed sessions only with steer", () => {
  assert.equal(requiredRemoteScope("session.resume"), "steer");
});
