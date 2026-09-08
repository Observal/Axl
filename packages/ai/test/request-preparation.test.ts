// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  makeFakeModelInfo,
  prepareModelRequest,
  RequestPreparationError,
  validateModelCatalog,
  type ModelInfo,
  type ModelRequest,
} from "../src/index.ts";

const textRequest = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  modelId: "target-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  ...overrides,
});

function targetModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return makeFakeModelInfo({
    providerId: "target-provider",
    modelId: "target-model",
    apiDialect: "openai-chat",
    compatibility: {
      dialect: "openai-chat",
      supportsStrictTools: true,
      supportsGrammarTools: true,
    },
    ...overrides,
  });
}

test("normalizes history tool identifiers and preserves canonical tool identity", async () => {
  const foreign = {
    providerId: "source-provider",
    apiDialect: "openai-responses",
    modelId: "source-model",
  } as const;
  const request = textRequest({
    tools: [
      {
        name: "browser.open",
        description: "Open a page",
        inputSchema: { type: "object" },
      },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "open it" }] },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            text: "I should use the browser",
            signature: { ...foreign, value: "opaque-thinking" },
          },
          {
            type: "text",
            text: "Opening",
            continuation: { ...foreign, itemId: "message-item" },
          },
        ],
        toolCalls: [
          {
            callId: "call|with/invalid+characters".repeat(4),
            name: "browser.open",
            input: { url: "https://example.test" },
            signature: { ...foreign, value: "opaque-tool" },
          },
        ],
      },
      {
        role: "tool",
        callId: "call|with/invalid+characters".repeat(4),
        name: "browser.open",
        content: [{ type: "text", text: "done" }],
        isError: false,
      },
    ],
  });

  const prepared = await prepareModelRequest(targetModel(), request);
  const tool = prepared.tools?.[0];
  const assistant = prepared.messages[1];
  const result = prepared.messages[2];

  assert.equal(tool?.canonicalName, "browser.open");
  assert.equal(tool?.name, "browser_open");
  assert.equal(assistant?.role, "assistant");
  assert.equal(result?.role, "tool");
  if (assistant?.role !== "assistant" || result?.role !== "tool") assert.fail("unexpected history");
  const call = assistant.toolCalls?.[0];
  assert.match(call?.callId ?? "", /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(call?.canonicalName, "browser.open");
  assert.equal(
    call?.canonicalCallId,
    request.messages[1]?.role === "assistant"
      ? request.messages[1].toolCalls?.[0]?.callId
      : undefined,
  );
  assert.equal(result.callId, call?.callId);
  assert.equal(result.canonicalCallId, call?.canonicalCallId);
  assert.equal(result.name, "browser_open");
  assert.deepEqual(prepared.preparation.sanitizations, [
    {
      path: "request.messages[1].content[0].signature",
      reason: "foreign-provider-signature",
    },
    {
      path: "request.messages[1].content[1].continuation",
      reason: "foreign-provider-continuation",
    },
    {
      path: "request.messages[1].toolCalls[0].signature",
      reason: "foreign-provider-signature",
    },
  ]);
  const thinking = assistant.content[0];
  const text = assistant.content[1];
  assert.ok(thinking);
  assert.ok(text);
  assert.equal("signature" in thinking, false);
  assert.equal("continuation" in text, false);
});

test("accepts a tool-only assistant message", async () => {
  const prepared = await prepareModelRequest(
    targetModel(),
    textRequest({
      messages: [
        { role: "user", content: [{ type: "text", text: "inspect" }] },
        {
          role: "assistant",
          content: [],
          toolCalls: [{ callId: "call-1", name: "read", input: { path: "README.md" } }],
        },
        {
          role: "tool",
          callId: "call-1",
          name: "read",
          content: [{ type: "text", text: "contents" }],
          isError: false,
        },
      ],
    }),
  );

  assert.deepEqual(prepared.messages[1]?.content, []);
  await assert.rejects(
    () =>
      prepareModelRequest(
        targetModel(),
        textRequest({ messages: [{ role: "assistant", content: [] }] }),
      ),
    /must not be empty without an assistant tool call/,
  );
});

test("retains replay metadata only for its exact issuing model", async () => {
  const identity = {
    providerId: "target-provider",
    apiDialect: "openai-chat",
    modelId: "target-model",
  } as const;
  const prepared = await prepareModelRequest(
    targetModel(),
    textRequest({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "", signature: { ...identity, value: "signed" } },
            {
              type: "text",
              text: "answer",
              continuation: { ...identity, responseId: "response-1", itemId: "item-1" },
            },
          ],
          origin: identity,
          continuation: { ...identity, responseId: "response-1" },
        },
      ],
    }),
  );

  const message = prepared.messages[0];
  assert.equal(message?.role, "assistant");
  if (message?.role !== "assistant") assert.fail("unexpected history");
  assert.equal(
    message.content[0]?.type === "thinking" ? message.content[0].signature?.value : undefined,
    "signed",
  );
  assert.equal(message.continuation?.responseId, "response-1");
  assert.deepEqual(prepared.preparation.sanitizations, []);
});

test("loads each image blob once and verifies size and digest", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let reads = 0;
  const reference = { sha256, mediaType: "image/png", sizeBytes: bytes.byteLength };
  const prepared = await prepareModelRequest(
    targetModel({ capabilities: { toolUse: true, structuredOutput: true, imageInput: true } }),
    textRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "blob", blob: reference },
            { type: "blob", blob: reference },
          ],
        },
      ],
      readBlob: async () => {
        reads += 1;
        return bytes;
      },
    }),
  );

  assert.equal(reads, 1);
  assert.equal(prepared.preparation.blobs.size, 1);
  assert.deepEqual(await prepared.readBlob?.(reference), bytes);
});

test("rejects unsupported media and changed blob bytes", async () => {
  const bytes = new Uint8Array([1]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const request = textRequest({
    messages: [
      {
        role: "user",
        content: [{ type: "blob", blob: { sha256, mediaType: "image/png", sizeBytes: 1 } }],
      },
    ],
    readBlob: async () => new Uint8Array([2]),
  });
  await assert.rejects(
    () => prepareModelRequest(targetModel(), request),
    /does not support: imageInput/,
  );
  await assert.rejects(
    () =>
      prepareModelRequest(
        targetModel({ capabilities: { toolUse: true, structuredOutput: true, imageInput: true } }),
        request,
      ),
    /content hash does not match/,
  );
});

test("prepares strict and grammar constrained tools without changing canonical names", async () => {
  const prepared = await prepareModelRequest(
    targetModel(),
    textRequest({
      tools: [
        {
          name: "search.docs",
          description: "Search documentation",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" }, limit: { type: "number" } },
            required: ["query"],
          },
          constraint: { type: "json-schema", strict: "require" },
        },
        {
          name: "write.expression",
          description: "Write an expression",
          inputSchema: {
            type: "object",
            properties: { expression: { type: "string" } },
            required: ["expression"],
          },
          constraint: { type: "grammar", variants: { lark: "start: NUMBER" } },
        },
      ],
    }),
  );

  const strict = prepared.tools?.[0];
  const grammar = prepared.tools?.[1];
  assert.equal(strict?.canonicalName, "search.docs");
  assert.equal(strict?.name, "search_docs");
  assert.deepEqual(strict?.preparedConstraint, { type: "json-schema", strict: true });
  assert.deepEqual(strict?.inputSchema.required, ["query", "limit"]);
  assert.equal(strict?.inputSchema.additionalProperties, false);
  assert.deepEqual(grammar?.preparedConstraint, {
    type: "grammar",
    format: "lark",
    definition: "start: NUMBER",
    inputProperty: "expression",
  });
});

test("rejects required constrained sampling that the model cannot honor", async () => {
  const unsupported = targetModel({
    compatibility: {
      dialect: "openai-chat",
      supportsStrictTools: false,
      supportsGrammarTools: false,
    },
  });
  const strictRequest = textRequest({
    tools: [
      {
        name: "strict",
        description: "Strict",
        inputSchema: { type: "object" },
        constraint: { type: "json-schema", strict: "require" },
      },
    ],
  });
  await assert.rejects(
    () => prepareModelRequest(unsupported, strictRequest),
    /strict schemas unsupported/,
  );
  await assert.rejects(
    () =>
      prepareModelRequest(
        unsupported,
        textRequest({
          tools: [
            {
              name: "grammar",
              description: "Grammar",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
              },
              constraint: { type: "grammar", variants: { regex: ".+" } },
            },
          ],
        }),
      ),
    /grammar tools unsupported/,
  );
});

test("resolves reasoning, cache placement, and validated sampling controls", async () => {
  const model = targetModel({
    maxOutputTokens: 20_000,
    thinkingLevelMap: { low: null, medium: "standard", high: "high" },
    cache: {
      supported: true,
      defaultRetention: "short",
      supportedRetentions: ["none", "short", "long"],
    },
    sampling: {
      supported: [
        "temperature",
        "topP",
        "topK",
        "minP",
        "frequencyPenalty",
        "presencePenalty",
        "repetitionPenalty",
        "seed",
      ],
      customFields: ["mirostat"],
    },
    compatibility: {
      dialect: "openai-chat",
      supportsStrictTools: true,
      supportsGrammarTools: true,
      thinkingTokenBudgetField: "thinking_budget_tokens",
      cacheControlFormat: "anthropic",
      supportsLongCacheRetention: true,
    },
  });
  const prepared = await prepareModelRequest(
    model,
    textRequest({
      system: "stable system",
      thinkingLevel: "low",
      thinkingBudgets: { medium: 2_000 },
      maxOutputTokens: 3_000,
      cache: { retention: "long", sessionId: "session-1" },
      sampling: {
        temperature: 0.2,
        topP: 0.9,
        topK: 20,
        minP: 0.1,
        frequencyPenalty: -0.5,
        presencePenalty: 0.5,
        repetitionPenalty: 1.1,
        seed: 7,
        custom: { mirostat: 2 },
      },
      tools: [{ name: "read", description: "Read", inputSchema: { type: "object" } }],
    }),
  );

  assert.deepEqual(prepared.preparation.reasoning, {
    requested: "low",
    effective: "medium",
    clamped: true,
    tokenBudget: 2_000,
  });
  assert.equal(prepared.thinkingLevel, "medium");
  assert.equal(prepared.maxOutputTokens, 5_000);
  assert.deepEqual(prepared.preparation.cache, {
    retention: "long",
    sessionId: "session-1",
    placements: [
      { target: "system" },
      { target: "tool", toolIndex: 0 },
      { target: "message-content", messageIndex: 0, contentIndex: 0 },
    ],
  });
  assert.deepEqual(prepared.sampling, {
    temperature: 0.2,
    topP: 0.9,
    topK: 20,
    minP: 0.1,
    frequencyPenalty: -0.5,
    presencePenalty: 0.5,
    repetitionPenalty: 1.1,
    seed: 7,
    custom: { mirostat: 2 },
  });
});

test("rejects invalid history, sampling, cache, and authorization metadata loudly", async () => {
  const model = targetModel();
  await assert.rejects(
    () =>
      prepareModelRequest(
        model,
        textRequest({
          messages: [
            {
              role: "tool",
              callId: "missing",
              name: "read",
              content: [{ type: "text", text: "result" }],
              isError: false,
            },
          ],
        }),
      ),
    /does not match a preceding unresolved tool call/,
  );
  await assert.rejects(
    () => prepareModelRequest(model, textRequest({ sampling: { topP: 2 } })),
    /sampling.topP must be between 0 and 1/,
  );
  await assert.rejects(
    () => prepareModelRequest(model, textRequest({ sampling: { topK: 20 } })),
    /sampling.topK is unsupported by this model/,
  );
  await assert.rejects(
    () => prepareModelRequest(model, textRequest({ sampling: { custom: { mirostat: 2 } } })),
    /sampling.custom.mirostat is unsupported by this model/,
  );
  await assert.rejects(
    () =>
      prepareModelRequest(
        model,
        textRequest({ cache: { retention: "none", sessionId: "ignored" } }),
      ),
    /requires prompt caching to be enabled/,
  );
  await assert.rejects(
    () => prepareModelRequest(model, textRequest({ metadata: { accessToken: "must-not-pass" } })),
    (error) =>
      error instanceof RequestPreparationError &&
      error.path === "request.metadata.accessToken" &&
      !JSON.stringify(error).includes("must-not-pass"),
  );
});

test("validates model sampling declarations in catalog metadata", () => {
  assert.throws(
    () =>
      validateModelCatalog([
        targetModel({
          sampling: {
            supported: ["temperature", "temperature"],
            customFields: ["accessToken"],
          },
        }),
      ]),
    (error) =>
      error instanceof Error &&
      error.message.includes("invalid sampling support") &&
      error.message.includes("invalid custom sampling fields"),
  );
});

test("rejects foreign redacted reasoning instead of dropping opaque content", async () => {
  await assert.rejects(
    () =>
      prepareModelRequest(
        targetModel(),
        textRequest({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  text: "",
                  redacted: true,
                  signature: {
                    providerId: "other",
                    apiDialect: "anthropic-messages",
                    modelId: "other-model",
                    value: "opaque",
                  },
                },
              ],
            },
          ],
        }),
      ),
    /redacted reasoning that cannot be replayed/,
  );
});
