// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { KernelTool } from "../tools.ts";

export function makeAskUserQuestionTool(): KernelTool {
  return {
    name: "ask_user_question",
    description:
      "Ask the user one or more structured questions before continuing. Not implemented yet.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              header: { type: "string" },
              question: { type: "string" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    description: { type: "string" },
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
    async execute() {
      throw new Error("ask_user_question is not implemented");
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
