// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ModelPort } from "@axl/kernel";
import type { JsonObject, ModelStreamEvent } from "@axl/protocol";

import {
  type McpInteractionRequest,
  McpManager,
  type McpToolBinding,
  mcpCanonicalToolName,
  mcpConfigurationFingerprint,
  type NamedMcpServerConfig,
  probeMcpServer,
  resolveMcpServerConfig,
} from "../src/index.ts";

const fixtureServer = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "server.mjs");

async function workspace(context: TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "axl-mcp-")));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const model: ModelPort = {
  stream() {
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text_delta", text: "fixture sample" };
      yield {
        type: "completed",
        stopReason: "stop",
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    })();
  },
};

function interactions(log: McpInteractionRequest[]) {
  return async (request: McpInteractionRequest) => {
    log.push(request);
    return request.kind === "mcp_elicitation_form"
      ? { action: "accept" as const, content: { confirm: true } }
      : { action: "accept" as const };
  };
}

function managerFor(input: {
  cwd: string;
  interactions: McpInteractionRequest[];
  config: ConstructorParameters<typeof McpManager>[0]["servers"][number];
  env?: Readonly<Record<string, string | undefined>>;
  secretValues?: readonly string[];
  cleanup?: () => Promise<void>;
}): McpManager {
  return new McpManager({
    servers: [input.config],
    cwd: input.cwd,
    sessionId: "test-session",
    stateDirectory: join(input.cwd, "state"),
    blobDirectory: join(input.cwd, "blobs"),
    model,
    modelId: "fixture-model",
    ...(input.secretValues === undefined ? {} : { secretValues: input.secretValues }),
    interact: interactions(input.interactions),
    wrapStdio: (process) => ({
      ...process,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      ...(input.cleanup === undefined ? {} : { cleanup: input.cleanup }),
    }),
    env: input.env ?? { PATH: process.env.PATH },
  });
}

async function directTool(manager: McpManager, config: NamedMcpServerConfig, name: string) {
  const discovered = await manager.discoverTools(config.name);
  const tool = discovered.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Fixture has no tool ${name}`);
  const identity = `mcp:${config.name}/${name}`;
  const binding: McpToolBinding = {
    ...tool,
    identity,
    canonicalName: mcpCanonicalToolName(config.name, name),
    serverName: config.name,
    toolName: name,
    configurationFingerprint: mcpConfigurationFingerprint(config.config),
    source: config.source,
  };
  return manager.makeDirectTool(binding);
}

test("stdio MCP discovers and directly calls frozen tools", async (context) => {
  const cwd = await workspace(context);
  const seen: McpInteractionRequest[] = [];
  let cleanupCalls = 0;
  const config: NamedMcpServerConfig = {
    name: "fixture",
    source: "test",
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
  const manager = managerFor({
    cwd,
    interactions: seen,
    secretValues: ["top-secret"],
    cleanup: () => {
      cleanupCalls += 1;
      return Promise.resolve();
    },
    config,
  });
  context.after(() => manager.dispose());

  const discovered = await manager.discoverTools("fixture");
  assert.deepEqual(
    discovered.tools.map((tool) => tool.name),
    ["echo", "interactive", "tasker"],
  );
  const echo = await directTool(manager, config, "echo");
  const invalid = await echo.execute({}, new AbortController().signal);
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0]?.type === "text" ? invalid.content[0].text : "", /fixture\/echo/);
  assert.equal(seen.length, 0);
  const echoed = await echo.execute({ text: "top-secret" }, new AbortController().signal);
  assert.equal(echoed.content[0]?.type === "text" && echoed.content[0].text, "[REDACTED]");

  const tasker = await directTool(manager, config, "tasker");
  const task = await tasker.execute({}, new AbortController().signal);
  assert.equal(task.content[0]?.type === "text" && task.content[0].text, "task complete");

  const interactiveTool = await directTool(manager, config, "interactive");
  const interactive = await interactiveTool.execute({}, new AbortController().signal);
  assert.equal(interactive.isError, false);
  assert.deepEqual(
    seen.map((request) => request.kind),
    [
      "mcp_tool",
      "mcp_tool",
      "mcp_tool",
      "mcp_elicitation_form",
      "mcp_sampling_request",
      "mcp_sampling_response",
    ],
  );
  const payload = JSON.parse(
    interactive.content[0]?.type === "text" ? interactive.content[0].text : "{}",
  ) as { roots: { roots: Array<{ uri: string }> }; sampled: { content: { text: string } } };
  assert.equal(payload.roots.roots[0]?.uri, pathToFileURL(cwd).href);
  assert.equal(payload.sampled.content.text, "fixture sample");
  await manager.dispose();
  assert.equal(cleanupCalls, 1);
});

/** Fake resource + authorization server: 401 until `Bearer access-token`, then an empty tool list. */
async function oauthFixture(context: TestContext): Promise<{
  readonly base: string;
  readonly authenticated: () => boolean;
}> {
  let base = "";
  let authenticated = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", base);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          resource: `${base}/mcp`,
          authorization_servers: [base],
          scopes_supported: ["tools"],
        }),
      );
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
      return;
    }
    if (url.pathname === "/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri") as string);
      redirect.searchParams.set("code", "test-code");
      redirect.searchParams.set("state", url.searchParams.get("state") as string);
      response.writeHead(302, { Location: redirect.href }).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (url.pathname === "/register") {
        const metadata = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject;
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ...metadata, client_id: "axl-test" }));
        return;
      }
      if (url.pathname === "/token") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ access_token: "access-token", token_type: "Bearer", expires_in: 3600 }),
        );
        return;
      }
      if (url.pathname !== "/mcp") {
        response.writeHead(404).end();
        return;
      }
      if (request.method === "GET" || request.method === "DELETE") {
        response.writeHead(405).end();
        return;
      }
      if (request.headers.authorization !== "Bearer access-token") {
        response.writeHead(401, {
          "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="tools"`,
        });
        response.end();
        return;
      }
      authenticated = true;
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id?: number;
        method: string;
      };
      if (message.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "oauth-fixture", version: "1.0.0" },
            }
          : { tools: [] };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  context.after(() => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
  return { base, authenticated: () => authenticated };
}

test("Streamable HTTP completes OAuth discovery, PKCE, registration, and token use", async (context) => {
  const cwd = await workspace(context);
  const fixture = await oauthFixture(context);
  const base = fixture.base;
  const approvals: McpInteractionRequest[] = [];
  const manager = new McpManager({
    servers: [
      {
        name: "oauth",
        source: "test",
        definition: { url: `${base}/mcp`, oauth: {} },
        config: {
          transport: "http",
          url: `${base}/mcp`,
          headers: {},
          oauth: {},
          roots: [],
          enabled: true,
          requestTimeoutMs: 5_000,
        },
      },
    ],
    cwd,
    sessionId: "test-session",
    stateDirectory: join(cwd, "state"),
    blobDirectory: join(cwd, "blobs"),
    model,
    modelId: "fixture-model",
    interact: async (request) => {
      approvals.push(request);
      const url = request.data?.url;
      assert.equal(typeof url, "string");
      await fetch(url as string);
      return { action: "accept" };
    },
    wrapStdio: (process) => ({ ...process, env: {} }),
  });
  context.after(() => manager.dispose());

  const result = await manager.discoverTools("oauth");
  assert.deepEqual(result.tools, []);
  assert.equal(fixture.authenticated(), true);
  assert.equal(approvals.length, 1);
});

test("a credential-less HTTP server that answers 401 triggers OAuth without oauth config", async (context) => {
  const cwd = await workspace(context);
  const fixture = await oauthFixture(context);
  const approvals: McpInteractionRequest[] = [];
  const manager = new McpManager({
    servers: [resolveMcpServerConfig("github-like", { url: `${fixture.base}/mcp` }, cwd, "test")],
    cwd,
    sessionId: "test-session",
    stateDirectory: join(cwd, "state"),
    blobDirectory: join(cwd, "blobs"),
    model,
    modelId: "fixture-model",
    interact: async (request) => {
      approvals.push(request);
      await fetch(request.data?.url as string);
      return { action: "accept" };
    },
    wrapStdio: (process) => ({ ...process, env: {} }),
  });
  context.after(() => manager.dispose());
  const result = await manager.discoverTools("github-like");
  assert.deepEqual(result.tools, []);
  assert.equal(fixture.authenticated(), true);
  assert.deepEqual(
    approvals.map((request) => request.kind),
    ["mcp_elicitation_url"],
  );
});

test("a probe reports authorization as required instead of completing OAuth", async (context) => {
  const cwd = await workspace(context);
  const fixture = await oauthFixture(context);
  const result = await probeMcpServer({
    server: resolveMcpServerConfig("github-like", { url: `${fixture.base}/mcp` }, cwd),
    cwd,
    stateDirectory: join(cwd, "probe-state"),
    blobDirectory: join(cwd, "blobs"),
    wrapStdio: (process) => ({ ...process, env: {} }),
    timeoutMs: 10_000,
  });
  assert.equal(result.authorization, "required");
  assert.deepEqual(result.tools, []);
  assert.equal(fixture.authenticated(), false);
});

test("Streamable HTTP sends configured headers and negotiates 2025-11-25", async (context) => {
  const cwd = await workspace(context);
  const seenHeaders: Array<{ authorization: string | undefined; protocol: string | undefined }> =
    [];
  let listCalls = 0;
  let toolCalls = 0;
  const server = createServer((request, response) => {
    if (request.method === "DELETE" || request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id?: number;
        method: string;
      };
      seenHeaders.push({
        authorization: request.headers.authorization,
        protocol: request.headers["mcp-protocol-version"] as string | undefined,
      });
      if (message.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (message.method === "initialize") {
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "http-fixture", version: "1.0.0" },
        };
      } else if (message.method === "tools/list") {
        listCalls += 1;
        result = {
          tools: [
            {
              name: "lookup",
              description: "Look up a value",
              inputSchema: {
                type: "object",
                properties: { id: { type: "number" } },
                required: ["id"],
                additionalProperties: false,
              },
            },
          ],
        };
      } else {
        toolCalls += 1;
        result = { content: [{ type: "text", text: "found" }] };
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  context.after(() => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const config: NamedMcpServerConfig = {
    name: "http",
    source: "test",
    definition: {
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: { Authorization: "Bearer ${MCP_TEST_AUTH}", "X-Static": "MCP_TEST_STATIC" },
    },
    config: {
      transport: "http",
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: { Authorization: "Bearer ${MCP_TEST_AUTH}", "X-Static": "MCP_TEST_STATIC" },
      roots: [],
      enabled: true,
      requestTimeoutMs: 5_000,
    },
  };
  const manager = managerFor({
    cwd,
    interactions: [],
    env: { PATH: process.env.PATH, MCP_TEST_AUTH: "test-token", MCP_TEST_STATIC: "static" },
    config,
  });
  context.after(() => manager.dispose());

  const listed = await manager.discoverTools("http");
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ["lookup"],
  );
  const tool = await directTool(manager, config, "lookup");
  const listCallsBeforeExecution = listCalls;
  assert.equal(
    (await tool.execute({ id: 1 }, new AbortController().signal)).content[0]?.type,
    "text",
  );
  assert.equal(listCalls, listCallsBeforeExecution);
  assert.equal(toolCalls, 1);
  assert.equal(
    seenHeaders.every((headers) => headers.authorization === "Bearer test-token"),
    true,
  );
  assert.equal(
    seenHeaders.some((headers) => headers.protocol === "2025-11-25"),
    true,
  );
});
