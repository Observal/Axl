// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { ActivityStorageError, type ActivityStorage, type JsonValue } from "@axl/extension-api";

import {
  CHESS_PUZZLE_SELECTION_VERSION,
  type ChessPuzzleCatalog,
  type ChessPuzzleDifficulty,
  type ChessPuzzleMode,
  type ChessPuzzleSelection,
  type ChessPuzzleState,
  type ChessPuzzleTheme,
  chessPuzzleById,
  createChessPuzzle,
  reduceChessPuzzle,
  selectChessPuzzle,
  submitChessPuzzleMove,
  validateChessPuzzleUtcDate,
} from "./chess-puzzle.ts";
import { chessMoveToUci } from "./chess.ts";

export const CHESS_PUZZLE_STORAGE_SCHEMA_VERSION = 1;
export const CHESS_PUZZLE_MAX_COMPLETIONS = 2_048;

export interface ChessPuzzlePreferences {
  readonly mode: ChessPuzzleMode;
  readonly difficulty: ChessPuzzleDifficulty;
  readonly theme: ChessPuzzleTheme;
  readonly orientation: "white" | "black";
}

interface SavedPromotionChooser {
  readonly from: number;
  readonly to: number;
  readonly selected: "queen" | "rook" | "bishop" | "knight";
}

interface SavedLastMove {
  readonly uci: string;
  readonly actor: "setup" | "player" | "opponent";
}

interface SavedChessPuzzleGame {
  readonly puzzleSetRevision: string;
  readonly selection: ChessPuzzleSelection;
  readonly puzzleId: string;
  readonly playerColor: "white" | "black";
  readonly setupMove: string;
  readonly expectedSolutionPly: number;
  readonly status: "active" | "reply-pending" | "solved";
  readonly orientation: "white" | "black";
  readonly cursor: number;
  readonly selectedSource?: number;
  readonly promotionChooser?: SavedPromotionChooser;
  readonly lastMove: SavedLastMove;
  readonly submittedMoves: readonly string[];
  readonly incorrectMoves: readonly string[];
  readonly hintLevel: 0 | 1 | 2 | 3;
  readonly completionRecorded: boolean;
}

export type ChessPuzzleCompletionRecord = readonly [
  key: string,
  playerMovesSubmitted: number,
  incorrectMoves: number,
  hintLevel: 0 | 1 | 2 | 3,
];

export interface ChessPuzzleSaveDocument {
  readonly version: 1;
  readonly preferences: ChessPuzzlePreferences;
  readonly game?: SavedChessPuzzleGame;
  readonly completions: readonly ChessPuzzleCompletionRecord[];
}

export interface ChessPuzzleStatistics {
  readonly puzzlesCompleted: number;
  readonly cleanSolves: number;
  readonly playerMovesSubmitted: number;
  readonly incorrectMoves: number;
  readonly hintsUsed: number;
  readonly byDifficulty: Readonly<Record<ChessPuzzleDifficulty, number>>;
  readonly byTheme: Readonly<Record<ChessPuzzleTheme, number>>;
  readonly currentDailyStreak: number;
  readonly maximumDailyStreak: number;
}

export type ChessPuzzleSaveErrorCode = "corrupt" | "future-version" | "revision-mismatch";

export class ChessPuzzleSaveError extends Error {
  readonly code: ChessPuzzleSaveErrorCode;

  constructor(code: ChessPuzzleSaveErrorCode, message: string) {
    super(message);
    this.name = "ChessPuzzleSaveError";
    this.code = code;
  }
}

export function createEmptyChessPuzzleSave(): ChessPuzzleSaveDocument {
  return Object.freeze({
    version: 1,
    preferences: Object.freeze({
      mode: "daily",
      difficulty: "easy",
      theme: "any",
      orientation: "white",
    }),
    completions: Object.freeze([]),
  });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ChessPuzzleSaveError("corrupt", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined)
    throw new ChessPuzzleSaveError("corrupt", `${label}.${unknown} is unknown`);
}

function integer(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
    throw new ChessPuzzleSaveError("corrupt", `${label} must be a bounded non-negative integer`);
  return value as number;
}

function difficulty(value: unknown, label: string): ChessPuzzleDifficulty {
  if (value !== "easy" && value !== "medium" && value !== "hard")
    throw new ChessPuzzleSaveError("corrupt", `${label} is invalid`);
  return value;
}

function theme(value: unknown, label: string): ChessPuzzleTheme {
  if (
    value !== "any" &&
    value !== "fork" &&
    value !== "pin" &&
    value !== "skewer" &&
    value !== "discoveredAttack" &&
    value !== "deflection" &&
    value !== "sacrifice" &&
    value !== "promotion" &&
    value !== "mate" &&
    value !== "advancedPawn"
  )
    throw new ChessPuzzleSaveError("corrupt", `${label} is invalid`);
  return value;
}

function orientation(value: unknown, label: string): "white" | "black" {
  if (value !== "white" && value !== "black")
    throw new ChessPuzzleSaveError("corrupt", `${label} is invalid`);
  return value;
}

function selection(
  value: unknown,
  catalog: ChessPuzzleCatalog,
  label: string,
): ChessPuzzleSelection {
  const input = object(value, label);
  if (input.kind === "daily") {
    exactKeys(
      input,
      ["kind", "puzzleSetRevision", "algorithmVersion", "utcDate", "difficulty", "theme"],
      label,
    );
    if (input.puzzleSetRevision !== catalog.revision)
      throw new ChessPuzzleSaveError(
        "revision-mismatch",
        `${label} puzzle set does not match this Axl version`,
      );
    if (
      input.algorithmVersion !== CHESS_PUZZLE_SELECTION_VERSION ||
      typeof input.utcDate !== "string"
    )
      throw new ChessPuzzleSaveError("corrupt", `${label} is invalid`);
    try {
      validateChessPuzzleUtcDate(input.utcDate);
    } catch {
      throw new ChessPuzzleSaveError("corrupt", `${label}.utcDate is invalid`);
    }
    return Object.freeze({
      kind: "daily",
      puzzleSetRevision: catalog.revision,
      algorithmVersion: 1,
      utcDate: input.utcDate,
      difficulty: difficulty(input.difficulty, `${label}.difficulty`),
      theme: theme(input.theme, `${label}.theme`),
    });
  }
  if (input.kind === "practice") {
    exactKeys(
      input,
      ["kind", "puzzleSetRevision", "algorithmVersion", "seed", "difficulty", "theme"],
      label,
    );
    if (input.puzzleSetRevision !== catalog.revision)
      throw new ChessPuzzleSaveError(
        "revision-mismatch",
        `${label} puzzle set does not match this Axl version`,
      );
    if (
      input.algorithmVersion !== CHESS_PUZZLE_SELECTION_VERSION ||
      !Number.isSafeInteger(input.seed)
    )
      throw new ChessPuzzleSaveError("corrupt", `${label} is invalid`);
    return Object.freeze({
      kind: "practice",
      puzzleSetRevision: catalog.revision,
      algorithmVersion: 1,
      seed: input.seed as number,
      difficulty: difficulty(input.difficulty, `${label}.difficulty`),
      theme: theme(input.theme, `${label}.theme`),
    });
  }
  throw new ChessPuzzleSaveError("corrupt", `${label}.kind is invalid`);
}

function strings(value: unknown, label: string, maximum = 16_384): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((entry) => typeof entry !== "string")
  )
    throw new ChessPuzzleSaveError("corrupt", `${label} must be a bounded string array`);
  return Object.freeze([...value] as string[]);
}

function savedLastMove(value: unknown, label: string): SavedLastMove {
  const input = object(value, label);
  exactKeys(input, ["uci", "actor"], label);
  if (
    typeof input.uci !== "string" ||
    (input.actor !== "setup" && input.actor !== "player" && input.actor !== "opponent")
  )
    throw new ChessPuzzleSaveError("corrupt", `${label} is invalid`);
  return Object.freeze({ uci: input.uci, actor: input.actor });
}

function savedPromotion(value: unknown, label: string): SavedPromotionChooser {
  const input = object(value, label);
  exactKeys(input, ["from", "to", "selected"], label);
  if (
    input.selected !== "queen" &&
    input.selected !== "rook" &&
    input.selected !== "bishop" &&
    input.selected !== "knight"
  )
    throw new ChessPuzzleSaveError("corrupt", `${label}.selected is invalid`);
  return Object.freeze({
    from: integer(input.from, `${label}.from`, 63),
    to: integer(input.to, `${label}.to`, 63),
    selected: input.selected,
  });
}

function restoreGame(
  value: unknown,
  catalog: ChessPuzzleCatalog,
): { readonly state: ChessPuzzleState; readonly recorded: boolean } {
  const game = object(value, "game");
  exactKeys(
    game,
    [
      "puzzleSetRevision",
      "selection",
      "puzzleId",
      "playerColor",
      "setupMove",
      "expectedSolutionPly",
      "status",
      "orientation",
      "cursor",
      "selectedSource",
      "promotionChooser",
      "lastMove",
      "submittedMoves",
      "incorrectMoves",
      "hintLevel",
      "completionRecorded",
    ],
    "game",
  );
  if (game.puzzleSetRevision !== catalog.revision)
    throw new ChessPuzzleSaveError(
      "revision-mismatch",
      "Saved Chess puzzle set does not match this Axl version",
    );
  const parsedSelection = selection(game.selection, catalog, "game.selection");
  if (
    typeof game.puzzleId !== "string" ||
    selectChessPuzzle(catalog, parsedSelection).id !== game.puzzleId
  )
    throw new ChessPuzzleSaveError("corrupt", "game puzzle does not match its selection");
  if (game.playerColor !== "white" && game.playerColor !== "black")
    throw new ChessPuzzleSaveError("corrupt", "game.playerColor is invalid");
  if (typeof game.setupMove !== "string" || typeof game.completionRecorded !== "boolean")
    throw new ChessPuzzleSaveError("corrupt", "game setup or completion marker is invalid");
  if (game.status !== "active" && game.status !== "reply-pending" && game.status !== "solved")
    throw new ChessPuzzleSaveError("corrupt", "game.status is invalid");
  const expectedSolutionPly = integer(game.expectedSolutionPly, "game.expectedSolutionPly", 512);
  const submittedMoves = strings(game.submittedMoves, "game.submittedMoves");
  const incorrectMoves = strings(game.incorrectMoves, "game.incorrectMoves");
  const hintLevel = integer(game.hintLevel, "game.hintLevel", 3) as 0 | 1 | 2 | 3;
  const selectedSource =
    game.selectedSource === undefined
      ? undefined
      : integer(game.selectedSource, "game.selectedSource", 63);
  const promotion =
    game.promotionChooser === undefined
      ? undefined
      : savedPromotion(game.promotionChooser, "game.promotionChooser");
  const lastMove = savedLastMove(game.lastMove, "game.lastMove");

  try {
    let state = createChessPuzzle(catalog, parsedSelection);
    while (state.hintLevel < hintLevel) state = reduceChessPuzzle(catalog, state, { type: "hint" });
    for (const submitted of submittedMoves) {
      if (state.status === "reply-pending")
        state = reduceChessPuzzle(catalog, state, { type: "apply-opponent-reply" });
      state = submitChessPuzzleMove(catalog, state, submitted);
    }
    if (state.status === "reply-pending" && game.status === "active")
      state = reduceChessPuzzle(catalog, state, { type: "apply-opponent-reply" });
    if (
      state.expectedSolutionPly !== expectedSolutionPly ||
      state.status !== game.status ||
      state.playerColor !== game.playerColor ||
      chessMoveToUci(state.setupMove) !== game.setupMove ||
      state.submittedMoves.length !== submittedMoves.length ||
      state.submittedMoves.some((move, index) => move !== submittedMoves[index]) ||
      state.incorrectMoves.length !== incorrectMoves.length ||
      state.incorrectMoves.some((move, index) => move !== incorrectMoves[index])
    )
      throw new Error("game progression does not match the canonical solution line");
    if (state.orientation !== orientation(game.orientation, "game.orientation"))
      state = reduceChessPuzzle(catalog, state, { type: "flip-board" });
    if (state.hintLevel !== hintLevel) throw new Error("game hint state is impossible");
    if (state.status === "active" && selectedSource !== undefined) {
      state = reduceChessPuzzle(catalog, state, { type: "set-cursor", square: selectedSource });
      state = reduceChessPuzzle(catalog, state, { type: "activate" });
      if (state.selectedSource !== selectedSource)
        throw new Error("game selected source is invalid");
      if (promotion !== undefined) {
        if (promotion.from !== selectedSource) throw new Error("game promotion source is invalid");
        state = reduceChessPuzzle(catalog, state, { type: "set-cursor", square: promotion.to });
        state = reduceChessPuzzle(catalog, state, { type: "activate" });
        state = reduceChessPuzzle(catalog, state, {
          type: "choose-promotion",
          promotion: promotion.selected,
        });
        if (state.promotionChooser === undefined)
          throw new Error("game promotion chooser is invalid");
      }
    } else if (selectedSource !== undefined || promotion !== undefined)
      throw new Error("game selection requires an active puzzle");
    const cursor = integer(game.cursor, "game.cursor", 63);
    if (state.promotionChooser === undefined)
      state = reduceChessPuzzle(catalog, state, { type: "set-cursor", square: cursor });
    else if (state.cursor !== cursor) throw new Error("game promotion cursor is invalid");
    if (state.cursor !== cursor) throw new Error("game cursor is invalid");
    if (
      chessMoveToUci(state.lastMove.move) !== lastMove.uci ||
      state.lastMove.actor !== lastMove.actor
    )
      throw new Error("game last move is forged");
    return { state, recorded: game.completionRecorded };
  } catch (error) {
    if (error instanceof ChessPuzzleSaveError) throw error;
    throw new ChessPuzzleSaveError(
      "corrupt",
      error instanceof Error ? error.message : "Chess puzzle game is invalid",
    );
  }
}

export function chessPuzzleCompletionKey(
  state: Pick<ChessPuzzleState, "selection" | "puzzleId">,
): string {
  const selection = state.selection;
  const identity = selection.kind === "daily" ? selection.utcDate : String(selection.seed);
  return [
    selection.kind,
    selection.puzzleSetRevision,
    selection.algorithmVersion,
    identity,
    selection.difficulty,
    selection.theme,
    state.puzzleId,
  ].join(":");
}

interface CompletionIdentity {
  readonly selection: ChessPuzzleSelection;
  readonly puzzleId: string;
}

function completionIdentity(
  key: string,
  catalogRevision?: string,
  label = "completion",
): CompletionIdentity {
  const parts = key.split(":");
  if (parts.length !== 7) throw new ChessPuzzleSaveError("corrupt", `${label}.key is invalid`);
  const [kind, puzzleSetRevision, version, identity, difficultyValue, themeValue, puzzleId] = parts;
  if (puzzleSetRevision !== catalogRevision && catalogRevision !== undefined)
    throw new ChessPuzzleSaveError(
      "revision-mismatch",
      `${label} puzzle set does not match this Axl version`,
    );
  if (puzzleSetRevision === undefined || version !== String(CHESS_PUZZLE_SELECTION_VERSION))
    throw new ChessPuzzleSaveError("corrupt", `${label}.key is invalid`);
  const parsedDifficulty = difficulty(difficultyValue, `${label}.difficulty`);
  const parsedTheme = theme(themeValue, `${label}.theme`);
  if (typeof puzzleId !== "string" || puzzleId.length === 0)
    throw new ChessPuzzleSaveError("corrupt", `${label}.puzzleId is invalid`);
  let parsedSelection: ChessPuzzleSelection;
  if (kind === "daily" && identity !== undefined) {
    try {
      validateChessPuzzleUtcDate(identity);
    } catch {
      throw new ChessPuzzleSaveError("corrupt", `${label}.dailyDate is invalid`);
    }
    parsedSelection = Object.freeze({
      kind: "daily",
      puzzleSetRevision,
      algorithmVersion: 1,
      utcDate: identity,
      difficulty: parsedDifficulty,
      theme: parsedTheme,
    });
  } else if (kind === "practice" && identity !== undefined) {
    const seed = Number(identity);
    if (!Number.isSafeInteger(seed) || String(seed) !== identity)
      throw new ChessPuzzleSaveError("corrupt", `${label}.seed is invalid`);
    parsedSelection = Object.freeze({
      kind: "practice",
      puzzleSetRevision,
      algorithmVersion: 1,
      seed,
      difficulty: parsedDifficulty,
      theme: parsedTheme,
    });
  } else throw new ChessPuzzleSaveError("corrupt", `${label}.key is invalid`);
  return Object.freeze({ selection: parsedSelection, puzzleId });
}

function completion(
  value: unknown,
  index: number,
  catalog: ChessPuzzleCatalog,
): ChessPuzzleCompletionRecord {
  const label = `completions[${index}]`;
  if (!Array.isArray(value) || value.length !== 4 || typeof value[0] !== "string")
    throw new ChessPuzzleSaveError("corrupt", `${label} must be a compact completion tuple`);
  const key = value[0];
  if (key.length > 512) throw new ChessPuzzleSaveError("corrupt", `${label}.key is too long`);
  const identity = completionIdentity(key, catalog.revision, label);
  const selected = selectChessPuzzle(catalog, identity.selection);
  if (selected.id !== identity.puzzleId)
    throw new ChessPuzzleSaveError("corrupt", `${label} puzzle is forged`);
  const incorrectMoves = integer(value[2], `${label}.incorrectMoves`, 1_000_000);
  const playerMovesSubmitted = integer(value[1], `${label}.playerMovesSubmitted`, 1_000_000);
  if (playerMovesSubmitted !== (selected.solutionMoves.length + 1) / 2 + incorrectMoves)
    throw new ChessPuzzleSaveError("corrupt", `${label} move counts are forged`);
  const hintLevel = integer(value[3], `${label}.hintLevel`, 3) as 0 | 1 | 2 | 3;
  return Object.freeze([key, playerMovesSubmitted, incorrectMoves, hintLevel] as const);
}

function gameRecord(state: ChessPuzzleState, completionRecorded: boolean): SavedChessPuzzleGame {
  return Object.freeze({
    puzzleSetRevision: state.puzzleSetRevision,
    selection: state.selection,
    puzzleId: state.puzzleId,
    playerColor: state.playerColor,
    setupMove: chessMoveToUci(state.setupMove),
    expectedSolutionPly: state.expectedSolutionPly,
    status: state.status,
    orientation: state.orientation,
    cursor: state.cursor,
    ...(state.selectedSource === undefined ? {} : { selectedSource: state.selectedSource }),
    ...(state.promotionChooser === undefined
      ? {}
      : {
          promotionChooser: Object.freeze({
            from: state.promotionChooser.from,
            to: state.promotionChooser.to,
            selected: state.promotionChooser.selected,
          }),
        }),
    lastMove: Object.freeze({
      uci: chessMoveToUci(state.lastMove.move),
      actor: state.lastMove.actor,
    }),
    submittedMoves: Object.freeze([...state.submittedMoves]),
    incorrectMoves: Object.freeze([...state.incorrectMoves]),
    hintLevel: state.hintLevel,
    completionRecorded,
  });
}

export function parseChessPuzzleSave(
  value: JsonValue,
  catalog: ChessPuzzleCatalog,
): {
  readonly document: ChessPuzzleSaveDocument;
  readonly state?: ChessPuzzleState;
  readonly completionRecorded: boolean;
} {
  const input = object(value, "Chess puzzle save");
  if (typeof input.version === "number" && input.version > CHESS_PUZZLE_STORAGE_SCHEMA_VERSION)
    throw new ChessPuzzleSaveError(
      "future-version",
      `Unsupported Chess puzzle save version ${input.version}`,
    );
  if (input.version !== CHESS_PUZZLE_STORAGE_SCHEMA_VERSION)
    throw new ChessPuzzleSaveError("corrupt", "Chess puzzle save version is invalid");
  exactKeys(input, ["version", "preferences", "game", "completions"], "Chess puzzle save");
  const preferences = object(input.preferences, "preferences");
  exactKeys(preferences, ["mode", "difficulty", "theme", "orientation"], "preferences");
  if (preferences.mode !== "daily" && preferences.mode !== "practice")
    throw new ChessPuzzleSaveError("corrupt", "preferences.mode is invalid");
  const parsedPreferences = Object.freeze({
    mode: preferences.mode,
    difficulty: difficulty(preferences.difficulty, "preferences.difficulty"),
    theme: theme(preferences.theme, "preferences.theme"),
    orientation: orientation(preferences.orientation, "preferences.orientation"),
  });
  if (!Array.isArray(input.completions) || input.completions.length > CHESS_PUZZLE_MAX_COMPLETIONS)
    throw new ChessPuzzleSaveError("corrupt", "Chess puzzle completion history is invalid");
  const completions = input.completions.map((record, index) => completion(record, index, catalog));
  if (new Set(completions.map(([key]) => key)).size !== completions.length)
    throw new ChessPuzzleSaveError("corrupt", "Chess puzzle completion keys must be unique");
  const restored = input.game === undefined ? undefined : restoreGame(input.game, catalog);
  if (restored !== undefined) {
    const recorded = completions.some(([key]) => key === chessPuzzleCompletionKey(restored.state));
    if (restored.recorded !== (restored.state.status === "solved" && recorded))
      throw new ChessPuzzleSaveError(
        "corrupt",
        "game completion marker does not match completion history",
      );
  }
  const document = Object.freeze({
    version: 1 as const,
    preferences: parsedPreferences,
    ...(restored === undefined ? {} : { game: gameRecord(restored.state, restored.recorded) }),
    completions: Object.freeze(completions),
  });
  return {
    document,
    ...(restored === undefined ? {} : { state: restored.state }),
    completionRecorded: restored?.recorded ?? false,
  };
}

function completionRecord(state: ChessPuzzleState): ChessPuzzleCompletionRecord {
  if (state.status !== "solved")
    throw new Error("Only solved Chess puzzles have completion records");
  return Object.freeze([
    chessPuzzleCompletionKey(state),
    state.submittedMoves.length,
    state.incorrectMoves.length,
    state.hintLevel,
  ] as const);
}

export function updateChessPuzzleSave(
  document: ChessPuzzleSaveDocument,
  state: ChessPuzzleState,
  preferences: ChessPuzzlePreferences,
): { readonly document: ChessPuzzleSaveDocument; readonly completionAdded: boolean } {
  const key = chessPuzzleCompletionKey(state);
  const alreadyRecorded = document.completions.some((record) => record[0] === key);
  const completionAdded = state.status === "solved" && !alreadyRecorded;
  const completions = completionAdded
    ? [...document.completions, completionRecord(state)].slice(-CHESS_PUZZLE_MAX_COMPLETIONS)
    : document.completions;
  return Object.freeze({
    document: Object.freeze({
      version: 1,
      preferences: Object.freeze({ ...preferences }),
      game: gameRecord(state, state.status === "solved" && (alreadyRecorded || completionAdded)),
      completions: Object.freeze(completions),
    }),
    completionAdded,
  });
}

export function mergeChessPuzzleCompletions(
  latest: ChessPuzzleSaveDocument,
  proposed: ChessPuzzleSaveDocument,
): ChessPuzzleSaveDocument {
  const byKey = new Map(latest.completions.map((record) => [record[0], record]));
  for (const record of proposed.completions)
    if (!byKey.has(record[0])) byKey.set(record[0], record);
  const completions = [...byKey.values()].slice(-CHESS_PUZZLE_MAX_COMPLETIONS);
  return Object.freeze({ ...latest, completions: Object.freeze(completions) });
}

function ordinal(date: string): number {
  validateChessPuzzleUtcDate(date);
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const adjustedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  return (
    era * 146097 +
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear
  );
}

export function chessPuzzleStatistics(document: ChessPuzzleSaveDocument): ChessPuzzleStatistics {
  const byDifficulty: Record<ChessPuzzleDifficulty, number> = { easy: 0, medium: 0, hard: 0 };
  const byTheme: Record<ChessPuzzleTheme, number> = {
    any: 0,
    fork: 0,
    pin: 0,
    skewer: 0,
    discoveredAttack: 0,
    deflection: 0,
    sacrifice: 0,
    promotion: 0,
    mate: 0,
    advancedPawn: 0,
  };
  let cleanSolves = 0;
  let playerMovesSubmitted = 0;
  let incorrectMoves = 0;
  let hintsUsed = 0;
  const dates = new Set<string>();
  for (const record of document.completions) {
    const identity = completionIdentity(record[0]);
    byDifficulty[identity.selection.difficulty] += 1;
    byTheme[identity.selection.theme] += 1;
    if (record[2] === 0) cleanSolves += 1;
    playerMovesSubmitted += record[1];
    incorrectMoves += record[2];
    if (record[3] > 0) hintsUsed += 1;
    if (identity.selection.kind === "daily") dates.add(identity.selection.utcDate);
  }
  let currentDailyStreak = 0;
  let maximumDailyStreak = 0;
  let previous: number | undefined;
  for (const date of [...dates].sort()) {
    const day = ordinal(date);
    currentDailyStreak =
      previous === undefined || day === previous + 1 ? currentDailyStreak + 1 : 1;
    maximumDailyStreak = Math.max(maximumDailyStreak, currentDailyStreak);
    previous = day;
  }
  return Object.freeze({
    puzzlesCompleted: document.completions.length,
    cleanSolves,
    playerMovesSubmitted,
    incorrectMoves,
    hintsUsed,
    byDifficulty: Object.freeze(byDifficulty),
    byTheme: Object.freeze(byTheme),
    currentDailyStreak,
    maximumDailyStreak,
  });
}

export function chessPuzzleSaveJson(document: ChessPuzzleSaveDocument): JsonValue {
  return JSON.parse(JSON.stringify(document)) as JsonValue;
}

interface PendingWrite {
  readonly document: ChessPuzzleSaveDocument;
  readonly containsCompletion: boolean;
}

export interface ChessPuzzleSaveWriter {
  enqueue(document: ChessPuzzleSaveDocument, completionAdded: boolean): void;
  flush(document?: ChessPuzzleSaveDocument, completionAdded?: boolean): Promise<void>;
  dispose(document?: ChessPuzzleSaveDocument, completionAdded?: boolean): Promise<void>;
}

export function createChessPuzzleSaveWriter(
  storage: ActivityStorage,
  catalog: ChessPuzzleCatalog,
  initialRevision: number | null,
): ChessPuzzleSaveWriter {
  let revision = initialRevision;
  let pending: PendingWrite | undefined;
  let inFlight: Promise<void> | undefined;
  let blocked = false;
  let disposed = false;
  let failure: unknown;
  let requiredCompletions: ChessPuzzleSaveDocument | undefined;

  const mergeRequiredCompletions = (
    document: ChessPuzzleSaveDocument,
    required: ChessPuzzleSaveDocument,
  ): ChessPuzzleSaveDocument => {
    const merged = mergeChessPuzzleCompletions(document, required);
    return Object.freeze({ ...document, completions: merged.completions });
  };

  const writeCompletionMerge = async (proposed: ChessPuzzleSaveDocument): Promise<void> => {
    for (;;) {
      const latest = await storage.read();
      if (latest !== undefined && latest.schemaVersion !== CHESS_PUZZLE_STORAGE_SCHEMA_VERSION)
        throw new ChessPuzzleSaveError(
          latest.schemaVersion > CHESS_PUZZLE_STORAGE_SCHEMA_VERSION ? "future-version" : "corrupt",
          `Unsupported Chess puzzle storage schema ${latest.schemaVersion}`,
        );
      const latestDocument =
        latest === undefined
          ? createEmptyChessPuzzleSave()
          : parseChessPuzzleSave(latest.value, catalog).document;
      const merged = mergeChessPuzzleCompletions(latestDocument, proposed);
      try {
        const stored = await storage.write(
          latest?.revision ?? null,
          CHESS_PUZZLE_STORAGE_SCHEMA_VERSION,
          chessPuzzleSaveJson(merged),
        );
        revision = stored.revision;
        return;
      } catch (error) {
        if (!(error instanceof ActivityStorageError) || error.code !== "conflict") throw error;
      }
    }
  };

  const drain = (): void => {
    if (inFlight !== undefined || pending === undefined || failure !== undefined) return;
    const next = pending;
    pending = undefined;
    inFlight = (async () => {
      if (blocked) {
        if (next.containsCompletion) await writeCompletionMerge(next.document);
        return;
      }
      try {
        const stored = await storage.write(
          revision,
          CHESS_PUZZLE_STORAGE_SCHEMA_VERSION,
          chessPuzzleSaveJson(next.document),
        );
        revision = stored.revision;
      } catch (error) {
        if (error instanceof ActivityStorageError && error.code === "conflict") {
          blocked = true;
          if (next.containsCompletion) await writeCompletionMerge(next.document);
          return;
        }
        throw error;
      }
    })()
      .catch((error: unknown) => {
        failure = error;
        pending = undefined;
      })
      .finally(() => {
        inFlight = undefined;
        drain();
      });
  };

  const enqueue = (document: ChessPuzzleSaveDocument, completionAdded: boolean): void => {
    if (disposed) throw new Error("Chess puzzle save writer is disposed");
    if (failure !== undefined) throw failure;
    if (completionAdded)
      requiredCompletions =
        requiredCompletions === undefined
          ? document
          : mergeRequiredCompletions(document, requiredCompletions);
    const retained =
      requiredCompletions === undefined
        ? document
        : mergeRequiredCompletions(document, requiredCompletions);
    pending = Object.freeze({
      document: retained,
      containsCompletion: requiredCompletions !== undefined,
    });
    drain();
  };

  const flush = async (
    document?: ChessPuzzleSaveDocument,
    completionAdded = false,
  ): Promise<void> => {
    if (document !== undefined) enqueue(document, completionAdded);
    while (inFlight !== undefined || pending !== undefined) {
      drain();
      await inFlight;
    }
    if (failure !== undefined) throw failure;
  };

  const dispose = async (
    document?: ChessPuzzleSaveDocument,
    completionAdded = false,
  ): Promise<void> => {
    if (disposed) return;
    if (document !== undefined) enqueue(document, completionAdded);
    await flush();
    disposed = true;
  };

  return Object.freeze({ enqueue, flush, dispose });
}

export function validateChessPuzzleCatalog(catalog: ChessPuzzleCatalog): void {
  if (!catalog.revision) throw new Error("Chess puzzle catalog revision is required");
  const ids = new Set<string>();
  for (const puzzle of catalog.puzzles) {
    if (ids.has(puzzle.id)) throw new Error(`Duplicate Chess puzzle ${puzzle.id}`);
    ids.add(puzzle.id);
    chessPuzzleById(catalog, puzzle.id);
  }
}
