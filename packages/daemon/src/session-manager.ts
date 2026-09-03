// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, open as openFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  AgentSession,
  type EventLogOptions,
  type ExtensionHost,
  JsonlEventLog,
  type ModelPort,
  SessionTree,
  type StablePrompt,
  type ToolRegistry,
} from "@axl/kernel";
import {
  type BlobReference,
  type CanonicalEvent,
  EVENT_FORMAT_VERSION,
  type EventId,
  type EventPayloadMap,
  type InteractionAction,
  type JsonObject,
  type JsonValue,
  type OperationId,
  parseEvent,
  parseEventId,
  parseOperationId,
  parseSessionId,
  type SessionActivityFrame,
  type SessionId,
  type SessionModelSelection,
  type SessionOpenResult,
  type SessionSummary,
  type UserContent,
  type WorkspaceDiff,
  type WorkspaceDiffScope,
} from "@axl/protocol";

import { BlobStore, BlobStoreError } from "./blob-store.ts";
import { WorkspaceCheckpointError, WorkspaceCheckpointStore } from "./workspace-checkpoint.ts";

export class DaemonError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DaemonError";
    this.code = code;
  }
}

export interface SessionRuntime {
  readonly model: ModelPort;
  readonly tools: ToolRegistry;
  readonly prompt?: StablePrompt;
  readonly system?: string;
  readonly log?: EventLogOptions;
  readonly extensionHost?: ExtensionHost;
  readonly sandbox?: EventPayloadMap["sandbox.configured"];
  readonly configModel?: EventPayloadMap["config.model"];
  readonly configThinking?: EventPayloadMap["config.thinking"];
  readonly configDialect?: EventPayloadMap["config.dialect"];
}

export type SessionRuntimeBoundary = "session_start" | "reload" | "model_switch" | "config_change";

export interface SessionInteractionRequest {
  readonly kind: EventPayloadMap["interaction.requested"]["kind"];
  readonly source: string;
  readonly message: string;
  readonly data?: JsonObject;
}

export interface SessionInteractionResponse {
  readonly action: InteractionAction;
  readonly content?: JsonObject;
}

export type SessionRuntimeFactory = (input: {
  readonly sessionId: SessionId;
  readonly cwd: string;
  readonly boundary: SessionRuntimeBoundary;
  readonly selection: SessionModelSelection;
  readonly interact: (
    request: SessionInteractionRequest,
    signal?: AbortSignal,
  ) => Promise<SessionInteractionResponse>;
  readonly readBlob: (reference: BlobReference) => Promise<Uint8Array>;
}) => SessionRuntime | Promise<SessionRuntime>;

export interface SessionManagerOptions {
  readonly dataDirectory: string;
  readonly runtime: SessionRuntimeFactory;
}

interface ActiveTurn {
  readonly operationId: OperationId;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  finish(): void;
}

interface PendingInteraction {
  readonly resolve: (response: SessionInteractionResponse) => void;
  readonly reject: (error: Error) => void;
}

interface ManagedSession {
  session: AgentSession;
  readonly cwd: string;
  readonly events: CanonicalEvent[];
  readonly listeners: Set<(event: CanonicalEvent) => void>;
  readonly activityListeners: Set<(frame: SessionActivityFrame) => void>;
  readonly activityState: {
    current?: SessionActivityFrame;
    text: string;
    thinking: string;
    tools: Array<{ callId: string; name: string }>;
  };
  selection: SessionModelSelection;
  activeTurn?: ActiveTurn;
  rebuilding?: Promise<void>;
  readonly interactions: Map<string, PendingInteraction>;
  checkpointError?: WorkspaceCheckpointError;
  workspaceCheckpointsEnabled: boolean;
}

function deferredTurn(operationId = parseOperationId(randomUUID(), "operationId")): ActiveTurn {
  let resolveDone = (): void => undefined;
  const done = new Promise<void>((resolvePromise) => {
    resolveDone = resolvePromise;
  });
  return { operationId, controller: new AbortController(), done, finish: resolveDone };
}

function userMessageText(event: CanonicalEvent): string | undefined {
  if (event.type !== "user.message") return undefined;
  const text = event.payload.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  return text || undefined;
}

function summarizeSession(events: readonly CanonicalEvent[]): SessionSummary {
  const created = events[0];
  if (created?.type !== "session.created") {
    throw new DaemonError("corrupt_session", "Session has no creation event");
  }
  const messages = events.flatMap((event) => {
    const text = userMessageText(event);
    return text === undefined ? [] : [text];
  });
  const firstUserMessage = messages[0];
  const lastUserMessage = messages.at(-1);
  return {
    sessionId: created.sessionId,
    cwd: created.payload.cwd,
    createdAt: created.timestamp,
    updatedAt: events.at(-1)?.timestamp ?? created.timestamp,
    userMessageCount: messages.length,
    ...(firstUserMessage === undefined ? {} : { firstUserMessage }),
    ...(lastUserMessage === undefined ? {} : { lastUserMessage }),
    ...(created.payload.parentSessionId === undefined
      ? {}
      : { parentSessionId: created.payload.parentSessionId }),
  };
}

/** Owns every live session. Clients never receive a mutable kernel object. */
export class SessionManager {
  private readonly options: SessionManagerOptions;
  private readonly sessions = new Map<SessionId, ManagedSession>();
  private readonly opening = new Map<SessionId, Promise<ManagedSession>>();
  private readonly workspaceCheckpoints: WorkspaceCheckpointStore;
  private readonly blobs: BlobStore;

  constructor(options: SessionManagerOptions) {
    this.options = { ...options, dataDirectory: resolve(options.dataDirectory) };
    this.workspaceCheckpoints = new WorkspaceCheckpointStore(this.options.dataDirectory);
    this.blobs = new BlobStore(this.options.dataDirectory);
  }

  private logPath(sessionId: SessionId): string {
    return join(this.options.dataDirectory, "sessions", `${sessionId}.jsonl`);
  }

  private async buildSession(
    sessionId: SessionId,
    cwd: string,
    events: CanonicalEvent[],
    listeners: Set<(event: CanonicalEvent) => void>,
    activityListeners: Set<(frame: SessionActivityFrame) => void>,
    activityState: {
      current?: SessionActivityFrame;
      text: string;
      thinking: string;
      tools: Array<{ callId: string; name: string }>;
    },
    boundary: SessionRuntimeBoundary,
    selection: SessionModelSelection,
    boundaryOperationId?: OperationId,
  ): Promise<AgentSession> {
    const runtime = await this.options.runtime({
      sessionId,
      cwd,
      boundary,
      selection,
      interact: (request, signal) => this.interact(sessionId, request, signal),
      readBlob: (reference) => this.blobs.readAll(sessionId, reference),
    });
    return AgentSession.open(this.logPath(sessionId), sessionId, {
      model: runtime.model,
      tools: runtime.tools,
      cwd,
      ...(runtime.prompt === undefined ? {} : { prompt: runtime.prompt }),
      ...(runtime.system === undefined ? {} : { system: runtime.system }),
      ...(runtime.log === undefined ? {} : { log: runtime.log }),
      ...(runtime.extensionHost === undefined ? {} : { extensionHost: runtime.extensionHost }),
      ...(runtime.sandbox === undefined ? {} : { sandbox: runtime.sandbox }),
      ...(runtime.configModel === undefined ? {} : { configModel: runtime.configModel }),
      ...(runtime.configThinking === undefined ? {} : { configThinking: runtime.configThinking }),
      ...(runtime.configDialect === undefined ? {} : { configDialect: runtime.configDialect }),
      ...(boundaryOperationId === undefined ? {} : { boundaryOperationId }),
      onEvent: (event) => {
        events.push(event);
        this.authorizeEventBlobs(sessionId, event);
        for (const listener of listeners) listener(event);
      },
      onActivity: (frame) => {
        if (!this.applyActivity(activityState, frame)) return;
        for (const listener of activityListeners) listener(frame);
      },
    });
  }

  private async open(
    sessionId: SessionId,
    cwd: string,
    selection: SessionModelSelection,
  ): Promise<ManagedSession> {
    const events: CanonicalEvent[] = [];
    const listeners = new Set<(event: CanonicalEvent) => void>();
    const activityListeners = new Set<(frame: SessionActivityFrame) => void>();
    const activityState = {
      text: "",
      thinking: "",
      tools: [] as Array<{ callId: string; name: string }>,
    };
    const session = await this.buildSession(
      sessionId,
      cwd,
      events,
      listeners,
      activityListeners,
      activityState,
      "session_start",
      selection,
    );
    const stored = await session.log.read();
    events.length = 0;
    events.push(...stored.events);
    for (const event of events) this.authorizeEventBlobs(sessionId, event);
    const managed: ManagedSession = {
      session,
      cwd,
      events,
      listeners,
      activityListeners,
      activityState,
      selection,
      interactions: new Map(),
      workspaceCheckpointsEnabled: false,
    };
    this.sessions.set(sessionId, managed);
    return managed;
  }

  async create(
    cwd: string,
    selection: SessionModelSelection = {},
    reservation?: { readonly sessionId: SessionId; readonly operationId: OperationId },
  ): Promise<{ sessionId: SessionId; events: readonly CanonicalEvent[] }> {
    const canonicalCwd = await realpath(cwd).catch((cause: unknown) => {
      throw new DaemonError("invalid_cwd", `Cannot open working directory ${cwd}`, { cause });
    });
    await mkdir(join(this.options.dataDirectory, "sessions"), { recursive: true, mode: 0o700 });
    const sessionId = reservation?.sessionId ?? parseSessionId(randomUUID(), "sessionId");
    if (reservation !== undefined) {
      const opened = await JsonlEventLog.open(this.logPath(sessionId), sessionId);
      const root = opened.events[0];
      if (root === undefined) {
        await opened.log.append({
          version: EVENT_FORMAT_VERSION,
          id: randomUUID(),
          sessionId,
          operationId: reservation.operationId,
          parentId: null,
          timestamp: Date.now(),
          type: "session.created",
          payload: { cwd: canonicalCwd },
        });
        await opened.log.drain();
      } else if (
        root.type !== "session.created" ||
        root.operationId !== reservation.operationId ||
        root.payload.cwd !== canonicalCwd
      ) {
        throw new DaemonError(
          "corrupt_session",
          `Reserved session ${sessionId} has conflicting history`,
        );
      }
    }
    const managed = await this.open(sessionId, canonicalCwd, selection);
    return { sessionId, events: [...managed.events] };
  }

  async reconcileAcceptedMutation(acceptance: {
    readonly method: string;
    readonly operationId: string;
    readonly targetSessionId?: SessionId;
    readonly intendedSessionId?: SessionId;
    readonly affectedOperationId?: string;
    readonly interactionId?: string;
  }): Promise<unknown | undefined> {
    const operationId = parseOperationId(acceptance.operationId, "operationId");
    if (
      acceptance.method === "session.create" ||
      acceptance.method === "session.fork" ||
      acceptance.method === "session.clone"
    ) {
      const intended = acceptance.intendedSessionId;
      if (intended === undefined)
        throw new DaemonError("corrupt_session", "Missing intended session ID");
      try {
        await stat(this.logPath(intended));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      const events = (await JsonlEventLog.open(this.logPath(intended), intended)).events;
      const root = events[0];
      if (root === undefined) return undefined;
      if (root.type !== "session.created" || root.operationId !== operationId) {
        throw new DaemonError(
          "corrupt_session",
          `Reserved session ${intended} has conflicting history`,
        );
      }
      await this.resume(intended);
      const result = this.describe(intended);
      if (acceptance.method !== "session.fork") return result;
      const sourceId = root.payload.parentSessionId;
      const sourceEventId = root.payload.sourceEventId;
      if (sourceId === undefined || sourceEventId === undefined) {
        throw new DaemonError(
          "corrupt_session",
          `Forked session ${intended} lacks source identity`,
        );
      }
      await this.resume(sourceId);
      const selected = this.managed(sourceId).events.find((event) => event.id === sourceEventId);
      const selectedText = selected === undefined ? undefined : userMessageText(selected);
      return { ...result, ...(selectedText === undefined ? {} : { selectedText }) };
    }

    const target = acceptance.targetSessionId;
    if (target === undefined) throw new DaemonError("corrupt_session", "Missing target session ID");
    try {
      await stat(this.logPath(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const stored = (await JsonlEventLog.open(this.logPath(target), target)).events;
    const evidence = stored.filter((event) => event.operationId === operationId);
    if (acceptance.method === "session.interrupt") {
      const affected =
        acceptance.affectedOperationId === undefined
          ? undefined
          : parseOperationId(acceptance.affectedOperationId, "affectedOperationId");
      if (affected === undefined) return { interrupted: false };
      const affectedEvents = stored.filter((event) => event.operationId === affected);
      const terminal = affectedEvents.some(
        (event) =>
          (event.type === "assistant.message" && event.payload.stopReason !== "tool_use") ||
          event.type === "session.error",
      );
      if (!terminal && affectedEvents.some((event) => event.type === "user.message")) {
        await this.resume(target);
        await this.managed(target).session.abortRecoveredTurn(affected);
      }
      return { interrupted: affectedEvents.length > 0 };
    }
    if (acceptance.method === "session.dispose") {
      return evidence.some((event) => event.type === "session.closed")
        ? { disposed: true }
        : undefined;
    }
    if (acceptance.method === "session.interaction.respond") {
      if (evidence.some((event) => event.type === "interaction.resolved")) {
        return { resolved: true };
      }
      if (acceptance.interactionId === undefined) {
        throw new DaemonError("corrupt_session", "Missing accepted interaction identity");
      }
      await this.resume(target);
      const resolution = this.managed(target).events.find(
        (event) =>
          event.type === "interaction.resolved" &&
          event.payload.interactionId === acceptance.interactionId,
      );
      if (resolution !== undefined) {
        throw new DaemonError(
          "cancelled",
          `Interaction ${acceptance.interactionId} was cancelled during daemon recovery`,
        );
      }
      return undefined;
    }
    if (evidence.length === 0) return undefined;
    await this.resume(target);
    if (acceptance.method === "session.send") {
      const terminal = evidence.findLast(
        (event) =>
          (event.type === "assistant.message" && event.payload.stopReason !== "tool_use") ||
          event.type === "session.error",
      );
      if (terminal?.type === "assistant.message")
        return { stopReason: terminal.payload.stopReason };
      if (terminal?.type === "session.error") return { stopReason: "error" };
      if (evidence.some((event) => event.type === "user.message")) {
        const aborted = await this.managed(target).session.abortRecoveredTurn(operationId);
        return { stopReason: aborted.payload.stopReason };
      }
      return undefined;
    }
    if (acceptance.method === "session.reload" || acceptance.method === "session.configure") {
      return { events: evidence };
    }
    return undefined;
  }

  activeOperationId(sessionId: unknown): OperationId | undefined {
    const parsed = parseSessionId(sessionId, "sessionId");
    return this.sessions.get(parsed)?.activeTurn?.operationId;
  }

  describe(sessionId: unknown): SessionOpenResult {
    const managed = this.managed(sessionId);
    const activeOperationId = managed.activityState.current?.operationId;
    return {
      sessionId: managed.session.log.sessionId,
      cwd: managed.cwd,
      runtime: {
        state:
          managed.interactions.size > 0
            ? "waiting_interaction"
            : managed.activeTurn !== undefined || managed.rebuilding !== undefined
              ? "running"
              : "idle",
        ...(activeOperationId === undefined ? {} : { activeOperationId }),
      },
      profile: "minimal",
    };
  }

  async list(): Promise<readonly SessionSummary[]> {
    const directory = join(this.options.dataDirectory, "sessions");
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const summaries: SessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionId = parseSessionId(basename(entry.name, ".jsonl"), "session file name");
      const active = this.sessions.get(sessionId);
      const events =
        active?.events ?? (await JsonlEventLog.open(join(directory, entry.name), sessionId)).events;
      summaries.push(summarizeSession(events));
    }
    return summaries.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async fork(
    sessionId: unknown,
    fromEventId: unknown,
    reservation?: { readonly sessionId: SessionId; readonly operationId: OperationId },
  ): Promise<{
    readonly sessionId: SessionId;
    readonly events: readonly CanonicalEvent[];
    readonly selectedText?: string;
  }> {
    const sourceId = parseSessionId(sessionId, "sessionId");
    await this.resume(sourceId);
    const source = this.managed(sourceId);
    if (source.activeTurn || source.rebuilding) {
      throw new DaemonError("operation_active", "An operation owns this session; fork after it");
    }
    const eventId = parseEventId(fromEventId, "fromEventId");
    const event = SessionTree.fromEvents(sourceId, source.events).event(eventId);
    if (event.type !== "user.message") {
      throw new DaemonError("invalid_fork_point", "A fork must start from a user message");
    }
    return this.copySession(sourceId, eventId, false, userMessageText(event), reservation);
  }

  async clone(
    sessionId: unknown,
    reservation?: { readonly sessionId: SessionId; readonly operationId: OperationId },
  ): Promise<{
    readonly sessionId: SessionId;
    readonly events: readonly CanonicalEvent[];
    readonly selectedText?: string;
  }> {
    const sourceId = parseSessionId(sessionId, "sessionId");
    await this.resume(sourceId);
    const source = this.managed(sourceId);
    if (source.activeTurn || source.rebuilding) {
      throw new DaemonError("operation_active", "An operation owns this session; clone after it");
    }
    const tip = source.events.at(-1)?.id;
    if (tip === undefined)
      throw new DaemonError("empty_session", "Session has no history to clone");
    return this.copySession(sourceId, tip, true, undefined, reservation);
  }

  async resume(
    sessionId: unknown,
  ): Promise<{ sessionId: SessionId; events: readonly CanonicalEvent[] }> {
    const parsed = parseSessionId(sessionId, "sessionId");
    const existing = this.sessions.get(parsed);
    if (existing) return { sessionId: parsed, events: [...existing.events] };
    const pending = this.opening.get(parsed);
    if (pending) {
      const managed = await pending;
      return { sessionId: parsed, events: [...managed.events] };
    }

    const opening = this.resumeFromLog(parsed);
    this.opening.set(parsed, opening);
    try {
      const managed = await opening;
      return { sessionId: parsed, events: [...managed.events] };
    } finally {
      this.opening.delete(parsed);
    }
  }

  private async copySession(
    sourceId: SessionId,
    targetId: EventId,
    includeTarget: boolean,
    selectedText?: string,
    reservation?: { readonly sessionId: SessionId; readonly operationId: OperationId },
  ): Promise<{
    readonly sessionId: SessionId;
    readonly events: readonly CanonicalEvent[];
    readonly selectedText?: string;
  }> {
    const source = this.managed(sourceId);
    const tree = SessionTree.fromEvents(sourceId, source.events);
    const lineage = tree.lineage(targetId);
    const copied = includeTarget ? lineage.slice(1) : lineage.slice(1, -1);
    const sessionId = reservation?.sessionId ?? parseSessionId(randomUUID(), "sessionId");
    const path = this.logPath(sessionId);
    const stagingPath =
      reservation === undefined
        ? path
        : join(
            this.options.dataDirectory,
            "sessions",
            `.staging-${sessionId}-${reservation.operationId}.jsonl`,
          );
    const startedAt = Date.now();
    const eventIds = new Map<string, string>();
    const operationIds = new Map<string, string>();
    const sourceRoot = lineage[0];
    if (sourceRoot === undefined || sourceRoot.type !== "session.created") {
      throw new DaemonError("corrupt_session", `Session ${sourceId} has no creation event`);
    }
    if (reservation !== undefined) {
      const existing = await JsonlEventLog.open(path, sessionId);
      const root = existing.events[0];
      if (root !== undefined) {
        if (
          root.type !== "session.created" ||
          root.operationId !== reservation.operationId ||
          root.payload.parentSessionId !== sourceId ||
          root.payload.sourceEventId !== targetId
        ) {
          throw new DaemonError(
            "corrupt_session",
            `Reserved session ${sessionId} has conflicting history`,
          );
        }
        const managed = await this.open(sessionId, source.cwd, source.selection);
        return {
          sessionId,
          events: [...managed.events],
          ...(selectedText === undefined ? {} : { selectedText }),
        };
      }
    }

    try {
      if (reservation !== undefined) await rm(stagingPath, { force: true });
      const { log } = await JsonlEventLog.open(stagingPath, sessionId);
      const root = await log.append({
        version: EVENT_FORMAT_VERSION,
        id: randomUUID(),
        sessionId,
        ...(reservation === undefined ? {} : { operationId: reservation.operationId }),
        parentId: null,
        timestamp: startedAt,
        type: "session.created",
        payload: { cwd: source.cwd, parentSessionId: sourceId, sourceEventId: targetId },
      });
      eventIds.set(sourceRoot.id, root.id);
      let parentId = root.id;
      for (const [index, event] of copied.entries()) {
        if (event.type === "session.created" || event.type === "session.closed") continue;
        const payload = structuredClone(event.payload) as Record<string, JsonValue>;
        if (event.type === "permission.resolved" && typeof payload.requestId === "string") {
          payload.requestId = eventIds.get(payload.requestId) ?? payload.requestId;
        } else if (event.type === "context.compacted" && Array.isArray(payload.replacedEventIds)) {
          payload.replacedEventIds = payload.replacedEventIds.flatMap((id) => {
            const replacement = typeof id === "string" ? eventIds.get(id) : undefined;
            return replacement === undefined ? [] : [replacement];
          });
        }
        const id = randomUUID();
        const operationId =
          event.operationId === undefined
            ? undefined
            : (operationIds.get(event.operationId) ??
              (() => {
                const created = randomUUID();
                operationIds.set(event.operationId as string, created);
                return created;
              })());
        const clone = parseEvent({
          version: EVENT_FORMAT_VERSION,
          id,
          sessionId,
          ...(operationId === undefined ? {} : { operationId }),
          parentId,
          timestamp: startedAt + index + 1,
          type: event.type,
          payload,
        });
        await log.append(clone);
        eventIds.set(event.id, id);
        parentId = clone.id;
      }
      await log.drain();
      if (reservation !== undefined) {
        await rename(stagingPath, path);
        const directory = await openFile(join(this.options.dataDirectory, "sessions"), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      const managed = await this.open(sessionId, source.cwd, source.selection);
      return {
        sessionId,
        events: [...managed.events],
        ...(selectedText === undefined ? {} : { selectedText }),
      };
    } catch (error) {
      await rm(stagingPath, { force: true });
      if (reservation === undefined) await rm(path, { force: true });
      throw error;
    }
  }

  private async resumeFromLog(sessionId: SessionId): Promise<ManagedSession> {
    const path = this.logPath(sessionId);
    try {
      await stat(path);
    } catch (cause) {
      throw new DaemonError("unknown_session", `Session ${sessionId} has no recorded history`, {
        cause,
      });
    }
    const { events } = await JsonlEventLog.open(path, sessionId);
    const created = events[0];
    if (created?.type !== "session.created") {
      throw new DaemonError("corrupt_session", `Session ${sessionId} has no creation event`);
    }
    let modelId: string | undefined;
    let thinkingLevel: SessionModelSelection["thinkingLevel"];
    for (const event of events) {
      if (event.type === "config.model") modelId = event.payload.modelId;
      else if (event.type === "config.thinking") thinkingLevel = event.payload.requested;
    }
    return this.open(sessionId, created.payload.cwd, {
      ...(modelId === undefined ? {} : { modelId }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    });
  }

  async reload(
    sessionId: unknown,
    operationId?: OperationId,
  ): Promise<{ events: readonly CanonicalEvent[] }> {
    const managed = this.managed(sessionId);
    if (managed.activeTurn || managed.rebuilding) {
      throw new DaemonError("operation_active", "An operation owns this branch; reload after it");
    }
    if (operationId !== undefined) {
      const recovered = managed.events.filter((event) => event.operationId === operationId);
      if (recovered.length > 0) return { events: recovered };
    }
    const before = managed.events.length;
    await this.rebuild(managed, "reload", managed.selection, operationId);
    return { events: managed.events.slice(before) };
  }

  async configure(
    sessionId: unknown,
    update: SessionModelSelection,
    operationId?: OperationId,
  ): Promise<{ events: readonly CanonicalEvent[] }> {
    const managed = this.managed(sessionId);
    if (operationId !== undefined) {
      const recovered = managed.events.filter((event) => event.operationId === operationId);
      if (recovered.length > 0) return { events: recovered };
    }
    if (managed.activeTurn || managed.rebuilding) {
      throw new DaemonError(
        "operation_active",
        "An operation owns this branch; change configuration after it",
      );
    }
    const selection = { ...managed.selection, ...update };
    const boundary: SessionRuntimeBoundary =
      update.modelId !== undefined && update.modelId !== managed.selection.modelId
        ? "model_switch"
        : "config_change";
    const before = managed.events.length;
    await this.rebuild(managed, boundary, selection, operationId);
    managed.selection = selection;
    return { events: managed.events.slice(before) };
  }

  async send(
    sessionId: unknown,
    content: readonly UserContent[],
    operationId?: OperationId,
  ): Promise<{ stopReason: string }> {
    const managed = this.managed(sessionId);
    if (operationId !== undefined) {
      const prior = managed.events.filter((event) => event.operationId === operationId);
      const terminal = prior.findLast(
        (event) =>
          (event.type === "assistant.message" && event.payload.stopReason !== "tool_use") ||
          event.type === "session.error",
      );
      if (terminal?.type === "assistant.message")
        return { stopReason: terminal.payload.stopReason };
      if (terminal?.type === "session.error") return { stopReason: "error" };
      if (prior.some((event) => event.type === "user.message")) {
        const aborted = await managed.session.abortRecoveredTurn(operationId);
        return { stopReason: aborted.payload.stopReason };
      }
    }
    for (const item of content) {
      if (item.type === "blob")
        await this.blobs.assertOwned(managed.session.log.sessionId, item.blob);
    }
    if (managed.activeTurn || managed.rebuilding) {
      throw new DaemonError("operation_active", "An operation already owns this branch");
    }
    const active = deferredTurn(operationId);
    managed.activeTurn = active;
    try {
      await this.captureWorkspaceCheckpoint(managed);
      const result = await managed.session.runTurn(
        content,
        active.controller.signal,
        active.operationId,
      );
      return { stopReason: result.stopReason };
    } finally {
      if (managed.activeTurn === active) delete managed.activeTurn;
      active.finish();
    }
  }

  async shell(
    sessionId: unknown,
    command: string,
    excluded: boolean,
  ): Promise<{ isError: boolean }> {
    const managed = this.managed(sessionId);
    if (managed.activeTurn || managed.rebuilding) {
      throw new DaemonError("operation_active", "An operation already owns this branch");
    }
    const active = deferredTurn();
    managed.activeTurn = active;
    try {
      await this.captureWorkspaceCheckpoint(managed);
      const event = await managed.session.runShell(
        command,
        excluded,
        active.controller.signal,
        active.operationId,
      );
      return { isError: event.payload.isError };
    } finally {
      if (managed.activeTurn === active) delete managed.activeTurn;
      active.finish();
    }
  }

  async setWorkspaceCheckpoints(
    sessionId: unknown,
    enabled: boolean,
  ): Promise<{ enabled: boolean }> {
    const managed = this.managed(sessionId);
    if (managed.activeTurn || managed.rebuilding) {
      throw new DaemonError(
        "operation_active",
        "Change workspace checkpoint capture after the active operation",
      );
    }
    managed.workspaceCheckpointsEnabled = enabled;
    if (enabled && !(await this.workspaceCheckpoints.has(managed.session.log.sessionId))) {
      await this.captureWorkspaceCheckpoint(managed);
      if (managed.checkpointError !== undefined) {
        throw new DaemonError(managed.checkpointError.code, managed.checkpointError.message, {
          cause: managed.checkpointError,
        });
      }
    }
    return { enabled };
  }

  startBlobUpload(
    sessionId: unknown,
    input: { readonly mediaType: string; readonly sizeBytes: number; readonly name?: string },
  ): Promise<{ uploadId: string; chunkBytes: number }> {
    return this.blobOperation(sessionId, (id) => this.blobs.start(id, input));
  }

  appendBlobChunk(
    sessionId: unknown,
    uploadId: string,
    offset: number,
    data: string,
  ): Promise<{ nextOffset: number }> {
    return this.blobOperation(sessionId, (id) => this.blobs.append(id, uploadId, offset, data));
  }

  commitBlobUpload(sessionId: unknown, uploadId: string): Promise<BlobReference> {
    return this.blobOperation(sessionId, (id) => this.blobs.commit(id, uploadId));
  }

  abortBlobUpload(sessionId: unknown, uploadId: string): Promise<{ aborted: boolean }> {
    return this.blobOperation(sessionId, (id) => this.blobs.abort(id, uploadId));
  }

  readBlob(sessionId: unknown, digest: string, offset: number, length: number) {
    return this.blobOperation(sessionId, (id) => this.blobs.read(id, digest, offset, length));
  }

  private async blobOperation<Result>(
    sessionId: unknown,
    operation: (sessionId: SessionId) => Promise<Result>,
  ): Promise<Result> {
    const managed = this.managed(sessionId);
    try {
      return await operation(managed.session.log.sessionId);
    } catch (error) {
      if (error instanceof BlobStoreError) {
        throw new DaemonError(error.code, error.message, { cause: error });
      }
      throw error;
    }
  }

  async workspaceDiff(sessionId: unknown, scope: WorkspaceDiffScope): Promise<WorkspaceDiff> {
    const managed = this.managed(sessionId);
    if (scope === "last-turn" && managed.checkpointError !== undefined) {
      throw new DaemonError(managed.checkpointError.code, managed.checkpointError.message, {
        cause: managed.checkpointError,
      });
    }
    try {
      return await this.workspaceCheckpoints.diff(
        managed.session.log.sessionId,
        managed.cwd,
        scope,
      );
    } catch (error) {
      if (error instanceof WorkspaceCheckpointError) {
        throw new DaemonError(error.code, error.message, { cause: error });
      }
      throw error;
    }
  }

  private async captureWorkspaceCheckpoint(managed: ManagedSession): Promise<void> {
    if (!managed.workspaceCheckpointsEnabled) return;
    try {
      await this.workspaceCheckpoints.capture(managed.session.log.sessionId, managed.cwd);
      delete managed.checkpointError;
    } catch (error) {
      if (error instanceof WorkspaceCheckpointError) {
        managed.checkpointError = error;
        return;
      }
      throw error;
    }
  }

  interrupt(sessionId: unknown): { interrupted: boolean } {
    const active = this.managed(sessionId).activeTurn;
    if (!active) return { interrupted: false };
    active.controller.abort();
    return { interrupted: true };
  }

  subscribe(
    sessionId: unknown,
    listener: (event: CanonicalEvent) => void,
    activityListener?: (frame: SessionActivityFrame) => void,
    fromNodeId?: EventId,
  ): {
    snapshot: readonly CanonicalEvent[];
    allEvents: readonly CanonicalEvent[];
    activity?: SessionActivityFrame;
    unsubscribe: () => void;
  } {
    const managed = this.managed(sessionId);
    const allEvents = [...managed.events];
    const snapshot =
      fromNodeId === undefined
        ? allEvents
        : SessionTree.fromEvents(managed.session.log.sessionId, allEvents).lineage(fromNodeId);
    managed.listeners.add(listener);
    if (activityListener !== undefined) managed.activityListeners.add(activityListener);
    const current = managed.activityState.current;
    const activity =
      current === undefined || current.type === "clear"
        ? undefined
        : {
            operationId: current.operationId,
            sequence: current.sequence,
            type: "snapshot" as const,
            text: managed.activityState.text,
            thinking: managed.activityState.thinking,
            toolCalls: [...managed.activityState.tools],
          };
    return {
      snapshot,
      allEvents,
      ...(activity === undefined ? {} : { activity }),
      unsubscribe: () => {
        managed.listeners.delete(listener);
        if (activityListener !== undefined) managed.activityListeners.delete(activityListener);
      },
    };
  }

  private async interact(
    sessionId: SessionId,
    request: SessionInteractionRequest,
    signal?: AbortSignal,
  ): Promise<SessionInteractionResponse> {
    if (signal?.aborted) throw new DOMException("Interaction aborted", "AbortError");
    const managed = this.managed(sessionId);
    const interactionId = randomUUID();
    let pending!: PendingInteraction;
    const response = new Promise<SessionInteractionResponse>((resolvePromise, rejectPromise) => {
      pending = { resolve: resolvePromise, reject: rejectPromise };
    });
    managed.interactions.set(interactionId, pending);

    const abort = (): void => {
      if (managed.interactions.delete(interactionId)) {
        pending.reject(new DOMException("Interaction aborted", "AbortError"));
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      if (managed.interactions.delete(interactionId)) {
        pending.reject(new DaemonError("interaction_timeout", "Interaction timed out"));
      }
    }, 300_000);
    timeout.unref();

    try {
      await managed.session.requestInteraction({ interactionId, ...request });
      return await response;
    } catch (error) {
      managed.interactions.delete(interactionId);
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  async respondToInteraction(
    sessionId: unknown,
    interactionId: string,
    response: SessionInteractionResponse,
    operationId?: OperationId,
  ): Promise<void> {
    const managed = this.managed(sessionId);
    if (
      operationId !== undefined &&
      managed.events.some(
        (event) => event.type === "interaction.resolved" && event.operationId === operationId,
      )
    ) {
      return;
    }
    const pending = managed.interactions.get(interactionId);
    if (!pending) {
      throw new DaemonError("unknown_interaction", `Interaction ${interactionId} is not pending`);
    }
    managed.interactions.delete(interactionId);
    try {
      await managed.session.resolveInteraction({ interactionId, ...response }, operationId);
      pending.resolve(response);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private async rebuild(
    managed: ManagedSession,
    boundary: SessionRuntimeBoundary,
    selection: SessionModelSelection,
    operationId?: OperationId,
  ): Promise<void> {
    const previous = managed.session;
    const rebuilding = (async () => {
      const next = await this.buildSession(
        previous.log.sessionId,
        managed.cwd,
        managed.events,
        managed.listeners,
        managed.activityListeners,
        managed.activityState,
        boundary,
        selection,
        operationId,
      );
      await previous.dispose();
      managed.session = next;
    })();
    managed.rebuilding = rebuilding;
    try {
      await rebuilding;
    } finally {
      if (managed.rebuilding === rebuilding) delete managed.rebuilding;
    }
  }

  async dispose(sessionId: unknown, operationId?: OperationId): Promise<void> {
    const parsed = parseSessionId(sessionId, "sessionId");
    let managed = this.sessions.get(parsed);
    if (!managed && operationId !== undefined) {
      try {
        await stat(this.logPath(parsed));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const opened = await JsonlEventLog.open(this.logPath(parsed), parsed);
      if (
        opened.events.some(
          (event) => event.type === "session.closed" && event.operationId === operationId,
        )
      ) {
        return;
      }
      await this.resume(parsed);
      managed = this.sessions.get(parsed);
    }
    if (!managed) return;
    await managed.rebuilding;
    managed.activeTurn?.controller.abort();
    for (const [interactionId, interaction] of managed.interactions) {
      managed.interactions.delete(interactionId);
      interaction.reject(new DaemonError("session_disposed", "Session was disposed"));
    }
    await managed.activeTurn?.done;
    if (
      operationId !== undefined &&
      !managed.events.some(
        (event) => event.type === "session.closed" && event.operationId === operationId,
      )
    ) {
      await managed.session.close(operationId);
    }
    this.sessions.delete(parsed);
    await managed.session.dispose();
    await this.blobs.disposeSession(parsed);
  }

  private applyActivity(
    state: ManagedSession["activityState"],
    frame: SessionActivityFrame,
  ): boolean {
    if (
      state.current !== undefined &&
      state.current.operationId === frame.operationId &&
      frame.sequence <= state.current.sequence
    ) {
      return false;
    }
    if (state.current?.operationId !== frame.operationId) {
      state.text = "";
      state.thinking = "";
      state.tools.length = 0;
    }
    if (frame.type === "clear") {
      state.current = frame;
      state.text = "";
      state.thinking = "";
      state.tools.length = 0;
      return true;
    }
    if (frame.type === "snapshot") {
      state.text = frame.text;
      state.thinking = frame.thinking;
      state.tools.splice(0, state.tools.length, ...frame.toolCalls);
    } else if (frame.type === "text_delta") {
      state.text = `${state.text}${frame.text}`.slice(-65_536);
    } else if (frame.type === "thinking_delta") {
      state.thinking = `${state.thinking}${frame.text}`.slice(-65_536);
    } else if (frame.type === "tool_call") {
      state.tools.push(frame.call);
      if (state.tools.length > 64) state.tools.shift();
    }
    state.current = frame;
    return true;
  }

  private authorizeEventBlobs(sessionId: SessionId, event: CanonicalEvent): void {
    if (
      event.type !== "user.message" &&
      event.type !== "user.shell" &&
      event.type !== "assistant.message" &&
      event.type !== "tool.result"
    ) {
      return;
    }
    const references = event.payload.content.flatMap((item) =>
      item.type === "blob" ? [item.blob] : [],
    );
    this.blobs.authorize(sessionId, references);
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.dispose(sessionId)));
  }

  private managed(sessionId: unknown): ManagedSession {
    const parsed = parseSessionId(sessionId, "sessionId");
    const managed = this.sessions.get(parsed);
    if (!managed)
      throw new DaemonError("unknown_session", `Session ${parsed} is not open; resume it first`);
    return managed;
  }
}
