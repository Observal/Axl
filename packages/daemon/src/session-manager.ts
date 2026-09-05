// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  mkdir,
  open as openFile,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  AgentSession,
  type CompactionSettings,
  CompactionUnavailableError,
  EventLogMigrationRequiredError,
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
  encodeCanonicalEvent,
  type InteractionAction,
  type JsonObject,
  type JsonValue,
  type OperationId,
  parseEvent,
  parseEventId,
  parseOperationId,
  parseSessionId,
  type SessionActivityFrame,
  type SessionConfiguration,
  type SessionId,
  type SessionOpenResult,
  type SessionSummary,
  type UserContent,
  type WorkspaceDiffParams,
  type WorkspaceDiffResult,
  type WorkspaceListParams,
  type WorkspaceListResult,
  type WorkspaceReadParams,
  type WorkspaceReadResult,
  type WorkspaceStatusParams,
  type WorkspaceStatusResult,
} from "@axl/protocol";

import { BlobStore, BlobStoreError } from "./blob-store.ts";
import {
  exportSessionArtifact,
  importSessionArtifact,
  SessionArtifactError,
} from "./session-artifact.ts";
import { WorkspaceCheckpointError, WorkspaceCheckpointStore } from "./workspace-checkpoint.ts";
import { WorkspaceError, WorkspaceService } from "./workspace-service.ts";

export class DaemonError extends Error {
  readonly code: string;
  readonly details: JsonObject | undefined;

  constructor(code: string, message: string, options?: { cause?: unknown; details?: JsonObject }) {
    super(message, options);
    this.name = "DaemonError";
    this.code = code;
    this.details = options?.details;
  }
}

export interface SessionRuntime {
  readonly model: ModelPort;
  readonly tools: ToolRegistry;
  readonly prompt?: StablePrompt;
  readonly system?: string;
  readonly log?: EventLogOptions;
  readonly extensionHost?: ExtensionHost;
  readonly compaction?: Partial<CompactionSettings>;
  readonly sandbox?: EventPayloadMap["sandbox.configured"];
  readonly configModel?: EventPayloadMap["config.model"];
  readonly configThinking?: EventPayloadMap["config.thinking"];
  readonly configProfile?: EventPayloadMap["config.profile"];
  readonly configTools?: EventPayloadMap["config.tools"];
  readonly configDialect?: EventPayloadMap["config.dialect"];
}

export type SessionRuntimeBoundary =
  | "session_start"
  | "reload"
  | "model_switch"
  | "tool_change"
  | "config_change";

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
  readonly selection: SessionConfiguration;
  readonly interact: (
    request: SessionInteractionRequest,
    signal?: AbortSignal,
  ) => Promise<SessionInteractionResponse>;
  readonly readBlob: (reference: BlobReference) => Promise<Uint8Array>;
}) => SessionRuntime | Promise<SessionRuntime>;

export interface SessionManagerOptions {
  readonly dataDirectory: string;
  readonly runtime: SessionRuntimeFactory;
  readonly workspaceDeniedPaths?: readonly string[];
}

interface ActiveTurn {
  readonly kind: "turn" | "shell" | "compaction";
  readonly operationId: OperationId;
  controller: AbortController;
  readonly done: Promise<void>;
  finish(): void;
}

interface QueuedTurn {
  readonly queueItemId: EventId;
  readonly operationId: OperationId;
  readonly content: readonly UserContent[];
  readonly priority: "front" | "back";
}

interface PendingInteraction {
  readonly resolve: (response: SessionInteractionResponse) => void;
  readonly reject: (error: Error) => void;
  resolution?: Promise<EventId>;
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
  selection: SessionConfiguration;
  activeTurn?: ActiveTurn;
  queuedInputs: Promise<void>;
  rebuilding?: Promise<void>;
  readonly interactions: Map<string, PendingInteraction>;
  readonly queue: QueuedTurn[];
  queueDraining: boolean;
  disposing: boolean;
  checkpointError?: WorkspaceCheckpointError;
  workspaceCheckpointsEnabled: boolean;
}

function deferredTurn(
  kind: ActiveTurn["kind"],
  operationId = parseOperationId(randomUUID(), "operationId"),
): ActiveTurn {
  let resolveDone = (): void => undefined;
  const done = new Promise<void>((resolvePromise) => {
    resolveDone = resolvePromise;
  });
  return { kind, operationId, controller: new AbortController(), done, finish: resolveDone };
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

export type StoredSessionSummary = Omit<SessionSummary, "runtime" | "attachmentCount">;

function summarizeSession(events: readonly CanonicalEvent[]): StoredSessionSummary {
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
  const sandbox = events.findLast((event) => event.type === "sandbox.configured");
  const image =
    sandbox?.type === "sandbox.configured" && typeof sandbox.payload.details?.image === "string"
      ? sandbox.payload.details.image
      : undefined;
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
    ...(sandbox?.type !== "sandbox.configured"
      ? {}
      : {
          securityMode: sandbox.payload.enforced ? ("sandboxed" as const) : ("unsafe" as const),
          sandboxProvider: sandbox.payload.provider,
        }),
    ...(image === undefined ? {} : { sandboxImage: image }),
  };
}

export async function listStoredSessions(
  dataDirectory: string,
): Promise<readonly SessionSummary[]> {
  const directory = join(resolve(dataDirectory), "sessions");
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
    const raw = await readFile(join(directory, entry.name), "utf8");
    const lines = raw.split("\n");
    lines.pop();
    const events = lines
      .filter((line) => line.length > 0)
      .map((line) => parseEvent(JSON.parse(line) as unknown));
    if (events.some((event) => event.sessionId !== sessionId)) {
      throw new DaemonError("corrupt_session", `Session file ${entry.name} contains another ID`);
    }
    summaries.push({
      ...summarizeSession(events),
      runtime: { state: "inactive" },
      attachmentCount: 0,
    });
  }
  return summaries.sort((left, right) => right.updatedAt - left.updatedAt);
}

/** Owns every live session. Clients never receive a mutable kernel object. */
export class SessionManager {
  private readonly options: SessionManagerOptions;
  private readonly sessions = new Map<SessionId, ManagedSession>();
  private readonly opening = new Map<SessionId, Promise<ManagedSession>>();
  private readonly quarantined = new Map<SessionId, EventLogMigrationRequiredError>();
  private readonly incompleteMigrations = new Set<SessionId>();
  private readonly workspaceCheckpoints: WorkspaceCheckpointStore;
  private readonly workspace: WorkspaceService;
  private readonly blobs: BlobStore;

  constructor(options: SessionManagerOptions) {
    this.options = { ...options, dataDirectory: resolve(options.dataDirectory) };
    this.workspaceCheckpoints = new WorkspaceCheckpointStore(this.options.dataDirectory);
    this.workspace = new WorkspaceService(
      this.options.dataDirectory,
      this.workspaceCheckpoints,
      this.options.workspaceDeniedPaths,
    );
    this.blobs = new BlobStore(this.options.dataDirectory);
  }

  private logPath(sessionId: SessionId): string {
    return join(this.options.dataDirectory, "sessions", `${sessionId}.jsonl`);
  }

  async scanLegacyEvents(): Promise<void> {
    const directory = join(this.options.dataDirectory, "sessions");
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    this.quarantined.clear();
    this.incompleteMigrations.clear();
    const pendingDirectory = join(this.options.dataDirectory, "migrations", "pending");
    try {
      for (const entry of await readdir(pendingDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const pending = JSON.parse(await readFile(join(pendingDirectory, entry.name), "utf8")) as {
          readonly targetSessionId?: unknown;
        };
        this.incompleteMigrations.add(
          parseSessionId(pending.targetSessionId, "pending.targetSessionId"),
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionId = parseSessionId(basename(entry.name, ".jsonl"), "session file name");
      if (this.incompleteMigrations.has(sessionId)) continue;
      try {
        await JsonlEventLog.open(join(directory, entry.name), sessionId);
      } catch (error) {
        if (!(error instanceof EventLogMigrationRequiredError)) throw error;
        this.quarantined.set(sessionId, error);
      }
    }
  }

  private assertNotQuarantined(sessionId: SessionId): void {
    if (this.incompleteMigrations.has(sessionId)) {
      throw new DaemonError("unknown_session", `Session ${sessionId} is not published`);
    }
    const error = this.quarantined.get(sessionId);
    if (error === undefined) return;
    throw new DaemonError(
      "event_migration_required",
      `Session ${sessionId} requires offline event migration`,
      {
        cause: error,
        details: {
          sessionId,
          eventId: error.eventId,
          eventType: error.eventType,
          encodedBytes: error.encodedBytes,
          maximumBytes: error.maximumBytes,
          recoveryCommand: `axl session migrate-events ${sessionId}`,
        },
      },
    );
  }

  private async externalizeOversizedContent(
    sessionId: SessionId,
    event: CanonicalEvent,
  ): Promise<CanonicalEvent> {
    if (
      event.type !== "user.message" &&
      event.type !== "assistant.message" &&
      event.type !== "user.shell" &&
      event.type !== "tool.result"
    ) {
      return event;
    }
    const content = await Promise.all(
      event.payload.content.map(async (item) => {
        if (item.type !== "text" || item.text.length === 0) return item;
        try {
          return { type: "blob" as const, blob: await this.blobs.storeText(sessionId, item.text) };
        } catch (error) {
          if (error instanceof BlobStoreError && error.code === "blob_too_large") return item;
          throw error;
        }
      }),
    );
    return parseEvent({ ...event, payload: { ...event.payload, content } });
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
    selection: SessionConfiguration,
    boundaryOperationId?: OperationId,
    creationOperationId?: OperationId,
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
      log: {
        ...(runtime.log?.secretValues === undefined
          ? {}
          : { secretValues: runtime.log.secretValues }),
        prepareOversizedEvent: (event) => this.externalizeOversizedContent(sessionId, event),
      },
      ...(runtime.extensionHost === undefined ? {} : { extensionHost: runtime.extensionHost }),
      ...(runtime.compaction === undefined ? {} : { compaction: runtime.compaction }),
      ...(runtime.sandbox === undefined ? {} : { sandbox: runtime.sandbox }),
      ...(runtime.configModel === undefined ? {} : { configModel: runtime.configModel }),
      ...(runtime.configThinking === undefined ? {} : { configThinking: runtime.configThinking }),
      ...(runtime.configProfile === undefined ? {} : { configProfile: runtime.configProfile }),
      ...(runtime.configTools === undefined ? {} : { configTools: runtime.configTools }),
      ...(runtime.configDialect === undefined ? {} : { configDialect: runtime.configDialect }),
      ...(boundaryOperationId === undefined ? {} : { boundaryOperationId }),
      ...(creationOperationId === undefined ? {} : { creationOperationId }),
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
    selection: SessionConfiguration,
    creationOperationId?: OperationId,
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
      undefined,
      creationOperationId,
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
      queuedInputs: Promise.resolve(),
      interactions: new Map(),
      queue: [],
      queueDraining: false,
      disposing: false,
      workspaceCheckpointsEnabled: false,
    };
    this.sessions.set(sessionId, managed);
    await this.pauseRecoveredQueue(managed);
    return managed;
  }

  async create(
    cwd: string,
    selection: SessionConfiguration = {},
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
      if (
        root !== undefined &&
        (root.type !== "session.created" ||
          root.operationId !== reservation.operationId ||
          root.payload.cwd !== canonicalCwd)
      ) {
        throw new DaemonError(
          "corrupt_session",
          `Reserved session ${sessionId} has conflicting history`,
        );
      }
    }
    const managed = await this.open(sessionId, canonicalCwd, selection, reservation?.operationId);
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
      acceptance.method === "session.clone" ||
      acceptance.method === "session.import"
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
      const terminal = affectedEvents.findLast(
        (event) =>
          (event.type === "assistant.message" && event.payload.stopReason !== "tool_use") ||
          event.type === "session.error",
      );
      if (terminal !== undefined) {
        const interrupted =
          terminal.type === "assistant.message" && terminal.payload.stopReason === "aborted";
        return {
          interrupted,
          ...(interrupted ? { operationId: affected } : {}),
        };
      }
      if (affectedEvents.some((event) => event.type === "user.message")) {
        await this.resume(target);
        await this.managed(target).session.abortRecoveredTurn(affected);
        return { interrupted: true, operationId: affected };
      }
      return { interrupted: false };
    }
    if (acceptance.method === "session.dispose") {
      return evidence.some((event) => event.type === "session.closed")
        ? { disposed: true, historyPreserved: true }
        : undefined;
    }
    if (acceptance.method === "session.interaction.respond") {
      const recordedResolution = evidence.find((event) => event.type === "interaction.resolved");
      if (recordedResolution?.type === "interaction.resolved") {
        return {
          interactionId: recordedResolution.payload.interactionId,
          resolutionEventId: recordedResolution.id,
        };
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
    if (acceptance.method === "session.queue.enqueue") {
      const queued = evidence.find((event) => event.type === "queue.enqueued");
      if (queued?.type !== "queue.enqueued") return undefined;
      const paused = this.managed(target).events.some(
        (event) => event.type === "queue.paused" && event.payload.queueItemId === queued.id,
      );
      return { queueItemId: queued.id, state: paused ? "paused" : "queued" };
    }
    if (acceptance.method === "session.queue.requeue") {
      const requeued = evidence.find((event) => event.type === "queue.requeued");
      return requeued?.type === "queue.requeued"
        ? { queueItemId: requeued.payload.queueItemId, state: "queued" }
        : undefined;
    }
    if (acceptance.method === "session.send") {
      const terminal = evidence.findLast(
        (event) =>
          (event.type === "assistant.message" && event.payload.stopReason !== "tool_use") ||
          event.type === "session.error",
      );
      if (terminal?.type === "assistant.message") {
        return { operationId, stopReason: terminal.payload.stopReason };
      }
      if (terminal?.type === "session.error") return { operationId, stopReason: "error" };
      if (evidence.some((event) => event.type === "user.message")) {
        const aborted = await this.managed(target).session.abortRecoveredTurn(operationId);
        return { operationId, stopReason: aborted.payload.stopReason };
      }
      return undefined;
    }
    if (acceptance.method === "session.reload") {
      return { boundaryEventIds: evidence.map((event) => event.id) };
    }
    if (acceptance.method === "session.configure") {
      return this.configurationResult(this.managed(target), evidence);
    }
    return undefined;
  }

  activeOperationId(sessionId: unknown): OperationId | undefined {
    const parsed = parseSessionId(sessionId, "sessionId");
    return this.sessions.get(parsed)?.activeTurn?.operationId;
  }

  describe(sessionId: unknown): SessionOpenResult {
    const managed = this.managed(sessionId);
    const activeOperationId = managed.activeTurn?.operationId;
    return {
      sessionId: managed.session.log.sessionId,
      cwd: managed.cwd,
      runtime: {
        state: managed.disposing
          ? "disposing"
          : managed.interactions.size > 0
            ? "waiting_interaction"
            : managed.activeTurn !== undefined || managed.rebuilding !== undefined
              ? "running"
              : "idle",
        ...(activeOperationId === undefined ? {} : { activeOperationId }),
      },
      profile: managed.selection.profile ?? "standard",
    };
  }

  async list(): Promise<readonly StoredSessionSummary[]> {
    const directory = join(this.options.dataDirectory, "sessions");
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const summaries: StoredSessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionId = parseSessionId(basename(entry.name, ".jsonl"), "session file name");
      if (this.incompleteMigrations.has(sessionId)) continue;
      this.assertNotQuarantined(sessionId);
      const active = this.sessions.get(sessionId);
      const events =
        active?.events ?? (await JsonlEventLog.open(join(directory, entry.name), sessionId)).events;
      summaries.push(summarizeSession(events));
    }
    return summaries.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  runtimeState(sessionId: SessionId): SessionOpenResult["runtime"] {
    const managed = this.sessions.get(sessionId);
    if (managed === undefined) return { state: "inactive" };
    return this.describe(sessionId).runtime;
  }

  async exportArtifact(
    sessionId: unknown,
    outputDirectory: string,
  ): Promise<{
    readonly outputDirectory: string;
    readonly sourceSha256: string;
    readonly eventCount: number;
    readonly blobCount: number;
  }> {
    const parsed = parseSessionId(sessionId, "sessionId");
    this.assertNotQuarantined(parsed);
    const active = this.sessions.get(parsed);
    if (active?.activeTurn !== undefined || active?.rebuilding !== undefined) {
      throw new DaemonError("operation_active", "Export the session after its active operation");
    }
    let events: readonly CanonicalEvent[];
    if (active !== undefined) {
      await active.session.log.drain();
      events = [...active.events];
    } else {
      const path = this.logPath(parsed);
      try {
        await stat(path);
      } catch (cause) {
        throw new DaemonError("unknown_session", `Session ${parsed} has no recorded history`, {
          cause,
        });
      }
      events = (await JsonlEventLog.open(path, parsed)).events;
      for (const event of events) this.authorizeEventBlobs(parsed, event);
    }
    try {
      return await exportSessionArtifact({
        events,
        outputDirectory,
        readBlob: (reference) => this.blobs.readAll(parsed, reference),
      });
    } catch (error) {
      if (error instanceof BlobStoreError || error instanceof SessionArtifactError) {
        throw new DaemonError(error.code, error.message, { cause: error });
      }
      throw error;
    }
  }

  async importArtifact(
    inputDirectory: string,
    cwd: string,
    reservation: { readonly sessionId: SessionId; readonly operationId: OperationId },
  ): Promise<{ readonly sessionId: SessionId; readonly events: readonly CanonicalEvent[] }> {
    const canonicalCwd = await realpath(cwd).catch((cause: unknown) => {
      throw new DaemonError("invalid_cwd", `Cannot open working directory ${cwd}`, { cause });
    });
    const path = this.logPath(reservation.sessionId);
    try {
      await stat(path);
      const existing = (await JsonlEventLog.open(path, reservation.sessionId)).events[0];
      if (
        existing?.type !== "session.created" ||
        existing.operationId !== reservation.operationId
      ) {
        throw new DaemonError(
          "corrupt_session",
          `Reserved session ${reservation.sessionId} has conflicting history`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await importSessionArtifact({
          dataDirectory: this.options.dataDirectory,
          inputDirectory,
          targetSessionId: reservation.sessionId,
          cwd: canonicalCwd,
          creationOperationId: reservation.operationId,
        });
      } catch (artifactError) {
        if (artifactError instanceof SessionArtifactError) {
          throw new DaemonError(artifactError.code, artifactError.message, {
            cause: artifactError,
          });
        }
        throw artifactError;
      }
    }
    return this.resume(reservation.sessionId);
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
    this.assertNotQuarantined(parsed);
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
    const targetOperationId = lineage.at(-1)?.operationId;
    const copied = (includeTarget ? lineage.slice(1) : lineage.slice(1, -1)).filter(
      (event) =>
        includeTarget || targetOperationId === undefined || event.operationId !== targetOperationId,
    );
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
        } else if (
          (event.type === "queue.requeued" ||
            event.type === "queue.started" ||
            event.type === "queue.paused") &&
          typeof payload.queueItemId === "string"
        ) {
          const queueItemId = eventIds.get(payload.queueItemId);
          if (queueItemId === undefined) {
            throw new DaemonError(
              "corrupt_session",
              `Queue lifecycle event ${event.id} references an event outside its lineage`,
            );
          }
          payload.queueItemId = queueItemId;
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
    this.assertNotQuarantined(sessionId);
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
    let thinkingLevel: SessionConfiguration["thinkingLevel"];
    let webFetch: boolean | undefined;
    let webSearch: boolean | undefined;
    let profile: SessionConfiguration["profile"];
    for (const event of events) {
      if (event.type === "config.model") modelId = event.payload.modelId;
      else if (event.type === "config.thinking") thinkingLevel = event.payload.requested;
      else if (event.type === "config.profile") profile = event.payload.profile;
      else if (event.type === "config.tools") {
        webFetch = event.payload.webFetch;
        webSearch = event.payload.webSearch;
      }
    }
    return this.open(sessionId, created.payload.cwd, {
      ...(modelId === undefined ? {} : { modelId }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      ...(webFetch === undefined ? {} : { webFetch }),
      ...(webSearch === undefined ? {} : { webSearch }),
      profile: profile ?? "standard",
    });
  }

  async reload(
    sessionId: unknown,
    operationId?: OperationId,
  ): Promise<{ boundaryEventIds: readonly EventId[] }> {
    const managed = this.managed(sessionId);
    if (managed.activeTurn || managed.rebuilding) {
      throw new DaemonError("operation_active", "An operation owns this branch; reload after it");
    }
    if (operationId !== undefined) {
      const recovered = managed.events.filter((event) => event.operationId === operationId);
      if (recovered.length > 0) {
        return { boundaryEventIds: recovered.map((event) => event.id) };
      }
    }
    const before = managed.events.length;
    await this.rebuild(managed, "reload", managed.selection, operationId);
    return { boundaryEventIds: managed.events.slice(before).map((event) => event.id) };
  }

  async configure(
    sessionId: unknown,
    update: SessionConfiguration,
    operationId?: OperationId,
  ): Promise<{
    modelId: string;
    requestedThinkingLevel: NonNullable<SessionConfiguration["thinkingLevel"]>;
    effectiveThinkingLevel: NonNullable<SessionConfiguration["thinkingLevel"]>;
    profile: NonNullable<SessionConfiguration["profile"]>;
    webFetch: boolean;
    webSearch: boolean;
    boundaryEventIds: readonly EventId[];
  }> {
    const managed = this.managed(sessionId);
    if (operationId !== undefined) {
      const recovered = managed.events.filter((event) => event.operationId === operationId);
      if (recovered.length > 0) return this.configurationResult(managed, recovered);
    }
    if (managed.activeTurn || managed.rebuilding) {
      throw new DaemonError(
        "operation_active",
        "An operation owns this branch; change configuration after it",
      );
    }
    const selection = { ...managed.selection, ...update };
    if (selection.modelId === undefined) {
      throw new DaemonError(
        "unsupported_capability",
        "Configuration requires a runtime with a known model",
      );
    }
    const boundary: SessionRuntimeBoundary =
      update.modelId !== undefined && update.modelId !== managed.selection.modelId
        ? "model_switch"
        : (update.webFetch !== undefined && update.webFetch !== managed.selection.webFetch) ||
            (update.webSearch !== undefined && update.webSearch !== managed.selection.webSearch)
          ? "tool_change"
          : "config_change";
    const before = managed.events.length;
    await this.rebuild(managed, boundary, selection, operationId);
    managed.selection = selection;
    return this.configurationResult(managed, managed.events.slice(before));
  }

  private configurationResult(
    managed: ManagedSession,
    boundaryEvents: readonly CanonicalEvent[],
  ): {
    modelId: string;
    requestedThinkingLevel: NonNullable<SessionConfiguration["thinkingLevel"]>;
    effectiveThinkingLevel: NonNullable<SessionConfiguration["thinkingLevel"]>;
    profile: NonNullable<SessionConfiguration["profile"]>;
    webFetch: boolean;
    webSearch: boolean;
    boundaryEventIds: readonly EventId[];
  } {
    const modelId = managed.selection.modelId;
    if (modelId === undefined) {
      throw new DaemonError("corrupt_session", "Configured session has no model identity");
    }
    const thinking = managed.events.findLast((event) => event.type === "config.thinking");
    const tools = managed.events.findLast((event) => event.type === "config.tools");
    const requestedThinkingLevel = managed.selection.thinkingLevel ?? "off";
    return {
      modelId,
      requestedThinkingLevel,
      effectiveThinkingLevel:
        thinking?.type === "config.thinking" ? thinking.payload.effective : requestedThinkingLevel,
      profile: managed.selection.profile ?? "standard",
      webFetch: tools?.type === "config.tools" ? tools.payload.webFetch : false,
      webSearch: tools?.type === "config.tools" ? tools.payload.webSearch : false,
      boundaryEventIds: boundaryEvents.map((event) => event.id),
    };
  }

  async enqueue(
    sessionId: unknown,
    content: readonly UserContent[],
    priority: "front" | "back",
    operationId: OperationId | undefined,
  ): Promise<{ queueItemId: EventId; state: "queued" }> {
    if (operationId === undefined)
      throw new DaemonError("internal_error", "Queue operation ID is missing");
    const managed = this.managed(sessionId);
    const prior = managed.events.find(
      (event) => event.type === "queue.enqueued" && event.operationId === operationId,
    );
    if (prior?.type === "queue.enqueued") return { queueItemId: prior.id, state: "queued" };
    try {
      for (const item of content) {
        if (item.type === "blob")
          await this.blobs.assertOwned(managed.session.log.sessionId, item.blob);
      }
    } catch (error) {
      if (error instanceof BlobStoreError) {
        throw new DaemonError(error.code, error.message, { cause: error });
      }
      throw error;
    }
    const queued = await managed.session.recordQueueEvent(operationId, "queue.enqueued", {
      content,
      priority,
    });
    const entry = { queueItemId: queued.id, operationId, content, priority };
    if (priority === "front") managed.queue.unshift(entry);
    else managed.queue.push(entry);
    void this.drainQueue(managed);
    return { queueItemId: queued.id, state: "queued" };
  }

  async requeue(
    sessionId: unknown,
    queueItemId: EventId,
    priority: "front" | "back",
    operationId: OperationId | undefined,
  ): Promise<{ queueItemId: EventId; state: "queued" }> {
    if (operationId === undefined)
      throw new DaemonError("internal_error", "Queue operation ID is missing");
    const managed = this.managed(sessionId);
    const prior = managed.events.find(
      (event) => event.type === "queue.requeued" && event.operationId === operationId,
    );
    if (prior?.type === "queue.requeued") return { queueItemId, state: "queued" };
    const queued = managed.events.find(
      (event) => event.type === "queue.enqueued" && event.id === queueItemId,
    );
    if (queued?.type !== "queue.enqueued" || queued.operationId === undefined) {
      throw new DaemonError("unknown_queue_item", "The queued prompt does not exist");
    }
    const latest = managed.events.findLast(
      (event) =>
        (event.type === "queue.requeued" ||
          event.type === "queue.started" ||
          event.type === "queue.paused") &&
        event.payload.queueItemId === queueItemId,
    );
    if (latest?.type !== "queue.paused") {
      throw new DaemonError("queue_not_paused", "Only a paused queued prompt can be re-queued");
    }
    await managed.session.recordQueueEvent(operationId, "queue.requeued", {
      queueItemId,
      priority,
    });
    const entry = {
      queueItemId,
      operationId: queued.operationId,
      content: queued.payload.content,
      priority,
    };
    if (priority === "front") managed.queue.unshift(entry);
    else managed.queue.push(entry);
    void this.drainQueue(managed);
    return { queueItemId, state: "queued" };
  }

  steer(sessionId: unknown, content: readonly UserContent[]): Promise<{ queued: true }> {
    return this.queueInput(sessionId, content, "steer");
  }

  followUp(sessionId: unknown, content: readonly UserContent[]): Promise<{ queued: true }> {
    return this.queueInput(sessionId, content, "followUp");
  }

  private queueInput(
    sessionId: unknown,
    content: readonly UserContent[],
    mode: "steer" | "followUp",
  ): Promise<{ queued: true }> {
    const managed = this.managed(sessionId);
    const queued = managed.queuedInputs.then(async () => {
      try {
        for (const item of content) {
          if (item.type === "blob") {
            await this.blobs.assertOwned(managed.session.log.sessionId, item.blob);
          }
        }
      } catch (error) {
        if (error instanceof BlobStoreError) {
          throw new DaemonError(error.code, error.message, { cause: error });
        }
        throw error;
      }
      if (managed.activeTurn?.kind !== "turn" || managed.rebuilding) {
        throw new DaemonError("operation_inactive", `No active model turn can receive ${mode}`);
      }
      managed.session[mode](content);
      return { queued: true as const };
    });
    managed.queuedInputs = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async send(
    sessionId: unknown,
    content: readonly UserContent[],
    operationId?: OperationId,
  ): Promise<{ operationId: OperationId; stopReason: string }> {
    const managed = this.managed(sessionId);
    if (operationId !== undefined) {
      const prior = managed.events.filter((event) => event.operationId === operationId);
      const terminal = prior.findLast(
        (event) =>
          (event.type === "assistant.message" && event.payload.stopReason !== "tool_use") ||
          event.type === "session.error",
      );
      if (terminal?.type === "assistant.message") {
        return { operationId, stopReason: terminal.payload.stopReason };
      }
      if (terminal?.type === "session.error") return { operationId, stopReason: "error" };
      if (prior.some((event) => event.type === "user.message")) {
        const aborted = await managed.session.abortRecoveredTurn(operationId);
        return { operationId, stopReason: aborted.payload.stopReason };
      }
    }
    try {
      for (const item of content) {
        if (item.type === "blob")
          await this.blobs.assertOwned(managed.session.log.sessionId, item.blob);
      }
    } catch (error) {
      if (error instanceof BlobStoreError) {
        throw new DaemonError(error.code, error.message, { cause: error });
      }
      throw error;
    }
    if (managed.activeTurn || managed.rebuilding) {
      throw new DaemonError("operation_active", "An operation already owns this branch");
    }
    const active = deferredTurn("turn", operationId);
    managed.activeTurn = active;
    try {
      await this.captureWorkspaceCheckpoint(managed);
      let result = await managed.session.runTurn(
        content,
        active.controller.signal,
        active.operationId,
      );
      while (managed.session.hasQueuedMessages()) {
        active.controller = new AbortController();
        result = (await managed.session.continueQueued(active.controller.signal)) ?? result;
      }
      return { operationId: active.operationId, stopReason: result.stopReason };
    } finally {
      if (managed.activeTurn === active) delete managed.activeTurn;
      active.finish();
      void this.drainQueue(managed);
    }
  }

  private async drainQueue(managed: ManagedSession): Promise<void> {
    if (managed.queueDraining || managed.activeTurn || managed.rebuilding || managed.disposing)
      return;
    managed.queueDraining = true;
    try {
      while (!managed.activeTurn && !managed.rebuilding) {
        const queued = managed.queue.shift();
        if (queued === undefined) break;
        await managed.session.recordQueueEvent(queued.operationId, "queue.started", {
          queueItemId: queued.queueItemId,
        });
        try {
          await this.send(managed.session.log.sessionId, queued.content, queued.operationId);
        } catch {
          await managed.session.recordSessionError(queued.operationId, {
            code: "queued_prompt_failed",
            message: "Queued prompt execution failed",
            retryable: false,
          });
        }
      }
    } finally {
      managed.queueDraining = false;
    }
  }

  private async pauseRecoveredQueue(managed: ManagedSession): Promise<void> {
    const pending = new Map<EventId, OperationId>();
    for (const event of managed.events) {
      if (event.type === "queue.enqueued" && event.operationId !== undefined) {
        pending.set(event.id, event.operationId);
      } else if (event.type === "queue.started" || event.type === "queue.paused") {
        pending.delete(event.payload.queueItemId);
      } else if (event.type === "queue.requeued") {
        const queued = managed.events.find(
          (candidate) =>
            candidate.type === "queue.enqueued" && candidate.id === event.payload.queueItemId,
        );
        if (queued?.operationId !== undefined) pending.set(queued.id, queued.operationId);
      }
    }
    for (const [queueItemId, operationId] of pending) {
      await managed.session.recordQueueEvent(operationId, "queue.paused", {
        queueItemId,
        reason: "daemon_restart",
      });
    }
  }

  async compact(sessionId: unknown, customInstructions?: string): Promise<{ eventId: EventId }> {
    const managed = this.managed(sessionId);
    if (managed.activeTurn || managed.rebuilding) {
      throw new DaemonError("operation_active", "An operation already owns this branch");
    }
    const active = deferredTurn("compaction");
    managed.activeTurn = active;
    try {
      const event = await managed.session.compact(customInstructions, active.controller.signal);
      return { eventId: event.id };
    } catch (error) {
      if (active.controller.signal.aborted)
        throw new DaemonError("cancelled", "Compaction cancelled", { cause: error });
      if (error instanceof CompactionUnavailableError)
        throw new DaemonError("bad_request", error.message, { cause: error });
      throw error;
    } finally {
      if (managed.activeTurn === active) delete managed.activeTurn;
      active.finish();
      void this.drainQueue(managed);
    }
  }

  async shell(
    sessionId: unknown,
    operationId: OperationId,
    command: string,
    excluded: boolean,
  ): Promise<{ operationId: OperationId; isError: boolean; resultEventId: EventId }> {
    const managed = this.managed(sessionId);
    const recorded = managed.events.find(
      (event) => event.type === "user.shell" && event.operationId === operationId,
    );
    if (recorded?.type === "user.shell") {
      if (recorded.payload.command !== command || recorded.payload.excluded !== excluded) {
        throw new DaemonError(
          "idempotency_conflict",
          "The shell operation ID is already bound to another command",
        );
      }
      return { operationId, isError: recorded.payload.isError, resultEventId: recorded.id };
    }
    encodeCanonicalEvent({
      version: EVENT_FORMAT_VERSION,
      id: randomUUID(),
      sessionId: managed.session.log.sessionId,
      operationId,
      parentId: managed.events.at(-1)?.id ?? null,
      timestamp: Date.now(),
      type: "user.shell",
      payload: {
        command,
        content: [
          {
            type: "blob",
            blob: {
              sha256: "0".repeat(64),
              mediaType: "application/octet-stream",
              sizeBytes: 20 * 1024 * 1024,
            },
          },
        ],
        isError: false,
        excluded,
      },
    });
    if (managed.activeTurn || managed.rebuilding) {
      throw new DaemonError("operation_active", "An operation already owns this branch");
    }
    const active = deferredTurn("shell", operationId);
    managed.activeTurn = active;
    try {
      await this.captureWorkspaceCheckpoint(managed);
      const event = await managed.session.runShell(
        command,
        excluded,
        active.controller.signal,
        active.operationId,
      );
      return { operationId, isError: event.payload.isError, resultEventId: event.id };
    } finally {
      if (managed.activeTurn === active) delete managed.activeTurn;
      active.finish();
      void this.drainQueue(managed);
    }
  }

  async setWorkspaceCheckpoints(
    sessionId: unknown,
    enabled: boolean,
  ): Promise<{ enabled: boolean; checkpointId?: string }> {
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
    const checkpoint = enabled
      ? await this.workspaceCheckpoints.read(managed.session.log.sessionId)
      : undefined;
    return {
      enabled,
      ...(checkpoint === undefined ? {} : { checkpointId: checkpoint.checkpointId }),
    };
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

  workspaceList(
    owner: string,
    sessionId: unknown,
    params: Omit<WorkspaceListParams, "sessionId">,
    signal?: AbortSignal,
  ): Promise<WorkspaceListResult> {
    return this.workspaceOperation(sessionId, (managed) =>
      this.workspace.list(owner, managed.session.log.sessionId, managed.cwd, params, signal),
    );
  }

  workspaceRead(
    owner: string,
    sessionId: unknown,
    params: Omit<WorkspaceReadParams, "sessionId">,
    signal?: AbortSignal,
  ): Promise<WorkspaceReadResult> {
    return this.workspaceOperation(sessionId, (managed) =>
      this.workspace.read(owner, managed.session.log.sessionId, managed.cwd, params, signal),
    );
  }

  workspaceStatus(
    sessionId: unknown,
    params: Omit<WorkspaceStatusParams, "sessionId">,
    signal?: AbortSignal,
  ): Promise<WorkspaceStatusResult> {
    const managed = this.managed(sessionId);
    if (params.scope === "last-turn" && managed.checkpointError !== undefined) {
      throw new DaemonError(managed.checkpointError.code, managed.checkpointError.message, {
        cause: managed.checkpointError,
      });
    }
    return this.workspaceOperation(sessionId, (current) =>
      this.workspace.status(current.session.log.sessionId, current.cwd, params, signal),
    );
  }

  workspaceDiff(
    sessionId: unknown,
    params: Omit<WorkspaceDiffParams, "sessionId">,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffResult> {
    return this.workspaceOperation(sessionId, (managed) =>
      this.workspace.diff(managed.session.log.sessionId, managed.cwd, params, signal),
    );
  }

  private async workspaceOperation<Result>(
    sessionId: unknown,
    operation: (managed: ManagedSession) => Promise<Result>,
  ): Promise<Result> {
    try {
      return await operation(this.managed(sessionId));
    } catch (error) {
      if (error instanceof WorkspaceCheckpointError || error instanceof WorkspaceError) {
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

  interrupt(sessionId: unknown): { interrupted: boolean; operationId?: OperationId } {
    const active = this.managed(sessionId).activeTurn;
    if (!active) return { interrupted: false };
    active.controller.abort();
    return { interrupted: true, operationId: active.operationId };
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
    const sessionEvents = [...managed.events];
    const selectedEvents =
      fromNodeId === undefined
        ? sessionEvents
        : SessionTree.fromEvents(managed.session.log.sessionId, sessionEvents).lineage(fromNodeId);
    if (fromNodeId === undefined) {
      managed.listeners.add(listener);
      if (activityListener !== undefined) managed.activityListeners.add(activityListener);
    }
    const current = managed.activityState.current;
    const activity =
      fromNodeId !== undefined ||
      current === undefined ||
      (current.type === "clear" && managed.activeTurn === undefined)
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
      snapshot: selectedEvents,
      allEvents: selectedEvents,
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
  ): Promise<{ interactionId: string; resolutionEventId: EventId }> {
    const managed = this.managed(sessionId);
    if (operationId !== undefined) {
      const recorded = managed.events.find(
        (event) => event.type === "interaction.resolved" && event.operationId === operationId,
      );
      if (recorded?.type === "interaction.resolved") {
        return { interactionId: recorded.payload.interactionId, resolutionEventId: recorded.id };
      }
    }
    const pending = managed.interactions.get(interactionId);
    if (!pending) {
      const resolved = managed.events.find(
        (event) =>
          event.type === "interaction.resolved" && event.payload.interactionId === interactionId,
      );
      if (resolved !== undefined) {
        throw new DaemonError(
          "interaction_already_resolved",
          `Interaction ${interactionId} is already resolved`,
          { details: { resolutionEventId: resolved.id } },
        );
      }
      throw new DaemonError("unknown_interaction", `Interaction ${interactionId} is not pending`);
    }
    if (pending.resolution !== undefined) {
      const resolutionEventId = await pending.resolution;
      throw new DaemonError(
        "interaction_already_resolved",
        `Interaction ${interactionId} is already resolved`,
        { details: { resolutionEventId } },
      );
    }
    const resolving = managed.session
      .resolveInteraction({ interactionId, ...response }, operationId)
      .then((event) => event.id);
    pending.resolution = resolving;
    try {
      const resolutionEventId = await resolving;
      managed.interactions.delete(interactionId);
      pending.resolve(response);
      return { interactionId, resolutionEventId };
    } catch (error) {
      managed.interactions.delete(interactionId);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private async rebuild(
    managed: ManagedSession,
    boundary: SessionRuntimeBoundary,
    selection: SessionConfiguration,
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
    managed.disposing = true;
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
    this.assertNotQuarantined(parsed);
    const managed = this.sessions.get(parsed);
    if (!managed)
      throw new DaemonError("unknown_session", `Session ${parsed} is not open; resume it first`);
    return managed;
  }
}
