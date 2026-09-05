// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { type CanonicalEvent, EVENT_FORMAT_VERSION, parseEvent } from "@axl/protocol";

import {
  PLAIN_PALETTE,
  ToolTransactionComponent,
  ToolTransactionStore,
  type ToolOutputDisplay,
} from "../src/index.ts";

const startedAt = Date.now();
const sessionId = "123e4567-e89b-42d3-a456-426614174000";

function call(): CanonicalEvent<"tool.call"> {
  return parseEvent({
    version: EVENT_FORMAT_VERSION,
    id: "00000000-0000-4000-8000-000000000001",
    sessionId,
    operationId: "00000000-0000-4000-8000-000000000010",
    parentId: null,
    timestamp: startedAt,
    type: "tool.call",
    payload: { callId: "call-1", name: "shell", input: { command: "pnpm test" } },
  }) as CanonicalEvent<"tool.call">;
}

function result(details: Record<string, unknown> = {}): CanonicalEvent<"tool.result"> {
  return parseEvent({
    version: EVENT_FORMAT_VERSION,
    id: "00000000-0000-4000-8000-000000000002",
    sessionId,
    operationId: "00000000-0000-4000-8000-000000000010",
    parentId: "00000000-0000-4000-8000-000000000001",
    timestamp: startedAt + 1_250,
    type: "tool.result",
    payload: {
      callId: "call-1",
      name: "shell",
      content: [{ type: "text", text: "tests passed" }],
      isError: false,
      details,
    },
  }) as CanonicalEvent<"tool.result">;
}

test("updates one retained component from running to succeeded", () => {
  const component = new ToolTransactionComponent(
    call(),
    () => PLAIN_PALETTE,
    () => "compact",
  );
  assert.match(component.render(80).join("\n"), /SHELL\s+running \|/);
  component.settle(result());
  const settled = component.render(80).join("\n");
  assert.match(settled, /SHELL\s+done \| 1\.3s/);
  assert.match(settled, /tests passed/);
});

test("renders unresolved restored calls as pending", () => {
  const pending = new ToolTransactionComponent(
    call(),
    () => PLAIN_PALETTE,
    () => "compact",
    "pending",
  );
  assert.match(pending.render(80).join("\n"), /SHELL\s+pending/);
});

test("preserves denied and aborted lifecycle states", () => {
  const denied = new ToolTransactionComponent(
    call(),
    () => PLAIN_PALETTE,
    () => "compact",
  );
  denied.markDenied("outside workspace");
  denied.settle(result());
  assert.match(denied.render(80).join("\n"), /SHELL\s+denied \|/);

  const aborted = new ToolTransactionComponent(
    call(),
    () => PLAIN_PALETTE,
    () => "compact",
  );
  aborted.settle(result({ endedBy: "abort" }));
  assert.match(aborted.render(80).join("\n"), /SHELL\s+aborted \|/);
});

test("tool groups retain call order, lifecycle counts, and full detail until drained", () => {
  let mode: ToolOutputDisplay = "compact";
  const store = new ToolTransactionStore(
    () => PLAIN_PALETTE,
    () => mode,
  );
  for (let i = 1; i <= 5; i++) {
    const event = call();
    store.start({
      ...event,
      payload: { ...event.payload, callId: `call-${i}`, input: { command: `command-${i}` } },
    });
  }
  for (let i = 4; i >= 1; i--) {
    const event = result();
    store.settle({
      ...event,
      payload: { ...event.payload, callId: `call-${i}`, isError: i === 2 },
    });
  }
  const compact = store.render(80).join("\n");
  assert.match(compact, /5 calls · 3 done · 1 failed · 1 running/);
  assert.match(compact, /2 earlier calls/);
  assert.ok(store.render(80).length <= 7);
  assert.deepEqual(store.drain(80), []);
  const event = result({ endedBy: "abort" });
  store.settle({ ...event, payload: { ...event.payload, callId: "call-5" } });
  assert.match(store.render(80).join("\n"), /1 aborted/);
  mode = "full";
  const full = store.render(80).join("\n");
  assert.match(full, /tests passed/);
  assert.ok(full.indexOf("command-1") < full.indexOf("command-4"));
  assert.ok(store.drain(80).length > 0);
  assert.deepEqual(store.render(80), []);
});
