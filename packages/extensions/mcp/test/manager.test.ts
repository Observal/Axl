// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";

import type { ModelPort } from "@axl/kernel";
import type { JsonObject, ModelStreamEvent } from "@axl/protocol";

import { McpManager, type McpInteractionRequest } from "../src/index.ts";

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

function parseResult(result: Awaited<ReturnType<ReturnType<McpManager["makeTool"]>["execute"]>>) {
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  return JSON.parse(text) as unknown;
}

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

async function execute(manager: McpManager, input: JsonObject) {
  return manager.makeTool().execute(input, new AbortController().signal);
}

test("stdio MCP supports discovery, tools, resources, prompts, roots, sampling, and elicitation", async (context) => {
  const cwd = await workspace(context);
  const seen: McpInteractionRequest[] = [];
  let cleanupCalls = 0;
  const manager = managerFor({
    cwd,
    interactions: seen,
    secretValues: ["top-secret"],
    cleanup: () => {
      cleanupCalls += 1;
      return Promise.resolve();
    },
    config: {
      name: "fixture",
      source: "test",
      config: {
        transport: "stdio",
        command: process.execPath,
        args: [fixtureServer],
        env: {},
        roots: [cwd],
        enabled: true,
        requestTimeoutMs: 5_000,
      },
    },
  });
  context.after(() => manager.dispose());

  const tools = parseResult(
    await execute(manager, { action: "list_tools", server: "fixture" }),
  ) as {
    tools: Array<{ name: string }>;
  };
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ["echo", "interactive", "tasker"],
  );
  const echoed = await execute(manager, {
    action: "call_tool",
    server: "fixture",
    name: "echo",
    arguments: { text: "top-secret" },
  });
  assert.equal(echoed.content[0]?.type === "text" && echoed.content[0].text, "[REDACTED]");
  const task = await execute(manager, {
    action: "call_tool",
    server: "fixture",
    name: "tasker",
    arguments: {},
  });
  assert.equal(task.content[0]?.type === "text" && task.content[0].text, "task complete");
  const tasks = parseResult(
    await execute(manager, { action: "list_tasks", server: "fixture" }),
  ) as { tasks: Array<{ taskId: string; status: string }> };
  assert.deepEqual(
    tasks.tasks.map(({ taskId, status }) => ({ taskId, status })),
    [{ taskId: "task-1", status: "completed" }],
  );

  const resources = parseResult(
    await execute(manager, { action: "list_resources", server: "fixture" }),
  ) as { resources: Array<{ uri: string }> };
  assert.equal(resources.resources[0]?.uri, "fixture://readme");
  const resource = await execute(manager, {
    action: "read_resource",
    server: "fixture",
    uri: "fixture://readme",
  });
  assert.equal(resource.content[0]?.type === "text" && resource.content[0].text, "resource");

  const prompt = parseResult(
    await execute(manager, {
      action: "get_prompt",
      server: "fixture",
      name: "review",
      arguments: { topic: "TypeScript" },
    }),
  ) as { messages: Array<{ content: { text: string } }> };
  assert.equal(prompt.messages[0]?.content.text, "Review TypeScript");

  const interactive = await execute(manager, {
    action: "call_tool",
    server: "fixture",
    name: "interactive",
    arguments: {},
  });
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

test("Streamable HTTP completes OAuth discovery, PKCE, registration, and token use", async (context) => {
  const cwd = await workspace(context);
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
  const approvals: McpInteractionRequest[] = [];
  const manager = new McpManager({
    servers: [
      {
        name: "oauth",
        source: "test",
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

  const result = parseResult(await execute(manager, { action: "list_tools", server: "oauth" })) as {
    tools: unknown[];
  };
  assert.deepEqual(result.tools, []);
  assert.equal(authenticated, true);
  assert.equal(approvals.length, 1);
});

test("Streamable HTTP sends configured headers and negotiates 2025-11-25", async (context) => {
  const cwd = await workspace(context);
  const seenHeaders: Array<{ authorization: string | undefined; protocol: string | undefined }> =
    [];
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
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "http-fixture", version: "1.0.0" },
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

  const manager = managerFor({
    cwd,
    interactions: [],
    env: { PATH: process.env.PATH, MCP_TEST_AUTH: "Bearer test-token" },
    config: {
      name: "http",
      source: "test",
      config: {
        transport: "http",
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: { Authorization: "MCP_TEST_AUTH" },
        roots: [],
        enabled: true,
        requestTimeoutMs: 5_000,
      },
    },
  });
  context.after(() => manager.dispose());

  const listed = parseResult(await execute(manager, { action: "list_tools", server: "http" })) as {
    tools: unknown[];
  };
  assert.deepEqual(listed.tools, []);
  assert.equal(
    seenHeaders.every((headers) => headers.authorization === "Bearer test-token"),
    true,
  );
  assert.equal(
    seenHeaders.some((headers) => headers.protocol === "2025-11-25"),
    true,
  );
});
