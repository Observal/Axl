// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROVENANCE_PATH = resolve(PACKAGE_ROOT, "data/sudoku/provenance.json");
const TARGET_PATH = resolve(PACKAGE_ROOT, "src/sudoku-fixtures.generated.ts");
const CHECK_FLAG = `-${"-"}check`;
const FULL_MASK = 0x3fe;

type Difficulty = "easy" | "medium" | "hard";

interface FixtureSpec {
  readonly id: string;
  readonly difficulty: Difficulty;
  readonly seed: number;
  readonly puzzleSha256: string;
  readonly solutionSha256: string;
}

interface Provenance {
  readonly schemaVersion: number;
  readonly fixtureSetRevision: string;
  readonly generatorAlgorithmVersion: number;
  readonly solverAlgorithmVersion: number;
  readonly difficultyAlgorithmVersion: number;
  readonly fixtures: readonly FixtureSpec[];
}

interface Rating {
  readonly nakedSingles: number;
  readonly hiddenSingles: number;
  readonly decisionCount: number;
  readonly maximumDecisionDepth: number;
}

interface GeneratedFixture extends FixtureSpec {
  readonly puzzle: string;
  readonly solution: string;
  readonly clueCount: number;
  readonly rating: Rating;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nextRandom(state: number): number {
  let next = state >>> 0;
  if (next === 0) next = 0x9e3779b9;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

function shuffle<T>(values: readonly T[], initialState: number): readonly [readonly T[], number] {
  const result = [...values];
  let state = initialState;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = nextRandom(state);
    const selected = Math.floor((state / 0x1_0000_0000) * (index + 1));
    [result[index], result[selected]] = [result[selected] as T, result[index] as T];
  }
  return [result, state] as const;
}

function solvedGrid(seed: number): readonly [readonly number[], number] {
  let state = seed >>> 0;
  if (state === 0) state = 1;
  let digits: readonly number[];
  [digits, state] = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9], state);
  const bandsResult = shuffle([0, 1, 2], state);
  const bands = bandsResult[0];
  state = bandsResult[1];
  const stacksResult = shuffle([0, 1, 2], state);
  const stacks = stacksResult[0];
  state = stacksResult[1];
  const rowsWithin: Array<readonly number[]> = [];
  const columnsWithin: Array<readonly number[]> = [];
  for (let index = 0; index < 3; index += 1) {
    let order: readonly number[];
    [order, state] = shuffle([0, 1, 2], state);
    rowsWithin.push(order);
    [order, state] = shuffle([0, 1, 2], state);
    columnsWithin.push(order);
  }
  state = nextRandom(state);
  const transpose = (state & 1) === 1;
  const rows = bands.flatMap((band) =>
    (rowsWithin[band] as readonly number[]).map((row) => band * 3 + row),
  );
  const columns = stacks.flatMap((stack) =>
    (columnsWithin[stack] as readonly number[]).map((column) => stack * 3 + column),
  );
  const result: number[] = [];
  for (let row = 0; row < 9; row += 1) {
    for (let column = 0; column < 9; column += 1) {
      const sourceRow = transpose ? (columns[column] as number) : (rows[row] as number);
      const sourceColumn = transpose ? (rows[row] as number) : (columns[column] as number);
      result.push(digits[(sourceRow * 3 + Math.floor(sourceRow / 3) + sourceColumn) % 9] as number);
    }
  }
  return [Object.freeze(result), state] as const;
}

function bitCount(value: number): number {
  let remaining = value;
  let count = 0;
  while (remaining !== 0) {
    remaining &= remaining - 1;
    count += 1;
  }
  return count;
}

function solutionCount(input: readonly number[]): {
  readonly count: 0 | 1 | 2;
  readonly solution?: readonly number[];
} {
  const board = [...input];
  const rows = Array<number>(9).fill(0);
  const columns = Array<number>(9).fill(0);
  const boxes = Array<number>(9).fill(0);
  for (let index = 0; index < 81; index += 1) {
    const digit = board[index] as number;
    if (digit === 0) continue;
    const row = Math.floor(index / 9);
    const column = index % 9;
    const box = Math.floor(row / 3) * 3 + Math.floor(column / 3);
    const bit = 1 << digit;
    if (((rows[row] as number) | (columns[column] as number) | (boxes[box] as number)) & bit)
      return { count: 0 };
    rows[row] = (rows[row] as number) | bit;
    columns[column] = (columns[column] as number) | bit;
    boxes[box] = (boxes[box] as number) | bit;
  }
  let count: 0 | 1 | 2 = 0;
  let solution: readonly number[] | undefined;
  const search = (): void => {
    if (count === 2) return;
    let selected = -1;
    let selectedMask = 0;
    let selectedCount = 10;
    for (let index = 0; index < 81; index += 1) {
      if (board[index] !== 0) continue;
      const row = Math.floor(index / 9);
      const column = index % 9;
      const box = Math.floor(row / 3) * 3 + Math.floor(column / 3);
      const mask =
        FULL_MASK & ~((rows[row] as number) | (columns[column] as number) | (boxes[box] as number));
      const candidates = bitCount(mask);
      if (candidates === 0) return;
      if (candidates < selectedCount) {
        selected = index;
        selectedMask = mask;
        selectedCount = candidates;
        if (candidates === 1) break;
      }
    }
    if (selected < 0) {
      count = count === 0 ? 1 : 2;
      solution ??= Object.freeze([...board]);
      return;
    }
    const row = Math.floor(selected / 9);
    const column = selected % 9;
    const box = Math.floor(row / 3) * 3 + Math.floor(column / 3);
    for (let digit = 1; digit <= 9; digit += 1) {
      const bit = 1 << digit;
      if ((selectedMask & bit) === 0) continue;
      board[selected] = digit;
      rows[row] = (rows[row] as number) | bit;
      columns[column] = (columns[column] as number) | bit;
      boxes[box] = (boxes[box] as number) | bit;
      search();
      rows[row] = (rows[row] as number) ^ bit;
      columns[column] = (columns[column] as number) ^ bit;
      boxes[box] = (boxes[box] as number) ^ bit;
      board[selected] = 0;
      if ((count as number) === 2) return;
    }
  };
  search();
  return { count, ...(solution === undefined ? {} : { solution }) };
}

function candidateMask(board: readonly number[], index: number): number {
  const row = Math.floor(index / 9);
  const column = index % 9;
  let used = 0;
  for (let offset = 0; offset < 9; offset += 1) {
    used |= 1 << (board[row * 9 + offset] as number);
    used |= 1 << (board[offset * 9 + column] as number);
  }
  const boxRow = Math.floor(row / 3) * 3;
  const boxColumn = Math.floor(column / 3) * 3;
  for (let boxRowOffset = 0; boxRowOffset < 3; boxRowOffset += 1) {
    for (let boxColumnOffset = 0; boxColumnOffset < 3; boxColumnOffset += 1) {
      used |= 1 << (board[(boxRow + boxRowOffset) * 9 + boxColumn + boxColumnOffset] as number);
    }
  }
  return FULL_MASK & ~used;
}

function ratePuzzle(input: readonly number[]): Rating {
  let board = [...input];
  let nakedSingles = 0;
  let hiddenSingles = 0;
  let decisionCount = 0;
  let maximumDecisionDepth = 0;
  const solve = (depth: number): boolean => {
    while (true) {
      let placed = false;
      for (let index = 0; index < 81; index += 1) {
        if (board[index] !== 0) continue;
        const mask = candidateMask(board, index);
        if (bitCount(mask) === 1) {
          board[index] = Math.log2(mask);
          nakedSingles += 1;
          placed = true;
          break;
        }
      }
      if (placed) continue;
      hidden: for (let kind = 0; kind < 3; kind += 1) {
        for (let unit = 0; unit < 9; unit += 1) {
          for (let digit = 1; digit <= 9; digit += 1) {
            const bit = 1 << digit;
            let found = -1;
            let occurrences = 0;
            for (let position = 0; position < 9; position += 1) {
              const row =
                kind === 0
                  ? unit
                  : kind === 1
                    ? position
                    : Math.floor(unit / 3) * 3 + Math.floor(position / 3);
              const column =
                kind === 0 ? position : kind === 1 ? unit : (unit % 3) * 3 + (position % 3);
              const index = row * 9 + column;
              if (board[index] === 0 && (candidateMask(board, index) & bit) !== 0) {
                occurrences += 1;
                found = index;
              }
            }
            if (occurrences === 1) {
              board[found] = digit;
              hiddenSingles += 1;
              placed = true;
              break hidden;
            }
          }
        }
      }
      if (!placed) break;
    }
    if (board.every((digit) => digit !== 0)) return true;
    let selected = -1;
    let selectedMask = 0;
    let selectedCount = 10;
    for (let index = 0; index < 81; index += 1) {
      if (board[index] !== 0) continue;
      const mask = candidateMask(board, index);
      const count = bitCount(mask);
      if (count === 0) return false;
      if (count < selectedCount) {
        selected = index;
        selectedMask = mask;
        selectedCount = count;
      }
    }
    const snapshot = [...board];
    decisionCount += 1;
    maximumDecisionDepth = Math.max(maximumDecisionDepth, depth + 1);
    for (let digit = 1; digit <= 9; digit += 1) {
      if ((selectedMask & (1 << digit)) === 0) continue;
      board = [...snapshot];
      board[selected] = digit;
      if (solve(depth + 1)) return true;
    }
    board = snapshot;
    return false;
  };
  if (!solve(0)) throw new Error("Difficulty rater could not solve a unique puzzle");
  return Object.freeze({ nakedSingles, hiddenSingles, decisionCount, maximumDecisionDepth });
}

function matchesDifficulty(difficulty: Difficulty, clueCount: number, rating: Rating): boolean {
  if (difficulty === "easy")
    return (
      clueCount >= 38 && clueCount <= 45 && rating.decisionCount === 0 && rating.hiddenSingles === 0
    );
  if (difficulty === "medium")
    return (
      clueCount >= 32 && clueCount <= 39 && rating.decisionCount === 0 && rating.hiddenSingles > 0
    );
  return clueCount >= 24 && clueCount <= 32 && rating.decisionCount > 0;
}

function generateFixture(spec: FixtureSpec): GeneratedFixture {
  const [solution, state] = solvedGrid(spec.seed);
  const [order] = shuffle(
    Array.from({ length: 81 }, (_, index) => index),
    state,
  );
  const board = [...solution];
  for (const index of order) {
    const previous = board[index] as number;
    board[index] = 0;
    const counted = solutionCount(board);
    if (counted.count !== 1) {
      board[index] = previous;
      continue;
    }
    if (counted.solution?.some((digit, solutionIndex) => digit !== solution[solutionIndex]))
      throw new Error(`${spec.id} uniqueness solution differs from its generated solution`);
    const clueCount = board.filter((digit) => digit !== 0).length;
    const rating = ratePuzzle(board);
    if (!matchesDifficulty(spec.difficulty, clueCount, rating)) continue;
    const puzzleText = board.join("");
    const solutionText = solution.join("");
    if (sha256(puzzleText) !== spec.puzzleSha256)
      throw new Error(`${spec.id} puzzle checksum does not match provenance`);
    if (sha256(solutionText) !== spec.solutionSha256)
      throw new Error(`${spec.id} solution checksum does not match provenance`);
    return Object.freeze({
      ...spec,
      puzzle: puzzleText,
      solution: solutionText,
      clueCount,
      rating,
    });
  }
  throw new Error(`${spec.id} seed did not produce its reviewed difficulty`);
}

function generatedSource(): string {
  const provenanceText = readFileSync(PROVENANCE_PATH, "utf8");
  const provenance = JSON.parse(provenanceText) as Provenance;
  if (!provenanceText.endsWith("\n") || provenanceText.includes("\r"))
    throw new Error("Sudoku provenance must be LF-terminated JSON");
  if (
    provenance.schemaVersion !== 1 ||
    provenance.generatorAlgorithmVersion !== 1 ||
    provenance.solverAlgorithmVersion !== 1 ||
    provenance.difficultyAlgorithmVersion !== 1 ||
    provenance.fixtureSetRevision !== "axl-sudoku-v1"
  )
    throw new Error("Unsupported Sudoku provenance version");
  if (provenance.fixtures.length !== 12) throw new Error("Sudoku v1 must contain 12 fixtures");
  const ids = new Set<string>();
  const fixtures = provenance.fixtures.map((fixture) => {
    if (ids.has(fixture.id)) throw new Error(`Duplicate Sudoku fixture ${fixture.id}`);
    ids.add(fixture.id);
    return generateFixture(fixture);
  });
  const records = fixtures
    .map(
      (fixture) =>
        `  Object.freeze({\n    id: ${JSON.stringify(fixture.id)},\n    fixtureSetRevision: ${JSON.stringify(provenance.fixtureSetRevision)},\n    difficulty: ${JSON.stringify(fixture.difficulty)},\n    puzzle: ${JSON.stringify(fixture.puzzle)},\n    solution: ${JSON.stringify(fixture.solution)},\n    clueCount: ${fixture.clueCount},\n    rating: Object.freeze({\n      nakedSingles: ${fixture.rating.nakedSingles},\n      hiddenSingles: ${fixture.rating.hiddenSingles},\n      decisionCount: ${fixture.rating.decisionCount},\n      maximumDecisionDepth: ${fixture.rating.maximumDecisionDepth},\n    }),\n  }),`,
    )
    .join("\n");
  return `// SPDX-FileCopyrightText: 2026 Kaushik Kumar\n// SPDX-License-Identifier: Apache-2.0\n// @generated by packages/extensions/lounge/scripts/generate-sudoku-fixtures.ts; do not edit.\n\nexport const SUDOKU_FIXTURE_SET_REVISION = ${JSON.stringify(provenance.fixtureSetRevision)} as const;\n\nexport type SudokuDifficulty = "easy" | "medium" | "hard";\n\nexport interface SudokuFixture {\n  readonly id: string;\n  readonly fixtureSetRevision: typeof SUDOKU_FIXTURE_SET_REVISION;\n  readonly difficulty: SudokuDifficulty;\n  readonly puzzle: string;\n  readonly solution: string;\n  readonly clueCount: number;\n  readonly rating: {\n    readonly nakedSingles: number;\n    readonly hiddenSingles: number;\n    readonly decisionCount: number;\n    readonly maximumDecisionDepth: number;\n  };\n}\n\nexport const SUDOKU_FIXTURES: readonly SudokuFixture[] = Object.freeze([\n${records}\n]);\n`;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const source = generatedSource();
  if (process.argv[2] === CHECK_FLAG) {
    const target = resolve(process.cwd(), process.argv[3] ?? TARGET_PATH);
    if (target !== TARGET_PATH)
      throw new Error(`No Sudoku fixture output exists for ${relative(process.cwd(), target)}`);
    if (readFileSync(target, "utf8") !== source) process.exitCode = 1;
  } else {
    writeFileSync(TARGET_PATH, source);
  }
}
