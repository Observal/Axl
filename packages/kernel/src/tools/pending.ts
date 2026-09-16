// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import {
  ASK_USER_QUESTION_LIMITS,
  CAPABILITY_LIMITS,
  type CapabilitySearchToolInput,
  type InteractionAction,
  type JsonObject,
  parseCapabilitySearchToolInput,
  parseUserQuestionRequest,
  parseUserQuestionResponse,
  type UserQuestionRequest,
  type UserQuestionResponse,
} from "@axl/protocol";
import type { CapabilityService } from "../capabilities.ts";
import type { KernelTool, SessionToolEffect } from "../tools.ts";
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

function capabilityInput(input: JsonObject): CapabilitySearchToolInput {
  try {
    return parseCapabilitySearchToolInput(input);
  } catch (error) {
    throw new ToolInputError(error instanceof Error ? error.message : "Invalid capability request");
  }
}

export function makeCompactContextTool(
  compact: (instructions?: string) => Promise<unknown>,
): KernelTool {
  return {
    name: "compact_context",
    description: "Queue canonical context compaction behind the active response.",
    inputSchema: {
      type: "object",
      properties: { instructions: { type: "string", minLength: 1, maxLength: 8_192 } },
      additionalProperties: false,
    },
    async execute(input, signal) {
      for (const key of Object.keys(input)) {
        if (key !== "instructions")
          throw new ToolInputError(`compact_context.${key} is not allowed`);
      }
      const instructions = input.instructions;
      if (
        instructions !== undefined &&
        (typeof instructions !== "string" || !instructions.trim())
      ) {
        throw new ToolInputError("compact_context.instructions must be a non-empty string");
      }
      signal.throwIfAborted();
      const result = await compact(instructions?.trim());
      signal.throwIfAborted();
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: false,
      };
    },
  };
}

export function makeReloadContextTool(reload: () => Promise<unknown>): KernelTool {
  return {
    name: "reload_context",
    description:
      "Queue rediscovery of project instructions, Skills, and tools after this response.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute(input, signal) {
      if (Object.keys(input).length > 0)
        throw new ToolInputError("reload_context accepts no input");
      signal.throwIfAborted();
      const result = await reload();
      signal.throwIfAborted();
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: false,
      };
    },
  };
}

export function makeCapabilitySearchTool(service: CapabilityService): KernelTool {
  return {
    name: "capability_search",
    description:
      "Search for optional authorized Skills or tools, activate selected results for the rest of the session, and read resources from active capabilities. Search before answering requests for abilities not already exposed, especially user-interface slash commands, and never pass slash commands to bash.",
    inputSchema: {
      type: "object",
      oneOf: [
        {
          properties: {
            action: { type: "string", enum: ["search"] },
            query: { type: "string", minLength: 1, maxLength: CAPABILITY_LIMITS.queryBytes },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: CAPABILITY_LIMITS.searchResults,
            },
          },
          required: ["action", "query"],
          additionalProperties: false,
        },
        {
          properties: {
            action: { type: "string", enum: ["activate"] },
            identities: {
              type: "array",
              minItems: 1,
              maxItems: CAPABILITY_LIMITS.activations,
              uniqueItems: true,
              items: { type: "string", minLength: 1, maxLength: CAPABILITY_LIMITS.identityBytes },
            },
          },
          required: ["action", "identities"],
          additionalProperties: false,
        },
        {
          properties: {
            action: { type: "string", enum: ["read"] },
            identity: { type: "string", minLength: 1, maxLength: CAPABILITY_LIMITS.identityBytes },
            path: { type: "string", minLength: 1, maxLength: CAPABILITY_LIMITS.pathBytes },
          },
          required: ["action", "identity", "path"],
          additionalProperties: false,
        },
      ],
    },
    async execute(rawInput, signal, context) {
      const input = capabilityInput(rawInput);
      signal.throwIfAborted();
      if (input.action === "search") {
        const query = input.query.trim().replaceAll(/\s+/gu, " ");
        const limit = input.limit ?? 5;
        const result = await service.search(query, limit);
        signal.throwIfAborted();
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: false,
          sessionEffects: [{ type: "capability.searched", payload: { query, limit, ...result } }],
        };
      }

      if (input.action === "read") {
        if (!context?.activeCapabilities.has(input.identity)) {
          throw new ToolInputError(
            `Capability ${input.identity} is not active in this session. Call capability_search with action="activate" and identities=["${input.identity}"], then retry this capability read. Do not use filesystem read or bash on the Skill source path.`,
          );
        }
        const content = await service.read(input.identity, input.path);
        signal.throwIfAborted();
        return { content: [{ type: "text", text: content }], isError: false };
      }

      const result = await service.activate(input.identities);
      signal.throwIfAborted();
      const sessionEffects: SessionToolEffect[] = [
        ...result.activated.map(({ capability, content }) => ({
          type: "capability.activated" as const,
          payload: { capability, content },
        })),
        ...result.denied.map(({ identity, reason }) => ({
          type: "capability.denied" as const,
          payload: { identity, reason },
        })),
      ];
      const visible = {
        activated: result.activated.map(({ capability }) => capability),
        denied: result.denied,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(visible) }],
        isError: false,
        sessionEffects,
      };
    },
  };
}
