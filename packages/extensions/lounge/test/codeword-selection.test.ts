// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEWORD_DAILY_SELECTION_VERSION,
  CODEWORD_DICTIONARY_REVISION,
  CODEWORD_PRACTICE_SELECTION_VERSION,
  createCodewordGame,
  createDailyCodeword,
  createPracticeCodeword,
} from "../src/index.ts";

test("daily selection is reproducible from an explicit UTC date", () => {
  const vectors = [
    ["1970-01-01", "knots"],
    ["2026-09-13", "idles"],
    ["2026-12-31", "tiers"],
    ["2027-01-01", "truth"],
  ] as const;
  for (const [utcDate, answer] of vectors) {
    const first = createDailyCodeword(utcDate);
    const second = createDailyCodeword(utcDate);
    assert.equal(first.answer, answer);
    assert.deepEqual(first, second);
    assert.equal(first.dictionaryRevision, CODEWORD_DICTIONARY_REVISION);
    assert.deepEqual(first.selection, {
      kind: "daily",
      algorithmVersion: CODEWORD_DAILY_SELECTION_VERSION,
      utcDate,
    });
  }
});

test("practice selection is reproducible for signed safe-integer seeds", () => {
  const vectors = [
    [0, "needy"],
    [1, "quiet"],
    [-1, "stand"],
    [42, "bowed"],
    [6699, "apple"],
    [Number.MAX_SAFE_INTEGER, "fused"],
  ] as const;
  for (const [seed, answer] of vectors) {
    const first = createPracticeCodeword(seed);
    assert.equal(first.answer, answer);
    assert.deepEqual(first, createPracticeCodeword(seed));
    assert.deepEqual(first.selection, {
      kind: "practice",
      algorithmVersion: CODEWORD_PRACTICE_SELECTION_VERSION,
      seed,
    });
  }
});

test("daily selection validates calendar dates without reading the clock", () => {
  for (const value of ["2026-2-03", "2026-02-30", "1969-12-31", "10000-01-01", "today"]) {
    assert.throws(() => createDailyCodeword(value), /UTC puzzle date/);
  }
  assert.equal(createDailyCodeword("2028-02-29").selection.kind, "daily");
});

test("selection and reducers do not consult ambient clock or randomness", (context) => {
  context.mock.method(Date, "now", () => {
    throw new Error("ambient clock used");
  });
  context.mock.method(Math, "random", () => {
    throw new Error("ambient randomness used");
  });
  assert.equal(createDailyCodeword("2026-09-13").answer, "idles");
  assert.equal(createPracticeCodeword(42).answer, "bowed");
});

test("unsupported selection algorithm versions fail loudly", () => {
  assert.throws(
    () =>
      createCodewordGame({
        kind: "daily",
        algorithmVersion: 2,
        utcDate: "2026-09-13",
      } as never),
    /Unsupported daily selection version 2/,
  );
  assert.throws(
    () => createCodewordGame({ kind: "practice", algorithmVersion: 2, seed: 1 } as never),
    /Unsupported practice selection version 2/,
  );
});
