// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { JsonValue } from "@axl/extension-api";

import {
  CODEWORD_DICTIONARY_REVISION,
  type CodewordDifficulty,
  type CodewordSelection,
  type CodewordState,
  createCodewordGame,
  reduceCodeword,
} from "./codeword.ts";

export const CODEWORD_STORAGE_SCHEMA_VERSION = 1;
const MAX_COMPLETION_RECORDS = 2_048;

export interface CodewordStatistics {
  readonly played: number;
  readonly wins: number;
  readonly winRate: number;
  readonly currentStreak: number;
  readonly maximumStreak: number;
  readonly guessDistribution: readonly [number, number, number, number, number, number];
}

export interface CodewordPreferences {
  readonly puzzle: "daily" | "practice";
  readonly difficulty: CodewordDifficulty;
}

interface SavedGame {
  readonly dictionaryRevision: string;
  readonly selection: CodewordSelection;
  readonly difficulty: CodewordDifficulty;
  readonly currentGuess: string;
  readonly guesses: readonly string[];
  readonly status: "active" | "won" | "lost";
  readonly completionRecorded: boolean;
}

interface CompletionRecord {
  readonly key: string;
  readonly won: boolean;
  readonly attempts: number;
  readonly dailyDate?: string;
}

export interface CodewordSaveDocument {
  readonly version: 1;
  readonly preferences: CodewordPreferences;
  readonly game?: SavedGame;
  readonly completions: readonly CompletionRecord[];
}

export type CodewordSaveErrorCode = "corrupt" | "future-version" | "dictionary-mismatch";

export class CodewordSaveError extends Error {
  readonly code: CodewordSaveErrorCode;

  constructor(code: CodewordSaveErrorCode, message: string) {
    super(message);
    this.name = "CodewordSaveError";
    this.code = code;
  }
}

export const EMPTY_CODEWORD_STATISTICS: CodewordStatistics = Object.freeze({
  played: 0,
  wins: 0,
  winRate: 0,
  currentStreak: 0,
  maximumStreak: 0,
  guessDistribution: Object.freeze([0, 0, 0, 0, 0, 0] as const),
});

export function createEmptyCodewordSave(): CodewordSaveDocument {
  return Object.freeze({
    version: 1,
    preferences: Object.freeze({ puzzle: "daily", difficulty: "normal" }),
    completions: Object.freeze([]),
  });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CodewordSaveError("corrupt", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined)
    throw new CodewordSaveError("corrupt", `${label}.${unknown} is unknown`);
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new CodewordSaveError("corrupt", `${label} must be an integer of at least ${minimum}`);
  }
  return value as number;
}

function selection(value: unknown): CodewordSelection {
  const input = object(value, "game.selection");
  if (input.kind === "daily") {
    exactKeys(input, ["kind", "algorithmVersion", "utcDate"], "game.selection");
    if (input.algorithmVersion !== 1 || typeof input.utcDate !== "string") {
      throw new CodewordSaveError("corrupt", "game.selection is invalid");
    }
    return { kind: "daily", algorithmVersion: 1, utcDate: input.utcDate };
  }
  if (input.kind === "practice") {
    exactKeys(input, ["kind", "algorithmVersion", "seed"], "game.selection");
    if (input.algorithmVersion !== 1 || !Number.isSafeInteger(input.seed)) {
      throw new CodewordSaveError("corrupt", "game.selection is invalid");
    }
    return { kind: "practice", algorithmVersion: 1, seed: input.seed as number };
  }
  throw new CodewordSaveError("corrupt", "game.selection kind is invalid");
}

function restoreGame(value: unknown): {
  readonly state: CodewordState;
  readonly recorded: boolean;
} {
  const game = object(value, "game");
  exactKeys(
    game,
    [
      "dictionaryRevision",
      "selection",
      "difficulty",
      "currentGuess",
      "guesses",
      "status",
      "completionRecorded",
    ],
    "game",
  );
  if (game.dictionaryRevision !== CODEWORD_DICTIONARY_REVISION) {
    throw new CodewordSaveError(
      "dictionary-mismatch",
      `Saved dictionary ${String(game.dictionaryRevision)} does not match ${CODEWORD_DICTIONARY_REVISION}`,
    );
  }
  if (game.difficulty !== "normal" && game.difficulty !== "hard") {
    throw new CodewordSaveError("corrupt", "game.difficulty is invalid");
  }
  if (!Array.isArray(game.guesses) || !game.guesses.every((guess) => typeof guess === "string")) {
    throw new CodewordSaveError("corrupt", "game.guesses is invalid");
  }
  if (typeof game.currentGuess !== "string" || typeof game.completionRecorded !== "boolean") {
    throw new CodewordSaveError("corrupt", "game state is invalid");
  }
  let state = createCodewordGame(selection(game.selection), game.difficulty);
  for (const guess of game.guesses) {
    for (const letter of guess) state = reduceCodeword(state, { type: "enter", letter });
    state = reduceCodeword(state, { type: "submit" });
    if (state.issue !== undefined) throw new CodewordSaveError("corrupt", "game guess is invalid");
  }
  for (const letter of game.currentGuess) state = reduceCodeword(state, { type: "enter", letter });
  if (state.issue !== undefined || state.status !== game.status) {
    throw new CodewordSaveError("corrupt", "game outcome does not match its guesses");
  }
  return { state, recorded: game.completionRecorded };
}

function completion(value: unknown, index: number): CompletionRecord {
  const record = object(value, `completions[${index}]`);
  exactKeys(record, ["key", "won", "attempts", "dailyDate"], `completions[${index}]`);
  if (typeof record.key !== "string" || !record.key || typeof record.won !== "boolean") {
    throw new CodewordSaveError("corrupt", `completions[${index}] is invalid`);
  }
  const attempts = integer(record.attempts, `completions[${index}].attempts`, 1);
  if (attempts > 6) throw new CodewordSaveError("corrupt", "completion attempts exceed six");
  if (record.key.length > 256) {
    throw new CodewordSaveError("corrupt", `completions[${index}].key is too long`);
  }
  if (record.dailyDate !== undefined) {
    if (typeof record.dailyDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(record.dailyDate)) {
      throw new CodewordSaveError("corrupt", `completions[${index}].dailyDate is invalid`);
    }
    const timestamp = Date.parse(`${record.dailyDate}T00:00:00.000Z`);
    if (
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 10) !== record.dailyDate ||
      record.key !== `daily:${record.dailyDate}`
    ) {
      throw new CodewordSaveError("corrupt", `completions[${index}].dailyDate is invalid`);
    }
  } else if (!/^practice:[a-z0-9._-]{1,128}:\d+:-?\d+$/u.test(record.key)) {
    throw new CodewordSaveError("corrupt", `completions[${index}].key is invalid`);
  }
  return Object.freeze({
    key: record.key,
    won: record.won,
    attempts,
    ...(record.dailyDate === undefined ? {} : { dailyDate: record.dailyDate }),
  });
}

export function parseCodewordSave(value: JsonValue): {
  readonly document: CodewordSaveDocument;
  readonly state?: CodewordState;
  readonly completionRecorded: boolean;
} {
  const input = object(value, "Codeword save");
  if (typeof input.version === "number" && input.version > CODEWORD_STORAGE_SCHEMA_VERSION) {
    throw new CodewordSaveError(
      "future-version",
      `Unsupported Codeword save version ${input.version}`,
    );
  }
  if (input.version !== CODEWORD_STORAGE_SCHEMA_VERSION) {
    throw new CodewordSaveError("corrupt", "Codeword save version is invalid");
  }
  exactKeys(input, ["version", "preferences", "game", "completions"], "Codeword save");
  const preferences = object(input.preferences, "preferences");
  exactKeys(preferences, ["puzzle", "difficulty"], "preferences");
  if (
    (preferences.puzzle !== "daily" && preferences.puzzle !== "practice") ||
    (preferences.difficulty !== "normal" && preferences.difficulty !== "hard")
  ) {
    throw new CodewordSaveError("corrupt", "Codeword preferences are invalid");
  }
  if (!Array.isArray(input.completions) || input.completions.length > MAX_COMPLETION_RECORDS) {
    throw new CodewordSaveError("corrupt", "Codeword completions are invalid");
  }
  const completions = input.completions.map(completion);
  if (new Set(completions.map(({ key }) => key)).size !== completions.length) {
    throw new CodewordSaveError("corrupt", "Codeword completion keys must be unique");
  }
  const restored = input.game === undefined ? undefined : restoreGame(input.game);
  if (restored !== undefined) {
    const recorded = completions.some(({ key }) => key === completionKey(restored.state));
    if (restored.recorded !== (restored.state.status !== "active" && recorded)) {
      throw new CodewordSaveError("corrupt", "game completion marker does not match statistics");
    }
  }
  const document = Object.freeze({
    version: 1 as const,
    preferences: Object.freeze({
      puzzle: preferences.puzzle,
      difficulty: preferences.difficulty,
    }) as CodewordPreferences,
    ...(restored === undefined ? {} : { game: gameRecord(restored.state, restored.recorded) }),
    completions: Object.freeze(completions),
  });
  return {
    document,
    ...(restored === undefined ? {} : { state: restored.state }),
    completionRecorded: restored?.recorded ?? false,
  };
}

function gameRecord(state: CodewordState, completionRecorded: boolean): SavedGame {
  return Object.freeze({
    dictionaryRevision: state.dictionaryRevision,
    selection: state.selection,
    difficulty: state.difficulty,
    currentGuess: state.currentGuess,
    guesses: Object.freeze(state.guesses.map(({ word }) => word)),
    status: state.status,
    completionRecorded,
  });
}

function completionKey(state: CodewordState): string {
  return state.selection.kind === "daily"
    ? `daily:${state.selection.utcDate}`
    : `practice:${state.dictionaryRevision}:${state.selection.algorithmVersion}:${state.selection.seed}`;
}

export function updateCodewordSave(
  document: CodewordSaveDocument,
  state: CodewordState,
  preferences: CodewordPreferences,
): { readonly document: CodewordSaveDocument; readonly completionAdded: boolean } {
  const key = completionKey(state);
  const alreadyRecorded = document.completions.some((record) => record.key === key);
  const completionAdded = state.status !== "active" && !alreadyRecorded;
  if (completionAdded && document.completions.length >= MAX_COMPLETION_RECORDS) {
    throw new CodewordSaveError("corrupt", "Codeword completion history is full");
  }
  const completions = completionAdded
    ? [
        ...document.completions,
        Object.freeze({
          key,
          won: state.status === "won",
          attempts: state.guesses.length,
          ...(state.selection.kind === "daily" ? { dailyDate: state.selection.utcDate } : {}),
        }),
      ]
    : document.completions;
  return {
    document: Object.freeze({
      version: 1,
      preferences: Object.freeze({ ...preferences }),
      game: gameRecord(state, state.status !== "active" && (alreadyRecorded || completionAdded)),
      completions: Object.freeze(completions),
    }),
    completionAdded,
  };
}

function utcDay(value: string): number {
  return Math.floor(Date.parse(`${value}T00:00:00.000Z`) / 86_400_000);
}

export function mergeCodewordCompletions(
  latest: CodewordSaveDocument,
  proposed: CodewordSaveDocument,
): CodewordSaveDocument {
  const byKey = new Map(latest.completions.map((record) => [record.key, record]));
  for (const record of proposed.completions) byKey.set(record.key, record);
  const completions = [...byKey.values()].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
  if (completions.length > MAX_COMPLETION_RECORDS) {
    throw new CodewordSaveError("corrupt", "Codeword completion history is full");
  }
  return Object.freeze({
    ...latest,
    completions: Object.freeze(completions),
  });
}

export function codewordStatistics(document: CodewordSaveDocument): CodewordStatistics {
  const played = document.completions.length;
  const wins = document.completions.filter(({ won }) => won).length;
  const distribution: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
  for (const completion of document.completions) {
    if (completion.won) {
      const index = completion.attempts - 1;
      distribution[index] = (distribution[index] ?? 0) + 1;
    }
  }
  const daily = document.completions
    .filter((record): record is CompletionRecord & { readonly dailyDate: string } =>
      Boolean(record.dailyDate),
    )
    .sort((left, right) =>
      left.dailyDate < right.dailyDate ? -1 : left.dailyDate > right.dailyDate ? 1 : 0,
    );
  let currentStreak = 0;
  let maximumStreak = 0;
  let previousDay: number | undefined;
  for (const record of daily) {
    const day = utcDay(record.dailyDate);
    currentStreak =
      record.won && (previousDay === undefined || day === previousDay + 1)
        ? currentStreak + 1
        : record.won
          ? 1
          : 0;
    maximumStreak = Math.max(maximumStreak, currentStreak);
    previousDay = day;
  }
  return Object.freeze({
    played,
    wins,
    winRate: played === 0 ? 0 : Math.round((wins / played) * 100),
    currentStreak,
    maximumStreak,
    guessDistribution: Object.freeze(distribution),
  });
}

export function codewordSaveJson(document: CodewordSaveDocument): JsonValue {
  return JSON.parse(JSON.stringify(document)) as JsonValue;
}
