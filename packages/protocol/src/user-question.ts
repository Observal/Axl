// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { type JsonObject, type JsonValue, ProtocolValidationError } from "./event-envelope.ts";

export const ASK_USER_QUESTION_LIMITS = {
  questions: 4,
  options: 4,
  header: 16,
  question: 2_000,
  label: 60,
  description: 2_000,
  preview: 12_000,
  customAnswer: 4_000,
} as const;

export interface UserQuestionOption extends JsonObject {
  readonly label: string;
  readonly description: string;
  readonly preview?: string;
}

export interface UserQuestion extends JsonObject {
  readonly header: string;
  readonly question: string;
  readonly options: readonly UserQuestionOption[];
  readonly multiSelect?: boolean;
}

export interface UserQuestionRequest extends JsonObject {
  readonly questions: readonly UserQuestion[];
}

export interface UserQuestionAnswer extends JsonObject {
  readonly questionIndex: number;
  readonly selectedLabels: readonly string[];
  readonly customAnswer?: string;
}

export interface UserQuestionResponse extends JsonObject {
  readonly answers: readonly UserQuestionAnswer[];
}

function fail(path: string, message: string): never {
  throw new ProtocolValidationError(path, message);
}

function object(value: JsonValue | undefined, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as JsonObject;
}

function exact(
  value: JsonObject,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) fail(`${path}.${key}`, "is not allowed");
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "is required");
}

function text(
  value: JsonValue | undefined,
  path: string,
  maxLength: number,
  requireTrimmed = true,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    (requireTrimmed && value.trim() !== value)
  ) {
    fail(path, requireTrimmed ? "must be non-empty trimmed text" : "must be non-empty text");
  }
  if (value.length > maxLength) fail(path, `must contain at most ${maxLength} characters`);
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127 ||
      /\p{Cf}/u.test(character)
    ) {
      fail(path, "must not contain unsafe control characters");
    }
  }
  return value;
}

function list(
  value: JsonValue | undefined,
  path: string,
  minimum: number,
  maximum: number,
): readonly JsonValue[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(path, `must contain between ${minimum} and ${maximum} items`);
  }
  return value;
}

export function parseUserQuestionRequest(value: unknown, path = "questions"): UserQuestionRequest {
  const input = object(value as JsonValue, path);
  exact(input, path, ["questions"]);
  const seenQuestions = new Set<string>();
  const questions = list(
    input.questions,
    `${path}.questions`,
    1,
    ASK_USER_QUESTION_LIMITS.questions,
  ).map((entry, questionIndex) => {
    const questionPath = `${path}.questions[${questionIndex}]`;
    const item = object(entry, questionPath);
    exact(item, questionPath, ["header", "question", "options"], ["multiSelect"]);
    const header = text(item.header, `${questionPath}.header`, ASK_USER_QUESTION_LIMITS.header);
    const question = text(
      item.question,
      `${questionPath}.question`,
      ASK_USER_QUESTION_LIMITS.question,
    );
    const questionKey = question.toLowerCase();
    if (seenQuestions.has(questionKey)) fail(`${questionPath}.question`, "must be unique");
    seenQuestions.add(questionKey);
    if (item.multiSelect !== undefined && typeof item.multiSelect !== "boolean") {
      fail(`${questionPath}.multiSelect`, "must be a boolean");
    }
    const seenLabels = new Set<string>();
    const options = list(
      item.options,
      `${questionPath}.options`,
      2,
      ASK_USER_QUESTION_LIMITS.options,
    ).map((entry, optionIndex) => {
      const optionPath = `${questionPath}.options[${optionIndex}]`;
      const option = object(entry, optionPath);
      exact(option, optionPath, ["label", "description"], ["preview"]);
      const label = text(option.label, `${optionPath}.label`, ASK_USER_QUESTION_LIMITS.label);
      const labelKey = label.toLowerCase();
      if (["other", "type something.", "next"].includes(labelKey))
        fail(`${optionPath}.label`, "is reserved");
      if (seenLabels.has(labelKey))
        fail(`${optionPath}.label`, "must be unique within the question");
      seenLabels.add(labelKey);
      const description = text(
        option.description,
        `${optionPath}.description`,
        ASK_USER_QUESTION_LIMITS.description,
      );
      const preview =
        option.preview === undefined
          ? undefined
          : text(option.preview, `${optionPath}.preview`, ASK_USER_QUESTION_LIMITS.preview, false);
      if (item.multiSelect === true && preview !== undefined)
        fail(`${optionPath}.preview`, "is only supported for single-select questions");
      return { label, description, ...(preview === undefined ? {} : { preview }) };
    });
    return {
      header,
      question,
      options,
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
    };
  });
  return { questions };
}

export function parseUserQuestionResponse(
  value: unknown,
  request: UserQuestionRequest,
  path = "response",
): UserQuestionResponse {
  const input = object(value as JsonValue, path);
  exact(input, path, ["answers"]);
  const answers = list(
    input.answers,
    `${path}.answers`,
    request.questions.length,
    request.questions.length,
  ).map((entry, answerIndex) => {
    const answerPath = `${path}.answers[${answerIndex}]`;
    const answer = object(entry, answerPath);
    exact(answer, answerPath, ["questionIndex", "selectedLabels"], ["customAnswer"]);
    if (!Number.isSafeInteger(answer.questionIndex) || answer.questionIndex !== answerIndex) {
      fail(`${answerPath}.questionIndex`, `must equal ${answerIndex}`);
    }
    const question = request.questions[answerIndex];
    if (question === undefined) fail(`${answerPath}.questionIndex`, "does not identify a question");
    if (!Array.isArray(answer.selectedLabels))
      fail(`${answerPath}.selectedLabels`, "must be an array");
    const allowed = new Set(question.options.map((option) => option.label));
    const selectedLabels = answer.selectedLabels.map((label, labelIndex) => {
      if (typeof label !== "string" || !allowed.has(label))
        fail(`${answerPath}.selectedLabels[${labelIndex}]`, "must match an offered option");
      return label;
    });
    if (new Set(selectedLabels).size !== selectedLabels.length)
      fail(`${answerPath}.selectedLabels`, "must not contain duplicates");
    const customAnswer =
      answer.customAnswer === undefined
        ? undefined
        : text(
            answer.customAnswer,
            `${answerPath}.customAnswer`,
            ASK_USER_QUESTION_LIMITS.customAnswer,
          );
    if (question.multiSelect !== true && selectedLabels.length > 1)
      fail(`${answerPath}.selectedLabels`, "must contain at most one option");
    if (question.multiSelect !== true && selectedLabels.length === 1 && customAnswer !== undefined)
      fail(answerPath, "cannot contain both an option and a custom answer");
    if (selectedLabels.length === 0 && customAnswer === undefined)
      fail(answerPath, "must contain an option or a custom answer");
    return {
      questionIndex: answerIndex,
      selectedLabels,
      ...(customAnswer === undefined ? {} : { customAnswer }),
    };
  });
  return { answers };
}
