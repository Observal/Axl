// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type {
  BlobReference,
  ModelMessage,
  ModelRequestConfiguration,
  ModelRequestSettings,
  ModelStreamEvent,
  ThinkingLevel,
  ToolDeclaration,
} from "@axl/protocol";

import { DEFAULT_MODEL_REQUEST_SETTINGS } from "@axl/protocol";
import { fitModelRequest } from "./request-configuration.ts";

import type { ModelProvider } from "./provider.ts";
import type { RequestModelMessage } from "./model.ts";
import type { ProviderRegistry } from "./registry.ts";
import { prepareModelRequest } from "./request-preparation.ts";
import { withResolvedSecretSink } from "./secret-context.ts";
import { normalizeModelStream } from "./stream.ts";

export interface SessionPortOptions {
  readonly modelId: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly onResolvedSecrets?: (values: readonly string[]) => void;
  readonly maxOutputTokens?: number;
  readonly requestSettings?: ModelRequestSettings;
  readonly readBlob?: (reference: BlobReference) => Promise<Uint8Array>;
}

interface PortTurnRequest {
  readonly system?: string | undefined;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolDeclaration[];
  readonly maxOutputTokens?: number | undefined;
  readonly cacheRetention?: "none" | "short" | "long" | undefined;
  readonly toolChoice?: "auto" | "required" | "none" | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly estimatedInputTokens?: number | undefined;
  readonly onRequestConfigured?:
    | ((configuration: ModelRequestConfiguration) => Promise<void>)
    | undefined;
}

/**
 * Binds a provider and model choice into the shape the kernel's ModelPort
 * expects. It is satisfied structurally, and the kernel never imports this package.
 * Streams are normalized, so the kernel always sees exactly one terminal.
 */
async function configureRequest(
  model: Parameters<typeof fitModelRequest>[0],
  request: PortTurnRequest,
  options: SessionPortOptions,
  messages: readonly RequestModelMessage[],
) {
  const settings = options.requestSettings ?? DEFAULT_MODEL_REQUEST_SETTINGS;
  const requestedMaximum =
    request.maxOutputTokens ?? options.maxOutputTokens ?? settings.maxOutputTokens ?? undefined;
  const raw = {
    modelId: options.modelId,
    ...(request.system === undefined ? {} : { system: request.system }),
    messages,
    tools: request.tools,
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    ...(requestedMaximum === undefined ? {} : { maxOutputTokens: requestedMaximum }),
    ...(request.cacheRetention === undefined
      ? {}
      : { cache: { retention: request.cacheRetention } as const }),
    httpIdleTimeoutMs: settings.httpIdleTimeoutMs,
    ...(request.estimatedInputTokens === undefined
      ? {}
      : { estimatedInputTokens: request.estimatedInputTokens }),
    ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
    ...(options.readBlob === undefined ? {} : { readBlob: options.readBlob }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
  const configuration = fitModelRequest(model, raw);
  const prepared = await prepareModelRequest(model, raw);
  await request.onRequestConfigured?.(configuration);
  return Object.freeze({
    ...prepared,
    maxOutputTokens: configuration.maxOutputTokens,
    httpIdleTimeoutMs: configuration.httpIdleTimeoutMs,
    estimatedInputTokens: configuration.estimatedInputTokens,
  });
}

type ReplayEvent = Extract<ModelStreamEvent, { type: "replay_metadata" }>;

function replayContinuation(event: ReplayEvent) {
  return {
    providerId: event.providerId,
    apiDialect: event.apiDialect,
    modelId: event.modelId,
    ...(event.responseId === undefined ? {} : { responseId: event.responseId }),
    ...(event.itemId === undefined ? {} : { itemId: event.itemId }),
    ...(event.namespace === undefined ? {} : { namespace: event.namespace }),
  };
}

function hasReplayContinuation(event: ReplayEvent): boolean {
  return (
    event.responseId !== undefined || event.itemId !== undefined || event.namespace !== undefined
  );
}

function retainReplayMetadata(
  messages: readonly ModelMessage[],
  turns: readonly (readonly ReplayEvent[])[],
): readonly RequestModelMessage[] {
  if (turns.length === 0) return messages;
  const assistantIndexes = messages.flatMap((message, index) =>
    message.role === "assistant" ? [index] : [],
  );
  const offset = Math.max(0, assistantIndexes.length - turns.length);
  const byMessage = new Map<number, readonly ReplayEvent[]>();
  turns.forEach((turn, index) => {
    const messageIndex = assistantIndexes[offset + index];
    if (messageIndex !== undefined) byMessage.set(messageIndex, turn);
  });

  return messages.map((message, messageIndex): RequestModelMessage => {
    const replay = byMessage.get(messageIndex);
    if (message.role !== "assistant" || replay === undefined || replay.length === 0) return message;
    const first = replay[0];
    if (first === undefined) return message;
    for (const event of replay) {
      if (
        event.providerId !== first.providerId ||
        event.apiDialect !== first.apiDialect ||
        event.modelId !== first.modelId
      ) {
        throw new Error("A model turn emitted replay metadata for multiple model identities");
      }
    }

    const thinking = replay
      .filter((event) => event.target === "thinking")
      .sort((a, b) => a.contentIndex - b.contentIndex);
    const text = replay
      .filter((event) => event.target === "text")
      .sort((a, b) => a.contentIndex - b.contentIndex);
    let thinkingIndex = 0;
    let textIndex = 0;
    const content = message.content.map((item) => {
      if (item.type === "thinking") {
        const event = thinking[thinkingIndex++];
        return event?.signature === undefined
          ? item
          : {
              ...item,
              signature: {
                providerId: event.providerId,
                apiDialect: event.apiDialect,
                modelId: event.modelId,
                value: event.signature,
              },
              ...(event.redacted === true ? { redacted: true } : {}),
            };
      }
      if (item.type === "text") {
        const event = text[textIndex++];
        return event === undefined
          ? item
          : {
              ...item,
              ...(event.signature === undefined
                ? {}
                : {
                    signature: {
                      providerId: event.providerId,
                      apiDialect: event.apiDialect,
                      modelId: event.modelId,
                      value: event.signature,
                    },
                  }),
              ...(hasReplayContinuation(event) ? { continuation: replayContinuation(event) } : {}),
            };
      }
      return item;
    });
    const calls = message.toolCalls?.map((call) => {
      const event = replay.find(
        (candidate) => candidate.target === "tool_call" && candidate.callId === call.callId,
      );
      return event === undefined
        ? call
        : {
            ...call,
            ...(event.signature === undefined
              ? {}
              : {
                  signature: {
                    providerId: event.providerId,
                    apiDialect: event.apiDialect,
                    modelId: event.modelId,
                    value: event.signature,
                  },
                }),
            ...(hasReplayContinuation(event) ? { continuation: replayContinuation(event) } : {}),
          };
    });
    const response = replay.find((event) => event.responseId !== undefined);
    return {
      role: "assistant",
      content,
      ...(calls === undefined ? {} : { toolCalls: calls }),
      origin: {
        providerId: first.providerId,
        apiDialect: first.apiDialect,
        modelId: first.modelId,
      },
      ...(response === undefined ? {} : { continuation: replayContinuation(response) }),
    };
  });
}

function streamWithSecretSink(
  stream: AsyncIterable<ModelStreamEvent>,
  sink: ((values: readonly string[]) => void) | undefined,
): AsyncIterable<ModelStreamEvent> {
  return (async function* () {
    const iterator = stream[Symbol.asyncIterator]();
    try {
      for (;;) {
        const result = await withResolvedSecretSink(sink, () => iterator.next());
        if (result.done) return;
        yield result.value;
      }
    } finally {
      const close = iterator.return;
      if (close !== undefined) {
        await withResolvedSecretSink(sink, () => close.call(iterator));
      }
    }
  })();
}

function retainStream(
  stream: AsyncIterable<ModelStreamEvent>,
  turns: ReplayEvent[][],
): AsyncIterable<ModelStreamEvent> {
  return (async function* () {
    const replay: ReplayEvent[] = [];
    try {
      for await (const event of stream) {
        if (event.type === "replay_metadata") replay.push(event);
        yield event;
      }
    } finally {
      turns.push(replay);
    }
  })();
}

export function modelPortForSession(
  provider: ModelProvider,
  options: SessionPortOptions,
): { stream(request: PortTurnRequest): AsyncIterable<ModelStreamEvent> } {
  const replayTurns: ReplayEvent[][] = [];
  return {
    stream: (request) =>
      retainStream(
        normalizeModelStream(
          (async function* () {
            request.signal?.throwIfAborted();
            const model = (await provider.listModels()).find(
              (candidate) => candidate.modelId === options.modelId,
            );
            if (model === undefined) {
              throw new Error(`Provider ${provider.id} has no model ${options.modelId}`);
            }
            const messages = retainReplayMetadata(request.messages, replayTurns);
            const prepared = await configureRequest(model, request, options, messages);
            request.signal?.throwIfAborted();
            yield* streamWithSecretSink(provider.stream(prepared), options.onResolvedSecrets);
          })(),
          request.signal,
        ),
        replayTurns,
      ),
  };
}

export interface RegistrySessionPortOptions extends SessionPortOptions {
  readonly providerId: string;
}

/** Binds a provider and model identity through the registry coordinator. */
export function modelPortForRegistry(
  registry: ProviderRegistry,
  options: RegistrySessionPortOptions,
): { stream(request: PortTurnRequest): AsyncIterable<ModelStreamEvent> } {
  const replayTurns: ReplayEvent[][] = [];
  return {
    stream: (request) =>
      retainStream(
        normalizeModelStream(
          (async function* () {
            request.signal?.throwIfAborted();
            const model = await registry.getModel(options.providerId, options.modelId);
            const messages = retainReplayMetadata(request.messages, replayTurns);
            const configured = await configureRequest(model, request, options, messages);
            request.signal?.throwIfAborted();
            yield* streamWithSecretSink(
              registry.stream(options.providerId, configured),
              options.onResolvedSecrets,
            );
          })(),
          request.signal,
        ),
        replayTurns,
      ),
  };
}
