// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { JsonValue } from "@axl/extension-api";

import {
  canMove2048,
  type Game2048Snapshot,
  type Game2048State,
  restoreGame2048,
} from "./game-2048.ts";

export const GAME_2048_STORAGE_SCHEMA_VERSION = 1;

export interface Game2048SaveDocument {
  readonly version: 1;
  readonly bestScore: number;
  readonly game: Game2048State;
}

export type Game2048SaveErrorCode = "corrupt" | "future-version";

export class Game2048SaveError extends Error {
  readonly code: Game2048SaveErrorCode;

  constructor(code: Game2048SaveErrorCode, message: string) {
    super(message);
    this.name = "Game2048SaveError";
    this.code = code;
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Game2048SaveError("corrupt", `${label} must be an object`);
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
    throw new Game2048SaveError("corrupt", `${label}.${unknown} is unknown`);
}

function integer(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Game2048SaveError("corrupt", `${label} must be a bounded non-negative integer`);
  }
  return value as number;
}

function snapshot(value: unknown, label: string, gameRoot = false): Game2048Snapshot {
  const input = object(value, label);
  exactKeys(
    input,
    gameRoot
      ? ["algorithmVersion", "board", "score", "status", "continued", "randomState", "undo"]
      : ["board", "score", "status", "continued", "randomState"],
    label,
  );
  if (!Array.isArray(input.board))
    throw new Game2048SaveError("corrupt", `${label}.board is invalid`);
  const board = input.board.map((tile, index) => integer(tile, `${label}.board[${index}]`));
  if (input.status !== "active" && input.status !== "won" && input.status !== "lost") {
    throw new Game2048SaveError("corrupt", `${label}.status is invalid`);
  }
  if (typeof input.continued !== "boolean") {
    throw new Game2048SaveError("corrupt", `${label}.continued is invalid`);
  }
  return {
    board: Object.freeze(board),
    score: integer(input.score, `${label}.score`),
    status: input.status,
    continued: input.continued,
    randomState: integer(input.randomState, `${label}.randomState`, 0xffffffff),
  };
}

export function parseGame2048Save(value: JsonValue): Game2048SaveDocument {
  const input = object(value, "2048 save");
  if (typeof input.version === "number" && input.version > GAME_2048_STORAGE_SCHEMA_VERSION) {
    throw new Game2048SaveError("future-version", `Unsupported 2048 save version ${input.version}`);
  }
  if (input.version !== GAME_2048_STORAGE_SCHEMA_VERSION) {
    throw new Game2048SaveError("corrupt", "2048 save version is invalid");
  }
  exactKeys(input, ["version", "bestScore", "game"], "2048 save");
  const game = object(input.game, "game");
  exactKeys(
    game,
    ["algorithmVersion", "board", "score", "status", "continued", "randomState", "undo"],
    "game",
  );
  if (game.algorithmVersion !== 1) {
    throw new Game2048SaveError("future-version", "Unsupported 2048 algorithm version");
  }
  try {
    const restored = restoreGame2048({
      ...snapshot(game, "game", true),
      ...(game.undo === undefined ? {} : { undo: snapshot(game.undo, "game.undo") }),
    });
    if (restored.randomState === 0 || restored.undo?.randomState === 0) {
      throw new Game2048SaveError("corrupt", "2048 random state must be non-zero");
    }
    const hasTarget = restored.board.some((tile) => tile >= 2048);
    if (
      (restored.status === "won" && (!hasTarget || restored.continued)) ||
      (restored.status === "lost" && canMove2048(restored.board)) ||
      (restored.status === "active" &&
        (!canMove2048(restored.board) || (hasTarget && !restored.continued)))
    ) {
      throw new Game2048SaveError("corrupt", "2048 outcome does not match its board");
    }
    const bestScore = integer(input.bestScore, "bestScore");
    if (bestScore < restored.score) {
      throw new Game2048SaveError("corrupt", "2048 best score is below the current score");
    }
    return Object.freeze({ version: 1, bestScore, game: restored });
  } catch (error) {
    if (error instanceof Game2048SaveError) throw error;
    throw new Game2048SaveError(
      "corrupt",
      error instanceof Error ? error.message : "2048 save is invalid",
    );
  }
}

export function game2048SaveJson(document: Game2048SaveDocument): JsonValue {
  return JSON.parse(JSON.stringify(document)) as JsonValue;
}

export function updateGame2048Save(state: Game2048State, previousBest = 0): Game2048SaveDocument {
  return Object.freeze({
    version: 1,
    bestScore: Math.max(previousBest, state.score),
    game: state,
  });
}
