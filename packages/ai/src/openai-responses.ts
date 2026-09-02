// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

// Axl-native OpenAI Responses codec and transport implementation.

import type { JsonObject, JsonValue, Usage } from "@axl/protocol";

import { assertModelSupports } from "./capabilities.ts";
import type { ResolvedAuth } from "./auth.ts";
import type { AuthMethod, ModelInfo, ModelRequest, ModelStreamEvent } from "./model.ts";
import type { ModelProvider } from "./provider.ts";
import { decodeSseStream, type SseFrame } from "./sse.ts";

/** OpenAI Responses rejects max_output_tokens below 16. */
const MIN_OUTPUT_TOKENS = 16;

export class ResponsesCodecError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ResponsesCodecError";
  }
}

/** Encodes a canonical request as an OpenAI Responses API streaming body. */
export function encodeResponsesRequest(
  model: ModelInfo,
  request: ModelRequest,
  deployment: string,
): JsonObject {
  const input: JsonValue[] = [];
  for (const message of request.messages) {
    if (message.role === "user") {
      input.push({ role: "user", content: contentParts(message.content, "input_text") });
    } else if (message.role === "assistant") {
      const text = message.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("");
      if (text.length > 0) {
        input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      }
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: "function_call",
          call_id: call.callId,
          name: call.name,
          arguments: JSON.stringify(call.input),
        });
      }
    } else {
      input.push({
        type: "function_call_output",
        call_id: message.callId,
        output: message.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join(""),
      });
    }
  }

  const body: Record<string, JsonValue> = {
    model: deployment,
    input,
    stream: true,
    store: false,
  };
  if (request.system !== undefined) body.instructions = request.system;
  if (request.maxOutputTokens !== undefined) {
    body.max_output_tokens = Math.max(request.maxOutputTokens, MIN_OUTPUT_TOKENS);
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    }));
    if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
  } else if (request.toolChoice === "required") {
    throw new ResponsesCodecError("toolChoice required needs at least one tool");
  }
  // `off` omits the reasoning parameter entirely rather than sending a zero.
  const level = request.thinkingLevel;
  if (model.reasoning && level !== undefined && level !== "off") {
    body.reasoning = { effort: model.thinkingLevelMap?.[level] ?? level };
  }
  return body;
}

function contentParts(
  content: readonly { type: string; text?: string }[],
  textType: "input_text",
): JsonValue[] {
  return content.map((item) => {
    if (item.type === "text") return { type: textType, text: item.text ?? "" };
    // Blob transport is the Phase 9 media channel; dropping content silently is worse than failing.
    throw new ResponsesCodecError(`Cannot encode ${item.type} content without media transport`);
  });
}

function mapUsage(raw: Record<string, unknown> | undefined): Usage {
  const usage = (raw ?? {}) as {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    // The API includes cached and cache-write tokens in input_tokens; subtract both.
    inputTokens: Math.max(0, (usage.input_tokens ?? 0) - cached - cacheWrite),
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

/**
 * Decodes Responses API SSE frames into canonical stream events. Ends after
 * the terminal event; a stream that ends without one simply returns, and
 * `normalizeModelStream` converts that into an error terminal.
 */
export async function* decodeResponsesStream(
  frames: AsyncIterable<SseFrame>,
): AsyncGenerator<ModelStreamEvent, void, undefined> {
  const calls = new Map<number, { callId: string; name: string; args: string }>();
  let sawToolCall = false;

  for await (const frame of frames) {
    if (frame.data === "[DONE]") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(frame.data) as Record<string, unknown>;
    } catch (error) {
      throw new ResponsesCodecError("Provider sent an undecodable stream frame", { cause: error });
    }
    const type = event.type;

    if (type === "response.output_text.delta") {
      yield { type: "text_delta", text: String(event.delta ?? "") };
    } else if (
      type === "response.reasoning_text.delta" ||
      type === "response.reasoning_summary_text.delta"
    ) {
      yield { type: "thinking_delta", text: String(event.delta ?? "") };
    } else if (type === "response.output_item.added") {
      const item = event.item as { type?: string; call_id?: string; name?: string } | undefined;
      if (item?.type === "function_call") {
        calls.set(Number(event.output_index ?? 0), {
          callId: String(item.call_id ?? ""),
          name: String(item.name ?? ""),
          args: "",
        });
      }
    } else if (type === "response.function_call_arguments.delta") {
      const call = calls.get(Number(event.output_index ?? 0));
      if (call) call.args += String(event.delta ?? "");
    } else if (type === "response.function_call_arguments.done") {
      const call = calls.get(Number(event.output_index ?? 0));
      if (call && typeof event.arguments === "string") call.args = event.arguments;
    } else if (type === "response.output_item.done") {
      const call = calls.get(Number(event.output_index ?? 0));
      if (call !== undefined) {
        calls.delete(Number(event.output_index ?? 0));
        let inputValue: unknown;
        try {
          inputValue = call.args === "" ? {} : JSON.parse(call.args);
        } catch (error) {
          throw new ResponsesCodecError(`Tool call ${call.callId} has undecodable arguments`, {
            cause: error,
          });
        }
        if (call.callId.length === 0 || call.name.length === 0) {
          throw new ResponsesCodecError("Provider sent a tool call without an id or name");
        }
        if (typeof inputValue !== "object" || inputValue === null || Array.isArray(inputValue)) {
          throw new ResponsesCodecError(`Tool call ${call.callId} arguments must be an object`);
        }
        sawToolCall = true;
        yield {
          type: "tool_call",
          callId: call.callId,
          name: call.name,
          input: inputValue as JsonObject,
        };
      }
    } else if (type === "response.completed" || type === "response.incomplete") {
      const response = event.response as { usage?: Record<string, unknown> } | undefined;
      yield {
        type: "completed",
        stopReason: type === "response.incomplete" ? "length" : sawToolCall ? "tool_use" : "stop",
        usage: mapUsage(response?.usage),
      };
      return;
    } else if (type === "response.failed" || type === "error") {
      const response = event.response as
        | { error?: { message?: string; code?: string } }
        | undefined;
      const message = response?.error?.message ?? (event.message as string | undefined);
      yield {
        type: "error",
        code: String(response?.error?.code ?? event.code ?? "provider_error"),
        message: message ?? "Provider reported a failure",
        retryable: false,
      };
      return;
    }
    // Unknown event types are forward-compatible noise and are ignored.
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
  readonly endpoint: ResponsesEndpoint;
  readonly models: readonly ModelInfo[];
  readonly resolveAuth: () => Promise<ResolvedAuth>;
  readonly fetch?: typeof fetch;
}

/**
 * Generic OpenAI-Responses provider: composes an endpoint policy, an auth
 * resolver, and an injectable fetch around the pure codec. Azure is one
 * endpoint policy; any Responses-compatible host is another. Model lookup and
 * capability checks fail before dispatch; every post-dispatch failure
 * terminates through the stream contract.
 */
export class OpenAiResponsesProvider implements ModelProvider {
  readonly id: string;
  readonly displayName: string;
  readonly authMethods: readonly AuthMethod[];
  private readonly endpoint: ResponsesEndpoint;
  private readonly models: readonly ModelInfo[];
  private readonly resolveAuth: () => Promise<ResolvedAuth>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiResponsesProviderOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.authMethods = options.authMethods;
    this.endpoint = options.endpoint;
    this.models = options.models;
    this.resolveAuth = options.resolveAuth;
    this.fetchImpl = options.fetch ?? fetch;
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
    let response: Response;
    try {
      const resolved = await this.resolveAuth();
      const body = encodeResponsesRequest(
        model,
        request,
        this.endpoint.deploymentFor(model.modelId, resolved),
      );
      response = await this.fetchImpl(this.endpoint.url(resolved), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...this.endpoint.headers(resolved),
        },
        body: JSON.stringify(body),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      yield this.failure(request, error);
      return;
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 2000);
      yield {
        type: "error",
        code: `http_${response.status}`,
        message: `Provider ${this.id} returned ${response.status}${detail ? `: ${detail}` : ""}`,
        retryable: response.status === 429 || response.status >= 500,
      };
      return;
    }
    if (response.body === null) {
      yield {
        type: "error",
        code: "empty_response",
        message: `Provider ${this.id} returned no response body`,
        retryable: true,
      };
      return;
    }

    try {
      yield* decodeResponsesStream(decodeSseStream(response.body));
    } catch (error) {
      yield this.failure(request, error);
    }
  }

  private failure(request: ModelRequest, error: unknown): ModelStreamEvent {
    if (request.signal?.aborted) return { type: "aborted" };
    return {
      type: "error",
      code: "provider_request_failed",
      message: error instanceof Error ? error.message : "provider request failed",
      retryable: false,
    };
  }
}
