// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  adjacentMineCount,
  createMinesweeper,
  MINESWEEPER_PRESETS,
  minesweeperNeighbors,
  reduceMinesweeper,
  remainingMineEstimate,
  restoreMinesweeper,
} from "../src/index.ts";

function placedState(input: {
  readonly width?: number;
  readonly height?: number;
  readonly mines: readonly number[];
  readonly revealed?: readonly number[];
  readonly flagged?: readonly number[];
  readonly cursor?: number;
  readonly status?: "active" | "won" | "lost";
  readonly exploded?: number;
}) {
  const width = input.width ?? 9;
  const height = input.height ?? 9;
  const size = width * height;
  const mines = Array<boolean>(size).fill(false);
  const revealed = Array<boolean>(size).fill(false);
  const flagged = Array<boolean>(size).fill(false);
  for (const index of input.mines) mines[index] = true;
  for (const index of input.revealed ?? []) revealed[index] = true;
  for (const index of input.flagged ?? []) flagged[index] = true;
  return restoreMinesweeper({
    preset: "beginner",
    width,
    height,
    mineCount: 10,
    randomState: 17,
    minesPlaced: true,
    mines,
    revealed,
    flagged,
    cursor: input.cursor ?? 0,
    status: input.status ?? "active",
    ...(input.exploded === undefined ? {} : { exploded: input.exploded }),
    elapsedMs: 0,
  });
}

test("Minesweeper places each preset deterministically after the first reveal", () => {
  for (const preset of ["beginner", "intermediate", "expert"] as const) {
    const initial = createMinesweeper(preset, 42);
    assert.equal(initial.mines.some(Boolean), false);
    const first = reduceMinesweeper(initial, { type: "reveal" });
    const second = reduceMinesweeper(createMinesweeper(preset, 42), { type: "reveal" });
    assert.deepEqual(first, second);
    assert.equal(first.mines.filter(Boolean).length, MINESWEEPER_PRESETS[preset].mines);
    assert.equal(first.mines[first.cursor], false);
    assert.ok(minesweeperNeighbors(first, first.cursor).every((index) => !first.mines[index]));
    assert.equal(initial.minesPlaced, false);
    assert.equal(first.minesPlaced, true);
  }
});

test("Minesweeper computes adjacency and expands zero regions through numbered boundaries", () => {
  const mines = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const initial = placedState({ mines, cursor: 80 });
  assert.equal(adjacentMineCount(initial, 10), 4);
  assert.equal(adjacentMineCount(initial, 80), 0);
  const revealed = reduceMinesweeper(initial, { type: "reveal" });
  assert.equal(revealed.status, "won");
  assert.equal(revealed.revealed[80], true);
  assert.equal(revealed.revealed[18], true);
  assert.equal(revealed.revealed[17], true);
  assert.ok(mines.every((index) => !revealed.revealed[index]));
});

test("Minesweeper flags hidden cells and rejects revealed-cell flags", () => {
  const initial = createMinesweeper("beginner", 5);
  const flagged = reduceMinesweeper(initial, { type: "flag" });
  assert.equal(flagged.flagged[0], true);
  assert.equal(remainingMineEstimate(flagged), 9);
  assert.equal(reduceMinesweeper(flagged, { type: "reveal" }), flagged);
  const unflagged = reduceMinesweeper(flagged, { type: "flag" });
  assert.equal(unflagged.flagged[0], false);

  const revealed = reduceMinesweeper(createMinesweeper("beginner", 7), { type: "reveal" });
  assert.equal(reduceMinesweeper(revealed, { type: "flag" }), revealed);
});

test("Minesweeper chord reveals safe neighbors and incorrect flags can explode a mine", () => {
  const mines = [0, 7, 8, 16, 17, 18, 25, 26, 27, 28];
  const safeChord = placedState({ mines, revealed: [10], flagged: [0], cursor: 10 });
  assert.equal(adjacentMineCount(safeChord, 10), 2);
  assert.equal(reduceMinesweeper(safeChord, { type: "chord" }), safeChord);
  const correctlyFlagged = placedState({ mines, revealed: [10], flagged: [0, 18], cursor: 10 });
  const expanded = reduceMinesweeper(correctlyFlagged, { type: "chord" });
  assert.equal(expanded.revealed[1], true);
  assert.equal(expanded.revealed[11], true);
  assert.equal(expanded.status, "won");

  const incorrect = placedState({ mines, revealed: [10], flagged: [1, 18], cursor: 10 });
  const lost = reduceMinesweeper(incorrect, { type: "chord" });
  assert.equal(lost.status, "lost");
  assert.equal(lost.exploded, 0);
  assert.equal(lost.flagged[1], true);
});

test("Minesweeper detects direct loss and complete safe-board wins", () => {
  const mines = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const lost = reduceMinesweeper(placedState({ mines, cursor: 0 }), { type: "reveal" });
  assert.equal(lost.status, "lost");
  assert.equal(lost.exploded, 0);

  const safe = Array.from({ length: 81 }, (_, index) => index).filter(
    (index) => !mines.includes(index),
  );
  const lastSafe = safe.at(-1);
  if (lastSafe === undefined) throw new Error("Expected a safe cell");
  const almostWon = placedState({ mines, revealed: safe.slice(0, -1), cursor: lastSafe });
  const won = reduceMinesweeper(almostWon, { type: "reveal" });
  assert.equal(won.status, "won");
});

test("Minesweeper movement, elapsed time, restart, and immutability are deterministic", () => {
  const initial = createMinesweeper("beginner", 12);
  const selected = reduceMinesweeper(initial, { type: "cursor", index: 40 });
  assert.equal(selected.cursor, 40);
  assert.equal(reduceMinesweeper(selected, { type: "cursor", index: 999 }), selected);
  const right = reduceMinesweeper(initial, { type: "move", direction: "right" });
  const down = reduceMinesweeper(right, { type: "move", direction: "down" });
  assert.equal(down.cursor, 10);
  assert.equal(reduceMinesweeper(initial, { type: "move", direction: "left" }), initial);
  const active = reduceMinesweeper(down, { type: "reveal" });
  const timed = reduceMinesweeper(active, { type: "elapsed", elapsedMs: 1_234 });
  assert.equal(timed.elapsedMs, 1_234);
  assert.equal(reduceMinesweeper(timed, { type: "elapsed", elapsedMs: 100 }), timed);
  assert.deepEqual(
    reduceMinesweeper(timed, { type: "restart", preset: "expert", seed: 99 }),
    createMinesweeper("expert", 99),
  );
  assert.equal(Object.isFrozen(timed), true);
  assert.equal(Object.isFrozen(timed.mines), true);
  assert.equal(initial.minesPlaced, false);
});

test("Minesweeper randomized play preserves mine, overlap, and state invariants", () => {
  let state = createMinesweeper("expert", 0x12345678);
  const directions = ["right", "down", "left", "up"] as const;
  for (let step = 0; step < 2_000; step += 1) {
    if (state.status === "won" || state.status === "lost")
      state = createMinesweeper("expert", step + 1);
    const previous = state;
    const selector = step % 7;
    state = reduceMinesweeper(
      state,
      selector < 4
        ? { type: "move", direction: directions[selector] as (typeof directions)[number] }
        : selector === 4
          ? { type: "flag" }
          : selector === 5
            ? { type: "reveal" }
            : { type: "chord" },
    );
    assert.equal(previous.mines.length, 480);
    assert.equal(state.mines.length, 480);
    assert.equal(
      state.minesPlaced ? state.mines.filter(Boolean).length : 0,
      state.mines.filter(Boolean).length,
    );
    assert.equal(
      state.revealed.some((value, index) => value && state.flagged[index]),
      false,
    );
    assert.equal(Object.isFrozen(state), true);
    assert.equal(Object.isFrozen(state.revealed), true);
  }
});
