// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SUDOKU_FIXTURES, SUDOKU_FIXTURE_SET_REVISION } from "../src/index.ts";

function independentSolutionCount(puzzle: string): number {
  const board = [...puzzle].map(Number);
  let count = 0;
  const valid = (index: number, digit: number): boolean => {
    const row = Math.floor(index / 9);
    const column = index % 9;
    for (let offset = 0; offset < 9; offset += 1) {
      if (board[row * 9 + offset] === digit || board[offset * 9 + column] === digit) return false;
    }
    const boxRow = Math.floor(row / 3) * 3;
    const boxColumn = Math.floor(column / 3) * 3;
    for (let rowOffset = 0; rowOffset < 3; rowOffset += 1)
      for (let columnOffset = 0; columnOffset < 3; columnOffset += 1)
        if (board[(boxRow + rowOffset) * 9 + boxColumn + columnOffset] === digit) return false;
    return true;
  };
  const search = (): void => {
    if (count >= 2) return;
    const index = board.indexOf(0);
    if (index < 0) {
      count += 1;
      return;
    }
    for (let digit = 1; digit <= 9; digit += 1) {
      if (!valid(index, digit)) continue;
      board[index] = digit;
      search();
      board[index] = 0;
      if (count >= 2) return;
    }
  };
  search();
  return count;
}

function validSolution(solution: string): boolean {
  const expected = "123456789";
  const units: string[] = [];
  for (let row = 0; row < 9; row += 1)
    units.push([...solution.slice(row * 9, row * 9 + 9)].sort().join(""));
  for (let column = 0; column < 9; column += 1)
    units.push(
      Array.from({ length: 9 }, (_, row) => solution[row * 9 + column])
        .sort()
        .join(""),
    );
  for (let box = 0; box < 9; box += 1) {
    const startRow = Math.floor(box / 3) * 3;
    const startColumn = (box % 3) * 3;
    units.push(
      Array.from(
        { length: 9 },
        (_, offset) =>
          solution[(startRow + Math.floor(offset / 3)) * 9 + startColumn + (offset % 3)],
      )
        .sort()
        .join(""),
    );
  }
  return units.every((unit) => unit === expected);
}

test("Sudoku fixtures match canonical provenance and generated output", () => {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const path = resolve(packageRoot, "data/sudoku/provenance.json");
  const source = readFileSync(path, "utf8");
  const provenance = JSON.parse(source) as {
    fixtureSetRevision: string;
    origin: { externalPuzzleData: boolean; license: string };
    fixtures: Array<{ id: string; puzzleSha256: string; solutionSha256: string }>;
  };
  assert.ok(source.endsWith("\n"));
  assert.equal(source.includes("\r"), false);
  assert.equal(provenance.fixtureSetRevision, SUDOKU_FIXTURE_SET_REVISION);
  assert.equal(provenance.origin.externalPuzzleData, false);
  assert.equal(provenance.origin.license, "Apache-2.0");
  assert.equal(SUDOKU_FIXTURES.length, 12);
  execFileSync(process.execPath, [
    resolve(packageRoot, "scripts/generate-sudoku-fixtures.ts"),
    "--check",
    resolve(packageRoot, "src/sudoku-fixtures.generated.ts"),
  ]);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  for (const fixture of SUDOKU_FIXTURES) {
    const recorded = provenance.fixtures.find(({ id }) => id === fixture.id);
    assert.ok(recorded);
    assert.equal(hash(fixture.puzzle), recorded.puzzleSha256);
    assert.equal(hash(fixture.solution), recorded.solutionSha256);
  }
});

test("every shipped Sudoku puzzle has exactly one independently verified solution", () => {
  for (const fixture of SUDOKU_FIXTURES) {
    assert.match(fixture.puzzle, /^[0-9]{81}$/u);
    assert.match(fixture.solution, /^[1-9]{81}$/u);
    assert.equal(independentSolutionCount(fixture.puzzle), 1, fixture.id);
    assert.equal(validSolution(fixture.solution), true, fixture.id);
    for (let index = 0; index < 81; index += 1)
      if (fixture.puzzle[index] !== "0")
        assert.equal(fixture.puzzle[index], fixture.solution[index], fixture.id);
  }
});

test("difficulty metadata obeys the versioned deterministic grading contract", () => {
  assert.deepEqual(
    SUDOKU_FIXTURES.map(({ difficulty }) => difficulty),
    [
      "easy",
      "easy",
      "easy",
      "easy",
      "medium",
      "medium",
      "medium",
      "medium",
      "hard",
      "hard",
      "hard",
      "hard",
    ],
  );
  for (const fixture of SUDOKU_FIXTURES) {
    if (fixture.difficulty === "easy") {
      assert.ok(fixture.clueCount >= 38 && fixture.clueCount <= 45);
      assert.equal(fixture.rating.hiddenSingles, 0);
      assert.equal(fixture.rating.decisionCount, 0);
    } else if (fixture.difficulty === "medium") {
      assert.ok(fixture.clueCount >= 32 && fixture.clueCount <= 39);
      assert.ok(fixture.rating.hiddenSingles > 0);
      assert.equal(fixture.rating.decisionCount, 0);
    } else {
      assert.ok(fixture.clueCount >= 24 && fixture.clueCount <= 32);
      assert.ok(fixture.rating.decisionCount > 0);
    }
  }
});
