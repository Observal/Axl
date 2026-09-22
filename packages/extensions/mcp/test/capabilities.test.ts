// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { type ModelPort, ToolRegistry } from "@axl/kernel";
import type { ModelStreamEvent } from "@axl/protocol";

import {
  loadMcpCapabilities,
  McpConfigStore,
  McpManager,
  type McpManagerOptions,
  mcpCanonicalToolName,
  mcpDefinitionFingerprint,
  mcpDiscoveryStateReader,
  McpProbeError,
  type NamedMcpServerConfig,
  probeMcpServer,
  resolveMcpServerConfig,
} from "../src/index.ts";

const fixtureServer = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "server.mjs");
const model: ModelPort = {
  stream: () =>
    (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield {
        type: "completed",
        stopReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    })(),
};

async function setup(context: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "axl-mcp-capabilities-"));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  const config: NamedMcpServerConfig = {
    name: "fixture",
    source: join(cwd, "mcp.json"),
    definition: { command: process.execPath, args: [fixtureServer], roots: [cwd] },
    config: {
      transport: "stdio",
      command: process.execPath,
      args: [fixtureServer],
      env: {},
      roots: [cwd],
      enabled: true,
      requestTimeoutMs: 5_000,
    },
  };
  return { cwd, config, cachePath: join(cwd, "cache", "mcp-tools.json") };
}

function manager(
  cwd: string,
  config: NamedMcpServerConfig,
  wrapStdio: McpManagerOptions["wrapStdio"],
) {
  return new McpManager({
    servers: [config],
    cwd,
    sessionId: "test-session",
    stateDirectory: join(cwd, "state"),
    blobDirectory: join(cwd, "blobs"),
    model,
    modelId: "fixture",
    interact: async () => ({ action: "accept" }),
    wrapStdio,
    env: { PATH: process.env.PATH },
  });
}

test("canonical MCP tool names remain provider-safe and collision-resistant", () => {
  const first = mcpCanonicalToolName("docs", "find-item");
  const second = mcpCanonicalToolName("docs", "find_item");
  assert.match(first, /^[A-Za-z0-9_-]{1,64}$/);
  assert.notEqual(first, second);
  assert.ok(mcpCanonicalToolName("s".repeat(128), "t".repeat(128)).length <= 64);
});

test("indexes MCP tools as inactive capabilities and reuses a private cache", async (context) => {
  const { cwd, config, cachePath } = await setup(context);
  const first = manager(cwd, config, (process) => ({
    ...process,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  }));
  context.after(() => first.dispose());
  const tools = new ToolRegistry();
  const loaded = await loadMcpCapabilities({ servers: [config], manager: first, tools, cachePath });
  assert.deepEqual(
    loaded.service.records.map((record) => record.identity),
    ["mcp:fixture/echo", "mcp:fixture/interactive", "mcp:fixture/tasker"],
  );
  assert.deepEqual(tools.declarations(), []);
  assert.equal(
    (await loaded.service.search("fixture echo", 5)).results[0]?.identity,
    "mcp:fixture/echo",
  );
  const activated = await loaded.service.activate(["mcp:fixture/echo"]);
  assert.equal(activated.denied.length, 0);
  const declaration = tools.activateCapability("mcp:fixture/echo");
  assert.match(declaration?.name ?? "", /^mcp_fixture_echo_[a-f0-9]{10}$/);
  assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
  const cacheText = await readFile(cachePath, "utf8");
  assert.equal(cacheText.includes(fixtureServer), false);

  const cachedManager = manager(cwd, config, () => {
    throw new Error("cache miss unexpectedly started MCP server");
  });
  context.after(() => cachedManager.dispose());
  const cachedTools = new ToolRegistry();
  const cached = await loadMcpCapabilities({
    servers: [config],
    manager: cachedManager,
    tools: cachedTools,
    cachePath,
  });
  assert.equal(cached.service.records.length, 3);

  const explicitDefaults = {
    ...config,
    definition: { ...config.definition, enabled: true, requestTimeoutMs: 5_000 },
  };
  await loadMcpCapabilities({
    servers: [explicitDefaults],
    manager: cachedManager,
    tools: new ToolRegistry(),
    cachePath,
  });
  const refreshedCache = JSON.parse(await readFile(cachePath, "utf8")) as {
    servers: { definitionFingerprint: string }[];
  };
  assert.equal(
    refreshedCache.servers[0]?.definitionFingerprint,
    mcpDefinitionFingerprint(explicitDefaults.definition),
  );
});

const passthroughStdio: McpManagerOptions["wrapStdio"] = (process) => ({
  ...process,
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
});

test("a failing server is isolated, cached as failed, and projected with its status", async (context) => {
  const { cwd, config, cachePath } = await setup(context);
  const broken: NamedMcpServerConfig = {
    name: "broken",
    source: config.source,
    definition: {
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      env: { TOKEN: "AXL_TEST_MCP_SECRET" },
    },
    config: {
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      env: { TOKEN: "AXL_TEST_MCP_SECRET" },
      roots: [cwd],
      enabled: true,
      requestTimeoutMs: 2_000,
    },
  };
  const both = new McpManager({
    servers: [broken, config],
    cwd,
    sessionId: "test-session",
    stateDirectory: join(cwd, "state"),
    blobDirectory: join(cwd, "blobs"),
    model,
    modelId: "fixture",
    secretValues: ["hunter2-secret-value"],
    interact: async () => ({ action: "accept" }),
    wrapStdio: passthroughStdio,
    env: { PATH: process.env.PATH, AXL_TEST_MCP_SECRET: "hunter2-secret-value" },
  });
  context.after(() => both.dispose());
  const tools = new ToolRegistry();
  const loaded = await loadMcpCapabilities({
    servers: [broken, config],
    manager: both,
    tools,
    cachePath,
  });
  assert.deepEqual(
    loaded.service.records.map((record) => record.identity),
    ["mcp:fixture/echo", "mcp:fixture/interactive", "mcp:fixture/tasker"],
  );
  assert.equal(loaded.failures.length, 1);
  assert.equal(loaded.failures[0]?.server, "broken");
  assert.ok((loaded.failures[0]?.error.length ?? 0) > 0);
  assert.equal(JSON.stringify(loaded.failures).includes("hunter2-secret-value"), false);
  assert.equal((await readFile(cachePath, "utf8")).includes("hunter2-secret-value"), false);

  await mkdir(join(cwd, "home"), { recursive: true });
  await writeFile(
    join(cwd, "home", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        broken: broken.definition,
        fixture: config.definition,
        fresh: { url: "https://mcp.example.com/mcp" },
        off: { url: "https://mcp.example.com/mcp", enabled: false },
      },
    }),
  );
  const store = new McpConfigStore(join(cwd, "home"), cwd, mcpDiscoveryStateReader(cachePath));
  const listed = await store.list();
  assert.deepEqual(
    listed.servers.map((server) => [
      server.name,
      server.status,
      server.tools.map((tool) => tool.name),
    ]),
    [
      ["broken", "failed", []],
      ["fixture", "discovered", ["echo", "interactive", "tasker"]],
      ["fresh", "pending", []],
      ["off", "disabled", []],
    ],
  );
  assert.equal(typeof listed.servers[0]?.error, "string");
  assert.equal(typeof listed.servers[1]?.discoveredAt, "number");

  await store.upsert("fixture", { ...config.definition, requestTimeoutMs: 9_000 });
  assert.equal(
    (await store.list()).servers.find((server) => server.name === "fixture")?.status,
    "pending",
  );
});

test("probing connects once, reports tools, records the cache, and never persists config", async (context) => {
  const { cwd, config, cachePath } = await setup(context);
  const result = await probeMcpServer({
    server: resolveMcpServerConfig("fixture", config.definition, cwd),
    cwd,
    stateDirectory: join(cwd, "probe-state"),
    blobDirectory: join(cwd, "blobs"),
    wrapStdio: passthroughStdio,
    env: { PATH: process.env.PATH },
    cachePath,
  });
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ["echo", "interactive", "tasker"],
  );
  assert.equal(typeof result.protocolVersion, "string");
  const cached = JSON.parse(await readFile(cachePath, "utf8")) as { servers: { server: string }[] };
  assert.deepEqual(
    cached.servers.map((server) => server.server),
    ["fixture"],
  );

  await assert.rejects(
    probeMcpServer({
      server: resolveMcpServerConfig(
        "broken",
        { command: process.execPath, args: ["-e", "process.exit(3)"] },
        cwd,
      ),
      cwd,
      stateDirectory: join(cwd, "probe-state"),
      blobDirectory: join(cwd, "blobs"),
      wrapStdio: passthroughStdio,
      env: { PATH: process.env.PATH },
      timeoutMs: 5_000,
    }),
    (error: unknown) => error instanceof McpProbeError && error.message.length > 0,
  );
  assert.throws(
    () => resolveMcpServerConfig("bad", { url: "http://example.com/mcp" }, cwd),
    /HTTPS/u,
  );
});
