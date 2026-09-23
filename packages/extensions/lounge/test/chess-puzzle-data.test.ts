// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyChessMove, chessFen, chessStatus, parseChessFen } from "../src/chess.ts";
import {
  CHESS_PUZZLES,
  CHESS_PUZZLE_SET_REVISION,
  CHESS_PUZZLE_THEMES,
} from "../src/chess-puzzles.generated.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "../../..");
const EXPOSED_THEMES = [
  "fork",
  "pin",
  "skewer",
  "discoveredAttack",
  "deflection",
  "sacrifice",
  "promotion",
  "mate",
  "advancedPawn",
] as const;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseCsvLine(line: string): readonly string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] as string;
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += character;
    } else if (character === ",") {
      fields.push(field);
      field = "";
    } else if (character === '"' && field.length === 0) quoted = true;
    else field += character;
  }
  assert.equal(quoted, false);
  fields.push(field);
  return fields;
}

function csvRows(path: string): readonly (readonly string[])[] {
  const source = readFileSync(path, "utf8");
  assert.ok(source.endsWith("\n"));
  assert.equal(source.includes("\r"), false);
  return source.trimEnd().split("\n").map(parseCsvLine);
}

test("Chess puzzle artifacts match pinned provenance and generated output", () => {
  const provenancePath = resolve(PACKAGE_ROOT, "data/chess/provenance.json");
  const provenanceText = readFileSync(provenancePath, "utf8");
  const provenance = JSON.parse(provenanceText) as {
    puzzleSetRevision: string;
    upstream: { recordCount: number; archiveBytes: number; archiveSha256: string };
    license: { expression: string; legalTextPath: string; legalTextSha256: string };
    files: Record<string, { path: string; count: number; sha256: string }>;
    sourceIds: string[];
  };
  assert.ok(provenanceText.endsWith("\n"));
  assert.equal(provenanceText.includes("\r"), false);
  assert.equal(provenance.puzzleSetRevision, CHESS_PUZZLE_SET_REVISION);
  assert.equal(provenance.upstream.recordCount, 6_100_952);
  assert.equal(provenance.upstream.archiveBytes, 304_429_328);
  assert.equal(
    provenance.upstream.archiveSha256,
    "95fd454bec9efe8f940d5863d5db4c57474f281a865834997bd8cb5d6a149bb9",
  );
  assert.equal(provenance.license.expression, "CC0-1.0");
  const licenseText = readFileSync(
    resolve(REPOSITORY_ROOT, provenance.license.legalTextPath),
    "utf8",
  );
  assert.equal(hash(licenseText), provenance.license.legalTextSha256);
  for (const record of Object.values(provenance.files)) {
    const source = readFileSync(resolve(PACKAGE_ROOT, record.path), "utf8");
    assert.equal(hash(source), record.sha256, record.path);
    assert.equal(record.count, 1_000, record.path);
  }
  assert.deepEqual(
    provenance.sourceIds,
    CHESS_PUZZLES.map(({ id }) => id),
  );
  execFileSync(process.execPath, [
    resolve(PACKAGE_ROOT, "scripts/generate-chess-puzzles.ts"),
    "--check",
    resolve(PACKAGE_ROOT, "src/chess-puzzles.generated.ts"),
  ]);
});

test("Chess puzzle review manifest covers every retained record", () => {
  const puzzles = csvRows(resolve(PACKAGE_ROOT, "data/chess/puzzles.csv"));
  const review = csvRows(resolve(PACKAGE_ROOT, "data/chess/review.csv"));
  assert.deepEqual(puzzles[0], [
    "sourceId",
    "sourceFen",
    "setupMove",
    "playableFen",
    "solutionMoves",
    "rating",
    "difficulty",
    "popularity",
    "ratingDeviation",
    "numberOfPlays",
    "themes",
    "reviewStatus",
    "inclusionReason",
  ]);
  assert.deepEqual(review[0], [
    "sourceId",
    "difficulty",
    "primaryTheme",
    "reviewStatus",
    "legalSetup",
    "legalSolution",
    "lineEndsOnPlayerMove",
    "noPrematureTerminal",
    "uniquePositionAndLine",
    "qualityBounds",
    "inclusionReason",
  ]);
  assert.equal(puzzles.length, 1_001);
  assert.equal(review.length, 1_001);
  assert.deepEqual(
    puzzles.slice(1).map((row) => row[0]),
    review.slice(1).map((row) => row[0]),
  );
  for (const row of review.slice(1)) {
    assert.equal(row.length, 11);
    assert.equal(row[3], "approved");
    assert.deepEqual(row.slice(4, 10), ["true", "true", "true", "true", "true", "true"]);
    assert.ok((row[10] as string).startsWith("Approved "));
  }
  const retainedHeader = new Set(puzzles[0]);
  for (const excluded of ["GameUrl", "OpeningTags", "DailyDate", "player", "account"])
    assert.equal(retainedHeader.has(excluded), false);
});

test("every shipped Chess puzzle replays legally from its exact setup", () => {
  assert.equal(CHESS_PUZZLES.length, 1_000);
  const ids = new Set<string>();
  const positionLines = new Set<string>();
  for (const puzzle of CHESS_PUZZLES) {
    assert.equal(ids.has(puzzle.id), false, puzzle.id);
    ids.add(puzzle.id);
    let position = parseChessFen(puzzle.sourceFen);
    assert.equal(chessStatus(position), "active", puzzle.id);
    position = applyChessMove(position, puzzle.setupMove);
    assert.equal(chessFen(position), puzzle.playableFen, puzzle.id);
    assert.equal(puzzle.solutionMoves.length % 2, 1, puzzle.id);
    for (const [index, move] of puzzle.solutionMoves.entries()) {
      assert.equal(chessStatus(position), "active", `${puzzle.id} ply ${index + 1}`);
      position = applyChessMove(position, move);
    }
    const pair = `${puzzle.playableFen}\n${puzzle.solutionMoves.join(" ")}`;
    assert.equal(positionLines.has(pair), false, puzzle.id);
    positionLines.add(pair);
  }
});

test("difficulty quality and exposed theme pools meet the reviewed contract", () => {
  assert.deepEqual(
    CHESS_PUZZLE_THEMES.map(({ id }) => id),
    EXPOSED_THEMES,
  );
  assert.equal(
    CHESS_PUZZLE_THEMES.every(
      ({ label, description }) =>
        label.length > 0 && description.length >= 20 && description.endsWith("."),
    ),
    true,
  );
  const expectedCounts = { easy: 334, medium: 333, hard: 333 } as const;
  const ratingBounds = { easy: [800, 1399], medium: [1400, 1999], hard: [2000, 2600] } as const;
  for (const difficulty of ["easy", "medium", "hard"] as const) {
    const puzzles = CHESS_PUZZLES.filter((puzzle) => puzzle.difficulty === difficulty);
    assert.equal(puzzles.length, expectedCounts[difficulty]);
    const [minimumRating, maximumRating] = ratingBounds[difficulty];
    for (const puzzle of puzzles) {
      assert.ok(puzzle.rating >= minimumRating && puzzle.rating <= maximumRating, puzzle.id);
      assert.ok(puzzle.popularity >= 95, puzzle.id);
      assert.ok(puzzle.numberOfPlays >= 1_000, puzzle.id);
      assert.ok(puzzle.ratingDeviation <= 80, puzzle.id);
      assert.equal(puzzle.themes.includes("mateIn1"), false, puzzle.id);
      assert.ok([3, 5, 7].includes(puzzle.solutionMoves.length), puzzle.id);
    }
    for (const theme of EXPOSED_THEMES)
      assert.ok(
        puzzles.filter((puzzle) => puzzle.themes.includes(theme)).length >= 24,
        `${difficulty}/${theme}`,
      );
  }
});
