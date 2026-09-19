// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { CHESS_PUZZLES, CHESS_PUZZLE_SET_REVISION } from "../src/chess-puzzles.generated.ts";
import { chessFen, chessMoveToUci, legalChessMoves } from "../src/chess.ts";
import {
  type ChessPuzzleCatalog,
  type ChessPuzzleSelection,
  type ChessPuzzleState,
  chessPuzzleExpectedMove,
  chessPuzzleHintText,
  createChessPuzzle,
  createDailyChessPuzzleSelection,
  createPracticeChessPuzzleSelection,
  reduceChessPuzzle,
  selectChessPuzzle,
  submitChessPuzzleMove,
} from "../src/index.ts";

const catalog: ChessPuzzleCatalog = Object.freeze({
  revision: CHESS_PUZZLE_SET_REVISION,
  puzzles: CHESS_PUZZLES,
});

function practice(
  seed = 42,
  difficulty: "easy" | "medium" | "hard" = "easy",
): ChessPuzzleSelection {
  return createPracticeChessPuzzleSelection(catalog.revision, seed, difficulty, "any");
}

function solve(selection: ChessPuzzleSelection): ChessPuzzleState {
  let state = createChessPuzzle(catalog, selection);
  while (state.status !== "solved") {
    if (state.status === "reply-pending")
      state = reduceChessPuzzle(catalog, state, { type: "apply-opponent-reply" });
    else state = submitChessPuzzleMove(catalog, state, chessPuzzleExpectedMove(catalog, state));
  }
  return state;
}

test("daily and practice selection hash every versioned input deterministically", () => {
  const daily = createDailyChessPuzzleSelection(catalog.revision, "2026-09-13", "medium", "fork");
  assert.deepEqual(selectChessPuzzle(catalog, daily), selectChessPuzzle(catalog, { ...daily }));
  const selected = selectChessPuzzle(catalog, daily);
  assert.equal(selected.difficulty, "medium");
  assert.ok(selected.themes.includes("fork"));

  const first = selectChessPuzzle(catalog, practice(42));
  const second = selectChessPuzzle(catalog, practice(42));
  assert.equal(first.id, second.id);
  assert.throws(
    () => selectChessPuzzle({ revision: catalog.revision, puzzles: [] }, practice()),
    /No Chess puzzles/,
  );
  assert.throws(
    () => createDailyChessPuzzleSelection(catalog.revision, "2026-02-29", "easy"),
    /invalid/,
  );
  assert.throws(
    () => createPracticeChessPuzzleSelection(catalog.revision, Number.MAX_SAFE_INTEGER + 1, "easy"),
    /safe integer/,
  );
});

test("puzzle progression applies only the exact sourced line", () => {
  let state = createChessPuzzle(catalog, practice());
  const initial = state;
  const initialFen = chessFen(state.position);
  assert.equal(state.playerColor, state.position.sideToMove);
  assert.equal(state.lastMove.actor, "setup");
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.position));

  const expected = chessMoveToUci(chessPuzzleExpectedMove(catalog, state));
  const incorrect = legalChessMoves(state.position).find(
    (move) => chessMoveToUci(move) !== expected,
  );
  assert.ok(incorrect);
  state = submitChessPuzzleMove(catalog, state, incorrect);
  assert.equal(chessFen(state.position), initialFen);
  assert.equal(state.position, initial.position);
  assert.equal(state.incorrectMoves.length, 1);
  assert.equal(state.submittedMoves.length, 1);
  assert.equal(state.expectedSolutionPly, 0);
  assert.equal(initial.incorrectMoves.length, 0);

  state = submitChessPuzzleMove(catalog, state, expected);
  assert.equal(state.expectedSolutionPly, 1);
  assert.equal(state.status, "reply-pending");
  const afterPlayer = state;
  const ignored = reduceChessPuzzle(catalog, state, { type: "move-cursor", direction: "left" });
  assert.equal(ignored, state);
  state = reduceChessPuzzle(catalog, state, { type: "apply-opponent-reply" });
  assert.equal(state.expectedSolutionPly, 2);
  assert.equal(state.status, "active");
  assert.notEqual(chessFen(state.position), chessFen(afterPlayer.position));

  state = solve(state.selection);
  assert.equal(state.status, "solved");
  assert.equal(
    state.expectedSolutionPly,
    selectChessPuzzle(catalog, state.selection).solutionMoves.length,
  );
  assert.equal(state.submittedMoves.length, state.totalPlayerMoves);
  assert.equal(reduceChessPuzzle(catalog, state, { type: "apply-opponent-reply" }), state);
});

test("source selection, legal targets, retries, reselection, and visual cursor motion are immutable", () => {
  let state = createChessPuzzle(catalog, practice(7));
  const expected = chessPuzzleExpectedMove(catalog, state);
  state = reduceChessPuzzle(catalog, state, { type: "set-cursor", square: expected.from });
  const beforeSelection = state;
  state = reduceChessPuzzle(catalog, state, { type: "activate" });
  assert.equal(state.selectedSource, expected.from);
  assert.ok(state.legalTargets.includes(expected.to));
  assert.equal(beforeSelection.selectedSource, undefined);

  const invalidTarget = Array.from({ length: 64 }, (_, square) => square).find(
    (square) => !state.legalTargets.includes(square) && state.position.board[square] === null,
  );
  assert.notEqual(invalidTarget, undefined);
  state = reduceChessPuzzle(catalog, state, {
    type: "set-cursor",
    square: invalidTarget as number,
  });
  state = reduceChessPuzzle(catalog, state, { type: "activate" });
  assert.equal(state.issue, "invalid-destination");
  assert.equal(state.selectedSource, expected.from);

  const friendly = state.position.board.findIndex(
    (piece, square) =>
      square !== expected.from &&
      piece !== null &&
      (piece === piece.toUpperCase()) === (state.playerColor === "white") &&
      legalChessMoves(state.position).some((move) => move.from === square),
  );
  assert.ok(friendly >= 0);
  state = reduceChessPuzzle(catalog, state, { type: "set-cursor", square: friendly });
  state = reduceChessPuzzle(catalog, state, { type: "activate" });
  assert.equal(state.selectedSource, friendly);
  state = reduceChessPuzzle(catalog, state, { type: "activate" });
  assert.equal(state.selectedSource, undefined);

  const white = createChessPuzzle(catalog, practice(11));
  const movedWhite = reduceChessPuzzle(catalog, white, { type: "move-cursor", direction: "up" });
  assert.equal(movedWhite.cursor, Math.min(63, white.cursor + 8));
  const black = reduceChessPuzzle(catalog, white, { type: "flip-board" });
  const movedBlack = reduceChessPuzzle(catalog, black, { type: "move-cursor", direction: "up" });
  assert.equal(movedBlack.cursor, Math.max(0, black.cursor - 8));
});

test("promotion requires an explicit chooser confirmation", () => {
  const fixture = CHESS_PUZZLES.find(({ id }) => id === "0bg6I");
  assert.ok(fixture);
  const promotionCatalog: ChessPuzzleCatalog = Object.freeze({
    revision: catalog.revision,
    puzzles: Object.freeze([fixture]),
  });
  const selection = createPracticeChessPuzzleSelection(
    catalog.revision,
    1,
    fixture.difficulty,
    "any",
  );
  let state = createChessPuzzle(promotionCatalog, selection);
  const expected = chessPuzzleExpectedMove(promotionCatalog, state);
  state = reduceChessPuzzle(promotionCatalog, state, { type: "set-cursor", square: expected.from });
  state = reduceChessPuzzle(promotionCatalog, state, { type: "activate" });
  state = reduceChessPuzzle(promotionCatalog, state, { type: "set-cursor", square: expected.to });
  state = reduceChessPuzzle(promotionCatalog, state, { type: "activate" });
  assert.deepEqual(state.promotionChooser?.choices, ["queen", "rook", "bishop", "knight"]);
  assert.equal(state.expectedSolutionPly, 0);
  state = reduceChessPuzzle(promotionCatalog, state, {
    type: "choose-promotion",
    promotion: "queen",
  });
  state = reduceChessPuzzle(promotionCatalog, state, { type: "confirm-promotion" });
  assert.equal(state.expectedSolutionPly, 1);
});

test("hints advance through source, target, and human-readable instruction", () => {
  let state = createChessPuzzle(catalog, practice(91, "hard"));
  assert.equal(chessPuzzleHintText(catalog, state), undefined);
  for (let level = 1; level <= 3; level += 1) {
    state = reduceChessPuzzle(catalog, state, { type: "hint" });
    assert.equal(state.hintLevel, level);
  }
  assert.match(chessPuzzleHintText(catalog, state) ?? "", /^[A-Z][a-z]+ [a-h][1-8] → [a-h][1-8]$/u);
  assert.equal(reduceChessPuzzle(catalog, state, { type: "hint" }), state);
});
