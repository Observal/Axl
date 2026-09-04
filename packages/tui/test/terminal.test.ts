// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  assertInteractiveTerminal,
  type TerminalInput,
  type TerminalOutput,
  TerminalSession,
  TerminalUnavailableError,
} from "../src/terminal.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class FakeInput extends EventEmitter implements TerminalInput {
  isTTY: boolean | undefined = true;
  isRaw = false;
  readonly rawChanges: boolean[] = [];

  setRawMode(mode: boolean): void {
    this.isRaw = mode;
    this.rawChanges.push(mode);
  }
}

class FakeOutput extends EventEmitter implements TerminalOutput {
  isTTY: boolean | undefined = true;
  columns = 100;
  rows = 30;
  readonly writes: string[] = [];
  failWrites = 0;

  write(data: string): void {
    this.writes.push(data);
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      throw new Error("terminal write failed");
    }
  }
}

function session(input = new FakeInput(), output = new FakeOutput(), suspendProcess?: () => void) {
  const chunks: string[] = [];
  const errors: Error[] = [];
  let resizes = 0;
  const terminal = new TerminalSession({
    input,
    output,
    onInput: (chunk) => chunks.push(chunk),
    onInputError: (error) => errors.push(error),
    onResize: () => {
      resizes += 1;
    },
    ...(suspendProcess === undefined ? {} : { suspendProcess }),
  });
  return { terminal, input, output, chunks, errors, resizes: () => resizes };
}

test("owns terminal modes and listeners for one idempotent lifecycle", () => {
  const state = session();
  state.terminal.start();
  state.terminal.start();

  assert.deepEqual(state.input.rawChanges, [true]);
  assert.equal(state.output.writes.length, 1);
  assert.equal((state.output.writes[0] ?? "").includes("\x1b[?2004h"), true);
  assert.equal((state.output.writes[0] ?? "").includes("\x1b[?1004h"), true);
  assert.equal((state.output.writes[0] ?? "").includes("\x1b[>1u"), true);
  assert.equal((state.output.writes[0] ?? "").includes("\x1b[>7u"), false);

  state.input.emit("data", "hello");
  state.output.emit("resize");
  assert.deepEqual(state.chunks, ["hello"]);
  assert.equal(state.resizes(), 1);

  state.terminal.stop();
  state.terminal.stop();
  assert.deepEqual(state.input.rawChanges, [true, false]);
  assert.equal((state.output.writes.at(-1) ?? "").includes("\x1b[?2004l"), true);
  assert.equal((state.output.writes.at(-1) ?? "").includes("\x1b[?7h"), true);
  assert.equal((state.output.writes.at(-1) ?? "").includes("\x1b[?25h"), true);
  const virtual = new VirtualTerminal();
  for (const write of state.output.writes) virtual.write(write);
  assert.equal(virtual.bracketedPaste, false);
  assert.equal(virtual.keyboardProtocol, false);
  assert.equal(virtual.mouseModes.has(1004), false);
  assert.equal(virtual.cursorVisible, true);

  state.input.emit("data", "ignored");
  state.output.emit("resize");
  assert.deepEqual(state.chunks, ["hello"]);
  assert.equal(state.resizes(), 1);
});

test("consumes fragmented Kitty negotiation before forwarding input", () => {
  const state = session();
  state.terminal.start();
  state.input.emit("data", "\x1b[?");
  state.input.emit("data", "7u");
  state.input.emit("data", "hello");

  assert.deepEqual(state.chunks, ["hello"]);
  assert.equal(
    state.output.writes.some((write) => write.includes("\x1b[>4;2m")),
    false,
  );
  state.terminal.stop();
});

test("forwards Kitty Escape key sequences after negotiation", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const received: string[] = [];
  const terminal = new TerminalSession({
    input,
    output,
    onInput: (sequence) => received.push(sequence),
    onInputError: (error) => assert.fail(error.message),
    onResize: () => undefined,
  });
  terminal.start();
  input.emit("data", "\x1b[?1u");
  input.emit("data", "\x1b[27u");
  assert.deepEqual(received, ["\x1b[27u"]);
  terminal.stop();
});

test("uses modifyOtherKeys when device attributes arrive without Kitty support", () => {
  const state = session();
  state.terminal.start();
  state.input.emit("data", "\x1b[?1;2c");

  assert.deepEqual(state.chunks, []);
  assert.equal(
    state.output.writes.some((write) => write.includes("\x1b[>4;2m")),
    true,
  );
  state.terminal.stop();
  assert.equal((state.output.writes.at(-1) ?? "").includes("\x1b[>4;0m"), true);
});

test("reports fallback activation failures without leaking them from input dispatch", () => {
  const state = session();
  state.terminal.start();
  state.output.failWrites = 1;

  assert.doesNotThrow(() => state.input.emit("data", "\x1b[?1;2c"));
  assert.equal(state.errors.length, 1);
  assert.match(state.errors[0]?.message ?? "", /terminal write failed/);
  state.terminal.stop();
});

test("suspends only after restoring and then resumes the terminal", () => {
  let suspended = 0;
  const state = session(undefined, undefined, () => {
    suspended += 1;
    assert.equal(state.input.isRaw, false);
    assert.equal(state.input.listenerCount("data"), 0);
  });

  state.terminal.start();
  state.terminal.suspend();
  assert.equal(suspended, 1);
  assert.equal(state.input.isRaw, true);
  assert.equal(state.input.listenerCount("data"), 1);
  assert.deepEqual(state.input.rawChanges, [true, false, true]);
  state.terminal.stop();
});

test("resumes the terminal before reporting a suspend failure", () => {
  const state = session(undefined, undefined, () => {
    throw new Error("suspend failed");
  });

  state.terminal.start();
  assert.throws(() => state.terminal.suspend(), /suspend failed/);
  assert.equal(state.input.isRaw, true);
  assert.equal(state.input.listenerCount("data"), 1);
  state.terminal.stop();
});

test("restores a terminal that was already in raw mode", () => {
  const input = new FakeInput();
  input.isRaw = true;
  const state = session(input);
  state.terminal.start();
  state.terminal.stop();
  assert.deepEqual(input.rawChanges, [true, true]);
});

test("rejects redirected interactive streams before changing terminal state", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.isTTY = false;

  assert.throws(() => assertInteractiveTerminal(input, output), TerminalUnavailableError);
  const state = session(input, output);
  assert.throws(() => state.terminal.start(), TerminalUnavailableError);
  assert.deepEqual(input.rawChanges, []);
  assert.deepEqual(output.writes, []);

  input.isTTY = undefined;
  output.isTTY = true;
  assert.throws(() => assertInteractiveTerminal(input, output), TerminalUnavailableError);
});

test("restores raw mode and protocol state after startup failure", () => {
  const state = session();
  state.output.failWrites = 1;

  assert.throws(() => state.terminal.start(), /terminal write failed/);
  assert.deepEqual(state.input.rawChanges, [true, false]);
  assert.equal(state.input.listenerCount("data"), 0);
  assert.equal(state.output.listenerCount("resize"), 0);
  assert.equal((state.output.writes.at(-1) ?? "").includes("\x1b[<u"), true);
});

test("attempts every cleanup operation when terminal restoration fails", () => {
  const state = session();
  state.terminal.start();
  state.output.failWrites = 1;

  assert.throws(() => state.terminal.stop(), /Failed to restore terminal state/);
  assert.deepEqual(state.input.rawChanges, [true, false]);
  assert.equal(state.input.listenerCount("data"), 0);
  assert.equal(state.output.listenerCount("resize"), 0);
});
