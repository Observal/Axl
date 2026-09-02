// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { AxlDaemon, DaemonClient, type SessionSnapshot } from "@axl/daemon";
import { type ModelPort, ToolRegistry } from "@axl/kernel";
import type { ModelStreamEvent } from "@axl/protocol";

const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));

test("--help and --version do not require credentials", () => {
  const help = spawnSync(process.execPath, [entry, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: axl/);

  const version = spawnSync(process.execPath, [entry, "--version"], { encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.equal(version.stdout, "axl 0.0.0-dev\n");
});

async function temporaryDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "axl-unsafe-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function connectEventually(socketPath: string, child: ChildProcess): Promise<DaemonClient> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`daemon exited with ${child.exitCode}`);
    try {
      return await DaemonClient.connect(socketPath);
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  }
  throw new Error("unsafe daemon did not become ready", { cause: lastError });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
}

test("--unsafe starts a separate unenforced daemon and records the warning state", async (context) => {
  const home = await temporaryDirectory(context);
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  let stderr = "";
  const child = spawn(process.execPath, [entry, "daemon", "--unsafe"], {
    env: {
      ...process.env,
      HOME: home,
      AZURE_OPENAI_API_KEY: "obviously-fake-test-key",
      AZURE_OPENAI_BASE_URL: "https://example.invalid/",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  context.after(() => stopChild(child));

  const stateDirectory = join(home, ".axl", "unsafe");
  const socketPath = join(stateDirectory, "axl.sock");
  const client = await connectEventually(socketPath, child);
  context.after(() => client.close());
  assert.deepEqual(await client.request("daemon.info", {}), { securityMode: "unsafe" });

  const created = (await client.request("session.create", { cwd: workspace })) as SessionSnapshot;
  const sandbox = created.events.find((event) => event.type === "sandbox.configured");
  assert.equal(sandbox?.type === "sandbox.configured" && sandbox.payload.enforced, false);
  assert.equal(sandbox?.type === "sandbox.configured" && sandbox.payload.provider, "none");
  const constraints = created.events.filter(
    (event) => event.type === "prompt.section" && event.payload.name === "constraints",
  );
  assert.equal(
    constraints.some(
      (event) =>
        event.type === "prompt.section" && event.payload.content.includes("full host access"),
    ),
    true,
  );
  await stat(join(stateDirectory, "sessions", `${created.sessionId}.jsonl`));
  assert.match(stderr, /WARNING: --unsafe disables operating-system isolation/);
  await stopChild(child);
});

const idleModel: ModelPort = {
  stream() {
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield {
        type: "completed",
        stopReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    })();
  },
};

async function expectModeMismatch(
  context: TestContext,
  daemonMode: "sandboxed" | "unsafe",
  clientUnsafe: boolean,
  expected: RegExp,
): Promise<void> {
  const directory = await temporaryDirectory(context);
  const socketPath = join(directory, "axl.sock");
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    securityMode: daemonMode,
    runtime: () => ({ model: idleModel, tools: new ToolRegistry() }),
  });
  await daemon.start();
  context.after(() => daemon.stop());

  let stderr = "";
  const child = spawn(
    process.execPath,
    [entry, ...(clientUnsafe ? ["--unsafe"] : []), "--socket", socketPath],
    {
      env: { ...process.env, HOME: directory },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolvePromise) =>
    child.once("exit", (code) => resolvePromise(code)),
  );
  assert.equal(exitCode, 1);
  assert.match(stderr, expected);
}

test("clients refuse a daemon with the opposite security mode", async (context) => {
  await expectModeMismatch(
    context,
    "sandboxed",
    true,
    /Daemon security mode is sandboxed; unsafe was requested/,
  );
  await expectModeMismatch(
    context,
    "unsafe",
    false,
    /Daemon security mode is unsafe; sandboxed was requested/,
  );
});
