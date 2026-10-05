// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { type AxlDaemon, RemoteDeviceAuthorityStore, RemotePairingStartError } from "@axl/daemon";
import { parseDeviceId, parseInstallationId, parseSessionId } from "@axl/protocol";

import { RemoteAccessBusyError } from "../src/remote-claim.ts";
import { HostedRemoteHost, type HostedRemoteSettings } from "../src/remote-host.ts";

const PAIRED = JSON.stringify({
  version: 2,
  cryptoSessionId: "01890a5d-ac96-774b-bcce-b302099a8059",
  deviceId: "01890a5d-ac96-774b-bcce-b302099a8058",
  phase: "paired",
});

function settings(prepare: () => Promise<void>): HostedRemoteSettings {
  return {
    origin: "https://stack.example",
    pagePath: "/remote/",
    accountId: "0f0e0d0c-0b0a-4908-8706-050403020100",
    installationId: parseInstallationId("01890a5d-ac96-774b-bcce-b302099a8057"),
    accessToken: async () => "token",
    possession: async () => ({ connectionNonce: "nonce", possessionProof: new Uint8Array(48) }),
    prepare,
    endpoint: async () => {
      throw new Error("no endpoint in this test");
    },
  };
}

/** A paired host whose every `prepare` fails with `failure`, and the lines it logged. */
async function pairedHost(context: TestContext, failure: () => Error) {
  const root = await mkdtemp(join(tmpdir(), "axl-remote-host-"));
  let host: HostedRemoteHost | undefined;
  // `after` hooks run in the order they are added, so one hook closes the host first: a restore
  // still retrying would otherwise write into the directory while it is being removed.
  context.after(async () => {
    await host?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  await writeFile(join(root, "host.json"), PAIRED);
  const output: string[] = [];
  host = await HostedRemoteHost.open(
    settings(async () => {
      throw failure();
    }),
    root,
    (message) => output.push(message),
  );
  await host.attach({} as AxlDaemon);
  return { root, host, output };
}

const restores = (output: readonly string[]) =>
  output.filter((line) => line.includes("could not restore the paired session")).length;

async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited > 2_000) throw new Error("timed out waiting for the host");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a /remote that cannot reach the stack says so and goes back to the paired session", async (context) => {
  const offline = () =>
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo EAI_AGAIN stack.example"), {
        code: "EAI_AGAIN",
      }),
    });
  const { root, host, output } = await pairedHost(context, offline);
  assert.equal(restores(output), 1, "the startup restore failed while offline");

  await assert.rejects(host.start(), (error: unknown) => {
    assert.ok(error instanceof RemotePairingStartError);
    assert.equal(
      error.message,
      "Could not reach stack.example. Check the network, then run /remote again.",
    );
    return true;
  });

  // The pairing the failed /remote interrupted is restored again, not left for a restart.
  await until(() => restores(output) === 2);
  assert.match(output.at(-1) ?? "", /could not restore the paired session, retrying in 2 s/u);
  assert.equal(host.status().phase, "paired");
  assert.equal(await readFile(join(root, "host.json"), "utf8"), PAIRED, "nothing was replaced");
});

test("a /remote refused for the account names the reason", async (context) => {
  const refused = () =>
    Object.assign(new Error("The account is not in the remote group"), { code: "not_enabled" });
  const { host } = await pairedHost(context, refused);
  await assert.rejects(host.start(), {
    name: "RemotePairingStartError",
    message: "Remote access is not enabled for this account.",
  });
});

test("a /remote while another daemon serves remote access names that daemon and keeps the pairing", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-remote-host-"));
  let host: HostedRemoteHost | undefined;
  context.after(async () => {
    await host?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  await writeFile(join(root, "host.json"), PAIRED);
  const busy = new RemoteAccessBusyError(4242, "/home/user/.axl/unsafe");
  let opened = 0;
  host = await HostedRemoteHost.open(
    {
      ...settings(async () => undefined),
      claim: async () => {
        throw busy;
      },
      endpoint: async () => {
        opened += 1;
        throw new Error("no endpoint in this test");
      },
    },
    root,
  );
  await host.attach({} as AxlDaemon);
  await assert.rejects(host.start(), {
    name: "RemotePairingStartError",
    message: busy.message,
  });
  assert.equal(opened, 0, "no session was opened while the other daemon held remote access");
  assert.equal(await readFile(join(root, "host.json"), "utf8"), PAIRED, "nothing was replaced");
  assert.match(host.status().lastError?.message ?? "", /another Axl daemon \(process 4242/u);
});

test("a /remote that fails after replacing the pairing does not restore the replaced one", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-remote-host-"));
  let host: HostedRemoteHost | undefined;
  context.after(async () => {
    await host?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  await writeFile(join(root, "host.json"), PAIRED);
  const output: string[] = [];
  host = await HostedRemoteHost.open(
    settings(async () => undefined),
    root,
    (message) => output.push(message),
  );
  await host.attach({} as AxlDaemon);
  await assert.rejects(host.start(), {
    name: "RemotePairingStartError",
    message: /Remote pairing could not start/u,
  });
  // The replaced device was revoked and its session pruned, so nothing is left to restore.
  await assert.rejects(access(join(root, "host.json")));
  assert.equal(host.pairedDevice(), undefined);
  assert.ok(output.some((line) => line.includes("pairing could not start")));
});

test("unpairing forgets the paired device and ends its shares", async (context) => {
  const offline = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const { root, host, output } = await pairedHost(context, offline);
  const deviceId = parseDeviceId("01890a5d-ac96-774b-bcce-b302099a8058");
  assert.equal(
    host.pairedDevice(),
    deviceId,
    "a stored pairing names its device before it is served",
  );
  await host.authority.registerLocalDevice(deviceId, ["observe", "steer"]);
  await host.authority.applyHostedGrant(deviceId, 1, ["observe", "steer"]);
  await host.authority.shareSession(
    deviceId,
    parseSessionId("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
  );

  assert.equal(await host.unpair(), true);
  assert.equal(host.pairedDevice(), undefined);
  assert.deepEqual(host.authority.shares(deviceId), []);
  assert.equal(host.authority.snapshot(deviceId)?.locallyRevoked, true);
  await assert.rejects(access(join(root, "host.json")), "the pairing is not restored again");
  assert.ok(output.some((line) => line.includes("unpaired")));
  const restoresBefore = restores(output);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(restores(output), restoresBefore, "an unpaired host stops retrying its restore");
  assert.equal(await host.unpair(), false);
});

test("a pairing no daemon serves is forgotten on disk, ending its shares", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-remote-forget-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const installationId = parseInstallationId("01890a5d-ac96-774b-bcce-b302099a8057");
  const deviceId = parseDeviceId("01890a5d-ac96-774b-bcce-b302099a8058");
  await writeFile(join(root, "host.json"), PAIRED);
  const before = await RemoteDeviceAuthorityStore.open(root, installationId);
  await before.registerLocalDevice(deviceId, ["observe", "steer"]);
  await before.applyHostedGrant(deviceId, 1, ["observe", "steer"]);
  await before.shareSession(deviceId, parseSessionId("dddddddd-dddd-4ddd-8ddd-dddddddddddd"));

  assert.equal(await HostedRemoteHost.forget(root, installationId), true);
  const after = await RemoteDeviceAuthorityStore.open(root, installationId);
  assert.deepEqual(after.shares(deviceId), []);
  assert.equal(after.snapshot(deviceId)?.locallyRevoked, true);
  await assert.rejects(access(join(root, "host.json")));
  assert.equal(await HostedRemoteHost.forget(root, installationId), false);
});
