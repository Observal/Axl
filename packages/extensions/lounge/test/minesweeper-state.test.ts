// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  createMinesweeper,
  minesweeperSaveJson,
  parseMinesweeperSave,
  reduceMinesweeper,
  updateMinesweeperSave,
} from "../src/index.ts";

test("Minesweeper saves round-trip exactly before and after placement", () => {
  const ready = reduceMinesweeper(createMinesweeper("intermediate", 42), { type: "flag" });
  assert.deepEqual(
    parseMinesweeperSave(minesweeperSaveJson(updateMinesweeperSave(ready))).game,
    ready,
  );

  let active = reduceMinesweeper(ready, { type: "move", direction: "right" });
  active = reduceMinesweeper(active, { type: "reveal" });
  active = reduceMinesweeper(active, { type: "elapsed", elapsedMs: 12_345 });
  const restored = parseMinesweeperSave(minesweeperSaveJson(updateMinesweeperSave(active))).game;
  assert.deepEqual(restored, active);
  assert.equal(restored.cursor, 1);
  assert.equal(restored.elapsedMs, 12_345);
  assert.deepEqual(restored.flagged, active.flagged);
  assert.deepEqual(restored.revealed, active.revealed);
  assert.deepEqual(restored.mines, active.mines);
  assert.equal(restored.randomState, active.randomState);
});

test("Minesweeper rejects future, malformed, oversized, and inconsistent documents", () => {
  assert.throws(() => parseMinesweeperSave({ version: 2, game: {} }), /Unsupported/);
  assert.throws(() => parseMinesweeperSave({ version: 1, game: {} }), /algorithm version/i);

  const valid = minesweeperSaveJson(
    updateMinesweeperSave(createMinesweeper("beginner", 1)),
  ) as Record<string, unknown>;
  const game = valid.game as Record<string, unknown>;
  assert.throws(
    () => parseMinesweeperSave({ ...valid, game: { ...game, mines: Array(10_000).fill(false) } }),
    /board length/,
  );
  assert.throws(
    () => parseMinesweeperSave({ ...valid, game: { ...game, status: "won" } }),
    /unplaced board|win is inconsistent/,
  );
  assert.throws(
    () => parseMinesweeperSave({ ...valid, game: { ...game, randomState: 0 } }),
    /random state/,
  );
  assert.throws(
    () => parseMinesweeperSave({ ...valid, game: { ...game, extra: true } }),
    /extra is unknown/,
  );
});

test("Minesweeper restart produces a clean independently seeded save", () => {
  let state = reduceMinesweeper(createMinesweeper("beginner", 10), { type: "reveal" });
  state = reduceMinesweeper(state, { type: "elapsed", elapsedMs: 9_999 });
  const restarted = reduceMinesweeper(state, { type: "restart", preset: "expert", seed: 11 });
  const saved = parseMinesweeperSave(minesweeperSaveJson(updateMinesweeperSave(restarted))).game;
  assert.equal(saved.preset, "expert");
  assert.equal(saved.minesPlaced, false);
  assert.equal(saved.elapsedMs, 0);
  assert.equal(saved.revealed.some(Boolean), false);
  assert.equal(saved.flagged.some(Boolean), false);
  assert.notEqual(saved.randomState, state.randomState);
});
