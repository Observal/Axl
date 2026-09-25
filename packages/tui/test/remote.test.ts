// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough as NodePassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { AxlDaemon } from "@axl/daemon";
import { type ModelPort, ToolRegistry } from "@axl/kernel";
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

async function openApp(context: TestContext, columns: number) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "axl-tui-remote-")));
  const socketPath = join(directory, "axl.sock");
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    remotePairing: {
      start: async () => ({
        link: LINK,
        cryptoSessionId: "01890a5d-ac96-774b-bcce-b302099a8059",
        deviceId: "01890a5d-ac96-774b-bcce-b302099a8058",
        expiresAt: Date.now() + 10 * 60_000,
      }),
    },
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
  return { input, text: () => stripAnsi(written) };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 5_000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("/remote prints a scannable code above the pairing link", async (context) => {
  const { input, text } = await openApp(context, 100);
  input.write("/remote\r");
  // The finder pattern's top edge: seven dark modules inside the four-module quiet zone.
  await until(() => / {4}█▀{5}█/u.test(text()), "QR code");
  assert.match(text(), /Remote pairing/u);
  assert.doesNotMatch(text(), /Widen the terminal/u);
});

test("/remote explains how to get a code in a narrow terminal", async (context) => {
  const { input, text } = await openApp(context, 80);
  input.write("/remote\r");
  await until(() => text().includes("Remote pairing"), "pairing");
  await until(() => text().includes("Widen the terminal to 93 columns"), "width hint");
  assert.doesNotMatch(text(), /█▀{5}█/u);
});
