// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  canMove2048,
  createGame2048,
  game2048SaveJson,
  moveGame2048,
  parseGame2048Save,
  reduceGame2048,
  restoreGame2048,
  updateGame2048Save,
} from "../src/index.ts";

function state(
  board: readonly number[],
  overrides: Partial<Parameters<typeof restoreGame2048>[0]> = {},
) {
  return restoreGame2048({
    board,
    score: 0,
    status: "active",
    continued: false,
    randomState: 1,
    ...overrides,
  });
}

test("2048 starts deterministically with two tiles", () => {
  const first = createGame2048(42);
  const second = createGame2048(42);
  assert.deepEqual(first, second);
  assert.equal(first.board.filter(Boolean).length, 2);
  assert.ok(first.board.every((value) => value === 0 || value === 2 || value === 4));
  assert.equal(first.score, 0);
});

test("2048 merges each tile at most once and spawns only after a changed move", () => {
  const initial = state([2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const moved = reduceGame2048(initial, { type: "move", direction: "left" });
  assert.deepEqual(moved.board.slice(0, 2), [4, 4]);
  assert.equal(moved.score, 8);
  assert.equal(moved.board.filter(Boolean).length, 3);
  assert.deepEqual(initial.board.slice(0, 4), [2, 2, 2, 2]);

  const blocked = state([2, 4, 8, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(reduceGame2048(blocked, { type: "move", direction: "left" }), blocked);
});

test("2048 traces exact sources, merge destinations, and its single deterministic spawn", () => {
  const initial = state([2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const result = moveGame2048(initial, "left");

  assert.equal(result.trace.changed, true);
  assert.deepEqual(result.trace.landedBoard.slice(0, 4), [4, 4, 0, 0]);
  assert.deepEqual(result.trace.merges, [
    { sources: [0, 1], destination: 0, value: 4 },
    { sources: [2, 3], destination: 1, value: 4 },
  ]);
  assert.deepEqual(result.trace.motions, [
    { source: 0, destination: 0, value: 2, resultValue: 4, merged: true },
    { source: 1, destination: 0, value: 2, resultValue: 4, merged: true },
    { source: 2, destination: 1, value: 2, resultValue: 4, merged: true },
    { source: 3, destination: 1, value: 2, resultValue: 4, merged: true },
  ]);
  assert.deepEqual(result.trace.spawn, { index: 2, value: 2 });
  assert.deepEqual(result.state.board.slice(0, 4), [4, 4, 2, 0]);
  assert.deepEqual(reduceGame2048(initial, { type: "move", direction: "left" }), result.state);
});

test("2048 no-op traces do not consume PRNG state or replace undo", () => {
  const initial = state([2, 4, 8, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], {
    randomState: 99,
  });
  const result = moveGame2048(initial, "left");
  assert.equal(result.state, initial);
  assert.deepEqual(result.trace, {
    direction: "left",
    changed: false,
    landedBoard: initial.board,
    motions: [],
    merges: [],
  });
  assert.equal(result.state.randomState, 99);
  assert.equal(result.state.undo, undefined);
});

test("2048 applies all four movement directions to rows and columns", () => {
  const cases = [
    { direction: "left" as const, board: [2, 2, 0, 0, ...Array<number>(12).fill(0)], merged: 0 },
    { direction: "right" as const, board: [2, 2, 0, 0, ...Array<number>(12).fill(0)], merged: 3 },
    {
      direction: "up" as const,
      board: [2, 0, 0, 0, 2, 0, 0, 0, ...Array<number>(8).fill(0)],
      merged: 0,
    },
    {
      direction: "down" as const,
      board: [2, 0, 0, 0, 2, 0, 0, 0, ...Array<number>(8).fill(0)],
      merged: 12,
    },
  ];
  for (const fixture of cases) {
    const moved = reduceGame2048(state(fixture.board), {
      type: "move",
      direction: fixture.direction,
    });
    assert.equal(moved.board[fixture.merged], 4, fixture.direction);
    assert.equal(moved.score, 4, fixture.direction);
  }
});

test("2048 undo restores board score status and PRNG exactly once", () => {
  const initial = state([2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], {
    score: 12,
    randomState: 99,
  });
  const moved = reduceGame2048(initial, { type: "move", direction: "left" });
  const undone = reduceGame2048(moved, { type: "undo" });
  assert.deepEqual(undone.board, initial.board);
  assert.equal(undone.score, initial.score);
  assert.equal(undone.randomState, initial.randomState);
  assert.equal(undone.undo, undefined);
  assert.equal(reduceGame2048(undone, { type: "undo" }), undone);
});

test("2048 win continuation and game-over detection are explicit", () => {
  const winning = state([1024, 1024, 0, 0, 16, 32, 64, 128, 2, 4, 8, 16, 32, 64, 128, 256]);
  const won = reduceGame2048(winning, { type: "move", direction: "left" });
  assert.equal(won.status, "won");
  assert.ok(won.board.includes(2048));
  const continued = reduceGame2048(won, { type: "continue" });
  assert.equal(continued.continued, true);
  assert.equal(continued.status, "active");

  assert.equal(canMove2048([2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2]), false);
  assert.equal(canMove2048([2, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2, 4, 8, 16, 32]), true);
});

test("2048 restart clears undo and uses the supplied seed", () => {
  const moved = reduceGame2048(createGame2048(5), { type: "move", direction: "left" });
  const restarted = reduceGame2048(moved, { type: "restart", seed: 77 });
  assert.deepEqual(restarted, createGame2048(77));
  assert.equal(restarted.undo, undefined);
});

test("2048 preserves tile, score, and immutability invariants across deterministic play", () => {
  let current = createGame2048(123456);
  const directions = ["left", "up", "right", "down"] as const;
  for (let move = 0; move < 2_000; move += 1) {
    if (current.status === "won") current = reduceGame2048(current, { type: "continue" });
    if (current.status === "lost")
      current = reduceGame2048(current, { type: "restart", seed: move + 1 });
    const previous = current;
    const direction = directions[move % 4] as (typeof directions)[number];
    const result = moveGame2048(current, direction);
    current = result.state;
    assert.deepEqual(reduceGame2048(previous, { type: "move", direction }), current);
    assert.equal(result.trace.changed, current !== previous);
    for (const motion of result.trace.motions) {
      assert.equal(previous.board[motion.source], motion.value);
      assert.equal(current.board[motion.destination], motion.resultValue);
    }
    if (result.trace.spawn !== undefined) {
      assert.equal(current.board[result.trace.spawn.index], result.trace.spawn.value);
    }
    assert.equal(current.board.length, 16);
    assert.ok(current.board.every((tile) => tile === 0 || Number.isInteger(Math.log2(tile))));
    assert.ok(current.score >= previous.score);
    assert.equal(Object.isFrozen(current), true);
    assert.equal(Object.isFrozen(current.board), true);
  }
});

test("2048 save data round-trips exactly and rejects malformed versions", () => {
  const moved = reduceGame2048(state([2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), {
    type: "move",
    direction: "left",
  });
  const document = updateGame2048Save(moved, 100);
  assert.deepEqual(parseGame2048Save(game2048SaveJson(document)), document);
  assert.throws(() => parseGame2048Save({ version: 2, bestScore: 0, game: {} }), /Unsupported/);
  assert.throws(
    () =>
      parseGame2048Save({
        version: 1,
        bestScore: 0,
        game: {
          algorithmVersion: 1,
          board: Array(16).fill(3),
          score: 0,
          status: "active",
          continued: false,
          randomState: 1,
        },
      }),
    /invalid tile/,
  );
});
