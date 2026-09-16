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
import type { ModelProvider } from "./provider.ts";
import {
  isPreparedModelRequest,
  type PreparedModelRequest,
  prepareModelRequest,
} from "./request-preparation.ts";
import { registerResolvedSecrets } from "./secret-context.ts";
import { decodeSseStream, type SseFrame } from "./sse.ts";
import { raceWithSignal, safeEndpoint, safeFetch } from "./transport-safety.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRIES = 10;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export interface EncodedHttpSseRequest {
  readonly url: string;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface HttpSseCodec {
  encode(
    model: ModelInfo,
    request: PreparedModelRequest,
    resolved: ResolvedAuth,
  ): EncodedHttpSseRequest;
  decode(
    frames: AsyncIterable<SseFrame>,
    options: HttpStreamDecodeOptions,
  ): AsyncIterable<ModelStreamEvent>;
  decodeBody?(
    body: ReadableStream<Uint8Array>,
    options: HttpStreamDecodeOptions,
  ): AsyncIterable<ModelStreamEvent>;
}

export interface HttpStreamDecodeOptions {
  readonly model: ModelInfo;
  readonly request: PreparedModelRequest;
  readonly startedAtMs: number;
  readonly now: () => number;
  readonly secretValues: readonly string[];
}

export interface HttpSseProviderOptions {
  readonly allowLoopbackHttp?: boolean;
  readonly id: string;
  readonly displayName: string;
  readonly authMethods: readonly AuthMethod[];
  readonly authentication?: ProviderAuthentication;
  readonly models: readonly ModelInfo[];
  readonly resolveAuth: (signal: AbortSignal) => Promise<ResolvedAuth>;
  readonly codecFor: (model: ModelInfo) => HttpSseCodec;
  readonly validateEndpoint?: (url: URL, model: ModelInfo, resolved: ResolvedAuth) => void;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

function category(status: number): ModelErrorCategory {
  if (status === 413) return "context_limit";
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "provider_internal";
  return "invalid_request";
}

function retryDelay(response: Response, attempt: number, maximum: number, now: number): number {
  const raw = response.headers.get("retry-after")?.trim();
  const seconds = raw === undefined ? Number.NaN : Number(raw);
  const date = raw === undefined ? Number.NaN : Date.parse(raw);
  const advised = Number.isFinite(seconds)
    ? Math.max(0, seconds * 1_000)
    : Number.isFinite(date)
      ? Math.max(0, date - now)
      : 250 * 2 ** attempt;
  return Math.min(advised, maximum);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Shared finite HTTP and SSE lifecycle for native provider codecs. */
export class HttpSseProvider implements ModelProvider {
  readonly id: string;
  readonly displayName: string;
  readonly authMethods: readonly AuthMethod[];
  readonly authentication?: ProviderAuthentication;
  private models: readonly ModelInfo[];
  private readonly resolveAuth: (signal: AbortSignal) => Promise<ResolvedAuth>;
  private readonly codecFor: (model: ModelInfo) => HttpSseCodec;
  private readonly validateEndpoint:
    | ((url: URL, model: ModelInfo, resolved: ResolvedAuth) => void)
    | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly now: () => number;
  private readonly allowLoopbackHttp: boolean;

  constructor(options: HttpSseProviderOptions) {
    this.id = options.id;
    this.allowLoopbackHttp = options.allowLoopbackHttp ?? false;
    this.displayName = options.displayName;
    this.authMethods = [...options.authMethods];
    if (options.authentication !== undefined) this.authentication = options.authentication;
    this.models = [...options.models];
    this.resolveAuth = options.resolveAuth;
    this.codecFor = options.codecFor;
    this.validateEndpoint = options.validateEndpoint;
    this.fetchImpl = options.fetch;
    this.now = options.now ?? Date.now;
  }

  listModels(): Promise<readonly ModelInfo[]> {
    return Promise.resolve(this.models);
  }

  replaceModels(models: readonly ModelInfo[]): void {
    this.models = [...models];
  }

  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const model = this.models.find((candidate) => candidate.modelId === request.modelId);
    if (model === undefined)
      throw new TypeError(`Provider ${this.id} has no model ${request.modelId}`);
    return this.run(model, request);
  }

  streamModel(model: ModelInfo, request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (model.providerId !== this.id || model.modelId !== request.modelId) {
      throw new TypeError(
        `Provider ${this.id} cannot dispatch foreign model ${model.providerId}/${model.modelId}`,
      );
    }
    return this.run(model, request);
  }

  private async *run(model: ModelInfo, request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const timeout = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal =
      request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
    let prepared: PreparedModelRequest;
    let encoded: EncodedHttpSseRequest;
    let resolved: ResolvedAuth;
    let secrets: readonly string[] = [];
    let codec: HttpSseCodec;
    try {
      prepared = isPreparedModelRequest(request)
        ? request
        : await prepareModelRequest(model, request);
      resolved = await raceWithSignal(this.resolveAuth(signal), signal);
      secrets = resolved.secretValues;
      registerResolvedSecrets(secrets);
      codec = this.codecFor(model);
      encoded = codec.encode(model, prepared, resolved);
      const requestUrl = new URL(
        safeEndpoint(encoded.url, {
          label: `Provider ${this.id} request endpoint`,
          allowLoopbackHttp: this.allowLoopbackHttp,
          allowQuery: true,
        }),
      );
      this.validateEndpoint?.(requestUrl, model, resolved);
    } catch (error) {
      yield this.failure(
        request,
        signal,
        error,
        secrets,
        "provider_request_setup_failed",
        "before_dispatch",
      );
      return;
    }

    const maximumRetries = Math.min(request.maxRetries ?? DEFAULT_MAX_RETRIES, MAX_RETRIES);
    const maximumDelay = request.maxRetryDelayMs ?? 30_000;
    let response: Response | undefined;
    const body = JSON.stringify(encoded.body);
    for (let attempt = 0; attempt <= maximumRetries; attempt += 1) {
      try {
        const unsignedHeaders = {
          accept: "text/event-stream",
          "content-type": "application/json",
          ...encoded.headers,
        };
        const headers =
          resolved.auth.signRequest === undefined
            ? unsignedHeaders
            : await raceWithSignal(
                resolved.auth.signRequest(
                  { method: "POST", url: encoded.url, headers: unsignedHeaders, body },
                  signal,
                ),
                signal,
              );
        signal.throwIfAborted();
        response = await raceWithSignal(
          safeFetch(
            encoded.url,
            {
              method: "POST",
              headers,
              body,
              signal,
            },
            {
              label: `Provider ${this.id} request endpoint`,
              allowLoopbackHttp: this.allowLoopbackHttp,
              expectedOrigin: new URL(encoded.url).origin,
              ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
            },
          ),
          signal,
        );
      } catch (error) {
        yield this.failure(
          request,
          signal,
          error,
          secrets,
          "provider_request_failed",
          "before_dispatch",
        );
        return;
      }
      if (response.ok) break;
      const retryable = RETRYABLE.has(response.status);
      if (retryable && attempt < maximumRetries) {
        const delay = retryDelay(response, attempt, maximumDelay, this.now());
        await response.body?.cancel();
        try {
          await wait(delay, signal);
        } catch (error) {
          yield this.failure(
            request,
            signal,
            error,
            secrets,
            "provider_request_failed",
            "before_dispatch",
          );
          return;
        }
        continue;
      }
      const contextLimit = await consumeContextLimitResponse(response, signal);
      yield {
        type: "error",
        code: `http_${response.status}`,
        message: `Provider ${this.id} returned ${response.status}`,
        retryable,
        category: contextLimit ? "context_limit" : category(response.status),
        requestPhase: "awaiting_response",
      };
      return;
    }
    if (response?.body == null) {
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
    let partial = false;
    try {
      const decodeOptions = {
        model,
        request: prepared,
        startedAtMs: this.now(),
        now: this.now,
        secretValues: secrets,
      };
      const events =
        codec.decodeBody?.(response.body, decodeOptions) ??
        codec.decode(decodeSseStream(response.body), decodeOptions);
      const iterator = events[Symbol.asyncIterator]();
      for (;;) {
        const next = await raceWithSignal(iterator.next(), signal);
        if (next.done) break;
        const event = next.value;
        if (!new Set(["completed", "error", "aborted"]).has(event.type)) partial = true;
        yield event;
        if (new Set(["completed", "error", "aborted"]).has(event.type)) return;
      }
    } catch (error) {
      yield this.failure(
        request,
        signal,
        error,
        secrets,
        "provider_stream_failed",
        "streaming",
        partial,
      );
    }
  }

  private failure(
    request: ModelRequest,
    operationSignal: AbortSignal,
    error: unknown,
    secrets: readonly string[],
    code: string,
    phase: "before_dispatch" | "streaming",
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
        requestPhase: phase,
        ...(partial ? { partial: true } : {}),
      };
    }
    return {
      type: "error",
      code,
      message: safeProviderMessage(
        error instanceof Error ? error.message : "provider request failed",
        secrets,
      ),
      retryable: false,
      category: error instanceof AuthError ? "authentication" : "unknown",
      requestPhase: phase,
      ...(partial ? { partial: true } : {}),
    };
  }
}
