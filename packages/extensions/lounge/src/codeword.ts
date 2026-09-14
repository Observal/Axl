// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  CODEWORD_ACCEPTED_GUESSES,
  CODEWORD_ANSWERS,
  CODEWORD_DICTIONARY_REVISION,
} from "./codeword-dictionary.generated.ts";

export const CODEWORD_LENGTH = 5;
export const CODEWORD_MAX_ATTEMPTS = 6;
export const CODEWORD_DAILY_SELECTION_VERSION = 1;
export const CODEWORD_PRACTICE_SELECTION_VERSION = 1;

export type CodewordScore = "exact" | "present" | "absent";
export type CodewordDifficulty = "normal" | "hard";
export type CodewordStatus = "active" | "won" | "lost";

export type CodewordSelection =
  | {
      readonly kind: "daily";
      readonly algorithmVersion: typeof CODEWORD_DAILY_SELECTION_VERSION;
      readonly utcDate: string;
    }
  | {
      readonly kind: "practice";
      readonly algorithmVersion: typeof CODEWORD_PRACTICE_SELECTION_VERSION;
      readonly seed: number;
    };

export interface CodewordSubmittedGuess {
  readonly word: string;
  readonly score: readonly CodewordScore[];
}

export type CodewordIssue =
  | { readonly code: "invalid-letter" }
  | { readonly code: "row-full" }
  | { readonly code: "incomplete-guess" }
  | { readonly code: "invalid-guess" }
  | { readonly code: "game-complete" }
  | { readonly code: "hard-exact"; readonly letter: string; readonly position: number }
  | {
      readonly code: "hard-minimum";
      readonly letter: string;
      readonly required: number;
      readonly actual: number;
    };

export interface CodewordState {
  readonly dictionaryRevision: typeof CODEWORD_DICTIONARY_REVISION;
  readonly selection: CodewordSelection;
  readonly difficulty: CodewordDifficulty;
  readonly answer: string;
  readonly currentGuess: string;
  readonly guesses: readonly CodewordSubmittedGuess[];
  readonly status: CodewordStatus;
  readonly issue?: CodewordIssue;
}

export type CodewordAction =
  | { readonly type: "enter"; readonly letter: string }
  | { readonly type: "erase" }
  | { readonly type: "submit" }
  | {
      readonly type: "restart";
      readonly selection: CodewordSelection;
      readonly difficulty?: CodewordDifficulty;
    };

const WORD = /^[a-z]{5}$/u;
const LETTER = /^[a-z]$/u;
const acceptedGuesses = new Set<string>(CODEWORD_ACCEPTED_GUESSES);

function assertWord(word: string, label: string): void {
  if (!WORD.test(word)) throw new TypeError(`${label} must be five lowercase ASCII letters`);
}

function freezeSelection(selection: CodewordSelection): CodewordSelection {
  return Object.freeze({ ...selection });
}

function freezeIssue(issue: CodewordIssue): CodewordIssue {
  return Object.freeze({ ...issue });
}

function freezeState(state: CodewordState): CodewordState {
  const { issue, ...rest } = state;
  const guesses = Object.freeze(
    state.guesses.map((guess) =>
      Object.freeze({ word: guess.word, score: Object.freeze([...guess.score]) }),
    ),
  );
  return Object.freeze({
    ...rest,
    selection: freezeSelection(state.selection),
    guesses,
    ...(issue === undefined ? {} : { issue: freezeIssue(issue) }),
  });
}

function withIssue(state: CodewordState, issue: CodewordIssue): CodewordState {
  return freezeState({ ...state, issue });
}

function clearIssue(state: CodewordState): Omit<CodewordState, "issue"> {
  const { issue: _issue, ...rest } = state;
  return rest;
}

/** Scores exact positions before consuming remaining answer-letter counts. */
export function scoreCodewordGuess(answer: string, guess: string): readonly CodewordScore[] {
  assertWord(answer, "Answer");
  assertWord(guess, "Guess");
  const score: CodewordScore[] = Array.from({ length: CODEWORD_LENGTH }, () => "absent");
  const remaining = new Map<string, number>();

  for (let index = 0; index < CODEWORD_LENGTH; index += 1) {
    const answerLetter = answer[index] as string;
    if (guess[index] === answerLetter) score[index] = "exact";
    else remaining.set(answerLetter, (remaining.get(answerLetter) ?? 0) + 1);
  }
  for (let index = 0; index < CODEWORD_LENGTH; index += 1) {
    if (score[index] === "exact") continue;
    const letter = guess[index] as string;
    const count = remaining.get(letter) ?? 0;
    if (count > 0) {
      score[index] = "present";
      remaining.set(letter, count - 1);
    }
  }
  return Object.freeze(score);
}

function validateUtcDate(utcDate: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(utcDate);
  if (!match) throw new TypeError("UTC puzzle date must use YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    year < 1970 ||
    year > 9999 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new TypeError("UTC puzzle date is invalid");
  }
}

function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function answerForSelection(selection: CodewordSelection): string {
  if (selection.kind === "daily") {
    if (selection.algorithmVersion !== CODEWORD_DAILY_SELECTION_VERSION) {
      throw new RangeError(`Unsupported daily selection version ${selection.algorithmVersion}`);
    }
    validateUtcDate(selection.utcDate);
    const key = `daily:${selection.algorithmVersion}:${CODEWORD_DICTIONARY_REVISION}:${selection.utcDate}`;
    return CODEWORD_ANSWERS[hash32(key) % CODEWORD_ANSWERS.length] as string;
  }
  if (selection.algorithmVersion !== CODEWORD_PRACTICE_SELECTION_VERSION) {
    throw new RangeError(`Unsupported practice selection version ${selection.algorithmVersion}`);
  }
  if (!Number.isSafeInteger(selection.seed)) {
    throw new TypeError("Practice seed must be a safe integer");
  }
  const key = `practice:${selection.algorithmVersion}:${CODEWORD_DICTIONARY_REVISION}:${selection.seed}`;
  return CODEWORD_ANSWERS[hash32(key) % CODEWORD_ANSWERS.length] as string;
}

export function createCodewordGame(
  selection: CodewordSelection,
  difficulty: CodewordDifficulty = "normal",
): CodewordState {
  if (difficulty !== "normal" && difficulty !== "hard") {
    throw new TypeError("Codeword difficulty must be normal or hard");
  }
  return freezeState({
    dictionaryRevision: CODEWORD_DICTIONARY_REVISION,
    selection,
    difficulty,
    answer: answerForSelection(selection),
    currentGuess: "",
    guesses: [],
    status: "active",
  });
}

export function createDailyCodeword(
  utcDate: string,
  difficulty: CodewordDifficulty = "normal",
): CodewordState {
  return createCodewordGame(
    { kind: "daily", algorithmVersion: CODEWORD_DAILY_SELECTION_VERSION, utcDate },
    difficulty,
  );
}

export function createPracticeCodeword(
  seed: number,
  difficulty: CodewordDifficulty = "normal",
): CodewordState {
  return createCodewordGame(
    { kind: "practice", algorithmVersion: CODEWORD_PRACTICE_SELECTION_VERSION, seed },
    difficulty,
  );
}

function hardModeIssue(state: CodewordState, guess: string): CodewordIssue | undefined {
  const exactByPosition = new Map<number, string>();
  const minimumByLetter = new Map<string, number>();
  for (const submitted of state.guesses) {
    const establishedThisRow = new Map<string, number>();
    for (let index = 0; index < CODEWORD_LENGTH; index += 1) {
      const result = submitted.score[index];
      const letter = submitted.word[index] as string;
      if (result === "exact") exactByPosition.set(index, letter);
      if (result === "exact" || result === "present") {
        establishedThisRow.set(letter, (establishedThisRow.get(letter) ?? 0) + 1);
      }
    }
    for (const [letter, count] of establishedThisRow) {
      minimumByLetter.set(letter, Math.max(minimumByLetter.get(letter) ?? 0, count));
    }
  }
  for (const [position, letter] of exactByPosition) {
    if (guess[position] !== letter) {
      return { code: "hard-exact", letter, position };
    }
  }
  for (const [letter, required] of [...minimumByLetter].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const actual = [...guess].filter((candidate) => candidate === letter).length;
    if (actual < required) return { code: "hard-minimum", letter, required, actual };
  }
  return undefined;
}

export function reduceCodeword(state: CodewordState, action: CodewordAction): CodewordState {
  if (action.type === "restart") {
    return createCodewordGame(action.selection, action.difficulty ?? state.difficulty);
  }
  if (state.status !== "active") return withIssue(state, { code: "game-complete" });

  if (action.type === "enter") {
    const letter = action.letter.toLowerCase();
    if (!LETTER.test(letter) || [...action.letter].length !== 1) {
      return withIssue(state, { code: "invalid-letter" });
    }
    if (state.currentGuess.length === CODEWORD_LENGTH) {
      return withIssue(state, { code: "row-full" });
    }
    return freezeState({ ...clearIssue(state), currentGuess: `${state.currentGuess}${letter}` });
  }

  if (action.type === "erase") {
    return freezeState({ ...clearIssue(state), currentGuess: state.currentGuess.slice(0, -1) });
  }

  if (state.currentGuess.length !== CODEWORD_LENGTH) {
    return withIssue(state, { code: "incomplete-guess" });
  }
  if (!acceptedGuesses.has(state.currentGuess)) {
    return withIssue(state, { code: "invalid-guess" });
  }
  if (state.difficulty === "hard") {
    const issue = hardModeIssue(state, state.currentGuess);
    if (issue !== undefined) return withIssue(state, issue);
  }

  const submitted = Object.freeze({
    word: state.currentGuess,
    score: scoreCodewordGuess(state.answer, state.currentGuess),
  });
  const guesses = [...state.guesses, submitted];
  const status: CodewordStatus =
    state.currentGuess === state.answer
      ? "won"
      : guesses.length === CODEWORD_MAX_ATTEMPTS
        ? "lost"
        : "active";
  return freezeState({
    ...clearIssue(state),
    currentGuess: "",
    guesses,
    status,
  });
}

export {
  CODEWORD_ACCEPTED_GUESSES,
  CODEWORD_ANSWERS,
  CODEWORD_DICTIONARY_REVISION,
} from "./codeword-dictionary.generated.ts";
