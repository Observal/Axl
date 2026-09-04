// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeResponsesStream,
  encodeResponsesRequest,
  makeFakeModelInfo,
  type ModelRequest,
  type ModelStreamEvent,
  ResponsesCodecError,
  type SseFrame,
} from "../src/index.ts";

const model = makeFakeModelInfo({
  modelId: "gpt-5",
  reasoning: true,
  thinkingLevelMap: { off: null, xhigh: "xhigh" },
});

const request: ModelRequest = {
  modelId: "gpt-5",
  system: "You are Axl.",
  messages: [
    { role: "user", content: [{ type: "text", text: "run the tests" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "Running." }],
      toolCalls: [{ callId: "call-1", name: "shell", input: { command: "pnpm test" } }],
    },
    {
      role: "tool",
      callId: "call-1",
      name: "shell",
      content: [{ type: "text", text: "all green" }],
      isError: false,
    },
  ],
  tools: [{ name: "shell", description: "Run a command", inputSchema: { type: "object" } }],
  thinkingLevel: "xhigh",
  maxOutputTokens: 4,
};

test("encodes messages, tools, thinking, and the output-token floor", () => {
  const body = encodeResponsesRequest(model, request, "gpt-5.6-sol");
  assert.equal(body.model, "gpt-5.6-sol");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.instructions, "You are Axl.");
  assert.equal(body.max_output_tokens, 16); // floor of 16
  assert.deepEqual(body.reasoning, { effort: "xhigh" });
  assert.deepEqual(body.input, [
    { role: "user", content: [{ type: "input_text", text: "run the tests" }] },
    { role: "assistant", content: [{ type: "output_text", text: "Running." }] },
    {
      type: "function_call",
      call_id: "call-1",
      name: "shell",
      arguments: '{"command":"pnpm test"}',
    },
    { type: "function_call_output", call_id: "call-1", output: "all green" },
  ]);
  assert.deepEqual(body.tools, [
    {
      type: "function",
      name: "shell",
      description: "Run a command",
      parameters: { type: "object" },
      strict: false,
    },
  ]);
});

test("off omits the reasoning parameter entirely", () => {
  const body = encodeResponsesRequest(
    model,
    { modelId: "gpt-5", messages: [], thinkingLevel: "off" },
    "gpt-5",
  );
  assert.equal("reasoning" in body, false);
});

test("blob content fails loudly instead of being dropped", () => {
  const blobRequest: ModelRequest = {
    modelId: "gpt-5",
    messages: [
      {
        role: "user",
        content: [
          { type: "blob", blob: { sha256: "a".repeat(64), mediaType: "image/png", sizeBytes: 1 } },
        ],
      },
    ],
  };
  assert.throws(
    () => encodeResponsesRequest(model, blobRequest, "gpt-5"),
    (error) => error instanceof ResponsesCodecError && /media transport/.test(error.message),
  );
});

test("encodes resolved image blobs as Responses API image parts", () => {
  const digest = "a".repeat(64);
  const body = encodeResponsesRequest(
    model,
    {
      modelId: "gpt-5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            { type: "blob", blob: { sha256: digest, mediaType: "image/png", sizeBytes: 3 } },
          ],
        },
      ],
    },
    "gpt-5",
    new Map([[digest, "YWJj"]]),
  );
  assert.deepEqual(body.input, [
    {
      role: "user",
      content: [
        { type: "input_text", text: "inspect" },
        {
          type: "input_image",
          detail: "auto",
          image_url: "data:image/png;base64,YWJj",
        },
      ],
    },
  ]);
});

async function* frames(events: readonly unknown[]): AsyncGenerator<SseFrame> {
  for (const event of events) yield { data: JSON.stringify(event) };
}

async function decode(events: readonly unknown[]): Promise<ModelStreamEvent[]> {
  return Array.fromAsync(decodeResponsesStream(frames(events)));
}

test("decodes a full transcript into canonical events", async () => {
  const events = await decode([
    { type: "response.created" },
    { type: "response.reasoning_text.delta", delta: "thinking..." },
    { type: "response.output_text.delta", delta: "Hello" },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "function_call", call_id: "call-9", name: "shell" },
    },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"command"' },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: ':"ls"}' },
    { type: "response.output_item.done", output_index: 1, item: { type: "function_call" } },
    {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          input_tokens_details: { cached_tokens: 100 },
          output_tokens_details: { reasoning_tokens: 8 },
        },
      },
    },
    { type: "response.output_text.delta", delta: "never seen" },
  ]);

  assert.deepEqual(events, [
    { type: "thinking_delta", text: "thinking..." },
    { type: "text_delta", text: "Hello" },
    { type: "tool_call", callId: "call-9", name: "shell", input: { command: "ls" } },
    {
      type: "completed",
      stopReason: "tool_use",
      usage: {
        inputTokens: 20, // cached tokens subtracted
        outputTokens: 30,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        reasoningTokens: 8,
      },
    },
  ]);
});

test("incomplete responses complete with stopReason length", async () => {
  const events = await decode([
    { type: "response.output_text.delta", delta: "truncat" },
    { type: "response.incomplete", response: { usage: { input_tokens: 5, output_tokens: 2 } } },
  ]);
  assert.equal(events[1]?.type === "completed" && events[1].stopReason, "length");
});

test("failures decode to error terminals", async () => {
  const failed = await decode([
    {
      type: "response.failed",
      response: { error: { code: "rate_limited", message: "slow down" } },
    },
  ]);
  assert.deepEqual(failed, [
    { type: "error", code: "rate_limited", message: "slow down", retryable: false },
  ]);

  const wireError = await decode([{ type: "error", code: "bad_request", message: "no" }]);
  assert.equal(wireError[0]?.type, "error");
});

test("undecodable frames and tool arguments fail loudly", async () => {
  await assert.rejects(
    Array.fromAsync(
      decodeResponsesStream(
        (async function* () {
          yield { data: "{not json" };
        })(),
      ),
    ),
    ResponsesCodecError,
  );
  const call = {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", call_id: "c", name: "shell" },
  };
  const done = {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "function_call" },
  };
  await assert.rejects(
    decode([
      call,
      { type: "response.function_call_arguments.delta", output_index: 0, delta: "{broken" },
      done,
    ]),
    (error: unknown) =>
      error instanceof ResponsesCodecError && /undecodable arguments/.test(String(error)),
  );
  await assert.rejects(
    decode([
      call,
      { type: "response.function_call_arguments.delta", output_index: 0, delta: "[]" },
      done,
    ]),
    (error: unknown) =>
      error instanceof ResponsesCodecError && /arguments must be an object/.test(String(error)),
  );
});
