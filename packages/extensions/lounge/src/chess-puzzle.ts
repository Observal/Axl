// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { ChessPuzzleRecord as GeneratedChessPuzzleRecord } from "./chess-puzzles.generated.ts";
import {
  applyChessMove,
  type ChessColor,
  type ChessMove,
  type ChessPosition,
  type ChessPromotion,
  chessFen,
  chessMoveToUci,
  chessSquareName,
  legalChessMoves,
  parseChessFen,
  parseUciMove,
} from "./chess.ts";

export const CHESS_PUZZLE_SELECTION_VERSION = 1;

export type ChessPuzzleDifficulty = "easy" | "medium" | "hard";
export type ChessPuzzleTheme =
  | "any"
  | "fork"
  | "pin"
  | "skewer"
  | "discoveredAttack"
  | "deflection"
  | "sacrifice"
  | "promotion"
  | "mate"
  | "advancedPawn";
export type ChessPuzzleMode = "daily" | "practice";
export type ChessPuzzleStatus = "active" | "reply-pending" | "solved";
export type ChessPuzzleDirection = "up" | "down" | "left" | "right";
export type ChessPuzzleIssueCode =
  | "not-your-piece"
  | "invalid-destination"
  | "incorrect-move"
  | "reply-pending"
  | "puzzle-solved";

export type ChessPuzzleRecord = GeneratedChessPuzzleRecord;

export interface ChessPuzzleCatalog {
  readonly revision: string;
  readonly puzzles: readonly ChessPuzzleRecord[];
}

interface ChessPuzzleSelectionBase {
  readonly puzzleSetRevision: string;
  readonly algorithmVersion: typeof CHESS_PUZZLE_SELECTION_VERSION;
  readonly difficulty: ChessPuzzleDifficulty;
  readonly theme: ChessPuzzleTheme;
}

export type ChessPuzzleSelection =
  | (ChessPuzzleSelectionBase & {
      readonly kind: "daily";
      readonly utcDate: string;
    })
  | (ChessPuzzleSelectionBase & {
      readonly kind: "practice";
      readonly seed: number;
    });

export interface ChessPuzzlePromotionChooser {
  readonly from: number;
  readonly to: number;
  readonly choices: readonly ChessPromotion[];
  readonly selected: ChessPromotion;
}

export interface ChessPuzzleLastMove {
  readonly move: ChessMove;
  readonly actor: "setup" | "player" | "opponent";
}

export interface ChessPuzzleState {
  readonly puzzleSetRevision: string;
  readonly selection: ChessPuzzleSelection;
  readonly puzzleId: string;
  readonly playerColor: ChessColor;
  readonly setupMove: ChessMove;
  readonly position: ChessPosition;
  readonly expectedSolutionPly: number;
  readonly totalPlayerMoves: number;
  readonly status: ChessPuzzleStatus;
  readonly orientation: ChessColor;
  readonly cursor: number;
  readonly selectedSource?: number;
  readonly legalTargets: readonly number[];
  readonly promotionChooser?: ChessPuzzlePromotionChooser;
  readonly lastMove: ChessPuzzleLastMove;
  readonly submittedMoves: readonly string[];
  readonly incorrectMoves: readonly string[];
  readonly mistakes: number;
  readonly hintLevel: 0 | 1 | 2 | 3;
  readonly issue?: ChessPuzzleIssueCode;
}

export type ChessPuzzleAction =
  | { readonly type: "move-cursor"; readonly direction: ChessPuzzleDirection }
  | { readonly type: "set-cursor"; readonly square: number }
  | { readonly type: "activate" }
  | { readonly type: "clear-selection" }
  | { readonly type: "choose-promotion"; readonly promotion: ChessPromotion }
  | { readonly type: "confirm-promotion" }
  | { readonly type: "apply-opponent-reply" }
  | { readonly type: "hint" }
  | { readonly type: "flip-board" };

const DIFFICULTIES: readonly ChessPuzzleDifficulty[] = Object.freeze(["easy", "medium", "hard"]);
const THEMES: readonly ChessPuzzleTheme[] = Object.freeze([
  "any",
  "fork",
  "pin",
  "skewer",
  "discoveredAttack",
  "deflection",
  "sacrifice",
  "promotion",
  "mate",
  "advancedPawn",
]);
const PROMOTIONS: readonly ChessPromotion[] = Object.freeze(["queen", "rook", "bishop", "knight"]);

function assertSquare(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 64)
    throw new RangeError(`${label} must be a square from 0 through 63`);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function validateChessPuzzleUtcDate(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) throw new TypeError("UTC puzzle date must use YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1970 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (days[month - 1] ?? 0)
  )
    throw new TypeError("UTC puzzle date is invalid");
}

function validateSelection(selection: ChessPuzzleSelection, revision: string): void {
  if (selection.puzzleSetRevision !== revision)
    throw new RangeError(
      `Puzzle selection revision ${selection.puzzleSetRevision} does not match ${revision}`,
    );
  if (selection.algorithmVersion !== CHESS_PUZZLE_SELECTION_VERSION)
    throw new RangeError(
      `Unsupported Chess puzzle selection version ${selection.algorithmVersion}`,
    );
  if (!DIFFICULTIES.includes(selection.difficulty))
    throw new TypeError("Chess puzzle difficulty is invalid");
  if (!THEMES.includes(selection.theme)) throw new TypeError("Chess puzzle theme is invalid");
  if (selection.kind === "daily") validateChessPuzzleUtcDate(selection.utcDate);
  else if (!Number.isSafeInteger(selection.seed))
    throw new TypeError("Practice seed must be a safe integer");
}

function freezeSelection(selection: ChessPuzzleSelection): ChessPuzzleSelection {
  return Object.freeze({ ...selection });
}

export function createDailyChessPuzzleSelection(
  puzzleSetRevision: string,
  utcDate: string,
  difficulty: ChessPuzzleDifficulty,
  theme: ChessPuzzleTheme = "any",
): ChessPuzzleSelection {
  const selection: ChessPuzzleSelection = {
    kind: "daily",
    puzzleSetRevision,
    algorithmVersion: CHESS_PUZZLE_SELECTION_VERSION,
    utcDate,
    difficulty,
    theme,
  };
  validateSelection(selection, puzzleSetRevision);
  return freezeSelection(selection);
}

export function createPracticeChessPuzzleSelection(
  puzzleSetRevision: string,
  seed: number,
  difficulty: ChessPuzzleDifficulty,
  theme: ChessPuzzleTheme = "any",
): ChessPuzzleSelection {
  const selection: ChessPuzzleSelection = {
    kind: "practice",
    puzzleSetRevision,
    algorithmVersion: CHESS_PUZZLE_SELECTION_VERSION,
    seed,
    difficulty,
    theme,
  };
  validateSelection(selection, puzzleSetRevision);
  return freezeSelection(selection);
}

function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function selectionKey(selection: ChessPuzzleSelection): string {
  const identity = selection.kind === "daily" ? selection.utcDate : String(selection.seed);
  return [
    selection.kind,
    selection.algorithmVersion,
    selection.puzzleSetRevision,
    identity,
    selection.difficulty,
    selection.theme,
  ].join(":");
}

export function selectChessPuzzle(
  catalog: ChessPuzzleCatalog,
  selection: ChessPuzzleSelection,
): ChessPuzzleRecord {
  validateSelection(selection, catalog.revision);
  const candidates = catalog.puzzles.filter(
    (puzzle) =>
      puzzle.difficulty === selection.difficulty &&
      (selection.theme === "any" || puzzle.themes.includes(selection.theme)),
  );
  if (candidates.length === 0)
    throw new Error(`No Chess puzzles for ${selection.difficulty}/${selection.theme}`);
  return candidates[hash32(selectionKey(selection)) % candidates.length] as ChessPuzzleRecord;
}

export function chessPuzzleById(catalog: ChessPuzzleCatalog, puzzleId: string): ChessPuzzleRecord {
  const puzzle = catalog.puzzles.find(({ id }) => id === puzzleId);
  if (puzzle === undefined) throw new Error(`Unknown Chess puzzle ${puzzleId}`);
  return puzzle;
}

function colorOf(piece: ChessPosition["board"][number]): ChessColor | undefined {
  if (piece === null) return undefined;
  return piece === piece.toUpperCase() ? "white" : "black";
}

function freezeMove(move: ChessMove): ChessMove {
  return Object.freeze({
    from: move.from,
    to: move.to,
    ...(move.promotion === undefined ? {} : { promotion: move.promotion }),
  });
}

function freezeLastMove(lastMove: ChessPuzzleLastMove): ChessPuzzleLastMove {
  return Object.freeze({ move: freezeMove(lastMove.move), actor: lastMove.actor });
}

function freezeChooser(chooser: ChessPuzzlePromotionChooser): ChessPuzzlePromotionChooser {
  return Object.freeze({
    from: chooser.from,
    to: chooser.to,
    choices: Object.freeze([...chooser.choices]),
    selected: chooser.selected,
  });
}

function freezeState(state: ChessPuzzleState): ChessPuzzleState {
  const { selectedSource, promotionChooser, issue, ...rest } = state;
  return Object.freeze({
    ...rest,
    selection: freezeSelection(state.selection),
    setupMove: freezeMove(state.setupMove),
    legalTargets: Object.freeze([...state.legalTargets]),
    lastMove: freezeLastMove(state.lastMove),
    submittedMoves: Object.freeze([...state.submittedMoves]),
    incorrectMoves: Object.freeze([...state.incorrectMoves]),
    ...(selectedSource === undefined ? {} : { selectedSource }),
    ...(promotionChooser === undefined
      ? {}
      : { promotionChooser: freezeChooser(promotionChooser) }),
    ...(issue === undefined ? {} : { issue }),
  });
}

function clearTransient(
  state: ChessPuzzleState,
): Omit<ChessPuzzleState, "selectedSource" | "promotionChooser" | "issue"> {
  const {
    selectedSource: _selectedSource,
    promotionChooser: _promotionChooser,
    issue: _issue,
    ...rest
  } = state;
  return rest;
}

function clearIssue(state: ChessPuzzleState): Omit<ChessPuzzleState, "issue"> {
  const { issue: _issue, ...rest } = state;
  return rest;
}

function withIssue(state: ChessPuzzleState, issue: ChessPuzzleIssueCode): ChessPuzzleState {
  return freezeState({ ...state, issue });
}

function legalFrom(position: ChessPosition, source: number): readonly ChessMove[] {
  return Object.freeze(legalChessMoves(position).filter(({ from }) => from === source));
}

function targets(moves: readonly ChessMove[]): readonly number[] {
  return Object.freeze([...new Set(moves.map(({ to }) => to))].sort((left, right) => left - right));
}

function initialCursor(position: ChessPosition, expected: ChessMove): number {
  return colorOf(position.board[expected.from] ?? null) === position.sideToMove ? expected.from : 0;
}

export function createChessPuzzle(
  catalog: ChessPuzzleCatalog,
  selection: ChessPuzzleSelection,
): ChessPuzzleState {
  const puzzle = selectChessPuzzle(catalog, selection);
  const source = parseChessFen(puzzle.sourceFen);
  const setupMove = parseUciMove(puzzle.setupMove);
  const playable = applyChessMove(source, setupMove);
  if (chessFen(playable) !== puzzle.playableFen)
    throw new Error(`Chess puzzle ${puzzle.id} setup does not match playable FEN`);
  if (puzzle.solutionMoves.length === 0 || puzzle.solutionMoves.length % 2 === 0)
    throw new Error(`Chess puzzle ${puzzle.id} must end on a player move`);
  const first = parseUciMove(puzzle.solutionMoves[0] as string);
  return freezeState({
    puzzleSetRevision: catalog.revision,
    selection,
    puzzleId: puzzle.id,
    playerColor: playable.sideToMove,
    setupMove,
    position: playable,
    expectedSolutionPly: 0,
    totalPlayerMoves: (puzzle.solutionMoves.length + 1) / 2,
    status: "active",
    orientation: playable.sideToMove,
    cursor: initialCursor(playable, first),
    legalTargets: [],
    lastMove: Object.freeze({ move: setupMove, actor: "setup" }),
    submittedMoves: [],
    incorrectMoves: [],
    mistakes: 0,
    hintLevel: 0,
  });
}

export function chessPuzzleExpectedMove(
  catalog: ChessPuzzleCatalog,
  state: ChessPuzzleState,
): ChessMove {
  const puzzle = chessPuzzleById(catalog, state.puzzleId);
  const uci = puzzle.solutionMoves[state.expectedSolutionPly];
  if (uci === undefined)
    throw new Error(`Chess puzzle ${puzzle.id} has no expected ply ${state.expectedSolutionPly}`);
  return parseUciMove(uci);
}

export function chessPuzzleHintText(
  catalog: ChessPuzzleCatalog,
  state: ChessPuzzleState,
): string | undefined {
  if (state.hintLevel < 3 || state.status !== "active") return undefined;
  const move = chessPuzzleExpectedMove(catalog, state);
  const piece = state.position.board[move.from];
  if (piece === null || piece === undefined)
    throw new Error("Expected Chess puzzle move has no source piece");
  const names: Readonly<Record<string, string>> = Object.freeze({
    p: "Pawn",
    n: "Knight",
    b: "Bishop",
    r: "Rook",
    q: "Queen",
    k: "King",
  });
  return `${names[piece.toLowerCase()] as string} ${chessSquareName(move.from)} → ${chessSquareName(move.to)}`;
}

function moveCursor(state: ChessPuzzleState, direction: ChessPuzzleDirection): ChessPuzzleState {
  const file = state.cursor % 8;
  const rank = Math.floor(state.cursor / 8);
  const whiteUp = state.orientation === "white";
  const rankDelta =
    direction === "up" ? (whiteUp ? 1 : -1) : direction === "down" ? (whiteUp ? -1 : 1) : 0;
  const fileDelta =
    direction === "left" ? (whiteUp ? -1 : 1) : direction === "right" ? (whiteUp ? 1 : -1) : 0;
  const nextFile = Math.max(0, Math.min(7, file + fileDelta));
  const nextRank = Math.max(0, Math.min(7, rank + rankDelta));
  const cursor = nextRank * 8 + nextFile;
  return cursor === state.cursor ? state : freezeState({ ...clearIssue(state), cursor });
}

function submitMove(
  catalog: ChessPuzzleCatalog,
  state: ChessPuzzleState,
  move: ChessMove,
): ChessPuzzleState {
  const uci = chessMoveToUci(move);
  const submittedMoves = [...state.submittedMoves, uci];
  const expected = chessMoveToUci(chessPuzzleExpectedMove(catalog, state));
  if (uci !== expected) {
    const { promotionChooser: _promotionChooser, issue: _issue, ...rest } = state;
    return freezeState({
      ...rest,
      submittedMoves,
      incorrectMoves: [...state.incorrectMoves, uci],
      mistakes: state.mistakes + 1,
      issue: "incorrect-move",
    });
  }
  const puzzle = chessPuzzleById(catalog, state.puzzleId);
  const position = applyChessMove(state.position, move);
  const expectedSolutionPly = state.expectedSolutionPly + 1;
  const solved = expectedSolutionPly === puzzle.solutionMoves.length;
  return freezeState({
    ...clearTransient(state),
    position,
    expectedSolutionPly,
    status: solved ? "solved" : "reply-pending",
    cursor: move.to,
    lastMove: { move, actor: "player" },
    submittedMoves,
    legalTargets: [],
  });
}

function activate(catalog: ChessPuzzleCatalog, state: ChessPuzzleState): ChessPuzzleState {
  if (state.status === "reply-pending") return withIssue(state, "reply-pending");
  if (state.status === "solved") return withIssue(state, "puzzle-solved");
  if (state.promotionChooser !== undefined)
    return submitMove(catalog, state, {
      from: state.promotionChooser.from,
      to: state.promotionChooser.to,
      promotion: state.promotionChooser.selected,
    });
  const pieceColor = colorOf(state.position.board[state.cursor] ?? null);
  if (state.selectedSource === undefined) {
    if (pieceColor !== state.playerColor) return withIssue(state, "not-your-piece");
    const moves = legalFrom(state.position, state.cursor);
    return freezeState({
      ...clearTransient(state),
      cursor: state.cursor,
      selectedSource: state.cursor,
      legalTargets: targets(moves),
    });
  }
  if (state.cursor === state.selectedSource)
    return freezeState({ ...clearTransient(state), cursor: state.cursor, legalTargets: [] });
  if (pieceColor === state.playerColor) {
    const moves = legalFrom(state.position, state.cursor);
    return freezeState({
      ...clearTransient(state),
      cursor: state.cursor,
      selectedSource: state.cursor,
      legalTargets: targets(moves),
    });
  }
  const matches = legalFrom(state.position, state.selectedSource).filter(
    ({ to }) => to === state.cursor,
  );
  if (matches.length === 0) return withIssue(state, "invalid-destination");
  if (matches.length > 1) {
    const choices = PROMOTIONS.filter((promotion) =>
      matches.some((move) => move.promotion === promotion),
    );
    return freezeState({
      ...clearIssue(state),
      promotionChooser: {
        from: state.selectedSource,
        to: state.cursor,
        choices,
        selected: choices[0] as ChessPromotion,
      },
    });
  }
  return submitMove(catalog, state, matches[0] as ChessMove);
}

export function reduceChessPuzzle(
  catalog: ChessPuzzleCatalog,
  state: ChessPuzzleState,
  action: ChessPuzzleAction,
): ChessPuzzleState {
  if (state.puzzleSetRevision !== catalog.revision)
    throw new Error("Chess puzzle state revision does not match catalog");
  if (action.type === "move-cursor") {
    if (state.status !== "active" || state.promotionChooser !== undefined) return state;
    return moveCursor(state, action.direction);
  }
  if (action.type === "set-cursor") {
    assertSquare(action.square, "Chess puzzle cursor");
    if (
      state.status !== "active" ||
      state.promotionChooser !== undefined ||
      action.square === state.cursor
    )
      return state;
    return freezeState({ ...clearIssue(state), cursor: action.square });
  }
  if (action.type === "activate") return activate(catalog, state);
  if (action.type === "clear-selection") {
    if (state.promotionChooser !== undefined) {
      const { promotionChooser: _promotionChooser, issue: _issue, ...rest } = state;
      return freezeState(rest);
    }
    if (state.selectedSource === undefined) return state;
    return freezeState({ ...clearTransient(state), cursor: state.cursor, legalTargets: [] });
  }
  if (action.type === "choose-promotion") {
    const chooser = state.promotionChooser;
    if (chooser === undefined || !chooser.choices.includes(action.promotion)) return state;
    return freezeState({
      ...clearIssue(state),
      promotionChooser: { ...chooser, selected: action.promotion },
    });
  }
  if (action.type === "confirm-promotion") {
    const chooser = state.promotionChooser;
    return chooser === undefined
      ? state
      : submitMove(catalog, state, {
          from: chooser.from,
          to: chooser.to,
          promotion: chooser.selected,
        });
  }
  if (action.type === "apply-opponent-reply") {
    if (state.status !== "reply-pending") return state;
    const move = chessPuzzleExpectedMove(catalog, state);
    const puzzle = chessPuzzleById(catalog, state.puzzleId);
    if (state.expectedSolutionPly + 1 >= puzzle.solutionMoves.length)
      throw new Error("Chess puzzle pending reply has no following player move");
    return freezeState({
      ...clearTransient(state),
      position: applyChessMove(state.position, move),
      expectedSolutionPly: state.expectedSolutionPly + 1,
      status: "active",
      cursor: parseUciMove(puzzle.solutionMoves[state.expectedSolutionPly + 1] as string).from,
      legalTargets: [],
      lastMove: { move, actor: "opponent" },
    });
  }
  if (action.type === "hint") {
    if (state.status !== "active" || state.hintLevel === 3) return state;
    return freezeState({ ...clearIssue(state), hintLevel: (state.hintLevel + 1) as 1 | 2 | 3 });
  }
  return freezeState({
    ...clearIssue(state),
    orientation: state.orientation === "white" ? "black" : "white",
  });
}

export function submitChessPuzzleMove(
  catalog: ChessPuzzleCatalog,
  state: ChessPuzzleState,
  move: ChessMove | string,
): ChessPuzzleState {
  if (state.status !== "active")
    return withIssue(state, state.status === "solved" ? "puzzle-solved" : "reply-pending");
  const candidate = typeof move === "string" ? parseUciMove(move) : move;
  const legal = legalChessMoves(state.position).find(
    (entry) => chessMoveToUci(entry) === chessMoveToUci(candidate),
  );
  if (legal === undefined)
    throw new Error(`Illegal Chess puzzle move ${chessMoveToUci(candidate)}`);
  return submitMove(catalog, state, legal);
}
