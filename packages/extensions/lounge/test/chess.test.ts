// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyChessMove,
  CHESS_START_FEN,
  chessFen,
  chessMoveToUci,
  chessSquare,
  chessSquareName,
  chessStatus,
  isChessCheckmate,
  isChessInCheck,
  isChessStalemate,
  legalChessMoves,
  parseChessFen,
  parseUciMove,
} from "../src/index.ts";

function moves(fen: string): readonly string[] {
  return legalChessMoves(parseChessFen(fen)).map(chessMoveToUci);
}

test("chess squares use a1 = 0 through h8 = 63", () => {
  assert.equal(chessSquare("a1"), 0);
  assert.equal(chessSquare("h1"), 7);
  assert.equal(chessSquare("a8"), 56);
  assert.equal(chessSquare("h8"), 63);
  assert.equal(chessSquareName(36), "e5");
  assert.throws(() => chessSquare("a9"), /algebraic/);
  assert.throws(() => chessSquareName(64), /0 through 63/);
});

test("FEN parsing preserves every position field and serializes canonically", () => {
  const position = parseChessFen("r3k2r/8/8/3pP3/8/8/8/R3K2R w qKQk d6 0 27");
  assert.equal(position.board[0], "R");
  assert.equal(position.board[63], "r");
  assert.equal(position.sideToMove, "white");
  assert.deepEqual(position.castlingRights, {
    whiteKingSide: true,
    whiteQueenSide: true,
    blackKingSide: true,
    blackQueenSide: true,
  });
  assert.equal(position.enPassantTarget, chessSquare("d6"));
  assert.equal(position.halfmoveClock, 0);
  assert.equal(position.fullmoveNumber, 27);
  assert.equal(chessFen(position), "r3k2r/8/8/3pP3/8/8/8/R3K2R w KQkq d6 0 27");
});

test("strict FEN validation rejects malformed and incoherent positions", () => {
  const invalid = [
    ["8/8/8/8/8/8/8/8 w - - 0", /six fields/],
    ["8/8/8/8/8/8/8/4K3 w - - 0 1", /black king/],
    ["4k3/8/8/8/8/8/4K3/4K3 w - - 0 1", /white king/],
    ["P3k3/8/8/8/8/8/8/4K3 w - - 0 1", /terminal rank/],
    ["8/8/8/8/8/8/4k3/4K3 w - - 0 1", /adjacent/],
    ["4k3/8/8/8/8/8/8/4K3 w K - 0 1", /castling right/],
    ["4k3/8/8/8/8/8/8/4K3 w - e6 0 1", /en-passant/],
    ["4k3/8/8/3p4/8/8/8/4K3 w - d6 1 1", /en-passant/],
    ["4k3/8/8/8/8/8/8/4K3 w - - -1 1", /halfmove/],
    ["4k3/8/8/8/8/8/8/4K3 w - - 0 0", /fullmove/],
    ["4k3/4R3/8/8/8/8/4r3/4K3 w - - 0 1", /both kings/],
    ["4k3/4R3/8/8/8/8/8/4K3 w - - 0 1", /just moved/],
    ["4k3/8/8/8/8/8/4r3/4K3 b - - 0 1", /just moved/],
  ] as const;
  for (const [fen, pattern] of invalid) assert.throws(() => parseChessFen(fen), pattern, fen);

  const repeatedCastlingRights = "K".repeat(100_000);
  assert.throws(
    () => parseChessFen(`4k3/8/8/8/8/8/8/4K3 w ${repeatedCastlingRights} - 0 1`),
    /castling rights/,
  );
});

test("UCI parsing and serialization support ordinary moves and all promotions", () => {
  assert.deepEqual(parseUciMove("e2e4"), { from: 12, to: 28 });
  assert.deepEqual(parseUciMove("a7a8n"), { from: 48, to: 56, promotion: "knight" });
  for (const uci of ["a7a8q", "a7a8r", "a7a8b", "a7a8n"])
    assert.equal(chessMoveToUci(parseUciMove(uci)), uci);
  assert.throws(() => parseUciMove("e2-e4"), /UCI/);
  assert.throws(() => parseUciMove("a7a8k"), /UCI/);
});

test("ordinary pieces slide, jump, push, double, and capture legally", () => {
  assert.deepEqual(moves(CHESS_START_FEN), [
    "b1a3",
    "b1c3",
    "g1f3",
    "g1h3",
    "a2a3",
    "a2a4",
    "b2b3",
    "b2b4",
    "c2c3",
    "c2c4",
    "d2d3",
    "d2d4",
    "e2e3",
    "e2e4",
    "f2f3",
    "f2f4",
    "g2g3",
    "g2g4",
    "h2h3",
    "h2h4",
  ]);
  const pieceMoves = moves("4k3/8/8/3p4/2BQN3/8/8/R3K3 w - - 0 1");
  for (const expected of ["a1a8", "c4d5", "d4d5", "e4d6", "e1f2"])
    assert.ok(pieceMoves.includes(expected), expected);
});

test("promotion generates queen, rook, bishop, and knight in stable order", () => {
  const promotionMoves = moves("7k/P7/8/8/8/8/8/7K w - - 0 1").filter((move) =>
    move.startsWith("a7a8"),
  );
  assert.deepEqual(promotionMoves, ["a7a8q", "a7a8r", "a7a8b", "a7a8n"]);
  const promoted = applyChessMove(parseChessFen("7k/P7/8/8/8/8/8/7K w - - 0 1"), "a7a8n");
  assert.equal(promoted.board[chessSquare("a8")], "N");
});

test("en passant captures the passed pawn but cannot expose its own king", () => {
  const available = parseChessFen("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2");
  assert.ok(legalChessMoves(available).some((move) => chessMoveToUci(move) === "e5d6"));
  const captured = applyChessMove(available, "e5d6");
  assert.equal(captured.board[chessSquare("d6")], "P");
  assert.equal(captured.board[chessSquare("d5")], null);
  assert.equal(captured.enPassantTarget, null);

  const pinned = parseChessFen("k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 2");
  assert.equal(
    legalChessMoves(pinned).some((move) => chessMoveToUci(move) === "e5d6"),
    false,
  );
});

test("castling checks rights, occupancy, attacked transit squares, and removes rights", () => {
  const open = parseChessFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  assert.ok(moves(chessFen(open)).includes("e1g1"));
  assert.ok(moves(chessFen(open)).includes("e1c1"));
  const castled = applyChessMove(open, "e1g1");
  assert.equal(castled.board[chessSquare("g1")], "K");
  assert.equal(castled.board[chessSquare("f1")], "R");
  assert.equal(castled.castlingRights.whiteKingSide, false);
  assert.equal(castled.castlingRights.whiteQueenSide, false);

  const attackedTransit = parseChessFen("r3kr1r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  assert.equal(moves(chessFen(attackedTransit)).includes("e1g1"), false);
  assert.ok(moves(chessFen(attackedTransit)).includes("e1c1"));

  const rookMoved = applyChessMove(open, "a1a2");
  assert.equal(rookMoved.castlingRights.whiteQueenSide, false);
  assert.equal(rookMoved.castlingRights.whiteKingSide, true);
});

test("checks and pins restrict legal moves to valid evasions", () => {
  const pinned = parseChessFen("k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1");
  assert.equal(moves(chessFen(pinned)).includes("e2d2"), false);
  assert.ok(moves(chessFen(pinned)).includes("e2e8"));

  const checked = parseChessFen("4k3/8/8/8/8/8/4r3/4K3 w - - 0 1");
  assert.equal(isChessInCheck(checked), true);
  assert.deepEqual(moves(chessFen(checked)), ["e1d1", "e1f1", "e1e2"]);
  assert.throws(() => applyChessMove(checked, "e1d2"), /Illegal/);
});

test("checkmate and stalemate are distinguished", () => {
  const mate = parseChessFen("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1");
  assert.equal(chessStatus(mate), "checkmate");
  assert.equal(isChessCheckmate(mate), true);
  assert.equal(isChessStalemate(mate), false);

  const stalemate = parseChessFen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
  assert.equal(chessStatus(stalemate), "stalemate");
  assert.equal(isChessStalemate(stalemate), true);
  assert.equal(isChessCheckmate(stalemate), false);
});

test("state transitions and generated moves are deeply immutable", () => {
  const initial = parseChessFen(CHESS_START_FEN);
  const before = chessFen(initial);
  const generated = legalChessMoves(initial);
  const next = applyChessMove(initial, "e2e4");
  assert.equal(chessFen(initial), before);
  assert.equal(initial.board[chessSquare("e2")], "P");
  assert.equal(next.board[chessSquare("e2")], null);
  assert.equal(next.board[chessSquare("e4")], "P");
  assert.equal(next.enPassantTarget, chessSquare("e3"));
  assert.equal(next.sideToMove, "black");
  assert.equal(Object.isFrozen(initial), true);
  assert.equal(Object.isFrozen(initial.board), true);
  assert.equal(Object.isFrozen(initial.castlingRights), true);
  assert.equal(Object.isFrozen(generated), true);
  assert.equal(Object.isFrozen(generated[0]), true);
  assert.equal(Object.isFrozen(next), true);
  assert.equal(Object.isFrozen(next.board), true);
  assert.equal(Object.isFrozen(next.castlingRights), true);
});
