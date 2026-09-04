// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { type CanonicalEvent, EVENT_FORMAT_VERSION, parseEvent } from "@axl/protocol";

import { PLAIN_PALETTE, ToolTransactionComponent } from "../src/index.ts";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";

function call(): CanonicalEvent<"tool.call"> {
  return parseEvent({
    version: EVENT_FORMAT_VERSION,
    id: "00000000-0000-4000-8000-000000000001",
    sessionId,
    operationId: "00000000-0000-4000-8000-000000000010",
    parentId: null,
    timestamp: 1_000,
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
    timestamp: 2_250,
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
  assert.match(component.render(80).join("\n"), /◌ running/);
  component.settle(result());
  const settled = component.render(80).join("\n");
  assert.match(settled, /✓ done · 1\.3s/);
  assert.match(settled, /tests passed/);
});

test("renders unresolved restored calls as pending", () => {
  const pending = new ToolTransactionComponent(
    call(),
    () => PLAIN_PALETTE,
    () => "compact",
    "pending",
  );
  assert.match(pending.render(80).join("\n"), /○ pending/);
});

test("preserves denied and aborted lifecycle states", () => {
  const denied = new ToolTransactionComponent(
    call(),
    () => PLAIN_PALETTE,
    () => "compact",
  );
  denied.markDenied("outside workspace");
  denied.settle(result());
  assert.match(denied.render(80).join("\n"), /! denied/);

  const aborted = new ToolTransactionComponent(
    call(),
    () => PLAIN_PALETTE,
    () => "compact",
  );
  aborted.settle(result({ endedBy: "abort" }));
  assert.match(aborted.render(80).join("\n"), /■ aborted/);
});
