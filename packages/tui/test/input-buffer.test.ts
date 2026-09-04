// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { TerminalInputBuffer, terminalEscapeTimeout } from "../src/input-buffer.ts";

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function recorder(
  options: {
    escapeTimeoutMs?: number;
    sequenceTimeoutMs?: number;
    pasteTimeoutMs?: number;
    maxSequenceBytes?: number;
    maxPasteBytes?: number;
  } = {},
) {
  const sequences: string[] = [];
  const errors: Error[] = [];
  const buffer = new TerminalInputBuffer({
    onSequence: (sequence) => sequences.push(sequence),
    onError: (error) => errors.push(error),
    ...options,
  });
  return { buffer, sequences, errors };
}

test("emits plain Unicode and complete terminal sequences in order", () => {
  const { buffer, sequences, errors } = recorder();
  buffer.push("a🙂\x1b[A\r");
  assert.deepEqual(sequences, ["a🙂", "\x1b[A", "\r"]);
  assert.deepEqual(errors, []);
  buffer.dispose();
});

test("preserves UTF-8 graphemes split across byte chunks", () => {
  const { buffer, sequences, errors } = recorder();
  const emoji = Buffer.from("🙂");
  buffer.push(emoji.subarray(0, 2));
  assert.deepEqual(sequences, []);
  buffer.push(emoji.subarray(2));
  assert.deepEqual(sequences, ["🙂"]);
  assert.deepEqual(errors, []);
  buffer.dispose();
});

test("reassembles fragmented CSI and bracketed paste sequences", async () => {
  const { buffer, sequences, errors } = recorder({
    sequenceTimeoutMs: 5,
    pasteTimeoutMs: 50,
  });
  buffer.push("\x1b[");
  buffer.push("1;5");
  buffer.push("D");
  buffer.push("\x1b[20");
  buffer.push("0~hello\nworld");
  await wait(15);
  buffer.push("\x1b[20");
  buffer.push("1~");

  assert.deepEqual(sequences, ["\x1b[1;5D", "\x1b[200~hello\nworld\x1b[201~"]);
  assert.deepEqual(errors, []);
  buffer.dispose();
});

test("waits for split Alt input and eventually emits a lone Escape", async () => {
  const split = recorder({ escapeTimeoutMs: 20 });
  split.buffer.push("\x1b");
  split.buffer.push("f");
  assert.deepEqual(split.sequences, ["\x1bf"]);
  split.buffer.dispose();

  const lone = recorder({ escapeTimeoutMs: 5 });
  lone.buffer.push("\x1b");
  assert.deepEqual(lone.sequences, []);
  await wait(15);
  assert.deepEqual(lone.sequences, ["\x1b"]);
  assert.deepEqual(lone.errors, []);
  lone.buffer.dispose();
});

test("reports truncated or oversized control sequences instead of leaking their bytes", async () => {
  const truncated = recorder({ sequenceTimeoutMs: 5 });
  truncated.buffer.push("\x1b[12;");
  await wait(15);
  assert.deepEqual(truncated.sequences, []);
  assert.equal(truncated.errors.length, 1);
  assert.match(truncated.errors[0]?.message ?? "", /Incomplete terminal input sequence/);
  truncated.buffer.dispose();

  const unicode = recorder({ sequenceTimeoutMs: 5 });
  unicode.buffer.push(Buffer.from("🙂").subarray(0, 2));
  await wait(15);
  assert.deepEqual(unicode.sequences, []);
  assert.equal(unicode.errors.length, 1);
  assert.match(unicode.errors[0]?.message ?? "", /Incomplete terminal input sequence/);
  unicode.buffer.dispose();

  const oversized = recorder({ maxSequenceBytes: 5 });
  oversized.buffer.push("\x1b]long control");
  assert.deepEqual(oversized.sequences, []);
  assert.equal(oversized.errors.length, 1);
  assert.match(oversized.errors[0]?.message ?? "", /input sequence exceeded/);
  oversized.buffer.dispose();
});

test("accepts BEL only for OSC strings", () => {
  const { buffer, sequences, errors } = recorder({ sequenceTimeoutMs: 0 });
  buffer.push("\x1b]title\x07");
  assert.deepEqual(sequences, ["\x1b]title\x07"]);

  buffer.push("\x1bPdata\x07");
  buffer.flush();
  assert.equal(errors.length, 1);
  assert.deepEqual(sequences, ["\x1b]title\x07"]);
  buffer.dispose();
});

test("bounds unfinished bracketed paste and cancels pending timers on dispose", async () => {
  const overflow = recorder({ maxPasteBytes: 8 });
  overflow.buffer.push("\x1b[200~too much");
  assert.equal(overflow.errors.length, 1);
  assert.match(overflow.errors[0]?.message ?? "", /paste exceeded/);
  overflow.buffer.dispose();

  const disposed = recorder({ escapeTimeoutMs: 5 });
  disposed.buffer.push("\x1b");
  disposed.buffer.dispose();
  await wait(15);
  assert.deepEqual(disposed.sequences, []);
  assert.deepEqual(disposed.errors, []);
});

test("uses a longer Escape timeout for SSH and rejects invalid configuration", () => {
  assert.equal(terminalEscapeTimeout({}), 10);
  assert.equal(terminalEscapeTimeout({ SSH_CONNECTION: "client server" }), 100);
  assert.equal(terminalEscapeTimeout({ AXL_TUI_ESCAPE_TIMEOUT_MS: "25" }), 25);
  assert.throws(
    () => terminalEscapeTimeout({ AXL_TUI_ESCAPE_TIMEOUT_MS: "invalid" }),
    /non-negative finite number/,
  );
  assert.throws(
    () => recorder({ maxPasteBytes: 0 }),
    /maxPasteBytes must be a positive safe integer/,
  );
});
