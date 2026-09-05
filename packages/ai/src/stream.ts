// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import {
  isTerminalModelStreamEvent,
  type ModelStreamEvent,
  type TerminalModelStreamEvent,
} from "./model.ts";

/**
 * Enforces the canonical stream contract on a provider stream: yields the
 * provider's events and guarantees exactly one terminal event. A thrown
 * provider error becomes an `error` terminal (or `aborted` when the request
 * signal fired), a stream that ends silently becomes an `error` terminal, and
 * nothing is consumed past the first terminal event.
 */
export async function* normalizeModelStream(
  stream: AsyncIterable<ModelStreamEvent>,
  signal?: AbortSignal,
): AsyncGenerator<ModelStreamEvent, void, undefined> {
  try {
    for await (const event of stream) {
      yield event;
      if (isTerminalModelStreamEvent(event)) return;
    }
  } catch (error) {
    yield terminalForFailure(
      signal,
      "provider_stream_failure",
      error instanceof Error ? error.message : "provider stream threw a non-Error value",
    );
    return;
  }
  yield terminalForFailure(
    signal,
    "provider_stream_truncated",
    "provider ended the stream without a terminal event",
  );
}

function terminalForFailure(
  signal: AbortSignal | undefined,
  code: string,
  message: string,
): TerminalModelStreamEvent {
  if (signal?.aborted) return { type: "aborted" };
  return {
    type: "error",
    code,
    message,
    retryable: true,
    category: "stream_interrupted",
    requestPhase: "streaming",
  };
}

/** Collects a normalized stream; the last event is always terminal. */
export async function collectModelStream(
  stream: AsyncIterable<ModelStreamEvent>,
  signal?: AbortSignal,
): Promise<{ events: readonly ModelStreamEvent[]; terminal: TerminalModelStreamEvent }> {
  const events: ModelStreamEvent[] = [];
  for await (const event of normalizeModelStream(stream, signal)) events.push(event);
  const terminal = events[events.length - 1];
  if (terminal === undefined || !isTerminalModelStreamEvent(terminal)) {
    throw new Error("normalized model stream did not end with a terminal event");
  }
  return { events, terminal };
}
