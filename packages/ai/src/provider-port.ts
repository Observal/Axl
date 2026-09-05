// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  isTerminalModelStreamEvent,
  type BlobReference,
  type ModelMessage,
  type ModelStreamError,
  type ModelStreamEvent,
  type ThinkingLevel,
  type ToolDeclaration,
} from "@axl/protocol";

import type { ModelProvider } from "./provider.ts";
import { normalizeModelStream } from "./stream.ts";

export interface ModelRetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maximumDelayMs: number;
  readonly multiplier: number;
  readonly jitterRatio: number;
}

export interface ModelRetryOptions extends Partial<ModelRetryPolicy> {
  /** Test seam. Production uses an abortable timer. */
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Test seam. Production uses Math.random. */
  readonly random?: () => number;
}

export const DEFAULT_MODEL_RETRY_POLICY: ModelRetryPolicy = Object.freeze({
  maxAttempts: 3,
  initialDelayMs: 500,
  maximumDelayMs: 60_000,
  multiplier: 2,
  jitterRatio: 0.2,
});

export interface SessionPortOptions {
  readonly modelId: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly maxOutputTokens?: number;
  readonly readBlob?: (reference: BlobReference) => Promise<Uint8Array>;
  readonly retry?: ModelRetryOptions | false;
}

interface PortTurnRequest {
  readonly system?: string | undefined;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolDeclaration[];
  readonly maxOutputTokens?: number | undefined;
  readonly toolChoice?: "auto" | "required" | "none" | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Binds a provider and model choice into the shape the kernel's ModelPort
 * expects (satisfied structurally — the kernel never imports this package).
 * Streams are normalized, so the kernel always sees exactly one terminal.
 */
export function modelPortForSession(
  provider: ModelProvider,
  options: SessionPortOptions,
): { stream(request: PortTurnRequest): AsyncIterable<ModelStreamEvent> } {
  const retry = options.retry === false ? undefined : retryPolicy(options.retry);
  const sleep = options.retry === false ? abortableSleep : (options.retry?.sleep ?? abortableSleep);
  const random = options.retry === false ? Math.random : (options.retry?.random ?? Math.random);

  const providerRequest = (request: PortTurnRequest) => ({
    modelId: options.modelId,
    ...(request.system === undefined ? {} : { system: request.system }),
    messages: request.messages,
    tools: request.tools,
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    ...(request.maxOutputTokens === undefined && options.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: request.maxOutputTokens ?? options.maxOutputTokens }),
    ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
    ...(options.readBlob === undefined ? {} : { readBlob: options.readBlob }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });

  return {
    stream: (request) =>
      retry === undefined
        ? normalizeModelStream(provider.stream(providerRequest(request)), request.signal)
        : streamWithRetries(
            () => normalizeModelStream(provider.stream(providerRequest(request)), request.signal),
            retry,
            sleep,
            random,
            request.signal,
          ),
  };
}

function retryPolicy(options: ModelRetryOptions | undefined): ModelRetryPolicy {
  const policy = { ...DEFAULT_MODEL_RETRY_POLICY, ...options };
  const positiveIntegers = [
    ["maxAttempts", policy.maxAttempts],
    ["initialDelayMs", policy.initialDelayMs],
    ["maximumDelayMs", policy.maximumDelayMs],
  ] as const;
  for (const [name, value] of positiveIntegers) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`retry.${name} must be a positive safe integer`);
    }
  }
  if (!Number.isFinite(policy.multiplier) || policy.multiplier < 1) {
    throw new TypeError("retry.multiplier must be at least 1");
  }
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new TypeError("retry.jitterRatio must be between 0 and 1");
  }
  return policy;
}

async function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("Model retry aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("Model retry aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    timer.unref?.();
  });
}

function retryDelay(
  error: ModelStreamError,
  failedAttempt: number,
  policy: ModelRetryPolicy,
  random: () => number,
): number {
  if (
    error.retryAfterMs !== undefined &&
    Number.isFinite(error.retryAfterMs) &&
    error.retryAfterMs >= 0
  ) {
    return Math.min(policy.maximumDelayMs, Math.round(error.retryAfterMs));
  }
  const base = Math.min(
    policy.maximumDelayMs,
    policy.initialDelayMs * policy.multiplier ** (failedAttempt - 1),
  );
  const sample = Math.min(1, Math.max(0, random()));
  const jitter = 1 + (sample * 2 - 1) * policy.jitterRatio;
  return Math.min(policy.maximumDelayMs, Math.max(0, Math.round(base * jitter)));
}

async function* streamWithRetries(
  start: () => AsyncIterable<ModelStreamEvent>,
  policy: ModelRetryPolicy,
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
  random: () => number,
  signal?: AbortSignal,
): AsyncGenerator<ModelStreamEvent, void, undefined> {
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    let exposedOutput = false;
    let retry = false;
    for await (const event of start()) {
      if (
        event.type === "error" &&
        event.retryable &&
        !exposedOutput &&
        attempt < policy.maxAttempts
      ) {
        const delayMs = retryDelay(event, attempt, policy, random);
        yield {
          type: "retry_scheduled",
          attempt: attempt + 1,
          maxAttempts: policy.maxAttempts,
          delayMs,
          error: event,
        };
        try {
          await sleep(delayMs, signal);
        } catch (error) {
          if (signal?.aborted) yield { type: "aborted" };
          else {
            yield {
              type: "error",
              code: "retry_scheduler_failed",
              message: error instanceof Error ? error.message : "model retry scheduler failed",
              retryable: false,
              category: "unknown",
              requestPhase: "before_dispatch",
            };
          }
          return;
        }
        if (signal?.aborted) {
          yield { type: "aborted" };
          return;
        }
        retry = true;
        break;
      }
      if (
        event.type === "text_delta" ||
        event.type === "thinking_delta" ||
        event.type === "tool_call"
      ) {
        exposedOutput = true;
      }
      yield event;
      if (isTerminalModelStreamEvent(event)) return;
    }
    if (!retry) return;
  }
}
