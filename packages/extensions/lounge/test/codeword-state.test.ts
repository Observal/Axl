// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue } from "@axl/extension-api";

import {
  CODEWORD_DICTIONARY_REVISION,
  CodewordSaveError,
  type CodewordState,
  codewordSaveJson,
  codewordStatistics,
  createDailyCodeword,
  createEmptyCodewordSave,
  createPracticeCodeword,
  mergeCodewordCompletions,
  parseCodewordSave,
  reduceCodeword,
  updateCodewordSave,
} from "../src/index.ts";

function submit(state: CodewordState, word: string): CodewordState {
  let next = state;
  for (const letter of word) next = reduceCodeword(next, { type: "enter", letter });
  return reduceCodeword(next, { type: "submit" });
}

function win(state: CodewordState): CodewordState {
  return submit(state, state.answer);
}

const dailyNormal = { puzzle: "daily", difficulty: "normal" } as const;
const practiceNormal = { puzzle: "practice", difficulty: "normal" } as const;

test("saved games restore the exact deterministic reducer state", () => {
  let state = createDailyCodeword("2026-09-13", "hard");
  state = submit(state, "crane");
  state = reduceCodeword(state, { type: "enter", letter: "i" });
  state = reduceCodeword(state, { type: "enter", letter: "d" });
  const saved = updateCodewordSave(createEmptyCodewordSave(), state, {
    puzzle: "daily",
    difficulty: "hard",
  }).document;
  const restored = parseCodewordSave(codewordSaveJson(saved));
  assert.deepEqual(restored.state, state);
  assert.equal(restored.completionRecorded, false);
  assert.deepEqual(restored.document.preferences, { puzzle: "daily", difficulty: "hard" });
});

test("completion accounting is idempotent and computes aggregate statistics", () => {
  const won = win(createPracticeCodeword(42));
  const first = updateCodewordSave(createEmptyCodewordSave(), won, practiceNormal);
  const repeated = updateCodewordSave(first.document, won, practiceNormal);
  assert.equal(first.completionAdded, true);
  assert.equal(repeated.completionAdded, false);
  assert.deepEqual(codewordStatistics(repeated.document), {
    played: 1,
    wins: 1,
    winRate: 100,
    currentStreak: 0,
    maximumStreak: 0,
    guessDistribution: [1, 0, 0, 0, 0, 0],
  });
});

test("daily streaks are UTC-based, order-independent, and ignore duplicate days", () => {
  let document = createEmptyCodewordSave();
  for (const date of ["2026-09-14", "2026-09-13", "2026-09-13", "2026-09-16"]) {
    const result = updateCodewordSave(document, win(createDailyCodeword(date)), dailyNormal);
    document = result.document;
  }
  assert.deepEqual(codewordStatistics(document), {
    played: 3,
    wins: 3,
    winRate: 100,
    currentStreak: 1,
    maximumStreak: 2,
    guessDistribution: [3, 0, 0, 0, 0, 0],
  });
});

test("a daily loss resets the current streak without changing the maximum", () => {
  let document = createEmptyCodewordSave();
  for (const date of ["2026-09-13", "2026-09-14"]) {
    document = updateCodewordSave(document, win(createDailyCodeword(date)), dailyNormal).document;
  }
  let loss = createDailyCodeword("2026-09-15");
  for (const guess of ["crane", "toils", "bumpy", "fudge", "sight", "known"]) {
    loss = submit(loss, guess);
  }
  document = updateCodewordSave(document, loss, dailyNormal).document;
  assert.equal(codewordStatistics(document).currentStreak, 0);
  assert.equal(codewordStatistics(document).maximumStreak, 2);
});

test("practice results do not alter daily streaks and losses do not enter guess distribution", () => {
  let document = updateCodewordSave(
    createEmptyCodewordSave(),
    win(createDailyCodeword("2026-09-13")),
    dailyNormal,
  ).document;
  document = updateCodewordSave(document, win(createPracticeCodeword(1)), practiceNormal).document;
  let loss = createPracticeCodeword(6699);
  for (const guess of ["crane", "toils", "bumpy", "fudge", "sight", "known"]) {
    loss = submit(loss, guess);
  }
  document = updateCodewordSave(document, loss, practiceNormal).document;
  assert.deepEqual(codewordStatistics(document), {
    played: 3,
    wins: 2,
    winRate: 67,
    currentStreak: 1,
    maximumStreak: 1,
    guessDistribution: [2, 0, 0, 0, 0, 0],
  });
});

test("completion merging is commutative and preserves the newer board", () => {
  const left = updateCodewordSave(
    createEmptyCodewordSave(),
    win(createPracticeCodeword(1)),
    practiceNormal,
  ).document;
  const right = updateCodewordSave(
    createEmptyCodewordSave(),
    win(createPracticeCodeword(42)),
    practiceNormal,
  ).document;
  const leftRight = mergeCodewordCompletions(left, right);
  const rightLeft = mergeCodewordCompletions(right, left);
  assert.deepEqual(codewordStatistics(leftRight), codewordStatistics(rightLeft));
  assert.deepEqual(leftRight.game, left.game);
  assert.deepEqual(rightLeft.game, right.game);
});

test("saved-state validation distinguishes future and incompatible data", () => {
  assert.throws(
    () => parseCodewordSave({ version: 2 } as JsonValue),
    (error: unknown) => error instanceof CodewordSaveError && error.code === "future-version",
  );
  const saved = updateCodewordSave(
    createEmptyCodewordSave(),
    createPracticeCodeword(1),
    practiceNormal,
  ).document;
  const incompatible = JSON.parse(JSON.stringify(saved)) as {
    game: { dictionaryRevision: string };
  };
  incompatible.game.dictionaryRevision = "other-revision";
  assert.throws(
    () => parseCodewordSave(incompatible as unknown as JsonValue),
    (error: unknown) => error instanceof CodewordSaveError && error.code === "dictionary-mismatch",
  );
  assert.equal(CODEWORD_DICTIONARY_REVISION, "esdb-2026.02.25-axl-codeword-v1");
});

test("malformed guesses and forged completion markers are rejected", () => {
  const saved = updateCodewordSave(
    createEmptyCodewordSave(),
    createPracticeCodeword(1),
    practiceNormal,
  ).document;
  const malformed = JSON.parse(JSON.stringify(saved)) as {
    game: { guesses: string[]; status: string; completionRecorded: boolean };
  };
  malformed.game.guesses = ["zzzzz"];
  assert.throws(
    () => parseCodewordSave(malformed as unknown as JsonValue),
    /game guess is invalid/,
  );

  const forged = JSON.parse(JSON.stringify(saved)) as {
    game: { completionRecorded: boolean };
  };
  forged.game.completionRecorded = true;
  assert.throws(
    () => parseCodewordSave(forged as unknown as JsonValue),
    /completion marker does not match/,
  );
});
