// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { JsonValue } from "@axl/extension-api";

import {
  restoreSudoku,
  type SudokuDifficulty,
  type SudokuSnapshot,
  type SudokuState,
} from "./sudoku.ts";

export const SUDOKU_STORAGE_SCHEMA_VERSION = 1;

export interface SudokuSaveDocument {
  readonly version: 1;
  readonly game: SudokuState;
}

export type SudokuSaveErrorCode = "corrupt" | "future-version" | "fixture-mismatch";

export class SudokuSaveError extends Error {
  readonly code: SudokuSaveErrorCode;

  constructor(code: SudokuSaveErrorCode, message: string) {
    super(message);
    this.name = "SudokuSaveError";
    this.code = code;
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new SudokuSaveError("corrupt", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new SudokuSaveError("corrupt", `${label}.${unknown} is unknown`);
}

function integer(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
    throw new SudokuSaveError("corrupt", `${label} must be a bounded non-negative integer`);
  return value as number;
}

function numbers(value: unknown, label: string, maximum: number): readonly number[] {
  if (!Array.isArray(value)) throw new SudokuSaveError("corrupt", `${label} must be an array`);
  return Object.freeze(value.map((item, index) => integer(item, `${label}[${index}]`, maximum)));
}

function booleans(value: unknown, label: string): readonly boolean[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "boolean"))
    throw new SudokuSaveError("corrupt", `${label} must be a boolean array`);
  return Object.freeze([...value]);
}

function snapshot(value: unknown, label: string): SudokuSnapshot {
  const input = object(value, label);
  exactKeys(
    input,
    ["values", "notes", "hinted", "selected", "notesMode", "hintCount", "status"],
    label,
  );
  if (typeof input.notesMode !== "boolean")
    throw new SudokuSaveError("corrupt", `${label}.notesMode is invalid`);
  if (input.status !== "active" && input.status !== "won")
    throw new SudokuSaveError("corrupt", `${label}.status is invalid`);
  return Object.freeze({
    values: numbers(input.values, `${label}.values`, 9),
    notes: numbers(input.notes, `${label}.notes`, 0x3fe),
    hinted: booleans(input.hinted, `${label}.hinted`),
    selected: integer(input.selected, `${label}.selected`, 80),
    notesMode: input.notesMode,
    hintCount: integer(input.hintCount, `${label}.hintCount`, 81),
    status: input.status,
  });
}

export function parseSudokuSave(value: JsonValue): SudokuSaveDocument {
  const input = object(value, "Sudoku save");
  if (typeof input.version === "number" && input.version > SUDOKU_STORAGE_SCHEMA_VERSION)
    throw new SudokuSaveError("future-version", `Unsupported Sudoku save version ${input.version}`);
  if (input.version !== SUDOKU_STORAGE_SCHEMA_VERSION)
    throw new SudokuSaveError("corrupt", "Sudoku save version is invalid");
  exactKeys(input, ["version", "game"], "Sudoku save");
  const game = object(input.game, "game");
  exactKeys(
    game,
    [
      "algorithmVersion",
      "selectionVersion",
      "fixtureSetRevision",
      "fixtureId",
      "difficulty",
      "values",
      "notes",
      "hinted",
      "selected",
      "notesMode",
      "hintCount",
      "status",
      "history",
    ],
    "game",
  );
  if (game.algorithmVersion !== 1 || game.selectionVersion !== 1)
    throw new SudokuSaveError("future-version", "Unsupported Sudoku algorithm version");
  if (game.fixtureSetRevision !== "axl-sudoku-v1")
    throw new SudokuSaveError(
      "fixture-mismatch",
      "Sudoku fixture set does not match this Axl version",
    );
  if (typeof game.fixtureId !== "string")
    throw new SudokuSaveError("corrupt", "Sudoku fixture ID is invalid");
  if (game.difficulty !== "easy" && game.difficulty !== "medium" && game.difficulty !== "hard")
    throw new SudokuSaveError("corrupt", "Sudoku difficulty is invalid");
  if (!Array.isArray(game.history) || game.history.length > 128)
    throw new SudokuSaveError("corrupt", "Sudoku undo history is invalid");
  try {
    const current = snapshot(
      {
        values: game.values,
        notes: game.notes,
        hinted: game.hinted,
        selected: game.selected,
        notesMode: game.notesMode,
        hintCount: game.hintCount,
        status: game.status,
      },
      "game",
    );
    const restored = restoreSudoku({
      fixtureId: game.fixtureId,
      difficulty: game.difficulty as SudokuDifficulty,
      ...current,
      history: Object.freeze(
        game.history.map((item, index) => snapshot(item, `game.history[${index}]`)),
      ),
    });
    return Object.freeze({ version: 1, game: restored });
  } catch (error) {
    if (error instanceof SudokuSaveError) throw error;
    throw new SudokuSaveError(
      "corrupt",
      error instanceof Error ? error.message : "Sudoku save is invalid",
    );
  }
}

export function sudokuSaveJson(document: SudokuSaveDocument): JsonValue {
  return JSON.parse(JSON.stringify(document)) as JsonValue;
}

export function updateSudokuSave(state: SudokuState): SudokuSaveDocument {
  return Object.freeze({ version: 1, game: state });
}
