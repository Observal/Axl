// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

// Transport-neutral Mistral Conversations request and SSE codec.

import { createHash } from "node:crypto";

import type { JsonObject, JsonValue, Usage } from "@axl/protocol";

import { safeProviderMessage } from "./diagnostics.ts";
import { isContextLimitError } from "./model-error.ts";
import type { MistralCompatibility, ModelInfo, ModelStreamEvent } from "./model.ts";
import {
  isPreparedModelRequest,
  type PreparedModelRequest,
  type PreparedRequestMessage,
  preparedBlobDataUrl,
} from "./request-preparation.ts";
import type { SseFrame } from "./sse.ts";
import { withUsageCost } from "./usage.ts";

const RESERVED_REQUEST_FIELDS = new Set([
  "model",
  "stream",
  "messages",
  "tools",
  "tool_choice",
  "max_tokens",
  "prompt_mode",
  "reasoning_effort",
  "prompt_cache_key",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "random_seed",
]);

export class MistralConversationsCodecError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MistralConversationsCodecError";
  }
}

export interface EncodedMistralConversationsRequest {
  readonly body: JsonObject;
  /** Safe affinity headers only. Authentication remains transport-owned. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface MistralConversationsDecodeOptions {
  readonly model: ModelInfo;
  readonly request: PreparedModelRequest;
  readonly startedAtMs?: number;
  readonly now?: () => number;
  readonly secretValues?: readonly string[];
}

type MutableJsonObject = Record<string, JsonValue>;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compatibility(model: ModelInfo): MistralCompatibility {
  if (model.apiDialect !== "mistral-conversations") {
    throw new MistralConversationsCodecError(
      `Model ${model.modelId} does not use the mistral-conversations dialect`,
    );
  }
  if (model.compatibility?.dialect !== "mistral-conversations") {
    throw new MistralConversationsCodecError(
      `Model ${model.modelId} has no Mistral Conversations compatibility record`,
    );
  }
  return model.compatibility;
}

function requirePrepared(request: PreparedModelRequest): void {
  if (!isPreparedModelRequest(request)) {
    throw new MistralConversationsCodecError(
      "Mistral Conversations requires a prepared model request",
    );
  }
}

function contentParts(
  request: PreparedModelRequest,
  message: Extract<PreparedRequestMessage, { role: "user" | "tool" }>,
): JsonValue[] {
  return message.content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    const blob = request.preparation.blobs.get(part.blob.sha256);
    if (blob === undefined) {
      throw new MistralConversationsCodecError(`Prepared blob ${part.blob.sha256} is unavailable`);
    }
    return { type: "image_url", image_url: preparedBlobDataUrl(blob) };
  });
}

function rejectReplayMetadata(
  message: Extract<PreparedRequestMessage, { role: "assistant" }>,
  messageIndex: number,
): void {
  if (message.continuation !== undefined) {
    throw new MistralConversationsCodecError(
      `messages[${messageIndex}] has continuation metadata unsupported by Mistral`,
    );
  }
  for (const [contentIndex, part] of message.content.entries()) {
    if (part.type === "text" && part.continuation !== undefined) {
      throw new MistralConversationsCodecError(
        `messages[${messageIndex}].content[${contentIndex}] has unsupported continuation metadata`,
      );
    }
    if ((part.type === "text" || part.type === "thinking") && part.signature !== undefined) {
      throw new MistralConversationsCodecError(
        `messages[${messageIndex}].content[${contentIndex}] has unsupported replay signature`,
      );
    }
  }
  for (const [callIndex, call] of (message.toolCalls ?? []).entries()) {
    if (call.signature !== undefined || call.continuation !== undefined) {
      throw new MistralConversationsCodecError(
        `messages[${messageIndex}].toolCalls[${callIndex}] has unsupported replay metadata`,
      );
    }
  }
}

function assistantMessage(
  message: Extract<PreparedRequestMessage, { role: "assistant" }>,
  messageIndex: number,
): JsonObject {
  rejectReplayMetadata(message, messageIndex);
  const content: JsonValue[] = [];
  for (const [contentIndex, part] of message.content.entries()) {
    if (part.type === "blob") {
      throw new MistralConversationsCodecError(
        `messages[${messageIndex}].content[${contentIndex}] cannot replay an assistant image`,
      );
    }
    if (part.text.trim().length === 0) continue;
    content.push(
      part.type === "thinking"
        ? { type: "thinking", thinking: [{ type: "text", text: part.text }] }
        : { type: "text", text: part.text },
    );
  }
  const toolCalls = message.toolCalls?.map(
    (call, index): JsonValue => ({
      id: call.callId,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.input) },
      index,
    }),
  );
  if (content.length === 0 && (toolCalls === undefined || toolCalls.length === 0)) {
    throw new MistralConversationsCodecError(
      `messages[${messageIndex}] has no Mistral-renderable assistant content`,
    );
  }
  return {
    role: "assistant",
    prefix: false,
    ...(content.length === 0 ? {} : { content }),
    ...(toolCalls === undefined || toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  };
}

function toolResultContent(
  request: PreparedModelRequest,
  message: Extract<PreparedRequestMessage, { role: "tool" }>,
): JsonValue[] {
  const parts = contentParts(request, message);
  const text = parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        object(part)?.type === "text" && typeof object(part)?.text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
  const images = parts.filter((part) => object(part)?.type === "image_url");
  let renderedText = text;
  if (message.isError) renderedText = `[tool error] ${renderedText || "(no tool output)"}`;
  else if (!renderedText)
    renderedText = images.length > 0 ? "(see attached image)" : "(no tool output)";
  return [{ type: "text", text: renderedText }, ...images];
}

function encodeMessages(model: ModelInfo, request: PreparedModelRequest): JsonValue[] {
  const messages: JsonValue[] = [];
  if (request.system !== undefined && request.system.length > 0) {
    messages.push({ role: "system", content: request.system });
  }
  for (const [messageIndex, message] of request.messages.entries()) {
    if (message.role === "user") {
      const parts = contentParts(request, message);
      const only = parts[0];
      messages.push({
        role: "user",
        content:
          parts.length === 1 && object(only)?.type === "text"
            ? (object(only)?.text as string)
            : parts,
      });
    } else if (message.role === "assistant") {
      messages.push(assistantMessage(message, messageIndex));
    } else {
      messages.push({
        role: "tool",
        tool_call_id: message.callId,
        name: message.name,
        content: toolResultContent(request, message),
      });
    }
  }
  compatibility(model);
  return messages;
}

function encodeTools(request: PreparedModelRequest): JsonValue[] | undefined {
  if (request.tools === undefined || request.tools.length === 0) return undefined;
  return request.tools.map((tool): JsonValue => {
    if (tool.preparedConstraint?.type === "grammar") {
      throw new MistralConversationsCodecError(
        `Mistral cannot render grammar-constrained tool ${tool.canonicalName}`,
      );
    }
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        strict:
          tool.preparedConstraint?.type === "json-schema" ? tool.preparedConstraint.strict : false,
      },
    };
  });
}

function applyReasoning(body: MutableJsonObject, request: PreparedModelRequest): void {
  const reasoning = request.preparation.reasoning;
  if (reasoning === undefined) return;
  if (reasoning.providerValue !== undefined) {
    body.reasoning_effort = reasoning.providerValue;
  } else if (reasoning.effective !== "off") {
    body.prompt_mode = "reasoning";
  }
}

function applySampling(body: MutableJsonObject, request: PreparedModelRequest): void {
  const sampling = request.sampling;
  if (sampling === undefined) return;
  const fields = {
    temperature: "temperature",
    topP: "top_p",
    frequencyPenalty: "frequency_penalty",
    presencePenalty: "presence_penalty",
    seed: "random_seed",
  } as const;
  for (const [source, target] of Object.entries(fields) as [keyof typeof fields, string][]) {
    const value = sampling[source];
    if (value !== undefined) body[target] = value;
  }
  for (const [field, value] of Object.entries(sampling.custom ?? {})) {
    if (RESERVED_REQUEST_FIELDS.has(field) || field in body) {
      throw new MistralConversationsCodecError(
        `Custom sampling field ${field} collides with a Mistral request field`,
      );
    }
    body[field] = value;
  }
}

/** Encodes only a validated, immutable prepared request. */
export function encodeMistralConversationsRequest(
  model: ModelInfo,
  request: PreparedModelRequest,
): EncodedMistralConversationsRequest {
  requirePrepared(request);
  compatibility(model);
  if (request.modelId !== model.modelId) {
    throw new MistralConversationsCodecError(
      `Request model ${request.modelId} does not match ${model.modelId}`,
    );
  }
  if (request.metadata !== undefined && Object.keys(request.metadata).length > 0) {
    throw new MistralConversationsCodecError("Mistral cannot render request metadata");
  }
  const body: MutableJsonObject = {
    model: model.modelId,
    stream: true,
    messages: encodeMessages(model, request),
  };
  if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
  const tools = request.toolChoice === "none" ? undefined : encodeTools(request);
  if (tools !== undefined) body.tools = tools;
  if (request.toolChoice !== undefined) {
    if (request.toolChoice !== "none" && tools === undefined) {
      throw new MistralConversationsCodecError(
        `toolChoice ${request.toolChoice} needs at least one tool`,
      );
    }
    body.tool_choice = request.toolChoice;
  }
  applyReasoning(body, request);
  applySampling(body, request);
  const headers: Record<string, string> = {};
  if (request.preparation.cache.retention !== "none") {
    const sessionId = request.preparation.cache.sessionId;
    if (sessionId !== undefined) {
      body.prompt_cache_key = sessionId;
      headers["x-affinity"] = sessionId;
    }
  }
  return { body, headers };
}

interface ToolAccumulator {
  readonly index: number;
  readonly contentIndex: number;
  id: string;
  name: string;
  argumentsText: string;
  emittedArguments: number;
  started: boolean;
}

function nonNegative(value: unknown, label: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new MistralConversationsCodecError(`Mistral usage ${label} must be non-negative`);
  }
  return value;
}

function usage(raw: unknown, model: ModelInfo): Usage {
  const value = object(raw);
  if (value === undefined)
    throw new MistralConversationsCodecError("Mistral usage must be an object");
  const prompt = nonNegative(value.prompt_tokens, "prompt_tokens");
  const details =
    object(value.prompt_tokens_details) ??
    object(value.prompt_token_details) ??
    object(value.promptTokensDetails) ??
    object(value.promptTokenDetails);
  const cachedRaw =
    details?.cached_tokens ??
    details?.cachedTokens ??
    value.num_cached_tokens ??
    value.numCachedTokens;
  const cached = Math.min(prompt, nonNegative(cachedRaw, "cached_tokens"));
  const mapped: Usage = {
    inputTokens: prompt - cached,
    outputTokens: nonNegative(value.completion_tokens, "completion_tokens"),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  return model.cost === undefined ? mapped : withUsageCost(model.cost, mapped);
}

function reverseToolName(request: PreparedModelRequest, name: string): string {
  return request.preparation.tools.find((tool) => tool.name === name)?.canonicalName ?? name;
}

function fallbackToolCallId(index: number): string {
  return createHash("sha256").update(`mistral-tool:${index}`).digest("hex").slice(0, 9);
}

function retryableCode(code: string): boolean {
  return code === "rate_limit" || code === "rate_limit_exceeded" || code === "server_error";
}

/** Decodes native Mistral SSE frames into canonical model stream events. */
export async function* decodeMistralConversationsStream(
  frames: AsyncIterable<SseFrame>,
  options: MistralConversationsDecodeOptions,
): AsyncGenerator<ModelStreamEvent, void, undefined> {
  requirePrepared(options.request);
  compatibility(options.model);
  const tools = new Map<number, ToolAccumulator>();
  let nextContentIndex = 0;
  let currentContent: { type: "text" | "thinking"; index: number } | undefined;
  let finalUsage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...(options.model.cost === undefined ? {} : { costUsd: 0 }),
  };
  let responseId: string | undefined;
  let routedModelId: string | undefined;
  let finishReason: string | undefined;
  let emittedContent = false;
  let emittedToolCall = false;

  const response = () => ({
    providerId: options.model.providerId,
    requestedModelId: options.request.modelId,
    ...(routedModelId === undefined ? {} : { routedModelId }),
    ...(responseId === undefined ? {} : { responseId }),
    ...(finishReason === undefined ? {} : { nativeStopReason: finishReason }),
    ...(options.startedAtMs === undefined
      ? {}
      : { latencyMs: Math.max(0, (options.now ?? Date.now)() - options.startedAtMs) }),
  });

  for await (const frame of frames) {
    if (options.request.signal?.aborted) {
      yield { type: "aborted", ...(emittedContent ? { partial: true } : {}) };
      return;
    }
    if (frame.data === "[DONE]") break;
    let chunk: Record<string, unknown>;
    try {
      const parsed = object(JSON.parse(frame.data) as unknown);
      if (parsed === undefined) throw new Error("frame is not an object");
      chunk = parsed;
    } catch (cause) {
      throw new MistralConversationsCodecError("Mistral sent an undecodable stream frame", {
        cause,
      });
    }

    const providerError = object(chunk.error);
    if (providerError !== undefined) {
      const code = String(providerError.code ?? providerError.type ?? "provider_error");
      const message = safeProviderMessage(
        typeof providerError.message === "string"
          ? providerError.message
          : "Mistral reported a failure",
        options.secretValues,
      );
      yield {
        type: "error",
        code,
        message,
        retryable: retryableCode(code),
        category: isContextLimitError(code, message)
          ? "context_limit"
          : code === "rate_limit" || code === "rate_limit_exceeded"
            ? "rate_limit"
            : retryableCode(code)
              ? "provider_internal"
              : "invalid_request",
        requestPhase: "streaming",
        ...(emittedContent ? { partial: true } : {}),
        response: response(),
      };
      return;
    }
    if (typeof chunk.id === "string" && chunk.id.length > 0) responseId ??= chunk.id;
    if (typeof chunk.model === "string" && chunk.model.length > 0) routedModelId ??= chunk.model;
    if (chunk.usage !== undefined) finalUsage = usage(chunk.usage, options.model);
    if (!Array.isArray(chunk.choices)) {
      throw new MistralConversationsCodecError("Mistral stream choices must be an array");
    }
    if (chunk.choices.length === 0) continue;
    if (chunk.choices.length !== 1) {
      throw new MistralConversationsCodecError("Mistral returned multiple completion choices");
    }
    const choice = object(chunk.choices[0]);
    if (choice === undefined)
      throw new MistralConversationsCodecError("Mistral choice is malformed");
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (typeof choice.finish_reason !== "string" || choice.finish_reason.length === 0) {
        throw new MistralConversationsCodecError("Mistral finish reason is malformed");
      }
      finishReason = choice.finish_reason;
    }
    const delta = object(choice.delta);
    if (delta === undefined) throw new MistralConversationsCodecError("Mistral delta is malformed");

    if (delta.content !== undefined && delta.content !== null) {
      const items = typeof delta.content === "string" ? [delta.content] : delta.content;
      if (!Array.isArray(items)) {
        throw new MistralConversationsCodecError("Mistral content delta is malformed");
      }
      for (const item of items) {
        let type: "text" | "thinking";
        let text: string;
        if (typeof item === "string") {
          type = "text";
          text = item;
        } else {
          const part = object(item);
          if (part?.type === "text" && typeof part.text === "string") {
            type = "text";
            text = part.text;
          } else if (part?.type === "thinking" && Array.isArray(part.thinking)) {
            type = "thinking";
            text = part.thinking
              .map((entry) => object(entry)?.text)
              .filter((entry): entry is string => typeof entry === "string")
              .join("");
            if (
              part.thinking.some(
                (entry) => object(entry) === undefined || typeof object(entry)?.text !== "string",
              )
            ) {
              throw new MistralConversationsCodecError("Mistral thinking delta is malformed");
            }
          } else {
            throw new MistralConversationsCodecError("Mistral content item is malformed");
          }
        }
        if (text.length === 0) continue;
        if (currentContent?.type !== type) currentContent = { type, index: nextContentIndex++ };
        emittedContent = true;
        yield {
          type: type === "text" ? "text_delta" : "thinking_delta",
          text,
          contentIndex: currentContent.index,
        };
      }
    }

    if (delta.tool_calls === undefined || delta.tool_calls === null) continue;
    if (!Array.isArray(delta.tool_calls)) {
      throw new MistralConversationsCodecError("Mistral tool call deltas must be an array");
    }
    currentContent = undefined;
    for (const rawTool of delta.tool_calls) {
      const tool = object(rawTool);
      if (tool === undefined || !Number.isSafeInteger(tool.index) || (tool.index as number) < 0) {
        throw new MistralConversationsCodecError("Mistral tool call has no valid index");
      }
      const index = tool.index as number;
      let state = tools.get(index);
      if (state === undefined) {
        state = {
          index,
          contentIndex: nextContentIndex++,
          id: "",
          name: "",
          argumentsText: "",
          emittedArguments: 0,
          started: false,
        };
        tools.set(index, state);
      }
      if (typeof tool.id === "string" && tool.id.length > 0 && tool.id !== "null")
        state.id ||= tool.id;
      const functionCall = object(tool.function);
      if (functionCall === undefined) {
        throw new MistralConversationsCodecError("Mistral tool function is malformed");
      }
      if (typeof functionCall.name === "string" && functionCall.name.length > 0) {
        state.name ||= functionCall.name;
      }
      if (typeof functionCall.arguments === "string") {
        state.argumentsText += functionCall.arguments;
      } else if (functionCall.arguments !== undefined) {
        const argumentsObject = object(functionCall.arguments);
        if (argumentsObject === undefined) {
          throw new MistralConversationsCodecError("Mistral tool arguments are malformed");
        }
        state.argumentsText += JSON.stringify(argumentsObject);
      }
      state.id ||= fallbackToolCallId(index);
      if (!state.started && state.name.length > 0) {
        state.started = true;
        emittedContent = true;
        yield {
          type: "tool_call_start",
          contentIndex: state.contentIndex,
          callId: state.id,
          name: reverseToolName(options.request, state.name),
        };
      }
      if (state.started && state.argumentsText.length > state.emittedArguments) {
        const argumentsDelta = state.argumentsText.slice(state.emittedArguments);
        state.emittedArguments = state.argumentsText.length;
        yield {
          type: "tool_call_delta",
          contentIndex: state.contentIndex,
          callId: state.id,
          argumentsDelta,
        };
      }
    }
  }

  if (options.request.signal?.aborted) {
    yield { type: "aborted", ...(emittedContent ? { partial: true } : {}) };
    return;
  }
  if (finishReason === undefined) return;
  for (const state of [...tools.values()].sort((left, right) => left.index - right.index)) {
    if (!state.started)
      throw new MistralConversationsCodecError("Mistral ended an incomplete tool call");
    let input: JsonObject;
    try {
      const parsed = object(JSON.parse(state.argumentsText || "{}") as unknown);
      if (parsed === undefined) throw new Error("arguments are not an object");
      input = parsed as JsonObject;
    } catch (cause) {
      throw new MistralConversationsCodecError(
        `Mistral tool call ${state.id} has undecodable arguments`,
        { cause },
      );
    }
    emittedToolCall = true;
    yield {
      type: "tool_call",
      contentIndex: state.contentIndex,
      callId: state.id,
      name: reverseToolName(options.request, state.name),
      input,
    };
  }

  const mapped =
    finishReason === "stop"
      ? "stop"
      : finishReason === "length" || finishReason === "model_length"
        ? "length"
        : finishReason === "tool_calls"
          ? "tool_use"
          : "error";
  if (mapped === "error") {
    yield {
      type: "error",
      code: finishReason,
      message: safeProviderMessage(`Provider stopped with: ${finishReason}`, options.secretValues),
      retryable: false,
      category: "provider_internal",
      requestPhase: "streaming",
      ...(emittedContent ? { partial: true } : {}),
      response: response(),
    };
    return;
  }
  yield {
    type: "completed",
    stopReason: mapped === "tool_use" || emittedToolCall ? "tool_use" : mapped,
    usage: finalUsage,
    ...(mapped === "length" ? { partial: true } : {}),
    response: response(),
  };
}
