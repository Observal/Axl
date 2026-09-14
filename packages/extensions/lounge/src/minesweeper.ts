// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

export const MINESWEEPER_ALGORITHM_VERSION = 1;

export type MinesweeperPreset = "beginner" | "intermediate" | "expert";
export type MinesweeperStatus = "ready" | "active" | "won" | "lost";
export type MinesweeperDirection = "up" | "down" | "left" | "right";

export interface MinesweeperPresetDefinition {
  readonly width: number;
  readonly height: number;
  readonly mines: number;
}

export const MINESWEEPER_PRESETS: Readonly<Record<MinesweeperPreset, MinesweeperPresetDefinition>> =
  Object.freeze({
    beginner: Object.freeze({ width: 9, height: 9, mines: 10 }),
    intermediate: Object.freeze({ width: 16, height: 16, mines: 40 }),
    expert: Object.freeze({ width: 30, height: 16, mines: 99 }),
  });

export interface MinesweeperState {
  readonly algorithmVersion: 1;
  readonly preset: MinesweeperPreset;
  readonly width: number;
  readonly height: number;
  readonly mineCount: number;
  readonly randomState: number;
  readonly minesPlaced: boolean;
  readonly mines: readonly boolean[];
  readonly revealed: readonly boolean[];
  readonly flagged: readonly boolean[];
  readonly cursor: number;
  readonly status: MinesweeperStatus;
  readonly exploded?: number;
  readonly elapsedMs: number;
}

export type MinesweeperAction =
  | { readonly type: "move"; readonly direction: MinesweeperDirection }
  | { readonly type: "cursor"; readonly index: number }
  | { readonly type: "reveal" }
  | { readonly type: "flag" }
  | { readonly type: "chord" }
  | { readonly type: "elapsed"; readonly elapsedMs: number }
  | { readonly type: "restart"; readonly preset: MinesweeperPreset; readonly seed: number };

function normalizedSeed(seed: number): number {
  if (!Number.isSafeInteger(seed)) throw new Error("Minesweeper seed must be a safe integer");
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

function freezeState(state: MinesweeperState): MinesweeperState {
  return Object.freeze({
    ...state,
    mines: Object.freeze([...state.mines]),
    revealed: Object.freeze([...state.revealed]),
    flagged: Object.freeze([...state.flagged]),
  });
}

function cells(state: Pick<MinesweeperState, "width" | "height">): number {
  return state.width * state.height;
}

export function minesweeperIndex(width: number, row: number, column: number): number {
  return row * width + column;
}

export function minesweeperCoordinates(
  state: Pick<MinesweeperState, "width">,
  index: number,
): { readonly row: number; readonly column: number } {
  return { row: Math.floor(index / state.width), column: index % state.width };
}

export function minesweeperNeighbors(
  state: Pick<MinesweeperState, "width" | "height">,
  index: number,
): readonly number[] {
  const { row, column } = minesweeperCoordinates(state, index);
  const result: number[] = [];
  for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
    for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
      if (rowOffset === 0 && columnOffset === 0) continue;
      const nextRow = row + rowOffset;
      const nextColumn = column + columnOffset;
      if (nextRow < 0 || nextRow >= state.height || nextColumn < 0 || nextColumn >= state.width) {
        continue;
      }
      result.push(minesweeperIndex(state.width, nextRow, nextColumn));
    }
  }
  return Object.freeze(result);
}

export function adjacentMineCount(state: MinesweeperState, index: number): number {
  return minesweeperNeighbors(state, index).filter((neighbor) => state.mines[neighbor]).length;
}

export function remainingMineEstimate(state: MinesweeperState): number {
  return state.mineCount - state.flagged.filter(Boolean).length;
}

export function createMinesweeper(
  preset: MinesweeperPreset = "beginner",
  seed = 1,
): MinesweeperState {
  const definition = MINESWEEPER_PRESETS[preset];
  const size = definition.width * definition.height;
  return freezeState({
    algorithmVersion: MINESWEEPER_ALGORITHM_VERSION,
    preset,
    width: definition.width,
    height: definition.height,
    mineCount: definition.mines,
    randomState: normalizedSeed(seed),
    minesPlaced: false,
    mines: Array<boolean>(size).fill(false),
    revealed: Array<boolean>(size).fill(false),
    flagged: Array<boolean>(size).fill(false),
    cursor: 0,
    status: "ready",
    elapsedMs: 0,
  });
}

function placedMines(
  state: MinesweeperState,
  firstReveal: number,
): { readonly mines: readonly boolean[]; readonly randomState: number } {
  const safeRegion = new Set([firstReveal, ...minesweeperNeighbors(state, firstReveal)]);
  const all = Array.from({ length: cells(state) }, (_, index) => index);
  const outsideRegion = all.filter((index) => !safeRegion.has(index));
  const eligible =
    outsideRegion.length >= state.mineCount
      ? outsideRegion
      : all.filter((index) => index !== firstReveal);
  let randomState = state.randomState;
  const shuffled = [...eligible];
  for (let index = 0; index < state.mineCount; index += 1) {
    const [roll, next] = random(randomState);
    randomState = next;
    const selected =
      index + Math.min(shuffled.length - index - 1, Math.floor(roll * (shuffled.length - index)));
    [shuffled[index], shuffled[selected]] = [
      shuffled[selected] as number,
      shuffled[index] as number,
    ];
  }
  const mines = Array<boolean>(cells(state)).fill(false);
  for (const index of shuffled.slice(0, state.mineCount)) mines[index] = true;
  return { mines: Object.freeze(mines), randomState };
}

function revealSafeCells(state: MinesweeperState, starts: readonly number[]): readonly boolean[] {
  const revealed = [...state.revealed];
  const queued = new Set<number>();
  const queue: number[] = [];
  for (const index of starts) {
    if (!state.flagged[index] && !state.mines[index] && !revealed[index]) {
      queue.push(index);
      queued.add(index);
    }
  }
  while (queue.length > 0) {
    const index = queue.shift() as number;
    revealed[index] = true;
    if (adjacentMineCount(state, index) !== 0) continue;
    for (const neighbor of minesweeperNeighbors(state, index)) {
      if (
        !queued.has(neighbor) &&
        !revealed[neighbor] &&
        !state.flagged[neighbor] &&
        !state.mines[neighbor]
      ) {
        queued.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return Object.freeze(revealed);
}

function outcome(state: MinesweeperState, revealed: readonly boolean[]): MinesweeperStatus {
  return revealed.every((value, index) => value || state.mines[index]) ? "won" : "active";
}

function reveal(state: MinesweeperState): MinesweeperState {
  if (state.status === "won" || state.status === "lost" || state.flagged[state.cursor])
    return state;
  if (state.revealed[state.cursor]) return state;
  let working = state;
  if (!state.minesPlaced) {
    const placement = placedMines(state, state.cursor);
    working = freezeState({
      ...state,
      minesPlaced: true,
      mines: placement.mines,
      randomState: placement.randomState,
      status: "active",
    });
  }
  if (working.mines[working.cursor]) {
    return freezeState({ ...working, status: "lost", exploded: working.cursor });
  }
  const revealed = revealSafeCells(working, [working.cursor]);
  return freezeState({ ...working, revealed, status: outcome(working, revealed) });
}

function chord(state: MinesweeperState): MinesweeperState {
  if (state.status !== "active" || !state.revealed[state.cursor]) return state;
  const number = adjacentMineCount(state, state.cursor);
  if (number === 0) return state;
  const neighbors = minesweeperNeighbors(state, state.cursor);
  if (neighbors.filter((index) => state.flagged[index]).length !== number) return state;
  const targets = neighbors.filter((index) => !state.flagged[index] && !state.revealed[index]);
  const exploded = targets.find((index) => state.mines[index]);
  if (exploded !== undefined) return freezeState({ ...state, status: "lost", exploded });
  const revealed = revealSafeCells(state, targets);
  if (revealed.every((value, index) => value === state.revealed[index])) return state;
  return freezeState({ ...state, revealed, status: outcome(state, revealed) });
}

function moveCursor(state: MinesweeperState, direction: MinesweeperDirection): MinesweeperState {
  const { row, column } = minesweeperCoordinates(state, state.cursor);
  const nextRow =
    direction === "up"
      ? Math.max(0, row - 1)
      : direction === "down"
        ? Math.min(state.height - 1, row + 1)
        : row;
  const nextColumn =
    direction === "left"
      ? Math.max(0, column - 1)
      : direction === "right"
        ? Math.min(state.width - 1, column + 1)
        : column;
  const cursor = minesweeperIndex(state.width, nextRow, nextColumn);
  return cursor === state.cursor ? state : freezeState({ ...state, cursor });
}

export function reduceMinesweeper(
  state: MinesweeperState,
  action: MinesweeperAction,
): MinesweeperState {
  if (action.type === "restart") return createMinesweeper(action.preset, action.seed);
  if (action.type === "move") return moveCursor(state, action.direction);
  if (action.type === "cursor") {
    return Number.isSafeInteger(action.index) &&
      action.index >= 0 &&
      action.index < cells(state) &&
      action.index !== state.cursor
      ? freezeState({ ...state, cursor: action.index })
      : state;
  }
  if (action.type === "elapsed") {
    if (
      state.status !== "active" ||
      !Number.isSafeInteger(action.elapsedMs) ||
      action.elapsedMs < state.elapsedMs
    )
      return state;
    return action.elapsedMs === state.elapsedMs
      ? state
      : freezeState({ ...state, elapsedMs: action.elapsedMs });
  }
  if (action.type === "reveal") return reveal(state);
  if (action.type === "chord") return chord(state);
  if (state.status === "won" || state.status === "lost" || state.revealed[state.cursor])
    return state;
  const flagged = [...state.flagged];
  flagged[state.cursor] = !flagged[state.cursor];
  return freezeState({ ...state, flagged: Object.freeze(flagged) });
}

export function restoreMinesweeper(
  input: Omit<MinesweeperState, "algorithmVersion">,
): MinesweeperState {
  const state = freezeState({ algorithmVersion: 1, ...input });
  validateMinesweeperState(state);
  return state;
}

export function validateMinesweeperState(state: MinesweeperState): void {
  const definition = MINESWEEPER_PRESETS[state.preset];
  if (
    definition === undefined ||
    state.width !== definition.width ||
    state.height !== definition.height ||
    state.mineCount !== definition.mines
  )
    throw new Error("Minesweeper preset dimensions are invalid");
  const size = cells(state);
  if (
    state.mines.length !== size ||
    state.revealed.length !== size ||
    state.flagged.length !== size
  )
    throw new Error("Minesweeper board length is invalid");
  if (
    ![...state.mines, ...state.revealed, ...state.flagged].every(
      (value) => typeof value === "boolean",
    )
  )
    throw new Error("Minesweeper board contains an invalid cell");
  if (
    !Number.isInteger(state.randomState) ||
    state.randomState <= 0 ||
    state.randomState > 0xffffffff
  )
    throw new Error("Minesweeper random state is invalid");
  if (!Number.isSafeInteger(state.cursor) || state.cursor < 0 || state.cursor >= size)
    throw new Error("Minesweeper cursor is invalid");
  if (!Number.isSafeInteger(state.elapsedMs) || state.elapsedMs < 0)
    throw new Error("Minesweeper elapsed time is invalid");
  if (state.revealed.some((value, index) => value && state.flagged[index]))
    throw new Error("Minesweeper cell cannot be revealed and flagged");
  if (state.revealed.some((value, index) => value && state.mines[index]))
    throw new Error("Minesweeper mine cannot be revealed as a safe cell");
  const placedCount = state.mines.filter(Boolean).length;
  if (state.minesPlaced ? placedCount !== state.mineCount : placedCount !== 0)
    throw new Error("Minesweeper mine placement is inconsistent");
  if (
    !state.minesPlaced &&
    (state.status !== "ready" ||
      state.revealed.some(Boolean) ||
      state.exploded !== undefined ||
      state.elapsedMs !== 0)
  )
    throw new Error("Minesweeper unplaced board is inconsistent");
  const safeCleared = state.revealed.every((value, index) => value || state.mines[index]);
  if (
    state.status === "won" &&
    (!state.minesPlaced || !safeCleared || state.exploded !== undefined)
  )
    throw new Error("Minesweeper win is inconsistent");
  if (
    state.status === "active" &&
    (!state.minesPlaced || safeCleared || state.exploded !== undefined)
  )
    throw new Error("Minesweeper active board is inconsistent");
  if (
    state.status === "lost" &&
    (state.exploded === undefined || !state.mines[state.exploded] || state.flagged[state.exploded])
  )
    throw new Error("Minesweeper loss is inconsistent");
  if (state.status !== "lost" && state.exploded !== undefined)
    throw new Error("Minesweeper exploded cell is inconsistent");
}
