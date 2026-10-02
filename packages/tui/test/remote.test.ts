// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough as NodePassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { AxlDaemon, RemoteDeviceAuthorityStore } from "@axl/daemon";
import { type ModelPort, ToolRegistry } from "@axl/kernel";
import { type DeviceId, parseDeviceId, parseInstallationId } from "@axl/protocol";
import { connectUnixClient } from "@axl/sdk/unix";

import { AxlApp, stripAnsi } from "../src/index.ts";

class PassThrough extends NodePassThrough {
  isTTY = true;
  isRaw = false;
  columns = 100;
  rows = 40;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}

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

// A pairing link shaped like the real one: 671 characters, a version 18 code.
const LINK = `https://stack.example/remote/#v=1&i=${"A".repeat(401)}&a=${"B".repeat(22)}&n=${"C".repeat(22)}&d=${"D".repeat(22)}&s=${"E".repeat(22)}&t=${"F".repeat(64)}&p=${"G".repeat(64)}`;

// A short link, as `/remote` prints once the control plane parks the full one.
const SHORT_LINK = `https://remote.example/remote/#p=${"H".repeat(22)}.${"I".repeat(43)}`;

const DEVICE = parseDeviceId("01890a5d-ac96-774b-bcce-b302099a8058");

async function openApp(
  context: TestContext,
  columns: number,
  link = LINK,
  remote = true,
  paired = false,
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "axl-tui-remote-")));
  const socketPath = join(directory, "axl.sock");
  const dataDirectory = join(directory, "data");
  const authority = await RemoteDeviceAuthorityStore.open(
    dataDirectory,
    parseInstallationId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  );
  let device: DeviceId | undefined;
  if (paired) {
    await authority.registerLocalDevice(DEVICE, ["observe", "steer"]);
    await authority.applyHostedGrant(DEVICE, 1, ["observe", "steer"]);
    device = DEVICE;
  }
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory,
    // Without a remote host the daemon does not grant pairing.
    ...(remote
      ? {
          remoteAuthority: authority,
          remotePairing: {
            pairedDevice: () => device,
            unpair: async () => {
              if (device === undefined) return false;
              await authority.revokeLocalDevice(device);
              device = undefined;
              return true;
            },
            start: async () => ({
              link,
              cryptoSessionId: "01890a5d-ac96-774b-bcce-b302099a8059",
              deviceId: "01890a5d-ac96-774b-bcce-b302099a8058",
              expiresAt: Date.now() + 10 * 60_000,
            }),
            status: () => ({
              phase: "paired",
              relay: "reconnecting",
              deviceOnline: false,
              witness: "ready",
              lastError: { message: "remote: relay stopped answering", at: Date.now() },
              logPath: join(directory, "remote.log"),
            }),
          },
        }
      : {}),
    runtime: async () => ({ model, tools: new ToolRegistry() }),
  });
  await daemon.start();
  context.after(async () => {
    await daemon.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = columns;
  let written = "";
  output.on("data", (chunk: Buffer) => {
    written += chunk.toString("utf8");
  });
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });
  context.after(() => app.stop());
  return { input, authority, text: () => stripAnsi(written) };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 5_000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("/remote frames a short link's code beside what to do with it", async (context) => {
  const { input, text } = await openApp(context, 100, SHORT_LINK);
  input.write("/remote\r");
  // The finder pattern's top edge, inside the frame and the four-module quiet zone.
  await until(() => /│ {5}█▀{5}█/u.test(text()), "framed QR code");
  assert.match(text(), /╭─ Remote ─+╮/u);
  assert.match(text(), /Pair a phone/u);
  assert.match(text(), /\/remote status/u);
  const lines = text().replaceAll("\r", "").split("\n");
  assert.ok(lines.includes(SHORT_LINK), "the link has a line of its own");
  const top = lines.findIndex((line) => line.includes("╭─ Remote"));
  const bottom = lines.findIndex((line, index) => index > top && line.startsWith("╰"));
  const frame = lines.slice(top + 1, bottom);
  assert.ok(frame.length <= 26, `a short link's code stays small (${frame.length} rows)`);
  assert.ok(
    frame.every((line) => line.startsWith("│") && line.length === frame[0]?.length),
    "every framed row has the same width",
  );
});

test("/remote stacks a long link's code under the heading", async (context) => {
  const { input, text } = await openApp(context, 100);
  input.write("/remote\r");
  await until(() => / {4}█▀{5}█/u.test(text()), "QR code");
  assert.match(text(), /Pair a phone/u);
  assert.doesNotMatch(text(), /╭─ Remote/u);
  assert.doesNotMatch(text(), /Widen the terminal/u);
});

test("/remote explains how to get a code in a narrow terminal", async (context) => {
  const { input, text } = await openApp(context, 80);
  input.write("/remote\r");
  await until(() => text().includes("Pair a phone"), "pairing");
  await until(() => text().includes("Widen the terminal to 93 columns"), "width hint");
  assert.doesNotMatch(text(), /█▀{5}█/u);
});

test("/remote status shows the pairing, relay, phone, and latest failure", async (context) => {
  const { input, text } = await openApp(context, 100);
  input.write("/remote status\r");
  await until(() => text().includes("Remote status"), "status");
  await until(() => text().includes("remote.log"), "log path");
  assert.match(text(), /Pairing {2}paired/u);
  assert.match(text(), /Relay {4}reconnecting/u);
  assert.match(text(), /Phone {4}offline/u);
  assert.match(text(), /relay stopped answering/u);
  assert.doesNotMatch(text(), /Pair a phone/u, "status never starts a new pairing");
});

test("/remote on a daemon without remote access says how to set it up", async (context) => {
  const { input, text } = await openApp(context, 100, LINK, false);
  input.write("/remote\r");
  await until(() => text().includes("axl remote login"), "setup hint");
});

test("/remote shares the session with a paired phone without a new code", async (context) => {
  const { input, authority, text } = await openApp(context, 100, SHORT_LINK, true, true);
  input.write("/remote\r");
  await until(() => text().includes("shared with your phone"), "share notice");
  assert.doesNotMatch(text(), /Pair a phone/u, "a paired phone needs no new code");
  assert.equal(authority.shares(DEVICE).length, 1);

  input.write("/remote status\r");
  await until(() => text().includes("including this one"), "shared row");

  input.write("/remote stop\r");
  await until(() => text().includes("stopped sharing this session"), "stop notice");
  assert.deepEqual(authority.shares(DEVICE), []);
  input.write("/remote stop\r");
  await until(() => text().includes("this session is not shared"), "nothing to stop");

  input.write("/remote\r");
  await until(() => authority.shares(DEVICE).length === 1, "shared again");
  input.write("/remote unpair\r");
  await until(() => text().includes("phone removed"), "unpair notice");
  assert.deepEqual(authority.shares(DEVICE), []);
});

test("/remote pair shows a new code even with a paired phone", async (context) => {
  const { input, text } = await openApp(context, 100, SHORT_LINK, true, true);
  input.write("/remote pair\r");
  await until(() => text().includes("Pair a phone"), "pairing");
});
