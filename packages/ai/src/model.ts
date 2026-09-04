// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { BlobReference, ModelMessage, ThinkingLevel, ToolDeclaration } from "@axl/protocol";

// The canonical stream and message shapes live in @axl/protocol so the
// kernel can consume them without depending on this package. Re-exported here
// so provider code keeps one import surface.
export type {
  ModelMessage,
  ModelStreamError,
  ModelStreamEvent,
  TerminalModelStreamEvent,
  ToolCallRequest,
  ToolDeclaration,
} from "@axl/protocol";
export { isTerminalModelStreamEvent } from "@axl/protocol";

/**
 * How a provider can authenticate. Credential storage and lifecycle are a
 * separate slice; the contract only declares the shapes a provider supports.
 */
export type AuthMethod = "environment" | "file" | "oauth" | "ambient" | "keyless";

export interface ModelCost {
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  readonly cacheReadUsdPerMTok?: number;
  readonly cacheWriteUsdPerMTok?: number;
}

export interface ModelCapabilities {
  readonly toolUse: boolean;
  readonly structuredOutput: boolean;
  readonly imageInput: boolean;
}

export interface ModelInfo {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  /** The wire dialect the provider speaks for this model, e.g. `openai-chat`. */
  readonly apiDialect: string;
  readonly capabilities: ModelCapabilities;
  /** Whether the model can think at all. False means only the `off` level. */
  readonly reasoning: boolean;
  /**
   * Maps canonical thinking levels to provider-specific values. A missing key
   * uses the provider default; `null` marks the level unsupported. `xhigh` and
   * `max` are supported only when explicitly mapped.
   */
  readonly thinkingLevelMap?: Readonly<Partial<Record<ThinkingLevel, string | null>>>;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly cost?: ModelCost;
  /** Extra headers the provider must send for this model. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Provider-specific compatibility flags, e.g. `{ strictJsonSchema: false }`. */
  readonly compatibility?: Readonly<Record<string, boolean>>;
}

export interface ModelRequest {
  readonly modelId: string;
  readonly system?: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ToolDeclaration[];
  readonly thinkingLevel?: ThinkingLevel;
  readonly maxOutputTokens?: number;
  readonly toolChoice?: "auto" | "required" | "none";
  /** Resolves content-addressed media without placing bytes in canonical events. */
  readonly readBlob?: (reference: BlobReference) => Promise<Uint8Array>;
  /** Cancellation for an in-flight stream travels through this signal. */
  readonly signal?: AbortSignal;
}
