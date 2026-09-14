// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

// Axl-native OpenAI Chat Completions request and streaming response codec.

import type { JsonObject, JsonValue, Usage } from "@axl/protocol";

import { safeProviderMessage } from "./diagnostics.ts";
import { isContextLimitError } from "./model-error.ts";
import type { ModelInfo, ModelStreamEvent, OpenAiChatCompatibility } from "./model.ts";
import {
  isPreparedModelRequest,
  preparedBlobDataUrl,
  type CachePlacement,
  type PreparedModelRequest,
  type PreparedRequestMessage,
  type PreparedToolDeclaration,
} from "./request-preparation.ts";
import type { SseFrame } from "./sse.ts";
import { withUsageCost } from "./usage.ts";

const REASONING_FIELDS = new Set(["reasoning", "reasoning_content", "reasoning_text"]);
const RESERVED_REQUEST_FIELDS = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "store",
  "tools",
  "tool_choice",
  "max_tokens",
  "max_completion_tokens",
  "reasoning_effort",
  "reasoning",
  "thinking",
  "enable_thinking",
  "chat_template_kwargs",
  "chat_template_args",
  "prompt_cache_key",
  "prompt_cache_retention",
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "seed",
  "provider",
]);

export class OpenAiChatCodecError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OpenAiChatCodecError";
  }
}

export interface EncodedOpenAiChatRequest {
  readonly body: JsonObject;
  /** Safe affinity headers only. Authentication remains transport-owned. */
  readonly headers: Readonly<Record<string, string>>;
}

type MutableJsonObject = Record<string, JsonValue>;

type WireMessage = MutableJsonObject & { role: JsonValue; content?: JsonValue };

function isJsonObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compatibility(model: ModelInfo): OpenAiChatCompatibility {
  if (model.apiDialect !== "openai-chat") {
    throw new OpenAiChatCodecError(`Model ${model.modelId} does not use the openai-chat dialect`);
  }
  if (model.compatibility?.dialect !== "openai-chat") {
    throw new OpenAiChatCodecError(
      `Model ${model.modelId} has no OpenAI Chat compatibility record`,
    );
  }
  return model.compatibility;
}

function preparedRequest(request: PreparedModelRequest): void {
  if (!isPreparedModelRequest(request)) {
    throw new OpenAiChatCodecError("OpenAI Chat requires a prepared model request");
  }
}

function cacheControl(
  model: ModelInfo,
  request: PreparedModelRequest,
): MutableJsonObject | undefined {
  if (request.preparation.cache.retention === "none") return undefined;
  const compat = compatibility(model);
  if (compat.cacheControlFormat !== "anthropic") return undefined;
  if (request.preparation.cache.retention === "long") {
    if (compat.supportsLongCacheRetention !== true) {
      throw new OpenAiChatCodecError("Long cache retention is unsupported by this Chat endpoint");
    }
    return { type: "ephemeral", ttl: "1h" };
  }
  return { type: "ephemeral" };
}

function hasPlacement(
  placements: readonly CachePlacement[],
  target: CachePlacement["target"],
  messageIndex?: number,
  contentIndex?: number,
): boolean {
  return placements.some(
    (placement) =>
      placement.target === target &&
      placement.messageIndex === messageIndex &&
      placement.contentIndex === contentIndex,
  );
}

function contentParts(
  request: PreparedModelRequest,
  message: PreparedRequestMessage,
  messageIndex: number,
  marker: MutableJsonObject | undefined,
): JsonValue[] {
  return message.content.map((item, contentIndex): JsonValue => {
    const marked =
      marker !== undefined &&
      hasPlacement(
        request.preparation.cache.placements,
        "message-content",
        messageIndex,
        contentIndex,
      );
    if (item.type === "text") {
      return { type: "text", text: item.text, ...(marked ? { cache_control: marker } : {}) };
    }
    if (item.type === "blob") {
      const blob = request.preparation.blobs.get(item.blob.sha256);
      if (blob === undefined) {
        throw new OpenAiChatCodecError(`Prepared blob ${item.blob.sha256} is unavailable`);
      }
      return {
        type: "image_url",
        image_url: { url: preparedBlobDataUrl(blob) },
        ...(marked ? { cache_control: marker } : {}),
      };
    }
    throw new OpenAiChatCodecError("OpenAI Chat cannot encode this content block");
  });
}

function textFromParts(parts: readonly JsonValue[]): string {
  return parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        isJsonObject(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function reasoningDetails(signature: string): JsonValue[] | undefined {
  try {
    const value = JSON.parse(signature) as unknown;
    if (!Array.isArray(value) || value.length === 0) return undefined;
    for (const detail of value) {
      if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return undefined;
      const type = (detail as Record<string, unknown>).type;
      if (
        type !== "reasoning.summary" &&
        type !== "reasoning.encrypted" &&
        type !== "reasoning.text"
      ) {
        return undefined;
      }
    }
    return value as JsonValue[];
  } catch {
    return undefined;
  }
}

function rejectContinuation(message: PreparedRequestMessage, messageIndex: number): void {
  if (message.role !== "assistant") return;
  if (message.continuation !== undefined) {
    throw new OpenAiChatCodecError(
      `messages[${messageIndex}] has continuation metadata unsupported by OpenAI Chat`,
    );
  }
  for (const [contentIndex, content] of message.content.entries()) {
    if (content.type === "text" && content.continuation !== undefined) {
      throw new OpenAiChatCodecError(
        `messages[${messageIndex}].content[${contentIndex}] has unsupported continuation metadata`,
      );
    }
  }
  for (const [callIndex, call] of (message.toolCalls ?? []).entries()) {
    if (call.continuation !== undefined) {
      throw new OpenAiChatCodecError(
        `messages[${messageIndex}].toolCalls[${callIndex}] has unsupported continuation metadata`,
      );
    }
  }
}

function assistantMessage(
  request: PreparedModelRequest,
  message: Extract<PreparedRequestMessage, { role: "assistant" }>,
  messageIndex: number,
  compat: OpenAiChatCompatibility,
  marker: MutableJsonObject | undefined,
): WireMessage {
  rejectContinuation(message, messageIndex);
  if (message.content.some((part) => part.type === "blob")) {
    throw new OpenAiChatCodecError("OpenAI Chat cannot replay image content from an assistant");
  }
  const textParts: JsonValue[] = message.content.flatMap((part, contentIndex) =>
    part.type === "text"
      ? [
          {
            type: "text",
            text: part.text,
            ...(marker !== undefined &&
            hasPlacement(
              request.preparation.cache.placements,
              "message-content",
              messageIndex,
              contentIndex,
            )
              ? { cache_control: marker }
              : {}),
          },
        ]
      : [],
  );
  const text = textFromParts(textParts);
  const hasMarkedText = textParts.some(
    (part) => isJsonObject(part) && part.cache_control !== undefined,
  );
  const thinking = message.content.filter((part) => part.type === "thinking");
  const wire: WireMessage = {
    role: "assistant",
    content: text.length > 0 ? (hasMarkedText ? textParts : text) : null,
  };

  if (thinking.length > 0) {
    const signedDetails: JsonValue[] = [];
    for (const part of thinking) {
      if (part.signature === undefined || REASONING_FIELDS.has(part.signature.value)) continue;
      const parsed = reasoningDetails(part.signature.value);
      if (parsed === undefined) {
        throw new OpenAiChatCodecError(
          `messages[${messageIndex}] has an unrecognized OpenAI Chat reasoning signature`,
        );
      }
      signedDetails.push(...parsed);
    }
    if (signedDetails.length > 0) {
      wire.reasoning_details = signedDetails;
    } else if (compat.requiresThinkingAsText === true) {
      const thinkingText = thinking
        .map((part) => part.text)
        .filter(Boolean)
        .join("\n\n");
      wire.content = [
        ...(thinkingText.length === 0 ? [] : [{ type: "text", text: thinkingText }]),
        ...textParts,
      ];
    } else {
      for (const part of thinking) {
        if (part.signature !== undefined && !REASONING_FIELDS.has(part.signature.value)) {
          throw new OpenAiChatCodecError(
            `messages[${messageIndex}] has an unrecognized OpenAI Chat reasoning signature`,
          );
        }
      }
      const field = thinking.find((part) => part.signature !== undefined)?.signature?.value;
      const reasoningField = field ?? "reasoning_content";
      wire[reasoningField] = thinking.map((part) => part.text).join("\n");
    }
  }

  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    const grammarTools = new Map(
      request.preparation.tools
        .filter((tool) => tool.preparedConstraint?.type === "grammar")
        .map((tool) => [tool.name, tool]),
    );
    wire.tool_calls = message.toolCalls.map((call): JsonValue => {
      if (call.signature !== undefined) {
        const detail = reasoningDetails(call.signature.value);
        if (detail === undefined) {
          throw new OpenAiChatCodecError(
            `messages[${messageIndex}] has an unrecognized tool reasoning signature`,
          );
        }
        const existing = wire.reasoning_details;
        wire.reasoning_details = [...(Array.isArray(existing) ? existing : []), ...detail];
      }
      const grammar = grammarTools.get(call.name)?.preparedConstraint;
      if (grammar?.type === "grammar") {
        const value = call.input[grammar.inputProperty];
        if (typeof value !== "string") {
          throw new OpenAiChatCodecError(
            `Grammar tool ${call.canonicalName} needs string input ${grammar.inputProperty}`,
          );
        }
        return { id: call.callId, type: "custom", custom: { name: call.name, input: value } };
      }
      return {
        id: call.callId,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.input) },
      };
    });
  }

  if (
    compat.requiresReasoningContentOnAssistantMessages === true &&
    wire.reasoning_content === undefined
  ) {
    wire.reasoning_content = "";
  }
  const hasContent =
    typeof wire.content === "string"
      ? wire.content.length > 0
      : Array.isArray(wire.content) && wire.content.length > 0;
  if (!hasContent && wire.tool_calls === undefined && wire.reasoning_details === undefined) {
    throw new OpenAiChatCodecError(
      `messages[${messageIndex}] has no OpenAI Chat renderable assistant content`,
    );
  }
  return wire;
}

function instructionMessage(
  model: ModelInfo,
  request: PreparedModelRequest,
  marker: MutableJsonObject | undefined,
): WireMessage | undefined {
  if (request.system === undefined || request.system.length === 0) return undefined;
  const compat = compatibility(model);
  const role = model.reasoning && compat.supportsDeveloperRole === true ? "developer" : "system";
  const marked =
    marker !== undefined && hasPlacement(request.preparation.cache.placements, "system");
  return {
    role,
    content: marked
      ? [{ type: "text", text: request.system, cache_control: marker }]
      : request.system,
  };
}

function encodeMessages(
  model: ModelInfo,
  request: PreparedModelRequest,
  marker: MutableJsonObject | undefined,
): JsonValue[] {
  const compat = compatibility(model);
  const output: JsonValue[] = [];
  const pendingToolImages: JsonValue[] = [];
  const instruction = instructionMessage(model, request, marker);
  if (instruction !== undefined) output.push(instruction);

  for (let messageIndex = 0; messageIndex < request.messages.length; messageIndex += 1) {
    const message = request.messages[messageIndex];
    if (message === undefined) continue;
    if (message.role === "user") {
      const parts = contentParts(request, message, messageIndex, marker);
      const onlyPart = parts[0];
      const plainText =
        parts.length === 1 &&
        onlyPart !== undefined &&
        isJsonObject(onlyPart) &&
        onlyPart.type === "text" &&
        onlyPart.cache_control === undefined;
      output.push({ role: "user", content: plainText ? (onlyPart.text ?? "") : parts });
      continue;
    }
    if (message.role === "assistant") {
      output.push(assistantMessage(request, message, messageIndex, compat, marker));
      continue;
    }

    const imageParts: JsonValue[] = [];
    const parts = contentParts(request, message, messageIndex, marker);
    for (const part of parts) {
      if (isJsonObject(part) && part.type === "image_url") imageParts.push(part);
    }
    const text = textFromParts(parts);
    const markedText = parts.some(
      (part) => isJsonObject(part) && part.type === "text" && part.cache_control !== undefined,
    );
    const toolContent =
      text.length > 0
        ? markedText
          ? parts.filter((part) => isJsonObject(part) && part.type === "text")
          : text
        : imageParts.length > 0
          ? "(see attached image)"
          : "(no tool output)";
    const toolMessage: MutableJsonObject = {
      role: "tool",
      tool_call_id: message.callId,
      content: toolContent,
      ...(compat.requiresToolResultName === true ? { name: message.name } : {}),
    };
    output.push(toolMessage);
    pendingToolImages.push(...imageParts);
    const nextMessage = request.messages[messageIndex + 1];
    if (nextMessage?.role !== "tool" && pendingToolImages.length > 0) {
      output.push({
        role: "user",
        content: [
          { type: "text", text: "Attached image(s) from tool result:" },
          ...pendingToolImages,
        ],
      });
      pendingToolImages.length = 0;
    } else if (nextMessage?.role === "user" && compat.requiresAssistantAfterToolResult === true) {
      output.push({ role: "assistant", content: "I have processed the tool results." });
    }
  }
  return output;
}

function encodeTools(
  request: PreparedModelRequest,
  marker: MutableJsonObject | undefined,
): JsonValue[] | undefined {
  if (request.tools === undefined || request.tools.length === 0) return undefined;
  return request.tools.map((tool, toolIndex): JsonValue => {
    let rendered: MutableJsonObject;
    if (tool.preparedConstraint?.type === "grammar") {
      rendered = {
        type: "custom",
        custom: {
          name: tool.name,
          description: tool.description,
          format: {
            type: "grammar",
            grammar: {
              syntax: tool.preparedConstraint.format,
              definition: tool.preparedConstraint.definition,
            },
          },
        },
      };
    } else {
      rendered = {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          ...(tool.preparedConstraint?.type === "json-schema"
            ? { strict: tool.preparedConstraint.strict }
            : {}),
        },
      };
    }
    const marked = request.preparation.cache.placements.some(
      (placement) => placement.target === "tool" && placement.toolIndex === toolIndex,
    );
    if (marked && marker !== undefined) rendered.cache_control = marker;
    return rendered;
  });
}

function applyReasoningControl(
  body: MutableJsonObject,
  model: ModelInfo,
  request: PreparedModelRequest,
): void {
  const reasoning = request.preparation.reasoning;
  if (reasoning === undefined) return;
  const compat = compatibility(model);
  const enabled = reasoning.effective !== "off";
  const effort = reasoning.providerValue;

  if (compat.thinkingFormat === "openrouter") {
    body.reasoning = { effort: enabled ? (effort ?? reasoning.effective) : (effort ?? "none") };
  } else if (compat.thinkingFormat === "deepseek") {
    body.thinking = { type: enabled ? "enabled" : "disabled" };
    if (enabled && compat.supportsReasoningEffort === true) {
      body.reasoning_effort = effort ?? reasoning.effective;
    }
  } else if (compat.thinkingFormat === "together") {
    body.reasoning = { enabled };
    if (enabled && compat.supportsReasoningEffort === true) {
      body.reasoning_effort = effort ?? reasoning.effective;
    }
  } else if (compat.thinkingFormat === "zai") {
    body.thinking = enabled ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
    if (enabled && compat.supportsReasoningEffort === true) {
      body.reasoning_effort = effort ?? reasoning.effective;
    }
  } else if (compat.thinkingFormat === "qwen") {
    body.enable_thinking = enabled;
    if (enabled && compat.supportsReasoningEffort === true) {
      body.reasoning_effort = effort ?? reasoning.effective;
    }
  } else if (compat.thinkingFormat === "chat-template") {
    body.chat_template_kwargs = { enable_thinking: enabled };
  } else if (compat.thinkingFormat === "baseten") {
    body.chat_template_args = { enable_thinking: enabled };
    if (compat.supportsReasoningEffort === true && (enabled || effort !== undefined)) {
      body.reasoning_effort = effort ?? reasoning.effective;
    }
  } else if (compat.thinkingFormat === "string-thinking") {
    body.thinking = effort ?? (enabled ? reasoning.effective : "none");
  } else if (compat.thinkingFormat === "ant-ling") {
    if (enabled) {
      if (effort === undefined) {
        throw new OpenAiChatCodecError("Ant Ling reasoning requires a prepared provider effort");
      }
      body.reasoning = { effort };
    }
  } else if (compat.supportsReasoningEffort === true) {
    if (enabled) body.reasoning_effort = effort ?? reasoning.effective;
    else if (effort !== undefined) body.reasoning_effort = effort;
  } else if (enabled) {
    throw new OpenAiChatCodecError("This Chat endpoint cannot render prepared reasoning controls");
  }

  if (reasoning.tokenBudget !== undefined) {
    const field = compat.thinkingTokenBudgetField;
    if (field === undefined) {
      throw new OpenAiChatCodecError("Prepared reasoning budget has no Chat request field");
    }
    body[field] = reasoning.tokenBudget;
  }
}

function applySampling(body: MutableJsonObject, request: PreparedModelRequest): void {
  const sampling = request.sampling;
  if (sampling === undefined) return;
  const fields = {
    temperature: "temperature",
    topP: "top_p",
    topK: "top_k",
    minP: "min_p",
    frequencyPenalty: "frequency_penalty",
    presencePenalty: "presence_penalty",
    repetitionPenalty: "repetition_penalty",
    seed: "seed",
  } as const;
  for (const [source, target] of Object.entries(fields) as [keyof typeof fields, string][]) {
    const value = sampling[source];
    if (value !== undefined) body[target] = value;
  }
  for (const [field, value] of Object.entries(sampling.custom ?? {})) {
    if (RESERVED_REQUEST_FIELDS.has(field) || field in body) {
      throw new OpenAiChatCodecError(
        `Custom sampling field ${field} collides with a request field`,
      );
    }
    body[field] = value;
  }
}

function applyCache(
  body: MutableJsonObject,
  headers: Record<string, string>,
  model: ModelInfo,
  request: PreparedModelRequest,
): void {
  const cache = request.preparation.cache;
  if (cache.retention === "none") return;
  const compat = compatibility(model);
  if (cache.retention === "long") {
    if (compat.supportsLongCacheRetention !== true) {
      throw new OpenAiChatCodecError("Long cache retention is unsupported by this Chat endpoint");
    }
    body.prompt_cache_retention = "24h";
  }
  if (cache.sessionId === undefined) return;
  if (model.providerId === "openai" || compat.supportsLongCacheRetention === true) {
    body.prompt_cache_key = Array.from(cache.sessionId).slice(0, 64).join("");
  }
  if (compat.sessionAffinityFormat === "openrouter") {
    headers["x-session-id"] = cache.sessionId;
  } else if (compat.sessionAffinityFormat === "openai") {
    headers.session_id = cache.sessionId;
    headers["x-client-request-id"] = cache.sessionId;
    headers["x-session-affinity"] = cache.sessionId;
  } else if (compat.sessionAffinityFormat === "openai-no-session") {
    headers["x-client-request-id"] = cache.sessionId;
    headers["x-session-affinity"] = cache.sessionId;
  }
}

/** Encodes only a validated, immutable prepared request. */
export function encodeOpenAiChatRequest(
  model: ModelInfo,
  request: PreparedModelRequest,
  wireModelId = model.modelId,
): EncodedOpenAiChatRequest {
  preparedRequest(request);
  const compat = compatibility(model);
  if (request.modelId !== model.modelId) {
    throw new OpenAiChatCodecError(
      `Request model ${request.modelId} does not match ${model.modelId}`,
    );
  }
  if (request.metadata !== undefined && Object.keys(request.metadata).length > 0) {
    throw new OpenAiChatCodecError("OpenAI Chat cannot render request metadata");
  }

  const marker = cacheControl(model, request);
  const body: MutableJsonObject = {
    model: wireModelId,
    messages: encodeMessages(model, request, marker),
    stream: true,
  };
  if (compat.supportsUsageInStreaming !== false) body.stream_options = { include_usage: true };
  if (compat.supportsStore === true) body.store = false;
  if (request.maxOutputTokens !== undefined) {
    body[compat.maxTokensField ?? "max_completion_tokens"] = request.maxOutputTokens;
  }
  const tools = encodeTools(request, marker);
  if (tools !== undefined) body.tools = tools;
  if (request.toolChoice !== undefined) {
    if (request.toolChoice !== "none" && tools === undefined) {
      throw new OpenAiChatCodecError(`toolChoice ${request.toolChoice} needs at least one tool`);
    }
    body.tool_choice = request.toolChoice;
  }
  applyReasoningControl(body, model, request);
  applySampling(body, request);
  const headers: Record<string, string> = {};
  applyCache(body, headers, model, request);
  return { body, headers };
}

interface ToolAccumulator {
  readonly index: number;
  readonly contentIndex: number;
  id: string;
  name: string;
  arguments: string;
  customInput: string;
  custom: boolean;
  started: boolean;
  emittedArguments: number;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function usage(raw: unknown, model: ModelInfo): Usage {
  const value = object(raw) ?? {};
  const promptDetails = object(value.prompt_tokens_details);
  const completionDetails = object(value.completion_tokens_details);
  const prompt = typeof value.prompt_tokens === "number" ? value.prompt_tokens : 0;
  const cacheRead =
    typeof promptDetails?.cached_tokens === "number"
      ? promptDetails.cached_tokens
      : typeof value.prompt_cache_hit_tokens === "number"
        ? value.prompt_cache_hit_tokens
        : typeof value.cached_tokens === "number"
          ? value.cached_tokens
          : 0;
  const cacheWrite =
    typeof promptDetails?.cache_write_tokens === "number" ? promptDetails.cache_write_tokens : 0;
  const output = typeof value.completion_tokens === "number" ? value.completion_tokens : 0;
  const reasoning =
    typeof completionDetails?.reasoning_tokens === "number"
      ? completionDetails.reasoning_tokens
      : 0;
  const mapped: Usage = {
    inputTokens: Math.max(0, prompt - cacheRead - cacheWrite),
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: reasoning,
  };
  return model.cost === undefined ? mapped : withUsageCost(model.cost, mapped);
}

function reverseToolName(request: PreparedModelRequest, name: string): string {
  return request.preparation.tools.find((tool) => tool.name === name)?.canonicalName ?? name;
}

function grammarTool(
  request: PreparedModelRequest,
  name: string,
): PreparedToolDeclaration | undefined {
  return request.preparation.tools.find(
    (tool) => tool.name === name && tool.preparedConstraint?.type === "grammar",
  );
}

function retryableProviderCode(code: string): boolean {
  return code === "rate_limit_exceeded" || code === "server_error" || code === "timeout";
}

export interface OpenAiChatDecodeOptions {
  readonly model: ModelInfo;
  readonly request: PreparedModelRequest;
  readonly startedAtMs?: number;
  readonly now?: () => number;
  readonly secretValues?: readonly string[];
}

/** Decodes Chat Completions SSE frames into canonical stream events. */
export async function* decodeOpenAiChatStream(
  frames: AsyncIterable<SseFrame>,
  options: OpenAiChatDecodeOptions,
): AsyncGenerator<ModelStreamEvent, void, undefined> {
  preparedRequest(options.request);
  compatibility(options.model);
  const tools = new Map<number, ToolAccumulator>();
  let finalUsage = usage(undefined, options.model);
  let finishReason: string | undefined;
  let responseId: string | undefined;
  let routedModelId: string | undefined;
  let emittedContent = false;
  let sawToolCall = false;
  let nextContentIndex = 0;
  let textContentIndex: number | undefined;
  let thinkingContentIndex: number | undefined;

  const responseMetadata = () => ({
    providerId: options.model.providerId,
    requestedModelId: options.request.modelId,
    ...(routedModelId === undefined ? {} : { routedModelId }),
    ...(responseId === undefined ? {} : { responseId }),
    ...(finishReason === undefined ? {} : { nativeStopReason: finishReason }),
    ...(options.startedAtMs === undefined
      ? {}
      : { latencyMs: Math.max(0, (options.now ?? Date.now)() - options.startedAtMs) }),
  });

  const terminal = (): ModelStreamEvent => {
    if (finishReason === "stop" || finishReason === "end") {
      return {
        type: "completed",
        stopReason: "stop",
        usage: finalUsage,
        response: responseMetadata(),
      };
    }
    if (finishReason === "length") {
      return {
        type: "completed",
        stopReason: "length",
        usage: finalUsage,
        partial: true,
        response: responseMetadata(),
      };
    }
    if (finishReason === "tool_calls" || finishReason === "function_call") {
      return {
        type: "completed",
        stopReason: "tool_use",
        usage: finalUsage,
        response: responseMetadata(),
      };
    }
    return {
      type: "error",
      code: "provider_finish_reason",
      message: `Provider finish reason: ${finishReason ?? "missing"}`,
      retryable: finishReason === "network_error",
      ...(emittedContent ? { partial: true } : {}),
      response: responseMetadata(),
    };
  };

  for await (const frame of frames) {
    if (options.request.signal?.aborted) {
      yield { type: "aborted", ...(emittedContent ? { partial: true } : {}) };
      return;
    }
    if (frame.data === "[DONE]") break;
    let chunk: Record<string, unknown>;
    try {
      const parsed = JSON.parse(frame.data) as unknown;
      const parsedObject = object(parsed);
      if (parsedObject === undefined) throw new Error("frame is not an object");
      chunk = parsedObject;
    } catch (error) {
      throw new OpenAiChatCodecError("Provider sent an undecodable Chat stream frame", {
        cause: error,
      });
    }

    const providerError = object(chunk.error);
    if (providerError !== undefined) {
      const code = String(providerError.code ?? providerError.type ?? "provider_error");
      const message = safeProviderMessage(
        typeof providerError.message === "string"
          ? providerError.message
          : "Provider reported a failure",
        options.secretValues,
      );
      yield {
        type: "error",
        code,
        message,
        retryable: retryableProviderCode(code),
        ...(isContextLimitError(code, message) ? { category: "context_limit" as const } : {}),
        ...(emittedContent ? { partial: true } : {}),
        response: responseMetadata(),
      };
      return;
    }

    if (typeof chunk.id === "string" && chunk.id.length > 0) responseId ??= chunk.id;
    if (typeof chunk.model === "string" && chunk.model.length > 0) routedModelId ??= chunk.model;
    if (chunk.usage !== undefined) finalUsage = usage(chunk.usage, options.model);

    if (chunk.choices === undefined) continue;
    if (!Array.isArray(chunk.choices)) {
      throw new OpenAiChatCodecError("Provider Chat stream choices must be an array");
    }
    if (chunk.choices.length === 0) continue;
    if (chunk.choices.length !== 1) {
      throw new OpenAiChatCodecError("Provider returned multiple Chat completion choices");
    }
    const choice = object(chunk.choices[0]);
    if (choice === undefined)
      throw new OpenAiChatCodecError("Provider returned a malformed Chat choice");
    if (choice.usage !== undefined && chunk.usage === undefined) {
      finalUsage = usage(choice.usage, options.model);
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
      finishReason = choice.finish_reason;
    }
    const delta = object(choice.delta);
    if (delta === undefined) continue;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      textContentIndex ??= nextContentIndex++;
      emittedContent = true;
      yield { type: "text_delta", text: delta.content, contentIndex: textContentIndex };
    }
    if (delta.reasoning_details !== undefined) {
      throw new OpenAiChatCodecError(
        "Provider returned reasoning replay metadata that the canonical stream cannot retain",
      );
    }
    for (const field of ["reasoning_content", "reasoning", "reasoning_text"]) {
      const value = delta[field];
      if (typeof value === "string" && value.length > 0) {
        thinkingContentIndex ??= nextContentIndex++;
        emittedContent = true;
        yield { type: "thinking_delta", text: value, contentIndex: thinkingContentIndex };
        break;
      }
    }

    if (delta.tool_calls === undefined) continue;
    if (!Array.isArray(delta.tool_calls)) {
      throw new OpenAiChatCodecError("Provider Chat tool call deltas must be an array");
    }
    for (const rawTool of delta.tool_calls) {
      const tool = object(rawTool);
      if (tool === undefined || !Number.isSafeInteger(tool.index) || (tool.index as number) < 0) {
        throw new OpenAiChatCodecError("Provider sent a tool call without a valid index");
      }
      const index = tool.index as number;
      let state = tools.get(index);
      if (state === undefined) {
        state = {
          index,
          contentIndex: nextContentIndex++,
          id: "",
          name: "",
          arguments: "",
          customInput: "",
          custom: false,
          started: false,
          emittedArguments: 0,
        };
        tools.set(index, state);
      }
      if (typeof tool.id === "string" && tool.id.length > 0) state.id ||= tool.id;
      const functionCall = object(tool.function);
      const customCall = object(tool.custom);
      if (typeof functionCall?.name === "string") state.name ||= functionCall.name;
      if (typeof functionCall?.arguments === "string") state.arguments += functionCall.arguments;
      if (typeof customCall?.name === "string") state.name ||= customCall.name;
      if (typeof customCall?.input === "string") {
        state.custom = true;
        state.customInput += customCall.input;
      }
      if (!state.started && state.id.length > 0 && state.name.length > 0) {
        state.started = true;
        emittedContent = true;
        yield {
          type: "tool_call_start",
          contentIndex: state.contentIndex,
          callId: state.id,
          name: reverseToolName(options.request, state.name),
        };
      }
      const argumentsText = state.custom ? state.customInput : state.arguments;
      if (state.started && argumentsText.length > state.emittedArguments) {
        const argumentsDelta = argumentsText.slice(state.emittedArguments);
        state.emittedArguments = argumentsText.length;
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
    if (!state.started) throw new OpenAiChatCodecError("Provider ended an incomplete tool call");
    let input: JsonObject;
    if (state.custom) {
      const declaration = grammarTool(options.request, state.name);
      const constraint = declaration?.preparedConstraint;
      if (constraint?.type !== "grammar") {
        throw new OpenAiChatCodecError(`Provider returned unknown custom tool ${state.name}`);
      }
      input = { [constraint.inputProperty]: state.customInput };
    } else {
      try {
        const parsed = state.arguments.length === 0 ? {} : (JSON.parse(state.arguments) as unknown);
        const parsedObject = object(parsed);
        if (parsedObject === undefined) throw new Error("arguments are not an object");
        input = parsedObject as JsonObject;
      } catch (error) {
        throw new OpenAiChatCodecError(`Tool call ${state.id} has undecodable arguments`, {
          cause: error,
        });
      }
    }
    sawToolCall = true;
    yield {
      type: "tool_call",
      contentIndex: state.contentIndex,
      callId: state.id,
      name: reverseToolName(options.request, state.name),
      input,
    };
  }
  if (sawToolCall && finishReason === "stop") finishReason = "tool_calls";
  yield terminal();
}
