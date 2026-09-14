// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { ProviderAuthentication, ResolvedAuth } from "./auth.ts";
import { AuthError } from "./auth.ts";
import { safeProviderMessage } from "./diagnostics.ts";
import { consumeContextLimitResponse } from "./model-error.ts";
import type {
  AuthMethod,
  ModelErrorCategory,
  ModelInfo,
  ModelRequest,
  ModelStreamEvent,
} from "./model.ts";
import {
  decodeOpenAiChatStream,
  encodeOpenAiChatRequest,
  OpenAiChatCodecError,
} from "./openai-chat.ts";
import type { ModelProvider } from "./provider.ts";
import {
  isPreparedModelRequest,
  type PreparedModelRequest,
  prepareModelRequest,
} from "./request-preparation.ts";
import { registerResolvedSecrets } from "./secret-context.ts";
import { decodeSseStream } from "./sse.ts";
import { raceWithSignal, safeEndpoint, safeFetch } from "./transport-safety.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const MAX_RETRIES = 10;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const SAFE_CONNECT_FAILURES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export interface OpenAiChatEndpoint {
  url(model: ModelInfo, resolved: ResolvedAuth): string;
  headers(model: ModelInfo, resolved: ResolvedAuth): Readonly<Record<string, string>>;
  wireModelId?(model: ModelInfo, resolved: ResolvedAuth): string;
}

export interface OpenAiChatProviderOptions {
  readonly id: string;
  readonly displayName: string;
  readonly authMethods: readonly AuthMethod[];
  readonly authentication?: ProviderAuthentication;
  readonly endpoint: OpenAiChatEndpoint;
  readonly models: readonly ModelInfo[];
  readonly resolveAuth: (signal: AbortSignal) => Promise<ResolvedAuth>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
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

function retryAfterMs(headers: Headers, now: number): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function retryDelayMs(
  attempt: number,
  headers: Headers | undefined,
  maxDelayMs: number,
  now: number,
): number {
  const advised = headers === undefined ? undefined : retryAfterMs(headers, now);
  return Math.min(advised ?? 250 * 2 ** attempt, maxDelayMs);
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(done, delayMs);
    function done(): void {
      signal.removeEventListener("abort", aborted);
      resolvePromise();
    }
    function aborted(): void {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function statusCategory(status: number): ModelErrorCategory {
  if (status === 413) return "context_limit";
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "provider_internal";
  return "invalid_request";
}

/** Reusable HTTP and SSE transport for providers using OpenAI Chat Completions. */
export class OpenAiChatProvider implements ModelProvider {
  readonly id: string;
  readonly displayName: string;
  readonly authMethods: readonly AuthMethod[];
  readonly authentication?: ProviderAuthentication;
  private readonly endpoint: OpenAiChatEndpoint;
  private readonly models: readonly ModelInfo[];
  private readonly resolveAuth: (signal: AbortSignal) => Promise<ResolvedAuth>;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly now: () => number;

  constructor(options: OpenAiChatProviderOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.authMethods = [...options.authMethods];
    if (options.authentication !== undefined) this.authentication = options.authentication;
    this.endpoint = options.endpoint;
    this.models = [...options.models];
    this.resolveAuth = options.resolveAuth;
    this.fetchImpl = options.fetch;
    this.now = options.now ?? Date.now;
  }

  listModels(): Promise<readonly ModelInfo[]> {
    return Promise.resolve(this.models);
  }

  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const model = this.models.find((candidate) => candidate.modelId === request.modelId);
    if (model === undefined) {
      throw new OpenAiChatCodecError(`Provider ${this.id} has no model ${request.modelId}`);
    }
    return this.streamModel(model, request);
  }

  streamModel(model: ModelInfo, request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (
      model.providerId !== this.id ||
      model.modelId !== request.modelId ||
      model.apiDialect !== "openai-chat"
    ) {
      throw new OpenAiChatCodecError(`Provider ${this.id} cannot dispatch the supplied model`);
    }
    return this.run(model, request);
  }

  private async *run(
    model: ModelInfo,
    request: ModelRequest,
  ): AsyncGenerator<ModelStreamEvent, void, undefined> {
    const timeoutSignal = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal =
      request.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([request.signal, timeoutSignal]);
    let prepared: PreparedModelRequest;
    let resolved: ResolvedAuth;
    let url: string;
    let init: RequestInit;
    let secretValues: readonly string[] = [];

    try {
      signal.throwIfAborted();
      prepared = isPreparedModelRequest(request)
        ? request
        : await prepareModelRequest(model, request);
      resolved = await raceWithSignal(this.resolveAuth(signal), signal);
      signal.throwIfAborted();
      secretValues = resolved.secretValues;
      registerResolvedSecrets(secretValues);
      const encoded = encodeOpenAiChatRequest(
        model,
        prepared,
        this.endpoint.wireModelId?.(model, resolved) ?? model.modelId,
      );
      url = safeEndpoint(this.endpoint.url(model, resolved), {
        label: `Provider ${this.id} request endpoint`,
        allowLoopbackHttp: this.id === "custom",
        allowQuery: true,
      });
      init = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...encoded.headers,
          ...this.endpoint.headers(model, resolved),
        },
        body: JSON.stringify(encoded.body),
        signal,
      };
    } catch (error) {
      yield this.failure(
        request,
        signal,
        error,
        secretValues,
        "provider_request_setup_failed",
        "before_dispatch",
        false,
        error instanceof AuthError
          ? "authentication"
          : error instanceof OpenAiChatCodecError
            ? "invalid_request"
            : "unknown",
      );
      return;
    }

    const maxRetries = Math.min(request.maxRetries ?? DEFAULT_MAX_RETRIES, MAX_RETRIES);
    const maxRetryDelayMs = request.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    const startedAtMs = this.now();
    let response: Response | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        response = await raceWithSignal(
          safeFetch(url, init, {
            label: `Provider ${this.id} request endpoint`,
            allowLoopbackHttp: this.id === "custom",
            expectedOrigin: new URL(url).origin,
            ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
          }),
          signal,
        );
      } catch (error) {
        if (signal.aborted) {
          yield this.failure(
            request,
            signal,
            error,
            secretValues,
            "provider_request_failed",
            "before_dispatch",
            false,
            "timeout",
          );
          return;
        }
        const nativeCode = nestedErrorCode(error);
        const retryable = nativeCode !== undefined && SAFE_CONNECT_FAILURES.has(nativeCode);
        if (retryable && attempt < maxRetries) {
          try {
            await wait(retryDelayMs(attempt, undefined, maxRetryDelayMs, this.now()), signal);
          } catch (waitError) {
            yield this.failure(
              request,
              signal,
              waitError,
              secretValues,
              "provider_request_failed",
              "before_dispatch",
              false,
              "timeout",
            );
            return;
          }
          continue;
        }
        yield this.failure(
          request,
          signal,
          error,
          secretValues,
          "provider_request_failed",
          retryable ? "before_dispatch" : "unknown",
          retryable,
          "network",
        );
        return;
      }

      if (response.ok) break;
      const retryable = RETRYABLE_STATUSES.has(response.status);
      const advisedDelay = retryable ? retryAfterMs(response.headers, this.now()) : undefined;
      if (retryable && attempt < maxRetries) {
        await response.body?.cancel();
        try {
          await wait(retryDelayMs(attempt, response.headers, maxRetryDelayMs, this.now()), signal);
        } catch (error) {
          yield this.failure(
            request,
            signal,
            error,
            secretValues,
            "provider_request_failed",
            "before_dispatch",
            false,
            "timeout",
          );
          return;
        }
        response = undefined;
        continue;
      }
      const contextLimit = await consumeContextLimitResponse(response, signal);
      yield {
        type: "error",
        code: `http_${response.status}`,
        message: `Provider ${this.id} returned ${response.status}`,
        retryable,
        category: contextLimit ? "context_limit" : statusCategory(response.status),
        requestPhase: "awaiting_response",
        ...(advisedDelay === undefined ? {} : { retryAfterMs: advisedDelay }),
      };
      return;
    }

    if (response?.body === undefined || response.body === null) {
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

    let emittedContent = false;
    try {
      const events = decodeOpenAiChatStream(decodeSseStream(response.body), {
        model,
        request: prepared,
        startedAtMs,
        now: this.now,
        secretValues,
      });
      const iterator = events[Symbol.asyncIterator]();
      for (;;) {
        const next = await raceWithSignal(iterator.next(), signal);
        if (next.done) break;
        const event = next.value;
        if (event.type !== "completed" && event.type !== "error" && event.type !== "aborted") {
          emittedContent = true;
        }
        yield event;
        if (event.type === "completed" || event.type === "error" || event.type === "aborted")
          return;
      }
    } catch (error) {
      yield this.failure(
        request,
        signal,
        error,
        secretValues,
        "provider_stream_failed",
        "streaming",
        false,
        signal.aborted ? "timeout" : "stream_interrupted",
        emittedContent,
      );
    }
  }

  private failure(
    request: ModelRequest,
    operationSignal: AbortSignal,
    error: unknown,
    secretValues: readonly string[],
    code: string,
    requestPhase: "before_dispatch" | "streaming" | "unknown",
    retryable: boolean,
    category: ModelErrorCategory,
    partial = false,
  ): ModelStreamEvent {
    if (request.signal?.aborted) return { type: "aborted", ...(partial ? { partial: true } : {}) };
    if (operationSignal.aborted) {
      return {
        type: "error",
        code: "provider_timeout",
        message: `Provider ${this.id} request timed out`,
        retryable: true,
        category: "timeout",
        requestPhase,
        ...(partial ? { partial: true } : {}),
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
      ...(partial ? { partial: true } : {}),
    };
  }
}
