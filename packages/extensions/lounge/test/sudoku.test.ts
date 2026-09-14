// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  createSudoku,
  reduceSudoku,
  restoreSudoku,
  selectSudokuFixture,
  sudokuConflicts,
  sudokuGivenValues,
  sudokuPeers,
  sudokuSolution,
} from "../src/index.ts";

function firstEmpty(state: ReturnType<typeof createSudoku>): number {
  return sudokuGivenValues(state).indexOf(0);
}

function select(state: ReturnType<typeof createSudoku>, index: number) {
  return reduceSudoku(state, { type: "select", index });
}

test("Sudoku selection and reducer behavior are deterministic and immutable", () => {
  assert.equal(selectSudokuFixture("easy", 42).id, selectSudokuFixture("easy", 42).id);
  assert.notEqual(selectSudokuFixture("easy", 1).difficulty, "medium");
  const state = createSudoku("medium", 9);
  const before = JSON.stringify(state);
  const moved = reduceSudoku(state, { type: "move", direction: "right" });
  assert.equal(JSON.stringify(state), before);
  assert.notEqual(moved, state);
  assert.ok(Object.isFrozen(moved));
  assert.ok(Object.isFrozen(moved.values));
  assert.ok(Object.isFrozen(moved.history));
});

test("given cells are protected while entry and erase update editable cells", () => {
  let state = createSudoku("easy", 1);
  const givens = sudokuGivenValues(state);
  const given = givens.findIndex((digit) => digit !== 0);
  state = select(state, given);
  assert.equal(reduceSudoku(state, { type: "digit", digit: 9 }), state);
  assert.equal(reduceSudoku(state, { type: "erase" }), state);

  const empty = givens.indexOf(0);
  state = select(state, empty);
  state = reduceSudoku(state, { type: "digit", digit: 7 });
  assert.equal(state.values[empty], 7);
  state = reduceSudoku(state, { type: "erase" });
  assert.equal(state.values[empty], 0);
});

test("notes toggle deterministically, stay fixed-width data, and clear from peers on entry", () => {
  let state = createSudoku("easy", 2);
  const empty = firstEmpty(state);
  const peer = sudokuPeers(empty).find((index) => sudokuGivenValues(state)[index] === 0) as number;
  state = select(state, peer);
  state = reduceSudoku(state, { type: "toggle-notes" });
  state = reduceSudoku(state, { type: "digit", digit: 4 });
  state = reduceSudoku(state, { type: "digit", digit: 7 });
  assert.equal(state.notes[peer], (1 << 4) | (1 << 7));
  state = reduceSudoku(state, { type: "toggle-notes" });
  state = select(state, empty);
  state = reduceSudoku(state, { type: "digit", digit: 4 });
  assert.equal((state.notes[peer] as number) & (1 << 4), 0);
  assert.notEqual((state.notes[peer] as number) & (1 << 7), 0);
});

test("row, column, and box conflicts include every affected cell", () => {
  const base = createSudoku("hard", 17);
  const givens = sudokuGivenValues(base);
  const cases = [
    [0, 1],
    [0, 9],
    [0, 10],
  ] as const;
  for (const [firstStart, secondStart] of cases) {
    let first = -1;
    let second = -1;
    for (let offset = 0; offset < 81; offset += 1) {
      const candidate = (firstStart + offset) % 81;
      if (givens[candidate] !== 0) continue;
      const peers = sudokuPeers(candidate);
      const match = peers.find((index) => index >= secondStart && givens[index] === 0);
      if (match !== undefined) {
        first = candidate;
        second = match;
        break;
      }
    }
    assert.ok(first >= 0 && second >= 0);
    const values = [...base.values];
    values[first] = 9;
    values[second] = 9;
    const conflicts = sudokuConflicts(values);
    assert.ok(conflicts.has(first));
    assert.ok(conflicts.has(second));
  }
});

test("peer semantics contain the selected row, column, and box exactly once", () => {
  const peers = sudokuPeers(40);
  assert.equal(peers.length, 20);
  assert.equal(new Set(peers).size, 20);
  assert.ok(peers.includes(36));
  assert.ok(peers.includes(4));
  assert.ok(peers.includes(30));
  assert.equal(peers.includes(40), false);
});

test("confirmed hints choose the first empty row-major cell, mark it, count it, and undo", () => {
  let state = createSudoku("medium", 9);
  const empty = state.values.indexOf(0);
  const before = state;
  state = reduceSudoku(state, { type: "hint" });
  assert.equal(state.selected, empty);
  assert.equal(state.values[empty], sudokuSolution(state)[empty]);
  assert.equal(state.hinted[empty], true);
  assert.equal(state.hintCount, 1);
  state = reduceSudoku(state, { type: "undo" });
  assert.deepEqual(state.values, before.values);
  assert.deepEqual(state.notes, before.notes);
  assert.deepEqual(state.hinted, before.hinted);
  assert.equal(state.hintCount, 0);
});

test("undo never crosses a new-game boundary", () => {
  let state = createSudoku("easy", 1);
  state = select(state, firstEmpty(state));
  state = reduceSudoku(state, { type: "digit", digit: 5 });
  assert.equal(state.history.length, 1);
  state = reduceSudoku(state, { type: "restart", difficulty: "hard", seed: 19 });
  assert.equal(state.history.length, 0);
  assert.equal(reduceSudoku(state, { type: "undo" }), state);
});

test("completion requires valid units and the unique verified solution", () => {
  let state = createSudoku("easy", 4);
  const solution = sudokuSolution(state);
  for (let index = 0; index < 81; index += 1) {
    if (sudokuGivenValues(state)[index] !== 0) continue;
    state = select(state, index);
    state = reduceSudoku(state, { type: "digit", digit: solution[index] as number });
  }
  assert.equal(state.status, "won");
  assert.equal(sudokuConflicts(state.values).size, 0);
  const forged = [...state.values];
  const firstEditable = sudokuGivenValues(state).indexOf(0);
  forged[firstEditable] = ((forged[firstEditable] as number) % 9) + 1;
  assert.throws(
    () => restoreSudoku({ ...state, values: forged, status: "won" }),
    /completion|given|inconsistent/i,
  );
});
