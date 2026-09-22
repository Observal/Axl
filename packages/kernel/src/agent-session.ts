// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import {
  type AssistantContent,
  type AssistantStopReason,
  type CanonicalEvent,
  type CompactionSettings,
  DEFAULT_COMPACTION_SETTINGS,
  EVENT_FORMAT_VERSION,
  type EventId,
  type EventPayloadMap,
  type EventType,
  estimateModelInputTokens,
  estimateModelMessageTokens,
  isTerminalModelStreamEvent,
  type ModelMessage,
  type ModelStreamError,
  type OperationId,
  type JsonObject,
  type JsonValue,
  parseEvent,
  parseEventId,
  parseOperationId,
  type SessionActivityFrame,
  type TerminalModelStreamEvent,
  type ToolCallRequest,
  type Usage,
  type UserContent,
} from "@axl/protocol";

import {
  type CompactionSummary,
  messagesFromCompactedLineage,
  prepareCompaction,
  serializeCompactionMessages,
  shouldCompact,
  summarizeCompaction,
  withFileSections,
} from "./compaction.ts";
import type { CapabilityService } from "./capabilities.ts";
import {
  CommandBlockedError,
  type CommandSource,
  type ExtensionHost,
  interceptCommand,
  NOOP_EXTENSION_HOST,
  type ToolCallDecision,
} from "./extension-host.ts";
import { type EventLogOptions, JsonlEventLog } from "./jsonl-event-log.ts";
import type { ModelPort } from "./model-port.ts";
import { SandboxViolationError } from "./path-policy.ts";
import type { StablePrompt } from "./prompt.ts";
import { verifyToolCallIntegrity } from "./replay.ts";
import { SessionTree } from "./session-tree.ts";
import type { ToolExecutionResult, ToolRegistry } from "./tools.ts";

export class OperationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationConflictError";
  }
}

/** Expected refusal when manual compaction has no eligible older context. */
export class CompactionUnavailableError extends Error {
  constructor(alreadyCompacted: boolean) {
    super(alreadyCompacted ? "Already compacted" : "Nothing to compact (session too small)");
    this.name = "CompactionUnavailableError";
  }
}

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

function modelRetryPolicy(options: ModelRetryOptions | undefined): ModelRetryPolicy {
  const policy = { ...DEFAULT_MODEL_RETRY_POLICY, ...options };
  for (const [name, value] of [
    ["maxAttempts", policy.maxAttempts],
    ["initialDelayMs", policy.initialDelayMs],
    ["maximumDelayMs", policy.maximumDelayMs],
  ] as const) {
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

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return sleep(milliseconds, undefined, { signal, ref: false });
}

function modelRetryDelay(
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

function unansweredToolCalls(events: readonly CanonicalEvent[]): CanonicalEvent<"tool.call">[] {
  const pending = new Map<string, CanonicalEvent<"tool.call">>();
  for (const event of events) {
    if (event.type === "tool.call") pending.set(event.payload.callId, event);
    else if (event.type === "tool.result") pending.delete(event.payload.callId);
  }
  return [...pending.values()];
}

function unansweredInteractions(
  events: readonly CanonicalEvent[],
): CanonicalEvent<"interaction.requested">[] {
  const pending = new Map<string, CanonicalEvent<"interaction.requested">>();
  for (const event of events) {
    if (event.type === "interaction.requested") pending.set(event.payload.interactionId, event);
    else if (event.type === "interaction.resolved") pending.delete(event.payload.interactionId);
  }
  return [...pending.values()];
}

function unfinishedCompactions(events: readonly CanonicalEvent[]): Array<{
  readonly operationId: OperationId;
  readonly reason: "manual" | "threshold" | "overflow";
  readonly started: boolean;
}> {
  const queued = new Map<
    OperationId,
    { reason: "manual" | "threshold" | "overflow"; started: boolean }
  >();
  for (const event of events) {
    if (event.operationId === undefined) continue;
    if (event.type === "compaction.queued") {
      queued.set(event.operationId, { reason: "manual", started: false });
    } else if (event.type === "compaction.started") {
      queued.set(event.operationId, { reason: event.payload.reason, started: true });
    } else if (event.type === "context.compacted" || event.type === "compaction.failed") {
      queued.delete(event.operationId);
    }
  }
  return [...queued].map(([operationId, value]) => ({ operationId, ...value }));
}

export interface AgentSessionOptions {
  readonly model: ModelPort;
  readonly tools: ToolRegistry;
  /**
   * The stable prompt, frozen for the life of the session. A fresh log records
   * its sections as `prompt.section` events. Takes precedence over `system`.
   */
  readonly prompt?: StablePrompt;
  readonly system?: string;
  readonly contextResources?: EventPayloadMap["context.resources"]["resources"];
  readonly recordPromptSnapshot?: boolean;
  readonly cwd: string;
  readonly extensionHost?: ExtensionHost;
  readonly capabilityService?: CapabilityService;
  readonly activationSignal?: AbortSignal;
  readonly retry?: ModelRetryOptions | false;
  readonly compaction?: Partial<CompactionSettings>;
  readonly modelContextWindow?: number;
  readonly log?: EventLogOptions;
  /** Sandbox state announced at every open as a `sandbox.configured` event. */
  readonly sandbox?: EventPayloadMap["sandbox.configured"];
  /** Provider configuration announced at every open as a `config.provider` event. */
  readonly configProvider?: EventPayloadMap["config.provider"];
  /** Model configuration announced at every open as a `config.model` event. */
  readonly configModel?: EventPayloadMap["config.model"];
  readonly configRequest?: EventPayloadMap["config.request"];
  readonly configCompaction?: EventPayloadMap["config.compaction"];
  /** Thinking configuration announced at every open as a `config.thinking` event. */
  readonly configThinking?: EventPayloadMap["config.thinking"];
  /** Effective tool profile announced at every open as a `config.profile` event. */
  readonly configProfile?: EventPayloadMap["config.profile"];
  /** Optional web-tool configuration announced at every open. */
  readonly configTools?: EventPayloadMap["config.tools"];
  /** Dialect boundary announced at open; the payload carries its own reason. */
  readonly configDialect?: EventPayloadMap["config.dialect"];
  /** Canonical operation that durably reserved a newly created session. */
  readonly creationOperationId?: OperationId;
  /** Canonical operation owning configuration events emitted at this boundary. */
  readonly boundaryOperationId?: OperationId;
  /** Live tail: invoked after each event is durably appended, in append order. */
  readonly onEvent?: (event: CanonicalEvent) => void;
  /** Non-durable model deltas for responsive attached clients. */
  readonly onActivity?: (frame: SessionActivityFrame) => void;
}

export interface TurnResult {
  /** Every event this turn appended, in order. */
  readonly events: readonly CanonicalEvent[];
  readonly stopReason: AssistantStopReason;
}

function shellModelContent(event: CanonicalEvent<"user.shell">): readonly UserContent[] {
  const text = event.payload.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
  const blobs = event.payload.content.filter((item) => item.type === "blob");
  return [{ type: "text", text: `[shell]\n$ ${event.payload.command}\n${text}` }, ...blobs];
}

/** Projects a branch lineage onto the model-facing message history. */
export function messagesFromLineage(events: readonly CanonicalEvent[]): readonly ModelMessage[] {
  return messagesFromCompactedLineage(events);
}

interface TurnOutcome {
  readonly content: readonly AssistantContent[];
  readonly toolCalls: readonly ToolCallRequest[];
  readonly stopReason: AssistantStopReason;
  readonly usage?: Usage;
  readonly error?: ModelStreamError;
  readonly exposedOutput: boolean;
}

/**
 * A live session over one event-log branch: the agent loop, tool dispatch,
 * cancellation, and operation ownership. Exactly one operation may mutate the
 * branch at a time; a second `runTurn` while one is active fails loudly.
 */
export class AgentSession {
  readonly log: JsonlEventLog;
  private contextUsage: { tokens: number; messageCount: number } | undefined;
  private readonly model: ModelPort;
  private readonly tools: ToolRegistry;
  private readonly host: ExtensionHost;
  private readonly capabilityService: CapabilityService | undefined;
  private readonly onEvent: ((event: CanonicalEvent) => void) | undefined;
  private readonly onActivity: ((frame: SessionActivityFrame) => void) | undefined;
  private readonly system: string | undefined;
  private readonly retry: ModelRetryPolicy | undefined;
  private readonly retrySleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly retryRandom: () => number;
  private readonly compaction: CompactionSettings;
  private readonly modelContextWindow: number;
  private tip: EventId | null;
  private messages: ModelMessage[];
  private activeOperation: OperationId | null = null;
  private acceptingQueuedMessages = false;
  private readonly steeringMessages: Array<readonly UserContent[]> = [];
  private readonly followUpMessages: Array<readonly UserContent[]> = [];
  private readonly activeCapabilityContent = new Map<string, string>();
  private readonly extensionState = new Map<string, JsonValue>();
  private readonly extensionLabels = new Map<string, string>();
  private readonly knownEventIds: Set<EventId>;

  private constructor(
    log: JsonlEventLog,
    events: readonly CanonicalEvent[],
    options: AgentSessionOptions,
  ) {
    this.log = log;
    this.model = options.model;
    this.tools = options.tools;
    this.host = options.extensionHost ?? NOOP_EXTENSION_HOST;
    this.capabilityService = options.capabilityService;
    this.onEvent = options.onEvent;
    this.onActivity = options.onActivity;
    this.system = options.prompt?.text ?? options.system;
    this.retry = options.retry === false ? undefined : modelRetryPolicy(options.retry);
    this.retrySleep =
      options.retry === false ? abortableSleep : (options.retry?.sleep ?? abortableSleep);
    this.retryRandom =
      options.retry === false ? Math.random : (options.retry?.random ?? Math.random);
    this.compaction = { ...DEFAULT_COMPACTION_SETTINGS, ...options.compaction };
    if (typeof this.compaction.enabled !== "boolean") {
      throw new TypeError("compaction.enabled must be a boolean");
    }
    for (const [name, value] of [
      ["reserveTokens", this.compaction.reserveTokens],
      ["keepRecentTokens", this.compaction.keepRecentTokens],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`compaction.${name} must be a positive safe integer`);
      }
    }
    this.modelContextWindow = options.modelContextWindow ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(this.modelContextWindow) || this.modelContextWindow < 1) {
      throw new TypeError("modelContextWindow must be a positive safe integer");
    }
    this.tip = events.at(-1)?.id ?? null;
    this.knownEventIds = new Set(events.map((event) => event.id));
    this.messages = [...messagesFromLineage(events)];
    for (const event of events) {
      if (event.type === "capability.activated") {
        this.activeCapabilityContent.set(event.payload.capability.identity, event.payload.content);
        this.tools.activateCapability(event.payload.capability.identity);
      } else if (event.type === "extension.state") {
        const key = `${event.payload.extensionId}\0${event.payload.key}`;
        if (event.payload.value === null) this.extensionState.delete(key);
        else this.extensionState.set(key, structuredClone(event.payload.value));
      } else if (event.type === "extension.label") {
        const key = `${event.payload.extensionId}\0${event.payload.eventId}`;
        if (event.payload.label === null) this.extensionLabels.delete(key);
        else this.extensionLabels.set(key, event.payload.label);
      }
    }
  }

  /**
   * Opens a session over a log file. A fresh log gets a `session.created`
   * root; an existing log is integrity-checked and its linear history
   * projected into the model surface.
   */
  static async open(
    path: string,
    sessionId: unknown,
    options: AgentSessionOptions,
  ): Promise<AgentSession> {
    try {
      return await AgentSession.openOwned(path, sessionId, options);
    } catch (error) {
      try {
        await options.extensionHost?.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Session open and extension cleanup failed",
        );
      }
      throw error;
    }
  }

  private static async openOwned(
    path: string,
    sessionId: unknown,
    options: AgentSessionOptions,
  ): Promise<AgentSession> {
    const opened = await JsonlEventLog.open(path, sessionId, options.log ?? {});
    const tree = SessionTree.fromEvents(opened.log.sessionId, opened.events);
    verifyToolCallIntegrity(tree);
    const tip = opened.events.at(-1)?.id;
    const lineage = tip === undefined ? [] : tree.lineage(tip);
    const session = new AgentSession(opened.log, lineage, options);
    session.host.bindSession?.({
      getState(extensionId, key) {
        const value = session.extensionState.get(`${extensionId}\0${key}`);
        return value === undefined ? undefined : structuredClone(value);
      },
      async setState(extensionId, key, value) {
        if (session.tip === null)
          throw new Error("Extension state is unavailable before session start");
        await session.append(session.activeOperation ?? undefined, "extension.state", {
          extensionId,
          key,
          value,
        });
        const stateKey = `${extensionId}\0${key}`;
        if (value === null) session.extensionState.delete(stateKey);
        else session.extensionState.set(stateKey, structuredClone(value));
      },
      getEntryLabel(extensionId, eventId) {
        return session.extensionLabels.get(`${extensionId}\0${eventId}`);
      },
      async setEntryLabel(extensionId, eventId, label) {
        if (!session.knownEventIds.has(parseEventId(eventId, "eventId"))) {
          throw new Error(`Unknown session event ${eventId}`);
        }
        await session.append(session.activeOperation ?? undefined, "extension.label", {
          extensionId,
          eventId: parseEventId(eventId, "eventId"),
          label,
        });
        const key = `${extensionId}\0${eventId}`;
        if (label === null) session.extensionLabels.delete(key);
        else session.extensionLabels.set(key, label);
      },
      async emit(extensionId, channel, value) {
        if (session.tip === null)
          throw new Error("Extension events are unavailable before session start");
        await session.append(session.activeOperation ?? undefined, "extension.event", {
          extensionId,
          channel,
          value,
        });
      },
      async sendExtensionMessage(extensionId, source, content) {
        if (session.tip === null) {
          throw new Error("Extension messages are unavailable before session start");
        }
        const event = await session.append(
          session.activeOperation ?? undefined,
          "context.extension",
          { extensionId, source, content },
        );
        session.messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: `[extension:${event.payload.extensionId}/${event.payload.source}]\n${event.payload.content}`,
            },
          ],
        });
      },
    });
    await session.host.activate(options.activationSignal ?? new AbortController().signal);
    for (const compaction of unfinishedCompactions(lineage)) {
      await session.append(compaction.operationId, "compaction.failed", {
        reason: compaction.reason,
        code: "daemon_restart",
        message: compaction.started
          ? "Compaction was interrupted because the daemon restarted."
          : "Queued compaction was cancelled because the daemon restarted.",
        willRetry: false,
      });
    }
    for (const interaction of unansweredInteractions(lineage)) {
      await session.append(interaction.operationId, "interaction.resolved", {
        interactionId: interaction.payload.interactionId,
        action: "cancel",
      });
    }
    for (const call of unansweredToolCalls(lineage)) {
      const result = await session.append(call.operationId, "tool.result", {
        callId: call.payload.callId,
        name: call.payload.name,
        content: [
          {
            type: "text",
            text: "Tool execution was aborted because the daemon stopped before recording a result.",
          },
        ],
        isError: true,
        details: { endedBy: "abort", reason: "daemon_restart" },
      });
      session.messages.push({
        role: "tool",
        callId: call.payload.callId,
        name: call.payload.name,
        content: result.payload.content,
        isError: true,
      });
    }
    const fresh = opened.events.length === 0;
    if (fresh) {
      await session.append(options.creationOperationId, "session.created", { cwd: options.cwd });
    }
    const hasResourceSnapshot = opened.events.some((event) => event.type === "context.resources");
    if (fresh || options.recordPromptSnapshot === true || !hasResourceSnapshot) {
      await session.append(options.boundaryOperationId, "context.resources", {
        resources: options.contextResources ?? [],
      });
    }
    const hasPromptSnapshot = opened.events.some((event) => event.type === "prompt.section");
    if (fresh || options.recordPromptSnapshot === true || !hasPromptSnapshot) {
      for (const section of options.prompt?.sections ?? []) {
        await session.append(options.boundaryOperationId, "prompt.section", section);
      }
    }
    // Tool schemas are model-visible configuration, so every runtime boundary
    // records the exact current roster before the next model request.
    for (const tool of options.tools.declarations()) {
      await session.append(options.boundaryOperationId, "tool.schema", tool);
    }
    // Sandbox and configuration are announced at every open so a resumed
    // session reflects what it is actually running under now.
    if (options.sandbox !== undefined) {
      await session.append(options.boundaryOperationId, "sandbox.configured", options.sandbox);
    }
    if (options.configProvider !== undefined) {
      await session.append(options.boundaryOperationId, "config.provider", options.configProvider);
    }
    if (options.configRequest !== undefined)
      await session.append(options.boundaryOperationId, "config.request", options.configRequest);
    if (options.configCompaction !== undefined)
      await session.append(
        options.boundaryOperationId,
        "config.compaction",
        options.configCompaction,
      );
    if (options.configModel !== undefined) {
      await session.append(options.boundaryOperationId, "config.model", options.configModel);
    }
    if (options.configThinking !== undefined) {
      await session.append(options.boundaryOperationId, "config.thinking", options.configThinking);
    }
    if (options.configProfile !== undefined) {
      await session.append(options.boundaryOperationId, "config.profile", options.configProfile);
    }
    if (options.configTools !== undefined) {
      await session.append(options.boundaryOperationId, "config.tools", options.configTools);
    }
    if (options.configDialect !== undefined) {
      await session.append(options.boundaryOperationId, "config.dialect", options.configDialect);
    }
    return session;
  }

  /**
   * Appends context — a skill body, steering, an injected instruction — to the
   * conversation surface. Prior content is never rewritten, reordered, or
   * timestamped; the prompt-cache prefix survives every injection.
   */
  async requestInteraction(
    payload: EventPayloadMap["interaction.requested"],
  ): Promise<CanonicalEvent> {
    if (this.activeOperation === null) {
      throw new OperationConflictError("Interactions require an active session operation");
    }
    return this.append(this.activeOperation, "interaction.requested", payload);
  }

  async resolveInteraction(
    payload: EventPayloadMap["interaction.resolved"],
    operationId?: OperationId,
  ): Promise<CanonicalEvent> {
    if (this.activeOperation === null) {
      throw new OperationConflictError("No active operation can receive this interaction response");
    }
    return this.append(operationId ?? this.activeOperation, "interaction.resolved", payload);
  }

  async injectContext(source: string, content: string): Promise<CanonicalEvent> {
    if (this.activeOperation !== null) {
      throw new OperationConflictError(
        `Operation ${this.activeOperation} owns this branch; steering lands after it`,
      );
    }
    const event = await this.append(undefined, "context.injected", { source, content });
    this.messages.push({
      role: "user",
      content: [{ type: "text", text: `[${source}]\n${content}` }],
    });
    return event;
  }

  /** Queues user input for the next model boundary of the active turn. */
  steer(content: readonly UserContent[]): void {
    if (!this.acceptingQueuedMessages) {
      throw new OperationConflictError("No active model turn can receive steering");
    }
    this.steeringMessages.push([...content]);
  }

  /** Queues user input until the active turn would otherwise finish. */
  followUp(content: readonly UserContent[]): void {
    if (!this.acceptingQueuedMessages) {
      throw new OperationConflictError("No active model turn can receive a follow-up");
    }
    this.followUpMessages.push([...content]);
  }

  hasQueuedMessages(): boolean {
    return this.steeringMessages.length > 0 || this.followUpMessages.length > 0;
  }

  queuedMessages(): {
    readonly steering: readonly (readonly UserContent[])[];
    readonly followUp: readonly (readonly UserContent[])[];
  } {
    return { steering: [...this.steeringMessages], followUp: [...this.followUpMessages] };
  }

  clearQueuedMessages(): void {
    this.steeringMessages.length = 0;
    this.followUpMessages.length = 0;
  }

  restoreQueuedMessages(messages: {
    readonly steering: readonly (readonly UserContent[])[];
    readonly followUp: readonly (readonly UserContent[])[];
  }): void {
    this.steeringMessages.unshift(...messages.steering.map((content) => [...content]));
    this.followUpMessages.unshift(...messages.followUp.map((content) => [...content]));
  }

  /** Starts a fresh turn for input left queued after an error or interruption. */
  async continueQueued(signal?: AbortSignal): Promise<TurnResult | undefined> {
    const queue = this.steeringMessages.length > 0 ? this.steeringMessages : this.followUpMessages;
    const content = queue.shift();
    return content === undefined ? undefined : this.runTurn(content, signal);
  }

  async dispose(): Promise<void> {
    await this.host.dispose();
    await this.log.drain();
  }

  /** Runs a user-requested shell command through the registered sandboxed shell tool. */
  async runShell(
    command: string,
    excluded: boolean,
    signal?: AbortSignal,
    requestedOperationId?: OperationId,
  ): Promise<CanonicalEvent<"user.shell">> {
    if (this.activeOperation !== null) {
      throw new OperationConflictError(
        `Operation ${this.activeOperation} already owns this branch`,
      );
    }
    const shell = this.tools.get("bash");
    if (!shell) throw new Error("The bash tool is unavailable in this session");
    const operationId = requestedOperationId ?? parseOperationId(randomUUID(), "operationId");
    this.activeOperation = operationId;
    try {
      const decided = await this.interceptCommand(
        "user_bash",
        "client",
        { command, excluded },
        signal,
      );
      if (typeof decided.command !== "string" || typeof decided.excluded !== "boolean") {
        throw new CommandBlockedError("user_bash", "extension returned invalid shell arguments");
      }
      command = decided.command;
      excluded = decided.excluded;
      const result = await shell.execute({ command }, signal ?? new AbortController().signal);
      const event = await this.append(operationId, "user.shell", {
        command,
        content: result.content,
        isError: result.isError,
        excluded,
      });
      if (!excluded) {
        this.messages.push({ role: "user", content: shellModelContent(event) });
      }
      return event;
    } finally {
      this.activeOperation = null;
    }
  }

  extensionCommands() {
    return this.host.commands?.() ?? [];
  }

  extensionInfo() {
    return {
      activeTools: this.tools.declarations().map((tool) => tool.name),
      ...(this.system === undefined ? {} : { systemPrompt: this.system }),
      ...(this.contextUsage === undefined ? {} : { contextTokens: this.contextUsage.tokens }),
      idle: this.activeOperation === null,
      pending: {
        steering: this.steeringMessages.length,
        followUp: this.followUpMessages.length,
      },
    };
  }

  async activateCapabilities(identities: readonly string[]): Promise<readonly string[]> {
    if (this.activeOperation !== null) {
      throw new OperationConflictError(
        `Operation ${this.activeOperation} owns this branch; activate tools after it`,
      );
    }
    if (this.capabilityService === undefined) {
      throw new Error("Capability activation is unavailable in this session");
    }
    const operationId = parseOperationId(randomUUID(), "operationId");
    const result = await this.capabilityService.activate(identities);
    for (const activated of result.activated) {
      await this.append(operationId, "capability.activated", activated);
      this.activeCapabilityContent.set(activated.capability.identity, activated.content);
      const declaration = this.tools.activateCapability(activated.capability.identity);
      if (declaration !== undefined) await this.append(operationId, "tool.schema", declaration);
    }
    for (const denied of result.denied) {
      await this.append(operationId, "capability.denied", denied);
    }
    this.contextUsage = undefined;
    return this.tools.declarations().map((tool) => tool.name);
  }

  invokeExtensionCommand(
    name: string,
    args: JsonObject,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (this.host.invokeCommand === undefined) {
      return Promise.reject(new Error(`Unknown extension command ${name}`));
    }
    return this.host.invokeCommand(name, args, signal);
  }

  async interceptInput(
    content: readonly UserContent[],
    source: "client" | "extension",
    signal: AbortSignal,
  ): Promise<{ readonly content: readonly UserContent[]; readonly handled: boolean }> {
    if (this.host.beforeInput === undefined) return { content, handled: false };
    const decision = await this.host.beforeInput({ source, content }, signal);
    if (decision?.action === "handled") return { content: [], handled: true };
    return {
      content: decision?.action === "transform" ? decision.content : content,
      handled: false,
    };
  }

  /**
   * Lets extensions replace or refuse a built-in command before it runs.
   * Returns the arguments to run with; throws `CommandBlockedError` on refusal.
   */
  interceptCommand(
    name: string,
    source: CommandSource,
    args: JsonObject,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    return interceptCommand(
      this.host,
      { name, source, args },
      signal ?? new AbortController().signal,
    );
  }

  /** Replaces older model-visible context with a durable continuation summary. */
  async compact(
    customInstructions?: string,
    signal?: AbortSignal,
    requestedOperationId?: OperationId,
    source: Exclude<CommandSource, "automatic"> = "client",
  ): Promise<CanonicalEvent<"context.compacted">> {
    if (this.activeOperation !== null) {
      throw new OperationConflictError(
        `Operation ${this.activeOperation} already owns this branch`,
      );
    }
    const operationId = requestedOperationId ?? parseOperationId(randomUUID(), "operationId");
    this.activeOperation = operationId;
    try {
      const event = await this.compactOwned(
        "manual",
        operationId,
        customInstructions,
        signal,
        source,
      );
      if (event === undefined) throw new CompactionUnavailableError(false);
      return event;
    } finally {
      this.activeOperation = null;
    }
  }

  private effectiveSystem(): string | undefined {
    const capabilities = [...this.activeCapabilityContent.values()];
    if (capabilities.length === 0) return this.system;
    return [this.system, ...capabilities].filter((value) => value !== undefined).join("\n\n");
  }

  private estimatedInputTokens(): number {
    return this.contextUsage === undefined
      ? estimateModelInputTokens({
          system: this.effectiveSystem(),
          messages: this.messages,
          tools: this.tools.declarations(),
        })
      : this.contextUsage.tokens +
          this.messages
            .slice(this.contextUsage.messageCount)
            .reduce((sum, message) => sum + estimateModelMessageTokens(message), 0);
  }

  private async compactOwned(
    reason: "manual" | "threshold" | "overflow",
    operationId: OperationId,
    customInstructions?: string,
    signal?: AbortSignal,
    source: CommandSource = "automatic",
  ): Promise<CanonicalEvent<"context.compacted"> | undefined> {
    let instructions = customInstructions?.trim();
    if (customInstructions !== undefined && !instructions) {
      throw new TypeError("Compaction instructions must not be empty");
    }
    const stored = await this.log.read();
    const tree = SessionTree.fromEvents(this.log.sessionId, stored.events);
    const lineage = this.tip === null ? [] : tree.lineage(this.tip);
    const adaptiveRecentTokens = Math.max(
      1,
      this.modelContextWindow -
        Math.min(this.compaction.reserveTokens, Math.floor(this.modelContextWindow / 2)),
    );
    const plan = prepareCompaction(
      lineage,
      reason === "manual"
        ? this.compaction.keepRecentTokens
        : Math.min(this.compaction.keepRecentTokens, adaptiveRecentTokens),
    );
    if (plan === undefined) {
      if (reason === "manual") {
        throw new CompactionUnavailableError(lineage.at(-1)?.type === "context.compacted");
      }
      return undefined;
    }
    const decided = await this.interceptCommand(
      "compact",
      source,
      {
        reason,
        ...(instructions === undefined ? {} : { instructions }),
        ...(plan.previousSummary === undefined ? {} : { previousSummary: plan.previousSummary }),
        transcript: serializeCompactionMessages(plan.messagesToSummarize),
      },
      signal,
    );
    if (decided.instructions !== undefined) {
      if (typeof decided.instructions !== "string" || decided.instructions.trim().length === 0) {
        throw new TypeError("Compaction instructions from an extension must be a non-empty string");
      }
      instructions = decided.instructions.trim();
    }
    let providedSummary: string | undefined;
    if (decided.summary !== undefined) {
      if (typeof decided.summary !== "string" || decided.summary.trim().length === 0) {
        throw new TypeError("Compaction summary from an extension must be a non-empty string");
      }
      providedSummary = decided.summary;
    }
    await this.append(operationId, "compaction.started", {
      reason,
      estimatedInputTokens: this.estimatedInputTokens(),
      contextWindow: this.modelContextWindow,
      reserveTokens: this.compaction.reserveTokens,
      keepRecentTokens: this.compaction.keepRecentTokens,
    });
    try {
      const result: CompactionSummary =
        providedSummary === undefined
          ? await summarizeCompaction(
              plan,
              this.model,
              instructions,
              signal,
              this.compaction.reserveTokens,
              async (configuration) => {
                await this.append(operationId, "model.request_configured", configuration);
              },
            )
          : {
              summary: withFileSections(providedSummary, plan),
              usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
              readFiles: plan.readFiles,
              modifiedFiles: plan.modifiedFiles,
            };
      signal?.throwIfAborted();
      const event = await this.append(operationId, "context.compacted", {
        summary: result.summary,
        replacedEventIds: plan.replacedEventIds,
        reason,
        willRetry: reason !== "manual",
        readFiles: result.readFiles,
        modifiedFiles: result.modifiedFiles,
        usage: result.usage,
      });
      this.messages = [...messagesFromLineage([...lineage, event])];
      this.contextUsage = undefined;
      return event;
    } catch (error) {
      await this.append(operationId, "compaction.failed", {
        reason,
        code: signal?.aborted ? "cancelled" : "summarization_failed",
        message: error instanceof Error ? error.message : "Compaction failed",
        willRetry: false,
      });
      throw error;
    }
  }

  /** Runs one user turn: model calls, steering, follow-ups, and tools until a final stop. */
  async runTurn(
    content: readonly UserContent[],
    signal?: AbortSignal,
    requestedOperationId?: OperationId,
  ): Promise<TurnResult> {
    if (this.activeOperation !== null) {
      throw new OperationConflictError(
        `Operation ${this.activeOperation} already owns this branch`,
      );
    }
    const operationId = requestedOperationId ?? parseOperationId(randomUUID(), "operationId");
    this.activeOperation = operationId;
    this.acceptingQueuedMessages = true;
    const appended: CanonicalEvent[] = [];
    try {
      await this.appendUserMessage(operationId, content, appended);
      await this.appendExtensionContext("agent", operationId, appended, signal);

      const activity = { sequence: 0 };
      let overflowRetried = false;
      while (true) {
        if (shouldCompact(this.estimatedInputTokens(), this.modelContextWindow, this.compaction)) {
          const compacted = await this.compactOwned("threshold", operationId, undefined, signal);
          if (compacted !== undefined) {
            while (
              await this.appendNextQueuedMessage(this.steeringMessages, operationId, appended)
            ) {
              // Steering received during summarization belongs before the resumed request.
            }
          }
        }
        await this.appendExtensionContext("request", operationId, appended, signal);
        const outcome = await this.modelTurn(operationId, activity, signal, appended);
        if (
          this.compaction.enabled &&
          !overflowRetried &&
          !outcome.exposedOutput &&
          outcome.error?.category === "context_limit"
        ) {
          overflowRetried = true;
          try {
            const compacted = await this.compactOwned("overflow", operationId, undefined, signal);
            if (compacted !== undefined) {
              while (
                await this.appendNextQueuedMessage(this.steeringMessages, operationId, appended)
              ) {
                // Preserve steering at the recovered model boundary.
              }
              continue;
            }
          } catch {
            // The durable compaction failure and original provider error explain the failed turn.
          }
        }
        const assistantEvent = await this.append(operationId, "assistant.message", {
          content: outcome.content,
          stopReason: outcome.stopReason,
          ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
          ...(outcome.error === undefined
            ? {}
            : { errorMessage: `${outcome.error.code}: ${outcome.error.message}` }),
        });
        appended.push(assistantEvent);
        // Keep the live history identical to `messagesFromCompactedLineage`: an aborted or
        // failed turn with no content and no tool calls is recorded canonically but is not a
        // model-visible message. Providers reject empty assistant messages.
        if (assistantEvent.payload.content.length > 0 || outcome.toolCalls.length > 0) {
          this.messages.push({
            role: "assistant",
            content: assistantEvent.payload.content,
            toolCalls: outcome.toolCalls,
          });
        }
        this.publishActivity({
          operationId,
          sequence: ++activity.sequence,
          type: "clear",
        });

        if (outcome.stopReason === "error" || outcome.stopReason === "aborted") {
          return { events: appended, stopReason: outcome.stopReason };
        }
        if (outcome.usage !== undefined) {
          const tokens =
            outcome.usage.inputTokens +
            outcome.usage.outputTokens +
            outcome.usage.cacheReadTokens +
            outcome.usage.cacheWriteTokens;
          if (tokens > 0) this.contextUsage = { tokens, messageCount: this.messages.length };
        }
        if (outcome.stopReason === "tool_use") {
          if (outcome.toolCalls.length === 0) {
            appended.push(
              await this.append(operationId, "session.error", {
                code: "missing_tool_call",
                message: "Model ended with tool_use but supplied no tool call",
                retryable: false,
              }),
            );
            return { events: appended, stopReason: "error" };
          }
          const aborted = await this.executeToolCalls(
            operationId,
            outcome.toolCalls,
            appended,
            signal,
          );
          // Use the normal terminal-message path without dispatching another model request.
          if (aborted) continue;
        }
        if (await this.appendNextQueuedMessage(this.steeringMessages, operationId, appended)) {
          continue;
        }
        if (outcome.stopReason === "tool_use") continue;
        if (await this.appendNextQueuedMessage(this.followUpMessages, operationId, appended)) {
          continue;
        }
        return { events: appended, stopReason: outcome.stopReason };
      }
    } finally {
      this.acceptingQueuedMessages = false;
      this.activeOperation = null;
    }
  }

  private async appendUserMessage(
    operationId: OperationId,
    content: readonly UserContent[],
    appended: CanonicalEvent[],
  ): Promise<void> {
    const event = await this.append(operationId, "user.message", { content });
    appended.push(event);
    this.messages.push({ role: "user", content: event.payload.content });
  }

  private async appendNextQueuedMessage(
    queue: Array<readonly UserContent[]>,
    operationId: OperationId,
    appended: CanonicalEvent[],
  ): Promise<boolean> {
    const content = queue[0];
    if (content === undefined) return false;
    await this.appendUserMessage(operationId, content, appended);
    queue.shift();
    return true;
  }

  async abortRecoveredTurn(operationId: OperationId): Promise<CanonicalEvent<"assistant.message">> {
    if (this.activeOperation !== null) {
      throw new OperationConflictError(
        `Operation ${this.activeOperation} already owns this branch`,
      );
    }
    return this.append(operationId, "assistant.message", {
      content: [],
      stopReason: "aborted",
      errorMessage:
        "Operation was aborted because the daemon restarted before recording completion.",
    });
  }

  async abortRecoveredDelivery(
    operationId: OperationId,
    content: readonly UserContent[],
  ): Promise<{
    readonly message: CanonicalEvent<"user.message">;
    readonly terminal: CanonicalEvent<"assistant.message">;
  }> {
    if (this.activeOperation !== null) {
      throw new OperationConflictError(
        `Operation ${this.activeOperation} already owns this branch`,
      );
    }
    const appended: CanonicalEvent[] = [];
    await this.appendUserMessage(operationId, content, appended);
    const message = appended[0];
    if (message?.type !== "user.message") {
      throw new Error("Recovered delivery did not append its user message");
    }
    const terminal = await this.abortRecoveredTurn(operationId);
    return { message, terminal };
  }

  async close(operationId: OperationId): Promise<CanonicalEvent<"session.closed">> {
    if (this.activeOperation !== null) {
      throw new OperationConflictError(
        `Operation ${this.activeOperation} already owns this branch`,
      );
    }
    return this.append(operationId, "session.closed", { reason: "disposed" });
  }

  private async modelTurn(
    operationId: OperationId,
    activity: { sequence: number },
    signal: AbortSignal | undefined,
    appended: CanonicalEvent[],
  ): Promise<TurnOutcome> {
    if (signal?.aborted) {
      return { content: [], toolCalls: [], stopReason: "aborted", exposedOutput: false };
    }
    const retry = this.retry;
    const maxAttempts = retry?.maxAttempts ?? 1;
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.modelAttempt(operationId, activity, signal, appended);
      const error = outcome.error;
      if (
        retry === undefined ||
        error === undefined ||
        !error.retryable ||
        error.requestPhase === undefined ||
        error.requestPhase === "unknown" ||
        outcome.exposedOutput ||
        attempt >= maxAttempts
      ) {
        return outcome;
      }

      const delayMs = modelRetryDelay(error, attempt, retry, this.retryRandom);
      appended.push(
        await this.append(operationId, "model.retry_scheduled", {
          attempt: attempt + 1,
          maxAttempts,
          delayMs,
          code: error.code,
        }),
      );
      try {
        await this.retrySleep(delayMs, signal);
      } catch (sleepError) {
        if (signal?.aborted) {
          return { content: [], toolCalls: [], stopReason: "aborted", exposedOutput: false };
        }
        return {
          content: [],
          toolCalls: [],
          stopReason: "error",
          exposedOutput: false,
          error: {
            code: "retry_scheduler_failed",
            message:
              sleepError instanceof Error ? sleepError.message : "model retry scheduler failed",
            retryable: false,
            category: "unknown",
            requestPhase: "before_dispatch",
          },
        };
      }
      if (signal?.aborted) {
        return { content: [], toolCalls: [], stopReason: "aborted", exposedOutput: false };
      }
    }
  }

  private async modelAttempt(
    operationId: OperationId,
    activity: { sequence: number },
    signal: AbortSignal | undefined,
    appended: CanonicalEvent[],
  ): Promise<TurnOutcome> {
    let thinking = "";
    let text = "";
    const toolCalls: ToolCallRequest[] = [];
    let terminal: TerminalModelStreamEvent | undefined;
    let exposedOutput = false;

    try {
      // Snapshot: the port must never observe the turn mutating history under it.
      const estimatedInputTokens = this.estimatedInputTokens();
      for await (const event of this.model.stream({
        estimatedInputTokens,
        onRequestConfigured: async (configuration) => {
          appended.push(await this.append(operationId, "model.request_configured", configuration));
        },
        system: this.effectiveSystem(),
        messages: [...this.messages],
        tools: this.tools.declarations(),
        signal,
      })) {
        if (event.type === "text_delta") {
          exposedOutput = true;
          text += event.text;
          this.publishActivity({
            operationId,
            sequence: ++activity.sequence,
            type: "text_delta",
            text: event.text,
          });
        } else if (event.type === "thinking_delta") {
          exposedOutput = true;
          thinking += event.text;
          this.publishActivity({
            operationId,
            sequence: ++activity.sequence,
            type: "thinking_delta",
            text: event.text,
          });
        } else if (event.type === "tool_call") {
          exposedOutput = true;
          toolCalls.push({ callId: event.callId, name: event.name, input: event.input });
          this.publishActivity({
            operationId,
            sequence: ++activity.sequence,
            type: "tool_call",
            call: { callId: event.callId, name: event.name },
          });
        }
        if (isTerminalModelStreamEvent(event)) {
          terminal = event;
          break;
        }
      }
    } catch (error) {
      terminal = signal?.aborted
        ? { type: "aborted" }
        : {
            type: "error",
            code: "model_port_failure",
            message: error instanceof Error ? error.message : "model port threw a non-Error value",
            retryable: false,
          };
    }
    if (terminal === undefined) {
      terminal = signal?.aborted
        ? { type: "aborted" }
        : {
            type: "error",
            code: "model_stream_truncated",
            message: "model stream ended without a terminal event",
            retryable: false,
          };
    }

    const content: AssistantContent[] = [];
    if (thinking.length > 0) content.push({ type: "thinking", text: thinking });
    if (text.length > 0) content.push({ type: "text", text });

    if (terminal.type === "completed") {
      return {
        content,
        toolCalls,
        stopReason: terminal.stopReason,
        usage: terminal.usage,
        exposedOutput,
      };
    }
    if (terminal.type === "aborted") {
      return { content, toolCalls: [], stopReason: "aborted", exposedOutput };
    }
    return { content, toolCalls: [], stopReason: "error", error: terminal, exposedOutput };
  }

  private async appendExtensionContext(
    phase: "agent" | "request",
    operationId: OperationId,
    appended: CanonicalEvent[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.host.contributeContext === undefined) return;
    const contributions = await this.host.contributeContext(
      {
        phase,
        systemPrompt: this.effectiveSystem() ?? "",
        messages: structuredClone(this.messages),
      },
      signal ?? new AbortController().signal,
    );
    for (const contribution of contributions) {
      const event = await this.append(operationId, "context.extension", contribution);
      appended.push(event);
      this.messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `[extension:${contribution.extensionId}/${contribution.source}]\n${contribution.content}`,
          },
        ],
      });
    }
  }

  /** Appends daemon-owned compaction queue lifecycle state to the canonical session log. */
  recordCompactionQueued(
    operationId: OperationId,
    instructions?: string,
  ): Promise<CanonicalEvent<"compaction.queued">> {
    return this.append(operationId, "compaction.queued", {
      ...(instructions === undefined ? {} : { instructions }),
    });
  }

  recordCompactionFailed(
    operationId: OperationId,
    code: string,
    message: string,
  ): Promise<CanonicalEvent<"compaction.failed">> {
    return this.append(operationId, "compaction.failed", {
      reason: "manual",
      code,
      message,
      willRetry: false,
    });
  }

  /** Appends daemon-owned queue lifecycle state to the canonical session log. */
  recordQueueEvent<
    Type extends
      | "queue.enqueued"
      | "queue.requeued"
      | "queue.started"
      | "queue.paused"
      | "queue.restored",
  >(
    operationId: OperationId,
    type: Type,
    payload: EventPayloadMap[Type],
  ): Promise<CanonicalEvent<Type>> {
    return this.append(operationId, type, payload);
  }

  /** Appends daemon-owned interrupt-and-deliver lifecycle state. */
  recordInterruptEvent<Type extends "interrupt.requested" | "interrupt.updated">(
    operationId: OperationId,
    type: Type,
    payload: EventPayloadMap[Type],
  ): Promise<CanonicalEvent<Type>> {
    return this.append(operationId, type, payload);
  }

  rename(operationId: OperationId, title: string): Promise<CanonicalEvent<"session.renamed">> {
    if (this.activeOperation !== null) {
      throw new OperationConflictError(`Operation ${this.activeOperation} owns this branch`);
    }
    return this.append(operationId, "session.renamed", { title });
  }

  recordSessionError(
    operationId: OperationId,
    payload: EventPayloadMap["session.error"],
  ): Promise<CanonicalEvent<"session.error">> {
    return this.append(operationId, "session.error", payload);
  }

  /** Executes each call, appending paired call/result events. Returns true when aborted. */
  private async executeToolCalls(
    operationId: OperationId,
    toolCalls: readonly ToolCallRequest[],
    appended: CanonicalEvent[],
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    for (const requested of toolCalls) {
      const prepared = await this.interceptToolCall(requested, signal);
      const call = prepared.call;
      appended.push(
        await this.append(operationId, "tool.call", {
          callId: call.callId,
          name: call.name,
          input: call.input,
        }),
      );
      const executed =
        prepared.blocked === undefined
          ? await this.executeTool(call, signal)
          : { result: prepared.blocked };
      const { result, violation } = {
        ...executed,
        result: await this.interceptToolResult(call, executed.result, signal),
      };
      if (violation !== undefined) {
        appended.push(
          await this.append(operationId, "sandbox.violation", {
            capability: violation.capability,
            reason: violation.reason,
          }),
        );
      }
      const resultEvent = await this.append(operationId, "tool.result", {
        callId: call.callId,
        name: call.name,
        content: result.content,
        isError: result.isError,
        ...(result.details === undefined ? {} : { details: result.details }),
      });
      appended.push(resultEvent);
      this.messages.push({
        role: "tool",
        callId: call.callId,
        name: call.name,
        content: resultEvent.payload.content,
        isError: result.isError,
      });
      for (const effect of result.sessionEffects ?? []) {
        appended.push(await this.append(operationId, effect.type, effect.payload as never));
        if (effect.type === "capability.activated") {
          this.activeCapabilityContent.set(
            effect.payload.capability.identity,
            effect.payload.content,
          );
          const declaration = this.tools.activateCapability(effect.payload.capability.identity);
          if (declaration !== undefined) {
            appended.push(await this.append(operationId, "tool.schema", declaration));
          }
          this.contextUsage = undefined;
        }
      }
      if (signal?.aborted) return true;
    }
    return false;
  }

  private async interceptToolCall(
    call: ToolCallRequest,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly call: ToolCallRequest; readonly blocked?: ToolExecutionResult }> {
    if (this.host.beforeToolCall === undefined) return { call };
    let decision: ToolCallDecision;
    try {
      decision = await this.host.beforeToolCall(
        { callId: call.callId, name: call.name, input: call.input },
        signal ?? new AbortController().signal,
      );
    } catch (error) {
      decision = {
        block: true,
        reason: error instanceof Error ? error.message : "extension tool gate failed",
      };
    }
    if (decision === undefined) return { call };
    if ("input" in decision) return { call: { ...call, input: decision.input } };
    return {
      call,
      blocked: {
        content: [{ type: "text", text: `Tool ${call.name} was blocked: ${decision.reason}` }],
        isError: true,
      },
    };
  }

  private async interceptToolResult(
    call: ToolCallRequest,
    result: ToolExecutionResult,
    signal: AbortSignal | undefined,
  ): Promise<ToolExecutionResult> {
    if (this.host.afterToolCall === undefined) return result;
    try {
      const decision = await this.host.afterToolCall(
        {
          callId: call.callId,
          name: call.name,
          input: call.input,
          content: result.content,
          isError: result.isError,
          ...(result.details === undefined ? {} : { details: result.details }),
        },
        signal ?? new AbortController().signal,
      );
      return decision === undefined ? result : { ...result, ...decision };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : "extension tool result hook failed",
          },
        ],
        isError: true,
      };
    }
  }

  private async executeTool(
    call: ToolCallRequest,
    signal: AbortSignal | undefined,
  ): Promise<{ result: ToolExecutionResult; violation?: SandboxViolationError }> {
    const tool = this.tools.get(call.name);
    if (tool === undefined) {
      return {
        result: {
          content: [{ type: "text", text: `Tool ${call.name} is not registered` }],
          isError: true,
        },
      };
    }
    const executionSignal = signal ?? new AbortController().signal;
    try {
      const result = await tool.execute(call.input, executionSignal, {
        activeCapabilities: new Set(this.activeCapabilityContent.keys()),
      });
      if (result.sessionEffects !== undefined && call.name !== "capability_search") {
        throw new Error(`Tool ${call.name} cannot emit session effects`);
      }
      return { result };
    } catch (error) {
      const failure = {
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : "tool execution failed",
          },
        ],
        isError: true,
      };
      if (error instanceof SandboxViolationError) return { result: failure, violation: error };
      return { result: failure };
    }
  }

  private publishActivity(frame: SessionActivityFrame): void {
    try {
      this.host.observeActivity?.(frame);
    } catch {
      // Presentation activity is advisory and cannot fail the agent operation.
    }
    this.onActivity?.(frame);
  }

  private async append<Type extends EventType>(
    operationId: OperationId | undefined,
    type: Type,
    payload: EventPayloadMap[Type],
  ): Promise<CanonicalEvent<Type>> {
    const event = parseEvent({
      version: EVENT_FORMAT_VERSION,
      id: randomUUID(),
      sessionId: this.log.sessionId,
      ...(operationId === undefined ? {} : { operationId }),
      parentId: this.tip,
      timestamp: Date.now(),
      type,
      payload,
    });
    const stored = await this.log.append(event);
    this.tip = stored.id;
    this.knownEventIds.add(stored.id);
    this.onEvent?.(stored);
    this.host.observe?.(stored);
    return stored as CanonicalEvent<Type>;
  }
}
