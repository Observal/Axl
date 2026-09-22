// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 Srihari
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FileCredentialStore, getStaticModelCatalog } from "@axl/ai";
import { AxlDaemon } from "@axl/daemon";
import { type ModelPort, ToolRegistry } from "@axl/kernel";
import type { CanonicalEvent, ModelStreamEvent } from "@axl/protocol";
import { AxlClientError } from "@axl/sdk";
import { connectUnixClient } from "@axl/sdk/unix";

import {
  listLocalSessions,
  localSandboxStateKey,
  loginProviderFromTrustedHost,
  startLocalDaemon,
} from "../src/index.ts";

test("provider output cannot persist rotating request credentials", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-runtime-redaction-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const axlHome = join(root, ".axl");
  const workspace = join(root, "workspace");
  const stateDirectory = join(axlHome, "unsafe");
  await mkdir(workspace, { recursive: true });
  let secret = "first-provider-secret";
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const events =
      requests % 2 === 1
        ? [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "message", id: `m-${requests}` },
            },
            { type: "response.output_text.delta", output_index: 0, delta: secret },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: { type: "message", id: `m-${requests}`, content: [] },
            },
            {
              type: "response.output_item.added",
              output_index: 1,
              item: {
                type: "function_call",
                id: `f-${requests}`,
                call_id: `call-${requests}`,
                name: "read",
              },
            },
            {
              type: "response.function_call_arguments.delta",
              output_index: 1,
              delta: JSON.stringify({ path: secret }),
            },
            {
              type: "response.output_item.done",
              output_index: 1,
              item: {
                type: "function_call",
                id: `f-${requests}`,
                call_id: `call-${requests}`,
                name: "read",
                arguments: JSON.stringify({ path: secret }),
              },
            },
            {
              type: "response.completed",
              response: { id: `r-${requests}`, status: "completed", usage: {} },
            },
          ]
        : [
            {
              type: "response.completed",
              response: { id: `r-${requests}`, status: "completed", usage: {} },
            },
          ];
    response.end(
      `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  context.after(() => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  const source = getStaticModelCatalog("openai").find(
    (model) => model.apiDialect === "openai-responses",
  );
  if (source === undefined) throw new Error("OpenAI Responses catalog is empty");
  await mkdir(axlHome, { recursive: true });
  await writeFile(
    join(axlHome, "models.json"),
    JSON.stringify({
      providers: {
        custom: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKeyEnvironmentVariables: ["AXL_TEST_CUSTOM_KEY"],
          models: [{ ...source, providerId: "custom", modelId: "echo-model" }],
        },
      },
    }),
  );
  process.env.AXL_TEST_CUSTOM_KEY = secret;
  context.after(() => delete process.env.AXL_TEST_CUSTOM_KEY);
  const socketPath = join(stateDirectory, "axl.sock");
  const daemon = await startLocalDaemon({
    axlHome,
    stateDirectory,
    socketPath,
    defaults: { providerId: "custom", modelId: "echo-model", thinkingLevel: "off" },
    store: new FileCredentialStore(join(axlHome, "credentials.json")),
    unsafe: true,
  });
  context.after(() => daemon.stop());
  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());
  const created = await client.request("session.create", { cwd: workspace });
  await client.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "first" }],
  });
  secret = "rotated-provider-secret";
  process.env.AXL_TEST_CUSTOM_KEY = secret;
  await client.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "second" }],
  });
  const raw = await readFile(
    join(stateDirectory, "sessions", `${created.sessionId}.jsonl`),
    "utf8",
  );
  assert.equal(raw.includes("first-provider-secret"), false);
  assert.equal(raw.includes("rotated-provider-secret"), false);
  assert.equal(raw.includes("[REDACTED]"), true);
});

test("OCI state keys require a digest and cannot traverse directories", () => {
  assert.equal(
    localSandboxStateKey({
      type: "oci",
      engine: "podman",
      image: `example.invalid/image@sha256:${"a".repeat(64)}`,
    }),
    join("oci", "podman", "a".repeat(64)),
  );
  assert.throws(
    () =>
      localSandboxStateKey({
        type: "oci",
        engine: "docker",
        image: "example.invalid/image@sha256:../../outside",
      }),
    /must be pinned/,
  );
});

test("discovers native and unsafe histories with explicit placement labels", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-runtime-catalog-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const axlHome = join(root, ".axl");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
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
  const start = async (directory: string, enforced: boolean) => {
    const daemon = new AxlDaemon({
      socketPath: join(directory, "test.sock"),
      dataDirectory: directory,
      securityMode: enforced ? "sandboxed" : "unsafe",
      sandboxProvider: enforced ? "bubblewrap" : "none",
      runtime: () => ({
        model,
        tools: new ToolRegistry(),
        sandbox: { provider: enforced ? "bubblewrap" : "none", enforced, controls: [] },
      }),
    });
    await daemon.start();
    context.after(() => daemon.stop());
    return (await daemon.sessions.create(workspace)).sessionId;
  };
  const nativeId = await start(axlHome, true);
  const unsafeId = await start(join(axlHome, "unsafe"), false);
  const sessions = await listLocalSessions(axlHome);
  assert.deepEqual(
    new Map(sessions.map((session) => [session.sessionId, session.placementLabel])),
    new Map([
      [nativeId, "SANDBOXED · native"],
      [unsafeId, "UNSAFE"],
    ]),
  );
});

test("assembles an authoritative local runtime without a presentation client", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "axl-runtime-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const axlHome = join(root, ".axl");
  const workspace = join(root, "workspace");
  const stateDirectory = join(axlHome, "unsafe");
  const socketPath = join(stateDirectory, "axl.sock");
  await mkdir(join(workspace, ".axl", "skills", "ignored"), { recursive: true });
  await writeFile(join(workspace, "AGENTS.md"), "Use the repository instructions.\n");
  await writeFile(
    join(workspace, ".axl", "skills", "ignored", "SKILL.md"),
    "---\nname: ignored\ndescription: Must not enter the stable prompt.\n---\nIgnored.\n",
  );

  const store = new FileCredentialStore(join(axlHome, "credentials.json"));
  const customSource = getStaticModelCatalog("deepseek")[0];
  if (customSource === undefined) throw new Error("DeepSeek catalog is empty");
  await mkdir(axlHome, { recursive: true });
  await writeFile(
    join(axlHome, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        broken: { command: process.execPath, args: ["-e", "process.exit(7)"] },
        fixture: {
          command: process.execPath,
          args: [
            join(
              dirname(fileURLToPath(import.meta.url)),
              "../../extensions/mcp/test/fixtures/server.mjs",
            ),
          ],
          roots: ["."],
        },
      },
    }),
  );
  await writeFile(
    join(axlHome, "models.json"),
    JSON.stringify({
      providers: {
        custom: {
          baseUrl: "http://127.0.0.1:11434/v1",
          models: [{ ...customSource, providerId: "custom", modelId: "local-model" }],
        },
      },
    }),
  );
  await store.modify("azure-openai", () =>
    Promise.resolve({
      type: "api_key",
      key: "obviously-fake-runtime-test-key",
      env: { AZURE_OPENAI_BASE_URL: "https://example.invalid/openai/v1" },
    }),
  );

  const daemon = await startLocalDaemon({
    axlHome,
    stateDirectory,
    socketPath,
    defaults: {
      modelId: "gpt-5",
      thinkingLevel: "medium",
      compaction: {
        enabled: true,
        reserveTokens: 12_000,
        keepRecentTokens: 20_000,
        modelOverrides: { "azure-openai-responses/gpt-5": { keepRecentTokens: 30_000 } },
      },
    },
    store,
    unsafe: true,
  });
  context.after(() => daemon.stop());
  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());

  assert.deepEqual(await client.request("daemon.info", {}), {
    securityMode: "unsafe",
    sandboxProvider: "none",
  });
  assert.equal(
    (await client.listCommands()).commands.some((command) => command.name === "mcp"),
    true,
  );
  assert.deepEqual(
    (await client.listMcpServers()).servers.map((server) => [server.name, server.status]),
    [
      ["broken", "pending"],
      ["fixture", "pending"],
    ],
  );
  assert.deepEqual(
    (
      await client.batchUpsertMcpServers({
        servers: [
          { name: "docs", definition: { url: "https://mcp.example.com/mcp" } },
          { name: "local", definition: { command: "example-mcp", enabled: false } },
        ],
      })
    ).servers.map((server) => server.name),
    ["broken", "docs", "fixture", "local"],
  );
  assert.equal((await client.removeMcpServer({ name: "docs" })).changed, true);
  assert.equal((await client.removeMcpServer({ name: "local" })).changed, true);
  const probed = await client.probeMcpServer({
    name: "fixture",
    definition: {
      command: process.execPath,
      args: [
        join(
          dirname(fileURLToPath(import.meta.url)),
          "../../extensions/mcp/test/fixtures/server.mjs",
        ),
      ],
      roots: ["."],
    },
  });
  assert.deepEqual(
    probed.tools.map((tool) => tool.name),
    ["echo", "interactive", "tasker"],
  );
  await assert.rejects(
    client.probeMcpServer({
      name: "broken",
      definition: { command: process.execPath, args: ["-e", "process.exit(7)"] },
    }),
    (error) =>
      error instanceof AxlClientError &&
      error.code === "mcp_probe_failed" &&
      error.details?.server === "broken",
  );
  await assert.rejects(
    client.probeMcpServer({ name: "plain", definition: { url: "http://example.com/mcp" } }),
    (error) => error instanceof AxlClientError && error.code === "mcp_probe_failed",
  );
  assert.equal(
    (await client.listMcpServers()).servers.find((server) => server.name === "fixture")?.status,
    "discovered",
  );
  const allProviders = await client.listProviders();
  assert.equal(allProviders.providers.length, 41);
  assert.deepEqual(
    allProviders.providers
      .find((provider) => provider.providerId === "custom")
      ?.models.map((model) => model.modelId),
    ["local-model"],
  );
  const inventory = await client.listProviders({ providerId: "azure-openai-responses" });
  assert.equal(inventory.providers.length, 1);
  assert.deepEqual(inventory.providers[0]?.loginMethods, ["api_key"]);
  assert.equal(
    inventory.providers[0]?.models.some((model) => model.modelId === "gpt-5"),
    true,
  );
  assert.equal(JSON.stringify(inventory).includes("obviously-fake-runtime-test-key"), false);
  assert.deepEqual(
    await client.providerAuthenticationStatus({ providerId: "azure-openai-responses" }),
    {
      providers: [
        {
          providerId: "azure-openai-responses",
          phase: "authenticated",
          method: "api_key",
          source: "Azure OpenAI API key",
        },
      ],
    },
  );
  await assert.rejects(
    client.request("session.create", {
      cwd: workspace,
      providerId: "missing-provider",
      modelId: "missing-model",
    }),
    (error) =>
      error instanceof AxlClientError &&
      error.code === "provider_not_found" &&
      error.details?.action === "configure_provider",
  );
  await assert.rejects(
    client.loginProvider({ providerId: "deepseek", method: "api_key" }),
    (error) => error instanceof AxlClientError && error.code === "authentication_unavailable",
  );
  const prompts = { requesting: 0, other: 0 };
  const login = await loginProviderFromTrustedHost({
    store,
    axlHome,
    providerId: "deepseek",
    method: "api_key",
    adapter: {
      createInteraction: () => ({
        prompt: async () => {
          prompts.requesting += 1;
          return "runtime-login-secret";
        },
        notify: () => {},
      }),
    },
  });
  const unrelatedAdapter = {
    createInteraction: () => ({
      prompt: async () => {
        prompts.other += 1;
        return "wrong-client-secret";
      },
      notify: () => {},
    }),
  };
  void unrelatedAdapter;
  assert.equal(login.phase, "authenticated");
  assert.deepEqual(prompts, { requesting: 1, other: 0 });
  assert.equal(JSON.stringify(login).includes("runtime-login-secret"), false);
  assert.deepEqual(await client.logoutProvider({ providerId: "deepseek" }), {
    providerId: "deepseek",
    phase: "logged_out",
  });
  const opened = await client.request("session.create", {
    cwd: workspace,
    userQuestions: true,
  });
  const subscription = await client.request("session.subscribe", {
    sessionId: opened.sessionId,
  });
  assert.ok(subscription.snapshot?.page.complete);
  const events = subscription.snapshot.page.events;
  await client.request("session.ack", {
    subscriptionId: subscription.subscriptionId,
    cursor: subscription.snapshot.boundaryCursor,
  });
  const sandbox = events.find((event) => event.type === "sandbox.configured");
  assert.deepEqual(sandbox?.type === "sandbox.configured" ? sandbox.payload : undefined, {
    provider: "none",
    enforced: false,
    controls: [],
  });
  assert.deepEqual(
    events
      .filter((event) => event.type === "tool.schema")
      .map((event) => (event.type === "tool.schema" ? event.payload.name : "")),
    [
      "bash",
      "read",
      "write",
      "edit",
      "web_fetch",
      "web_search",
      "ask_user_question",
      "capability_search",
    ],
  );
  const mcpCache = JSON.parse(await readFile(join(axlHome, "cache", "mcp-tools.json"), "utf8")) as {
    servers: Array<{ server: string; tools: Array<{ name: string }> }>;
    failures: Array<{ server: string; error: string }>;
  };
  assert.equal(mcpCache.servers[0]?.server, "fixture");
  assert.deepEqual(
    mcpCache.servers[0]?.tools.map((tool) => tool.name),
    ["echo", "interactive", "tasker"],
  );
  assert.deepEqual(
    mcpCache.failures.map((failure) => failure.server),
    ["broken"],
  );
  const projected = await client.listMcpServers();
  assert.deepEqual(
    projected.servers.map((server) => [server.name, server.status, server.tools.length]),
    [
      ["broken", "failed", 0],
      ["fixture", "discovered", 3],
    ],
  );
  assert.ok((projected.servers[0]?.error?.length ?? 0) > 0);
  const prompt = events
    .filter((event) => event.type === "prompt.section")
    .map((event) => (event.type === "prompt.section" ? event.payload.content : ""))
    .join("\n\n");
  assert.match(prompt, /<project_instructions path=.*AGENTS\.md/);
  assert.match(prompt, /Use the repository instructions\./);
  assert.doesNotMatch(prompt, /Must not enter the stable prompt|<available_skills>/);
  assert.deepEqual(events.find((event) => event.type === "context.resources")?.payload, {
    resources: [
      {
        kind: "agents",
        scope: "project",
        path: join(workspace, "AGENTS.md"),
        content: "Use the repository instructions.",
      },
    ],
  });

  const pushed: CanonicalEvent[] = [];
  client.onEvent((message) => pushed.push(message.event));
  await writeFile(join(workspace, "AGENTS.override.md"), "Use the reloaded override.\n");
  const reloaded = await client.request("session.reload", { sessionId: opened.sessionId });
  const reloadedResources = pushed.find(
    (event) => event.type === "context.resources" && reloaded.boundaryEventIds.includes(event.id),
  );
  assert.deepEqual(
    reloadedResources?.type === "context.resources"
      ? reloadedResources.payload.resources.map(({ path, content }) => [path, content])
      : undefined,
    [[join(workspace, "AGENTS.override.md"), "Use the reloaded override."]],
  );

  assert.deepEqual(events.find((event) => event.type === "config.request")?.payload, {
    maxOutputTokens: null,
    httpIdleTimeoutMs: 300_000,
  });
  assert.deepEqual(events.find((event) => event.type === "config.compaction")?.payload, {
    enabled: true,
    reserveTokens: 12_000,
    keepRecentTokens: 30_000,
  });
  assert.deepEqual(events.find((event) => event.type === "config.profile")?.payload, {
    profile: "standard",
  });
  assert.deepEqual(events.find((event) => event.type === "config.tools")?.payload, {
    webFetch: true,
    webSearch: true,
    userQuestions: true,
  });

  const unattended = await client.request("session.create", { cwd: workspace });
  const unattendedSubscription = await client.request("session.subscribe", {
    sessionId: unattended.sessionId,
  });
  assert.equal(
    unattendedSubscription.snapshot?.page.events.some(
      (event) => event.type === "tool.schema" && event.payload.name === "ask_user_question",
    ),
    false,
  );
  assert.equal(
    unattendedSubscription.snapshot?.page.events
      .filter((event) => event.type === "prompt.section")
      .some(
        (event) =>
          event.type === "prompt.section" && event.payload.content.includes("ask_user_question"),
      ),
    false,
  );

  for (const [profile, expectedTools] of [
    ["minimal", ["bash", "edit"]],
    ["exec", ["bash"]],
    ["chat", []],
  ] as const) {
    const createdProfile = await client.request("session.create", { cwd: workspace, profile });
    const subscribed = await client.request("session.subscribe", {
      sessionId: createdProfile.sessionId,
    });
    assert.deepEqual(
      subscribed.snapshot?.page.events
        .filter((event) => event.type === "tool.schema")
        .map((event) => (event.type === "tool.schema" ? event.payload.name : "")),
      expectedTools,
    );
  }
});

test("disposes loaded daemon extensions when later runtime setup fails", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "axl-runtime-extension-cleanup-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const axlHome = join(root, ".axl");
  const workspace = join(root, "workspace");
  const stateDirectory = join(axlHome, "unsafe");
  const socketPath = join(stateDirectory, "axl.sock");
  const marker = join(root, "cleanup.txt");
  await mkdir(join(axlHome, "extensions"), { recursive: true });
  await mkdir(workspace);
  await writeFile(
    join(axlHome, "extensions", "cleanup.js"),
    `import { appendFile } from "node:fs/promises";\nexport default (axl) => axl.track(() => appendFile(${JSON.stringify(marker)}, "disposed\\n"));\n`,
  );
  await writeFile(join(axlHome, "mcp.json"), "{ invalid json\n");
  const daemon = await startLocalDaemon({
    axlHome,
    stateDirectory,
    socketPath,
    defaults: { modelId: "gpt-5", thinkingLevel: "off" },
    store: new FileCredentialStore(join(axlHome, "credentials.json")),
    unsafe: true,
  });
  context.after(() => daemon.stop());
  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());

  await assert.rejects(client.request("session.create", { cwd: workspace }), AxlClientError);
  assert.equal(await readFile(marker, "utf8"), "disposed\n");
});

test("manages global, explicit, and trusted project daemon extensions through the SDK", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "axl-runtime-extension-manager-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const axlHome = join(root, ".axl");
  const workspace = join(root, "workspace");
  const stateDirectory = join(axlHome, "unsafe");
  const socketPath = join(stateDirectory, "axl.sock");
  const marker = join(root, "loaded.txt");
  await mkdir(join(axlHome, "extensions"), { recursive: true });
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(join(workspace, ".axl", "extensions"), { recursive: true });
  const source = (name: string) =>
    `import { appendFile } from "node:fs/promises";\nexport default async (axl) => { await appendFile(${JSON.stringify(marker)}, ${JSON.stringify(`${name}\n`)}); axl.on("resources_discover", () => [{ name: "${name}-rules", content: "${name} rules" }]); axl.registerTool({ name: ${JSON.stringify(`${name}_tool`)}, description: ${JSON.stringify(name)}, inputSchema: { type: "object" }, execute: () => ({ content: [] }) }); };\n`;
  await writeFile(join(axlHome, "extensions", "global.js"), source("global"));
  await writeFile(join(workspace, ".axl", "extensions", "project.js"), source("project"));
  const explicitPath = join(root, "explicit.js");
  await writeFile(explicitPath, source("explicit"));

  const daemon = await startLocalDaemon({
    axlHome,
    stateDirectory,
    socketPath,
    defaults: { modelId: "gpt-5", thinkingLevel: "off" },
    store: new FileCredentialStore(join(axlHome, "credentials.json")),
    unsafe: true,
  });
  context.after(() => daemon.stop());
  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());
  const opened = await client.request("session.create", { cwd: workspace });

  assert.deepEqual(
    (await client.listExtensions({ sessionId: opened.sessionId })).extensions.map(
      (item) => item.id,
    ),
    ["global"],
  );
  const initial = await client.request("session.subscribe", { sessionId: opened.sessionId });
  assert.equal(
    initial.snapshot?.page.events.some(
      (event) =>
        event.type === "context.resources" &&
        event.payload.resources.some(
          (resource) => resource.path === "extension:global/global-rules",
        ),
    ),
    true,
  );
  const trusted = await client.trustExtensionProject({
    sessionId: opened.sessionId,
    trusted: true,
  });
  assert.equal(trusted.project.trusted, true);
  assert.deepEqual(
    trusted.extensions.map((item) => item.id),
    ["global", "project"],
  );
  const disabled = await client.disableExtension({
    sessionId: opened.sessionId,
    extensionId: "project",
  });
  assert.equal(disabled.extensions.find((item) => item.id === "project")?.enabled, false);
  await client.enableExtension({ sessionId: opened.sessionId, extensionId: "project" });
  const installed = await client.installExtension({
    sessionId: opened.sessionId,
    source: { type: "path", path: explicitPath },
  });
  assert.equal(installed.changedExtensionId, "explicit");
  await client.reloadExtension({ sessionId: opened.sessionId, extensionId: "explicit" });
  const removed = await client.removeExtension({
    sessionId: opened.sessionId,
    extensionId: "explicit",
  });
  assert.equal(
    removed.extensions.some((item) => item.id === "explicit"),
    false,
  );
  assert.match(await readFile(marker, "utf8"), /global\nproject\n/u);
});
