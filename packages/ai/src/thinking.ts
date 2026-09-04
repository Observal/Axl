// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

// Axl-native thinking-level selection, clamping, and token-budget policy.

import { supportedThinkingLevels, THINKING_LEVELS, type ThinkingLevel } from "@axl/protocol";

import type { ModelInfo } from "./model.ts";

export { supportedThinkingLevels, THINKING_LEVELS };

/** Exactly the payload of a `config.thinking` event, so clamping is always loggable. */
export interface ThinkingClamp {
  readonly requested: ThinkingLevel;
  readonly effective: ThinkingLevel;
  readonly clamped: boolean;
}

/**
 * Visible clamping: an unsupported request moves to the nearest stronger
 * supported level, then the nearest weaker one. The result is the
 * `config.thinking` payload the session logs on every thinking change.
 */
export function clampThinkingLevel(model: ModelInfo, requested: ThinkingLevel): ThinkingClamp {
  const supported = supportedThinkingLevels(model);
  if (supported.includes(requested)) {
    return { requested, effective: requested, clamped: false };
  }
  const requestedIndex = THINKING_LEVELS.indexOf(requested);
  for (let index = requestedIndex + 1; index < THINKING_LEVELS.length; index += 1) {
    const candidate = THINKING_LEVELS[index] as ThinkingLevel;
    if (supported.includes(candidate)) {
      return { requested, effective: candidate, clamped: true };
    }
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVELS[index] as ThinkingLevel;
    if (supported.includes(candidate)) {
      return { requested, effective: candidate, clamped: true };
    }
  }
  return { requested, effective: supported[0] ?? "off", clamped: true };
}

/** Token budgets per thinking level, for providers that reason by token budget. */
export interface ThinkingBudgets {
  readonly minimal?: number;
  readonly low?: number;
  readonly medium?: number;
  readonly high?: number;
}

export const DEFAULT_THINKING_BUDGETS: Required<ThinkingBudgets> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
};

/** Tokens always reserved for the answer when thinking shares the output ceiling. */
export const MIN_ANSWER_TOKENS = 1024;

/** Budget for a level; `xhigh` and `max` use the `high` budget on token-budget providers. */
export function thinkingBudgetForLevel(
  level: Exclude<ThinkingLevel, "off">,
  budgets?: ThinkingBudgets,
): number {
  const merged = { ...DEFAULT_THINKING_BUDGETS, ...budgets };
  const folded = level === "xhigh" || level === "max" ? "high" : level;
  return merged[folded];
}

export interface FittedThinkingBudget {
  /** The output ceiling to request: answer plus thinking, capped by the model. */
  readonly maxTokens: number;
  /** The thinking budget to request, always leaving answer room. */
  readonly thinkingBudget: number;
}

/**
 * Fits a thinking budget under the model's output limit while reserving answer
 * space. Without an explicit caller cap the model limit is the ceiling; with
 * one, the ceiling grows by the thinking budget up to the model limit. If the
 * budget would consume the ceiling, it is cut so at least MIN_ANSWER_TOKENS
 * remain for the answer.
 */
export function fitThinkingBudget(input: {
  readonly level: ThinkingLevel;
  readonly modelMaxTokens: number;
  readonly requestedMaxTokens?: number;
  readonly budgets?: ThinkingBudgets;
}): FittedThinkingBudget {
  const { level, modelMaxTokens, requestedMaxTokens, budgets } = input;
  if (level === "off") {
    return {
      maxTokens: Math.min(requestedMaxTokens ?? modelMaxTokens, modelMaxTokens),
      thinkingBudget: 0,
    };
  }
  let thinkingBudget = thinkingBudgetForLevel(level, budgets);
  const maxTokens =
    requestedMaxTokens === undefined
      ? modelMaxTokens
      : Math.min(requestedMaxTokens + thinkingBudget, modelMaxTokens);
  if (maxTokens <= thinkingBudget) {
    thinkingBudget = Math.min(thinkingBudget, Math.max(0, maxTokens - MIN_ANSWER_TOKENS));
  }
  return { maxTokens, thinkingBudget };
}
