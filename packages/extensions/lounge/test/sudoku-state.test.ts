// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  createSudoku,
  parseSudokuSave,
  reduceSudoku,
  SudokuSaveError,
  sudokuSaveJson,
  updateSudokuSave,
} from "../src/index.ts";

function saved() {
  let state = createSudoku("medium", 9);
  state = reduceSudoku(state, { type: "digit", digit: 4 });
  state = reduceSudoku(state, { type: "toggle-notes" });
  state = reduceSudoku(state, { type: "move", direction: "right" });
  state = reduceSudoku(state, { type: "digit", digit: 2 });
  state = reduceSudoku(state, { type: "hint" });
  return sudokuSaveJson(updateSudokuSave(state));
}

test("Sudoku save round-trips exact logical state and undo history", () => {
  const value = saved();
  assert.deepEqual(sudokuSaveJson(parseSudokuSave(value)), value);
});

test("Sudoku rejects future, fixture-mismatched, malformed, and oversized saves", () => {
  assert.throws(
    () => parseSudokuSave({ version: 2, game: {} }),
    (error) => error instanceof SudokuSaveError && error.code === "future-version",
  );
  const valid = saved() as Record<string, unknown>;
  const game = valid.game as Record<string, unknown>;
  assert.throws(
    () => parseSudokuSave({ ...valid, game: { ...game, fixtureSetRevision: "future" } } as never),
    (error) => error instanceof SudokuSaveError && error.code === "fixture-mismatch",
  );
  assert.throws(
    () => parseSudokuSave({ ...valid, game: { ...game, selected: 81 } } as never),
    /selected/i,
  );
  assert.throws(
    () =>
      parseSudokuSave({
        ...valid,
        game: { ...game, history: Array(129).fill((game.history as unknown[])[0]) },
      } as never),
    /history/i,
  );
});

test("Sudoku rejects inconsistent givens, notes, hints, and completion", () => {
  const valid = saved() as Record<string, unknown>;
  const game = valid.game as Record<string, unknown>;
  const values = [...(game.values as number[])];
  const given = values.findIndex((digit) => digit !== 0);
  values[given] = 0;
  assert.throws(() => parseSudokuSave({ ...valid, game: { ...game, values } } as never), /given/i);
  const notes = [...(game.notes as number[])];
  const filled = (game.values as number[]).findIndex((digit) => digit !== 0);
  notes[filled] = 2;
  assert.throws(() => parseSudokuSave({ ...valid, game: { ...game, notes } } as never), /notes/i);
  assert.throws(
    () => parseSudokuSave({ ...valid, game: { ...game, status: "won" } } as never),
    /completion/i,
  );
});
