// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type {
  ModelMessage,
  ModelRequestConfiguration,
  ModelStreamEvent,
  ToolDeclaration,
} from "@axl/protocol";

/** One model turn as the kernel requests it. Model identity is the adapter's concern. */
export interface ModelTurnRequest {
  readonly system?: string | undefined;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolDeclaration[];
  readonly maxOutputTokens?: number | undefined;
  readonly cacheRetention?: "none" | "short" | "long" | undefined;
  readonly estimatedInputTokens?: number | undefined;
  readonly onRequestConfigured?:
    | ((configuration: ModelRequestConfiguration) => Promise<void>)
    | undefined;
  readonly toolChoice?: "auto" | "required" | "none" | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * The kernel's port to a model. Provider-specific logic — model IDs, dialects,
 * auth, retries — lives outside the kernel; adapters satisfy this port
 * structurally. The stream should end with exactly one terminal event; the
 * loop treats a thrown error or a silent end as an error terminal, so a
 * misbehaving adapter degrades loudly instead of corrupting the session.
 */
export interface ModelPort {
  stream(request: ModelTurnRequest): AsyncIterable<ModelStreamEvent>;
}
