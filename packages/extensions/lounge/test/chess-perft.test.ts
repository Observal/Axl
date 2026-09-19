// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyChessMove,
  CHESS_START_FEN,
  chessMoveToUci,
  type ChessPosition,
  legalChessMoves,
  parseChessFen,
} from "../src/index.ts";

function perft(position: ChessPosition, depth: number): number {
  if (depth === 0) return 1;
  let nodes = 0;
  for (const move of legalChessMoves(position))
    nodes += perft(applyChessMove(position, move), depth - 1);
  return nodes;
}

function divide(position: ChessPosition, depth: number): ReadonlyMap<string, number> {
  return new Map(
    legalChessMoves(position).map((move) => [
      chessMoveToUci(move),
      perft(applyChessMove(position, move), depth - 1),
    ]),
  );
}

function verify(fen: string, totals: readonly number[]): void {
  const position = parseChessFen(fen);
  for (const [offset, expected] of totals.entries())
    assert.equal(perft(position, offset + 1), expected, `${fen} depth ${offset + 1}`);
}

test("starting position perft through depth four and selected root divides", () => {
  const position = parseChessFen(CHESS_START_FEN);
  verify(CHESS_START_FEN, [20, 400, 8_902, 197_281]);
  const depthFour = divide(position, 4);
  assert.equal(depthFour.get("b1a3"), 8_885);
  assert.equal(depthFour.get("b1c3"), 9_755);
  assert.equal(depthFour.get("d2d4"), 12_435);
  assert.equal(depthFour.get("e2e4"), 13_160);
  assert.equal(depthFour.get("g1f3"), 9_748);
  assert.equal(depthFour.get("g1h3"), 8_881);
  assert.equal(
    [...depthFour.values()].reduce((sum, nodes) => sum + nodes, 0),
    197_281,
  );
});

test("Kiwipete perft covers castling, pins, and slider blockers", () => {
  const fen = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";
  verify(fen, [48, 2_039, 97_862]);
  const depthThree = divide(parseChessFen(fen), 3);
  assert.equal(depthThree.get("d5d6"), 1_991);
  assert.equal(depthThree.get("d5e6"), 2_241);
  assert.equal(
    [...depthThree.values()].reduce((sum, nodes) => sum + nodes, 0),
    97_862,
  );
});

test("position three perft covers en passant and discovered pins", () => {
  verify("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", [14, 191, 2_812, 43_238]);
});

test("position four perft covers promotion and castling", () => {
  verify("r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", [6, 264, 9_467]);
});

test("position five perft covers promotion and check evasion", () => {
  verify("rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", [44, 1_486, 62_379]);
});

test("position six perft covers tactical check evasion", () => {
  verify(
    "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
    [46, 2_079, 89_890],
  );
});
