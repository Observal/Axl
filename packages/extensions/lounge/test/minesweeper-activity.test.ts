// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type ActivityContext,
  type ActivityFrame,
  type ActivityInput,
  type ActivityPauseReason,
  type ActivityStorage,
  ActivityStorageError,
  type ActivityStoredValue,
  type JsonValue,
} from "@axl/extension-api";

import {
  createMinesweeper,
  minesweeperActivity,
  minesweeperSaveJson,
  parseMinesweeperSave,
  reduceMinesweeper,
  restoreMinesweeper,
  updateMinesweeperSave,
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

interface Scheduled {
  readonly delay: number;
  active: boolean;
  fire(elapsed?: number): void;
}

function fixtureContext(
  options: {
    readonly storage?: ActivityStorage;
    readonly textOnly?: boolean;
    readonly reducedMotion?: boolean;
  } = {},
) {
  let now = 0;
  let invalidations = 0;
  const scheduled: Scheduled[] = [];
  const context: ActivityContext = {
    signal: new AbortController().signal,
    now: () => now,
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
    schedule: (delay, callback) => {
      const item: Scheduled = {
        delay,
        active: true,
        fire(elapsed = delay) {
          if (!item.active) return;
          item.active = false;
          now += elapsed;
          callback(elapsed);
        },
      };
      scheduled.push(item);
      return () => {
        item.active = false;
      };
    },
    ...(options.storage === undefined ? {} : { storage: options.storage }),
  };
  return {
    context,
    scheduled,
    get invalidations() {
      return invalidations;
    },
    setNow(value: number) {
      now = value;
    },
  };
}

function key(value: string): Extract<ActivityInput, { readonly type: "key" }> {
  return { type: "key", key: value, ctrl: false, alt: false, shift: false, repeat: false };
}

function mouse(
  button: "left" | "middle" | "right",
  row: number,
  column: number,
): Extract<ActivityInput, { readonly type: "mouse" }> {
  return {
    type: "mouse",
    phase: "press",
    button,
    row,
    column,
    ctrl: false,
    alt: false,
    shift: false,
  };
}

function text(frame: ActivityFrame): string {
  return frame.lines.map((row) => row.map((item) => item.text).join("")).join("\n");
}

function selectedCell(frame: ActivityFrame): { readonly row: number; readonly column: number } {
  for (const [row, spans] of frame.lines.entries()) {
    let column = 0;
    for (const item of spans) {
      if (item.text === "[" && item.style === "selection") return { row, column: column + 1 };
      column += item.text.length;
    }
  }
  throw new Error("Expected a semantic selected cell");
}

function boardOrigin(frame: ActivityFrame): { readonly row: number; readonly column: number } {
  const rows = frame.lines.map((row) => row.map((item) => item.text).join(""));
  const row = rows.findIndex((value) => value.includes("┼") || value.includes("-----+-"));
  const value = rows[row] ?? "";
  const column = value.includes("┼") ? value.indexOf("┼") : value.indexOf("-----+-") + 5;
  assert.ok(row >= 0 && column >= 0, "expected coordinate axis separator");
  return { row, column };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
}

test("Minesweeper renders bounded complete and clipped boards at 40, 80, and 120 columns", () => {
  for (const viewport of [
    { width: 40, height: 15 },
    { width: 80, height: 24 },
    { width: 120, height: 30 },
  ]) {
    const instance = minesweeperActivity({ seed: () => 42 }).create(fixtureContext().context);
    const frame = instance.render(viewport);
    assert.ok(frame.lines.length <= viewport.height);
    assert.ok(
      frame.lines.every((row) => row.map((item) => item.text).join("").length <= viewport.width),
    );
    assert.match(text(frame), /BEGINNER/);
    assert.match(text(frame), /MINES EST 10/);
    assert.match(text(frame), /\[1 Beginner\].*\[3 Expert\]/);
    assert.match(text(frame), / A {2}B {2}C/);
    assert.match(text(frame), /01 {2}│/);
    assert.match(text(frame), /─────┼/);
    assert.match(text(frame), /Enter open/);
    assert.equal(frame.cursor, undefined);
    assert.ok(selectedCell(frame));
    if (viewport.width === 40) assert.deepEqual(boardOrigin(frame), { row: 5, column: 7 });
  }

  const expert = minesweeperActivity({ seed: () => 42 }).create(fixtureContext().context);
  expert.render({ width: 40, height: 15 });
  expert.handleInput(key("3"));
  for (let index = 0; index < 29; index += 1) expert.handleInput(key("right"));
  for (let index = 0; index < 15; index += 1) expert.handleInput(key("down"));
  const clipped = text(expert.render({ width: 40, height: 15 }));
  assert.match(clipped, /EXPERT/);
  assert.match(clipped, /‹/);
  assert.match(clipped, /↑/);
  assert.match(clipped, /AA AB AC AD/);
});

test("Minesweeper uses semantic selection without a hardware cursor in every presentation mode", () => {
  for (const presentation of [
    {},
    { textOnly: true },
    { reducedMotion: true },
    { textOnly: true, reducedMotion: true },
  ]) {
    const instance = minesweeperActivity({ seed: () => 42 }).create(
      fixtureContext(presentation).context,
    );
    const frame = instance.render({ width: 40, height: 15 });
    assert.equal(frame.cursor, undefined);
    const selected = selectedCell(frame);
    const row = frame.lines[selected.row] ?? [];
    assert.ok(row.some((item) => item.text === "[" && item.style === "selection"));
    assert.ok(row.some((item) => item.text === "]" && item.style === "selection"));
    assert.match(text(frame), /A1 · HIDDEN/);
  }
});

test("Minesweeper coordinate gutters remain structural and Expert labels stay separated", () => {
  const instance = minesweeperActivity({ seed: () => 42 }).create(
    fixtureContext({ textOnly: true }).context,
  );
  let frame = instance.render({ width: 40, height: 15 });
  assert.match(text(frame), /COLS.*│.* A {2}B {2}C/);
  assert.match(text(frame), /-----\+-/);
  assert.match(text(frame), /01 {2}│/);
  assert.equal(
    frame.lines.flat().some((item) => item.style === "selection" && /COLS|│|01/.test(item.text)),
    false,
  );

  instance.handleInput(key("3"));
  for (let index = 0; index < 29; index += 1) instance.handleInput(key("right"));
  frame = instance.render({ width: 40, height: 15 });
  assert.match(text(frame), /AA AB AC AD/);
});

test("Minesweeper mouse mapping stays exact across viewport panning and resize", () => {
  for (const width of [40, 80, 120]) {
    const instance = minesweeperActivity({ seed: () => 42 }).create(fixtureContext().context);
    instance.render({ width, height: width === 40 ? 15 : 24 });
    instance.handleInput(key("3"));
    for (let index = 0; index < 29; index += 1) instance.handleInput(key("right"));
    for (let index = 0; index < 15; index += 1) instance.handleInput(key("down"));
    instance.render({ width: 40, height: 15 });
    const resized = instance.render({ width, height: width === 40 ? 15 : 24 });
    const selected = selectedCell(resized);
    instance.handleInput(mouse("right", selected.row, selected.column));
    const saved = parseMinesweeperSave(instance.serialize() as JsonValue).game;
    assert.equal(saved.cursor, 479, `cursor at ${width} columns`);
    assert.equal(saved.flagged[479], true, `flag mapping at ${width} columns`);
  }
});

test("Minesweeper help documents keyboard mouse and translated-touch behavior", () => {
  const instance = minesweeperActivity({ seed: () => 42 }).create(fixtureContext().context);
  instance.render({ width: 80, height: 24 });
  instance.handleInput(key("?"));
  const help = text(instance.render({ width: 80, height: 24 }));
  assert.match(help, /Keyboard: arrows\/HJKL move/);
  assert.match(help, /Space\/Enter reveal or chord · F flag/);
  assert.match(help, /C chord a revealed number/);
  assert.match(help, /Mouse: left reveal\/chord · right flag/);
  assert.match(help, /Middle-click chord/);
  assert.match(help, /Touch\*: terminal must translate taps/);
  assert.match(help, /No native touch gestures/);
});

test("Minesweeper handles movement aliases, reveal, flags, chord feedback, help, and preset confirmation", () => {
  let seed = 1;
  const instance = minesweeperActivity({ seed: () => seed++ }).create(fixtureContext().context);
  instance.render({ width: 80, height: 24 });
  instance.handleInput(key("l"));
  instance.handleInput(key("j"));
  assert.match(text(instance.render({ width: 80, height: 24 })), /B2 · HIDDEN/);
  instance.handleInput(key("f"));
  assert.match(text(instance.render({ width: 80, height: 24 })), /Flag placed/);
  instance.handleInput(key("enter"));
  assert.match(text(instance.render({ width: 80, height: 24 })), /Flagged cells stay closed/);
  instance.handleInput(key("f"));
  instance.handleInput(key("enter"));
  instance.handleInput(key("c"));
  assert.match(text(instance.render({ width: 80, height: 24 })), /chord|adjacent mines/i);
  instance.handleInput(key("?"));
  assert.match(text(instance.render({ width: 80, height: 24 })), /HOW TO PLAY/);
  instance.handleInput(key("?"));
  instance.handleInput(key("3"));
  assert.match(text(instance.render({ width: 80, height: 24 })), /START EXPERT/);
  instance.handleInput(key("n"));
  assert.doesNotMatch(text(instance.render({ width: 80, height: 24 })), /START EXPERT/);
  instance.handleInput(key("3"));
  instance.handleInput(key("y"));
  assert.match(text(instance.render({ width: 80, height: 24 })), /EXPERT/);
});

test("Minesweeper mouse clicks reveal, flag, select presets, and open local controls", () => {
  let seed = 10;
  const instance = minesweeperActivity({ seed: () => seed++ }).create(fixtureContext().context);
  let frame = instance.render({ width: 40, height: 15 });
  const cursor = selectedCell(frame);

  instance.handleInput(mouse("right", cursor.row, cursor.column));
  instance.handleInput({ ...mouse("right", cursor.row, cursor.column), phase: "release" });
  assert.match(text(instance.render({ width: 40, height: 15 })), /A1 · FLAGGED/);
  instance.handleInput(mouse("right", cursor.row, cursor.column));
  instance.handleInput(mouse("left", cursor.row, cursor.column + 3));
  assert.equal(parseMinesweeperSave(instance.serialize() as JsonValue).game.minesPlaced, true);
  assert.match(text(instance.render({ width: 40, height: 15 })), /B1 ·/);

  frame = instance.render({ width: 40, height: 15 });
  const rows = frame.lines.map((row) => row.map((item) => item.text).join(""));
  const helpRow = rows.findIndex((row) => row.includes("[? Help]"));
  const helpColumn = rows[helpRow]?.indexOf("[? Help]") ?? -1;
  instance.handleInput(mouse("left", helpRow, helpColumn + 1));
  frame = instance.render({ width: 40, height: 15 });
  assert.match(text(frame), /HOW TO PLAY/);
  const helpLines = frame.lines.map((row) => row.map((item) => item.text).join(""));
  const backRow = helpLines.findIndex((row) => row.includes("[? Back]"));
  const backColumn = helpLines[backRow]?.indexOf("[? Back]") ?? -1;
  instance.handleInput(mouse("left", backRow, backColumn + 1));

  frame = instance.render({ width: 40, height: 15 });
  const presetRows = frame.lines.map((row) => row.map((item) => item.text).join(""));
  const presetRow = presetRows.findIndex((row) => row.includes("[3 Expert]"));
  const presetColumn = presetRows[presetRow]?.indexOf("[3 Expert]") ?? -1;
  instance.handleInput(mouse("left", presetRow, presetColumn + 1));
  frame = instance.render({ width: 40, height: 15 });
  assert.match(text(frame), /START EXPERT/);
  const confirmationLines = frame.lines.map((row) => row.map((item) => item.text).join(""));
  const replaceColumn = confirmationLines[2]?.indexOf("[Y Replace]") ?? -1;
  instance.handleInput(mouse("left", 2, replaceColumn + 1));
  assert.equal(parseMinesweeperSave(instance.serialize() as JsonValue).game.preset, "expert");
});

test("Enter and left click chord a satisfied revealed number", async () => {
  const storage = new MemoryStorage();
  const mines = Array<boolean>(81).fill(false);
  for (const index of [0, 7, 8, 16, 17, 18, 25, 26, 27, 28]) mines[index] = true;
  const revealed = Array<boolean>(81).fill(false);
  revealed[10] = true;
  const flagged = Array<boolean>(81).fill(false);
  flagged[0] = true;
  flagged[18] = true;
  const state = restoreMinesweeper({
    ...createMinesweeper("beginner", 1),
    minesPlaced: true,
    mines,
    revealed,
    flagged,
    cursor: 10,
    status: "active",
  });
  storage.stored = {
    revision: 1,
    schemaVersion: 1,
    value: minesweeperSaveJson(updateMinesweeperSave(state)),
  };
  const keyboard = minesweeperActivity().create(fixtureContext({ storage }).context);
  await settle();
  const ready = text(keyboard.render({ width: 80, height: 24 }));
  assert.match(ready, /ENTER\/C CHORD READY/);
  keyboard.handleInput(key("enter"));
  assert.equal(parseMinesweeperSave(keyboard.serialize() as JsonValue).game.status, "won");
  await keyboard.dispose();

  storage.stored = {
    revision: 1,
    schemaVersion: 1,
    value: minesweeperSaveJson(updateMinesweeperSave(state)),
  };
  const pointer = minesweeperActivity().create(fixtureContext({ storage }).context);
  await settle();
  const pointerFrame = pointer.render({ width: 80, height: 24 });
  const pointerCell = selectedCell(pointerFrame);
  pointer.handleInput(mouse("left", pointerCell.row, pointerCell.column));
  assert.equal(parseMinesweeperSave(pointer.serialize() as JsonValue).game.status, "won");
  await pointer.dispose();

  storage.stored = {
    revision: 1,
    schemaVersion: 1,
    value: minesweeperSaveJson(updateMinesweeperSave(state)),
  };
  const middlePointer = minesweeperActivity().create(fixtureContext({ storage }).context);
  await settle();
  const middleFrame = middlePointer.render({ width: 80, height: 24 });
  const middleCell = selectedCell(middleFrame);
  middlePointer.handleInput(mouse("middle", middleCell.row, middleCell.column));
  assert.equal(parseMinesweeperSave(middlePointer.serialize() as JsonValue).game.status, "won");
  await middlePointer.dispose();
});

test("Minesweeper timer starts on reveal, advances once per delayed callback, and pauses without catch-up", () => {
  const fixture = fixtureContext();
  const instance = minesweeperActivity({ seed: () => 42 }).create(fixture.context);
  instance.render({ width: 80, height: 24 });
  assert.equal(fixture.scheduled.length, 0);
  instance.handleInput(key("enter"));
  assert.equal(fixture.scheduled.length, 1);
  assert.equal(fixture.scheduled[0]?.delay, 1_000);
  fixture.scheduled[0]?.fire(2_500);
  assert.match(text(instance.render({ width: 80, height: 24 })), /TIME 00:02/);
  assert.equal(fixture.scheduled.length, 2);
  instance.handleInput({ type: "focus", focused: false });
  assert.equal(fixture.scheduled.filter(({ active }) => active).length, 0);
  const paused = parseMinesweeperSave(instance.serialize() as JsonValue).game.elapsedMs;
  fixture.scheduled[1]?.fire(10_000);
  assert.equal(parseMinesweeperSave(instance.serialize() as JsonValue).game.elapsedMs, paused);
  instance.handleInput({ type: "focus", focused: true });
  assert.equal(fixture.scheduled.filter(({ active }) => active).length, 1);
});

test("Minesweeper help, restart, pause, presentation change, and disposal cancel timer work", async () => {
  const fixture = fixtureContext();
  const instance = minesweeperActivity({ seed: () => 42 }).create(fixture.context);
  instance.render({ width: 80, height: 24 });
  instance.handleInput(key("enter"));
  assert.equal(fixture.scheduled.filter(({ active }) => active).length, 1);
  instance.handleInput(key("?"));
  assert.equal(fixture.scheduled.filter(({ active }) => active).length, 0);
  instance.handleInput(key("?"));
  assert.equal(fixture.scheduled.filter(({ active }) => active).length, 1);
  instance.handleInput(key("r"));
  assert.equal(fixture.scheduled.filter(({ active }) => active).length, 0);
  instance.handleInput(key("n"));
  assert.equal(fixture.scheduled.filter(({ active }) => active).length, 1);
  instance.presentationChanged?.();
  assert.equal(fixture.scheduled.filter(({ active }) => active).length, 1);
  instance.pause("attention");
  assert.equal(fixture.scheduled.filter(({ active }) => active).length, 0);
  const snapshot = instance.serialize();
  for (const scheduled of fixture.scheduled) scheduled.fire(50_000);
  assert.deepEqual(instance.serialize(), snapshot);
  instance.resume();
  assert.equal(fixture.scheduled.filter(({ active }) => active).length, 1);
  await instance.dispose();
  assert.equal(fixture.scheduled.filter(({ active }) => active).length, 0);
});

test("Minesweeper persistence restores exact board cursor flags and elapsed time", async () => {
  const storage = new MemoryStorage();
  const firstFixture = fixtureContext({ storage });
  const first = minesweeperActivity({ seed: () => 42 }).create(firstFixture.context);
  first.render({ width: 40, height: 15 });
  await settle();
  first.handleInput(key("right"));
  first.handleInput(key("f"));
  first.handleInput(key("left"));
  first.handleInput(key("enter"));
  firstFixture.scheduled.find(({ active }) => active)?.fire(1_234);
  await first.dispose();
  assert.ok(storage.stored);
  const saved = parseMinesweeperSave(storage.stored?.value as JsonValue).game;

  const second = minesweeperActivity({ seed: () => 99 }).create(
    fixtureContext({ storage }).context,
  );
  await settle();
  assert.deepEqual(parseMinesweeperSave(second.serialize() as JsonValue).game, saved);
  assert.match(text(second.render({ width: 40, height: 15 })), /Saved board restored/);
  await second.dispose();
});

test("Minesweeper loss shows mines, explosion, and incorrect flags without color", async () => {
  const storage = new MemoryStorage();
  const base = createMinesweeper("beginner", 1);
  const mines = Array<boolean>(81).fill(false);
  for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) mines[index] = true;
  const flagged = Array<boolean>(81).fill(false);
  flagged[1] = true;
  flagged[10] = true;
  const revealed = Array<boolean>(81).fill(false);
  revealed[18] = true;
  revealed[80] = true;
  const lost = restoreMinesweeper({
    ...base,
    minesPlaced: true,
    mines,
    revealed,
    flagged,
    cursor: 18,
    status: "lost",
    exploded: 0,
  });
  storage.stored = {
    revision: 1,
    schemaVersion: 1,
    value: minesweeperSaveJson(updateMinesweeperSave(lost)),
  };
  const instance = minesweeperActivity().create(
    fixtureContext({ storage, textOnly: true }).context,
  );
  await settle();
  const frame = instance.render({ width: 40, height: 15 });
  const rendered = text(frame);
  assert.deepEqual(boardOrigin(frame), { row: 5, column: 7 });
  assert.match(rendered, /BOOM! · MINE AT A1/);
  assert.match(rendered, /!/);
  assert.match(rendered, /\*/);
  assert.match(rendered, /x/);
  for (const glyph of ["#", "F", ".", "1", "*", "!", "x"]) assert.ok(rendered.includes(glyph));
  assert.ok(frame.lines.flat().some((item) => item.text === "!" && item.style === "error"));
  assert.ok(frame.lines.flat().some((item) => item.text === "x" && item.style === "error"));
  assert.ok(frame.lines.flat().some((item) => item.text === "F" && item.style === "warning"));
  assert.ok(frame.lines.flat().some((item) => item.text === "1" && item.style === "accent"));
  assert.ok(frame.lines.flat().some((item) => item.text === "[" && item.style === "selection"));
  assert.equal(
    frame.lines.flat().some((item) => item.style === "selection" && /^\s+$/u.test(item.text)),
    false,
  );
  await instance.dispose();
});

test("Minesweeper shows direct win and loss actions and restarts completed boards", async () => {
  const storage = new MemoryStorage();
  let state = reduceMinesweeper(createMinesweeper("beginner", 42), { type: "reveal" });
  const revealed = state.mines.map((mine) => !mine);
  state = restoreMinesweeper({ ...state, revealed, status: "won" });
  storage.stored = {
    revision: 1,
    schemaVersion: 1,
    value: minesweeperSaveJson(updateMinesweeperSave(state)),
  };
  const instance = minesweeperActivity({ seed: () => 43 }).create(
    fixtureContext({ storage }).context,
  );
  await settle();
  const wonFrame = instance.render({ width: 40, height: 15 });
  const won = text(wonFrame);
  assert.deepEqual(boardOrigin(wonFrame), { row: 5, column: 7 });
  assert.match(won, /CLEARED!/);
  assert.match(won, /Enter\/R new/);
  assert.match(won, /Ctrl\+P Games/);
  assert.match(won, /◆/);
  assert.ok(wonFrame.lines[1]?.some((item) => item.style === "success"));
  const resultRows = wonFrame.lines.map((row) => row.map((item) => item.text).join(""));
  assert.equal(
    resultRows.findIndex((row) => / A {2}B {2}C/.test(row)),
    4,
  );
  const newRow = resultRows.findIndex((row) => row.includes("[Enter/R New]"));
  const newColumn = resultRows[newRow]?.indexOf("[Enter/R New]") ?? -1;
  instance.handleInput(mouse("left", newRow, newColumn + 1));
  assert.equal(parseMinesweeperSave(instance.serialize() as JsonValue).game.status, "ready");
  await instance.dispose();
});

test("Minesweeper reports revision conflicts and future saves without overwriting them", async () => {
  const conflict = new MemoryStorage();
  const instance = minesweeperActivity({ seed: () => 42 }).create(
    fixtureContext({ storage: conflict }).context,
  );
  instance.render({ width: 80, height: 24 });
  await settle();
  conflict.stored = { ...(conflict.stored as ActivityStoredValue), revision: 2 };
  instance.handleInput(key("right"));
  await settle();
  assert.equal(conflict.stored.revision, 2);
  assert.match(text(instance.render({ width: 80, height: 24 })), /stale revision/);
  await instance.dispose();

  const future = new MemoryStorage();
  future.stored = { revision: 3, schemaVersion: 2, value: { version: 2 } };
  const futureInstance = minesweeperActivity({ seed: () => 42 }).create(
    fixtureContext({ storage: future }).context,
  );
  futureInstance.render({ width: 80, height: 24 });
  await settle();
  assert.match(
    text(futureInstance.render({ width: 80, height: 24 })),
    /Unsupported Minesweeper storage schema 2/,
  );
  futureInstance.handleInput(key("r"));
  await settle();
  assert.equal(future.stored?.schemaVersion, 1);
  await futureInstance.dispose();
});

test("Minesweeper cancels timer work for every host suspension reason", () => {
  const reasons: readonly ActivityPauseReason[] = [
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
  ];
  for (const reason of reasons) {
    const fixture = fixtureContext({ reducedMotion: true });
    const instance = minesweeperActivity({ seed: () => 42 }).create(fixture.context);
    instance.render({ width: 80, height: 24 });
    instance.handleInput(key("enter"));
    assert.equal(fixture.scheduled.filter(({ active }) => active).length, 1, reason);
    instance.pause(reason);
    assert.equal(fixture.scheduled.filter(({ active }) => active).length, 0, reason);
    const paused = instance.serialize();
    for (const scheduled of fixture.scheduled) scheduled.fire(5_000);
    assert.deepEqual(instance.serialize(), paused, reason);
  }
});

test("Minesweeper text-only and reduced-motion keep explicit static cell semantics", () => {
  const fixture = fixtureContext({ textOnly: true, reducedMotion: true });
  const instance = minesweeperActivity({ seed: () => 42 }).create(fixture.context);
  instance.render({ width: 40, height: 15 });
  instance.handleInput(key("f"));
  const frame = instance.render({ width: 40, height: 15 });
  const rendered = text(frame);
  assert.match(rendered, /F/);
  assert.match(rendered, /#/);
  assert.match(rendered, /A1 · FLAGGED/);
  assert.equal(
    frame.lines.flat().some((item) => item.style === "selection" && /^\s+$/u.test(item.text)),
    false,
  );
  instance.handleInput(key("f"));
  instance.handleInput(key("enter"));
  assert.equal(fixture.scheduled.filter(({ active }) => active).length, 1);
});

test("Minesweeper ignores held, paste, unknown, unfocused, and undersized input", () => {
  const instance = minesweeperActivity({ seed: () => 42 }).create(fixtureContext().context);
  instance.render({ width: 39, height: 14 });
  const before = instance.serialize();
  instance.handleInput(key("enter"));
  instance.handleInput({ ...key("enter"), repeat: true });
  instance.handleInput({ type: "paste" });
  instance.handleInput({ type: "unknown" });
  assert.deepEqual(instance.serialize(), before);
  instance.render({ width: 40, height: 15 });
  instance.handleInput({ type: "focus", focused: false });
  instance.handleInput(key("enter"));
  assert.deepEqual(instance.serialize(), before);
});
