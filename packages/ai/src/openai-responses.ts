// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

// Axl-native OpenAI Responses codec and legacy transport composition.

import type { JsonObject, JsonValue, ModelErrorCategory, Usage } from "@axl/protocol";

import { AuthError, type ProviderAuthentication, type ResolvedAuth } from "./auth.ts";
import { assertModelSupports } from "./capabilities.ts";
import { safeProviderMessage } from "./diagnostics.ts";
import { consumeContextLimitResponse, isContextLimitError } from "./model-error.ts";
import type {
  AuthMethod,
  ModelInfo,
  ModelRequest,
  ModelStreamEvent,
  OpenAiResponsesCompatibility,
} from "./model.ts";
import type { ModelProvider } from "./provider.ts";
import {
  isPreparedModelRequest,
  type PreparedModelRequest,
  type PreparedRequestMessage,
  type PreparedToolDeclaration,
  preparedBlobDataUrl,
  prepareModelRequest,
} from "./request-preparation.ts";
import { registerResolvedSecrets } from "./secret-context.ts";
import { decodeSseStream, type SseFrame } from "./sse.ts";
import { safeEndpoint, safeFetch } from "./transport-safety.ts";
import { withUsageCost } from "./usage.ts";

/** OpenAI Responses rejects max_output_tokens below 16. */
const MIN_OUTPUT_TOKENS = 16;
const IDLE_TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const SAFE_CONNECT_FAILURES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const RATE_LIMIT_CODES = new Set([
  "rate_limit",
  "rate_limited",
  "rate_limit_exceeded",
  "too_many_requests",
]);
const OVERLOADED_CODES = new Set(["overloaded", "server_error", "temporarily_unavailable"]);
const RESERVED_REQUEST_FIELDS = new Set([
  "model",
  "input",
  "instructions",
  "stream",
  "store",
  "include",
  "tools",
  "tool_choice",
  "max_output_tokens",
  "reasoning",
  "temperature",
  "top_p",
  "prompt_cache_key",
  "prompt_cache_retention",
]);

export class ResponsesCodecError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ResponsesCodecError";
  }
}

export interface EncodedResponsesRequest {
  readonly body: JsonObject;
  /** Safe affinity headers only. Authentication remains transport-owned. */
  readonly headers: Readonly<Record<string, string>>;
}

type MutableJsonObject = Record<string, JsonValue>;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compatibility(model: ModelInfo): OpenAiResponsesCompatibility {
  if (
    model.apiDialect !== "openai-responses" &&
    model.apiDialect !== "azure-openai-responses" &&
    model.apiDialect !== "openai-codex-responses"
  ) {
    throw new ResponsesCodecError(`Model ${model.modelId} does not use a Responses API dialect`);
  }
  const declared = model.compatibility;
  if (declared === undefined) {
    return {
      dialect:
        model.apiDialect === "openai-responses"
          ? "openai-responses"
          : model.apiDialect === "azure-openai-responses"
            ? "azure-openai-responses"
            : "openai-codex-responses",
    };
  }
  if (
    (declared.dialect !== "openai-responses" &&
      declared.dialect !== "azure-openai-responses" &&
      declared.dialect !== "openai-codex-responses") ||
    declared.dialect !== model.apiDialect
  ) {
    throw new ResponsesCodecError(
      `Model ${model.modelId} has no matching Responses compatibility record`,
    );
  }
  return declared;
}

function requirePrepared(request: PreparedModelRequest): void {
  if (!isPreparedModelRequest(request)) {
    throw new ResponsesCodecError("OpenAI Responses requires a prepared model request");
  }
}

function preparedContent(
  request: PreparedModelRequest,
  content: Extract<PreparedRequestMessage, { role: "user" | "tool" }>["content"],
): JsonValue[] {
  return content.map((item): JsonValue => {
    if (item.type === "text") return { type: "input_text", text: item.text };
    const blob = request.preparation.blobs.get(item.blob.sha256);
    if (blob === undefined) {
      throw new ResponsesCodecError(`Prepared blob ${item.blob.sha256} is unavailable`);
    }
    return { type: "input_image", detail: "auto", image_url: preparedBlobDataUrl(blob) };
  });
}

function plainToolOutput(parts: readonly JsonValue[]): JsonValue {
  if (parts.length === 1) {
    const part = object(parts[0]);
    if (part?.type === "input_text" && typeof part.text === "string") return part.text;
  }
  return parts as JsonValue;
}

function parseReasoningSignature(value: string, path: string): JsonObject {
  try {
    const parsed = JSON.parse(value) as unknown;
    const item = object(parsed);
    if (item?.type !== "reasoning") throw new Error("signature is not a reasoning item");
    return parsed as JsonObject;
  } catch (error) {
    throw new ResponsesCodecError(`${path} has an invalid Responses reasoning signature`, {
      cause: error,
    });
  }
}

function fallbackMessageId(messageIndex: number, contentIndex: number): string {
  return `msg_axl_${messageIndex}_${contentIndex}`;
}

function toolForCall(
  request: PreparedModelRequest,
  call: { readonly canonicalName: string },
): PreparedToolDeclaration | undefined {
  return request.preparation.tools.find((tool) => tool.canonicalName === call.canonicalName);
}

function encodeMessages(request: PreparedModelRequest): JsonValue[] {
  const input: JsonValue[] = [];
  for (const [messageIndex, message] of request.messages.entries()) {
    if (message.role === "user") {
      input.push({ role: "user", content: preparedContent(request, message.content) });
      continue;
    }
    if (message.role === "tool") {
      const output = preparedContent(request, message.content);
      const tool = request.preparation.tools.find(
        (candidate) => candidate.canonicalName === message.canonicalName,
      );
      input.push({
        type:
          tool?.preparedConstraint?.type === "grammar"
            ? "custom_tool_call_output"
            : "function_call_output",
        call_id: message.callId,
        output: plainToolOutput(output),
      });
      continue;
    }

    for (const [contentIndex, content] of message.content.entries()) {
      if (content.type === "blob") {
        throw new ResponsesCodecError(
          "OpenAI Responses cannot replay image content from an assistant",
        );
      }
      if (content.type === "thinking") {
        if (content.signature !== undefined) {
          input.push(
            parseReasoningSignature(
              content.signature.value,
              `messages[${messageIndex}].content[${contentIndex}]`,
            ),
          );
        }
        continue;
      }
      if (content.text.length === 0) continue;
      input.push({
        type: "message",
        role: "assistant",
        status: "completed",
        id: content.continuation?.itemId ?? fallbackMessageId(messageIndex, contentIndex),
        content: [{ type: "output_text", text: content.text, annotations: [] }],
      });
    }

    for (const call of message.toolCalls ?? []) {
      const continuation = call.continuation;
      const tool = toolForCall(request, call);
      if (tool?.preparedConstraint?.type === "grammar") {
        const value = call.input[tool.preparedConstraint.inputProperty];
        if (typeof value !== "string") {
          throw new ResponsesCodecError(
            `Tool call ${call.canonicalCallId} grammar input must be a string`,
          );
        }
        input.push({
          type: "custom_tool_call",
          call_id: call.callId,
          name: call.name,
          input: value,
          ...(continuation?.itemId === undefined ? {} : { id: continuation.itemId }),
          ...(continuation?.namespace === undefined ? {} : { namespace: continuation.namespace }),
        });
      } else {
        input.push({
          type: "function_call",
          call_id: call.callId,
          name: call.name,
          arguments: JSON.stringify(call.input),
          ...(continuation?.itemId === undefined ? {} : { id: continuation.itemId }),
          ...(continuation?.namespace === undefined ? {} : { namespace: continuation.namespace }),
        });
      }
    }
  }
  return input;
}

function encodeTools(request: PreparedModelRequest): JsonValue[] | undefined {
  if (request.preparation.tools.length === 0) return undefined;
  return request.preparation.tools.map((tool): JsonValue => {
    const constraint = tool.preparedConstraint;
    if (constraint?.type === "grammar") {
      return {
        type: "custom",
        name: tool.name,
        description: tool.description,
        format: {
          type: "grammar",
          syntax: constraint.format,
          definition: constraint.definition,
        },
      };
    }
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: constraint?.type === "json-schema" ? constraint.strict : false,
    };
  });
}

function applySampling(body: MutableJsonObject, request: PreparedModelRequest): void {
  if (request.sampling?.temperature !== undefined) body.temperature = request.sampling.temperature;
  if (request.sampling?.topP !== undefined) body.top_p = request.sampling.topP;
  for (const [field, value] of Object.entries(request.sampling?.custom ?? {})) {
    if (RESERVED_REQUEST_FIELDS.has(field) || field in body) {
      throw new ResponsesCodecError(`Custom sampling field ${field} collides with a request field`);
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
      throw new ResponsesCodecError(
        "Long cache retention is unsupported by this Responses endpoint",
      );
    }
    body.prompt_cache_retention = "24h";
  }
  if (cache.sessionId === undefined) return;
  body.prompt_cache_key = Array.from(cache.sessionId).slice(0, 64).join("");
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
export function encodeResponsesRequest(
  model: ModelInfo,
  request: PreparedModelRequest,
  wireModelId = model.modelId,
): EncodedResponsesRequest {
  requirePrepared(request);
  const compat = compatibility(model);
  if (request.modelId !== model.modelId) {
    throw new ResponsesCodecError(
      `Request model ${request.modelId} does not match ${model.modelId}`,
    );
  }
  if (request.metadata !== undefined && Object.keys(request.metadata).length > 0) {
    throw new ResponsesCodecError("OpenAI Responses cannot render request metadata");
  }

  const body: MutableJsonObject = {
    model: wireModelId,
    input: encodeMessages(request),
    stream: true,
    store: false,
  };
  if (request.system !== undefined) body.instructions = request.system;
  if (request.maxOutputTokens !== undefined) {
    if (compat.supportsMaxOutputTokens === false) {
      throw new ResponsesCodecError("This Responses endpoint does not support max_output_tokens");
    }
    body.max_output_tokens = Math.max(request.maxOutputTokens, MIN_OUTPUT_TOKENS);
  }
  const tools = encodeTools(request);
  if (tools !== undefined) body.tools = tools;
  if (request.toolChoice !== undefined) {
    if (request.toolChoice !== "none" && tools === undefined) {
      throw new ResponsesCodecError(`toolChoice ${request.toolChoice} needs at least one tool`);
    }
    body.tool_choice = request.toolChoice;
  }
  const reasoning = request.preparation.reasoning;
  if (reasoning !== undefined && reasoning.effective !== "off") {
    body.reasoning = { effort: reasoning.providerValue ?? reasoning.effective, summary: "auto" };
    body.include = ["reasoning.encrypted_content"];
  }
  applySampling(body, request);
  const headers: Record<string, string> = {};
  applyCache(body, headers, model, request);
  return { body, headers };
}

function mapUsage(raw: unknown, model: ModelInfo, includeCost: boolean): Usage {
  const value = object(raw) ?? {};
  const inputDetails = object(value.input_tokens_details);
  const outputDetails = object(value.output_tokens_details);
  const input = typeof value.input_tokens === "number" ? value.input_tokens : 0;
  const cached = typeof inputDetails?.cached_tokens === "number" ? inputDetails.cached_tokens : 0;
  const cacheWrite =
    typeof inputDetails?.cache_write_tokens === "number" ? inputDetails.cache_write_tokens : 0;
  const mapped: Usage = {
    inputTokens: Math.max(0, input - cached - cacheWrite),
    outputTokens: typeof value.output_tokens === "number" ? value.output_tokens : 0,
    cacheReadTokens: cached,
    cacheWriteTokens: cacheWrite,
    reasoningTokens:
      typeof outputDetails?.reasoning_tokens === "number" ? outputDetails.reasoning_tokens : 0,
  };
  return !includeCost || model.cost === undefined ? mapped : withUsageCost(model.cost, mapped);
}

function providerErrorCategory(code: string, message = ""): ModelErrorCategory {
  if (isContextLimitError(code, message)) return "context_limit";
  const normalized = code.toLowerCase();
  if (RATE_LIMIT_CODES.has(normalized)) return "rate_limit";
  if (OVERLOADED_CODES.has(normalized)) return "overloaded";
  if (normalized === "timeout") return "timeout";
  return "unknown";
}

function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function nestedErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

interface OutputSlot {
  readonly type: "thinking" | "text" | "function" | "custom";
  readonly contentIndex: number;
  readonly callId?: string;
  readonly name?: string;
  arguments: string;
  started: boolean;
}

export interface ResponsesDecodeOptions {
  readonly model: ModelInfo;
  readonly request: PreparedModelRequest;
  readonly startedAtMs?: number;
  readonly now?: () => number;
  readonly secretValues?: readonly string[];
  /** Transitional transports can retain their pre-codec usage shape. */
  readonly includeCost?: boolean;
}

/** Decodes Responses API SSE frames into canonical stream events. */
export async function* decodeResponsesStream(
  frames: AsyncIterable<SseFrame>,
  options: ResponsesDecodeOptions,
): AsyncGenerator<ModelStreamEvent, void, undefined> {
  requirePrepared(options.request);
  compatibility(options.model);
  const slots = new Map<number, OutputSlot>();
  let responseId: string | undefined;
  let routedModelId: string | undefined;
  let emittedContent = false;
  let sawToolCall = false;

  const metadata = (nativeStopReason?: string) => ({
    providerId: options.model.providerId,
    requestedModelId: options.request.modelId,
    ...(routedModelId === undefined ? {} : { routedModelId }),
    ...(responseId === undefined ? {} : { responseId }),
    ...(nativeStopReason === undefined ? {} : { nativeStopReason }),
    ...(options.startedAtMs === undefined
      ? {}
      : { latencyMs: Math.max(0, (options.now ?? Date.now)() - options.startedAtMs) }),
  });

  const replay = (
    target: "thinking" | "text" | "tool_call",
    contentIndex: number,
    data: { callId?: string; signature?: string; itemId?: string; namespace?: string },
  ): ModelStreamEvent => ({
    type: "replay_metadata",
    target,
    contentIndex,
    providerId: options.model.providerId,
    apiDialect: options.model.apiDialect,
    modelId: options.model.modelId,
    ...(data.callId === undefined ? {} : { callId: data.callId }),
    ...(data.signature === undefined ? {} : { signature: data.signature }),
    ...(responseId === undefined ? {} : { responseId }),
    ...(data.itemId === undefined ? {} : { itemId: data.itemId }),
    ...(data.namespace === undefined ? {} : { namespace: data.namespace }),
  });

  for await (const frame of frames) {
    if (options.request.signal?.aborted) {
      yield { type: "aborted", ...(emittedContent ? { partial: true } : {}) };
      return;
    }
    if (frame.data === "[DONE]") continue;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(frame.data) as unknown;
      const parsedObject = object(parsed);
      if (parsedObject === undefined) throw new Error("frame is not an object");
      event = parsedObject;
    } catch (error) {
      throw new ResponsesCodecError("Provider sent an undecodable Responses stream frame", {
        cause: error,
      });
    }
    const type = event.type;

    if (type === "response.created") {
      const response = object(event.response);
      if (typeof response?.id === "string" && response.id.length > 0) responseId = response.id;
      if (typeof response?.model === "string" && response.model.length > 0)
        routedModelId = response.model;
      continue;
    }

    if (type === "response.output_item.added") {
      const outputIndex = event.output_index;
      const item = object(event.item);
      if (!Number.isSafeInteger(outputIndex) || (outputIndex as number) < 0 || item === undefined) {
        throw new ResponsesCodecError("Provider sent an output item without a valid index");
      }
      const index = outputIndex as number;
      if (slots.has(index)) throw new ResponsesCodecError(`Provider reused output index ${index}`);
      if (item.type === "reasoning") {
        slots.set(index, { type: "thinking", contentIndex: index, arguments: "", started: true });
      } else if (item.type === "message") {
        slots.set(index, { type: "text", contentIndex: index, arguments: "", started: true });
      } else if (item.type === "function_call" || item.type === "custom_tool_call") {
        const callId = typeof item.call_id === "string" ? item.call_id : "";
        const name = typeof item.name === "string" ? item.name : "";
        if (callId.length === 0 || name.length === 0) {
          throw new ResponsesCodecError("Provider sent a tool call without an id or name");
        }
        const canonicalName =
          options.request.preparation.tools.find((tool) => tool.name === name)?.canonicalName ??
          name;
        slots.set(index, {
          type: item.type === "function_call" ? "function" : "custom",
          contentIndex: index,
          callId,
          name: canonicalName,
          arguments:
            item.type === "function_call" && typeof item.arguments === "string"
              ? item.arguments
              : item.type === "custom_tool_call" && typeof item.input === "string"
                ? item.input
                : "",
          started: true,
        });
        emittedContent = true;
        yield { type: "tool_call_start", contentIndex: index, callId, name: canonicalName };
      }
      continue;
    }

    if (
      type === "response.reasoning_text.delta" ||
      type === "response.reasoning_summary_text.delta"
    ) {
      const index = event.output_index;
      const slot = typeof index === "number" ? slots.get(index) : undefined;
      if (typeof index === "number" && slot?.type !== "thinking") {
        throw new ResponsesCodecError("Reasoning delta has no reasoning item");
      }
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta.length > 0) emittedContent = true;
      yield {
        type: "thinking_delta",
        text: delta,
        ...(slot === undefined ? {} : { contentIndex: slot.contentIndex }),
      };
      continue;
    }

    if (type === "response.reasoning_summary_part.done") {
      const index = event.output_index;
      const slot = typeof index === "number" ? slots.get(index) : undefined;
      if (slot?.type !== "thinking")
        throw new ResponsesCodecError("Reasoning part has no reasoning item");
      emittedContent = true;
      yield { type: "thinking_delta", text: "\n\n", contentIndex: slot.contentIndex };
      continue;
    }

    if (type === "response.output_text.delta" || type === "response.refusal.delta") {
      const index = event.output_index;
      const slot = typeof index === "number" ? slots.get(index) : undefined;
      if (typeof index === "number" && slot?.type !== "text") {
        throw new ResponsesCodecError("Text delta has no message item");
      }
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta.length > 0) emittedContent = true;
      yield {
        type: "text_delta",
        text: delta,
        ...(slot === undefined ? {} : { contentIndex: slot.contentIndex }),
      };
      continue;
    }

    if (type === "response.function_call_arguments.delta") {
      const index = event.output_index;
      const slot = typeof index === "number" ? slots.get(index) : undefined;
      if (slot?.type !== "function" || slot.callId === undefined) {
        throw new ResponsesCodecError("Function arguments delta has no function call item");
      }
      const delta = typeof event.delta === "string" ? event.delta : "";
      slot.arguments += delta;
      emittedContent = true;
      yield {
        type: "tool_call_delta",
        contentIndex: slot.contentIndex,
        callId: slot.callId,
        argumentsDelta: delta,
      };
      continue;
    }

    if (type === "response.function_call_arguments.done") {
      const index = event.output_index;
      const slot = typeof index === "number" ? slots.get(index) : undefined;
      if (slot?.type !== "function") {
        throw new ResponsesCodecError("Function arguments completion has no function call item");
      }
      if (typeof event.arguments === "string") slot.arguments = event.arguments;
      continue;
    }

    if (type === "response.custom_tool_call_input.delta") {
      const index = event.output_index;
      const slot = typeof index === "number" ? slots.get(index) : undefined;
      if (slot?.type !== "custom" || slot.callId === undefined) {
        throw new ResponsesCodecError("Custom tool delta has no custom tool item");
      }
      const delta = typeof event.delta === "string" ? event.delta : "";
      slot.arguments += delta;
      const tool = options.request.preparation.tools.find(
        (candidate) => candidate.name === slot.name,
      );
      const property =
        tool?.preparedConstraint?.type === "grammar"
          ? tool.preparedConstraint.inputProperty
          : "input";
      emittedContent = true;
      yield {
        type: "tool_call_delta",
        contentIndex: slot.contentIndex,
        callId: slot.callId,
        argumentsDelta: JSON.stringify({ [property]: slot.arguments }),
      };
      continue;
    }

    if (type === "response.custom_tool_call_input.done") {
      const index = event.output_index;
      const slot = typeof index === "number" ? slots.get(index) : undefined;
      if (slot?.type !== "custom") {
        throw new ResponsesCodecError("Custom tool completion has no custom tool item");
      }
      if (typeof event.input === "string") slot.arguments = event.input;
      continue;
    }

    if (type === "response.output_item.done") {
      const index = event.output_index;
      const item = object(event.item);
      const slot = typeof index === "number" ? slots.get(index) : undefined;
      if (slot === undefined || item === undefined) {
        throw new ResponsesCodecError("Completed output item has no matching item");
      }
      slots.delete(index as number);
      const itemId = typeof item.id === "string" && item.id.length > 0 ? item.id : undefined;
      const namespace =
        typeof item.namespace === "string" && item.namespace.length > 0
          ? item.namespace
          : undefined;
      if (slot.type === "thinking") {
        const signature = JSON.stringify(item);
        yield replay("thinking", slot.contentIndex, {
          signature,
          ...(itemId === undefined ? {} : { itemId }),
        });
      } else if (slot.type === "text") {
        yield replay("text", slot.contentIndex, {
          ...(itemId === undefined ? {} : { itemId }),
          ...(typeof item.phase === "string" ? { namespace: item.phase } : {}),
        });
      } else {
        if (slot.callId === undefined || slot.name === undefined) {
          throw new ResponsesCodecError("Completed tool item is missing its identity");
        }
        let input: JsonObject;
        if (slot.type === "custom") {
          const tool = options.request.preparation.tools.find(
            (candidate) => candidate.canonicalName === slot.name || candidate.name === slot.name,
          );
          const property =
            tool?.preparedConstraint?.type === "grammar"
              ? tool.preparedConstraint.inputProperty
              : "input";
          input = { [property]: typeof item.input === "string" ? item.input : slot.arguments };
        } else {
          const source =
            typeof item.arguments === "string" ? item.arguments : slot.arguments || "{}";
          try {
            const parsed = JSON.parse(source) as unknown;
            if (object(parsed) === undefined) throw new Error("arguments are not an object");
            input = parsed as JsonObject;
          } catch (error) {
            throw new ResponsesCodecError(`Tool call ${slot.callId} has undecodable arguments`, {
              cause: error,
            });
          }
        }
        sawToolCall = true;
        yield {
          type: "tool_call",
          contentIndex: slot.contentIndex,
          callId: slot.callId,
          name: slot.name,
          input,
        };
        if (itemId !== undefined || namespace !== undefined || responseId !== undefined) {
          yield replay("tool_call", slot.contentIndex, {
            callId: slot.callId,
            ...(itemId === undefined ? {} : { itemId }),
            ...(namespace === undefined ? {} : { namespace }),
          });
        }
      }
      continue;
    }

    if (type === "response.completed" || type === "response.incomplete") {
      const response = object(event.response);
      if (typeof response?.id === "string" && response.id.length > 0) responseId = response.id;
      if (typeof response?.model === "string" && response.model.length > 0)
        routedModelId = response.model;
      const details = object(response?.incomplete_details);
      const reason = typeof details?.reason === "string" ? details.reason : undefined;
      const status = typeof response?.status === "string" ? response.status : undefined;
      const nativeStopReason = reason ?? status;
      if (
        type === "response.incomplete" &&
        reason !== undefined &&
        reason !== "max_output_tokens"
      ) {
        yield {
          type: "error",
          code: "response_incomplete",
          message: `Response incomplete: ${reason}`,
          retryable: false,
          ...(emittedContent ? { partial: true } : {}),
          response: metadata(nativeStopReason),
        };
        return;
      }
      yield {
        type: "completed",
        stopReason: type === "response.incomplete" ? "length" : sawToolCall ? "tool_use" : "stop",
        usage: mapUsage(response?.usage, options.model, options.includeCost !== false),
        ...(type === "response.incomplete" ? { partial: true } : {}),
        response: metadata(nativeStopReason),
      };
      return;
    }

    if (type === "response.failed" || type === "error") {
      const response = object(event.response);
      const providerError = object(response?.error) ?? object(event.error);
      const code = String(providerError?.code ?? event.code ?? "provider_error");
      const rawMessage =
        typeof providerError?.message === "string"
          ? providerError.message
          : typeof event.message === "string"
            ? event.message
            : "Provider reported a failure";
      const category = providerErrorCategory(code, rawMessage);
      yield {
        type: "error",
        code,
        message: safeProviderMessage(rawMessage, options.secretValues),
        retryable: category === "rate_limit" || category === "overloaded" || category === "timeout",
        category,
        requestPhase: "streaming",
        ...(emittedContent ? { partial: true } : {}),
        response: metadata(typeof response?.status === "string" ? response.status : undefined),
      };
      return;
    }
    // Unknown top-level event types are forward-compatible noise.
  }
}

/** Endpoint policy a Responses-API host plugs into the generic provider. */
export interface ResponsesEndpoint {
  url(resolved: ResolvedAuth): string;
  headers(resolved: ResolvedAuth): Readonly<Record<string, string>>;
  /** Maps a canonical model ID to the wire model/deployment name. */
  deploymentFor(modelId: string, resolved: ResolvedAuth): string;
}

export interface OpenAiResponsesProviderOptions {
  readonly id: string;
  readonly displayName: string;
  readonly authMethods: readonly AuthMethod[];
  readonly authentication?: ProviderAuthentication;
  readonly endpoint: ResponsesEndpoint;
  readonly models: readonly ModelInfo[];
  readonly resolveAuth: () => Promise<ResolvedAuth>;
  readonly fetch?: typeof fetch;
}

/** Legacy transport composition retained until provider registration owns transport. */
export class OpenAiResponsesProvider implements ModelProvider {
  readonly id: string;
  readonly displayName: string;
  readonly authMethods: readonly AuthMethod[];
  readonly authentication?: ProviderAuthentication;
  private readonly endpoint: ResponsesEndpoint;
  private readonly models: readonly ModelInfo[];
  private readonly resolveAuth: () => Promise<ResolvedAuth>;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: OpenAiResponsesProviderOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.authMethods = options.authMethods;
    if (options.authentication !== undefined) this.authentication = options.authentication;
    this.endpoint = options.endpoint;
    this.models = options.models;
    this.resolveAuth = options.resolveAuth;
    this.fetchImpl = options.fetch;
  }

  listModels(): Promise<readonly ModelInfo[]> {
    return Promise.resolve(this.models);
  }

  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const model = this.models.find((candidate) => candidate.modelId === request.modelId);
    if (model === undefined) {
      throw new ResponsesCodecError(`Provider ${this.id} has no model ${request.modelId}`);
    }
    assertModelSupports(model, request);
    return this.run(model, request);
  }

  private async *run(
    model: ModelInfo,
    request: ModelRequest,
  ): AsyncGenerator<ModelStreamEvent, void, undefined> {
    let url: string;
    let init: {
      method: string;
      headers: Record<string, string>;
      body: string;
      signal?: AbortSignal;
    };
    let prepared: PreparedModelRequest;
    let secretValues: readonly string[] = [];
    try {
      prepared = isPreparedModelRequest(request)
        ? request
        : await prepareModelRequest(model, request);
      const resolved = await this.resolveAuth();
      secretValues = resolved.secretValues;
      registerResolvedSecrets(secretValues);
      const encoded = encodeResponsesRequest(
        model,
        prepared,
        this.endpoint.deploymentFor(model.modelId, resolved),
      );
      url = safeEndpoint(this.endpoint.url(resolved), {
        label: `Provider ${this.id} request endpoint`,
        allowLoopbackHttp: true,
        allowQuery: true,
      });
      init = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...encoded.headers,
          ...this.endpoint.headers(resolved),
        },
        body: JSON.stringify(encoded.body),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      };
    } catch (error) {
      yield this.failure(
        request,
        error,
        secretValues,
        "provider_request_setup_failed",
        "before_dispatch",
        false,
        error instanceof AuthError
          ? "authentication"
          : error instanceof ResponsesCodecError
            ? "invalid_request"
            : "unknown",
      );
      return;
    }

    let response: Pick<Response, "ok" | "status" | "headers" | "body">;
    try {
      response = await safeFetch(url, init, {
        label: `Provider ${this.id} request endpoint`,
        allowLoopbackHttp: true,
        expectedOrigin: new URL(url).origin,
        idleTimeoutMs: request.httpIdleTimeoutMs ?? 300_000,
        ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
      });
    } catch (error) {
      const nativeCode = nestedErrorCode(error);
      const safeToRetry = nativeCode !== undefined && SAFE_CONNECT_FAILURES.has(nativeCode);
      yield this.failure(
        request,
        error,
        secretValues,
        "provider_request_failed",
        safeToRetry ? "before_dispatch" : "unknown",
        safeToRetry,
        "network",
      );
      return;
    }

    if (!response.ok) {
      const contextLimit = await consumeContextLimitResponse(response, request.signal);
      const retryable = response.status === 429 || [500, 502, 503, 504].includes(response.status);
      const retryDelay = retryable ? retryAfterMs(response.headers) : undefined;
      yield {
        type: "error",
        code: `http_${response.status}`,
        message: `Provider ${this.id} returned ${response.status}`,
        retryable,
        category: contextLimit
          ? "context_limit"
          : response.status === 429
            ? "rate_limit"
            : response.status >= 500
              ? "provider_internal"
              : response.status === 401
                ? "authentication"
                : response.status === 403
                  ? "authorization"
                  : "invalid_request",
        requestPhase: "awaiting_response",
        ...(retryDelay === undefined ? {} : { retryAfterMs: retryDelay }),
      };
      return;
    }
    if (response.body === null) {
      yield {
        type: "error",
        code: "empty_response",
        message: `Provider ${this.id} returned no response body`,
        retryable: false,
        category: "provider_internal",
        requestPhase: "awaiting_response",
      };
      return;
    }

    try {
      yield* decodeResponsesStream(decodeSseStream(response.body), {
        model,
        request: prepared,
        secretValues,
        includeCost: false,
      });
    } catch (error) {
      yield this.failure(
        request,
        error,
        secretValues,
        "provider_stream_failed",
        "streaming",
        false,
        "stream_interrupted",
      );
    }
  }

  private failure(
    request: ModelRequest,
    error: unknown,
    secretValues: readonly string[],
    code: string,
    requestPhase: "before_dispatch" | "awaiting_response" | "streaming" | "unknown",
    retryable: boolean,
    category: ModelErrorCategory,
  ): ModelStreamEvent {
    if (request.signal?.aborted) return { type: "aborted" };
    const transportCode = nestedErrorCode(error);
    if (transportCode !== undefined && IDLE_TIMEOUT_CODES.has(transportCode)) {
      return {
        type: "error",
        code: "model_request_idle_timeout",
        message: `Provider ${this.id} produced no HTTP data before the configured idle timeout`,
        retryable: false,
        category: "timeout",
        requestPhase: requestPhase === "streaming" ? "streaming" : "awaiting_response",
      };
    }
    return {
      type: "error",
      code,
      message: safeProviderMessage(
        error instanceof Error ? error.message : "provider request failed",
        secretValues,
      ),
      retryable,
      category,
      requestPhase,
    };
  }
}
