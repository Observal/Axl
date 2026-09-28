// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationState } from "@axl/sdk";

import { elapsed, turnStage, turnStartedAt } from "../src/remote/turn.ts";

const OPERATION = "01a0e643-cbc3-7bdf-ad7d-029d97478eb9";

function state(fields: Partial<Record<keyof ConversationState, unknown>>): ConversationState {
  return {
    records: [],
    tools: [],
    operations: [],
    ...fields,
  } as unknown as ConversationState;
}

test("the turn stage follows what the running turn streams", () => {
  assert.equal(turnStage(state({})), undefined, "nothing runs");
  const running = { activeOperationId: OPERATION };
  assert.equal(turnStage(state(running)), "Working");
  const activity = (fields: object) => ({
    operationId: OPERATION,
    sequence: 1,
    text: "",
    thinking: "",
    toolCalls: [],
    ...fields,
  });
  assert.equal(
    turnStage(state({ ...running, activity: activity({ thinking: "hm" }) })),
    "Thinking",
  );
  assert.equal(
    turnStage(state({ ...running, activity: activity({ thinking: "hm", text: "Hi" }) })),
    "Writing",
  );
  assert.equal(
    turnStage(
      state({ ...running, activity: activity({ toolCalls: [{ callId: "a", name: "read" }] }) }),
    ),
    "Running read",
  );
  assert.equal(
    turnStage(
      state({
        ...running,
        tools: [
          { callId: "a", name: "read", operationId: OPERATION, result: { isError: false } },
          { callId: "b", name: "shell", operationId: OPERATION },
        ],
      }),
    ),
    "Running shell",
    "a finished tool no longer counts",
  );
  assert.equal(
    turnStage(
      state({
        ...running,
        operations: [{ operationId: OPERATION, status: "waiting_interaction" }],
      }),
    ),
    "Waiting for an answer on the computer",
  );
  // Activity left over from another operation says nothing about this one.
  assert.equal(
    turnStage(state({ ...running, activity: { ...activity({ text: "old" }), operationId: "x" } })),
    "Working",
  );
});

test("the turn started with its first event", () => {
  const event = (operationId: string, timestamp: number) => ({
    kind: "event",
    event: { type: "user.message", operationId, timestamp },
  });
  const records = [event("other", 5), event(OPERATION, 10), event(OPERATION, 20)];
  assert.equal(turnStartedAt(state({ records })), undefined, "nothing runs");
  assert.equal(turnStartedAt(state({ records, activeOperationId: OPERATION })), 10);
});

test("elapsed time reads in seconds, then minutes", () => {
  assert.equal(elapsed(-5), "0s");
  assert.equal(elapsed(12_900), "12s");
  assert.equal(elapsed(184_000), "3m 04s");
});
