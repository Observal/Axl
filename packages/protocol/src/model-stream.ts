// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { JsonObject } from "./event-envelope.ts";
import type {
  AssistantContent,
  AssistantStopReason,
  ThinkingLevel,
  Usage,
  UserContent,
} from "./events.ts";

export interface ModelThinkingSupport {
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: Readonly<Partial<Record<ThinkingLevel, string | null>>>;
}

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function supportedThinkingLevels(model: ModelThinkingSupport): readonly ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export interface ToolCallRequest {
  readonly callId: string;
  readonly name: string;
  readonly input: JsonObject;
}

export type ModelMessage =
  | { readonly role: "user"; readonly content: readonly UserContent[] }
  | {
      readonly role: "assistant";
      readonly content: readonly AssistantContent[];
      readonly toolCalls?: readonly ToolCallRequest[];
    }
  | {
      readonly role: "tool";
      readonly callId: string;
      readonly name: string;
      readonly content: readonly UserContent[];
      readonly isError: boolean;
    };

export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface ModelStreamError {
  readonly code: string;
  readonly message: string;
  /** True only when re-dispatching the identical request is known to be safe. */
  readonly retryable: boolean;
}

/**
 * Canonical model stream shape. Every stream yields zero or more deltas and
 * tool calls, then exactly one terminal event: `completed`, `error`, or
 * `aborted`. Nothing follows a terminal event.
 */
export type ModelStreamEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "thinking_delta"; readonly text: string }
  | ({ readonly type: "tool_call" } & ToolCallRequest)
  | { readonly type: "completed"; readonly stopReason: AssistantStopReason; readonly usage: Usage }
  | ({ readonly type: "error" } & ModelStreamError)
  | { readonly type: "aborted" };

export type TerminalModelStreamEvent = Extract<
  ModelStreamEvent,
  { type: "completed" | "error" | "aborted" }
>;

export function isTerminalModelStreamEvent(
  event: ModelStreamEvent,
): event is TerminalModelStreamEvent {
  return event.type === "completed" || event.type === "error" || event.type === "aborted";
}
