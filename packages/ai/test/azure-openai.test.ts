// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthError,
  type AuthContext,
  azureOpenAiAuthMethod,
  collectModelStream,
  createAzureOpenAiProvider,
  FakeModelProvider,
  InMemoryCredentialStore,
  login,
  makeFakeModelInfo,
  type ModelStreamEvent,
  normalizeAzureBaseUrl,
  parseDeploymentMap,
} from "../src/index.ts";

const usage = { inputTokens: 20, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 0 };

function makeContext(env: Record<string, string> = {}): AuthContext {
  return { env: (name) => env[name], fileExists: () => Promise.resolve(false) };
}

function sseBody(events: readonly unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

const transcript = [
  { type: "response.reasoning_text.delta", delta: "hmm" },
  { type: "response.output_text.delta", delta: "Hello" },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", call_id: "call-1", name: "shell" },
  },
  { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"command":"ls"}' },
  { type: "response.output_item.done", output_index: 0, item: { type: "function_call" } },
  {
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        input_tokens_details: { cached_tokens: 100 },
      },
    },
  },
];

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function makeFakeFetch(events: readonly unknown[]): {
  fetch: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(sseBody(events), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  return { fetch: fakeFetch, requests };
}

async function makeProvider(events: readonly unknown[], env: Record<string, string>) {
  const store = new InMemoryCredentialStore();
  await login(store, "azure-openai", { type: "api_key", key: "azure-secret-key" });
  const { fetch, requests } = makeFakeFetch(events);
  const provider = createAzureOpenAiProvider({ store, context: makeContext(env), fetch });
  return { provider, requests };
}

test("normalizes Azure base URLs and passes gateways through", () => {
  assert.equal(
    normalizeAzureBaseUrl("https://myres.openai.azure.com"),
    "https://myres.openai.azure.com/openai/v1",
  );
  assert.equal(
    normalizeAzureBaseUrl("https://myres.cognitiveservices.azure.com/openai/"),
    "https://myres.cognitiveservices.azure.com/openai/v1",
  );
  assert.equal(
    normalizeAzureBaseUrl("https://myres.openai.azure.com/openai/v1/responses"),
    "https://myres.openai.azure.com/openai/v1",
  );
  assert.equal(
    normalizeAzureBaseUrl("https://gateway.example.com/azure/"),
    "https://gateway.example.com/azure",
  );
  assert.throws(() => normalizeAzureBaseUrl("not a url"), AuthError);
});

test("exported Azure settings override values saved by interactive login", async () => {
  const resolved = await azureOpenAiAuthMethod.resolve({
    context: makeContext({
      AZURE_OPENAI_BASE_URL: "https://exported.openai.azure.com",
      AZURE_OPENAI_API_VERSION: "2026-01-01",
      AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5=exported",
    }),
    credential: {
      type: "api_key",
      key: "stored-key",
      env: {
        AZURE_OPENAI_BASE_URL: "https://stored.openai.azure.com",
        AZURE_OPENAI_API_VERSION: "2025-01-01",
        AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5=stored",
      },
    },
    signal: new AbortController().signal,
  });

  assert.equal(resolved?.auth.apiKey, "stored-key");
  assert.deepEqual(resolved?.env, {
    AZURE_OPENAI_BASE_URL: "https://exported.openai.azure.com/openai/v1",
    AZURE_OPENAI_API_VERSION: "2026-01-01",
    AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5=exported",
  });
});

test("parses the model-to-deployment map format", () => {
  assert.deepEqual(parseDeploymentMap("gpt-5=gpt-5.6-sol, gpt-4o = prod-4o"), {
    "gpt-5": "gpt-5.6-sol",
    "gpt-4o": "prod-4o",
  });
  assert.deepEqual(parseDeploymentMap(undefined), {});
  assert.deepEqual(parseDeploymentMap("malformed,also=ok"), { also: "ok" });
});

test("streams from Azure with api-key header, versioned URL, and mapped deployment", async () => {
  const { provider, requests } = await makeProvider(transcript, {
    AZURE_OPENAI_RESOURCE_NAME: "myres",
    AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5=gpt-5.6-sol",
  });

  const { events, terminal } = await collectModelStream(
    provider.stream({
      modelId: "gpt-5",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      thinkingLevel: "xhigh",
    }),
  );

  const request = requests[0];
  assert.equal(request?.url, "https://myres.openai.azure.com/openai/v1/responses?api-version=v1");
  assert.equal(request?.headers["api-key"], "azure-secret-key");
  assert.equal(request?.body.model, "gpt-5.6-sol");
  assert.deepEqual(request?.body.reasoning, { effort: "xhigh" });

  assert.equal(events.length, 4);
  assert.equal(terminal.type, "completed");
  if (terminal.type === "completed") {
    assert.equal(terminal.stopReason, "tool_use");
    assert.deepEqual(terminal.usage, { ...usage, reasoningTokens: 0 });
  }
});

test("exit gate: Azure and the fake provider produce identical canonical stream shapes", async () => {
  const canonical: readonly ModelStreamEvent[] = [
    { type: "thinking_delta", text: "hmm" },
    { type: "text_delta", text: "Hello" },
    { type: "tool_call", callId: "call-1", name: "shell", input: { command: "ls" } },
    { type: "completed", stopReason: "tool_use", usage: { ...usage, reasoningTokens: 0 } },
  ];
  const fake = new FakeModelProvider({
    models: [makeFakeModelInfo({ modelId: "gpt-5" })],
    responses: [canonical],
  });
  const { provider: azure } = await makeProvider(transcript, {
    AZURE_OPENAI_RESOURCE_NAME: "myres",
  });

  const request = {
    modelId: "gpt-5",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  } as const;
  const fromFake = await collectModelStream(fake.stream(request));
  const fromAzure = await collectModelStream(azure.stream(request));
  assert.deepEqual(fromAzure.events, fromFake.events);
});

test("capability mismatches fail before any request is dispatched", async () => {
  const { provider, requests } = await makeProvider(transcript, {
    AZURE_OPENAI_RESOURCE_NAME: "myres",
  });
  const models = await provider.listModels();
  assert.equal(
    models.some((model) => model.modelId === "gpt-5"),
    true,
  );

  assert.throws(() => provider.stream({ modelId: "unknown-model", messages: [] }), /no model/);
  assert.equal(requests.length, 0);
});

test("HTTP failures terminate through the stream contract without leaking the key", async () => {
  const store = new InMemoryCredentialStore();
  await login(store, "azure-openai", { type: "api_key", key: "azure-secret-key" });
  const failingFetch = (async () =>
    new Response('{"error":{"message":"deployment not found"}}', { status: 404 })) as typeof fetch;
  const provider = createAzureOpenAiProvider({
    store,
    context: makeContext({ AZURE_OPENAI_RESOURCE_NAME: "myres" }),
    fetch: failingFetch,
  });

  const { terminal } = await collectModelStream(
    provider.stream({ modelId: "gpt-5", messages: [] }),
  );
  assert.equal(terminal.type, "error");
  if (terminal.type === "error") {
    assert.equal(terminal.code, "http_404");
    assert.equal(terminal.retryable, false);
    assert.equal(terminal.message.includes("azure-secret-key"), false);
  }
});

test("cancellation terminates cleanly with an aborted terminal", async () => {
  const controller = new AbortController();
  const store = new InMemoryCredentialStore();
  await login(store, "azure-openai", { type: "api_key", key: "azure-secret-key" });
  const abortingFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    controller.abort();
    (init?.signal as AbortSignal).throwIfAborted();
    throw new Error("unreachable");
  }) as typeof fetch;
  const provider = createAzureOpenAiProvider({
    store,
    context: makeContext({ AZURE_OPENAI_RESOURCE_NAME: "myres" }),
    fetch: abortingFetch,
  });

  const { terminal } = await collectModelStream(
    provider.stream({ modelId: "gpt-5", messages: [], signal: controller.signal }),
    controller.signal,
  );
  assert.deepEqual(terminal, { type: "aborted" });
});

test("missing configuration surfaces a typed auth state through the stream", async () => {
  const provider = createAzureOpenAiProvider({
    store: new InMemoryCredentialStore(),
    context: makeContext({}),
    fetch: (async () => new Response("")) as typeof fetch,
  });
  const { terminal } = await collectModelStream(
    provider.stream({ modelId: "gpt-5", messages: [] }),
  );
  assert.equal(terminal.type, "error");
  if (terminal.type === "error") {
    assert.equal(/not configured/.test(terminal.message), true);
  }
});

test("publishes the complete built-in Azure OpenAI model catalog", async () => {
  const { AZURE_OPENAI_MODELS } = await import("../src/index.ts");
  assert.deepEqual(
    AZURE_OPENAI_MODELS.map((model) => model.modelId),
    [
      "gpt-4",
      "gpt-4-turbo",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "gpt-4o",
      "gpt-4o-2024-05-13",
      "gpt-4o-2024-08-06",
      "gpt-4o-2024-11-20",
      "gpt-4o-mini",
      "gpt-5",
      "gpt-5-chat-latest",
      "gpt-5-mini",
      "gpt-5-nano",
      "gpt-5-pro",
      "gpt-5.1",
      "gpt-5.2",
      "gpt-5.2-chat-latest",
      "gpt-5.2-pro",
      "gpt-5.3-chat-latest",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.4-pro",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-realtime-2.1",
      "o1",
      "o1-pro",
      "o3",
      "o3-mini",
      "o3-pro",
      "o4-mini",
    ],
  );
  assert.equal(new Set(AZURE_OPENAI_MODELS.map((model) => model.modelId)).size, 38);
  assert.equal(
    AZURE_OPENAI_MODELS.every((model) => model.providerId === "azure-openai"),
    true,
  );
  assert.equal(
    AZURE_OPENAI_MODELS.find((model) => model.modelId === "gpt-4")?.capabilities.imageInput,
    false,
  );
  assert.deepEqual(
    AZURE_OPENAI_MODELS.find((model) => model.modelId === "gpt-5.6-sol")?.thinkingLevelMap,
    { off: null, xhigh: "xhigh", max: "max" },
  );
});
