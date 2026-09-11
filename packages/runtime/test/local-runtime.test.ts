// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 Srihari
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileCredentialStore, getStaticModelCatalog } from "@axl/ai";
import { AxlDaemon } from "@axl/daemon";
import { type ModelPort, ToolRegistry } from "@axl/kernel";
import type { ModelStreamEvent } from "@axl/protocol";
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
  const root = await mkdtemp(join(tmpdir(), "axl-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const axlHome = join(root, ".axl");
  const workspace = join(root, "workspace");
  const stateDirectory = join(axlHome, "unsafe");
  const socketPath = join(stateDirectory, "axl.sock");
  await mkdir(workspace, { recursive: true });

  const store = new FileCredentialStore(join(axlHome, "credentials.json"));
  const customSource = getStaticModelCatalog("deepseek")[0];
  if (customSource === undefined) throw new Error("DeepSeek catalog is empty");
  await mkdir(axlHome, { recursive: true });
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
    defaults: { modelId: "gpt-5", thinkingLevel: "medium" },
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
  const opened = await client.request("session.create", { cwd: workspace });
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
    ["bash", "read", "write", "edit", "web_fetch", "web_search"],
  );
  assert.deepEqual(events.find((event) => event.type === "config.request")?.payload, {
    maxOutputTokens: null,
    httpIdleTimeoutMs: 300_000,
  });
  assert.deepEqual(events.find((event) => event.type === "config.profile")?.payload, {
    profile: "standard",
  });
  assert.deepEqual(events.find((event) => event.type === "config.tools")?.payload, {
    webFetch: true,
    webSearch: true,
  });

  const delegated = await client.request("session.create", {
    cwd: workspace,
    subagents: true,
  });
  const delegatedSubscription = await client.request("session.subscribe", {
    sessionId: delegated.sessionId,
  });
  const delegatedEvents = delegatedSubscription.snapshot?.page.events ?? [];
  assert.deepEqual(
    delegatedEvents
      .filter((event) => event.type === "tool.schema")
      .map((event) => (event.type === "tool.schema" ? event.payload.name : "")),
    ["bash", "read", "write", "edit", "subagent", "subagent_message", "web_fetch", "web_search"],
  );
  assert.deepEqual(delegatedEvents.find((event) => event.type === "config.tools")?.payload, {
    webFetch: true,
    webSearch: true,
    subagents: true,
  });

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
