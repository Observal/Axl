// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { JsonValue } from "@axl/extension-api";

import {
  type MinesweeperPreset,
  type MinesweeperState,
  restoreMinesweeper,
} from "./minesweeper.ts";

export const MINESWEEPER_STORAGE_SCHEMA_VERSION = 1;

export interface MinesweeperSaveDocument {
  readonly version: 1;
  readonly game: MinesweeperState;
}

export type MinesweeperSaveErrorCode = "corrupt" | "future-version";

export class MinesweeperSaveError extends Error {
  readonly code: MinesweeperSaveErrorCode;

  constructor(code: MinesweeperSaveErrorCode, message: string) {
    super(message);
    this.name = "MinesweeperSaveError";
    this.code = code;
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MinesweeperSaveError("corrupt", `${label} must be an object`);
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
    throw new MinesweeperSaveError("corrupt", `${label}.${unknown} is unknown`);
}

function integer(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new MinesweeperSaveError("corrupt", `${label} must be a bounded non-negative integer`);
  }
  return value as number;
}

function booleans(value: unknown, label: string): readonly boolean[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "boolean")) {
    throw new MinesweeperSaveError("corrupt", `${label} must be a boolean array`);
  }
  return Object.freeze([...value]);
}

export function parseMinesweeperSave(value: JsonValue): MinesweeperSaveDocument {
  const input = object(value, "Minesweeper save");
  if (typeof input.version === "number" && input.version > MINESWEEPER_STORAGE_SCHEMA_VERSION) {
    throw new MinesweeperSaveError(
      "future-version",
      `Unsupported Minesweeper save version ${input.version}`,
    );
  }
  if (input.version !== MINESWEEPER_STORAGE_SCHEMA_VERSION) {
    throw new MinesweeperSaveError("corrupt", "Minesweeper save version is invalid");
  }
  exactKeys(input, ["version", "game"], "Minesweeper save");
  const game = object(input.game, "game");
  exactKeys(
    game,
    [
      "algorithmVersion",
      "preset",
      "width",
      "height",
      "mineCount",
      "randomState",
      "minesPlaced",
      "mines",
      "revealed",
      "flagged",
      "cursor",
      "status",
      "exploded",
      "elapsedMs",
    ],
    "game",
  );
  if (game.algorithmVersion !== 1) {
    throw new MinesweeperSaveError("future-version", "Unsupported Minesweeper algorithm version");
  }
  if (game.preset !== "beginner" && game.preset !== "intermediate" && game.preset !== "expert") {
    throw new MinesweeperSaveError("corrupt", "Minesweeper preset is invalid");
  }
  if (
    game.status !== "ready" &&
    game.status !== "active" &&
    game.status !== "won" &&
    game.status !== "lost"
  ) {
    throw new MinesweeperSaveError("corrupt", "Minesweeper status is invalid");
  }
  if (typeof game.minesPlaced !== "boolean") {
    throw new MinesweeperSaveError("corrupt", "Minesweeper placement state is invalid");
  }
  try {
    const restored = restoreMinesweeper({
      preset: game.preset as MinesweeperPreset,
      width: integer(game.width, "game.width", 30),
      height: integer(game.height, "game.height", 24),
      mineCount: integer(game.mineCount, "game.mineCount", 719),
      randomState: integer(game.randomState, "game.randomState", 0xffffffff),
      minesPlaced: game.minesPlaced,
      mines: booleans(game.mines, "game.mines"),
      revealed: booleans(game.revealed, "game.revealed"),
      flagged: booleans(game.flagged, "game.flagged"),
      cursor: integer(game.cursor, "game.cursor", 719),
      status: game.status,
      ...(game.exploded === undefined
        ? {}
        : { exploded: integer(game.exploded, "game.exploded", 719) }),
      elapsedMs: integer(game.elapsedMs, "game.elapsedMs"),
    });
    return Object.freeze({ version: 1, game: restored });
  } catch (error) {
    if (error instanceof MinesweeperSaveError) throw error;
    throw new MinesweeperSaveError(
      "corrupt",
      error instanceof Error ? error.message : "Minesweeper save is invalid",
    );
  }
}

export function minesweeperSaveJson(document: MinesweeperSaveDocument): JsonValue {
  return JSON.parse(JSON.stringify(document)) as JsonValue;
}

export function updateMinesweeperSave(state: MinesweeperState): MinesweeperSaveDocument {
  return Object.freeze({ version: 1, game: state });
}
