// SPDX-FileCopyrightText: 2026 PranavD2905
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { AxlDaemon } from "@axl/daemon";
import { type ModelPort, ToolRegistry } from "@axl/kernel";
import type { ModelStreamEvent } from "@axl/protocol";
import { connectUnixClient } from "@axl/sdk/unix";

const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));

async function temporaryDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "axl-run-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, [entry, ...args], {
    env,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (input !== undefined) child.stdin?.end(input);
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

test("help lists run -p as the print alias", () => {
  const help = spawnSync(process.execPath, [entry, "run", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: axl/);
  assert.match(help.stdout, /axl run -p \[prompt\] \[options\]\s+Same as axl print/);
});

test("run -p matches print and rejects other run invocations before creating a session", async (context) => {
  const directory = await temporaryDirectory(context);
  const workspace = join(directory, "workspace");
  const socketPath = join(directory, "axl.sock");
  await mkdir(workspace);
  const prompts: string[] = [];
  const model: ModelPort = {
    stream(request) {
      const user = request.messages.findLast((message) => message.role === "user");
      const prompt =
        user?.role === "user"
          ? user.content
              .filter((content) => content.type === "text")
              .map((content) => content.text)
              .join("")
          : "";
      prompts.push(prompt);
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (prompt.includes("fail")) {
          yield {
            type: "error",
            code: "test_failure",
            message: "deterministic failure",
            retryable: false,
          };
          return;
        }
        yield { type: "text_delta", text: `echo: ${prompt}` };
        yield {
          type: "completed",
          stopReason: "stop",
          usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      })();
    },
  };
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    securityMode: "sandboxed",
    runtime: () => ({ model, tools: new ToolRegistry() }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  const env = { ...process.env, HOME: directory };
  const target = ["--cwd", workspace, "--socket", socketPath];
  const sessionCount = async (): Promise<number> => {
    const client = await connectUnixClient(socketPath);
    try {
      const listed = await client.request("session.list", {
        scope: "all_local",
        order: "recent",
        pageSize: 50,
      });
      return listed.sessions.length;
    } finally {
      client.close();
    }
  };

  for (const args of [
    ["run"],
    ["run", "hello"],
    ["run", "-p", "hello", "--json"],
    ["run", "-p", "hello", "--resume"],
    ["run", "-p", "hello", "--theme", "dark"],
  ]) {
    const result = await runCli([...args, ...target], env, "");
    assert.equal(result.code, 1, args.join(" "));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^axl: (run requires -p|Unsupported run option)/);
  }
  assert.equal(await sessionCount(), 0);
  assert.deepEqual(prompts, []);

  const printed = await runCli(["print", "Summarize", "this", ...target], env, "piped input\n");
  const run = await runCli(["run", "-p", "Summarize", "this", ...target], env, "piped input\n");
  assert.equal(printed.code, 0, printed.stderr);
  assert.deepEqual(run, printed);
  assert.equal(run.stdout, "echo: Summarize this\n\npiped input\n");

  const stdinOnly = await runCli(["run", "-p", ...target], env, "from stdin");
  assert.deepEqual(stdinOnly, await runCli(["print", ...target], env, "from stdin"));
  assert.equal(stdinOnly.stdout, "echo: from stdin\n");

  const keywordPrompt = await runCli(["run", "-p", "json", "models", ...target], env);
  assert.deepEqual(keywordPrompt, await runCli(["print", ...target, "--", "json", "models"], env));
  assert.equal(prompts.at(-1), "json models");

  const failedPrint = await runCli(["print", "please", "fail", ...target], env);
  const failedRun = await runCli(["run", "-p", "please", "fail", ...target], env);
  assert.equal(failedPrint.code, 1);
  assert.deepEqual(failedRun, failedPrint);

  const empty = await runCli(["run", "-p", ...target], env, "");
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /print requires a prompt argument or piped stdin/);
});
