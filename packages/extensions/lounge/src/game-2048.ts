// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

export const GAME_2048_SIZE = 4;
export const GAME_2048_TARGET = 2048;
export const GAME_2048_ALGORITHM_VERSION = 1;

export type Game2048Direction = "up" | "down" | "left" | "right";
export type Game2048Status = "active" | "won" | "lost";

export interface Game2048Snapshot {
  readonly board: readonly number[];
  readonly score: number;
  readonly status: Game2048Status;
  readonly continued: boolean;
  readonly randomState: number;
}

export interface Game2048State extends Game2048Snapshot {
  readonly algorithmVersion: 1;
  readonly undo?: Game2048Snapshot;
}

export type Game2048Action =
  | { readonly type: "move"; readonly direction: Game2048Direction }
  | { readonly type: "undo" }
  | { readonly type: "continue" }
  | { readonly type: "restart"; readonly seed: number };

export interface Game2048TileMotion {
  readonly source: number;
  readonly destination: number;
  readonly value: number;
  readonly resultValue: number;
  readonly merged: boolean;
}

export interface Game2048Merge {
  readonly sources: readonly [number, number];
  readonly destination: number;
  readonly value: number;
}

export interface Game2048Spawn {
  readonly index: number;
  readonly value: 2 | 4;
}

export interface Game2048MoveTrace {
  readonly direction: Game2048Direction;
  readonly changed: boolean;
  readonly landedBoard: readonly number[];
  readonly motions: readonly Game2048TileMotion[];
  readonly merges: readonly Game2048Merge[];
  readonly spawn?: Game2048Spawn;
}

export interface Game2048MoveResult {
  readonly state: Game2048State;
  readonly trace: Game2048MoveTrace;
}

function freezeSnapshot(snapshot: Game2048Snapshot): Game2048Snapshot {
  return Object.freeze({ ...snapshot, board: Object.freeze([...snapshot.board]) });
}

function freezeState(state: Game2048State): Game2048State {
  return Object.freeze({
    ...state,
    board: Object.freeze([...state.board]),
    ...(state.undo === undefined ? {} : { undo: freezeSnapshot(state.undo) }),
  });
}

function normalizedSeed(seed: number): number {
  if (!Number.isSafeInteger(seed)) throw new Error("2048 seed must be a safe integer");
  const value = seed >>> 0;
  return value === 0 ? 0x9e3779b9 : value;
}

function random(state: number): readonly [number, number] {
  let next = state >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  next >>>= 0;
  return [next / 0x1_0000_0000, next] as const;
}

function spawn(
  board: readonly number[],
  randomState: number,
): {
  readonly board: readonly number[];
  readonly randomState: number;
  readonly spawn?: Game2048Spawn;
} {
  const empty = board.flatMap((value, index) => (value === 0 ? [index] : []));
  if (empty.length === 0) return { board, randomState };
  const [positionRoll, afterPosition] = random(randomState);
  const [valueRoll, afterValue] = random(afterPosition);
  const index = empty[
    Math.min(empty.length - 1, Math.floor(positionRoll * empty.length))
  ] as number;
  const value: 2 | 4 = valueRoll < 0.9 ? 2 : 4;
  const next = [...board];
  next[index] = value;
  return {
    board: Object.freeze(next),
    randomState: afterValue,
    spawn: Object.freeze({ index, value }),
  };
}

function indices(direction: Game2048Direction, line: number): readonly number[] {
  const forward = Array.from({ length: GAME_2048_SIZE }, (_, offset) => offset);
  const order = direction === "right" || direction === "down" ? forward.reverse() : forward;
  return order.map((offset) =>
    direction === "left" || direction === "right"
      ? line * GAME_2048_SIZE + offset
      : offset * GAME_2048_SIZE + line,
  );
}

function movedBoard(
  board: readonly number[],
  direction: Game2048Direction,
): {
  readonly board: readonly number[];
  readonly score: number;
  readonly changed: boolean;
  readonly motions: readonly Game2048TileMotion[];
  readonly merges: readonly Game2048Merge[];
} {
  const next = Array<number>(GAME_2048_SIZE * GAME_2048_SIZE).fill(0);
  const motions: Game2048TileMotion[] = [];
  const merges: Game2048Merge[] = [];
  let score = 0;
  for (let line = 0; line < GAME_2048_SIZE; line += 1) {
    const positions = indices(direction, line);
    const sources = positions.flatMap((source) => {
      const value = board[source] as number;
      return value === 0 ? [] : [{ source, value }];
    });
    let sourceOffset = 0;
    let destinationOffset = 0;
    while (sourceOffset < sources.length) {
      const first = sources[sourceOffset] as (typeof sources)[number];
      const second = sources[sourceOffset + 1];
      const destination = positions[destinationOffset] as number;
      if (second !== undefined && first.value === second.value) {
        const value = first.value * 2;
        next[destination] = value;
        motions.push(
          {
            source: first.source,
            destination,
            value: first.value,
            resultValue: value,
            merged: true,
          },
          {
            source: second.source,
            destination,
            value: second.value,
            resultValue: value,
            merged: true,
          },
        );
        merges.push({ sources: [first.source, second.source], destination, value });
        score += value;
        sourceOffset += 2;
      } else {
        next[destination] = first.value;
        motions.push({
          source: first.source,
          destination,
          value: first.value,
          resultValue: first.value,
          merged: false,
        });
        sourceOffset += 1;
      }
      destinationOffset += 1;
    }
  }
  return {
    board: Object.freeze(next),
    score,
    changed: next.some((value, index) => value !== board[index]),
    motions: Object.freeze(motions.map((motion) => Object.freeze(motion))),
    merges: Object.freeze(
      merges.map((merge) => Object.freeze({ ...merge, sources: Object.freeze(merge.sources) })),
    ),
  };
}

export function canMove2048(board: readonly number[]): boolean {
  if (board.some((value) => value === 0)) return true;
  for (let row = 0; row < GAME_2048_SIZE; row += 1) {
    for (let column = 0; column < GAME_2048_SIZE; column += 1) {
      const index = row * GAME_2048_SIZE + column;
      if (column + 1 < GAME_2048_SIZE && board[index] === board[index + 1]) return true;
      if (row + 1 < GAME_2048_SIZE && board[index] === board[index + GAME_2048_SIZE]) return true;
    }
  }
  return false;
}

export function createGame2048(seed: number): Game2048State {
  const first = spawn(Object.freeze(Array<number>(16).fill(0)), normalizedSeed(seed));
  const second = spawn(first.board, first.randomState);
  return freezeState({
    algorithmVersion: GAME_2048_ALGORITHM_VERSION,
    board: second.board,
    score: 0,
    status: "active",
    continued: false,
    randomState: second.randomState,
  });
}

export function restoreGame2048(input: {
  readonly board: readonly number[];
  readonly score: number;
  readonly status: Game2048Status;
  readonly continued: boolean;
  readonly randomState: number;
  readonly undo?: Game2048Snapshot;
}): Game2048State {
  validateGame2048Snapshot(input);
  if (input.undo !== undefined) validateGame2048Snapshot(input.undo);
  return freezeState({ algorithmVersion: 1, ...input });
}

export function validateGame2048Snapshot(value: Game2048Snapshot): void {
  if (value.board.length !== 16) throw new Error("2048 board must contain sixteen cells");
  if (
    value.board.some(
      (tile) =>
        !Number.isSafeInteger(tile) ||
        tile < 0 ||
        (tile !== 0 && !Number.isInteger(Math.log2(tile))),
    )
  ) {
    throw new Error("2048 board contains an invalid tile");
  }
  if (!Number.isSafeInteger(value.score) || value.score < 0)
    throw new Error("2048 score is invalid");
  if (
    !Number.isInteger(value.randomState) ||
    value.randomState < 0 ||
    value.randomState > 0xffffffff
  ) {
    throw new Error("2048 random state is invalid");
  }
  if (!(["active", "won", "lost"] as const).includes(value.status)) {
    throw new Error("2048 status is invalid");
  }
  if (typeof value.continued !== "boolean") throw new Error("2048 continuation state is invalid");
}

export function moveGame2048(
  state: Game2048State,
  direction: Game2048Direction,
): Game2048MoveResult {
  const movement = movedBoard(state.board, direction);
  const unchangedTrace = (): Game2048MoveTrace =>
    Object.freeze({
      direction,
      changed: false,
      landedBoard: state.board,
      motions: Object.freeze([]),
      merges: Object.freeze([]),
    });
  if (state.status !== "active" || !movement.changed) {
    return Object.freeze({ state, trace: unchangedTrace() });
  }
  const previous = freezeSnapshot({
    board: state.board,
    score: state.score,
    status: state.status,
    continued: state.continued,
    randomState: state.randomState,
  });
  const spawned = spawn(movement.board, state.randomState);
  const reachedTarget = spawned.board.some((tile) => tile >= GAME_2048_TARGET);
  const status: Game2048Status =
    reachedTarget && !state.continued ? "won" : canMove2048(spawned.board) ? "active" : "lost";
  const next = freezeState({
    algorithmVersion: 1,
    board: spawned.board,
    score: state.score + movement.score,
    status,
    continued: state.continued,
    randomState: spawned.randomState,
    undo: previous,
  });
  return Object.freeze({
    state: next,
    trace: Object.freeze({
      direction,
      changed: true,
      landedBoard: movement.board,
      motions: movement.motions,
      merges: movement.merges,
      ...(spawned.spawn === undefined ? {} : { spawn: spawned.spawn }),
    }),
  });
}

export function reduceGame2048(state: Game2048State, action: Game2048Action): Game2048State {
  if (action.type === "restart") return createGame2048(action.seed);
  if (action.type === "undo") {
    if (state.undo === undefined) return state;
    return freezeState({ algorithmVersion: 1, ...state.undo });
  }
  if (action.type === "continue") {
    if (state.status !== "won") return state;
    return freezeState({
      ...state,
      status: canMove2048(state.board) ? "active" : "lost",
      continued: true,
    });
  }
  return moveGame2048(state, action.direction).state;
}
