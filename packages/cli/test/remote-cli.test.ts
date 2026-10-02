// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RemoteDeviceAuthorityStore } from "@axl/daemon";
import { parseDeviceId, parseInstallationId, parseSessionId } from "@axl/protocol";
import { remoteAccountPath } from "@axl/runtime";

import { runRemoteCommand } from "../src/remote-cli.ts";

const accountId = "0f0e0d0c-0b0a-4908-8706-050403020100";
const installationId = parseInstallationId("01890a5d-ac96-774b-bcce-b302099a8057");
const deviceId = parseDeviceId("01890a5d-ac96-774b-bcce-b302099a8058");

test("signing out with no daemon running removes the paired phone and its shares", async (context) => {
  const axlHome = await mkdtemp(join(tmpdir(), "axl-remote-logout-"));
  context.after(() => rm(axlHome, { recursive: true, force: true }));
  await mkdir(join(axlHome, "remote"), { recursive: true });
  await writeFile(
    remoteAccountPath(axlHome),
    JSON.stringify({
      version: 1,
      origin: "https://stack.example",
      pagePath: "/remote/",
      authority: "https://auth.stack.example",
      clientId: "client",
      accountId,
      email: "person@example.com",
      installationId,
      helper: join(axlHome, "missing-helper.exe"),
      binding: join(axlHome, "missing-binding.js"),
      refreshToken: "c2VhbGVk",
      installationKey: "c2VhbGVk",
    }),
  );
  // A pairing under the native daemon's state directory, which is the Axl home itself.
  const root = join(axlHome, "remote", `${accountId}.${installationId}`);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "host.json"),
    JSON.stringify({
      version: 2,
      cryptoSessionId: "01890a5d-ac96-774b-bcce-b302099a8059",
      deviceId,
      phase: "paired",
    }),
  );
  const authority = await RemoteDeviceAuthorityStore.open(root, installationId);
  await authority.registerLocalDevice(deviceId, ["observe", "steer"]);
  await authority.applyHostedGrant(deviceId, 1, ["observe", "steer"]);
  await authority.shareSession(deviceId, parseSessionId("dddddddd-dddd-4ddd-8ddd-dddddddddddd"));

  let output = "";
  await runRemoteCommand(["logout"], axlHome, (text) => {
    output += text;
  });

  assert.match(output, /Removed the paired phone/u);
  assert.match(output, /Signed out person@example\.com/u);
  const after = await RemoteDeviceAuthorityStore.open(root, installationId);
  assert.deepEqual(after.shares(deviceId), []);
  assert.equal(after.snapshot(deviceId)?.locallyRevoked, true);
  await assert.rejects(access(join(root, "host.json")));
  await assert.rejects(access(remoteAccountPath(axlHome)));
});
