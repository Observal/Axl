// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { collectModelStream, type ModelStreamEvent, normalizeModelStream } from "../src/index.ts";

const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
const completed: ModelStreamEvent = { type: "completed", stopReason: "stop", usage };

test("passes a well-formed stream through and stops at the terminal event", async () => {
  let pulledPastTerminal = false;
  async function* source(): AsyncGenerator<ModelStreamEvent> {
    yield { type: "thinking_delta", text: "hmm" };
    yield { type: "text_delta", text: "hello" };
    yield { type: "tool_call", callId: "call-1", name: "shell", input: { command: "true" } };
    yield completed;
    pulledPastTerminal = true;
    yield { type: "text_delta", text: "junk after terminal" };
  }

  const { events, terminal } = await collectModelStream(source());
  assert.equal(events.length, 4);
  assert.deepEqual(terminal, completed);
  assert.equal(pulledPastTerminal, false);
});

test("converts a thrown provider error into an error terminal", async () => {
  async function* source(): AsyncGenerator<ModelStreamEvent> {
    yield { type: "text_delta", text: "partial" };
    throw new Error("connection reset");
  }

  const { events, terminal } = await collectModelStream(source());
  assert.deepEqual(events[0], { type: "text_delta", text: "partial" });
  assert.deepEqual(terminal, {
    type: "error",
    code: "provider_stream_failure",
    message: "connection reset",
    retryable: false,
    category: "stream_interrupted",
    requestPhase: "streaming",
  });
});

test("converts a silently ended stream into an error terminal", async () => {
  async function* source(): AsyncGenerator<ModelStreamEvent> {
    yield { type: "text_delta", text: "cut off" };
  }

  const { terminal } = await collectModelStream(source());
  assert.equal(terminal.type, "error");
  if (terminal.type === "error") {
    assert.equal(terminal.code, "provider_stream_truncated");
    assert.equal(terminal.retryable, false);
  }
});

test("reports an aborted terminal when the request signal fired", async () => {
  const controller = new AbortController();
  async function* source(): AsyncGenerator<ModelStreamEvent> {
    yield { type: "text_delta", text: "before abort" };
    controller.abort();
    throw new Error("aborted mid-flight");
  }

  const { terminal } = await collectModelStream(source(), controller.signal);
  assert.deepEqual(terminal, { type: "aborted" });
});

test("normalizeModelStream yields nothing after a terminal event", async () => {
  async function* source(): AsyncGenerator<ModelStreamEvent> {
    yield { type: "aborted" };
  }

  const events: ModelStreamEvent[] = [];
  for await (const event of normalizeModelStream(source())) events.push(event);
  assert.deepEqual(events, [{ type: "aborted" }]);
});
