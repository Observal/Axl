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
  type TerminalActivityInstance,
  TerminalExtensionHost,
} from "@axl/extension-api";

import {
  codewordActivity,
  codewordSaveJson,
  createEmptyCodewordSave,
  loungeExtension,
  parseCodewordSave,
} from "../src/index.ts";

function context(
  onInvalidate: () => void = () => undefined,
  storage?: ActivityStorage,
  presentation: () => { readonly reducedMotion: boolean; readonly textOnly: boolean } = () => ({
    reducedMotion: true,
    textOnly: false,
  }),
): ActivityContext {
  return {
    signal: new AbortController().signal,
    now: () => 0,
    status: () => ({
      operation: "idle",
      activeToolCount: 0,
      queuedInput: { steer: 0, followUp: 0, interrupt: 0 },
    }),
    presentation,
    invalidate: onInvalidate,
    schedule: () => () => undefined,
    ...(storage === undefined ? {} : { storage }),
  };
}

class MemoryStorage implements ActivityStorage {
  stored: ActivityStoredValue | undefined;

  read(): Promise<ActivityStoredValue | undefined> {
    return Promise.resolve(this.stored);
  }

  write(
    expectedRevision: number | null,
    schemaVersion: number,
    value: JsonValue,
  ): Promise<ActivityStoredValue> {
    if ((this.stored?.revision ?? null) !== expectedRevision) {
      throw new ActivityStorageError("conflict", "stale revision");
    }
    this.stored = Object.freeze({
      revision: (this.stored?.revision ?? 0) + 1,
      schemaVersion,
      value,
    });
    return Promise.resolve(this.stored);
  }

  reset(expectedRevision: number): Promise<void> {
    if (this.stored?.revision !== expectedRevision) {
      throw new ActivityStorageError("conflict", "stale revision");
    }
    this.stored = undefined;
    return Promise.resolve();
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
}

class FakeScheduler {
  now = 0;
  private readonly tasks: Array<{
    readonly due: number;
    readonly started: number;
    readonly callback: (elapsedMs: number) => void;
    active: boolean;
  }> = [];

  readonly schedule = (delayMs: number, callback: (elapsedMs: number) => void): (() => void) => {
    const task = { due: this.now + delayMs, started: this.now, callback, active: true };
    this.tasks.push(task);
    return () => {
      task.active = false;
    };
  };

  advance(milliseconds: number): void {
    const target = this.now + milliseconds;
    for (;;) {
      const next = this.tasks
        .filter((task) => task.active && task.due <= target)
        .sort((left, right) => left.due - right.due)[0];
      if (next === undefined) break;
      this.now = next.due;
      next.active = false;
      next.callback(this.now - next.started);
    }
    this.now = target;
  }

  get pending(): number {
    return this.tasks.filter((task) => task.active).length;
  }
}

function animatedContext(
  scheduler: FakeScheduler,
  preferences: { reducedMotion: boolean; textOnly: boolean },
): ActivityContext {
  return {
    ...context(
      () => undefined,
      undefined,
      () => preferences,
    ),
    now: () => scheduler.now,
    schedule: scheduler.schedule,
  };
}

function key(
  value: string,
  options: { readonly ctrl?: boolean; readonly alt?: boolean } = {},
): Extract<ActivityInput, { readonly type: "key" }> {
  return {
    type: "key",
    key: value,
    ctrl: options.ctrl ?? false,
    alt: options.alt ?? false,
    shift: false,
    repeat: false,
  };
}

function activity() {
  return codewordActivity({
    selection: { kind: "practice", algorithmVersion: 1, seed: 0 },
  });
}

function enter(instance: TerminalActivityInstance, word: string): void {
  for (const letter of word) instance.handleInput(key(letter));
  instance.handleInput(key("enter"));
}

function text(frame: ActivityFrame): string {
  return frame.lines.map((line) => line.map((item) => item.text).join("")).join("\n");
}

interface ActivitySnapshot {
  readonly answer: string;
  readonly currentGuess: string;
  readonly guesses: readonly unknown[];
  readonly selection: { readonly kind: string };
  readonly status: string;
  readonly issue?: { readonly code: string };
}

function serialized(instance: TerminalActivityInstance): ActivitySnapshot {
  const state = parseCodewordSave(instance.serialize() as JsonValue).state;
  if (state === undefined) throw new Error("Codeword activity has no game state");
  return state;
}

test("the Lounge extension registers its games through the public activity API", async () => {
  const host = new TerminalExtensionHost([loungeExtension]);
  await host.activate();
  assert.deepEqual(
    host.activities().map(({ id, name, category }) => ({ id, name, category })),
    [
      { id: "axl.lounge.codeword", name: "Wordle", category: "game" },
      { id: "axl.lounge.2048", name: "2048", category: "game" },
      { id: "axl.lounge.minesweeper", name: "Minesweeper", category: "game" },
      { id: "axl.lounge.sudoku", name: "Sudoku", category: "game" },
    ],
  );
  await host.dispose();
});

test("Codeword renders stable semantic frames at compact, standard, and wide widths", () => {
  const instance = activity().create(context());
  for (const viewport of [
    { width: 40, height: 15 },
    { width: 80, height: 22 },
    { width: 120, height: 28 },
  ]) {
    const frame = instance.render(viewport);
    assert.ok(frame.lines.length <= viewport.height);
    for (const row of frame.lines) {
      assert.ok(row.map((item) => item.text).join("").length <= viewport.width);
      for (const item of row) {
        assert.ok(
          ["text", "muted", "accent", "success", "warning", "error", "selection"].includes(
            item.style,
          ),
        );
      }
    }
    const rendered = text(frame);
    assert.match(rendered, /Practice · Normal · (?:Attempt )?1\/6/);
    assert.equal((rendered.match(/│ {3}│/g) ?? []).length, 30);
    assert.match(rendered, /Q {3}W {3}E {3}R {3}T {3}Y {3}U {3}I {3}O {3}P/);
    assert.match(rendered, /Type/);
    if (viewport.height !== 22) assert.match(rendered, /\? help/);
  }
});

test("compact empty and partially entered semantic frames stay stable", () => {
  const instance = activity().create(context());
  assert.deepEqual(text(instance.render({ width: 40, height: 15 })).split("\n"), [
    "    Practice · Normal · Attempt 1/6",
    "    ▶ │   │ │   │ │   │ │   │ │   │",
    "      │   │ │   │ │   │ │   │ │   │",
    "      │   │ │   │ │   │ │   │ │   │",
    "      │   │ │   │ │   │ │   │ │   │",
    "      │   │ │   │ │   │ │   │ │   │",
    "      │   │ │   │ │   │ │   │ │   │",
    "",
    " Q   W   E   R   T   Y   U   I   O   P ",
    "   A   S   D   F   G   H   J   K   L ",
    " ENTER  Z   X   C   V   B   N   M   ⌫ ",
    " Type · ↵ submit · ? help · ^R restart",
  ]);
  for (const letter of "nee") instance.handleInput(key(letter));
  assert.match(text(instance.render({ width: 40, height: 15 })), /▶ │ N │ │ E │ │ E │/);
});

test("keyboard rows remain aligned as evidence styles change", () => {
  const instance = activity().create(context());
  const before = text(instance.render({ width: 40, height: 15 }))
    .split("\n")
    .slice(8, 11);
  enter(instance, "crane");
  const after = text(instance.render({ width: 40, height: 15 }))
    .split("\n")
    .slice(8, 11);
  assert.deepEqual(
    after.map((row) => row.search(/\S/u)),
    before.map((row) => row.search(/\S/u)),
  );
  assert.deepEqual(
    after.map((row) => row.length),
    before.map((row) => row.length),
  );
});

test("Codeword handles letters, erase, incomplete guesses, and invalid words", () => {
  let invalidations = 0;
  const instance = activity().create(
    context(() => {
      invalidations += 1;
    }),
  );
  instance.render({ width: 80, height: 18 });
  instance.handleInput(key("N"));
  instance.handleInput(key("e"));
  instance.handleInput(key("backspace"));
  assert.equal(serialized(instance).currentGuess, "n");
  instance.handleInput(key("enter"));
  assert.match(text(instance.render({ width: 80, height: 18 })), /Enter five letters/);

  instance.handleInput(key("backspace"));
  enter(instance, "zzzzz");
  assert.equal(serialized(instance).currentGuess, "zzzzz");
  assert.match(text(instance.render({ width: 80, height: 18 })), /Not in the accepted word list/);
  assert.ok(invalidations >= 8);
});

test("help and restart confirmation stay inside the activity", () => {
  const instance = activity().create(context());
  instance.render({ width: 80, height: 18 });
  instance.handleInput(key("?"));
  assert.match(text(instance.render({ width: 80, height: 18 })), /WORDLE · HOW TO PLAY/);
  instance.handleInput(key("?"));
  instance.handleInput(key("n"));
  instance.handleInput(key("e"));
  instance.handleInput(key("e"));
  instance.handleInput(key("d"));
  instance.handleInput(key("y"));
  instance.handleInput(key("r", { ctrl: true }));
  assert.match(text(instance.render({ width: 80, height: 18 })), /RESTART WORDLE/);
  assert.equal(serialized(instance).currentGuess, "needy");
  instance.handleInput(key("n"));
  assert.equal(serialized(instance).currentGuess, "needy");
  instance.handleInput(key("r", { ctrl: true }));
  instance.handleInput(key("y"));
  assert.equal(serialized(instance).currentGuess, "");
  assert.deepEqual(serialized(instance).guesses, []);
});

test("winning and losing render explicit results and accessible evidence", () => {
  const won = activity().create(context());
  won.render({ width: 80, height: 18 });
  enter(won, "needy");
  assert.equal(serialized(won).status, "won");
  const wonText = text(won.render({ width: 80, height: 18 }));
  assert.match(wonText, /SOLVED! · 1 GUESS/);
  assert.equal(
    won
      .render({ width: 80, height: 18 })
      .lines.flat()
      .find((item) => item.text.includes(" N "))?.style,
    "success",
  );

  const lost = activity().create(context());
  lost.render({ width: 80, height: 18 });
  for (const guess of ["crane", "toils", "bumpy", "fudge", "sight", "known"]) enter(lost, guess);
  assert.equal(serialized(lost).status, "lost");
  assert.match(text(lost.render({ width: 80, height: 18 })), /GAME OVER · ANSWER: NEEDY/);
});

test("neutral tiles and semantic evidence remain distinct without heavy backgrounds", () => {
  const instance = codewordActivity({
    selection: { kind: "practice", algorithmVersion: 1, seed: 6699 },
  }).create(context());
  const empty = instance.render({ width: 80, height: 22 });
  assert.equal(empty.lines.flat().find(({ text }) => text === "╭───╮")?.style, "text");
  assert.equal(
    empty.lines.flat().some(({ text, style }) => text.includes("╭───╮") && style === "selection"),
    false,
  );

  enter(instance, "allee");
  const scored = instance.render({ width: 80, height: 18 });
  assert.match(text(scored), /┃ A ┃ ║ L ║ │ L │ │ E │ ┃ E ┃/);
  const present = scored.lines.flat().find(({ text }) => text.includes("║ L ║"));
  assert.equal(present?.style, "warning");
  assert.equal(present?.emphasis, "strong");
});

test("hard-mode feedback is rendered without consuming a forbidden guess", () => {
  const instance = codewordActivity({
    selection: { kind: "practice", algorithmVersion: 1, seed: 6699 },
    difficulty: "hard",
  }).create(context());
  instance.render({ width: 80, height: 18 });
  enter(instance, "allee");
  enter(instance, "lease");
  assert.equal(serialized(instance).guesses.length, 1);
  assert.match(text(instance.render({ width: 80, height: 18 })), /Hard mode: keep A in position 1/);
});

test("reveals one tile every 80 ms and bounds win emphasis to 300 ms", () => {
  const scheduler = new FakeScheduler();
  const preferences = { reducedMotion: false, textOnly: false };
  const instance = activity().create(animatedContext(scheduler, preferences));
  instance.render({ width: 80, height: 18 });
  enter(instance, "needy");

  assert.equal(scheduler.pending, 1);
  const submittedRow = () => text(instance.render({ width: 80, height: 18 })).split("\n")[1] ?? "";
  assert.doesNotMatch(submittedRow(), /┃ N ┃/);
  scheduler.advance(79);
  assert.doesNotMatch(submittedRow(), /┃ N ┃/);
  scheduler.advance(1);
  assert.match(submittedRow(), /┃ N ┃/);
  scheduler.advance(319);
  assert.match(text(instance.render({ width: 80, height: 18 })), /Revealing result/);
  scheduler.advance(1);
  const emphasized = instance.render({ width: 80, height: 18 });
  assert.match(text(emphasized), /┃ N ┃.*┃ E ┃.*┃ E ┃.*┃ D ┃.*┃ Y ┃/);
  assert.equal(
    emphasized.lines.flat().find((item) => item.text.includes("SOLVED!"))?.emphasis,
    "reverse",
  );
  assert.equal(scheduler.pending, 1);
  scheduler.advance(299);
  assert.equal(scheduler.pending, 1);
  scheduler.advance(1);
  assert.equal(scheduler.pending, 0);
  assert.equal(
    instance
      .render({ width: 80, height: 18 })
      .lines.flat()
      .find((item) => item.text.includes("SOLVED!"))?.emphasis,
    "strong",
  );
});

test("reduced motion and text-only apply complete static results immediately", () => {
  for (const preferences of [
    { reducedMotion: true, textOnly: false },
    { reducedMotion: false, textOnly: true },
  ]) {
    const scheduler = new FakeScheduler();
    const instance = activity().create(animatedContext(scheduler, preferences));
    instance.render({ width: 80, height: 18 });
    enter(instance, "needy");
    const frame = text(instance.render({ width: 80, height: 18 }));
    assert.equal(scheduler.pending, 0);
    assert.match(frame, /N[^\n]*E[^\n]*E[^\n]*D[^\n]*Y/);
    assert.doesNotMatch(frame, /Revealing result/);
  }
});

test("enabling reduced motion cancels and completes a pending reveal", () => {
  const scheduler = new FakeScheduler();
  const preferences = { reducedMotion: false, textOnly: false };
  const instance = activity().create(animatedContext(scheduler, preferences));
  instance.render({ width: 80, height: 18 });
  enter(instance, "needy");
  scheduler.advance(80);
  assert.equal(scheduler.pending, 1);
  preferences.reducedMotion = true;
  instance.presentationChanged?.();
  assert.equal(scheduler.pending, 0);
  const submitted = text(instance.render({ width: 80, height: 18 })).split("\n")[1] ?? "";
  assert.match(submitted, /┃ N ┃.*┃ E ┃.*┃ E ┃.*┃ D ┃.*┃ Y ┃/);
});

test("text-only frames use stable status, board, keyboard, and controls order", () => {
  const scheduler = new FakeScheduler();
  const instance = activity().create(
    animatedContext(scheduler, { reducedMotion: false, textOnly: true }),
  );
  instance.render({ width: 80, height: 18 });
  enter(instance, "crane");
  const lines = text(instance.render({ width: 80, height: 18 })).split("\n");
  assert.match(lines[0] ?? "", /Practice · Normal · Attempt 2\/6/);
  assert.match(lines[1] ?? "", /Type a five-letter word/);
  assert.match(lines[2] ?? "", /^Row 1:/);
  assert.match(lines[7] ?? "", /^Row 6:/);
  assert.match(lines[8] ?? "", /^Keyboard exact:/);
  assert.match(lines[9] ?? "", /^Keyboard present:/);
  assert.match(lines[10] ?? "", /^Keyboard absent:/);
  assert.equal(scheduler.pending, 0);
});

test("invalid feedback, paste, unknown input, and held keys are static and non-destructive", () => {
  const scheduler = new FakeScheduler();
  const instance = activity().create(
    animatedContext(scheduler, { reducedMotion: false, textOnly: false }),
  );
  instance.render({ width: 80, height: 18 });
  instance.handleInput(key("n"));
  instance.handleInput({ ...key("e"), repeat: true });
  instance.handleInput({ type: "paste" });
  instance.handleInput({ type: "unknown" });
  instance.handleInput(key("enter"));
  const state = serialized(instance);
  assert.equal(state.currentGuess, "n");
  assert.equal(state.guesses.length, 0);
  assert.equal(scheduler.pending, 0);
  assert.match(text(instance.render({ width: 80, height: 18 })), /Enter five letters/);
});

test("pause and disposal cancel decorative callbacks without a delayed mutation", async () => {
  const scheduler = new FakeScheduler();
  const instance = activity().create(
    animatedContext(scheduler, { reducedMotion: false, textOnly: false }),
  );
  instance.render({ width: 80, height: 18 });
  enter(instance, "needy");
  scheduler.advance(80);
  instance.pause("attention");
  assert.equal(scheduler.pending, 0);
  const paused = text(instance.render({ width: 80, height: 18 }));
  scheduler.advance(1_000);
  assert.equal(text(instance.render({ width: 80, height: 18 })), paused);
  await instance.dispose();
  assert.equal(scheduler.pending, 0);
});

test("undersized frames reject invisible game input", () => {
  const instance = activity().create(context());
  assert.match(text(instance.render({ width: 39, height: 9 })), /WORDLE NEEDS MORE ROOM/);
  instance.handleInput(key("n"));
  assert.equal(serialized(instance).currentGuess, "");
});

test("the Wordle menu changes puzzle and difficulty independently", () => {
  const instance = codewordActivity({
    utcDate: () => "2026-09-13",
    practiceSeed: () => 6699,
  }).create(context());
  assert.match(text(instance.render({ width: 80, height: 18 })), /● DAILY {5}○ PRACTICE/);
  instance.handleInput(key("?"));
  assert.match(text(instance.render({ width: 80, height: 18 })), /WORDLE · HOW TO PLAY/);
  instance.handleInput(key("?"));
  instance.handleInput(key("right"));
  assert.deepEqual(parseCodewordSave(instance.serialize() as JsonValue).document.preferences, {
    puzzle: "practice",
    difficulty: "normal",
  });
  instance.handleInput(key("down"));
  assert.deepEqual(parseCodewordSave(instance.serialize() as JsonValue).document.preferences, {
    puzzle: "practice",
    difficulty: "normal",
  });
  instance.handleInput(key("right"));
  assert.deepEqual(parseCodewordSave(instance.serialize() as JsonValue).document.preferences, {
    puzzle: "practice",
    difficulty: "hard",
  });
  instance.handleInput(key("enter"));
  const frame = text(instance.render({ width: 80, height: 18 }));
  assert.match(frame, /Practice · Hard/);
  assert.equal(serialized(instance).answer, "apple");
});

test("activity storage restores an exact paused game", async () => {
  const storage = new MemoryStorage();
  const options = { utcDate: () => "2026-09-13", practiceSeed: () => 42 };
  const first = codewordActivity(options).create(context(() => undefined, storage));
  assert.match(text(first.render({ width: 80, height: 18 })), /Loading Wordle/);
  await settle();
  assert.match(text(first.render({ width: 80, height: 18 })), /START TODAY'S WORDLE/);
  first.handleInput(key("enter"));
  first.handleInput(key("i"));
  first.handleInput(key("d"));
  await first.dispose();

  const second = codewordActivity(options).create(context(() => undefined, storage));
  await settle();
  assert.match(text(second.render({ width: 80, height: 18 })), /CONTINUE · ATTEMPT 1\/6/);
  second.handleInput(key("enter"));
  const restored = parseCodewordSave(second.serialize() as JsonValue).state;
  assert.equal(restored?.selection.kind, "daily");
  assert.equal(
    restored?.selection.kind === "daily" ? restored.selection.utcDate : undefined,
    "2026-09-13",
  );
  assert.equal(restored?.currentGuess, "id");
  await second.dispose();
});

test("an active daily remains resumable across the UTC midnight boundary", async () => {
  const storage = new MemoryStorage();
  const first = codewordActivity({ utcDate: () => "2026-09-13" }).create(
    context(() => undefined, storage),
  );
  first.render({ width: 80, height: 18 });
  await settle();
  first.handleInput(key("enter"));
  first.handleInput(key("i"));
  await first.dispose();

  const nextDay = codewordActivity({ utcDate: () => "2026-09-14" }).create(
    context(() => undefined, storage),
  );
  await settle();
  assert.match(text(nextDay.render({ width: 80, height: 18 })), /CONTINUE · ATTEMPT 1\/6/);
  nextDay.handleInput(key("enter"));
  const restored = serialized(nextDay);
  assert.equal(restored.currentGuess, "i");
  await nextDay.dispose();
});

test("completion statistics persist once across reload and redraw", async () => {
  const storage = new MemoryStorage();
  const options = { utcDate: () => "2026-09-13", practiceSeed: () => 42 };
  const first = codewordActivity(options).create(context(() => undefined, storage));
  first.render({ width: 80, height: 18 });
  await settle();
  first.handleInput(key("enter"));
  enter(first, "idles");
  first.render({ width: 80, height: 18 });
  first.render({ width: 80, height: 18 });
  await first.dispose();

  const second = codewordActivity(options).create(context(() => undefined, storage));
  await settle();
  second.handleInput(key("enter"));
  const frame = text(second.render({ width: 80, height: 18 }));
  assert.match(frame, /SOLVED! · 1 GUESS/);
  assert.match(frame, /Played 1 {3}Win 100% {3}Streak 1 {3}Best 1/);
  assert.match(frame, /Guess distribution · 1:1/);
  await second.dispose();
});

test("restarting a completed daily creates a new deterministic practice game", () => {
  const instance = codewordActivity({
    selection: { kind: "daily", algorithmVersion: 1, utcDate: "2026-09-13" },
    practiceSeed: () => 42,
  }).create(context());
  instance.render({ width: 80, height: 18 });
  enter(instance, "idles");
  instance.handleInput(key("r", { ctrl: true }));
  instance.handleInput(key("y"));
  const restarted = serialized(instance);
  const saved = parseCodewordSave(instance.serialize() as JsonValue).state;
  assert.equal(saved?.selection.kind, "practice");
  assert.equal(restarted.answer, "bowed");
  assert.equal(restarted.status, "active");
});

test("completed results offer fresh Practice games with a new seed", () => {
  const seeds = [42, 6699];
  const instance = codewordActivity({
    selection: { kind: "practice", algorithmVersion: 1, seed: 0 },
    practiceSeed: () => seeds.shift() ?? 1,
  }).create(context());
  instance.render({ width: 80, height: 18 });
  enter(instance, "needy");
  assert.match(text(instance.render({ width: 80, height: 18 })), /\[ Enter \] New practice/);

  instance.handleInput(key("enter"));
  assert.equal(serialized(instance).answer, "bowed");
  enter(instance, "bowed");
  instance.handleInput(key("r"));
  assert.equal(serialized(instance).answer, "apple");
  assert.equal(serialized(instance).selection.kind, "practice");
});

test("the menu describes active and completed results without styling centering padding", () => {
  const instance = codewordActivity({
    selection: { kind: "daily", algorithmVersion: 1, utcDate: "2026-09-13" },
    utcDate: () => "2026-09-13",
  }).create(context());
  instance.render({ width: 80, height: 18 });
  enter(instance, "idles");
  instance.handleInput(key("m"));
  const frame = instance.render({ width: 80, height: 18 });
  assert.match(text(frame), /TODAY SOLVED · 1\/6/);
  assert.doesNotMatch(text(frame), /VIEW RESULT/);
  for (const selected of frame.lines.flat().filter(({ style }) => style === "selection")) {
    assert.equal(selected.text, selected.text.trimStart());
  }
  instance.handleInput(key("?"));
  assert.match(text(instance.render({ width: 80, height: 18 })), /WORDLE · HOW TO PLAY/);
  instance.handleInput(key("?"));
  assert.match(text(instance.render({ width: 80, height: 18 })), /TODAY SOLVED · 1\/6/);
  instance.handleInput(key("m"));
  assert.match(text(instance.render({ width: 80, height: 18 })), /SOLVED! · 1 GUESS/);
});

test("a completed prior daily does not replace the next UTC daily", async () => {
  const storage = new MemoryStorage();
  const first = codewordActivity({ utcDate: () => "2026-09-13" }).create(
    context(() => undefined, storage),
  );
  first.render({ width: 80, height: 18 });
  await settle();
  first.handleInput(key("enter"));
  enter(first, "idles");
  await first.dispose();

  const next = codewordActivity({ utcDate: () => "2026-09-14" }).create(
    context(() => undefined, storage),
  );
  await settle();
  assert.match(text(next.render({ width: 80, height: 18 })), /START TODAY'S WORDLE/);
  next.handleInput(key("enter"));
  const restored = parseCodewordSave(next.serialize() as JsonValue).state;
  assert.equal(
    restored?.selection.kind === "daily" ? restored.selection.utcDate : undefined,
    "2026-09-14",
  );
  await next.dispose();
});

test("picker choices persist before a game starts", async () => {
  const storage = new MemoryStorage();
  const first = codewordActivity().create(context(() => undefined, storage));
  first.render({ width: 80, height: 18 });
  await settle();
  first.handleInput(key("right"));
  first.handleInput(key("down"));
  first.handleInput(key("right"));
  await first.dispose();
  const saved = parseCodewordSave(storage.stored?.value as JsonValue);
  assert.deepEqual(saved.document.preferences, { puzzle: "practice", difficulty: "hard" });
});

test("a board conflict preserves the newer board but merges a unique completion", async () => {
  const storage = new MemoryStorage();
  storage.stored = {
    revision: 1,
    schemaVersion: 1,
    value: codewordSaveJson(createEmptyCodewordSave()),
  };
  const instance = codewordActivity({ utcDate: () => "2026-09-13" }).create(
    context(() => undefined, storage),
  );
  instance.render({ width: 80, height: 18 });
  await settle();
  storage.stored = {
    revision: 2,
    schemaVersion: 1,
    value: codewordSaveJson(createEmptyCodewordSave()),
  };
  instance.handleInput(key("enter"));
  enter(instance, "idles");
  await instance.dispose();
  const persisted = parseCodewordSave(storage.stored.value);
  assert.equal(persisted.state, undefined);
  assert.equal(persisted.document.completions.length, 1);
  assert.match(text(instance.render({ width: 80, height: 18 })), /Save conflict/);
});

test("future saved state is visible and reset requires the stored revision", async () => {
  const storage = new MemoryStorage();
  storage.stored = { revision: 3, schemaVersion: 1, value: { version: 2 } };
  const instance = codewordActivity().create(context(() => undefined, storage));
  instance.render({ width: 80, height: 18 });
  await settle();
  assert.match(
    text(instance.render({ width: 80, height: 18 })),
    /Unsupported Codeword save version 2/,
  );
  instance.handleInput(key("r"));
  await settle();
  assert.equal(storage.stored, undefined);
  assert.match(text(instance.render({ width: 80, height: 18 })), /START TODAY'S WORDLE/);
  await instance.dispose();
});
