// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startWebGateway, type WebGateway } from "@axl/cli";
import { AxlDaemon } from "@axl/daemon";
import { type ModelPort, ToolRegistry } from "@axl/kernel";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const enabled = process.env.AXL_REAL_BROWSER === "1" && existsSync(CHROME);
const model: ModelPort = {
  stream() {
    return (async function* () {
      yield {
        type: "completed" as const,
        stopReason: "stop" as const,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    })();
  },
};

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitFor<Value>(
  read: () => Promise<Value | undefined>,
  label: string,
): Promise<Value> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() - started > 10_000) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
}

async function evaluatePage(port: number): Promise<string> {
  const debuggerUrl = await waitFor(async () => {
    const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
      response.json(),
    )) as Array<{ readonly url?: string; readonly webSocketDebuggerUrl?: string }>;
    return targets.find((target) => target.url?.startsWith("http://127.0.0.1:"))
      ?.webSocketDebuggerUrl;
  }, "Axl browser target");
  const socket = new WebSocket(debuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Chrome debugger failed")), {
      once: true,
    });
  });
  let nextId = 0;
  const pending = new Map<number, (value: unknown) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      readonly id?: number;
      readonly result?: unknown;
    };
    if (message.id !== undefined) {
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
    }
  });
  const command = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<unknown>((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const body = await waitFor(async () => {
    const result = (await command("Runtime.evaluate", {
      expression: "document.body?.innerText ?? ''",
      returnByValue: true,
    })) as { readonly result?: { readonly value?: unknown } };
    const value = result.result?.value;
    return typeof value === "string" &&
      value.includes("Select or create") &&
      value.includes("Sessions") &&
      value.includes("Connected")
      ? value
      : undefined;
  }, "Axl application shell");
  socket.close();
  return body;
}

test(
  "one-use launch URL reaches the Vite shell in a real browser",
  { skip: enabled ? false : "set AXL_REAL_BROWSER=1 on macOS with Google Chrome" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "axl-browser-smoke-"));
    const socketPath = join(directory, "axl.sock");
    const profile = join(directory, "chrome");
    const daemon = new AxlDaemon({
      socketPath,
      dataDirectory: join(directory, "data"),
      runtime: () => ({ model, tools: new ToolRegistry(), system: "You are Axl." }),
    });
    await daemon.start();
    const vitePort = await availablePort();
    const vite = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)),
        "--host",
        "127.0.0.1",
        "--port",
        String(vitePort),
        "--strictPort",
      ],
      { stdio: "ignore" },
    );
    let chrome: ChildProcess | undefined;
    let gateway: WebGateway | undefined;
    try {
      await waitFor(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${vitePort}/__axl_dev__/`);
          return response.ok ? true : undefined;
        } catch {
          return undefined;
        }
      }, "Vite");
      gateway = await startWebGateway({
        socketPath,
        viteUrl: `http://127.0.0.1:${vitePort}`,
      });
      chrome = spawn(
        CHROME,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-first-run",
          "--remote-debugging-port=0",
          `--user-data-dir=${profile}`,
          gateway.launchUrl,
        ],
        { stdio: "ignore" },
      );
      const debuggerPort = await waitFor(async () => {
        try {
          const text = await readFile(join(profile, "DevToolsActivePort"), "utf8");
          const port = Number(text.split("\n", 1)[0]);
          return Number.isSafeInteger(port) ? port : undefined;
        } catch {
          return undefined;
        }
      }, "Chrome debugger");
      const body = await evaluatePage(debuggerPort);
      assert.match(body, /Axl\s*Connected/);
      assert.match(body, /Sessions/);
    } finally {
      await gateway?.close();
      await Promise.all([...(chrome === undefined ? [] : [stopChild(chrome)]), stopChild(vite)]);
      await daemon.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
