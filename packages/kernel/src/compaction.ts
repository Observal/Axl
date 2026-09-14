// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type {
  CanonicalEvent,
  CompactionSettings,
  EventId,
  ModelMessage,
  ModelRequestConfiguration,
  ModelStreamEvent,
  ToolCallRequest,
  Usage,
} from "@axl/protocol";
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateModelInputTokens,
  estimateModelMessageTokens,
} from "@axl/protocol";

export type { CompactionSettings } from "@axl/protocol";
export const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
export const DEFAULT_COMPACTION_RESERVE_TOKENS = DEFAULT_COMPACTION_SETTINGS.reserveTokens;

import type { ModelPort } from "./model-port.ts";
import { ReplayError } from "./replay.ts";

const TOOL_RESULT_MAX_CHARACTERS = 2_000;
const COMPACTION_SUMMARY_PREFIX =
  "Earlier conversation history was compacted into this continuation summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
const SUMMARIZATION_SYSTEM_PROMPT =
  "Summarize the supplied conversation for another assistant. Do not continue the conversation or answer its questions. Return only the requested continuation summary.";

interface ContextGroup {
  readonly message: ModelMessage;
  readonly eventIds: EventId[];
}

interface ProjectedContext {
  readonly previousCompaction?: CanonicalEvent<"context.compacted">;
  readonly groups: readonly ContextGroup[];
}

export interface CompactionPlan {
  readonly messagesToSummarize: readonly ModelMessage[];
  readonly turnPrefixMessages: readonly ModelMessage[];
  readonly previousSummary?: string;
  readonly replacedEventIds: readonly EventId[];
  readonly splitTurn: boolean;
  readonly readFiles: readonly string[];
  readonly modifiedFiles: readonly string[];
}

export interface CompactionSummary {
  readonly summary: string;
  readonly usage: Usage;
  readonly readFiles: readonly string[];
  readonly modifiedFiles: readonly string[];
}

export function shouldCompact(
  estimatedInputTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  return settings.enabled && estimatedInputTokens > contextWindow - settings.reserveTokens;
}

function replacementClosure(
  events: readonly CanonicalEvent[],
  compaction: CanonicalEvent<"context.compacted">,
): ReadonlySet<EventId> {
  const byId = new Map(events.map((event, index) => [event.id, { event, index }]));
  const compactionIndex = byId.get(compaction.id)?.index ?? -1;
  const hidden = new Set<EventId>();
  const pending = [...compaction.payload.replacedEventIds];
  while (pending.length > 0) {
    const id = pending.pop() as EventId;
    if (hidden.has(id)) continue;
    const found = byId.get(id);
    if (found === undefined || found.index >= compactionIndex) {
      throw new ReplayError(`Compaction ${compaction.id} replaces non-ancestor event ${id}`);
    }
    hidden.add(id);
    if (found.event.type === "context.compacted")
      pending.push(...found.event.payload.replacedEventIds);
  }
  return hidden;
}

function projectContext(events: readonly CanonicalEvent[]): ProjectedContext {
  const previousCompaction = events.findLast(
    (event): event is CanonicalEvent<"context.compacted"> => event.type === "context.compacted",
  );
  const hidden =
    previousCompaction === undefined
      ? new Set<EventId>()
      : replacementClosure(events, previousCompaction);
  const groups: Array<
    ContextGroup & { message: ModelMessage & { toolCalls?: ToolCallRequest[] } }
  > = [];
  let toolCallingAssistant: (typeof groups)[number] | undefined;

  for (const event of events) {
    if (event.type === "user.message") {
      toolCallingAssistant = undefined;
      groups.push({
        message: { role: "user", content: event.payload.content },
        eventIds: [event.id],
      });
    } else if (event.type === "user.shell") {
      toolCallingAssistant = undefined;
      if (!event.payload.excluded) {
        groups.push({
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: `[shell]\n$ ${event.payload.command}\n${event.payload.content
                  .filter((item) => item.type === "text")
                  .map((item) => item.text)
                  .join("")}`,
              },
            ],
          },
          eventIds: [event.id],
        });
      }
    } else if (event.type === "assistant.message") {
      toolCallingAssistant = {
        message: { role: "assistant", content: event.payload.content, toolCalls: [] },
        eventIds: [event.id],
      };
      groups.push(toolCallingAssistant);
    } else if (event.type === "tool.call") {
      if (toolCallingAssistant === undefined || toolCallingAssistant.message.role !== "assistant") {
        throw new ReplayError(`Tool call ${event.id} has no preceding assistant turn`);
      }
      toolCallingAssistant.message.toolCalls?.push({
        callId: event.payload.callId,
        name: event.payload.name === "shell" ? "bash" : event.payload.name,
        input: event.payload.input,
      });
      toolCallingAssistant.eventIds.push(event.id);
    } else if (event.type === "tool.result") {
      groups.push({
        message: {
          role: "tool",
          callId: event.payload.callId,
          name: event.payload.name === "shell" ? "bash" : event.payload.name,
          content: event.payload.content,
          isError: event.payload.isError,
        },
        eventIds: [event.id],
      });
    } else if (event.type === "context.injected") {
      toolCallingAssistant = undefined;
      groups.push({
        message: {
          role: "user",
          content: [{ type: "text", text: `[${event.payload.source}]\n${event.payload.content}` }],
        },
        eventIds: [event.id],
      });
    } else if (event.type === "context.compacted") toolCallingAssistant = undefined;
  }

  const visibleGroups: ContextGroup[] = [];
  let foundReplacement = false;
  for (const group of groups) {
    const hiddenCount = group.eventIds.filter((id) => hidden.has(id)).length;
    if (hiddenCount > 0 && hiddenCount < group.eventIds.length) {
      throw new ReplayError(
        `Compaction ${previousCompaction?.id ?? "<unknown>"} splits a model message group`,
      );
    }
    if (hiddenCount > 0) {
      if (visibleGroups.length > 0) {
        throw new ReplayError(
          `Compaction ${previousCompaction?.id ?? "<unknown>"} replaces a non-prefix message`,
        );
      }
      foundReplacement = true;
    } else visibleGroups.push(group);
  }
  if (previousCompaction !== undefined && !foundReplacement) {
    throw new ReplayError(`Compaction ${previousCompaction.id} replaces no model-visible events`);
  }
  return {
    ...(previousCompaction === undefined ? {} : { previousCompaction }),
    groups: visibleGroups,
  };
}

export function messagesFromCompactedLineage(
  events: readonly CanonicalEvent[],
): readonly ModelMessage[] {
  const projected = projectContext(events);
  return [
    ...(projected.previousCompaction === undefined
      ? []
      : [
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: `${COMPACTION_SUMMARY_PREFIX}${projected.previousCompaction.payload.summary}${COMPACTION_SUMMARY_SUFFIX}`,
              },
            ],
          },
        ]),
    ...projected.groups.flatMap((group) => {
      const message = group.message;
      return message.role === "assistant" &&
        message.content.length === 0 &&
        (message.toolCalls?.length ?? 0) === 0
        ? []
        : [message];
    }),
  ];
}

function fileLists(
  messages: readonly ModelMessage[],
  previous?: CanonicalEvent<"context.compacted">,
): { readFiles: string[]; modifiedFiles: string[] } {
  const read = new Set(previous?.payload.readFiles ?? []);
  const modified = new Set(previous?.payload.modifiedFiles ?? []);
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      const path = typeof call.input.path === "string" ? call.input.path : undefined;
      if (!path) continue;
      if (call.name === "read") read.add(path);
      else if (call.name === "write" || call.name === "edit") modified.add(path);
    }
  }
  for (const path of modified) read.delete(path);
  return { readFiles: [...read].sort(), modifiedFiles: [...modified].sort() };
}

export function prepareCompaction(
  events: readonly CanonicalEvent[],
  keepRecentTokens = DEFAULT_COMPACTION_KEEP_RECENT_TOKENS,
): CompactionPlan | undefined {
  if (!Number.isSafeInteger(keepRecentTokens) || keepRecentTokens < 1) {
    throw new TypeError("keepRecentTokens must be a positive safe integer");
  }
  if (events.at(-1)?.type === "context.compacted") return undefined;

  const projected = projectContext(events);
  let accumulated = 0;
  let crossedAt = -1;
  for (let index = projected.groups.length - 1; index >= 0; index -= 1) {
    const group = projected.groups[index];
    if (group === undefined) continue;
    accumulated += estimateModelMessageTokens(group.message);
    if (accumulated >= keepRecentTokens) {
      crossedAt = index;
      break;
    }
  }
  if (crossedAt < 0) return undefined;

  let firstKeptIndex = crossedAt;
  if (projected.groups[firstKeptIndex]?.message.role === "tool") {
    while (firstKeptIndex >= 0 && projected.groups[firstKeptIndex]?.message.role !== "assistant") {
      firstKeptIndex -= 1;
    }
  }
  if (firstKeptIndex <= 0) return undefined;

  const splitTurn = projected.groups[firstKeptIndex]?.message.role === "assistant";
  let turnStartIndex = firstKeptIndex;
  if (splitTurn) {
    for (let index = firstKeptIndex - 1; index >= 0; index -= 1) {
      if (projected.groups[index]?.message.role === "user") {
        turnStartIndex = index;
        break;
      }
    }
  }
  const historyEnd = splitTurn ? turnStartIndex : firstKeptIndex;
  const compacted = projected.groups.slice(0, firstKeptIndex);
  const { readFiles, modifiedFiles } = fileLists(
    compacted.map((group) => group.message),
    projected.previousCompaction,
  );
  return {
    messagesToSummarize: projected.groups.slice(0, historyEnd).map((group) => group.message),
    turnPrefixMessages: splitTurn
      ? projected.groups.slice(turnStartIndex, firstKeptIndex).map((group) => group.message)
      : [],
    ...(projected.previousCompaction === undefined
      ? {}
      : { previousSummary: projected.previousCompaction.payload.summary }),
    replacedEventIds: [
      ...(projected.previousCompaction === undefined ? [] : [projected.previousCompaction.id]),
      ...compacted.flatMap((group) => group.eventIds),
    ],
    splitTurn,
    readFiles,
    modifiedFiles,
  };
}

function contentText(
  content: readonly { readonly type: string; readonly text?: string }[],
): string {
  return content
    .map((item) =>
      item.type === "text" || item.type === "thinking"
        ? (item.text ?? "")
        : "[binary attachment omitted]",
    )
    .filter(Boolean)
    .join("\n");
}

function truncateToolResult(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARACTERS) return text;
  return `${text.slice(0, TOOL_RESULT_MAX_CHARACTERS)}\n\n[${text.length - TOOL_RESULT_MAX_CHARACTERS} characters omitted]`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

export function serializeCompactionMessages(messages: readonly ModelMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") parts.push(`[User]\n${contentText(message.content)}`);
    else if (message.role === "assistant") {
      const thinking = message.content
        .filter((item) => item.type === "thinking")
        .map((item) => item.text)
        .join("\n");
      const text = message.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      if (thinking) parts.push(`[Assistant thinking]\n${thinking}`);
      if (text) parts.push(`[Assistant]\n${text}`);
      if ((message.toolCalls?.length ?? 0) > 0) {
        parts.push(
          `[Assistant tool calls]\n${message.toolCalls?.map((call) => `${call.name}(${safeJson(call.input)})`).join("\n")}`,
        );
      }
    } else {
      parts.push(
        `[Tool result: ${message.name}${message.isError ? ", error" : ""}]\n${truncateToolResult(contentText(message.content))}`,
      );
    }
  }
  return parts.join("\n\n");
}

function summaryPrompt(plan: CompactionPlan, customInstructions?: string): string {
  const previous =
    plan.previousSummary === undefined
      ? ""
      : `\n\n<previous-summary>\n${plan.previousSummary}\n</previous-summary>`;
  const focus = customInstructions
    ? `\n\nAdditional focus from the user: ${customInstructions}`
    : "";
  return `<conversation>\n${serializeCompactionMessages(plan.messagesToSummarize)}\n</conversation>${previous}${focus}\n\nWrite a concise continuation summary using exactly these sections:\n\n## Goal\n## Constraints & Preferences\n## Progress\n### Done\n### In Progress\n### Blocked\n## Key Decisions\n## Next Steps\n## Critical Context\n\nPreserve exact file paths, function names, commands, and error messages needed to continue.`;
}

function turnPrefixPrompt(messages: readonly ModelMessage[]): string {
  return `<conversation>\n${serializeCompactionMessages(messages)}\n</conversation>\n\nThis is the prefix of a turn whose recent suffix remains in context. Summarize only what is needed to understand that suffix using exactly these sections:\n\n## Original Request\n## Early Progress\n## Context for Suffix`;
}

function addUsage(first: Usage, second: Usage): Usage {
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    cacheReadTokens: first.cacheReadTokens + second.cacheReadTokens,
    cacheWriteTokens: first.cacheWriteTokens + second.cacheWriteTokens,
    ...((first.reasoningTokens ?? second.reasoningTokens) === undefined
      ? {}
      : { reasoningTokens: (first.reasoningTokens ?? 0) + (second.reasoningTokens ?? 0) }),
    ...((first.costUsd ?? second.costUsd) === undefined
      ? {}
      : { costUsd: (first.costUsd ?? 0) + (second.costUsd ?? 0) }),
  };
}

async function summarizeText(
  prompt: string,
  model: ModelPort,
  signal: AbortSignal | undefined,
  maxOutputTokens: number,
  onRequestConfigured?: (configuration: ModelRequestConfiguration) => Promise<void>,
): Promise<{ text: string; usage: Usage }> {
  signal?.throwIfAborted();
  let text = "";
  let terminal: Extract<ModelStreamEvent, { type: "completed" }> | undefined;
  const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: prompt }] }];
  for await (const event of model.stream({
    onRequestConfigured,
    estimatedInputTokens: estimateModelInputTokens({
      system: SUMMARIZATION_SYSTEM_PROMPT,
      messages,
      tools: [],
    }),
    system: SUMMARIZATION_SYSTEM_PROMPT,
    messages,
    tools: [],
    maxOutputTokens,
    toolChoice: "none",
    cacheRetention: "none",
    signal,
  })) {
    if (event.type === "text_delta") text += event.text;
    else if (event.type === "tool_call") throw new Error("Compaction model attempted a tool call");
    else if (event.type === "error") throw new Error(`Compaction failed: ${event.message}`);
    else if (event.type === "aborted") throw new DOMException("Compaction aborted", "AbortError");
    else if (event.type === "completed") {
      if (event.stopReason !== "stop")
        throw new Error(`Compaction summary ended with ${event.stopReason}`);
      terminal = event;
      break;
    }
  }
  signal?.throwIfAborted();
  if (terminal === undefined) throw new Error("Compaction model stream ended without completion");
  text = text.trim();
  if (!text) throw new Error("Compaction model returned an empty summary");
  return { text, usage: terminal.usage };
}

export async function summarizeCompaction(
  plan: CompactionPlan,
  model: ModelPort,
  customInstructions?: string,
  signal?: AbortSignal,
  reserveTokens = DEFAULT_COMPACTION_RESERVE_TOKENS,
  onRequestConfigured?: (configuration: ModelRequestConfiguration) => Promise<void>,
): Promise<CompactionSummary> {
  const maxOutputTokens = Math.max(1, Math.floor(reserveTokens * 0.8));
  let summary: string;
  let usage: Usage;
  if (plan.messagesToSummarize.length === 0) {
    summary = plan.previousSummary ?? "No prior history.";
    usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  } else {
    const result = await summarizeText(
      summaryPrompt(plan, customInstructions),
      model,
      signal,
      maxOutputTokens,
      onRequestConfigured,
    );
    summary = result.text;
    usage = result.usage;
  }
  if (plan.turnPrefixMessages.length > 0) {
    const prefix = await summarizeText(
      turnPrefixPrompt(plan.turnPrefixMessages),
      model,
      signal,
      Math.max(1, Math.floor(reserveTokens * 0.5)),
      onRequestConfigured,
    );
    summary = `${summary}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix.text}`;
    usage = addUsage(usage, prefix.usage);
  }
  const sections: string[] = [];
  if (plan.readFiles.length > 0)
    sections.push(`<read-files>\n${plan.readFiles.join("\n")}\n</read-files>`);
  if (plan.modifiedFiles.length > 0)
    sections.push(`<modified-files>\n${plan.modifiedFiles.join("\n")}\n</modified-files>`);
  if (sections.length > 0) summary += `\n\n${sections.join("\n\n")}`;
  return { summary, usage, readFiles: plan.readFiles, modifiedFiles: plan.modifiedFiles };
}
