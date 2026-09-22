// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { readBoundedJson } from "./transport-safety.ts";

/** Recognizes provider-specific context overflow failures without treating every bad request as retryable. */
export function isContextLimitError(code: string, message: string, status?: number): boolean {
  if (status === 413) return true;
  const value = `${code} ${message}`.toLowerCase();
  return [
    "context_length_exceeded",
    "context window exceeded",
    "maximum context length",
    "prompt is too long",
    "prompt too long",
    "input is too long",
    "too many input tokens",
  ].some((marker) => value.includes(marker));
}

/** Consumes a failed HTTP response and detects common bounded provider overflow payloads. */
export async function consumeContextLimitResponse(
  response: Pick<Response, "body" | "headers" | "status">,
  signal?: AbortSignal,
): Promise<boolean> {
  if (response.status === 413) {
    await response.body?.cancel();
    return true;
  }
  if (response.status !== 400 && response.status !== 422) {
    await response.body?.cancel();
    return false;
  }
  try {
    const body = await readBoundedJson(response, 64 * 1024, signal);
    const value = body as {
      readonly code?: unknown;
      readonly message?: unknown;
      readonly error?: {
        readonly code?: unknown;
        readonly type?: unknown;
        readonly message?: unknown;
      };
    };
    const error = value.error;
    const code = error?.code ?? error?.type ?? value.code;
    const message = error?.message ?? value.message;
    return isContextLimitError(
      typeof code === "string" ? code : "",
      typeof message === "string" ? message : "",
      response.status,
    );
  } catch {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }
}
