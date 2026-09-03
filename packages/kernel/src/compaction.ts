// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type {
  CanonicalEvent,
  EventId,
  ModelMessage,
  ModelStreamEvent,
  ToolCallRequest,
  Usage,
} from "@axl/protocol";

import type { ModelPort } from "./model-port.ts";
import { ReplayError } from "./replay.ts";

export const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20_000;
export const DEFAULT_COMPACTION_MAX_OUTPUT_TOKENS = 4_096;

export interface CompactionSettings {
  readonly keepRecentTokens: number;
  readonly maxOutputTokens: number;
}

const TOOL_RESULT_MAX_CHARACTERS = 2_000;
const ESTIMATED_BLOB_CHARACTERS = 4_800;
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
  readonly previousSummary?: string;
  readonly replacedEventIds: readonly EventId[];
  readonly splitTurn: boolean;
}

export interface CompactionSummary {
  readonly summary: string;
  readonly usage: Usage;
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
    if (found.event.type === "context.compacted") {
      pending.push(...found.event.payload.replacedEventIds);
    }
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
    ContextGroup & {
      message: ModelMessage & { toolCalls?: ToolCallRequest[] };
    }
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
    } else if (event.type === "context.compacted") {
      toolCallingAssistant = undefined;
    }
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
    } else {
      visibleGroups.push(group);
    }
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
    ...projected.groups.map((group) => group.message),
  ];
}

function contentCharacters(
  content: readonly { readonly type: string; readonly text?: string }[],
): number {
  return content.reduce(
    (total, item) =>
      total +
      (item.type === "text" || item.type === "thinking"
        ? (item.text?.length ?? 0)
        : ESTIMATED_BLOB_CHARACTERS),
    0,
  );
}

export function estimateModelMessageTokens(message: ModelMessage): number {
  let characters = contentCharacters(message.content);
  if (message.role === "assistant") {
    for (const call of message.toolCalls ?? []) {
      characters += call.name.length + JSON.stringify(call.input).length;
    }
  } else if (message.role === "tool") {
    characters += message.name.length;
  }
  return Math.ceil(characters / 4);
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

  let firstKeptIndex = -1;
  for (let index = crossedAt; index < projected.groups.length; index += 1) {
    const role = projected.groups[index]?.message.role;
    if (role === "user" || role === "assistant") {
      firstKeptIndex = index;
      break;
    }
  }
  if (firstKeptIndex <= 0) return undefined;

  const compacted = projected.groups.slice(0, firstKeptIndex);
  return {
    messagesToSummarize: compacted.map((group) => group.message),
    ...(projected.previousCompaction === undefined
      ? {}
      : { previousSummary: projected.previousCompaction.payload.summary }),
    replacedEventIds: [
      ...(projected.previousCompaction === undefined ? [] : [projected.previousCompaction.id]),
      ...compacted.flatMap((group) => group.eventIds),
    ],
    splitTurn: projected.groups[firstKeptIndex]?.message.role === "assistant",
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

export function serializeCompactionMessages(messages: readonly ModelMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      parts.push(`[User]\n${contentText(message.content)}`);
    } else if (message.role === "assistant") {
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
          `[Assistant tool calls]\n${message.toolCalls
            ?.map((call) => `${call.name}(${JSON.stringify(call.input)})`)
            .join("\n")}`,
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
  const split = plan.splitTurn
    ? "\n\nThe retained context begins partway through a turn. Preserve the original request and early work needed to understand that suffix."
    : "";
  const focus = customInstructions
    ? `\n\nAdditional focus from the user: ${customInstructions}`
    : "";
  return `<conversation>\n${serializeCompactionMessages(plan.messagesToSummarize)}\n</conversation>${previous}${split}${focus}\n\nWrite a concise continuation summary using exactly these sections:\n\n## Goal\n## Constraints & Preferences\n## Progress\n### Done\n### In Progress\n### Blocked\n## Key Decisions\n## Next Steps\n## Critical Context\n\nPreserve exact file paths, function names, commands, and error messages needed to continue.`;
}

export async function summarizeCompaction(
  plan: CompactionPlan,
  model: ModelPort,
  customInstructions?: string,
  signal?: AbortSignal,
  maxOutputTokens = DEFAULT_COMPACTION_MAX_OUTPUT_TOKENS,
): Promise<CompactionSummary> {
  signal?.throwIfAborted();
  let summary = "";
  let terminal: Extract<ModelStreamEvent, { type: "completed" }> | undefined;
  for await (const event of model.stream({
    system: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [
      { role: "user", content: [{ type: "text", text: summaryPrompt(plan, customInstructions) }] },
    ],
    tools: [],
    maxOutputTokens,
    toolChoice: "none",
    signal,
  })) {
    if (event.type === "text_delta") summary += event.text;
    else if (event.type === "tool_call") throw new Error("Compaction model attempted a tool call");
    else if (event.type === "error") throw new Error(`Compaction failed: ${event.message}`);
    else if (event.type === "aborted") throw new DOMException("Compaction aborted", "AbortError");
    else if (event.type === "completed") {
      if (event.stopReason !== "stop") {
        throw new Error(`Compaction summary ended with ${event.stopReason}`);
      }
      terminal = event;
      break;
    }
  }
  signal?.throwIfAborted();
  if (terminal === undefined) throw new Error("Compaction model stream ended without completion");
  summary = summary.trim();
  if (!summary) throw new Error("Compaction model returned an empty summary");
  return { summary, usage: terminal.usage };
}
