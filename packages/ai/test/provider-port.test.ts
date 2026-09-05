// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { FakeModelProvider, modelPortForSession, type ModelStreamEvent } from "../src/index.ts";

const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

test("binds model choice and thinking level into kernel-shaped turns", async () => {
  const provider = new FakeModelProvider({
    responses: [
      [
        { type: "text_delta", text: "ok" },
        { type: "completed", stopReason: "stop", usage },
      ],
    ],
  });
  const readBlob = async () => new Uint8Array([1]);
  const modelPort = modelPortForSession(provider, {
    modelId: "fake-model",
    thinkingLevel: "high",
    readBlob,
  });

  const events: ModelStreamEvent[] = [];
  for await (const event of modelPort.stream({
    system: "You are Axl.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
  })) {
    events.push(event);
  }

  assert.equal(events.length, 2);
  assert.equal(events[1]?.type, "completed");
  const request = provider.requests[0];
  assert.equal(request?.modelId, "fake-model");
  assert.equal(request?.thinkingLevel, "high");
  assert.equal(request?.system, "You are Axl.");
  assert.equal(request?.readBlob, readBlob);
});

test("normalization guarantees a terminal even when the provider misbehaves", async () => {
  const provider = new FakeModelProvider({
    responses: [[{ type: "text_delta", text: "cut off" }]], // no terminal
  });
  const modelPort = modelPortForSession(provider, { modelId: "fake-model" });

  const events: ModelStreamEvent[] = [];
  for await (const event of modelPort.stream({ messages: [], tools: [] })) events.push(event);
  assert.equal(events[1]?.type, "error");
});

test("retries a safe terminal failure with deterministic backoff", async () => {
  const provider = new FakeModelProvider({
    responses: [
      [
        {
          type: "error",
          code: "http_503",
          message: "busy",
          retryable: true,
          retryAfterMs: 750,
        },
      ],
      [{ type: "completed", stopReason: "stop", usage }],
    ],
  });
  const delays: number[] = [];
  const modelPort = modelPortForSession(provider, {
    modelId: "fake-model",
    retry: {
      sleep: (delay) => {
        delays.push(delay);
        return Promise.resolve();
      },
      random: () => 0.5,
    },
  });

  const events = await Array.fromAsync(modelPort.stream({ messages: [], tools: [] }));
  assert.deepEqual(
    events.map((event) => event.type),
    ["retry_scheduled", "completed"],
  );
  const retry = events[0];
  assert.equal(retry?.type === "retry_scheduled" && retry.attempt, 2);
  assert.deepEqual(delays, [750]);
  assert.equal(provider.requests.length, 2);
});

test("stops retrying after the attempt budget is exhausted", async () => {
  const failure = { type: "error", code: "http_503", message: "busy", retryable: true } as const;
  const provider = new FakeModelProvider({ responses: [[failure], [failure], [failure]] });
  const modelPort = modelPortForSession(provider, {
    modelId: "fake-model",
    retry: { sleep: () => Promise.resolve(), random: () => 0.5 },
  });

  const events = await Array.fromAsync(modelPort.stream({ messages: [], tools: [] }));
  assert.deepEqual(
    events.map((event) => event.type),
    ["retry_scheduled", "retry_scheduled", "error"],
  );
  assert.equal(provider.requests.length, 3);
});

test("does not retry after any model output is exposed", async () => {
  const provider = new FakeModelProvider({
    responses: [
      [
        { type: "text_delta", text: "partial" },
        { type: "error", code: "http_503", message: "busy", retryable: true },
      ],
    ],
  });
  const modelPort = modelPortForSession(provider, {
    modelId: "fake-model",
    retry: { sleep: () => Promise.resolve() },
  });

  const events = await Array.fromAsync(modelPort.stream({ messages: [], tools: [] }));
  assert.deepEqual(
    events.map((event) => event.type),
    ["text_delta", "error"],
  );
  assert.equal(provider.requests.length, 1);
});

test("cancellation during retry backoff aborts without redispatch", async () => {
  const controller = new AbortController();
  const provider = new FakeModelProvider({
    responses: [[{ type: "error", code: "http_503", message: "busy", retryable: true }]],
  });
  const modelPort = modelPortForSession(provider, {
    modelId: "fake-model",
    retry: {
      sleep: () => {
        controller.abort();
        return Promise.reject(new DOMException("aborted", "AbortError"));
      },
    },
  });

  const events = await Array.fromAsync(
    modelPort.stream({ messages: [], tools: [], signal: controller.signal }),
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["retry_scheduled", "aborted"],
  );
  assert.equal(provider.requests.length, 1);
});
