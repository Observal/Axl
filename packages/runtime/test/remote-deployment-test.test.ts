// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AxlDaemon } from "@axl/daemon";
import { parseInstallationId } from "@axl/protocol";

import {
  type DeploymentTestRemoteConfig,
  DeploymentTestRemoteHost,
} from "../src/remote-deployment-test.ts";

function config(directory: string): DeploymentTestRemoteConfig {
  return {
    origin: "https://stack.invalid",
    pagePath: "/remote/",
    accountId: "0f0e0d0c-0b0a-4908-8706-050403020100",
    installationId: parseInstallationId("01890a5d-ac96-774b-bcce-b302099a8057"),
    accessToken: "test-token",
    phoneSignIn: false,
    possessionProof: new Uint8Array(48),
    // No binding exists here, so restoring the paired session fails the way an outage would.
    binding: join(directory, "missing-binding.js"),
  };
}

test("an unpaired host reports its phase and log without touching the network", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-remote-host-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const host = await DeploymentTestRemoteHost.open(config(directory), directory);
  context.after(() => host.close());
  await host.attach({} as AxlDaemon);
  const status = host.status();
  assert.equal(status.phase, "unpaired");
  assert.equal(status.relay, "disconnected");
  assert.equal(status.deviceOnline, false);
  assert.equal(status.lastError, undefined);
  assert.equal(status.logPath, join(directory, "remote-deployment-test", "remote.log"));
});

test("a paired session that cannot be restored is retried and reported", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-remote-host-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "remote-deployment-test");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "host.json"),
    JSON.stringify({
      version: 2,
      cryptoSessionId: "01890a5d-ac96-774b-bcce-b302099a8059",
      deviceId: "01890a5d-ac96-774b-bcce-b302099a8058",
      phase: "paired",
    }),
  );
  const output: string[] = [];
  const host = await DeploymentTestRemoteHost.open(config(directory), directory, (message) =>
    output.push(message),
  );
  await host.attach({} as AxlDaemon);

  const status = host.status();
  assert.equal(status.phase, "paired", "a pending restore still counts as paired");
  assert.equal(status.relay, "disconnected");
  assert.match(status.lastError?.message ?? "", /could not restore the paired session, retrying/u);
  assert.match(
    status.lastError?.message ?? "",
    /\(ERR_MODULE_NOT_FOUND\)/u,
    "the log keeps the code",
  );
  assert.match(output.join("\n"), /retrying in 2 s/u);

  await host.close();
  const log = await readFile(status.logPath ?? "", "utf8");
  assert.match(log, /^\d{4}-\d{2}-\d{2}T.* remote: could not restore/mu);
  if (process.platform !== "win32") {
    assert.equal((await stat(status.logPath ?? "")).mode & 0o777, 0o600);
  }
});
