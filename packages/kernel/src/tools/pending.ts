// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import {
  ASK_USER_QUESTION_LIMITS,
  type InteractionAction,
  type JsonObject,
  parseUserQuestionRequest,
  parseUserQuestionResponse,
  type UserQuestionRequest,
  type UserQuestionResponse,
} from "@axl/protocol";
import type { KernelTool } from "../tools.ts";
import { ToolInputError } from "./validate.ts";

export interface AskUserQuestionInteraction {
  readonly kind: "user_question";
  readonly source: "ask_user_question";
  readonly message: string;
  readonly data: UserQuestionRequest;
}

export type AskUserQuestionResponder = (
  request: AskUserQuestionInteraction,
  signal?: AbortSignal,
) => Promise<{ readonly action: InteractionAction; readonly content?: JsonObject }>;

function questionInput(input: JsonObject): UserQuestionRequest {
  try {
    return parseUserQuestionRequest(input, "ask_user_question");
  } catch (error) {
    throw new ToolInputError(error instanceof Error ? error.message : "Invalid questionnaire");
  }
}

export function makeAskUserQuestionTool(interact: AskUserQuestionResponder): KernelTool {
  return {
    name: "ask_user_question",
    description:
      "Ask the user one or more structured questions before continuing. Use multiSelect when several answers may apply. Users can always provide a custom answer.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: ASK_USER_QUESTION_LIMITS.questions,
          items: {
            type: "object",
            properties: {
              header: { type: "string", minLength: 1, maxLength: ASK_USER_QUESTION_LIMITS.header },
              question: {
                type: "string",
                minLength: 1,
                maxLength: ASK_USER_QUESTION_LIMITS.question,
              },
              options: {
                type: "array",
                minItems: 2,
                maxItems: ASK_USER_QUESTION_LIMITS.options,
                items: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      minLength: 1,
                      maxLength: ASK_USER_QUESTION_LIMITS.label,
                    },
                    description: {
                      type: "string",
                      minLength: 1,
                      maxLength: ASK_USER_QUESTION_LIMITS.description,
                    },
                    preview: {
                      type: "string",
                      minLength: 1,
                      maxLength: ASK_USER_QUESTION_LIMITS.preview,
                    },
                  },
                  required: ["label", "description"],
                  additionalProperties: false,
                },
              },
              multiSelect: { type: "boolean" },
            },
            required: ["header", "question", "options"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
    async execute(input, signal) {
      const request = questionInput(input);
      const response = await interact(
        {
          kind: "user_question",
          source: "ask_user_question",
          message: request.questions.map((question) => question.question).join("\n"),
          data: request,
        },
        signal,
      );
      if (response.action !== "accept") {
        return {
          content: [
            {
              type: "text",
              text: `The user ${response.action === "decline" ? "declined" : "cancelled"} the questionnaire.`,
            },
          ],
          isError: false,
          details: { action: response.action },
        };
      }
      let parsed: UserQuestionResponse;
      try {
        parsed = parseUserQuestionResponse(response.content, request);
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : "Invalid questionnaire response");
      }
      const lines = parsed.answers.map((answer) => {
        const question = request.questions[answer.questionIndex];
        const values = [
          ...answer.selectedLabels,
          ...(answer.customAnswer === undefined ? [] : [answer.customAnswer]),
        ];
        return `${question?.question ?? `Question ${answer.questionIndex + 1}`}\n${values.join(", ")}`;
      });
      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        isError: false,
        details: parsed,
      };
    },
  };
}

export function makeCapabilitySearchTool(): KernelTool {
  return {
    name: "capability_search",
    description:
      "Search for optional authorized capabilities needed for a task. Not implemented yet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute() {
      throw new Error("capability_search is not implemented");
    },
  };
}
