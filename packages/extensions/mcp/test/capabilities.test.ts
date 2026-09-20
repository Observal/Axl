// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { type ModelPort, ToolRegistry } from "@axl/kernel";
import type { ModelStreamEvent } from "@axl/protocol";

import {
  loadMcpCapabilities,
  McpManager,
  type McpManagerOptions,
  mcpCanonicalToolName,
  type NamedMcpServerConfig,
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
});
