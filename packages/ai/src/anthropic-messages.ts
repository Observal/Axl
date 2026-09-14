// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

// Axl-native Anthropic Messages request and streaming response codec.

import type { JsonObject, JsonValue, Usage } from "@axl/protocol";

import { safeProviderMessage } from "./diagnostics.ts";
import { isContextLimitError } from "./model-error.ts";
import type { AnthropicCompatibility, ModelInfo, ModelStreamEvent } from "./model.ts";
import {
  isPreparedModelRequest,
  type CachePlacement,
  type PreparedModelRequest,
  type PreparedRequestMessage,
} from "./request-preparation.ts";
import type { SseFrame } from "./sse.ts";
import { modelCostRates, withUsageCost } from "./usage.ts";

const ANTHROPIC_VERSION = "2023-06-01";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const RESERVED_REQUEST_FIELDS = new Set([
  "model",
  "messages",
  "system",
  "max_tokens",
  "stream",
  "tools",
  "tool_choice",
  "thinking",
  "output_config",
  "temperature",
  "top_p",
  "top_k",
  "metadata",
]);

export class AnthropicMessagesCodecError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AnthropicMessagesCodecError";
  }
}

export interface EncodedAnthropicMessagesRequest {
  readonly body: JsonObject;
  /** Protocol headers only. Authentication remains transport-owned. */
  readonly headers: Readonly<Record<string, string>>;
}

type MutableJsonObject = Record<string, JsonValue>;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compatibility(model: ModelInfo): AnthropicCompatibility {
  if (model.apiDialect !== "anthropic-messages") {
    throw new AnthropicMessagesCodecError(
      `Model ${model.modelId} does not use the anthropic-messages dialect`,
    );
  }
  if (model.compatibility?.dialect !== "anthropic-messages") {
    throw new AnthropicMessagesCodecError(
      `Model ${model.modelId} has no Anthropic Messages compatibility record`,
    );
  }
  return model.compatibility;
}

function preparedRequest(request: PreparedModelRequest): void {
  if (!isPreparedModelRequest(request)) {
    throw new AnthropicMessagesCodecError("Anthropic Messages requires a prepared model request");
  }
}

function hasPlacement(
  placements: readonly CachePlacement[],
  target: CachePlacement["target"],
  messageIndex?: number,
  contentIndex?: number,
  toolIndex?: number,
): boolean {
  return placements.some(
    (placement) =>
      placement.target === target &&
      placement.messageIndex === messageIndex &&
      placement.contentIndex === contentIndex &&
      placement.toolIndex === toolIndex,
  );
}

function cacheControl(
  model: ModelInfo,
  request: PreparedModelRequest,
): MutableJsonObject | undefined {
  const retention = request.preparation.cache.retention;
  if (retention === "none") return undefined;
  if (retention === "long" && compatibility(model).supportsLongCacheRetention !== true) {
    throw new AnthropicMessagesCodecError("Long cache retention is unsupported by this model");
  }
  return retention === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

function imageBlock(request: PreparedModelRequest, sha256: string): MutableJsonObject {
  const blob = request.preparation.blobs.get(sha256);
  if (blob === undefined) {
    throw new AnthropicMessagesCodecError(`Prepared blob ${sha256} is unavailable`);
  }
  if (
    !new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]).has(blob.reference.mediaType)
  ) {
    throw new AnthropicMessagesCodecError(
      `Anthropic Messages does not support image media type ${blob.reference.mediaType}`,
    );
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: blob.reference.mediaType,
      data: Buffer.from(blob.bytes).toString("base64"),
    },
  };
}

function basicContent(
  request: PreparedModelRequest,
  message: PreparedRequestMessage,
  messageIndex: number,
  marker: MutableJsonObject | undefined,
): JsonValue[] {
  return message.content.map((content, contentIndex): JsonValue => {
    const marked =
      marker !== undefined &&
      hasPlacement(
        request.preparation.cache.placements,
        "message-content",
        messageIndex,
        contentIndex,
      );
    const block =
      content.type === "text"
        ? ({ type: "text", text: content.text } as MutableJsonObject)
        : content.type === "blob"
          ? imageBlock(request, content.blob.sha256)
          : undefined;
    if (block === undefined) {
      throw new AnthropicMessagesCodecError("Anthropic Messages cannot encode this content block");
    }
    if (marked) block.cache_control = marker;
    return block;
  });
}

function rejectContinuation(message: PreparedRequestMessage, messageIndex: number): void {
  if (message.role !== "assistant") return;
  if (message.continuation !== undefined) {
    throw new AnthropicMessagesCodecError(
      `messages[${messageIndex}] has continuation metadata unsupported by Anthropic Messages`,
    );
  }
  for (const [contentIndex, content] of message.content.entries()) {
    if (content.type === "text" && content.continuation !== undefined) {
      throw new AnthropicMessagesCodecError(
        `messages[${messageIndex}].content[${contentIndex}] has unsupported continuation metadata`,
      );
    }
  }
  for (const [callIndex, call] of (message.toolCalls ?? []).entries()) {
    if (call.continuation !== undefined) {
      throw new AnthropicMessagesCodecError(
        `messages[${messageIndex}].toolCalls[${callIndex}] has unsupported continuation metadata`,
      );
    }
    if (call.signature !== undefined) {
      throw new AnthropicMessagesCodecError(
        `messages[${messageIndex}].toolCalls[${callIndex}] has unsupported signature metadata`,
      );
    }
  }
}

function assistantContent(
  message: Extract<PreparedRequestMessage, { role: "assistant" }>,
  messageIndex: number,
): JsonValue[] {
  rejectContinuation(message, messageIndex);
  const blocks: JsonValue[] = [];
  for (const content of message.content) {
    if (content.type === "blob") {
      throw new AnthropicMessagesCodecError(
        `messages[${messageIndex}] cannot replay an assistant image through Anthropic Messages`,
      );
    }
    if (content.type === "text") {
      if (content.text.length > 0) blocks.push({ type: "text", text: content.text });
      continue;
    }
    if (content.redacted === true) {
      if (content.signature === undefined) {
        throw new AnthropicMessagesCodecError(
          `messages[${messageIndex}] has redacted thinking without a signature`,
        );
      }
      blocks.push({ type: "redacted_thinking", data: content.signature.value });
      continue;
    }
    if (content.signature === undefined) {
      if (content.text.length > 0) blocks.push({ type: "text", text: content.text });
      continue;
    }
    blocks.push({
      type: "thinking",
      thinking: content.text,
      signature: content.signature.value,
    });
  }
  for (const call of message.toolCalls ?? []) {
    blocks.push({ type: "tool_use", id: call.callId, name: call.name, input: call.input });
  }
  if (blocks.length === 0) {
    throw new AnthropicMessagesCodecError(
      `messages[${messageIndex}] has no Anthropic-renderable assistant content`,
    );
  }
  return blocks;
}

function encodeMessages(
  request: PreparedModelRequest,
  marker: MutableJsonObject | undefined,
): JsonValue[] {
  const messages: MutableJsonObject[] = [];
  for (let messageIndex = 0; messageIndex < request.messages.length; messageIndex += 1) {
    const message = request.messages[messageIndex];
    if (message === undefined) continue;
    if (message.role === "user") {
      messages.push({
        role: "user",
        content: basicContent(request, message, messageIndex, marker),
      });
      continue;
    }
    if (message.role === "assistant") {
      messages.push({ role: "assistant", content: assistantContent(message, messageIndex) });
      continue;
    }

    const results: JsonValue[] = [];
    let resultIndex = messageIndex;
    while (resultIndex < request.messages.length) {
      const result = request.messages[resultIndex];
      if (result?.role !== "tool") break;
      const content = basicContent(request, result, resultIndex, marker);
      results.push({
        type: "tool_result",
        tool_use_id: result.callId,
        content,
        is_error: result.isError,
      });
      resultIndex += 1;
    }
    messages.push({ role: "user", content: results });
    messageIndex = resultIndex - 1;
  }
  return messages;
}

function encodeTools(
  request: PreparedModelRequest,
  marker: MutableJsonObject | undefined,
): JsonValue[] | undefined {
  if (request.tools === undefined || request.tools.length === 0) return undefined;
  return request.tools.map((tool, toolIndex): JsonValue => {
    if (tool.preparedConstraint?.type === "grammar") {
      throw new AnthropicMessagesCodecError(
        `Anthropic Messages cannot render grammar-constrained tool ${tool.canonicalName}`,
      );
    }
    const rendered: MutableJsonObject = {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
      ...(tool.preparedConstraint?.type === "json-schema" && tool.preparedConstraint.strict
        ? { strict: true }
        : {}),
    };
    if (
      marker !== undefined &&
      hasPlacement(request.preparation.cache.placements, "tool", undefined, undefined, toolIndex)
    ) {
      rendered.cache_control = marker;
    }
    return rendered;
  });
}

function applyThinking(
  body: MutableJsonObject,
  model: ModelInfo,
  request: PreparedModelRequest,
): boolean {
  const reasoning = request.preparation.reasoning;
  if (reasoning === undefined) return false;
  if (reasoning.effective === "off") {
    body.thinking = { type: "disabled" };
    return false;
  }
  const compat = compatibility(model);
  if (compat.forceAdaptiveThinking === true) {
    body.thinking = { type: "adaptive", display: "summarized" };
    body.output_config = { effort: reasoning.providerValue ?? reasoning.effective };
    return true;
  }
  if (reasoning.tokenBudget === undefined) {
    throw new AnthropicMessagesCodecError(
      "Anthropic budget-based thinking requires a prepared token budget",
    );
  }
  body.thinking = {
    type: "enabled",
    budget_tokens: reasoning.tokenBudget,
    display: "summarized",
  };
  return true;
}

function applySampling(body: MutableJsonObject, request: PreparedModelRequest): void {
  const sampling = request.sampling;
  if (sampling === undefined) return;
  if (sampling.temperature !== undefined) body.temperature = sampling.temperature;
  if (sampling.topP !== undefined) body.top_p = sampling.topP;
  if (sampling.topK !== undefined) body.top_k = sampling.topK;
  for (const [field, value] of Object.entries(sampling.custom ?? {})) {
    if (RESERVED_REQUEST_FIELDS.has(field) || field in body) {
      throw new AnthropicMessagesCodecError(
        `Custom sampling field ${field} collides with an Anthropic request field`,
      );
    }
    body[field] = value;
  }
}

/** Encodes only a validated, immutable prepared request. */
export function encodeAnthropicMessagesRequest(
  model: ModelInfo,
  request: PreparedModelRequest,
): EncodedAnthropicMessagesRequest {
  preparedRequest(request);
  const compat = compatibility(model);
  if (request.modelId !== model.modelId) {
    throw new AnthropicMessagesCodecError(
      `Request model ${request.modelId} does not match ${model.modelId}`,
    );
  }
  const metadata = request.metadata;
  if (metadata !== undefined && Object.keys(metadata).some((key) => key !== "user_id")) {
    throw new AnthropicMessagesCodecError("Anthropic Messages supports only metadata.user_id");
  }
  if (metadata?.user_id !== undefined && typeof metadata.user_id !== "string") {
    throw new AnthropicMessagesCodecError("Anthropic Messages metadata.user_id must be a string");
  }

  const marker = cacheControl(model, request);
  const body: MutableJsonObject = {
    model: model.modelId,
    messages: encodeMessages(request, marker),
    max_tokens: request.maxOutputTokens ?? model.maxOutputTokens,
    stream: true,
  };
  if (request.system !== undefined && request.system.length > 0) {
    body.system = [
      {
        type: "text",
        text: request.system,
        ...(marker !== undefined && hasPlacement(request.preparation.cache.placements, "system")
          ? { cache_control: marker }
          : {}),
      },
    ];
  }
  const tools = encodeTools(request, marker);
  if (tools !== undefined) body.tools = tools;
  if (request.toolChoice !== undefined) {
    if (request.toolChoice !== "none" && tools === undefined) {
      throw new AnthropicMessagesCodecError(
        `toolChoice ${request.toolChoice} needs at least one tool`,
      );
    }
    body.tool_choice = {
      type: request.toolChoice === "required" ? "any" : request.toolChoice,
    };
  }
  const thinkingEnabled = applyThinking(body, model, request);
  applySampling(body, request);
  if (metadata?.user_id !== undefined) body.metadata = { user_id: metadata.user_id };

  const headers: Record<string, string> = {
    accept: "text/event-stream",
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (thinkingEnabled && compat.forceAdaptiveThinking !== true) {
    headers["anthropic-beta"] = INTERLEAVED_THINKING_BETA;
  }
  return { body, headers };
}

interface TextBlock {
  readonly type: "text";
  readonly providerIndex: number;
  readonly contentIndex: number;
}

interface ThinkingBlock {
  readonly type: "thinking";
  readonly providerIndex: number;
  readonly contentIndex: number;
  readonly redacted: boolean;
  signature: string;
}

interface ToolBlock {
  readonly type: "tool";
  readonly providerIndex: number;
  readonly contentIndex: number;
  readonly callId: string;
  readonly wireName: string;
  argumentsText: string;
}

type Block = TextBlock | ThinkingBlock | ToolBlock;

function numberField(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AnthropicMessagesCodecError(`Anthropic usage ${name} must be non-negative`);
  }
  return value;
}

interface AnthropicUsageState {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  reasoning: number;
}

function mergeUsage(state: AnthropicUsageState, raw: unknown): void {
  if (raw === undefined) return;
  const value = object(raw);
  if (value === undefined)
    throw new AnthropicMessagesCodecError("Anthropic usage must be an object");
  const input = numberField(value.input_tokens, "input_tokens");
  const output = numberField(value.output_tokens, "output_tokens");
  const cacheRead = numberField(value.cache_read_input_tokens, "cache_read_input_tokens");
  const cacheWrite = numberField(value.cache_creation_input_tokens, "cache_creation_input_tokens");
  const details = object(value.cache_creation);
  const outputDetails = object(value.output_tokens_details);
  const cacheWrite1h = numberField(details?.ephemeral_1h_input_tokens, "ephemeral_1h_input_tokens");
  const reasoning = numberField(outputDetails?.thinking_tokens, "thinking_tokens");
  if (input !== undefined) state.input = input;
  if (output !== undefined) state.output = output;
  if (cacheRead !== undefined) state.cacheRead = cacheRead;
  if (cacheWrite !== undefined) state.cacheWrite = cacheWrite;
  if (cacheWrite1h !== undefined) state.cacheWrite1h = cacheWrite1h;
  if (reasoning !== undefined) state.reasoning = reasoning;
}

function usage(state: AnthropicUsageState, model: ModelInfo): Usage {
  const mapped: Usage = {
    inputTokens: state.input,
    outputTokens: state.output,
    cacheReadTokens: state.cacheRead,
    cacheWriteTokens: state.cacheWrite,
    reasoningTokens: state.reasoning,
  };
  if (model.cost === undefined) return mapped;
  if (state.cacheWrite1h <= 0) return withUsageCost(model.cost, mapped);
  if (state.cacheWrite1h > state.cacheWrite) {
    throw new AnthropicMessagesCodecError(
      "Anthropic 1h cache write tokens exceed total cache write tokens",
    );
  }
  const rates = modelCostRates(model.cost, mapped);
  const shortWrite = state.cacheWrite - state.cacheWrite1h;
  return {
    ...mapped,
    costUsd:
      (rates.inputUsdPerMTok * state.input +
        rates.outputUsdPerMTok * state.output +
        (rates.cacheReadUsdPerMTok ?? 0) * state.cacheRead +
        (rates.cacheWriteUsdPerMTok ?? 0) * shortWrite +
        rates.inputUsdPerMTok * 2 * state.cacheWrite1h) /
      1_000_000,
  };
}

function reverseToolName(request: PreparedModelRequest, name: string): string {
  return request.preparation.tools.find((tool) => tool.name === name)?.canonicalName ?? name;
}

function retryableProviderCode(code: string): boolean {
  return new Set(["api_error", "overloaded_error", "rate_limit_error", "timeout_error"]).has(code);
}

function parseFrame(frame: SseFrame): Record<string, unknown> | undefined {
  if (frame.event === "ping") return undefined;
  try {
    const parsed = JSON.parse(frame.data) as unknown;
    const value = object(parsed);
    if (value === undefined) throw new Error("frame is not an object");
    return value;
  } catch (error) {
    throw new AnthropicMessagesCodecError("Provider sent an undecodable Anthropic stream frame", {
      cause: error,
    });
  }
}

export interface AnthropicMessagesDecodeOptions {
  readonly model: ModelInfo;
  readonly request: PreparedModelRequest;
  readonly startedAtMs?: number;
  readonly now?: () => number;
  readonly secretValues?: readonly string[];
}

/** Decodes Anthropic Messages SSE frames into canonical stream events. */
export async function* decodeAnthropicMessagesStream(
  frames: AsyncIterable<SseFrame>,
  options: AnthropicMessagesDecodeOptions,
): AsyncGenerator<ModelStreamEvent, void, undefined> {
  preparedRequest(options.request);
  compatibility(options.model);
  const blocks = new Map<number, Block>();
  const usageState: AnthropicUsageState = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    reasoning: 0,
  };
  let responseId: string | undefined;
  let routedModelId: string | undefined;
  let stopReason: string | undefined;
  let stopDetails: Record<string, unknown> | undefined;
  let emittedContent = false;
  let nextContentIndex = 0;

  const responseMetadata = () => ({
    providerId: options.model.providerId,
    requestedModelId: options.request.modelId,
    ...(routedModelId === undefined ? {} : { routedModelId }),
    ...(responseId === undefined ? {} : { responseId }),
    ...(stopReason === undefined ? {} : { nativeStopReason: stopReason }),
    ...(options.startedAtMs === undefined
      ? {}
      : { latencyMs: Math.max(0, (options.now ?? Date.now)() - options.startedAtMs) }),
  });

  for await (const frame of frames) {
    if (options.request.signal?.aborted) {
      yield { type: "aborted", ...(emittedContent ? { partial: true } : {}) };
      return;
    }
    if (
      frame.event !== undefined &&
      !new Set([
        "message_start",
        "message_delta",
        "message_stop",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "error",
      ]).has(frame.event)
    ) {
      continue;
    }
    const event = parseFrame(frame);
    if (event === undefined) continue;
    const type = typeof event.type === "string" ? event.type : frame.event;

    if (type === "error") {
      const providerError = object(event.error) ?? event;
      const code = String(providerError.type ?? providerError.code ?? "provider_error");
      const message = safeProviderMessage(
        typeof providerError.message === "string"
          ? providerError.message
          : "Anthropic reported a failure",
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

    if (type === "message_start") {
      const message = object(event.message);
      if (message === undefined) {
        throw new AnthropicMessagesCodecError("Anthropic message_start has no message object");
      }
      if (typeof message.id === "string" && message.id.length > 0) responseId = message.id;
      if (typeof message.model === "string" && message.model.length > 0)
        routedModelId = message.model;
      mergeUsage(usageState, message.usage);
      continue;
    }

    if (type === "content_block_start") {
      if (!Number.isSafeInteger(event.index) || (event.index as number) < 0) {
        throw new AnthropicMessagesCodecError("Anthropic content block has no valid index");
      }
      const providerIndex = event.index as number;
      if (blocks.has(providerIndex)) {
        throw new AnthropicMessagesCodecError(
          `Anthropic content block ${providerIndex} started twice`,
        );
      }
      const content = object(event.content_block);
      if (content === undefined || typeof content.type !== "string") {
        throw new AnthropicMessagesCodecError("Anthropic content block start is malformed");
      }
      const contentIndex = nextContentIndex++;
      if (content.type === "text") {
        blocks.set(providerIndex, { type: "text", providerIndex, contentIndex });
        if (typeof content.text === "string" && content.text.length > 0) {
          emittedContent = true;
          yield { type: "text_delta", text: content.text, contentIndex };
        }
      } else if (content.type === "thinking") {
        const signature = typeof content.signature === "string" ? content.signature : "";
        blocks.set(providerIndex, {
          type: "thinking",
          providerIndex,
          contentIndex,
          redacted: false,
          signature,
        });
        if (typeof content.thinking === "string" && content.thinking.length > 0) {
          emittedContent = true;
          yield { type: "thinking_delta", text: content.thinking, contentIndex };
        }
      } else if (content.type === "redacted_thinking") {
        if (typeof content.data !== "string" || content.data.length === 0) {
          throw new AnthropicMessagesCodecError("Anthropic redacted thinking has no signature");
        }
        blocks.set(providerIndex, {
          type: "thinking",
          providerIndex,
          contentIndex,
          redacted: true,
          signature: content.data,
        });
        emittedContent = true;
        yield { type: "thinking_delta", text: "[Reasoning redacted]", contentIndex };
      } else if (content.type === "tool_use") {
        if (
          typeof content.id !== "string" ||
          content.id.length === 0 ||
          typeof content.name !== "string" ||
          content.name.length === 0
        ) {
          throw new AnthropicMessagesCodecError("Anthropic tool use start is malformed");
        }
        const input = object(content.input);
        if (content.input !== undefined && input === undefined) {
          throw new AnthropicMessagesCodecError("Anthropic tool use input must be an object");
        }
        const argumentsText =
          input === undefined || Object.keys(input).length === 0 ? "" : JSON.stringify(input);
        blocks.set(providerIndex, {
          type: "tool",
          providerIndex,
          contentIndex,
          callId: content.id,
          wireName: content.name,
          argumentsText,
        });
        emittedContent = true;
        yield {
          type: "tool_call_start",
          contentIndex,
          callId: content.id,
          name: reverseToolName(options.request, content.name),
        };
      }
      continue;
    }

    if (type === "content_block_delta") {
      if (!Number.isSafeInteger(event.index) || (event.index as number) < 0) {
        throw new AnthropicMessagesCodecError("Anthropic content delta has no valid index");
      }
      const block = blocks.get(event.index as number);
      if (block === undefined) {
        throw new AnthropicMessagesCodecError(
          `Anthropic delta targets unknown block ${String(event.index)}`,
        );
      }
      const delta = object(event.delta);
      if (delta === undefined || typeof delta.type !== "string") {
        throw new AnthropicMessagesCodecError("Anthropic content delta is malformed");
      }
      if (delta.type === "text_delta") {
        if (block.type !== "text" || typeof delta.text !== "string") {
          throw new AnthropicMessagesCodecError("Anthropic text delta targets a non-text block");
        }
        if (delta.text.length > 0) {
          emittedContent = true;
          yield { type: "text_delta", text: delta.text, contentIndex: block.contentIndex };
        }
      } else if (delta.type === "thinking_delta") {
        if (block.type !== "thinking" || typeof delta.thinking !== "string") {
          throw new AnthropicMessagesCodecError(
            "Anthropic thinking delta targets a non-thinking block",
          );
        }
        if (delta.thinking.length > 0) {
          emittedContent = true;
          yield {
            type: "thinking_delta",
            text: delta.thinking,
            contentIndex: block.contentIndex,
          };
        }
      } else if (delta.type === "signature_delta") {
        if (block.type !== "thinking" || typeof delta.signature !== "string") {
          throw new AnthropicMessagesCodecError(
            "Anthropic signature delta targets a non-thinking block",
          );
        }
        block.signature += delta.signature;
      } else if (delta.type === "input_json_delta") {
        if (block.type !== "tool" || typeof delta.partial_json !== "string") {
          throw new AnthropicMessagesCodecError(
            "Anthropic tool input delta targets a non-tool block",
          );
        }
        block.argumentsText += delta.partial_json;
        if (delta.partial_json.length > 0) {
          yield {
            type: "tool_call_delta",
            contentIndex: block.contentIndex,
            callId: block.callId,
            argumentsDelta: delta.partial_json,
          };
        }
      }
      continue;
    }

    if (type === "content_block_stop") {
      if (!Number.isSafeInteger(event.index) || (event.index as number) < 0) {
        throw new AnthropicMessagesCodecError("Anthropic content stop has no valid index");
      }
      const block = blocks.get(event.index as number);
      if (block === undefined) {
        throw new AnthropicMessagesCodecError(
          `Anthropic stopped unknown block ${String(event.index)}`,
        );
      }
      blocks.delete(event.index as number);
      if (block.type === "thinking" && block.signature.length > 0) {
        yield {
          type: "replay_metadata",
          target: "thinking",
          contentIndex: block.contentIndex,
          providerId: options.model.providerId,
          apiDialect: options.model.apiDialect,
          modelId: options.request.modelId,
          signature: block.signature,
          ...(block.redacted ? { redacted: true } : {}),
        };
      } else if (block.type === "tool") {
        let input: JsonObject;
        try {
          const parsed =
            block.argumentsText.length === 0 ? {} : (JSON.parse(block.argumentsText) as unknown);
          const parsedObject = object(parsed);
          if (parsedObject === undefined) throw new Error("tool input is not an object");
          input = parsedObject as JsonObject;
        } catch (error) {
          throw new AnthropicMessagesCodecError(
            `Tool call ${block.callId} has undecodable arguments`,
            { cause: error },
          );
        }
        yield {
          type: "tool_call",
          contentIndex: block.contentIndex,
          callId: block.callId,
          name: reverseToolName(options.request, block.wireName),
          input,
        };
      }
      continue;
    }

    if (type === "message_delta") {
      const delta = object(event.delta);
      if (delta === undefined) {
        throw new AnthropicMessagesCodecError("Anthropic message_delta has no delta object");
      }
      if (delta.stop_reason !== undefined && delta.stop_reason !== null) {
        if (typeof delta.stop_reason !== "string" || delta.stop_reason.length === 0) {
          throw new AnthropicMessagesCodecError("Anthropic stop reason is malformed");
        }
        stopReason = delta.stop_reason;
      }
      if (delta.stop_details !== undefined && delta.stop_details !== null) {
        stopDetails = object(delta.stop_details);
        if (stopDetails === undefined) {
          throw new AnthropicMessagesCodecError("Anthropic stop details are malformed");
        }
      }
      mergeUsage(usageState, event.usage);
      continue;
    }

    if (type === "message_stop") {
      if (blocks.size > 0) {
        throw new AnthropicMessagesCodecError("Anthropic stopped with incomplete content blocks");
      }
      if (stopReason === undefined) {
        throw new AnthropicMessagesCodecError("Anthropic stream ended without a stop reason");
      }
      const finalUsage = usage(usageState, options.model);
      if (
        stopReason === "end_turn" ||
        stopReason === "stop_sequence" ||
        stopReason === "pause_turn"
      ) {
        yield {
          type: "completed",
          stopReason: "stop",
          usage: finalUsage,
          response: responseMetadata(),
        };
        return;
      }
      if (stopReason === "max_tokens") {
        yield {
          type: "completed",
          stopReason: "length",
          usage: finalUsage,
          partial: true,
          response: responseMetadata(),
        };
        return;
      }
      if (stopReason === "tool_use") {
        yield {
          type: "completed",
          stopReason: "tool_use",
          usage: finalUsage,
          response: responseMetadata(),
        };
        return;
      }
      if (stopReason === "refusal" || stopReason === "sensitive") {
        const explanation =
          typeof stopDetails?.explanation === "string"
            ? stopDetails.explanation
            : `Provider stopped with: ${stopReason}`;
        yield {
          type: "error",
          code: stopReason,
          message: safeProviderMessage(explanation, options.secretValues),
          retryable: false,
          ...(emittedContent ? { partial: true } : {}),
          response: responseMetadata(),
        };
        return;
      }
      throw new AnthropicMessagesCodecError(`Unhandled Anthropic stop reason: ${stopReason}`);
    }
  }

  if (options.request.signal?.aborted) {
    yield { type: "aborted", ...(emittedContent ? { partial: true } : {}) };
  }
}
