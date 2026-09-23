// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

export const CHESS_START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export type ChessColor = "white" | "black";
export type ChessPiece = "P" | "N" | "B" | "R" | "Q" | "K" | "p" | "n" | "b" | "r" | "q" | "k";
export type ChessPromotion = "queen" | "rook" | "bishop" | "knight";

export interface ChessCastlingRights {
  readonly whiteKingSide: boolean;
  readonly whiteQueenSide: boolean;
  readonly blackKingSide: boolean;
  readonly blackQueenSide: boolean;
}

export interface ChessPosition {
  readonly board: readonly (ChessPiece | null)[];
  readonly sideToMove: ChessColor;
  readonly castlingRights: ChessCastlingRights;
  readonly enPassantTarget: number | null;
  readonly halfmoveClock: number;
  readonly fullmoveNumber: number;
}

export interface ChessMove {
  readonly from: number;
  readonly to: number;
  readonly promotion?: ChessPromotion;
}

export type ChessStatus = "active" | "checkmate" | "stalemate";

const PIECES = new Set<ChessPiece>(["P", "N", "B", "R", "Q", "K", "p", "n", "b", "r", "q", "k"]);
const PROMOTIONS: readonly ChessPromotion[] = Object.freeze(["queen", "rook", "bishop", "knight"]);
const PROMOTION_UCI: Readonly<Record<ChessPromotion, string>> = Object.freeze({
  queen: "q",
  rook: "r",
  bishop: "b",
  knight: "n",
});
const UCI_PROMOTION: Readonly<Record<string, ChessPromotion>> = Object.freeze({
  q: "queen",
  r: "rook",
  b: "bishop",
  n: "knight",
});
const KNIGHT_OFFSETS = Object.freeze([
  [-2, -1],
  [-2, 1],
  [-1, -2],
  [-1, 2],
  [1, -2],
  [1, 2],
  [2, -1],
  [2, 1],
] as const);
const KING_OFFSETS = Object.freeze([
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
] as const);
const BISHOP_DIRECTIONS = Object.freeze([
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
] as const);
const ROOK_DIRECTIONS = Object.freeze([
  [-1, 0],
  [0, -1],
  [0, 1],
  [1, 0],
] as const);
const ALL_DIRECTIONS = Object.freeze([...BISHOP_DIRECTIONS, ...ROOK_DIRECTIONS]);

function freezeCastlingRights(rights: ChessCastlingRights): ChessCastlingRights {
  return Object.freeze({ ...rights });
}

function freezePosition(position: ChessPosition): ChessPosition {
  return Object.freeze({
    ...position,
    board: Object.freeze([...position.board]),
    castlingRights: freezeCastlingRights(position.castlingRights),
  });
}

function freezeMove(move: ChessMove): ChessMove {
  return Object.freeze({
    from: move.from,
    to: move.to,
    ...(move.promotion === undefined ? {} : { promotion: move.promotion }),
  });
}

function opposite(color: ChessColor): ChessColor {
  return color === "white" ? "black" : "white";
}

function colorOf(piece: ChessPiece): ChessColor {
  return piece === piece.toUpperCase() ? "white" : "black";
}

function kindOf(piece: ChessPiece): string {
  return piece.toLowerCase();
}

function square(file: number, rank: number): number {
  return rank * 8 + file;
}

function fileOf(index: number): number {
  return index % 8;
}

function rankOf(index: number): number {
  return Math.floor(index / 8);
}

function onBoard(file: number, rank: number): boolean {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}

function assertSquare(index: number, label: string): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 64) {
    throw new RangeError(`${label} must be a square from 0 through 63`);
  }
}

export function chessSquare(name: string): number {
  if (!/^[a-h][1-8]$/u.test(name))
    throw new TypeError("Chess square must use algebraic coordinates");
  return square(name.charCodeAt(0) - 97, Number(name[1]) - 1);
}

export function chessSquareName(index: number): string {
  assertSquare(index, "Chess square");
  return `${String.fromCharCode(97 + fileOf(index))}${rankOf(index) + 1}`;
}

export function parseUciMove(value: string): ChessMove {
  const match = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/u.exec(value);
  if (match === null)
    throw new TypeError(
      "UCI move must contain two squares and an optional q, r, b, or n promotion",
    );
  const promotionCode = match[3];
  return freezeMove({
    from: chessSquare(match[1] as string),
    to: chessSquare(match[2] as string),
    ...(promotionCode === undefined
      ? {}
      : { promotion: UCI_PROMOTION[promotionCode] as ChessPromotion }),
  });
}

export function chessMoveToUci(move: ChessMove): string {
  assertSquare(move.from, "Move source");
  assertSquare(move.to, "Move destination");
  if (move.promotion !== undefined && !PROMOTIONS.includes(move.promotion)) {
    throw new TypeError("Chess promotion must be queen, rook, bishop, or knight");
  }
  return `${chessSquareName(move.from)}${chessSquareName(move.to)}${
    move.promotion === undefined ? "" : PROMOTION_UCI[move.promotion]
  }`;
}

function parseBoard(value: string): readonly (ChessPiece | null)[] {
  const ranks = value.split("/");
  if (ranks.length !== 8) throw new TypeError("FEN board must contain eight ranks");
  const board = Array<ChessPiece | null>(64).fill(null);
  for (let fenRank = 0; fenRank < 8; fenRank += 1) {
    let file = 0;
    for (const token of ranks[fenRank] as string) {
      if (/^[1-8]$/u.test(token)) {
        file += Number(token);
      } else if (PIECES.has(token as ChessPiece)) {
        if (file >= 8) throw new TypeError("FEN rank contains more than eight squares");
        board[square(file, 7 - fenRank)] = token as ChessPiece;
        file += 1;
      } else {
        throw new TypeError("FEN board contains an invalid piece or empty-square count");
      }
    }
    if (file !== 8) throw new TypeError("Each FEN rank must contain exactly eight squares");
  }
  return Object.freeze(board);
}

function parseCastlingRights(value: string): ChessCastlingRights {
  if (value !== "-") {
    const seen = new Set<string>();
    if (value.length === 0 || value.length > 4) {
      throw new TypeError("FEN castling rights are invalid");
    }
    for (const right of value) {
      if (!"KQkq".includes(right) || seen.has(right)) {
        throw new TypeError("FEN castling rights are invalid");
      }
      seen.add(right);
    }
  }
  return freezeCastlingRights({
    whiteKingSide: value.includes("K"),
    whiteQueenSide: value.includes("Q"),
    blackKingSide: value.includes("k"),
    blackQueenSide: value.includes("q"),
  });
}

function parseCounter(value: string, label: string, minimum: number): number {
  if (!/^(0|[1-9]\d*)$/u.test(value)) throw new TypeError(`FEN ${label} is invalid`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum)
    throw new TypeError(`FEN ${label} is invalid`);
  return result;
}

function kingSquare(position: ChessPosition, color: ChessColor): number {
  const king = color === "white" ? "K" : "k";
  return position.board.indexOf(king);
}

function validateCastlingCoherence(position: ChessPosition): void {
  const { board, castlingRights: rights } = position;
  if (rights.whiteKingSide && (board[4] !== "K" || board[7] !== "R"))
    throw new TypeError("FEN white king-side castling right is incoherent");
  if (rights.whiteQueenSide && (board[4] !== "K" || board[0] !== "R"))
    throw new TypeError("FEN white queen-side castling right is incoherent");
  if (rights.blackKingSide && (board[60] !== "k" || board[63] !== "r"))
    throw new TypeError("FEN black king-side castling right is incoherent");
  if (rights.blackQueenSide && (board[60] !== "k" || board[56] !== "r"))
    throw new TypeError("FEN black queen-side castling right is incoherent");
}

function validateEnPassant(position: ChessPosition): void {
  const target = position.enPassantTarget;
  if (target === null) return;
  const expectedRank = position.sideToMove === "white" ? 5 : 2;
  const pawnSquare = target + (position.sideToMove === "white" ? -8 : 8);
  const originSquare = target + (position.sideToMove === "white" ? 8 : -8);
  const pawn = position.sideToMove === "white" ? "p" : "P";
  if (
    rankOf(target) !== expectedRank ||
    position.board[target] !== null ||
    position.board[pawnSquare] !== pawn ||
    position.board[originSquare] !== null ||
    position.halfmoveClock !== 0
  ) {
    throw new TypeError("FEN en-passant target is impossible");
  }
}

function validatePosition(position: ChessPosition): void {
  if (position.board.filter((piece) => piece === "K").length !== 1)
    throw new TypeError("FEN must contain exactly one white king");
  if (position.board.filter((piece) => piece === "k").length !== 1)
    throw new TypeError("FEN must contain exactly one black king");
  for (let file = 0; file < 8; file += 1) {
    if (
      position.board[file]?.toLowerCase() === "p" ||
      position.board[56 + file]?.toLowerCase() === "p"
    )
      throw new TypeError("FEN pawns cannot occupy a terminal rank");
  }
  const whiteKing = kingSquare(position, "white");
  const blackKing = kingSquare(position, "black");
  if (
    Math.abs(fileOf(whiteKing) - fileOf(blackKing)) <= 1 &&
    Math.abs(rankOf(whiteKing) - rankOf(blackKing)) <= 1
  ) {
    throw new TypeError("FEN kings cannot be adjacent");
  }
  validateCastlingCoherence(position);
  validateEnPassant(position);
  const whiteInCheck = isChessSquareAttacked(position, whiteKing, "black");
  const blackInCheck = isChessSquareAttacked(position, blackKing, "white");
  if (whiteInCheck && blackInCheck) throw new TypeError("FEN cannot place both kings in check");
  const inactiveKingInCheck = position.sideToMove === "white" ? blackInCheck : whiteInCheck;
  if (inactiveKingInCheck) throw new TypeError("FEN side that just moved cannot remain in check");
}

export function parseChessFen(fen: string): ChessPosition {
  const fields = fen.split(" ");
  if (fields.length !== 6 || fields.some((field) => field.length === 0))
    throw new TypeError("FEN must contain exactly six fields separated by single spaces");
  const [boardField, sideField, castlingField, enPassantField, halfmoveField, fullmoveField] =
    fields as [string, string, string, string, string, string];
  if (sideField !== "w" && sideField !== "b")
    throw new TypeError("FEN side to move must be w or b");
  const position = freezePosition({
    board: parseBoard(boardField),
    sideToMove: sideField === "w" ? "white" : "black",
    castlingRights: parseCastlingRights(castlingField),
    enPassantTarget: enPassantField === "-" ? null : chessSquare(enPassantField),
    halfmoveClock: parseCounter(halfmoveField, "halfmove clock", 0),
    fullmoveNumber: parseCounter(fullmoveField, "fullmove number", 1),
  });
  validatePosition(position);
  return position;
}

export function chessFen(position: ChessPosition): string {
  const ranks: string[] = [];
  for (let rank = 7; rank >= 0; rank -= 1) {
    let empty = 0;
    let encoded = "";
    for (let file = 0; file < 8; file += 1) {
      const piece = position.board[square(file, rank)];
      if (piece === null || piece === undefined) {
        empty += 1;
      } else {
        if (empty > 0) encoded += String(empty);
        encoded += piece;
        empty = 0;
      }
    }
    if (empty > 0) encoded += String(empty);
    ranks.push(encoded);
  }
  const rights = `${position.castlingRights.whiteKingSide ? "K" : ""}${
    position.castlingRights.whiteQueenSide ? "Q" : ""
  }${position.castlingRights.blackKingSide ? "k" : ""}${
    position.castlingRights.blackQueenSide ? "q" : ""
  }`;
  return `${ranks.join("/")} ${position.sideToMove === "white" ? "w" : "b"} ${
    rights || "-"
  } ${position.enPassantTarget === null ? "-" : chessSquareName(position.enPassantTarget)} ${
    position.halfmoveClock
  } ${position.fullmoveNumber}`;
}

export function isChessSquareAttacked(
  position: ChessPosition,
  target: number,
  byColor: ChessColor,
): boolean {
  assertSquare(target, "Attack target");
  const targetFile = fileOf(target);
  const targetRank = rankOf(target);
  const pawn = byColor === "white" ? "P" : "p";
  const pawnSourceRank = targetRank + (byColor === "white" ? -1 : 1);
  for (const fileOffset of [-1, 1]) {
    const sourceFile = targetFile + fileOffset;
    if (
      onBoard(sourceFile, pawnSourceRank) &&
      position.board[square(sourceFile, pawnSourceRank)] === pawn
    )
      return true;
  }
  const knight = byColor === "white" ? "N" : "n";
  for (const [fileOffset, rankOffset] of KNIGHT_OFFSETS) {
    const sourceFile = targetFile + fileOffset;
    const sourceRank = targetRank + rankOffset;
    if (
      onBoard(sourceFile, sourceRank) &&
      position.board[square(sourceFile, sourceRank)] === knight
    )
      return true;
  }
  const king = byColor === "white" ? "K" : "k";
  for (const [fileOffset, rankOffset] of KING_OFFSETS) {
    const sourceFile = targetFile + fileOffset;
    const sourceRank = targetRank + rankOffset;
    if (onBoard(sourceFile, sourceRank) && position.board[square(sourceFile, sourceRank)] === king)
      return true;
  }
  for (const [fileOffset, rankOffset] of ALL_DIRECTIONS) {
    let sourceFile = targetFile + fileOffset;
    let sourceRank = targetRank + rankOffset;
    while (onBoard(sourceFile, sourceRank)) {
      const piece = position.board[square(sourceFile, sourceRank)];
      if (piece !== null && piece !== undefined) {
        if (colorOf(piece) === byColor) {
          const kind = kindOf(piece);
          const diagonal = fileOffset !== 0 && rankOffset !== 0;
          if (kind === "q" || (diagonal ? kind === "b" : kind === "r")) return true;
        }
        break;
      }
      sourceFile += fileOffset;
      sourceRank += rankOffset;
    }
  }
  return false;
}

export function isChessInCheck(
  position: ChessPosition,
  color: ChessColor = position.sideToMove,
): boolean {
  return isChessSquareAttacked(position, kingSquare(position, color), opposite(color));
}

function pushMove(moves: ChessMove[], from: number, to: number, promotionRank = false): void {
  if (promotionRank) {
    for (const promotion of PROMOTIONS) moves.push({ from, to, promotion });
  } else {
    moves.push({ from, to });
  }
}

function addPawnMoves(position: ChessPosition, from: number, moves: ChessMove[]): void {
  const color = position.sideToMove;
  const direction = color === "white" ? 1 : -1;
  const startRank = color === "white" ? 1 : 6;
  const promotionRank = color === "white" ? 7 : 0;
  const file = fileOf(from);
  const rank = rankOf(from);
  const oneRank = rank + direction;
  if (onBoard(file, oneRank)) {
    const one = square(file, oneRank);
    if (position.board[one] === null) {
      pushMove(moves, from, one, oneRank === promotionRank);
      const twoRank = rank + direction * 2;
      if (rank === startRank && position.board[square(file, twoRank)] === null)
        moves.push({ from, to: square(file, twoRank) });
    }
  }
  for (const fileOffset of [-1, 1]) {
    const targetFile = file + fileOffset;
    const targetRank = rank + direction;
    if (!onBoard(targetFile, targetRank)) continue;
    const to = square(targetFile, targetRank);
    const target = position.board[to];
    if (
      (target !== null && target !== undefined && colorOf(target) !== color) ||
      position.enPassantTarget === to
    )
      pushMove(moves, from, to, targetRank === promotionRank);
  }
}

function addJumpMoves(
  position: ChessPosition,
  from: number,
  offsets: readonly (readonly [number, number])[],
  moves: ChessMove[],
): void {
  const file = fileOf(from);
  const rank = rankOf(from);
  for (const [fileOffset, rankOffset] of offsets) {
    const targetFile = file + fileOffset;
    const targetRank = rank + rankOffset;
    if (!onBoard(targetFile, targetRank)) continue;
    const to = square(targetFile, targetRank);
    const target = position.board[to];
    if (target === null || target === undefined || colorOf(target) !== position.sideToMove)
      moves.push({ from, to });
  }
}

function addSlidingMoves(
  position: ChessPosition,
  from: number,
  directions: readonly (readonly [number, number])[],
  moves: ChessMove[],
): void {
  for (const [fileOffset, rankOffset] of directions) {
    let file = fileOf(from) + fileOffset;
    let rank = rankOf(from) + rankOffset;
    while (onBoard(file, rank)) {
      const to = square(file, rank);
      const target = position.board[to];
      if (target === null || target === undefined) {
        moves.push({ from, to });
      } else {
        if (colorOf(target) !== position.sideToMove) moves.push({ from, to });
        break;
      }
      file += fileOffset;
      rank += rankOffset;
    }
  }
}

function addCastlingMoves(position: ChessPosition, moves: ChessMove[]): void {
  const color = position.sideToMove;
  const enemy = opposite(color);
  const rank = color === "white" ? 0 : 7;
  const kingFrom = square(4, rank);
  const rights = position.castlingRights;
  if (isChessSquareAttacked(position, kingFrom, enemy)) return;
  const kingSide = color === "white" ? rights.whiteKingSide : rights.blackKingSide;
  if (
    kingSide &&
    position.board[square(5, rank)] === null &&
    position.board[square(6, rank)] === null &&
    !isChessSquareAttacked(position, square(5, rank), enemy) &&
    !isChessSquareAttacked(position, square(6, rank), enemy)
  ) {
    moves.push({ from: kingFrom, to: square(6, rank) });
  }
  const queenSide = color === "white" ? rights.whiteQueenSide : rights.blackQueenSide;
  if (
    queenSide &&
    position.board[square(1, rank)] === null &&
    position.board[square(2, rank)] === null &&
    position.board[square(3, rank)] === null &&
    !isChessSquareAttacked(position, square(3, rank), enemy) &&
    !isChessSquareAttacked(position, square(2, rank), enemy)
  ) {
    moves.push({ from: kingFrom, to: square(2, rank) });
  }
}

function pseudoLegalMoves(position: ChessPosition): readonly ChessMove[] {
  const moves: ChessMove[] = [];
  for (let from = 0; from < 64; from += 1) {
    const piece = position.board[from];
    if (piece === null || piece === undefined || colorOf(piece) !== position.sideToMove) continue;
    switch (kindOf(piece)) {
      case "p":
        addPawnMoves(position, from, moves);
        break;
      case "n":
        addJumpMoves(position, from, KNIGHT_OFFSETS, moves);
        break;
      case "b":
        addSlidingMoves(position, from, BISHOP_DIRECTIONS, moves);
        break;
      case "r":
        addSlidingMoves(position, from, ROOK_DIRECTIONS, moves);
        break;
      case "q":
        addSlidingMoves(position, from, ALL_DIRECTIONS, moves);
        break;
      case "k":
        addJumpMoves(position, from, KING_OFFSETS, moves);
        addCastlingMoves(position, moves);
        break;
    }
  }
  return moves;
}

function removeRookRight(rights: ChessCastlingRights, squareIndex: number): ChessCastlingRights {
  return {
    ...rights,
    ...(squareIndex === 7 ? { whiteKingSide: false } : {}),
    ...(squareIndex === 0 ? { whiteQueenSide: false } : {}),
    ...(squareIndex === 63 ? { blackKingSide: false } : {}),
    ...(squareIndex === 56 ? { blackQueenSide: false } : {}),
  };
}

function applyUnchecked(position: ChessPosition, move: ChessMove): ChessPosition {
  const piece = position.board[move.from] as ChessPiece;
  const color = position.sideToMove;
  const board = [...position.board];
  const target = board[move.to];
  const pawnMove = kindOf(piece) === "p";
  const enPassant = pawnMove && move.to === position.enPassantTarget && target === null;
  board[move.from] = null;
  if (enPassant) board[move.to + (color === "white" ? -8 : 8)] = null;
  const promotedPiece =
    move.promotion === undefined
      ? piece
      : ((color === "white"
          ? PROMOTION_UCI[move.promotion].toUpperCase()
          : PROMOTION_UCI[move.promotion]) as ChessPiece);
  board[move.to] = promotedPiece;

  const castling = kindOf(piece) === "k" && Math.abs(move.to - move.from) === 2;
  if (castling) {
    const kingSide = move.to > move.from;
    const rookFrom = kingSide ? move.from + 3 : move.from - 4;
    const rookTo = kingSide ? move.from + 1 : move.from - 1;
    board[rookTo] = board[rookFrom] as ChessPiece;
    board[rookFrom] = null;
  }

  let rights = removeRookRight(position.castlingRights, move.from);
  rights = removeRookRight(rights, move.to);
  if (piece === "K") rights = { ...rights, whiteKingSide: false, whiteQueenSide: false };
  if (piece === "k") rights = { ...rights, blackKingSide: false, blackQueenSide: false };

  return freezePosition({
    board,
    sideToMove: opposite(color),
    castlingRights: rights,
    enPassantTarget:
      pawnMove && Math.abs(move.to - move.from) === 16 ? (move.from + move.to) / 2 : null,
    halfmoveClock: pawnMove || target !== null || enPassant ? 0 : position.halfmoveClock + 1,
    fullmoveNumber: position.fullmoveNumber + (color === "black" ? 1 : 0),
  });
}

function promotionOrder(move: ChessMove): number {
  return move.promotion === undefined ? -1 : PROMOTIONS.indexOf(move.promotion);
}

export function legalChessMoves(position: ChessPosition): readonly ChessMove[] {
  const color = position.sideToMove;
  const moves = pseudoLegalMoves(position)
    .filter((move) => !isChessInCheck(applyUnchecked(position, move), color))
    .sort(
      (left, right) =>
        left.from - right.from ||
        left.to - right.to ||
        promotionOrder(left) - promotionOrder(right),
    )
    .map(freezeMove);
  return Object.freeze(moves);
}

function sameMove(left: ChessMove, right: ChessMove): boolean {
  return left.from === right.from && left.to === right.to && left.promotion === right.promotion;
}

export function applyChessMove(position: ChessPosition, move: ChessMove | string): ChessPosition {
  const candidate = typeof move === "string" ? parseUciMove(move) : freezeMove(move);
  const legal = legalChessMoves(position).find((entry) => sameMove(entry, candidate));
  if (legal === undefined) throw new Error(`Illegal chess move ${chessMoveToUci(candidate)}`);
  return applyUnchecked(position, legal);
}

export function chessStatus(position: ChessPosition): ChessStatus {
  if (legalChessMoves(position).length > 0) return "active";
  return isChessInCheck(position) ? "checkmate" : "stalemate";
}

export function isChessCheckmate(position: ChessPosition): boolean {
  return chessStatus(position) === "checkmate";
}

export function isChessStalemate(position: ChessPosition): boolean {
  return chessStatus(position) === "stalemate";
}
