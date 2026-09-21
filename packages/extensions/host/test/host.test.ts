// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { CompositeCapabilityService, ToolRegistry } from "@axl/kernel";
import type { CanonicalEvent } from "@axl/protocol";

import {
  DAEMON_EXTENSION_AUTHORITY,
  DaemonExtensionError,
  type DaemonExtensionFailure,
  discoverDaemonExtensions,
  loadDaemonExtensions,
} from "../src/index.ts";

async function directory(context: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "axl-daemon-extensions-"));
  context.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function load(dir: string, tools = new ToolRegistry()) {
  const failures: DaemonExtensionFailure[] = [];
  const loaded = await loadDaemonExtensions({
    directory: dir,
    cwd: "/workspace",
    tools,
    grantedAuthorities: new Set([DAEMON_EXTENSION_AUTHORITY]),
    onFailure: (failure) => failures.push(failure),
  });
  return { ...loaded, tools, failures };
}

test("a missing directory loads no extensions", async (context) => {
  const dir = join(await directory(context), "absent");
  assert.deepEqual(await discoverDaemonExtensions(dir), []);
  const { host, source } = await load(dir);
  assert.equal(host.beforeToolCall, undefined);
  assert.equal(host.observe, undefined);
  assert.deepEqual(source.records, []);
});

test("discovers files and index directories in name order and skips other entries", async (context) => {
  const dir = await directory(context);
  await writeFile(join(dir, "zeta.ts"), "export default () => {};\n");
  await mkdir(join(dir, "alpha"));
  await writeFile(join(dir, "alpha", "index.js"), "export default () => {};\n");
  await writeFile(join(dir, "notes.md"), "ignored\n");
  await writeFile(join(dir, ".hidden.ts"), "export default () => { throw new Error('no'); };\n");
  const discovered = await discoverDaemonExtensions(dir);
  assert.deepEqual(
    discovered.map((extension) => extension.id),
    ["alpha", "zeta"],
  );
});

test("registers TypeScript extension tools into the capability index and runs them", async (context) => {
  const dir = await directory(context);
  await writeFile(
    join(dir, "greeter.ts"),
    `import type { DaemonExtensionApi } from "@axl/extension-api";
export default function (axl: DaemonExtensionApi): void {
  axl.registerTool({
    name: "greet",
    description: "Greets a person by name",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    execute: (input: Readonly<Record<string, unknown>>) => ({
      content: [{ type: "text", text: "hello " + String(input.name) + " from " + axl.cwd }],
    }),
  });
}
`,
  );
  const { tools, source, extensions } = await load(dir);
  assert.deepEqual(
    extensions.map((extension) => [extension.id, extension.tools]),
    [["greeter", ["greet"]]],
  );
  assert.equal(source.records[0]?.identity, "extension:greeter/greet");
  assert.deepEqual(source.records[0]?.requiredAuthority, [DAEMON_EXTENSION_AUTHORITY]);

  // Hidden until activated, then callable under its canonical name.
  assert.equal(tools.get("greet"), undefined);
  const catalog = new CompositeCapabilityService([source], new Set([DAEMON_EXTENSION_AUTHORITY]));
  const found = await catalog.search("greet person", 5);
  assert.equal(found.results[0]?.identity, "extension:greeter/greet");
  const activation = await catalog.activate(["extension:greeter/greet"]);
  assert.equal(activation.activated.length, 1);
  assert.ok(tools.activateCapability("extension:greeter/greet"));
  const result = await tools.get("greet")?.execute({ name: "Ada" }, new AbortController().signal);
  assert.deepEqual(result, {
    content: [{ type: "text", text: "hello Ada from /workspace" }],
    isError: false,
  });
});

test("tool.call handlers block in load order, prefix the extension id, and fail closed", async (context) => {
  const dir = await directory(context);
  await writeFile(
    join(dir, "a-allow.js"),
    `export default (axl) => { axl.on("tool.call", () => undefined); };\n`,
  );
  await writeFile(
    join(dir, "b-block.js"),
    `export default (axl) => {
  axl.on("tool.call", (event) => {
    if (event.name === "bash" && String(event.input.command).includes("rm -rf")) {
      return { block: true, reason: "destructive command" };
    }
  });
};
`,
  );
  await writeFile(
    join(dir, "c-throw.js"),
    `export default (axl) => {
  axl.on("tool.call", (event) => {
    if (event.name === "boom") throw new Error("handler bug");
  });
};
`,
  );
  const { host } = await load(dir);
  const signal = new AbortController().signal;
  assert.equal(
    await host.beforeToolCall?.({ callId: "1", name: "read", input: { path: "x" } }, signal),
    undefined,
  );
  assert.deepEqual(
    await host.beforeToolCall?.(
      { callId: "2", name: "bash", input: { command: "rm -rf /" } },
      signal,
    ),
    { block: true, reason: "b-block: destructive command" },
  );
  await assert.rejects(
    async () => host.beforeToolCall?.({ callId: "3", name: "boom", input: {} }, signal),
    (error: unknown) => error instanceof DaemonExtensionError && /handler bug/.test(error.message),
  );
});

test("session.event observers receive projected events and their failures are reported", async (context) => {
  const dir = await directory(context);
  await writeFile(
    join(dir, "watch.js"),
    `export default (axl) => {
  globalThis.__axlObserved = [];
  axl.on("session.event", (event) => {
    globalThis.__axlObserved.push(event.type);
    event.payload.mutated = true;
    if (event.type === "bad") throw new Error("observer bug");
  });
};
`,
  );
  const { host, failures } = await load(dir);
  const payload = { text: "hi" } as Record<string, unknown>;
  host.observe?.({
    id: "e1",
    type: "user.message",
    timestamp: 1,
    payload,
  } as never as CanonicalEvent);
  host.observe?.({ id: "e2", type: "bad", timestamp: 2, payload: {} } as never as CanonicalEvent);
  assert.deepEqual((globalThis as { __axlObserved?: string[] }).__axlObserved, [
    "user.message",
    "bad",
  ]);
  assert.equal(payload.mutated, undefined, "observers get a copy, not the canonical payload");
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.extensionId, "watch");
  assert.match(failures[0]?.error.message ?? "", /observer bug/);
});

test("invalid extensions fail the whole load and unwind registrations", async (context) => {
  const dir = await directory(context);
  await writeFile(
    join(dir, "a-good.js"),
    `export default (axl) => { axl.registerTool({ name: "ok", description: "fine", inputSchema: { type: "object" }, execute: () => ({ content: [] }) }); };\n`,
  );
  await writeFile(join(dir, "b-bad.js"), `export const notDefault = 1;\n`);
  const tools = new ToolRegistry();
  await assert.rejects(
    load(dir, tools),
    (error: unknown) =>
      error instanceof DaemonExtensionError &&
      /default export must be a function/.test(error.message),
  );
  // The good extension's tool was unregistered, so the name is free again.
  tools.registerCapability("extension:probe/ok", {
    name: "ok",
    description: "probe",
    inputSchema: { type: "object" },
    execute: async () => ({ content: [], isError: false }),
  });
});

test("rejects bad tool definitions, late registrations, and duplicate names", async (context) => {
  const dir = await directory(context);
  await writeFile(
    join(dir, "late.js"),
    `export default (axl) => {
  axl.on("tool.call", () => { axl.registerTool({ name: "x", description: "x", inputSchema: {}, execute: () => ({ content: [] }) }); });
};
`,
  );
  const { host } = await load(dir);
  await assert.rejects(
    async () =>
      host.beforeToolCall?.({ callId: "1", name: "echo", input: {} }, new AbortController().signal),
    /only allowed while the extension factory runs/,
  );

  const bad = await directory(context);
  await writeFile(
    join(bad, "bad-name.js"),
    `export default (axl) => { axl.registerTool({ name: "Bad Name", description: "x", inputSchema: {}, execute: () => ({ content: [] }) }); };\n`,
  );
  await assert.rejects(load(bad), /tool name must match/);

  const clash = await directory(context);
  await writeFile(
    join(clash, "clash.js"),
    `export default (axl) => { axl.registerTool({ name: "read", description: "x", inputSchema: {}, execute: () => ({ content: [] }) }); };\n`,
  );
  const tools = new ToolRegistry();
  tools.register({
    name: "read",
    description: "builtin",
    inputSchema: { type: "object" },
    execute: async () => ({ content: [], isError: false }),
  });
  await assert.rejects(load(clash, tools), /already registered/);
});

test("disposes tracked resources in reverse order and reports disposer failures", async (context) => {
  const dir = await directory(context);
  await writeFile(
    join(dir, "resources.js"),
    `export default (axl) => {
  globalThis.__axlDisposed = [];
  axl.track(() => { globalThis.__axlDisposed.push("first"); });
  axl.track(() => { throw new Error("cleanup bug"); });
  axl.track(() => { globalThis.__axlDisposed.push("third"); });
};
`,
  );
  const { host, failures } = await load(dir);
  await host.dispose();
  await host.dispose();
  assert.deepEqual((globalThis as { __axlDisposed?: string[] }).__axlDisposed, ["third", "first"]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.event, "dispose");
});

test("command handlers chain argument replacements, block with a prefixed reason, and fail closed", async (context) => {
  const dir = await directory(context);
  await writeFile(
    join(dir, "a-summary.js"),
    `export default (axl) => {
  axl.on("command", (event) => {
    if (event.name === "compact") return { args: { ...event.args, summary: "mine" } };
  });
};
`,
  );
  await writeFile(
    join(dir, "b-guard.js"),
    `export default (axl) => {
  axl.on("command", (event) => {
    if (event.name === "compact") return { args: { ...event.args, tag: "b" } };
    if (event.name === "rename" && event.args.title === "secret") return { block: true, reason: "no secrets" };
    if (event.name === "reload") throw new Error("reload gate bug");
    if (event.name === "fork") return "nonsense";
    event.args.mutated = true;
  });
};
`,
  );
  const { host } = await load(dir);
  const signal = new AbortController().signal;
  const compact = await host.beforeCommand?.(
    { name: "compact", source: "client", args: { reason: "manual" } },
    signal,
  );
  assert.deepEqual(compact, { args: { reason: "manual", summary: "mine", tag: "b" } });
  assert.deepEqual(
    await host.beforeCommand?.(
      { name: "rename", source: "client", args: { title: "secret" } },
      signal,
    ),
    { block: true, reason: "b-guard: no secrets" },
  );
  const original = { title: "fine" };
  assert.equal(
    await host.beforeCommand?.({ name: "rename", source: "client", args: original }, signal),
    undefined,
  );
  assert.deepEqual(original, { title: "fine" }, "handlers receive a copy of the arguments");
  await assert.rejects(
    async () => host.beforeCommand?.({ name: "reload", source: "model", args: {} }, signal),
    (error: unknown) =>
      error instanceof DaemonExtensionError && /reload gate bug/.test(error.message),
  );
  await assert.rejects(
    async () => host.beforeCommand?.({ name: "fork", source: "client", args: {} }, signal),
    /must return undefined, \{ args \}, or \{ block: true, reason \}/,
  );
});
