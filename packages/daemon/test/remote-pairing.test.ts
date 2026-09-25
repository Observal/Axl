// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { ModelPort } from "@axl/kernel";
import { ToolRegistry } from "@axl/kernel";
import type { RemotePairingStartResult } from "@axl/protocol";
import { AxlClientError } from "@axl/sdk";
import { connectUnixClient } from "@axl/sdk/unix";

import { AxlDaemon, type RemotePairingService, requiredRemoteScope } from "../src/index.ts";

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

async function start(context: TestContext, remotePairing?: RemotePairingService) {
  const directory = await mkdtemp(join(tmpdir(), "axl-remote-pairing-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "axl.sock");
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    ...(remotePairing === undefined ? {} : { remotePairing }),
    runtime: async () => ({ model, tools: new ToolRegistry() }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());
  return client;
}

test("grants remote pairing only when the daemon hosts it", async (context) => {
  const without = await start(context);
  assert.equal(without.connection.grantedCapabilities.includes("remote.pairing.start"), false);
  await assert.rejects(
    without.startRemotePairing(),
    (error) => error instanceof AxlClientError && error.code === "unsupported_capability",
  );

  let calls = 0;
  const hosted = await start(context, {
    start: async () => {
      calls += 1;
      return pairing;
    },
  });
  assert.equal(hosted.connection.grantedCapabilities.includes("remote.pairing.start"), true);
  assert.deepEqual(await hosted.startRemotePairing(), pairing);
  assert.equal(calls, 1);
});

test("reports a failed pairing start as remote_unavailable", async (context) => {
  const client = await start(context, {
    start: async () => {
      throw new Error("witness down: secret-detail");
    },
  });
  await assert.rejects(client.startRemotePairing(), (error) => {
    assert.ok(error instanceof AxlClientError);
    assert.equal(error.code, "remote_unavailable");
    assert.doesNotMatch(error.message, /secret-detail/u);
    return true;
  });
});

test("remote devices cannot start another pairing", () => {
  assert.equal(requiredRemoteScope("remote.pairing.start"), undefined);
});

test("remote devices reopen closed sessions only with steer", () => {
  assert.equal(requiredRemoteScope("session.resume"), "steer");
});
