// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type ActivityContext,
  type ActivityFrame,
  type ActivityInput,
  type ActivityStorage,
  ActivityStorageError,
  type ActivityStoredValue,
  type JsonValue,
} from "@axl/extension-api";

import {
  createSudoku,
  parseSudokuSave,
  reduceSudoku,
  sudokuActivity,
  sudokuGivenValues,
  sudokuSaveJson,
  sudokuSolution,
  updateSudokuSave,
} from "../src/index.ts";

class MemoryStorage implements ActivityStorage {
  stored: ActivityStoredValue | undefined;

  read(): Promise<ActivityStoredValue | undefined> {
    return Promise.resolve(this.stored);
  }
  write(expectedRevision: number | null, schemaVersion: number, value: JsonValue) {
    if ((this.stored?.revision ?? null) !== expectedRevision)
      throw new ActivityStorageError("conflict", "stale revision");
    this.stored = Object.freeze({
      revision: (this.stored?.revision ?? 0) + 1,
      schemaVersion,
      value,
    });
    return Promise.resolve(this.stored);
  }
  reset(expectedRevision: number): Promise<void> {
    if (this.stored?.revision !== expectedRevision)
      throw new ActivityStorageError("conflict", "stale revision");
    this.stored = undefined;
    return Promise.resolve();
  }
}

function context(
  options: { storage?: ActivityStorage; textOnly?: boolean; reducedMotion?: boolean } = {},
) {
  let invalidations = 0;
  let schedules = 0;
  const value: ActivityContext = {
    signal: new AbortController().signal,
    now: () => 0,
    status: () => ({
      operation: "idle",
      activeToolCount: 0,
      queuedInput: { steer: 0, followUp: 0, interrupt: 0 },
    }),
    presentation: () => ({
      reducedMotion: options.reducedMotion ?? false,
      textOnly: options.textOnly ?? false,
    }),
    invalidate: () => {
      invalidations += 1;
    },
    schedule: () => {
      schedules += 1;
      return () => undefined;
    },
    ...(options.storage === undefined ? {} : { storage: options.storage }),
  };
  return {
    value,
    get invalidations() {
      return invalidations;
    },
    get schedules() {
      return schedules;
    },
  };
}

function key(value: string): Extract<ActivityInput, { readonly type: "key" }> {
  return { type: "key", key: value, ctrl: false, alt: false, shift: false, repeat: false };
}

function text(frame: ActivityFrame): string {
  return frame.lines.map((row) => row.map((item) => item.text).join("")).join("\n");
}

function widths(frame: ActivityFrame): readonly number[] {
  return frame.lines.map((row) => row.map((item) => item.text).join("").length);
}

async function settle(): Promise<void> {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
}

function storedState(storage: MemoryStorage) {
  return parseSudokuSave(storage.stored?.value as JsonValue).game;
}

function activityWithState(
  state: ReturnType<typeof createSudoku>,
  presentation: { textOnly?: boolean; reducedMotion?: boolean } = {},
) {
  const storage = new MemoryStorage();
  storage.stored = {
    revision: 1,
    schemaVersion: 1,
    value: sudokuSaveJson(updateSudokuSave(state)),
  };
  const fixture = context({ storage, ...presentation });
  const instance = sudokuActivity({ seed: () => 99 }).create(fixture.value);
  return { storage, fixture, instance };
}

test("Sudoku renders bounded responsive frames with stable strong 3×3 separators", () => {
  for (const viewport of [
    { width: 40, height: 18 },
    { width: 80, height: 24 },
    { width: 120, height: 30 },
  ]) {
    const instance = sudokuActivity({ seed: () => 1 }).create(context().value);
    const frame = instance.render(viewport);
    assert.ok(frame.lines.length <= viewport.height);
    assert.ok(widths(frame).every((width) => width <= viewport.width));
    const rendered = text(frame);
    assert.match(rendered, /EASY · EASY-0[1-4]/);
    assert.match(rendered, /┏━+┯━+┯━+┳/);
    assert.equal((rendered.match(/┣━+┿━+┿━+╋/gu) ?? []).length, 2);
    assert.match(rendered, /┗━+┷━+┷━+┻/);
    if (viewport.height >= 22) assert.equal((rendered.match(/┠─+┼─+┼─+╂/gu) ?? []).length, 6);
    assert.match(rendered, /D Difficulty|D EASY|D Level/);
    assert.equal(frame.cursor, undefined);
  }
});

test("Sudoku keyboard entry, erase, notes, movement aliases, and input isolation are immediate", () => {
  const fixture = context();
  const instance = sudokuActivity({ seed: () => 1 }).create(fixture.value);
  instance.render({ width: 40, height: 18 });
  const before = instance.serialize();
  instance.handleInput({ type: "paste" });
  instance.handleInput({ type: "unknown" });
  instance.handleInput({ ...key("9"), repeat: true });
  assert.deepEqual(instance.serialize(), before);
  instance.handleInput(key("n"));
  instance.handleInput(key("2"));
  instance.handleInput(key("7"));
  let frame = instance.render({ width: 40, height: 18 });
  assert.match(text(frame), /NOTES 2 7/);
  const noteBoardWidths = widths(frame).slice(2, 15);
  instance.handleInput(key("n"));
  instance.handleInput(key("5"));
  frame = instance.render({ width: 40, height: 18 });
  assert.deepEqual(widths(frame).slice(2, 15), noteBoardWidths);
  assert.match(text(frame), /ENTERED|CONFLICT/);
  instance.handleInput(key("backspace"));
  assert.match(text(instance.render({ width: 40, height: 18 })), /EMPTY|Cell erased/);
  instance.handleInput(key("l"));
  instance.handleInput(key("j"));
  assert.match(text(instance.render({ width: 40, height: 18 })), /R2C2/);
});

test("Sudoku given, entered, notes, hints, conflicts, peers, and selection have non-color cues", async () => {
  let state = createSudoku("hard", 17);
  const givens = sudokuGivenValues(state);
  const first = givens.indexOf(0);
  const second = state.values.findIndex(
    (digit, index) =>
      index !== first && digit === 0 && Math.floor(index / 9) === Math.floor(first / 9),
  );
  state = reduceSudoku(state, { type: "select", index: first });
  state = reduceSudoku(state, { type: "digit", digit: 9 });
  state = reduceSudoku(state, { type: "select", index: second });
  state = reduceSudoku(state, { type: "digit", digit: 9 });
  state = reduceSudoku(state, { type: "hint" });
  const noteCell = state.values.findIndex(
    (digit, index) => digit === 0 && index !== first && index !== second,
  );
  state = reduceSudoku(state, { type: "select", index: noteCell });
  state = reduceSudoku(state, { type: "toggle-notes" });
  state = reduceSudoku(state, { type: "digit", digit: 3 });
  const { instance } = activityWithState(state, { textOnly: true });
  await settle();
  const frame = instance.render({ width: 80, height: 24 });
  const rendered = text(frame);
  assert.match(rendered, /!9!/);
  assert.match(rendered, /\+\d\+/);
  assert.match(rendered, /\[n\]/);
  assert.match(rendered, /░/);
  assert.ok(frame.lines.flat().some((item) => item.style === "error"));
  assert.ok(frame.lines.flat().some((item) => item.style === "success"));
  assert.ok(frame.lines.flat().some((item) => item.style === "warning"));
  assert.ok(frame.lines.flat().some((item) => item.style === "selection"));
  assert.equal(
    frame.lines.flat().some((item) => item.style === "selection" && /^\s+$/u.test(item.text)),
    false,
  );
  await instance.dispose();
});

test("Sudoku hint requires confirmation, uses row-major order, marks, counts, and undoes", () => {
  const instance = sudokuActivity({ seed: () => 9 }).create(context().value);
  instance.render({ width: 80, height: 24 });
  const before = parseSudokuSave(instance.serialize() as JsonValue).game;
  const empty = before.values.indexOf(0);
  instance.handleInput(key("g"));
  assert.match(
    text(instance.render({ width: 80, height: 24 })),
    new RegExp(`Fill R${Math.floor(empty / 9) + 1}C${(empty % 9) + 1}`),
  );
  assert.deepEqual(parseSudokuSave(instance.serialize() as JsonValue).game.values, before.values);
  instance.handleInput(key("y"));
  let state = parseSudokuSave(instance.serialize() as JsonValue).game;
  assert.equal(state.values[empty], sudokuSolution(state)[empty]);
  assert.equal(state.hinted[empty], true);
  assert.equal(state.hintCount, 1);
  instance.handleInput(key("u"));
  state = parseSudokuSave(instance.serialize() as JsonValue).game;
  assert.deepEqual(state.values, before.values);
  assert.equal(state.hintCount, 0);
});

test("Sudoku help, restart, difficulty, result actions, and undo boundary stay in-pane", async () => {
  let seed = 1;
  const instance = sudokuActivity({ seed: () => seed++ }).create(context().value);
  instance.render({ width: 80, height: 24 });
  instance.handleInput(key("?"));
  assert.match(text(instance.render({ width: 80, height: 24 })), /SUDOKU · HOW TO PLAY/);
  instance.handleInput(key("?"));
  instance.handleInput(key("9"));
  instance.handleInput(key("d"));
  assert.match(text(instance.render({ width: 80, height: 24 })), /START MEDIUM SUDOKU/);
  instance.handleInput(key("n"));
  instance.handleInput(key("r"));
  assert.match(text(instance.render({ width: 80, height: 24 })), /START A NEW SUDOKU/);
  instance.handleInput(key("y"));
  assert.match(text(instance.render({ width: 80, height: 24 })), /Nothing to undo|New puzzle/);

  let completed = createSudoku("easy", 1);
  const solution = sudokuSolution(completed);
  for (let index = 0; index < 81; index += 1) {
    if (sudokuGivenValues(completed)[index] !== 0) continue;
    completed = reduceSudoku(completed, { type: "select", index });
    completed = reduceSudoku(completed, { type: "digit", digit: solution[index] as number });
  }
  const restored = activityWithState(completed);
  await settle();
  assert.match(text(restored.instance.render({ width: 80, height: 24 })), /SUDOKU COMPLETE/);
  restored.instance.handleInput(key("enter"));
  assert.equal(parseSudokuSave(restored.instance.serialize() as JsonValue).game.status, "active");
  assert.equal(parseSudokuSave(restored.instance.serialize() as JsonValue).game.history.length, 0);
  await restored.instance.dispose();
});

test("Sudoku persists and resumes exact logical state", async () => {
  const storage = new MemoryStorage();
  const first = sudokuActivity({ seed: () => 6 }).create(context({ storage }).value);
  first.render({ width: 80, height: 24 });
  await settle();
  first.handleInput(key("n"));
  first.handleInput(key("3"));
  first.handleInput(key("n"));
  first.handleInput(key("right"));
  first.handleInput(key("8"));
  first.handleInput(key("g"));
  first.handleInput(key("y"));
  await first.dispose();
  const saved = storedState(storage);
  const second = sudokuActivity({ seed: () => 99 }).create(context({ storage }).value);
  await settle();
  assert.deepEqual(parseSudokuSave(second.serialize() as JsonValue).game, saved);
  assert.match(text(second.render({ width: 80, height: 24 })), /Saved puzzle restored exactly/);
  await second.dispose();
});

test("Sudoku surfaces conflict and future storage failures without overwriting", async () => {
  const conflict = new MemoryStorage();
  const instance = sudokuActivity({ seed: () => 1 }).create(context({ storage: conflict }).value);
  instance.render({ width: 80, height: 24 });
  await settle();
  conflict.stored = { ...(conflict.stored as ActivityStoredValue), revision: 2 };
  instance.handleInput(key("9"));
  await settle();
  assert.equal(conflict.stored.revision, 2);
  assert.match(text(instance.render({ width: 80, height: 24 })), /stale revision/);
  await instance.dispose();

  const future = new MemoryStorage();
  future.stored = { revision: 4, schemaVersion: 2, value: { version: 2 } };
  const futureInstance = sudokuActivity().create(context({ storage: future }).value);
  futureInstance.render({ width: 80, height: 24 });
  await settle();
  assert.match(
    text(futureInstance.render({ width: 80, height: 24 })),
    /Unsupported Sudoku storage schema 2/,
  );
  futureInstance.handleInput(key("r"));
  await settle();
  assert.equal(future.stored?.schemaVersion, 1);
  await futureInstance.dispose();
});

test("Sudoku has no scheduled work and ignores input when unfocused, paused, or undersized", async () => {
  const fixture = context({ reducedMotion: true, textOnly: true });
  const instance = sudokuActivity({ seed: () => 1 }).create(fixture.value);
  instance.render({ width: 39, height: 17 });
  const before = instance.serialize();
  instance.handleInput(key("9"));
  assert.deepEqual(instance.serialize(), before);
  instance.render({ width: 40, height: 18 });
  instance.handleInput({ type: "focus", focused: false });
  instance.handleInput(key("9"));
  assert.deepEqual(instance.serialize(), before);
  instance.pause("attention");
  instance.handleInput(key("9"));
  assert.deepEqual(instance.serialize(), before);
  assert.equal(fixture.schedules, 0);
  instance.resume();
  instance.presentationChanged?.();
  assert.equal(fixture.schedules, 0);
  await instance.dispose();
  assert.equal(fixture.schedules, 0);

  for (const reason of [
    "attention",
    "hidden",
    "unfocused",
    "monitor-focused",
    "unsupported-size",
    "disconnect",
    "completion",
    "failure",
    "session-switch",
    "reload",
  ] as const) {
    const reasonFixture = context();
    const candidate = sudokuActivity({ seed: () => 1 }).create(reasonFixture.value);
    candidate.render({ width: 40, height: 18 });
    candidate.pause(reason);
    const paused = candidate.serialize();
    candidate.handleInput(key("8"));
    assert.deepEqual(candidate.serialize(), paused, reason);
    assert.equal(reasonFixture.schedules, 0, reason);
    await candidate.dispose();
  }
});
