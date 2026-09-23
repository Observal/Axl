// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CODEWORD_ACCEPTED_GUESSES,
  CODEWORD_ANSWERS,
  CODEWORD_DICTIONARY_REVISION,
} from "../src/index.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provenance = JSON.parse(
  readFileSync(resolve(packageRoot, "data/codeword/provenance.json"), "utf8"),
) as {
  readonly dictionaryRevision: string;
  readonly review: {
    readonly excludedFromAcceptedGuesses: readonly string[];
    readonly excludedFromAnswersOnly: readonly string[];
  };
  readonly files: {
    readonly answers: { readonly count: number; readonly sha256: string };
    readonly acceptedGuesses: { readonly count: number; readonly sha256: string };
  };
};

function source(words: readonly string[]): string {
  return `${words.join("\n")}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertDictionary(words: readonly string[]): void {
  let previous: string | undefined;
  for (const word of words) {
    assert.match(word, /^[a-z]{5}$/u);
    if (previous !== undefined) assert.ok(previous < word);
    previous = word;
  }
  assert.equal(new Set(words).size, words.length);
  assert.equal(Object.isFrozen(words), true);
}

test("dictionary revision, counts, ordering, and checksums match provenance", () => {
  assert.equal(CODEWORD_DICTIONARY_REVISION, "esdb-2026.02.25-axl-codeword-v1");
  assert.equal(provenance.dictionaryRevision, CODEWORD_DICTIONARY_REVISION);
  assertDictionary(CODEWORD_ANSWERS);
  assertDictionary(CODEWORD_ACCEPTED_GUESSES);
  assert.equal(CODEWORD_ANSWERS.length, provenance.files.answers.count);
  assert.equal(CODEWORD_ACCEPTED_GUESSES.length, provenance.files.acceptedGuesses.count);
  assert.equal(sha256(source(CODEWORD_ANSWERS)), provenance.files.answers.sha256);
  assert.equal(sha256(source(CODEWORD_ACCEPTED_GUESSES)), provenance.files.acceptedGuesses.sha256);
});

test("every answer is accepted and reviewed exclusions remain absent", () => {
  const answers = new Set<string>(CODEWORD_ANSWERS);
  const accepted = new Set<string>(CODEWORD_ACCEPTED_GUESSES);
  for (const answer of answers) assert.ok(accepted.has(answer), answer);
  for (const excluded of provenance.review.excludedFromAcceptedGuesses) {
    assert.equal(accepted.has(excluded), false, excluded);
    assert.equal(answers.has(excluded), false, excluded);
  }
  for (const excluded of provenance.review.excludedFromAnswersOnly) {
    assert.equal(answers.has(excluded), false, excluded);
    assert.equal(accepted.has(excluded), true, excluded);
  }
});
