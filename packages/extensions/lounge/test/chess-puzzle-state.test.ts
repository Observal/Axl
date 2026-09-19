// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  ActivityStorageError,
  type ActivityStoredValue,
  type ActivityStorage,
  type JsonValue,
} from "@axl/extension-api";

import { CHESS_PUZZLES, CHESS_PUZZLE_SET_REVISION } from "../src/chess-puzzles.generated.ts";
import {
  CHESS_PUZZLE_MAX_COMPLETIONS,
  ChessPuzzleSaveError,
  type ChessPuzzleCatalog,
  type ChessPuzzleCompletionRecord,
  type ChessPuzzlePreferences,
  type ChessPuzzleSaveDocument,
  type ChessPuzzleSelection,
  type ChessPuzzleState,
  chessPuzzleExpectedMove,
  chessPuzzleSaveJson,
  chessPuzzleStatistics,
  createChessPuzzle,
  createChessPuzzleSaveWriter,
  createDailyChessPuzzleSelection,
  createEmptyChessPuzzleSave,
  createPracticeChessPuzzleSelection,
  legalChessMoves,
  mergeChessPuzzleCompletions,
  parseChessPuzzleSave,
  reduceChessPuzzle,
  submitChessPuzzleMove,
  updateChessPuzzleSave,
} from "../src/index.ts";

const catalog: ChessPuzzleCatalog = Object.freeze({
  revision: CHESS_PUZZLE_SET_REVISION,
  puzzles: CHESS_PUZZLES,
});
const preferences: ChessPuzzlePreferences = Object.freeze({
  mode: "practice",
  difficulty: "easy",
  theme: "any",
  orientation: "white",
});

function practice(seed: number): ChessPuzzleSelection {
  return createPracticeChessPuzzleSelection(catalog.revision, seed, "easy", "any");
}

function solve(selection: ChessPuzzleSelection, mistakes = 0, hint = false): ChessPuzzleState {
  let state = createChessPuzzle(catalog, selection);
  if (hint) state = reduceChessPuzzle(catalog, state, { type: "hint" });
  for (let index = 0; index < mistakes; index += 1) {
    const expected = chessPuzzleExpectedMove(catalog, state);
    const wrong = legalChessMoves(state.position).find(
      (move) =>
        `${move.from}:${move.to}:${move.promotion ?? ""}` !==
        `${expected.from}:${expected.to}:${expected.promotion ?? ""}`,
    );
    assert.ok(wrong);
    state = submitChessPuzzleMove(catalog, state, wrong);
  }
  while (state.status !== "solved") {
    if (state.status === "reply-pending")
      state = reduceChessPuzzle(catalog, state, { type: "apply-opponent-reply" });
    else state = submitChessPuzzleMove(catalog, state, chessPuzzleExpectedMove(catalog, state));
  }
  return state;
}

function saveSolved(
  document: ChessPuzzleSaveDocument,
  selection: ChessPuzzleSelection,
  mistakes = 0,
  hint = false,
): ChessPuzzleSaveDocument {
  return updateChessPuzzleSave(document, solve(selection, mistakes, hint), {
    mode: selection.kind,
    difficulty: selection.difficulty,
    theme: selection.theme,
    orientation: "white",
  }).document;
}

test("schema version 1 restores state by replaying canonical setup and solution plies", () => {
  let state = createChessPuzzle(catalog, practice(42));
  state = reduceChessPuzzle(catalog, state, { type: "hint" });
  state = submitChessPuzzleMove(catalog, state, chessPuzzleExpectedMove(catalog, state));
  state = reduceChessPuzzle(catalog, state, { type: "apply-opponent-reply" });
  const expected = chessPuzzleExpectedMove(catalog, state);
  state = reduceChessPuzzle(catalog, state, { type: "set-cursor", square: expected.from });
  state = reduceChessPuzzle(catalog, state, { type: "activate" });
  const saved = updateChessPuzzleSave(createEmptyChessPuzzleSave(), state, preferences).document;
  const restored = parseChessPuzzleSave(chessPuzzleSaveJson(saved), catalog);
  assert.deepEqual(restored.state, state);
  assert.equal(restored.completionRecorded, false);
  assert.ok(Object.isFrozen(restored.document));
  assert.ok(Object.isFrozen(restored.document.completions));
});

test("pending and solved states restore without inventing opponent replies", () => {
  let pending = createChessPuzzle(catalog, practice(77));
  pending = reduceChessPuzzle(catalog, pending, { type: "hint" });
  pending = submitChessPuzzleMove(catalog, pending, chessPuzzleExpectedMove(catalog, pending));
  const pendingSave = updateChessPuzzleSave(
    createEmptyChessPuzzleSave(),
    pending,
    preferences,
  ).document;
  assert.deepEqual(parseChessPuzzleSave(chessPuzzleSaveJson(pendingSave), catalog).state, pending);

  const solved = solve(practice(78), 1, true);
  const solvedSave = updateChessPuzzleSave(
    createEmptyChessPuzzleSave(),
    solved,
    preferences,
  ).document;
  const restored = parseChessPuzzleSave(chessPuzzleSaveJson(solvedSave), catalog);
  assert.deepEqual(restored.state, solved);
  assert.equal(restored.completionRecorded, true);
});

test("strict restoration rejects unknown, future, mismatched, and forged state", () => {
  assert.throws(
    () => parseChessPuzzleSave({ version: 2 } as JsonValue, catalog),
    (error: unknown) => error instanceof ChessPuzzleSaveError && error.code === "future-version",
  );
  const original = updateChessPuzzleSave(
    createEmptyChessPuzzleSave(),
    createChessPuzzle(catalog, practice(1)),
    preferences,
  ).document;

  const unknown = structuredClone(original) as unknown as Record<string, unknown>;
  unknown.extra = true;
  assert.throws(() => parseChessPuzzleSave(unknown as JsonValue, catalog), /extra is unknown/);

  const revision = structuredClone(original) as { game: { puzzleSetRevision: string } };
  revision.game.puzzleSetRevision = "other";
  assert.throws(
    () => parseChessPuzzleSave(revision as unknown as JsonValue, catalog),
    (error: unknown) => error instanceof ChessPuzzleSaveError && error.code === "revision-mismatch",
  );

  const selection = structuredClone(original) as { game: { puzzleId: string } };
  selection.game.puzzleId = "forged";
  assert.throws(
    () => parseChessPuzzleSave(selection as unknown as JsonValue, catalog),
    /selection/,
  );

  const progression = structuredClone(original) as {
    game: { expectedSolutionPly: number; status: string };
  };
  progression.game.expectedSolutionPly = 1;
  progression.game.status = "reply-pending";
  assert.throws(
    () => parseChessPuzzleSave(progression as unknown as JsonValue, catalog),
    /progression/,
  );

  const pending = structuredClone(original) as { game: { status: string } };
  pending.game.status = "reply-pending";
  assert.throws(
    () => parseChessPuzzleSave(pending as unknown as JsonValue, catalog),
    /progression/,
  );

  let realPending = createChessPuzzle(catalog, practice(2));
  realPending = submitChessPuzzleMove(
    catalog,
    realPending,
    chessPuzzleExpectedMove(catalog, realPending),
  );
  const impossibleSelection = structuredClone(
    updateChessPuzzleSave(createEmptyChessPuzzleSave(), realPending, preferences).document,
  ) as unknown as { game: { selectedSource: number } };
  impossibleSelection.game.selectedSource = realPending.lastMove.move.to;
  assert.throws(
    () => parseChessPuzzleSave(impossibleSelection as unknown as JsonValue, catalog),
    /requires an active puzzle/,
  );
});

test("forged completion records and completion markers are rejected", () => {
  const solved = solve(practice(9));
  const saved = updateChessPuzzleSave(createEmptyChessPuzzleSave(), solved, preferences).document;
  const forgedCount = structuredClone(saved) as unknown as {
    completions: Array<[string, number, number, number]>;
  };
  const countRecord = forgedCount.completions[0];
  assert.ok(countRecord);
  countRecord[1] += 1;
  assert.throws(() => parseChessPuzzleSave(forgedCount as unknown as JsonValue, catalog), /forged/);

  const forgedPuzzle = structuredClone(saved) as unknown as {
    completions: Array<[string, number, number, number]>;
  };
  const puzzleRecord = forgedPuzzle.completions[0];
  assert.ok(puzzleRecord);
  const keyParts = puzzleRecord[0].split(":");
  keyParts[6] = "forged";
  puzzleRecord[0] = keyParts.join(":");
  assert.throws(
    () => parseChessPuzzleSave(forgedPuzzle as unknown as JsonValue, catalog),
    /forged/,
  );

  const marker = structuredClone(saved) as unknown as {
    game: { completionRecorded: boolean };
    completions: unknown[];
  };
  marker.completions = [];
  assert.throws(
    () => parseChessPuzzleSave(marker as unknown as JsonValue, catalog),
    /completion marker/,
  );

  const forgedSubmission = structuredClone(saved) as unknown as {
    game: { submittedMoves: string[] };
  };
  forgedSubmission.game.submittedMoves.push(forgedSubmission.game.submittedMoves.at(-1) ?? "a1a2");
  assert.throws(
    () => parseChessPuzzleSave(forgedSubmission as unknown as JsonValue, catalog),
    /progression/,
  );
});

test("statistics count clean solves, attempts, filters, and each UTC daily date once", () => {
  let document = createEmptyChessPuzzleSave();
  const dailyAny = createDailyChessPuzzleSelection(catalog.revision, "2026-09-13", "easy", "any");
  const dailyFork = createDailyChessPuzzleSelection(catalog.revision, "2026-09-13", "easy", "fork");
  const dailyNext = createDailyChessPuzzleSelection(
    catalog.revision,
    "2026-09-14",
    "medium",
    "any",
  );
  const dailyGap = createDailyChessPuzzleSelection(catalog.revision, "2026-09-16", "hard", "any");
  document = saveSolved(document, dailyAny);
  document = saveSolved(document, dailyFork, 1, true);
  document = saveSolved(document, dailyNext);
  document = saveSolved(document, dailyGap);
  const statistics = chessPuzzleStatistics(document);
  assert.equal(statistics.puzzlesCompleted, 4);
  assert.equal(statistics.cleanSolves, 3);
  assert.equal(statistics.incorrectMoves, 1);
  assert.equal(statistics.hintsUsed, 1);
  assert.equal(statistics.byDifficulty.easy, 2);
  assert.equal(statistics.byDifficulty.medium, 1);
  assert.equal(statistics.byDifficulty.hard, 1);
  assert.equal(statistics.byTheme.any, 3);
  assert.equal(statistics.byTheme.fork, 1);
  assert.equal(statistics.maximumDailyStreak, 2);
  assert.equal(statistics.currentDailyStreak, 1);
});

test("completion merges preserve the latest active board and bound history", () => {
  const latest = updateChessPuzzleSave(
    createEmptyChessPuzzleSave(),
    createChessPuzzle(catalog, practice(100)),
    preferences,
  ).document;
  const proposed = saveSolved(createEmptyChessPuzzleSave(), practice(101));
  const merged = mergeChessPuzzleCompletions(latest, proposed);
  assert.deepEqual(merged.game, latest.game);
  assert.equal(merged.completions.length, 1);

  const record = proposed.completions[0];
  assert.ok(record);
  const withKey = (key: string): ChessPuzzleCompletionRecord =>
    Object.freeze([key, record[1], record[2], record[3]] as const);
  const oversized = Object.freeze({
    ...latest,
    completions: Object.freeze(
      Array.from({ length: CHESS_PUZZLE_MAX_COMPLETIONS }, (_, index) =>
        withKey(`${"x".repeat(90)}:${index}`),
      ),
    ),
  }) as ChessPuzzleSaveDocument;
  const newest = Object.freeze({
    ...proposed,
    completions: Object.freeze([withKey("newest")]),
  }) as ChessPuzzleSaveDocument;
  const bounded = mergeChessPuzzleCompletions(oversized, newest);
  assert.equal(bounded.completions.length, CHESS_PUZZLE_MAX_COMPLETIONS);
  assert.equal(bounded.completions.at(-1)?.[0], "newest");
  assert.equal(
    bounded.completions.some(([key]) => key === `${"x".repeat(90)}:0`),
    false,
  );
  assert.ok(JSON.stringify(bounded).length < 256 * 1024);
});

class MemoryStorage implements ActivityStorage {
  revision = 0;
  value: JsonValue | undefined;
  writes = 0;
  activeWrites = 0;
  maximumActiveWrites = 0;
  pauseFirst = false;
  private releaseFirst: (() => void) | undefined;

  async read(): Promise<ActivityStoredValue | undefined> {
    return this.value === undefined
      ? undefined
      : { revision: this.revision, schemaVersion: 1, value: structuredClone(this.value) };
  }

  async write(
    expectedRevision: number | null,
    schemaVersion: number,
    value: JsonValue,
  ): Promise<ActivityStoredValue> {
    this.writes += 1;
    this.activeWrites += 1;
    this.maximumActiveWrites = Math.max(this.maximumActiveWrites, this.activeWrites);
    if (this.pauseFirst && this.writes === 1)
      await new Promise<void>((resolve) => {
        this.releaseFirst = resolve;
      });
    try {
      const expected = this.value === undefined ? null : this.revision;
      if (expectedRevision !== expected)
        throw new ActivityStorageError("conflict", "stale revision");
      this.revision += 1;
      this.value = structuredClone(value);
      return { revision: this.revision, schemaVersion, value: structuredClone(value) };
    } finally {
      this.activeWrites -= 1;
    }
  }

  async reset(): Promise<void> {
    this.value = undefined;
  }

  release(): void {
    this.releaseFirst?.();
  }
}

test("save writer keeps one write in flight and one replaceable latest snapshot", async () => {
  const storage = new MemoryStorage();
  storage.pauseFirst = true;
  const writer = createChessPuzzleSaveWriter(storage, catalog, null);
  const first = updateChessPuzzleSave(
    createEmptyChessPuzzleSave(),
    createChessPuzzle(catalog, practice(1)),
    preferences,
  ).document;
  const second = updateChessPuzzleSave(
    first,
    createChessPuzzle(catalog, practice(2)),
    preferences,
  ).document;
  const latest = updateChessPuzzleSave(
    second,
    createChessPuzzle(catalog, practice(3)),
    preferences,
  ).document;
  writer.enqueue(first, false);
  writer.enqueue(second, false);
  writer.enqueue(latest, false);
  storage.release();
  await writer.flush();
  assert.equal(storage.maximumActiveWrites, 1);
  assert.equal(storage.writes, 2);
  assert.deepEqual(storage.value, chessPuzzleSaveJson(latest));
});

test("CAS conflicts merge only unique completions and never replace the latest board", async () => {
  const storage = new MemoryStorage();
  const latest = updateChessPuzzleSave(
    createEmptyChessPuzzleSave(),
    createChessPuzzle(catalog, practice(200)),
    preferences,
  ).document;
  await storage.write(null, 1, chessPuzzleSaveJson(latest));
  const completed = saveSolved(createEmptyChessPuzzleSave(), practice(201));
  const writer = createChessPuzzleSaveWriter(storage, catalog, 0);
  writer.enqueue(completed, true);
  await writer.flush();
  const persisted = parseChessPuzzleSave(storage.value as JsonValue, catalog).document;
  assert.deepEqual(persisted.game, latest.game);
  assert.equal(persisted.completions.length, 1);
});

test("completion snapshots survive replacement and disposal flushes the final snapshot", async () => {
  const storage = new MemoryStorage();
  storage.pauseFirst = true;
  const writer = createChessPuzzleSaveWriter(storage, catalog, null);
  const completed = saveSolved(createEmptyChessPuzzleSave(), practice(301));
  const final = updateChessPuzzleSave(
    completed,
    createChessPuzzle(catalog, practice(302)),
    preferences,
  ).document;
  writer.enqueue(completed, true);
  writer.enqueue(final, false);
  storage.release();
  await writer.dispose(final, false);
  const persisted = parseChessPuzzleSave(storage.value as JsonValue, catalog).document;
  assert.deepEqual(persisted.game, final.game);
  assert.equal(persisted.completions.length, 1);
  assert.equal(storage.maximumActiveWrites, 1);
});
