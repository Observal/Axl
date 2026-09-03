// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { AxlDaemon, DaemonClient } from "@axl/daemon";
import { type ModelPort, ToolRegistry } from "@axl/kernel";
import { MAX_CANONICAL_EVENT_BYTES, type ModelStreamEvent } from "@axl/protocol";

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
  const deadline = Date.now() + 30_000;
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

async function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, [entry, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const code = await new Promise<number | null>((resolvePromise) =>
    child.once("exit", (value) => resolvePromise(value)),
  );
  return { code, stdout, stderr };
}

test("offline raw session export requires explicit raw mode and preserves bytes", async (context) => {
  const home = await temporaryDirectory(context);
  const sessionId = "00000000-0000-4000-8000-000000000401";
  const sessions = join(home, ".axl", "sessions");
  await mkdir(sessions, { recursive: true });
  const source = Buffer.from('{"unknown":"legacy bytes"}\n');
  await writeFile(join(sessions, `${sessionId}.jsonl`), source);
  const output = join(home, "raw-export");

  const missingRaw = await runCli(["session", "export", sessionId, "--output", output], {
    ...process.env,
    HOME: home,
  });
  assert.equal(missingRaw.code, 1);
  assert.match(missingRaw.stderr, /requires --raw/);

  const exported = await runCli(["session", "export", sessionId, "--raw", "--output", output], {
    ...process.env,
    HOME: home,
  });
  assert.equal(exported.code, 0, exported.stderr);
  assert.deepEqual(await readFile(join(output, `${sessionId}.jsonl`)), source);
});

test("offline migration requires explicit confirmation before prefix recovery", async (context) => {
  const home = await temporaryDirectory(context);
  const sessionId = "00000000-0000-4000-8000-000000000402";
  const sessions = join(home, ".axl", "sessions");
  await mkdir(sessions, { recursive: true });
  const rootId = "00000000-0000-4000-8000-000000000403";
  const root = {
    version: 1,
    id: rootId,
    sessionId,
    parentId: null,
    timestamp: 1,
    type: "session.created",
    payload: { cwd: "/workspace" },
  };
  const oversized = {
    version: 1,
    id: "00000000-0000-4000-8000-000000000404",
    sessionId,
    parentId: rootId,
    timestamp: 2,
    type: "prompt.section",
    payload: {
      name: "legacy",
      source: "test",
      content: "é".repeat(MAX_CANONICAL_EVENT_BYTES),
    },
  };
  const sourcePath = join(sessions, `${sessionId}.jsonl`);
  const source = Buffer.from(`${JSON.stringify(root)}\n${JSON.stringify(oversized)}\n`);
  await writeFile(sourcePath, source);
  const env = { ...process.env, HOME: home };

  const refused = await runCli(["session", "migrate-events", sessionId], env);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--confirm-prefix/);
  assert.deepEqual(await readFile(sourcePath), source);

  const recovered = await runCli(["session", "migrate-events", sessionId, "--confirm-prefix"], env);
  assert.equal(recovered.code, 0, recovered.stderr);
  const manifest = JSON.parse(recovered.stdout) as {
    targetSessionId: string;
    recovery: string;
  };
  assert.equal(manifest.recovery, "prefix_only");
  await stat(join(sessions, `${manifest.targetSessionId}.jsonl`));
  assert.deepEqual(await readFile(sourcePath), source);
});

test("OCI CLI arguments fail closed", async () => {
  const missingImage = await runCli(["--sandbox", "podman"]);
  assert.equal(missingImage.code, 1);
  assert.match(missingImage.stderr, /requires --image with a sha256 digest/);
  const unsafeOci = await runCli([
    "--unsafe",
    "--sandbox",
    "docker",
    "--image",
    "example.invalid/image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ]);
  assert.equal(unsafeOci.code, 1);
  assert.match(unsafeOci.stderr, /--unsafe cannot be combined/);
});

test("doctor reports native, Podman, and Docker capabilities without credentials", async () => {
  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, [entry, "doctor"], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolvePromise) =>
    child.once("exit", (code) => resolvePromise(code)),
  );
  assert.equal(exitCode, 0, stderr);
  const report = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(typeof report.native, "object");
  assert.equal(typeof report.podman, "object");
  assert.equal(typeof report.docker, "object");
});

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
  assert.deepEqual(await client.request("daemon.info", {}), {
    securityMode: "unsafe",
    sandboxProvider: "none",
  });

  const created = await client.request("session.create", { cwd: workspace });
  const subscription = await client.request("session.subscribe", {
    sessionId: created.sessionId,
  });
  assert.ok(subscription.snapshot?.page.complete);
  const events = subscription.snapshot.page.events;
  await client.request("session.ack", {
    subscriptionId: subscription.subscriptionId,
    cursor: subscription.snapshot.boundaryCursor,
  });
  const sandbox = events.find((event) => event.type === "sandbox.configured");
  assert.equal(sandbox?.type === "sandbox.configured" && sandbox.payload.enforced, false);
  assert.equal(sandbox?.type === "sandbox.configured" && sandbox.payload.provider, "none");
  const constraints = events.filter(
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

test("clients refuse a different OCI engine or image", async (context) => {
  const directory = await temporaryDirectory(context);
  const socketPath = join(directory, "axl.sock");
  const firstImage = `example.invalid/image@sha256:${"a".repeat(64)}`;
  const secondImage = `example.invalid/image@sha256:${"b".repeat(64)}`;
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    securityMode: "sandboxed",
    sandboxProvider: "podman",
    sandboxImage: firstImage,
    runtime: () => ({ model: idleModel, tools: new ToolRegistry() }),
  });
  await daemon.start();
  context.after(() => daemon.stop());

  for (const args of [
    ["--sandbox", "docker", "--image", firstImage],
    ["--sandbox", "podman", "--image", secondImage],
  ]) {
    const result = await runCli([...args, "--socket", socketPath]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Daemon security mode is sandboxed\/podman/);
  }
});
