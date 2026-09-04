// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type {
  BlobReference,
  ModelMessage,
  ModelStreamEvent,
  ThinkingLevel,
  ToolDeclaration,
} from "@axl/protocol";

import type { ModelProvider } from "./provider.ts";
import { normalizeModelStream } from "./stream.ts";

export interface SessionPortOptions {
  readonly modelId: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly maxOutputTokens?: number;
  readonly readBlob?: (reference: BlobReference) => Promise<Uint8Array>;
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
  return {
    stream: (request) =>
      normalizeModelStream(
        provider.stream({
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
        }),
        request.signal,
      ),
  };
}
