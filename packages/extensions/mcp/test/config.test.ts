// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadMcpConfig,
  McpConfigError,
  McpConfigStore,
  mcpSecretReferences,
  mcpSecretValues,
  resolveMcpSecretValue,
} from "../src/index.ts";

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
  const batch = await store.upsertMany([
    { name: "docs", definition: { url: "https://docs.example.com/mcp" } },
    { name: "local", definition: { command: "example-mcp" } },
  ]);
  assert.deepEqual(
    batch.servers.map((server) => server.name),
    ["context7", "docs", "local"],
  );
  assert.equal((await store.remove("context7")).servers.length, 2);

  await rm(join(root, "mcp.json"));
  await writeFile(join(root, "target.json"), '{"mcpServers":{}}');
  await symlink(join(root, "target.json"), join(root, "mcp.json"));
  await assert.rejects(() => store.list(), /not a symlink/);
});

test("rejects a batch that would exceed the total server limit before writing", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-mcp-limit-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new McpConfigStore(root, root);
  await assert.rejects(
    store.upsertMany(
      Array.from({ length: 257 }, (_, index) => ({
        name: `server-${index}`,
        definition: { command: "example-mcp" },
      })),
    ),
    /at most 256/u,
  );
  assert.equal((await store.list()).servers.length, 0);
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
  await writeFile(
    path,
    JSON.stringify({
      mcpServers: {
        bad: {
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer literal-secret" },
        },
      },
    }),
  );
  await assert.rejects(load, /literal values are never stored/u);
  await writeFile(
    path,
    JSON.stringify({
      mcpServers: { bad: { command: "x", env: { TOKEN: "ghp-abc.123 literal" } } },
    }),
  );
  await assert.rejects(load, McpConfigError);
});

test("header and env values may be variable names or ${VAR} templates", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-mcp-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        remote: {
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer ${GH_PAT}", "X-Key": "API_KEY" },
        },
        local: { command: "x", env: { DSN: "postgres://${DB_USER}:${DB_PASS}@db/app" } },
      },
    }),
  );
  const servers = await loadMcpConfig({ cwd: root, globalDirectory: root });
  assert.deepEqual(mcpSecretReferences("Bearer ${GH_PAT}"), ["GH_PAT"]);
  assert.deepEqual(mcpSecretReferences("API_KEY"), ["API_KEY"]);
  assert.deepEqual(mcpSecretReferences("Bearer literal"), []);
  const env = { GH_PAT: "pat", API_KEY: "key", DB_USER: "u", DB_PASS: "p" };
  assert.deepEqual([...mcpSecretValues(servers, env)].sort(), ["key", "p", "pat", "u"]);
  assert.equal(
    resolveMcpSecretValue("Bearer ${GH_PAT}", env, () => "h"),
    "Bearer pat",
  );
  assert.equal(
    resolveMcpSecretValue("API_KEY", env, () => "h"),
    "key",
  );
  assert.equal(
    resolveMcpSecretValue("postgres://${DB_USER}:${DB_PASS}@db/app", env, () => "h"),
    "postgres://u:p@db/app",
  );
  assert.throws(
    () => resolveMcpSecretValue("Bearer ${MISSING}", env, () => "header"),
    /MISSING is not set/u,
  );
});
