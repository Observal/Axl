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
  THEMES,
  stripAnsi,
  TranscriptDocument,
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
  assert.doesNotMatch(compact, /earlier calls/);
  for (let i = 1; i <= 5; i++) assert.match(compact, new RegExp(`command-${i}`));
  assert.ok(store.renderWindow(80, 7).length <= 7);
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

test("per-call anchors survive earlier result growth and transcript commits", () => {
  const store = new ToolTransactionStore(
    () => PLAIN_PALETTE,
    () => "full",
  );
  const first = call();
  const second = {
    ...first,
    id: "00000000-0000-4000-8000-000000000003" as typeof first.id,
    payload: { ...first.payload, callId: "call-2", input: { command: "second command" } },
  };
  store.start(first);
  store.start(second);
  const before = store.rows(80).filter((row) => row.sourceId === second.id);
  assert.ok(before.length > 1);
  const completed = result();
  store.settle({
    ...completed,
    payload: {
      ...completed.payload,
      content: [{ type: "text", text: "earlier result\n".repeat(100) }],
    },
  });
  const after = store.rows(80).filter((row) => row.sourceId === second.id);
  assert.deepEqual(after, before);
  assert.ok(after.every((row) => row.toolGroupId === first.id));
  store.settle({ ...completed, payload: { ...completed.payload, callId: "call-2" } });
  const rows = store.drain(80);
  const document = new TranscriptDocument();
  document.appendRows(rows);
  assert.deepEqual(document.rows, rows);
  assert.ok(document.rows.some((row) => row.sourceId === second.id));
});

test("bounded regular previews preserve the pending tool header and explain omitted output", () => {
  const store = new ToolTransactionStore(
    () => PLAIN_PALETTE,
    () => "full",
  );
  const first = call();
  store.start(first);
  for (let i = 2; i <= 40; i++) {
    store.start({ ...first, payload: { ...first.payload, callId: `call-${i}` } });
    const completed = result();
    store.settle({ ...completed, payload: { ...completed.payload, callId: `call-${i}` } });
  }
  const lines = store.renderWindow(80, 6);
  assert.ok(lines.length <= 6);
  assert.match(lines[0] ?? "", /SHELL\s+running/);
  assert.match(lines.at(-1) ?? "", /fullscreen or \/export/);
  assert.equal(store.renderWindow(80, 1).length, 1);
  assert.deepEqual(store.renderWindow(80, 0), []);
  assert.ok(store.rows(80).length > 100);
});

test("compact groups retain every read block and expose edit diffs", () => {
  const palette = THEMES["axl-dark"];
  assert.ok(palette);
  const store = new ToolTransactionStore(
    () => palette,
    () => "compact",
  );
  for (let index = 1; index <= 5; index++) {
    const original = call();
    store.start({
      ...original,
      payload: {
        ...original.payload,
        callId: `read-${index}`,
        name: "read",
        input: { path: `file-${index}.ts` },
      },
    });
  }
  const original = call();
  store.start({
    ...original,
    payload: {
      ...original.payload,
      callId: "edit",
      name: "edit",
      input: { path: "file-1.ts", oldText: "before", newText: "after" },
    },
  });
  const rows = store.render(80);
  for (let index = 1; index <= 5; index++) {
    const row = rows.findIndex((line) => stripAnsi(line).includes(`READ  file-${index}.ts`));
    assert.ok(row >= 0);
    assert.ok(rows[row]?.includes("\x1b[48;2;32;35;36m"));
    assert.ok(rows[row + 1]?.includes("\x1b[48;2;32;35;36m"));
    assert.equal(stripAnsi(rows[row + 1] ?? "").trim(), "");
  }
  assert.match(stripAnsi(rows.join("\n")), /-│ before/);
  assert.match(stripAnsi(rows.join("\n")), /\+│ after/);
});
