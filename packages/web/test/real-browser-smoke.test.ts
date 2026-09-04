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
const CDP_COMMAND_TIMEOUT_MS = 3_000;
const CHILD_SHUTDOWN_TIMEOUT_MS = 2_000;
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
  let resolveExit: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
    child.once("exit", resolve);
  });
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, CHILD_SHUTDOWN_TIMEOUT_MS)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, CHILD_SHUTDOWN_TIMEOUT_MS)),
    ]);
  }
  child.removeListener("exit", resolveExit);
}

class CdpCommandError extends Error {
  readonly code: number;

  constructor(method: string, code: number, message: string) {
    super(`CDP ${method} failed (${code}): ${message}`);
    this.name = "CdpCommandError";
    this.code = code;
  }
}

type PendingCommand = {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

function isAuthenticatedDevTarget(value: string | undefined, origin: string): boolean {
  if (value === undefined) return false;
  try {
    const url = new URL(value);
    return url.origin === origin && /^\/_axl\/[0-9a-f]{32}\/dev\//.test(url.pathname);
  } catch {
    return false;
  }
}

function isNavigationTransition(error: unknown): boolean {
  return (
    error instanceof CdpCommandError &&
    (error.code === -32000 || /context|navigat|target/i.test(error.message))
  );
}

async function evaluatePage(port: number, origin: string): Promise<string> {
  const debuggerUrl = await waitFor(async () => {
    const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
      response.json(),
    )) as Array<{ readonly url?: string; readonly webSocketDebuggerUrl?: string }>;
    return targets.find((target) => isAuthenticatedDevTarget(target.url, origin))
      ?.webSocketDebuggerUrl;
  }, "final authenticated Axl browser target");
  const socket = new WebSocket(debuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out opening the Chrome debugger")),
      CDP_COMMAND_TIMEOUT_MS,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("Chrome debugger failed"));
      },
      { once: true },
    );
  });
  let nextId = 0;
  const pending = new Map<number, PendingCommand>();
  const rejectPending = (error: Error): void => {
    for (const command of pending.values()) {
      clearTimeout(command.timer);
      command.reject(error);
    }
    pending.clear();
  };
  socket.addEventListener("close", () => rejectPending(new Error("Chrome debugger closed")));
  socket.addEventListener("message", (event) => {
    let message: {
      readonly id?: number;
      readonly result?: unknown;
      readonly error?: { readonly code?: unknown; readonly message?: unknown };
    };
    try {
      message = JSON.parse(String(event.data)) as typeof message;
    } catch {
      rejectPending(new Error("Chrome debugger returned invalid JSON"));
      return;
    }
    if (message.id === undefined) return;
    const command = pending.get(message.id);
    if (command === undefined) return;
    clearTimeout(command.timer);
    pending.delete(message.id);
    if (message.error !== undefined) {
      command.reject(
        new CdpCommandError(
          command.method,
          typeof message.error.code === "number" ? message.error.code : -1,
          typeof message.error.message === "string" ? message.error.message : "unknown error",
        ),
      );
    } else if (!("result" in message)) {
      command.reject(new Error(`CDP ${command.method} returned neither result nor error`));
    } else {
      command.resolve(message.result);
    }
  });
  const command = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for CDP ${method}`));
      }, CDP_COMMAND_TIMEOUT_MS);
      pending.set(id, { method, resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  try {
    await command("Runtime.enable");
    const body = await waitFor(async () => {
      try {
        const response = await command("Runtime.evaluate", {
          expression: "document.body?.innerText ?? ''",
          returnByValue: true,
        });
        if (typeof response !== "object" || response === null || !("result" in response)) {
          throw new Error("CDP Runtime.evaluate returned an invalid result");
        }
        const remote = (response as { readonly result: { readonly value?: unknown } }).result;
        const value = remote.value;
        return typeof value === "string" &&
          value.includes("Select or create") &&
          value.includes("Sessions") &&
          value.includes("Connected")
          ? value
          : undefined;
      } catch (error) {
        if (isNavigationTransition(error)) return undefined;
        throw error;
      }
    }, "stable Axl application execution context");
    return body;
  } finally {
    rejectPending(new Error("Chrome debugger test completed"));
    socket.close();
  }
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
      const body = await evaluatePage(debuggerPort, gateway.origin);
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
