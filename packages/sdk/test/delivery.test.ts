// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type AxlClient,
  AxlClientError,
  deliverPrompt,
  parseSessionId,
  restoreQueuedPrompts,
} from "../src/index.ts";

const sessionId = parseSessionId("00000000-0000-4000-8000-000000000001");
const content = [{ type: "text" as const, text: "Continue with tests" }];

test("prompt delivery maps prompt, follow-up, interrupt, and queue modes", async () => {
  const methods: string[] = [];
  const client = {
    async request(method: string) {
      methods.push(method);
      if (method === "session.send" || method === "session.interruptAndDeliver") {
        return {
          operationId: "00000000-0000-4000-8000-000000000002",
          stopReason: "stop",
        };
      }
      if (method === "session.queue.enqueue") {
        return {
          queueItemId: "00000000-0000-4000-8000-000000000003",
          state: "queued",
        };
      }
      if (method === "session.followUp") return { queued: true };
      throw new Error(`Unexpected request ${method}`);
    },
  } as unknown as AxlClient;

  assert.equal((await deliverPrompt(client, sessionId, content, "prompt")).state, "completed");
  assert.equal((await deliverPrompt(client, sessionId, content, "follow_up")).state, "accepted");
  assert.equal((await deliverPrompt(client, sessionId, content, "interrupt")).state, "completed");
  assert.equal((await deliverPrompt(client, sessionId, content, "queue_back")).state, "queued");
  assert.deepEqual(methods, [
    "session.send",
    "session.followUp",
    "session.interruptAndDeliver",
    "session.queue.enqueue",
  ]);
});

test("queue restoration preserves typed content and interrupt intent", async () => {
  const requests: unknown[] = [];
  const result = {
    items: [{ content, priority: "front" as const, source: "steer" as const }],
    interrupted: true,
  };
  const client = {
    async request(_method: string, params: unknown) {
      requests.push(params);
      return result;
    },
  } as unknown as AxlClient;

  assert.deepEqual(await restoreQueuedPrompts(client, sessionId, true), result);
  assert.deepEqual(requests, [{ sessionId, interrupt: true }]);
});

test("prompt delivery safely queues a late steer", async () => {
  const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
  const client = {
    async request(method: string, params: unknown) {
      requests.push({ method, params });
      if (method === "session.steer") {
        throw new AxlClientError("operation_inactive", "The operation already completed");
      }
      if (method === "session.queue.enqueue") {
        return {
          queueItemId: "00000000-0000-4000-8000-000000000002",
          state: "queued",
        };
      }
      throw new Error(`Unexpected request ${method}`);
    },
  } as unknown as AxlClient;

  assert.deepEqual(await deliverPrompt(client, sessionId, content, "steer"), {
    state: "queued",
    mode: "steer",
    queueItemId: "00000000-0000-4000-8000-000000000002",
    queueState: "queued",
  });
  assert.deepEqual(
    requests.map((request) => request.method),
    ["session.steer", "session.queue.enqueue"],
  );
  assert.deepEqual(requests[1]?.params, { sessionId, content, priority: "front" });
});

test("prompt delivery reports transport ambiguity without retrying non-idempotent steering", async () => {
  let attempts = 0;
  const client = {
    async request() {
      attempts += 1;
      throw new AxlClientError("disconnected", "Connection closed");
    },
  } as unknown as AxlClient;

  assert.deepEqual(await deliverPrompt(client, sessionId, content, "follow_up"), {
    state: "uncertain",
    mode: "follow_up",
  });
  assert.equal(attempts, 1);
});
