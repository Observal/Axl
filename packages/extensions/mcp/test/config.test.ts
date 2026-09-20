// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadMcpConfig, McpConfigError, McpConfigStore, mcpSecretValues } from "../src/index.ts";

test("loads only global mcpServers and infers transports", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-mcp-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const global = join(root, "global");
  const project = join(root, "project");
  await mkdir(join(project, ".axl"), { recursive: true });
  await mkdir(global);
  await writeFile(
    join(global, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        local: { command: "node", args: ["server.mjs"], roots: ["."] },
        disabled: { command: "false", enabled: false },
        remote: {
          url: "https://example.com/mcp",
          headers: { Authorization: "EXAMPLE_TOKEN" },
          oauth: { clientId: "axl", scope: "tools" },
        },
      },
    }),
  );
  await writeFile(
    join(project, ".axl", "mcp.json"),
    JSON.stringify({ mcpServers: { ignored: { command: "false" } } }),
  );

  const servers = await loadMcpConfig({ cwd: project, globalDirectory: global });
  assert.deepEqual(
    servers.map((server) => [server.name, server.config.transport]),
    [
      ["local", "stdio"],
      ["remote", "http"],
    ],
  );
  assert.equal(servers[0]?.config.roots[0], project);
  assert.deepEqual(mcpSecretValues(servers, { EXAMPLE_TOKEN: "top-secret" }), ["top-secret"]);
});

test("configuration store atomically adds and removes private global servers", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-mcp-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new McpConfigStore(root, root);

  const added = await store.upsert("context7", { url: "https://mcp.context7.com/mcp" });
  assert.equal(added.changed, true);
  assert.equal(added.servers[0]?.name, "context7");
  assert.equal((await lstat(join(root, "mcp.json"))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(root, "mcp.json"), "utf8")), {
    mcpServers: { context7: { url: "https://mcp.context7.com/mcp" } },
  });
  assert.equal((await store.remove("context7")).servers.length, 0);

  await rm(join(root, "mcp.json"));
  await writeFile(join(root, "target.json"), '{"mcpServers":{}}');
  await symlink(join(root, "target.json"), join(root, "mcp.json"));
  await assert.rejects(() => store.list(), /not a symlink/);
});

test("rejects legacy, ambiguous, unsafe, and unknown configuration", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-mcp-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const path = join(root, "mcp.json");
  const load = () => loadMcpConfig({ cwd: root, globalDirectory: root });

  await writeFile(path, JSON.stringify({ servers: {} }));
  await assert.rejects(load, McpConfigError);
  await writeFile(
    path,
    JSON.stringify({ mcpServers: { bad: { url: "https://example.com", command: "node" } } }),
  );
  await assert.rejects(load, McpConfigError);
  await writeFile(path, JSON.stringify({ mcpServers: { bad: { url: "http://example.com/mcp" } } }));
  await assert.rejects(load, McpConfigError);
  await writeFile(path, JSON.stringify({ mcpServers: { bad: { url: ":not-a-url" } } }));
  await assert.rejects(load, McpConfigError);
});
