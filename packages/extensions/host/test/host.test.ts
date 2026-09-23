// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { CompositeCapabilityService, ToolInputError, ToolRegistry } from "@axl/kernel";
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

async function load(
  dir: string,
  tools = new ToolRegistry(),
  options: { readonly signal?: AbortSignal } = {},
) {
  const failures: DaemonExtensionFailure[] = [];
  const loaded = await loadDaemonExtensions({
    directory: dir,
    cwd: "/workspace",
    tools,
    grantedAuthorities: new Set([DAEMON_EXTENSION_AUTHORITY]),
    ...options,
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

test("disabled extensions contribute nothing and are not imported", async (context) => {
  const dir = await directory(context);
  await writeFile(join(dir, "disabled.js"), `throw new Error("must not import");\n`);
  await writeFile(
    join(dir, "enabled.js"),
    `export default (axl) => { axl.registerTool({ name: "active", description: "active", inputSchema: { type: "object" }, execute: () => ({ content: [] }) }); };\n`,
  );
  const tools = new ToolRegistry();
  const loaded = await loadDaemonExtensions({
    directory: dir,
    cwd: "/workspace",
    tools,
    grantedAuthorities: new Set([DAEMON_EXTENSION_AUTHORITY]),
    disabledExtensionIds: new Set(["disabled"]),
    onFailure: () => undefined,
  });
  assert.deepEqual(
    loaded.extensions.map((extension) => extension.id),
    ["enabled"],
  );
  assert.deepEqual(
    loaded.source.records.map((record) => record.identity),
    ["extension:enabled/active"],
  );
  await loaded.host.dispose();
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
  const greet = tools.get("greet");
  assert.ok(greet);
  await assert.rejects(
    greet.execute({}, new AbortController().signal),
    (error: unknown) =>
      error instanceof ToolInputError && /required property 'name'/.test(error.message),
  );
  const result = await greet.execute({ name: "Ada" }, new AbortController().signal);
  assert.deepEqual(result, {
    content: [{ type: "text", text: "hello Ada from /workspace" }],
    isError: false,
  });
});

test("schema identifiers are isolated across extensions and reloads", async (context) => {
  const dir = await directory(context);
  for (const name of ["first", "second"]) {
    await writeFile(
      join(dir, `${name}.js`),
      `export default (axl) => { axl.registerTool({ name: "${name}", description: "${name}", inputSchema: { $id: "shared", type: "object" }, execute: () => ({ content: [] }) }); };\n`,
    );
  }
  for (let loadIndex = 0; loadIndex < 2; loadIndex += 1) {
    const loaded = await load(dir, new ToolRegistry());
    assert.deepEqual(
      loaded.extensions.map((extension) => extension.id),
      ["first", "second"],
    );
    await loaded.host.dispose();
  }
});

test("reload imports changed extension source instead of the cached module", async (context) => {
  const dir = await directory(context);
  const path = join(dir, "version.js");
  const source = (version: string) => `export default (axl) => {
  axl.registerTool({ name: "version", description: "version", inputSchema: { type: "object" }, execute: () => ({ content: [{ type: "text", text: "${version}" }] }) });
};
`;
  await writeFile(path, source("v1"));
  const first = await load(dir);
  first.tools.activateCapability("extension:version/version");
  const firstResult = await first.tools.get("version")?.execute({}, new AbortController().signal);
  assert.deepEqual(firstResult, {
    content: [{ type: "text", text: "v1" }],
    isError: false,
  });
  await first.host.dispose();

  await writeFile(path, source("v2"));
  const second = await load(dir);
  second.tools.activateCapability("extension:version/version");
  const secondResult = await second.tools.get("version")?.execute({}, new AbortController().signal);
  assert.deepEqual(secondResult, {
    content: [{ type: "text", text: "v2" }],
    isError: false,
  });
  await second.host.dispose();
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

test("tool input and result handlers chain in extension order", async (context) => {
  const dir = await directory(context);
  await writeFile(
    join(dir, "a.js"),
    `export default (axl) => {
  axl.on("tool.call", (event) => ({ input: { ...event.input, first: true } }));
  axl.on("tool.result", (event) => ({ content: [...event.content, { type: "text", text: "a" }] }));
};\n`,
  );
  await writeFile(
    join(dir, "b.js"),
    `export default (axl) => {
  axl.on("tool.call", (event) => ({ input: { ...event.input, second: event.input.first } }));
  axl.on("tool.result", (event) => ({ content: [...event.content, { type: "text", text: "b" }] }));
};\n`,
  );
  const { host } = await load(dir);
  const signal = new AbortController().signal;
  assert.deepEqual(await host.beforeToolCall?.({ callId: "1", name: "echo", input: {} }, signal), {
    input: { first: true, second: true },
  });
  assert.deepEqual(
    await host.afterToolCall?.(
      { callId: "1", name: "echo", input: {}, content: [], isError: false },
      signal,
    ),
    {
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
      isError: false,
    },
  );
  await host.dispose();

  const bad = await directory(context);
  await writeFile(
    join(bad, "bad.js"),
    `export default (axl) => axl.on("tool.result", () => ({ content: "invalid" }));\n`,
  );
  const invalid = await load(bad);
  await assert.rejects(
    invalid.host.afterToolCall?.(
      { callId: "1", name: "echo", input: {}, content: [], isError: false },
      signal,
    ),
    /content/u,
  );
  await invalid.host.dispose();
});

test("provider hooks chain headers and payloads and observe responses", async (context) => {
  const dir = await directory(context);
  await writeFile(
    join(dir, "provider.js"),
    `export default (axl) => {
  globalThis.__axlProviderStatus = 0;
  axl.on("before_provider_headers", (event) => ({ ...event.headers, "x-extension": "yes" }));
  axl.on("before_provider_request", (event) => ({ ...event.payload, extension: true }));
  axl.on("after_provider_response", (event) => { globalThis.__axlProviderStatus = event.status; });
};\n`,
  );
  const { host } = await load(dir);
  const signal = new AbortController().signal;
  assert.deepEqual(
    await host.beforeProviderHeaders?.({ url: "https://example.com", headers: {} }, signal),
    { "x-extension": "yes" },
  );
  assert.deepEqual(
    await host.beforeProviderRequest?.({ url: "https://example.com", payload: {} }, signal),
    { extension: true },
  );
  await host.afterProviderResponse?.(
    { url: "https://example.com", status: 201, headers: {} },
    signal,
  );
  assert.equal((globalThis as { __axlProviderStatus?: number }).__axlProviderStatus, 201);
  await host.dispose();
  delete (globalThis as { __axlProviderStatus?: number }).__axlProviderStatus;
});

test("input handlers transform or handle input in extension order", async (context) => {
  const dir = await directory(context);
  await writeFile(
    join(dir, "input.js"),
    `export default (axl) => axl.on("input", (event) => {
  const text = event.content[0]?.text;
  if (text === "handled") return { action: "handled" };
  return { action: "transform", content: [{ type: "text", text: String(text) + " transformed" }] };
});\n`,
  );
  const { host } = await load(dir);
  const signal = new AbortController().signal;
  assert.deepEqual(
    await host.beforeInput?.(
      { source: "client", content: [{ type: "text", text: "hello" }] },
      signal,
    ),
    { action: "transform", content: [{ type: "text", text: "hello transformed" }] },
  );
  assert.deepEqual(
    await host.beforeInput?.(
      { source: "client", content: [{ type: "text", text: "handled" }] },
      signal,
    ),
    { action: "handled" },
  );
  await host.dispose();
});

test("extension state is namespaced through the bound session", async (context) => {
  const dir = await directory(context);
  await writeFile(
    join(dir, "state.js"),
    `export default (axl) => { globalThis.__axlState = axl.state; };\n`,
  );
  const { host } = await load(dir);
  const values = new Map<string, unknown>();
  host.bindSession?.({
    getState: (extensionId, key) => values.get(`${extensionId}:${key}`) as never,
    setState: async (extensionId, key, value) => {
      if (value === null) values.delete(`${extensionId}:${key}`);
      else values.set(`${extensionId}:${key}`, value);
    },
    sendExtensionMessage: async () => undefined,
    getEntryLabel: () => undefined,
    setEntryLabel: async () => undefined,
    emit: async () => undefined,
  });
  const state = (
    globalThis as {
      __axlState?: {
        get(key: string): unknown;
        set(key: string, value: unknown): Promise<void>;
        delete(key: string): Promise<void>;
      };
    }
  ).__axlState;
  await state?.set("count", 1);
  assert.equal(state?.get("count"), 1);
  await state?.delete("count");
  assert.equal(state?.get("count"), undefined);
  await assert.rejects(() => state?.set("bad key", 1), /state key/u);
  await host.dispose();
  delete (globalThis as { __axlState?: unknown }).__axlState;
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

test("projects typed lifecycle events from canonical and activity streams", async (context) => {
  const dir = await directory(context);
  await writeFile(
    join(dir, "lifecycle.js"),
    `export default (axl) => {
  globalThis.__axlLifecycle = [];
  for (const name of ["session_start", "agent_start", "turn_start", "message_start", "message_update", "message_end", "turn_end", "agent_end", "agent_settled", "extension_event", "session_shutdown"]) {
    axl.on(name, (event) => { globalThis.__axlLifecycle.push(event.type); });
  }
  axl.on("resources_discover", () => [{ name: "rules", content: "Use extension rules." }]);
};\n`,
  );
  const { host } = await load(dir);
  const signal = new AbortController().signal;
  await host.activate(signal);
  assert.deepEqual(await host.discoverResources?.(signal), [
    {
      kind: "extension",
      scope: "global",
      path: "extension:lifecycle/rules",
      content: "Use extension rules.",
    },
  ]);
  host.observe?.({
    id: "e1",
    type: "user.message",
    timestamp: 1,
    payload: { content: [{ type: "text", text: "go" }] },
  } as never);
  host.observeActivity?.({
    operationId: "00000000-0000-4000-8000-000000000001",
    sequence: 1,
    type: "text_delta",
    text: "hello",
  } as never);
  host.observe?.({
    id: "bus",
    type: "extension.event",
    timestamp: 2,
    payload: { extensionId: "lifecycle", channel: "changed", value: true },
  } as never);
  host.observe?.({
    id: "e2",
    type: "assistant.message",
    timestamp: 2,
    payload: { content: [{ type: "text", text: "hello" }], stopReason: "stop" },
  } as never);
  host.settled?.("00000000-0000-4000-8000-000000000001" as never);
  await host.dispose();
  assert.deepEqual((globalThis as { __axlLifecycle?: string[] }).__axlLifecycle, [
    "session_start",
    "agent_start",
    "turn_start",
    "message_start",
    "message_update",
    "extension_event",
    "message_end",
    "turn_end",
    "agent_end",
    "agent_settled",
    "session_shutdown",
  ]);
  delete (globalThis as { __axlLifecycle?: string[] }).__axlLifecycle;
});

test("disposal drains pending session.event handlers before cleanup", async (context) => {
  const dir = await directory(context);
  let release: (() => void) | undefined;
  (globalThis as { __axlObserverWait?: Promise<void> }).__axlObserverWait = new Promise<void>(
    (resolve) => {
      release = resolve;
    },
  );
  await writeFile(
    join(dir, "watch.js"),
    `export default (axl) => {
  globalThis.__axlObserverOrder = [];
  axl.on("session.event", async () => {
    globalThis.__axlObserverOrder.push("started");
    await globalThis.__axlObserverWait;
    globalThis.__axlObserverOrder.push("finished");
  });
  axl.track(() => { globalThis.__axlObserverOrder.push("cleanup"); });
};
`,
  );
  const { host } = await load(dir);
  host.observe?.({ id: "e1", type: "user.message", timestamp: 1, payload: {} } as never);
  const disposing = host.dispose();
  await Promise.resolve();
  assert.deepEqual((globalThis as { __axlObserverOrder?: string[] }).__axlObserverOrder, [
    "started",
  ]);
  release?.();
  await disposing;
  assert.deepEqual((globalThis as { __axlObserverOrder?: string[] }).__axlObserverOrder, [
    "started",
    "finished",
    "cleanup",
  ]);
});

test("disposal aborts observers and bounds uncooperative handlers", async (context) => {
  const aborting = await directory(context);
  await writeFile(
    join(aborting, "watch.js"),
    `export default (axl) => {
  globalThis.__axlObserverAbort = [];
  axl.on("session.event", async (event) => {
    await new Promise((resolve) => event.signal.addEventListener("abort", resolve, { once: true }));
    globalThis.__axlObserverAbort.push("aborted");
  });
  axl.track(() => { globalThis.__axlObserverAbort.push("cleanup"); });
};
`,
  );
  const { host } = await load(aborting);
  host.observe?.({ id: "e1", type: "user.message", timestamp: 1, payload: {} } as never);
  await host.dispose();
  assert.deepEqual((globalThis as { __axlObserverAbort?: string[] }).__axlObserverAbort, [
    "aborted",
    "cleanup",
  ]);

  const hanging = await directory(context);
  await writeFile(
    join(hanging, "watch.js"),
    `export default (axl) => {
  globalThis.__axlTimedCleanup = false;
  axl.on("session.event", () => new Promise(() => {}));
  axl.track(() => { globalThis.__axlTimedCleanup = true; });
};
`,
  );
  const failures: DaemonExtensionFailure[] = [];
  const loaded = await loadDaemonExtensions({
    directory: hanging,
    cwd: "/workspace",
    tools: new ToolRegistry(),
    grantedAuthorities: new Set([DAEMON_EXTENSION_AUTHORITY]),
    cleanupTimeoutMs: 10,
    onFailure: (failure) => failures.push(failure),
  });
  loaded.host.observe?.({ id: "e1", type: "user.message", timestamp: 1, payload: {} } as never);
  await loaded.host.dispose();
  assert.equal((globalThis as { __axlTimedCleanup?: boolean }).__axlTimedCleanup, true);
  assert.equal(failures.length, 1);
  assert.match(failures[0]?.error.message ?? "", /cleanup exceeded 10ms/);
});

test("activation receives and honors the owning operation signal", async (context) => {
  const dir = await directory(context);
  await writeFile(
    join(dir, "cancelled.js"),
    `export default async (axl) => { await new Promise((resolve, reject) => { axl.signal.addEventListener("abort", () => reject(axl.signal.reason), { once: true }); }); };\n`,
  );
  const controller = new AbortController();
  const loading = load(dir, new ToolRegistry(), { signal: controller.signal });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  controller.abort(new DOMException("Cancelled", "AbortError"));
  await assert.rejects(loading, { name: "DaemonExtensionError" });
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

test("a failing factory rolls back its own resources and preserves its error", async (context) => {
  const dir = await directory(context);
  await writeFile(
    join(dir, "broken.js"),
    `export default (axl) => {
  globalThis.__axlFactoryDisposed = [];
  axl.registerTool({ name: "temporary", description: "temporary", inputSchema: { type: "object" }, execute: () => ({ content: [] }) });
  axl.track(() => { globalThis.__axlFactoryDisposed.push("first"); });
  axl.track(() => { throw new Error("cleanup bug"); });
  axl.track(() => { globalThis.__axlFactoryDisposed.push("third"); });
  throw new Error("factory bug");
};
`,
  );
  const tools = new ToolRegistry();
  const failures: DaemonExtensionFailure[] = [];
  await assert.rejects(
    loadDaemonExtensions({
      directory: dir,
      cwd: "/workspace",
      tools,
      grantedAuthorities: new Set([DAEMON_EXTENSION_AUTHORITY]),
      onFailure: (failure) => failures.push(failure),
    }),
    (error: unknown) => error instanceof DaemonExtensionError && /factory bug/.test(error.message),
  );
  assert.deepEqual((globalThis as { __axlFactoryDisposed?: string[] }).__axlFactoryDisposed, [
    "third",
    "first",
  ]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.event, "dispose");
  tools.registerCapability("extension:probe/temporary", {
    name: "temporary",
    description: "probe",
    inputSchema: { type: "object" },
    execute: async () => ({ content: [], isError: false }),
  });
});

test("supports dynamic tools and rejects bad definitions and duplicate names", async (context) => {
  const dir = await directory(context);
  await writeFile(
    join(dir, "dynamic.js"),
    `export default (axl) => {
  globalThis.__axlRegisterDynamic = () => axl.registerTool({ name: "dynamic", description: "dynamic", inputSchema: {}, execute: () => ({ content: [] }) });
};
`,
  );
  const loaded = await load(dir);
  assert.equal((await loaded.source.service.search("dynamic", 5)).results.length, 0);
  const unregister = (
    globalThis as { __axlRegisterDynamic?: () => () => void }
  ).__axlRegisterDynamic?.();
  assert.equal((await loaded.source.service.search("dynamic", 5)).results[0]?.name, "dynamic");
  unregister?.();
  assert.equal((await loaded.source.service.search("dynamic", 5)).results.length, 0);
  await loaded.host.dispose();
  delete (globalThis as { __axlRegisterDynamic?: () => () => void }).__axlRegisterDynamic;

  const bad = await directory(context);
  await writeFile(
    join(bad, "bad-name.js"),
    `export default (axl) => { axl.registerTool({ name: "Bad Name", description: "x", inputSchema: {}, execute: () => ({ content: [] }) }); };\n`,
  );
  await assert.rejects(load(bad), /tool name must match/);

  const badSchema = await directory(context);
  await writeFile(
    join(badSchema, "bad-schema.js"),
    `export default (axl) => { axl.registerTool({ name: "broken", description: "x", inputSchema: { type: "wat" }, execute: () => ({ content: [] }) }); };\n`,
  );
  await assert.rejects(load(badSchema), /invalid inputSchema/);

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

test("registers shared daemon commands and rejects reserved names", async (context) => {
  const dir = await directory(context);
  await writeFile(
    join(dir, "commands.js"),
    `export default (axl) => axl.registerCommand({ name: "hello", description: "Say hello", execute: (args) => "hello " + String(args.name) });\n`,
  );
  const loaded = await loadDaemonExtensions({
    directory: dir,
    cwd: "/workspace",
    tools: new ToolRegistry(),
    grantedAuthorities: new Set([DAEMON_EXTENSION_AUTHORITY]),
    reservedCommandNames: new Set(["reload"]),
    onFailure: () => undefined,
  });
  assert.deepEqual(loaded.host.commands?.(), [
    { extensionId: "commands", name: "hello", description: "Say hello" },
  ]);
  assert.equal(
    await loaded.host.invokeCommand?.("hello", { name: "Axl" }, new AbortController().signal),
    "hello Axl",
  );
  await loaded.host.dispose();

  const clash = await directory(context);
  await writeFile(
    join(clash, "bad.js"),
    `export default (axl) => axl.registerCommand({ name: "reload", description: "bad", execute: () => undefined });\n`,
  );
  await assert.rejects(
    loadDaemonExtensions({
      directory: clash,
      cwd: "/workspace",
      tools: new ToolRegistry(),
      grantedAuthorities: new Set([DAEMON_EXTENSION_AUTHORITY]),
      reservedCommandNames: new Set(["reload"]),
      onFailure: () => undefined,
    }),
    /already registered/u,
  );
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
