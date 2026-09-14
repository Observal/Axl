// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

// Transport-neutral Amazon Bedrock Converse Stream request and event codec.

import type { JsonObject, JsonValue, Usage } from "@axl/protocol";

import { safeProviderMessage } from "./diagnostics.ts";
import { isContextLimitError } from "./model-error.ts";
import type { BedrockCompatibility, ModelInfo, ModelStreamEvent } from "./model.ts";
import {
  isPreparedModelRequest,
  type PreparedModelRequest,
  type PreparedRequestMessage,
} from "./request-preparation.ts";
import { stripTrailingSlashes } from "./transport-safety.ts";
import { withUsageCost } from "./usage.ts";

const EMPTY_TEXT_PLACEHOLDER = "<empty>";
const REDACTED_THINKING_PLACEHOLDER = "[Reasoning redacted]";
const REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const RESERVED_REQUEST_FIELDS = new Set(["thinking", "output_config", "anthropic_beta"]);

export class BedrockConverseStreamCodecError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BedrockConverseStreamCodecError";
  }
}

export type BedrockAuthenticationPolicy =
  | { readonly type: "sigv4" }
  | { readonly type: "bearer"; readonly token: string };

export interface BedrockRequestPolicy {
  readonly region?: string;
  readonly baseUrl?: string;
  readonly authentication: BedrockAuthenticationPolicy;
  readonly thinkingDisplay?: "summarized" | "omitted";
  readonly interleavedThinking?: boolean;
}

export interface AwsSigningInputs {
  readonly service: "bedrock";
  readonly region: string;
}

export interface EncodedBedrockConverseStreamRequest {
  readonly method: "POST";
  readonly url: string;
  readonly body: JsonObject;
  readonly headers: Readonly<Record<string, string>>;
  /** Credentials and the signature itself are supplied by the transport layer. */
  readonly signing?: AwsSigningInputs;
}

export type BedrockConverseStreamEvent = Readonly<Record<string, unknown>>;

export interface BedrockConverseStreamDecodeOptions {
  readonly model: ModelInfo;
  readonly request: PreparedModelRequest;
  readonly responseId?: string;
  readonly routedModelId?: string;
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

function compatibility(model: ModelInfo): BedrockCompatibility {
  if (model.apiDialect !== "bedrock-converse-stream") {
    throw new BedrockConverseStreamCodecError(
      `Model ${model.modelId} does not use the bedrock-converse-stream dialect`,
    );
  }
  if (model.compatibility?.dialect !== "bedrock-converse-stream") {
    throw new BedrockConverseStreamCodecError(
      `Model ${model.modelId} has no Bedrock Converse Stream compatibility record`,
    );
  }
  return model.compatibility;
}

function requirePrepared(request: PreparedModelRequest): void {
  if (!isPreparedModelRequest(request)) {
    throw new BedrockConverseStreamCodecError(
      "Bedrock Converse Stream requires a prepared model request",
    );
  }
}

function nonEmpty(value: string | undefined, label: string): string {
  const result = value?.trim();
  if (!result) throw new BedrockConverseStreamCodecError(`Bedrock ${label} is required`);
  return result;
}

function regionFromModelId(modelId: string): string | undefined {
  const match = modelId.match(/^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/);
  return match?.[1];
}

function resolvedRegion(modelId: string, configured: string | undefined): string {
  const region = regionFromModelId(modelId) ?? nonEmpty(configured, "region");
  if (!REGION_PATTERN.test(region)) {
    throw new BedrockConverseStreamCodecError("Bedrock region is invalid");
  }
  return region;
}

function requestUrl(modelId: string, baseUrl: string | undefined, region: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl ?? `https://bedrock-runtime.${region}.amazonaws.com`);
  } catch (cause) {
    throw new BedrockConverseStreamCodecError("Bedrock base URL is invalid", { cause });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BedrockConverseStreamCodecError("Bedrock base URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.hash) {
    throw new BedrockConverseStreamCodecError("Bedrock base URL contains unsupported URL data");
  }
  url.pathname = `${stripTrailingSlashes(url.pathname)}/model/${encodeURIComponent(
    nonEmpty(modelId, "model ID"),
  )}/converse-stream`;
  return url.toString();
}

function headerValue(value: string, label: string): string {
  const result = nonEmpty(value, label);
  if (/\r|\n/.test(result)) {
    throw new BedrockConverseStreamCodecError(`Bedrock ${label} contains invalid characters`);
  }
  return result;
}

function imageFormat(mediaType: string): "jpeg" | "png" | "gif" | "webp" {
  if (mediaType === "image/jpeg" || mediaType === "image/jpg") return "jpeg";
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/gif") return "gif";
  if (mediaType === "image/webp") return "webp";
  throw new BedrockConverseStreamCodecError(
    `Bedrock does not support image media type ${mediaType}`,
  );
}

function contentBlock(
  request: PreparedModelRequest,
  content: Extract<PreparedRequestMessage, { role: "user" | "tool" }>["content"][number],
): JsonObject | undefined {
  if (content.type === "text") {
    return content.text.trim().length === 0 ? undefined : { text: content.text };
  }
  const blob = request.preparation.blobs.get(content.blob.sha256);
  if (blob === undefined) {
    throw new BedrockConverseStreamCodecError(
      `Prepared blob ${content.blob.sha256} is unavailable`,
    );
  }
  return {
    image: {
      format: imageFormat(blob.reference.mediaType),
      source: { bytes: Buffer.from(blob.bytes).toString("base64") },
    },
  };
}

function basicContent(
  request: PreparedModelRequest,
  message: Extract<PreparedRequestMessage, { role: "user" | "tool" }>,
): JsonObject[] {
  const result = message.content.flatMap((content) => {
    const block = contentBlock(request, content);
    return block === undefined ? [] : [block];
  });
  return result.length === 0 ? [{ text: EMPTY_TEXT_PLACEHOLDER }] : result;
}

function sanitizeDocument(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sanitizeDocument);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key.length > 0)
        .map(([key, item]) => [key, sanitizeDocument(item)]),
    );
  }
  return value;
}

function assistantContent(
  model: ModelInfo,
  message: Extract<PreparedRequestMessage, { role: "assistant" }>,
  messageIndex: number,
): JsonObject[] {
  const compat = compatibility(model);
  if (message.continuation !== undefined) {
    throw new BedrockConverseStreamCodecError(
      `messages[${messageIndex}] has continuation metadata unsupported by Bedrock`,
    );
  }
  const result: JsonObject[] = [];
  for (const [contentIndex, content] of message.content.entries()) {
    if (content.type === "blob") {
      throw new BedrockConverseStreamCodecError(
        `messages[${messageIndex}].content[${contentIndex}] cannot replay an assistant image`,
      );
    }
    if (content.type === "text") {
      if (content.continuation !== undefined) {
        throw new BedrockConverseStreamCodecError(
          `messages[${messageIndex}].content[${contentIndex}] has unsupported continuation metadata`,
        );
      }
      if (content.text.trim().length > 0) result.push({ text: content.text });
      continue;
    }
    if (content.redacted === true) {
      if (content.signature === undefined) {
        throw new BedrockConverseStreamCodecError(
          `messages[${messageIndex}].content[${contentIndex}] has redacted reasoning without a signature`,
        );
      }
      result.push({ reasoningContent: { redactedContent: content.signature.value } });
      continue;
    }
    if (content.signature !== undefined && compat.supportsThinkingSignatures === true) {
      result.push({
        reasoningContent: {
          reasoningText: { text: content.text, signature: content.signature.value },
        },
      });
    } else if (compat.supportsThinkingSignatures === true) {
      if (content.text.trim().length > 0) result.push({ text: content.text });
    } else if (content.text.trim().length > 0) {
      result.push({ reasoningContent: { reasoningText: { text: content.text } } });
    }
  }
  for (const [callIndex, call] of (message.toolCalls ?? []).entries()) {
    if (call.continuation !== undefined || call.signature !== undefined) {
      throw new BedrockConverseStreamCodecError(
        `messages[${messageIndex}].toolCalls[${callIndex}] has unsupported replay metadata`,
      );
    }
    result.push({
      toolUse: { toolUseId: call.callId, name: call.name, input: sanitizeDocument(call.input) },
    });
  }
  if (result.length === 0) {
    throw new BedrockConverseStreamCodecError(
      `messages[${messageIndex}] has no Bedrock-renderable assistant content`,
    );
  }
  return result;
}

function encodeMessages(model: ModelInfo, request: PreparedModelRequest): JsonObject[] {
  const messages: MutableJsonObject[] = [];
  for (let index = 0; index < request.messages.length; index += 1) {
    const message = request.messages[index];
    if (message === undefined) continue;
    if (message.role === "user") {
      messages.push({ role: "user", content: basicContent(request, message) });
      continue;
    }
    if (message.role === "assistant") {
      messages.push({ role: "assistant", content: assistantContent(model, message, index) });
      continue;
    }
    const results: JsonObject[] = [];
    let resultIndex = index;
    while (resultIndex < request.messages.length) {
      const result = request.messages[resultIndex];
      if (result?.role !== "tool") break;
      results.push({
        toolResult: {
          toolUseId: result.callId,
          content: basicContent(request, result),
          status: result.isError ? "error" : "success",
        },
      });
      resultIndex += 1;
    }
    messages.push({ role: "user", content: results });
    index = resultIndex - 1;
  }

  if (
    request.preparation.cache.retention !== "none" &&
    compatibility(model).supportsPromptCacheMarkers === true
  ) {
    const lastUser = messages.findLast((message) => message.role === "user");
    const content = lastUser?.content;
    if (Array.isArray(content)) {
      content.push({
        cachePoint: {
          type: "default",
          ...(request.preparation.cache.retention === "long" ? { ttl: "1h" } : {}),
        },
      });
    }
  }
  return messages;
}

function encodeTools(request: PreparedModelRequest): JsonObject[] | undefined {
  if (request.tools === undefined || request.tools.length === 0) return undefined;
  return request.tools.map((tool) => {
    if (tool.preparedConstraint?.type === "grammar") {
      throw new BedrockConverseStreamCodecError(
        `Bedrock cannot render grammar-constrained tool ${tool.canonicalName}`,
      );
    }
    return {
      toolSpec: {
        name: tool.name,
        description: tool.description,
        inputSchema: { json: tool.inputSchema },
        ...(tool.preparedConstraint?.type === "json-schema" && tool.preparedConstraint.strict
          ? { strict: true }
          : {}),
      },
    };
  });
}

function additionalFields(
  model: ModelInfo,
  request: PreparedModelRequest,
  policy: BedrockRequestPolicy,
): JsonObject | undefined {
  const result: MutableJsonObject = {};
  for (const [key, value] of Object.entries(request.sampling?.custom ?? {})) {
    if (RESERVED_REQUEST_FIELDS.has(key)) {
      throw new BedrockConverseStreamCodecError(
        `Custom sampling field ${key} collides with a Bedrock request field`,
      );
    }
    result[key] = value;
  }
  const reasoning = request.preparation.reasoning;
  const compat = compatibility(model);
  if (
    reasoning !== undefined &&
    reasoning.effective !== "off" &&
    compat.supportsThinkingSignatures === true
  ) {
    if (
      policy.thinkingDisplay !== undefined &&
      policy.thinkingDisplay !== "summarized" &&
      policy.thinkingDisplay !== "omitted"
    ) {
      throw new BedrockConverseStreamCodecError("Bedrock thinking display is invalid");
    }
    const govCloud =
      resolvedRegion(model.modelId, policy.region).startsWith("us-gov-") ||
      model.modelId.toLowerCase().startsWith("us-gov.");
    const display = govCloud ? undefined : (policy.thinkingDisplay ?? "summarized");
    if (compat.forceAdaptiveThinking === true) {
      result.thinking = {
        type: "adaptive",
        ...(display === undefined ? {} : { display }),
      };
      result.output_config = { effort: reasoning.providerValue ?? reasoning.effective };
    } else {
      if (reasoning.tokenBudget === undefined) {
        throw new BedrockConverseStreamCodecError(
          "Bedrock Claude thinking requires a prepared token budget",
        );
      }
      result.thinking = {
        type: "enabled",
        budget_tokens: reasoning.tokenBudget,
        ...(display === undefined ? {} : { display }),
      };
      if (policy.interleavedThinking !== false) {
        result.anthropic_beta = ["interleaved-thinking-2025-05-14"];
      }
    }
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function requestMetadata(metadata: PreparedModelRequest["metadata"]): JsonObject | undefined {
  if (metadata === undefined) return undefined;
  const entries = Object.entries(metadata);
  if (entries.length > 50) {
    throw new BedrockConverseStreamCodecError("Bedrock request metadata exceeds 50 entries");
  }
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > 64 || key.toLowerCase().startsWith("aws:")) {
      throw new BedrockConverseStreamCodecError(`Bedrock request metadata key ${key} is invalid`);
    }
    if (typeof value !== "string" || value.length > 256) {
      throw new BedrockConverseStreamCodecError(
        `Bedrock request metadata value for ${key} must be a string of at most 256 characters`,
      );
    }
    result[key] = value;
  }
  return result;
}

/** Encodes a prepared request and the non-secret inputs required by AWS SigV4. */
export function encodeBedrockConverseStreamRequest(
  model: ModelInfo,
  request: PreparedModelRequest,
  policy: BedrockRequestPolicy,
): EncodedBedrockConverseStreamRequest {
  requirePrepared(request);
  compatibility(model);
  if (request.modelId !== model.modelId) {
    throw new BedrockConverseStreamCodecError(
      `Request model ${request.modelId} does not match ${model.modelId}`,
    );
  }
  if (typeof policy !== "object" || policy === null) {
    throw new BedrockConverseStreamCodecError("Bedrock request policy is invalid");
  }
  const region = resolvedRegion(model.modelId, policy.region);
  const body: MutableJsonObject = { messages: encodeMessages(model, request) };
  if (request.system !== undefined && request.system.trim().length > 0) {
    body.system = [
      { text: request.system },
      ...(request.preparation.cache.retention !== "none" &&
      compatibility(model).supportsPromptCacheMarkers === true
        ? [
            {
              cachePoint: {
                type: "default",
                ...(request.preparation.cache.retention === "long" ? { ttl: "1h" } : {}),
              },
            },
          ]
        : []),
    ];
  }
  const inferenceConfig: MutableJsonObject = {};
  const maxTokens =
    request.maxOutputTokens ??
    (compatibility(model).supportsThinkingSignatures === true ? model.maxOutputTokens : undefined);
  if (maxTokens !== undefined) inferenceConfig.maxTokens = maxTokens;
  if (request.sampling?.temperature !== undefined)
    inferenceConfig.temperature = request.sampling.temperature;
  if (request.sampling?.topP !== undefined) inferenceConfig.topP = request.sampling.topP;
  if (Object.keys(inferenceConfig).length > 0) body.inferenceConfig = inferenceConfig;
  const tools = request.toolChoice === "none" ? undefined : encodeTools(request);
  if (tools !== undefined) {
    body.toolConfig = {
      tools,
      ...(request.toolChoice === undefined
        ? {}
        : {
            toolChoice:
              request.toolChoice === "required"
                ? { any: {} }
                : request.toolChoice === "auto"
                  ? { auto: {} }
                  : {},
          }),
    };
  } else if (request.toolChoice !== undefined && request.toolChoice !== "none") {
    throw new BedrockConverseStreamCodecError(
      `toolChoice ${request.toolChoice} needs at least one tool`,
    );
  }
  const extra = additionalFields(model, request, policy);
  if (extra !== undefined) body.additionalModelRequestFields = extra;
  const metadata = requestMetadata(request.metadata);
  if (metadata !== undefined) body.requestMetadata = metadata;

  const headers: Record<string, string> = {
    accept: "application/vnd.amazon.eventstream",
    "content-type": "application/json",
  };
  let signing: AwsSigningInputs | undefined;
  if (typeof policy.authentication !== "object" || policy.authentication === null) {
    throw new BedrockConverseStreamCodecError("Bedrock authentication policy is invalid");
  }
  if (policy.authentication.type === "bearer") {
    headers.authorization = `Bearer ${headerValue(policy.authentication.token, "bearer token")}`;
  } else if (policy.authentication.type === "sigv4") {
    signing = { service: "bedrock", region };
  } else {
    throw new BedrockConverseStreamCodecError("Bedrock authentication policy is invalid");
  }
  return {
    method: "POST",
    url: requestUrl(model.modelId, policy.baseUrl, region),
    body,
    headers,
    ...(signing === undefined ? {} : { signing }),
  };
}

interface TextBlock {
  readonly type: "text";
  readonly contentIndex: number;
}

interface ThinkingBlock {
  readonly type: "thinking";
  readonly contentIndex: number;
  signature: string;
  redacted: boolean;
  redactedChunks: Uint8Array[];
}

interface ToolBlock {
  readonly type: "tool";
  readonly contentIndex: number;
  readonly callId: string;
  readonly wireName: string;
  argumentsText: string;
}

type ActiveBlock = TextBlock | ThinkingBlock | ToolBlock;

function eventIndex(event: Record<string, unknown>, label: string): number {
  if (!Number.isSafeInteger(event.contentBlockIndex) || (event.contentBlockIndex as number) < 0) {
    throw new BedrockConverseStreamCodecError(`Bedrock ${label} has no valid content block index`);
  }
  return event.contentBlockIndex as number;
}

function reverseToolName(request: PreparedModelRequest, name: string): string {
  return request.preparation.tools.find((tool) => tool.name === name)?.canonicalName ?? name;
}

function bytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return undefined;
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

function base64(chunks: readonly Uint8Array[]): string {
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("base64");
}

function nonNegative(value: unknown, label: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new BedrockConverseStreamCodecError(`Bedrock usage ${label} must be non-negative`);
  }
  return value;
}

function mapUsage(raw: unknown, model: ModelInfo): Usage {
  const value = object(raw);
  if (value === undefined)
    throw new BedrockConverseStreamCodecError("Bedrock usage must be an object");
  const mapped: Usage = {
    inputTokens: nonNegative(value.inputTokens, "inputTokens"),
    outputTokens: nonNegative(value.outputTokens, "outputTokens"),
    cacheReadTokens: nonNegative(value.cacheReadInputTokens, "cacheReadInputTokens"),
    cacheWriteTokens: nonNegative(value.cacheWriteInputTokens, "cacheWriteInputTokens"),
    reasoningTokens: 0,
  };
  return model.cost === undefined ? mapped : withUsageCost(model.cost, mapped);
}

function stopReason(reason: string): "stop" | "length" | "tool_use" | "error" {
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  if (reason === "max_tokens" || reason === "model_context_window_exceeded") return "length";
  if (reason === "tool_use") return "tool_use";
  return "error";
}

function exception(event: Record<string, unknown>): { code: string; value: unknown } | undefined {
  for (const code of [
    "internalServerException",
    "modelStreamErrorException",
    "validationException",
    "throttlingException",
    "serviceUnavailableException",
  ]) {
    if (event[code] !== undefined) return { code, value: event[code] };
  }
  return undefined;
}

function finalizeBlock(
  block: ActiveBlock,
  options: BedrockConverseStreamDecodeOptions,
): readonly ModelStreamEvent[] {
  if (block.type === "text") return [];
  if (block.type === "thinking") {
    const signature = block.redacted ? base64(block.redactedChunks) : block.signature;
    return signature.length === 0
      ? []
      : [
          {
            type: "replay_metadata",
            target: "thinking",
            contentIndex: block.contentIndex,
            providerId: options.model.providerId,
            apiDialect: options.model.apiDialect,
            modelId: options.request.modelId,
            signature,
            ...(block.redacted ? { redacted: true } : {}),
          },
        ];
  }
  let input: unknown;
  try {
    input = JSON.parse(block.argumentsText || "{}");
  } catch (cause) {
    throw new BedrockConverseStreamCodecError("Bedrock tool input is not valid JSON", { cause });
  }
  const parsed = object(input);
  if (parsed === undefined) {
    throw new BedrockConverseStreamCodecError("Bedrock tool input must be an object");
  }
  return [
    {
      type: "tool_call",
      contentIndex: block.contentIndex,
      callId: block.callId,
      name: reverseToolName(options.request, block.wireName),
      input: parsed as JsonObject,
    },
  ];
}

/** Decodes AWS SDK Converse events into canonical model stream events. */
export async function* decodeBedrockConverseStream(
  events: AsyncIterable<BedrockConverseStreamEvent>,
  options: BedrockConverseStreamDecodeOptions,
): AsyncGenerator<ModelStreamEvent, void, undefined> {
  requirePrepared(options.request);
  compatibility(options.model);
  const blocks = new Map<number, ActiveBlock>();
  let nextContentIndex = 0;
  let emittedContent = false;
  let emittedToolCall = false;
  let nativeStopReason: string | undefined;
  let finalUsage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...(options.model.cost === undefined ? {} : { costUsd: 0 }),
  };
  let latencyMs: number | undefined;
  const response = () => ({
    providerId: options.model.providerId,
    requestedModelId: options.request.modelId,
    ...(options.routedModelId === undefined ? {} : { routedModelId: options.routedModelId }),
    ...(options.responseId === undefined ? {} : { responseId: options.responseId }),
    ...(nativeStopReason === undefined ? {} : { nativeStopReason }),
    ...(latencyMs === undefined
      ? options.startedAtMs === undefined
        ? {}
        : { latencyMs: Math.max(0, (options.now ?? Date.now)() - options.startedAtMs) }
      : { latencyMs }),
  });

  for await (const raw of events) {
    if (options.request.signal?.aborted) {
      yield { type: "aborted", ...(emittedContent ? { partial: true } : {}) };
      return;
    }
    const event = object(raw);
    if (event === undefined) {
      throw new BedrockConverseStreamCodecError("Bedrock stream event must be an object");
    }
    const failure = exception(event);
    if (failure !== undefined) {
      const details = object(failure.value);
      const message = safeProviderMessage(
        typeof details?.message === "string"
          ? details.message
          : "Bedrock reported a stream failure",
        options.secretValues,
      );
      const retryable =
        failure.code === "throttlingException" || failure.code === "serviceUnavailableException";
      yield {
        type: "error",
        code: failure.code,
        message,
        retryable,
        category: isContextLimitError(failure.code, message)
          ? "context_limit"
          : failure.code === "throttlingException"
            ? "rate_limit"
            : failure.code === "serviceUnavailableException"
              ? "overloaded"
              : failure.code === "validationException"
                ? "invalid_request"
                : "provider_internal",
        requestPhase: "streaming",
        ...(emittedContent ? { partial: true } : {}),
        response: response(),
      };
      return;
    }

    const messageStart = object(event.messageStart);
    if (messageStart !== undefined) {
      if (messageStart.role !== "assistant") {
        throw new BedrockConverseStreamCodecError("Bedrock message start role must be assistant");
      }
      continue;
    }
    const start = object(event.contentBlockStart);
    if (start !== undefined) {
      const providerIndex = eventIndex(start, "content block start");
      if (blocks.has(providerIndex)) {
        throw new BedrockConverseStreamCodecError(
          `Bedrock content block ${providerIndex} started twice`,
        );
      }
      const toolUse = object(object(start.start)?.toolUse);
      if (
        toolUse === undefined ||
        typeof toolUse.toolUseId !== "string" ||
        toolUse.toolUseId.length === 0 ||
        typeof toolUse.name !== "string" ||
        toolUse.name.length === 0
      ) {
        throw new BedrockConverseStreamCodecError("Bedrock content block start is malformed");
      }
      const block: ToolBlock = {
        type: "tool",
        contentIndex: nextContentIndex++,
        callId: toolUse.toolUseId,
        wireName: toolUse.name,
        argumentsText: "",
      };
      blocks.set(providerIndex, block);
      emittedContent = true;
      yield {
        type: "tool_call_start",
        contentIndex: block.contentIndex,
        callId: block.callId,
        name: reverseToolName(options.request, block.wireName),
      };
      continue;
    }
    const deltaEvent = object(event.contentBlockDelta);
    if (deltaEvent !== undefined) {
      const providerIndex = eventIndex(deltaEvent, "content block delta");
      const delta = object(deltaEvent.delta);
      if (delta === undefined) {
        throw new BedrockConverseStreamCodecError("Bedrock content block delta is malformed");
      }
      let block = blocks.get(providerIndex);
      if (delta.text !== undefined) {
        if (typeof delta.text !== "string") {
          throw new BedrockConverseStreamCodecError("Bedrock text delta is malformed");
        }
        if (block === undefined) {
          block = { type: "text", contentIndex: nextContentIndex++ };
          blocks.set(providerIndex, block);
        }
        if (block.type !== "text") {
          throw new BedrockConverseStreamCodecError("Bedrock text delta targets a non-text block");
        }
        if (delta.text.length > 0) {
          emittedContent = true;
          yield { type: "text_delta", text: delta.text, contentIndex: block.contentIndex };
        }
        continue;
      }
      const toolUse = object(delta.toolUse);
      if (toolUse !== undefined) {
        if (block?.type !== "tool" || typeof toolUse.input !== "string") {
          throw new BedrockConverseStreamCodecError("Bedrock tool input delta is malformed");
        }
        block.argumentsText += toolUse.input;
        if (toolUse.input.length > 0) {
          yield {
            type: "tool_call_delta",
            contentIndex: block.contentIndex,
            callId: block.callId,
            argumentsDelta: toolUse.input,
          };
        }
        continue;
      }
      const reasoning = object(delta.reasoningContent);
      if (reasoning !== undefined) {
        if (block === undefined) {
          block = {
            type: "thinking",
            contentIndex: nextContentIndex++,
            signature: "",
            redacted: false,
            redactedChunks: [],
          };
          blocks.set(providerIndex, block);
        }
        if (block.type !== "thinking") {
          throw new BedrockConverseStreamCodecError(
            "Bedrock reasoning delta targets a non-thinking block",
          );
        }
        if (reasoning.text !== undefined) {
          if (typeof reasoning.text !== "string") {
            throw new BedrockConverseStreamCodecError("Bedrock reasoning text is malformed");
          }
          if (reasoning.text.length > 0) {
            emittedContent = true;
            yield {
              type: "thinking_delta",
              text: reasoning.text,
              contentIndex: block.contentIndex,
            };
          }
        }
        if (reasoning.signature !== undefined) {
          if (typeof reasoning.signature !== "string") {
            throw new BedrockConverseStreamCodecError("Bedrock reasoning signature is malformed");
          }
          if (!block.redacted) block.signature += reasoning.signature;
        }
        if (reasoning.redactedContent !== undefined) {
          const chunk = bytes(reasoning.redactedContent);
          if (chunk === undefined || chunk.length === 0) {
            throw new BedrockConverseStreamCodecError("Bedrock redacted reasoning is malformed");
          }
          if (!block.redacted) {
            block.redacted = true;
            block.signature = "";
            emittedContent = true;
            yield {
              type: "thinking_delta",
              text: REDACTED_THINKING_PLACEHOLDER,
              contentIndex: block.contentIndex,
            };
          }
          block.redactedChunks.push(chunk);
        }
        continue;
      }
      continue;
    }
    const stop = object(event.contentBlockStop);
    if (stop !== undefined) {
      const providerIndex = eventIndex(stop, "content block stop");
      const block = blocks.get(providerIndex);
      if (block === undefined) {
        throw new BedrockConverseStreamCodecError(
          `Bedrock stop targets unknown block ${providerIndex}`,
        );
      }
      for (const finalized of finalizeBlock(block, options)) {
        if (finalized.type === "tool_call") emittedToolCall = true;
        yield finalized;
      }
      blocks.delete(providerIndex);
      continue;
    }
    const messageStop = object(event.messageStop);
    if (messageStop !== undefined) {
      if (typeof messageStop.stopReason !== "string" || messageStop.stopReason.length === 0) {
        throw new BedrockConverseStreamCodecError("Bedrock message stop reason is malformed");
      }
      nativeStopReason = messageStop.stopReason;
      continue;
    }
    const metadata = object(event.metadata);
    if (metadata !== undefined) {
      if (metadata.usage !== undefined) finalUsage = mapUsage(metadata.usage, options.model);
      const metrics = object(metadata.metrics);
      if (metrics?.latencyMs !== undefined) {
        latencyMs = nonNegative(metrics.latencyMs, "latencyMs");
      }
    }
  }

  if (options.request.signal?.aborted) {
    yield { type: "aborted", ...(emittedContent ? { partial: true } : {}) };
    return;
  }
  if (nativeStopReason === undefined) return;
  for (const [, block] of [...blocks.entries()].sort(([left], [right]) => left - right)) {
    for (const finalized of finalizeBlock(block, options)) {
      if (finalized.type === "tool_call") emittedToolCall = true;
      yield finalized;
    }
  }
  const mapped = stopReason(nativeStopReason);
  if (mapped === "error") {
    yield {
      type: "error",
      code: nativeStopReason,
      message: safeProviderMessage(
        `Provider stopped with: ${nativeStopReason}`,
        options.secretValues,
      ),
      retryable: false,
      category:
        nativeStopReason === "guardrail_intervened" || nativeStopReason === "content_filtered"
          ? "content_policy"
          : "provider_internal",
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
