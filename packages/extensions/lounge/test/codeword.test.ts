// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEWORD_MAX_ATTEMPTS,
  type CodewordState,
  createPracticeCodeword,
  reduceCodeword,
  scoreCodewordGuess,
} from "../src/index.ts";

function enter(state: CodewordState, word: string): CodewordState {
  return [...word].reduce(
    (current, letter) => reduceCodeword(current, { type: "enter", letter }),
    state,
  );
}

function submit(state: CodewordState, word: string): CodewordState {
  return reduceCodeword(enter(state, word), { type: "submit" });
}

function words(alphabet: string, length: number): readonly string[] {
  if (length === 0) return [""];
  return words(alphabet, length - 1).flatMap((prefix) =>
    [...alphabet].map((letter) => `${prefix}${letter}`),
  );
}

function referenceScore(answer: string, guess: string): readonly string[] {
  const result = Array.from({ length: 5 }, () => "absent");
  const unusedAnswer: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    if (answer[index] === guess[index]) result[index] = "exact";
    else unusedAnswer.push(index);
  }
  for (let guessIndex = 0; guessIndex < 5; guessIndex += 1) {
    if (result[guessIndex] === "exact") continue;
    const answerOffset = unusedAnswer.findIndex(
      (answerIndex) => answer[answerIndex] === guess[guessIndex],
    );
    if (answerOffset >= 0) {
      result[guessIndex] = "present";
      unusedAnswer.splice(answerOffset, 1);
    }
  }
  return result;
}

test("scores exact, present, and absent letters with exact matches first", () => {
  assert.deepEqual(scoreCodewordGuess("crane", "crane"), [
    "exact",
    "exact",
    "exact",
    "exact",
    "exact",
  ]);
  assert.deepEqual(scoreCodewordGuess("crane", "react"), [
    "present",
    "present",
    "exact",
    "present",
    "absent",
  ]);
  assert.deepEqual(scoreCodewordGuess("apple", "allee"), [
    "exact",
    "present",
    "absent",
    "absent",
    "exact",
  ]);
  assert.deepEqual(scoreCodewordGuess("eerie", "epees"), [
    "exact",
    "absent",
    "present",
    "present",
    "absent",
  ]);
});

test("duplicate scoring agrees exhaustively with independent matching", () => {
  const cases = words("abc", 5);
  for (const answer of cases) {
    for (const guess of cases) {
      assert.deepEqual(scoreCodewordGuess(answer, guess), referenceScore(answer, guess));
    }
  }
});

test("entry, erase, incomplete, invalid, and full-row input are non-destructive", () => {
  const initial = createPracticeCodeword(6699);
  const oneLetter = reduceCodeword(initial, { type: "enter", letter: "A" });
  assert.equal(oneLetter.currentGuess, "a");
  assert.equal(initial.currentGuess, "");
  assert.equal(reduceCodeword(oneLetter, { type: "erase" }).currentGuess, "");

  const incomplete = reduceCodeword(oneLetter, { type: "submit" });
  assert.equal(incomplete.issue?.code, "incomplete-guess");
  assert.equal(incomplete.guesses.length, 0);
  const invalid = reduceCodeword(enter(initial, "zzzzz"), { type: "submit" });
  assert.equal(invalid.issue?.code, "invalid-guess");
  assert.equal(invalid.currentGuess, "zzzzz");
  assert.equal(
    reduceCodeword(initial, { type: "enter", letter: "ß" }).issue?.code,
    "invalid-letter",
  );
  assert.equal(
    reduceCodeword(initial, { type: "enter", letter: "ab" }).issue?.code,
    "invalid-letter",
  );
  assert.equal(
    reduceCodeword(enter(initial, "crane"), { type: "enter", letter: "s" }).issue?.code,
    "row-full",
  );
});

test("normal mode wins and stops after six unsuccessful attempts", () => {
  const initial = createPracticeCodeword(6699);
  assert.equal(initial.answer, "apple");
  const won = submit(initial, "apple");
  assert.equal(won.status, "won");
  assert.equal(won.guesses.length, 1);
  assert.equal(reduceCodeword(won, { type: "erase" }).issue?.code, "game-complete");

  let lost = initial;
  for (const guess of ["crane", "toils", "bumpy", "fudge", "sight", "known"]) {
    lost = submit(lost, guess);
  }
  assert.equal(lost.guesses.length, CODEWORD_MAX_ATTEMPTS);
  assert.equal(lost.status, "lost");
  assert.equal(reduceCodeword(lost, { type: "submit" }).issue?.code, "game-complete");
});

test("hard mode locks exact positions and proven minimum letter counts", () => {
  const apple = createPracticeCodeword(6699, "hard");
  const afterAllee = submit(apple, "allee");
  assert.deepEqual(afterAllee.guesses[0]?.score, ["exact", "present", "absent", "absent", "exact"]);
  const wrongPosition = submit(afterAllee, "lease");
  assert.deepEqual(wrongPosition.issue, { code: "hard-exact", letter: "a", position: 0 });

  const eerie = createPracticeCodeword(1917, "hard");
  const afterEpees = submit(eerie, "epees");
  const tooFew = submit(afterEpees, "erase");
  assert.deepEqual(tooFew.issue, {
    code: "hard-minimum",
    letter: "e",
    required: 3,
    actual: 2,
  });
});

test("hard mode does not infer unsupported maximum duplicate counts", () => {
  const initial = createPracticeCodeword(6699, "hard");
  const first = submit(initial, "allee");
  const repeated = submit(first, "allee");
  assert.equal(repeated.issue, undefined);
  assert.equal(repeated.guesses.length, 2);
});

test("reducers leave prior state deeply unchanged and freeze new state", () => {
  const initial = createPracticeCodeword(6699);
  const entered = enter(initial, "crane");
  const submitted = reduceCodeword(entered, { type: "submit" });
  assert.equal(initial.currentGuess, "");
  assert.deepEqual(initial.guesses, []);
  assert.equal(entered.currentGuess, "crane");
  assert.deepEqual(entered.guesses, []);
  assert.equal(Object.isFrozen(submitted), true);
  assert.equal(Object.isFrozen(submitted.selection), true);
  assert.equal(Object.isFrozen(submitted.guesses), true);
  assert.equal(Object.isFrozen(submitted.guesses[0]), true);
  assert.equal(Object.isFrozen(submitted.guesses[0]?.score), true);
});

test("restart creates a fresh deterministic game with explicit selection", () => {
  const played = submit(createPracticeCodeword(6699), "crane");
  const restarted = reduceCodeword(played, {
    type: "restart",
    selection: { kind: "practice", algorithmVersion: 1, seed: 42 },
    difficulty: "hard",
  });
  assert.equal(restarted.answer, "bowed");
  assert.equal(restarted.difficulty, "hard");
  assert.equal(restarted.status, "active");
  assert.equal(restarted.currentGuess, "");
  assert.deepEqual(restarted.guesses, []);
});

test("scoring and constructors reject malformed inputs", () => {
  assert.throws(() => scoreCodewordGuess("four", "crane"), /five lowercase ASCII letters/);
  assert.throws(() => scoreCodewordGuess("CRANE", "crane"), /five lowercase ASCII letters/);
  assert.throws(
    () => createPracticeCodeword(Number.POSITIVE_INFINITY),
    /Practice seed must be a safe integer/,
  );
});
