// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  SUDOKU_FIXTURES,
  SUDOKU_FIXTURE_SET_REVISION,
  type SudokuDifficulty,
  type SudokuFixture,
} from "./sudoku-fixtures.generated.ts";

export const SUDOKU_ALGORITHM_VERSION = 1;
export const SUDOKU_SELECTION_VERSION = 1;
export const SUDOKU_SIZE = 9;
export const SUDOKU_CELLS = 81;
export const SUDOKU_ALL_NOTES = 0x3fe;
const MAX_UNDO = 128;

export type SudokuStatus = "active" | "won";
export type SudokuDirection = "up" | "down" | "left" | "right";

export interface SudokuSnapshot {
  readonly values: readonly number[];
  readonly notes: readonly number[];
  readonly hinted: readonly boolean[];
  readonly selected: number;
  readonly notesMode: boolean;
  readonly hintCount: number;
  readonly status: SudokuStatus;
}

export interface SudokuState extends SudokuSnapshot {
  readonly algorithmVersion: 1;
  readonly selectionVersion: 1;
  readonly fixtureSetRevision: typeof SUDOKU_FIXTURE_SET_REVISION;
  readonly fixtureId: string;
  readonly difficulty: SudokuDifficulty;
  readonly history: readonly SudokuSnapshot[];
}

export type SudokuAction =
  | { readonly type: "move"; readonly direction: SudokuDirection }
  | { readonly type: "select"; readonly index: number }
  | { readonly type: "digit"; readonly digit: number }
  | { readonly type: "erase" }
  | { readonly type: "toggle-notes" }
  | { readonly type: "undo" }
  | { readonly type: "hint" }
  | { readonly type: "restart"; readonly difficulty: SudokuDifficulty; readonly seed: number };

function fixtureDigits(value: string): readonly number[] {
  return Object.freeze([...value].map((digit) => Number(digit)));
}

export function sudokuFixture(fixtureId: string): SudokuFixture {
  const fixture = SUDOKU_FIXTURES.find(({ id }) => id === fixtureId);
  if (fixture === undefined) throw new Error(`Unknown Sudoku fixture ${fixtureId}`);
  return fixture;
}

export function sudokuGivenValues(state: Pick<SudokuState, "fixtureId">): readonly number[] {
  return fixtureDigits(sudokuFixture(state.fixtureId).puzzle);
}

export function sudokuSolution(state: Pick<SudokuState, "fixtureId">): readonly number[] {
  return fixtureDigits(sudokuFixture(state.fixtureId).solution);
}

function normalizedSeed(seed: number): number {
  if (!Number.isSafeInteger(seed)) throw new Error("Sudoku seed must be a safe integer");
  const value = seed >>> 0;
  return value === 0 ? 0x9e3779b9 : value;
}

function nextRandom(state: number): number {
  let next = normalizedSeed(state);
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

export function selectSudokuFixture(difficulty: SudokuDifficulty, seed: number): SudokuFixture {
  const fixtures = SUDOKU_FIXTURES.filter((fixture) => fixture.difficulty === difficulty);
  if (fixtures.length === 0) throw new Error(`No Sudoku fixtures for ${difficulty}`);
  return fixtures[nextRandom(seed) % fixtures.length] as SudokuFixture;
}

function freezeSnapshot(snapshot: SudokuSnapshot): SudokuSnapshot {
  return Object.freeze({
    ...snapshot,
    values: Object.freeze([...snapshot.values]),
    notes: Object.freeze([...snapshot.notes]),
    hinted: Object.freeze([...snapshot.hinted]),
  });
}

function freezeState(state: SudokuState): SudokuState {
  return Object.freeze({
    ...freezeSnapshot(state),
    algorithmVersion: 1,
    selectionVersion: 1,
    fixtureSetRevision: SUDOKU_FIXTURE_SET_REVISION,
    fixtureId: state.fixtureId,
    difficulty: state.difficulty,
    history: Object.freeze(state.history.map(freezeSnapshot)),
  });
}

function snapshot(state: SudokuState): SudokuSnapshot {
  return freezeSnapshot({
    values: state.values,
    notes: state.notes,
    hinted: state.hinted,
    selected: state.selected,
    notesMode: state.notesMode,
    hintCount: state.hintCount,
    status: state.status,
  });
}

export function sudokuPeers(index: number): readonly number[] {
  const row = Math.floor(index / 9);
  const column = index % 9;
  const peers = new Set<number>();
  for (let offset = 0; offset < 9; offset += 1) {
    peers.add(row * 9 + offset);
    peers.add(offset * 9 + column);
  }
  const boxRow = Math.floor(row / 3) * 3;
  const boxColumn = Math.floor(column / 3) * 3;
  for (let rowOffset = 0; rowOffset < 3; rowOffset += 1)
    for (let columnOffset = 0; columnOffset < 3; columnOffset += 1)
      peers.add((boxRow + rowOffset) * 9 + boxColumn + columnOffset);
  peers.delete(index);
  return Object.freeze([...peers].sort((left, right) => left - right));
}

export function sudokuConflicts(values: readonly number[]): ReadonlySet<number> {
  const conflicts = new Set<number>();
  const units: number[][] = [];
  for (let row = 0; row < 9; row += 1)
    units.push(Array.from({ length: 9 }, (_, column) => row * 9 + column));
  for (let column = 0; column < 9; column += 1)
    units.push(Array.from({ length: 9 }, (_, row) => row * 9 + column));
  for (let box = 0; box < 9; box += 1) {
    const boxRow = Math.floor(box / 3) * 3;
    const boxColumn = (box % 3) * 3;
    units.push(
      Array.from(
        { length: 9 },
        (_, offset) => (boxRow + Math.floor(offset / 3)) * 9 + boxColumn + (offset % 3),
      ),
    );
  }
  for (const unit of units) {
    const positions = new Map<number, number[]>();
    for (const index of unit) {
      const digit = values[index] as number;
      if (digit === 0) continue;
      const matches = positions.get(digit) ?? [];
      matches.push(index);
      positions.set(digit, matches);
    }
    for (const matches of positions.values()) {
      if (matches.length > 1) for (const index of matches) conflicts.add(index);
    }
  }
  return conflicts;
}

function completed(values: readonly number[], solution: readonly number[]): boolean {
  if (values.some((digit) => digit === 0) || sudokuConflicts(values).size > 0) return false;
  return values.every((digit, index) => digit === solution[index]);
}

export function createSudoku(difficulty: SudokuDifficulty = "easy", seed = 1): SudokuState {
  const fixture = selectSudokuFixture(difficulty, seed);
  const values = fixtureDigits(fixture.puzzle);
  return freezeState({
    algorithmVersion: SUDOKU_ALGORITHM_VERSION,
    selectionVersion: SUDOKU_SELECTION_VERSION,
    fixtureSetRevision: SUDOKU_FIXTURE_SET_REVISION,
    fixtureId: fixture.id,
    difficulty,
    values,
    notes: Array<number>(SUDOKU_CELLS).fill(0),
    hinted: Array<boolean>(SUDOKU_CELLS).fill(false),
    selected: values.indexOf(0),
    notesMode: false,
    hintCount: 0,
    status: "active",
    history: [],
  });
}

function changedState(
  state: SudokuState,
  changes: Partial<SudokuSnapshot>,
  recordHistory = true,
): SudokuState {
  const values = changes.values ?? state.values;
  const status = completed(values, sudokuSolution(state)) ? "won" : "active";
  const history = recordHistory
    ? [...state.history.slice(-(MAX_UNDO - 1)), snapshot(state)]
    : state.history;
  return freezeState({ ...state, ...changes, values, status, history });
}

function move(state: SudokuState, direction: SudokuDirection): SudokuState {
  const row = Math.floor(state.selected / 9);
  const column = state.selected % 9;
  const nextRow =
    direction === "up" ? Math.max(0, row - 1) : direction === "down" ? Math.min(8, row + 1) : row;
  const nextColumn =
    direction === "left"
      ? Math.max(0, column - 1)
      : direction === "right"
        ? Math.min(8, column + 1)
        : column;
  const selected = nextRow * 9 + nextColumn;
  return selected === state.selected ? state : freezeState({ ...state, selected });
}

function enterDigit(state: SudokuState, digit: number): SudokuState {
  if (!Number.isInteger(digit) || digit < 1 || digit > 9 || state.status === "won") return state;
  const givens = sudokuGivenValues(state);
  if ((givens[state.selected] as number) !== 0) return state;
  if (state.notesMode) {
    if ((state.values[state.selected] as number) !== 0) return state;
    const notes = [...state.notes];
    notes[state.selected] = (notes[state.selected] as number) ^ (1 << digit);
    return changedState(state, { notes: Object.freeze(notes) });
  }
  if (state.values[state.selected] === digit && state.notes[state.selected] === 0) return state;
  const values = [...state.values];
  const notes = [...state.notes];
  const hinted = [...state.hinted];
  values[state.selected] = digit;
  notes[state.selected] = 0;
  hinted[state.selected] = false;
  for (const peer of sudokuPeers(state.selected))
    notes[peer] = (notes[peer] as number) & ~(1 << digit);
  return changedState(state, {
    values: Object.freeze(values),
    notes: Object.freeze(notes),
    hinted: Object.freeze(hinted),
  });
}

function erase(state: SudokuState): SudokuState {
  if (state.status === "won" || sudokuGivenValues(state)[state.selected] !== 0) return state;
  if (state.values[state.selected] === 0 && state.notes[state.selected] === 0) return state;
  const values = [...state.values];
  const notes = [...state.notes];
  const hinted = [...state.hinted];
  values[state.selected] = 0;
  notes[state.selected] = 0;
  hinted[state.selected] = false;
  return changedState(state, {
    values: Object.freeze(values),
    notes: Object.freeze(notes),
    hinted: Object.freeze(hinted),
  });
}

function hint(state: SudokuState): SudokuState {
  if (state.status === "won") return state;
  const index = state.values.indexOf(0);
  if (index < 0) return state;
  const values = [...state.values];
  const notes = [...state.notes];
  const hinted = [...state.hinted];
  const digit = sudokuSolution(state)[index] as number;
  values[index] = digit;
  notes[index] = 0;
  hinted[index] = true;
  for (const peer of sudokuPeers(index)) notes[peer] = (notes[peer] as number) & ~(1 << digit);
  return changedState(state, {
    values: Object.freeze(values),
    notes: Object.freeze(notes),
    hinted: Object.freeze(hinted),
    selected: index,
    hintCount: state.hintCount + 1,
  });
}

export function reduceSudoku(state: SudokuState, action: SudokuAction): SudokuState {
  if (action.type === "restart") return createSudoku(action.difficulty, action.seed);
  if (action.type === "move") return move(state, action.direction);
  if (action.type === "select") {
    return Number.isSafeInteger(action.index) &&
      action.index >= 0 &&
      action.index < SUDOKU_CELLS &&
      action.index !== state.selected
      ? freezeState({ ...state, selected: action.index })
      : state;
  }
  if (action.type === "toggle-notes")
    return state.status === "won" ? state : freezeState({ ...state, notesMode: !state.notesMode });
  if (action.type === "digit") return enterDigit(state, action.digit);
  if (action.type === "erase") return erase(state);
  if (action.type === "hint") return hint(state);
  const previous = state.history.at(-1);
  if (previous === undefined) return state;
  return freezeState({
    ...state,
    ...previous,
    history: state.history.slice(0, -1),
  });
}

export function restoreSudoku(
  input: Omit<SudokuState, "algorithmVersion" | "selectionVersion" | "fixtureSetRevision">,
): SudokuState {
  const state = freezeState({
    algorithmVersion: 1,
    selectionVersion: 1,
    fixtureSetRevision: SUDOKU_FIXTURE_SET_REVISION,
    ...input,
  });
  validateSudokuState(state);
  return state;
}

function validateSnapshot(
  value: SudokuSnapshot,
  givens: readonly number[],
  solution: readonly number[],
  label: string,
): void {
  if (value.values.length !== 81 || value.notes.length !== 81 || value.hinted.length !== 81)
    throw new Error(`${label} board length is invalid`);
  if (!value.values.every((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9))
    throw new Error(`${label} values are invalid`);
  if (
    !value.notes.every(
      (notes) => Number.isInteger(notes) && notes >= 0 && (notes & ~SUDOKU_ALL_NOTES) === 0,
    )
  )
    throw new Error(`${label} notes are invalid`);
  if (!value.hinted.every((hinted) => typeof hinted === "boolean"))
    throw new Error(`${label} hint markers are invalid`);
  if (!Number.isSafeInteger(value.selected) || value.selected < 0 || value.selected >= 81)
    throw new Error(`${label} selection is invalid`);
  if (
    typeof value.notesMode !== "boolean" ||
    !Number.isSafeInteger(value.hintCount) ||
    value.hintCount < 0
  )
    throw new Error(`${label} mode or hint count is invalid`);
  if (value.status !== "active" && value.status !== "won")
    throw new Error(`${label} status is invalid`);
  for (let index = 0; index < 81; index += 1) {
    if (givens[index] !== 0 && value.values[index] !== givens[index])
      throw new Error(`${label} changes a given cell`);
    if (value.values[index] !== 0 && value.notes[index] !== 0)
      throw new Error(`${label} stores notes under a filled cell`);
    if (
      value.hinted[index] &&
      (givens[index] !== 0 || value.values[index] === 0 || value.values[index] !== solution[index])
    )
      throw new Error(`${label} hint marker is inconsistent`);
  }
  const expectedStatus = completed(value.values, solution) ? "won" : "active";
  if (value.status !== expectedStatus) throw new Error(`${label} completion state is inconsistent`);
}

export function validateSudokuState(state: SudokuState): void {
  const fixture = sudokuFixture(state.fixtureId);
  if (
    state.fixtureSetRevision !== SUDOKU_FIXTURE_SET_REVISION ||
    state.algorithmVersion !== 1 ||
    state.selectionVersion !== 1
  )
    throw new Error("Sudoku version is unsupported");
  if (state.difficulty !== fixture.difficulty)
    throw new Error("Sudoku difficulty does not match fixture");
  const givens = fixtureDigits(fixture.puzzle);
  const solution = fixtureDigits(fixture.solution);
  validateSnapshot(state, givens, solution, "Sudoku state");
  if (state.history.length > MAX_UNDO) throw new Error("Sudoku undo history is oversized");
  for (const [index, prior] of state.history.entries())
    validateSnapshot(prior, givens, solution, `Sudoku history[${index}]`);
  const hintedCount = state.hinted.filter(Boolean).length;
  if (state.hintCount < hintedCount) throw new Error("Sudoku hint count is inconsistent");
}

export { SUDOKU_FIXTURES, SUDOKU_FIXTURE_SET_REVISION, type SudokuDifficulty, type SudokuFixture };
