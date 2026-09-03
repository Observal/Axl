// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  type AttachmentPresence,
  type CanonicalEvent,
  CanonicalEventSizeError,
  type ClientIdentity,
  type EventCursor,
  type EventId,
  encodeWireMessage,
  hashCanonicalRequest,
  isKnownRpcErrorCode,
  isRetryableMutationMethod,
  isRpcErrorAllowed,
  isRpcErrorRetryable,
  MAX_CANONICAL_EVENT_BYTES,
  MAX_WIRE_MESSAGE_BYTES,
  ProtocolValidationError,
  parseOperationId,
  parseRpcResult,
  parseSessionId,
  parseWireRequest,
  type RetryableMutationMethod,
  requiredCapability,
  RPC_METHODS,
  type ServerMessage,
  type SessionActivityFrame,
  type SessionId,
  type SessionListParams,
  type SessionSummary,
  type SnapshotPage,
  WIRE_CAPABILITIES,
  WIRE_PROTOCOL_VERSION,
  type WireRequest,
} from "@axl/protocol";

import { type CommandAcceptance, CommandJournal, CommandJournalError } from "./command-journal.ts";
import { DataDirectoryLock } from "./data-directory-lock.ts";
import { DaemonError, SessionManager, type SessionManagerOptions } from "./session-manager.ts";

export type DaemonSecurityMode = "sandboxed" | "unsafe";

export interface DaemonOptions extends SessionManagerOptions {
  readonly socketPath: string;
  readonly securityMode?: DaemonSecurityMode;
  readonly sandboxProvider?: string;
  readonly sandboxImage?: string;
  readonly snapshotIdleLifetimeMs?: number;
  readonly snapshotAbsoluteLifetimeMs?: number;
  readonly cursorLifetimeMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly presenceTimeoutMs?: number;
}

const MAX_PENDING_REQUESTS = 64;
const MAX_ATTACHMENTS = 256;
const MAX_SNAPSHOT_PAGE_BYTES = MAX_CANONICAL_EVENT_BYTES;
const MAX_SNAPSHOT_PAGE_EVENTS = 5_000;
const MAX_SNAPSHOT_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_TAIL_EVENTS = 1_024;
const MAX_EVENT_CURSORS = 16_384;
const HEARTBEAT_INTERVAL_MS = 20_000;
const PRESENCE_TIMEOUT_MS = 60_000;
const SOCKET_PROBE_TIMEOUT_MS = 500;

export function normalizeDaemonRpcErrorCode(method: WireRequest["method"], code: string): string {
  return isKnownRpcErrorCode(code) && isRpcErrorAllowed(method, code) ? code : "internal_error";
}

interface CursorRecord {
  subscriptionId: string;
  readonly sessionId: SessionId;
  readonly fromNodeId?: EventId;
  readonly position: number;
  readonly expiresAt: number;
  acknowledged: boolean;
}

interface ConnectionSubscription {
  readonly id: string;
  readonly sessionId: SessionId;
  readonly fromNodeId?: EventId;
  readonly boundaryCursor?: EventCursor;
  readonly snapshotId?: string;
  readonly snapshotEvents: readonly CanonicalEvent[];
  readonly pageCursors: Map<string, number>;
  readonly pageResults: Map<string, SnapshotPage>;
  readonly bufferedEvents: Array<{ readonly event: CanonicalEvent; readonly position: number }>;
  readonly bufferedActivity: SessionActivityFrame[];
  unsubscribe: () => void;
  nextPosition: number;
  sequence: number;
  bufferedEventBytes: number;
  acknowledgedPosition: number;
  acknowledgedCursor?: EventCursor;
  active: boolean;
  finalPageServed: boolean;
  activateAfterResponse: boolean;
  invalidated: boolean;
  readonly createdAt: number;
  lastAccessAt: number;
}

interface SessionListPage {
  readonly queryKey: string;
  readonly sessions: readonly SessionSummary[];
  readonly offset: number;
}

interface ConnectionState {
  initialized: boolean;
  attachmentId?: string;
  client?: ClientIdentity;
  connectedAt?: number;
  lastSeenAt?: number;
  grantedCapabilities: ReadonlySet<string>;
  pendingRequests: number;
  readonly cancellableRequests: Map<number, AbortController>;
  readonly sessionListPages: Map<string, SessionListPage>;
  readonly subscriptions: Map<string, ConnectionSubscription>;
  readonly send: (message: ServerMessage) => void;
}

type SocketIdentity = { readonly dev: number; readonly ino: number };

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => finish(true), SOCKET_PROBE_TIMEOUT_MS);
    timer.unref();
    let settled = false;
    const finish = (live: boolean, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(live);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (["ECONNREFUSED", "ENOENT", "EPIPE", "ECONNRESET"].includes(error.code ?? "")) {
        finish(false);
      } else {
        finish(false, error);
      }
    });
  });
}

async function removeStaleSocket(path: string): Promise<void> {
  let before: Stats;
  try {
    before = await lstat(path);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  if (!before.isSocket()) throw new Error(`Refusing to remove non-socket path ${path}`);
  if (await socketIsLive(path)) throw new Error(`A daemon is already listening at ${path}`);
  const after = await lstat(path);
  if (!after.isSocket() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error(`Socket path changed while checking ${path}`);
  }
  await unlink(path);
}

/** The local daemon is the sole owner of session loops, logs, and operations. */
export class AxlDaemon {
  readonly sessions: SessionManager;
  private readonly socketPath: string;
  private readonly securityMode: DaemonSecurityMode;
  private readonly sandboxProvider: string;
  private readonly sandboxImage: string | undefined;
  private readonly dataDirectory: string;
  private readonly snapshotIdleLifetimeMs: number;
  private readonly snapshotAbsoluteLifetimeMs: number;
  private readonly cursorLifetimeMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly presenceTimeoutMs: number;
  private readonly daemonInstanceId = randomUUID();
  private commandJournal: CommandJournal | undefined;
  private dataLock: DataDirectoryLock | undefined;
  private server: Server | undefined;
  private socketIdentity: SocketIdentity | undefined;
  private readonly connections = new Set<Socket>();
  private readonly connectionStates = new Set<ConnectionState>();
  private readonly cursors = new Map<EventCursor, CursorRecord>();

  constructor(options: DaemonOptions) {
    this.sessions = new SessionManager(options);
    this.socketPath = options.socketPath;
    this.securityMode = options.securityMode ?? "sandboxed";
    this.sandboxProvider = options.sandboxProvider ?? "unknown";
    this.sandboxImage = options.sandboxImage;
    this.dataDirectory = options.dataDirectory;
    this.snapshotIdleLifetimeMs = options.snapshotIdleLifetimeMs ?? 30_000;
    this.snapshotAbsoluteLifetimeMs = options.snapshotAbsoluteLifetimeMs ?? 300_000;
    this.cursorLifetimeMs = options.cursorLifetimeMs ?? 300_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.presenceTimeoutMs = options.presenceTimeoutMs ?? PRESENCE_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.snapshotIdleLifetimeMs) ||
      this.snapshotIdleLifetimeMs <= 0 ||
      !Number.isSafeInteger(this.snapshotAbsoluteLifetimeMs) ||
      this.snapshotAbsoluteLifetimeMs < this.snapshotIdleLifetimeMs
    ) {
      throw new TypeError("Snapshot lifetimes must be positive and absolute must cover idle");
    }
    if (!Number.isSafeInteger(this.cursorLifetimeMs) || this.cursorLifetimeMs <= 0) {
      throw new TypeError("Cursor lifetime must be positive");
    }
    if (
      !Number.isSafeInteger(this.heartbeatIntervalMs) ||
      this.heartbeatIntervalMs <= 0 ||
      !Number.isSafeInteger(this.presenceTimeoutMs) ||
      this.presenceTimeoutMs <= this.heartbeatIntervalMs
    ) {
      throw new TypeError("Presence timeout must be greater than the positive heartbeat interval");
    }
  }

  async start(): Promise<void> {
    if (this.server || this.dataLock) {
      throw new DaemonError("already_started", "Daemon already started");
    }
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await removeStaleSocket(this.socketPath);
    this.dataLock = await DataDirectoryLock.acquire(this.dataDirectory, "daemon");
    try {
      await this.sessions.scanLegacyEvents();
      this.commandJournal = await CommandJournal.open(this.dataDirectory);
      await this.commandJournal.reconcile(async (acceptance) => {
        try {
          const result = await this.sessions.reconcileAcceptedMutation(acceptance);
          return result === undefined ? undefined : { result };
        } catch (error) {
          if (error instanceof DaemonError && error.code === "cancelled") {
            return {
              error: { code: error.code, message: error.message, retryable: false },
            };
          }
          throw error;
        }
      });

      const server = createServer((socket) => this.accept(socket));
      this.server = server;
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => {
          server.off("listening", listening);
          reject(error);
        };
        const listening = (): void => {
          server.off("error", failed);
          resolve();
        };
        server.once("error", failed);
        server.once("listening", listening);
        server.listen(this.socketPath);
      });
      const stats = await lstat(this.socketPath);
      this.socketIdentity = { dev: stats.dev, ino: stats.ino };
      await chmod(this.socketPath, 0o600);
    } catch (error) {
      if (this.server?.listening) {
        await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      }
      this.server = undefined;
      try {
        await this.removeOwnedSocket();
      } finally {
        await this.dataLock.release();
        this.dataLock = undefined;
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    this.cursors.clear();
    const server = this.server;
    this.server = undefined;
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      await this.sessions.disposeAll();
    } finally {
      try {
        await this.removeOwnedSocket();
      } finally {
        await this.dataLock?.release({ allowMissing: true });
        this.dataLock = undefined;
      }
    }
  }

  private accept(socket: Socket): void {
    this.connections.add(socket);
    const send = (message: ServerMessage): void => {
      if (socket.destroyed) return;
      const encoded = encodeWireMessage(message);
      if (Buffer.byteLength(encoded) > MAX_WIRE_MESSAGE_BYTES) {
        socket.destroy(new Error("Daemon message exceeded the negotiated size limit"));
        return;
      }
      socket.write(encoded);
    };
    const state: ConnectionState = {
      initialized: false,
      grantedCapabilities: new Set(),
      pendingRequests: 0,
      cancellableRequests: new Map(),
      sessionListPages: new Map(),
      subscriptions: new Map(),
      send,
    };
    this.connectionStates.add(state);
    send({
      kind: "hello",
      wireVersion: WIRE_PROTOCOL_VERSION,
      daemonInstanceId: this.daemonInstanceId,
      capabilities: WIRE_CAPABILITIES,
      limits: {
        maxMessageBytes: MAX_WIRE_MESSAGE_BYTES,
        maxPendingRequests: MAX_PENDING_REQUESTS,
      },
    });

    let buffer = "";
    const decoder = new StringDecoder("utf8");
    socket.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > MAX_WIRE_MESSAGE_BYTES && !buffer.includes("\n")) {
        send({
          kind: "error",
          id: -1,
          error: {
            code: "frame_too_large",
            message: "Request exceeded the size limit",
            retryable: false,
          },
        });
        socket.destroy();
        return;
      }
      for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_WIRE_MESSAGE_BYTES) {
          send({
            kind: "error",
            id: -1,
            error: {
              code: "frame_too_large",
              message: "Request exceeded the size limit",
              retryable: false,
            },
          });
          socket.destroy();
          return;
        }
        if (line.trim()) {
          if (state.pendingRequests >= MAX_PENDING_REQUESTS) {
            this.rejectOverloadedLine(line, send);
            continue;
          }
          state.pendingRequests += 1;
          void this.handleLine(line, send, state).finally(() => {
            state.pendingRequests -= 1;
          });
        }
      }
    });
    const presenceTimer = setInterval(
      () => {
        const now = Date.now();
        this.pruneCursors(now);
        if (state.lastSeenAt !== undefined && now - state.lastSeenAt > this.presenceTimeoutMs) {
          socket.destroy();
          return;
        }
        for (const subscription of state.subscriptions.values()) {
          if (
            !subscription.active &&
            !subscription.invalidated &&
            (now - subscription.lastAccessAt > this.snapshotIdleLifetimeMs ||
              now - subscription.createdAt > this.snapshotAbsoluteLifetimeMs)
          ) {
            this.invalidateSnapshot(subscription);
          }
        }
      },
      Math.min(this.heartbeatIntervalMs, this.snapshotIdleLifetimeMs),
    );
    presenceTimer.unref();
    const cleanup = (): void => {
      clearInterval(presenceTimer);
      for (const controller of state.cancellableRequests.values()) controller.abort();
      state.cancellableRequests.clear();
      state.sessionListPages.clear();
      for (const subscription of state.subscriptions.values()) {
        this.releaseSubscriptionCursors(subscription, true);
        subscription.unsubscribe();
      }
      state.subscriptions.clear();
      this.connections.delete(socket);
      this.connectionStates.delete(state);
      this.publishPresence();
    };
    socket.once("close", cleanup);
    socket.once("error", () => socket.destroy());
  }

  private rejectOverloadedLine(line: string, send: (message: ServerMessage) => void): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line) as unknown;
    } catch (error) {
      send({
        kind: "error",
        id: -1,
        error: {
          code: "bad_request",
          message: error instanceof Error ? error.message : "Undecodable request",
          retryable: false,
        },
      });
      return;
    }
    try {
      const request = parseWireRequest(decoded);
      send({
        kind: "error",
        id: request.id,
        method: request.method,
        error: {
          code: "rate_limited",
          message: "Too many pending requests",
          retryable: true,
        },
      });
    } catch (error) {
      const candidate =
        typeof decoded === "object" && decoded !== null
          ? (decoded as Record<string, unknown>)
          : undefined;
      const id =
        Number.isSafeInteger(candidate?.id) && (candidate?.id as number) >= 0
          ? (candidate?.id as number)
          : -1;
      this.rejectMalformedRequest(candidate, id, error, send);
    }
  }

  private rejectMalformedRequest(
    candidate: Record<string, unknown> | undefined,
    id: number,
    error: unknown,
    send: (message: ServerMessage) => void,
  ): void {
    const method =
      id !== -1 &&
      typeof candidate?.method === "string" &&
      (RPC_METHODS as readonly string[]).includes(candidate.method)
        ? (candidate.method as WireRequest["method"])
        : undefined;
    const reportedCode =
      error instanceof ProtocolValidationError && error.path === "request.idempotencyKey"
        ? "invalid_idempotency_key"
        : "bad_request";
    const code =
      method === undefined ? "bad_request" : normalizeDaemonRpcErrorCode(method, reportedCode);
    send({
      kind: "error",
      id: method === undefined ? -1 : id,
      ...(method === undefined ? {} : { method }),
      error: {
        code,
        message: error instanceof Error ? error.message : "Invalid request",
        retryable: isRpcErrorRetryable(code),
      },
    });
  }

  private async handleLine(
    line: string,
    send: (message: ServerMessage) => void,
    state: ConnectionState,
  ): Promise<void> {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line) as unknown;
    } catch (error) {
      send({
        kind: "error",
        id: -1,
        error: {
          code: "bad_request",
          message: error instanceof Error ? error.message : "Undecodable request",
          retryable: false,
        },
      });
      return;
    }
    let request: WireRequest;
    try {
      request = parseWireRequest(decoded);
    } catch (error) {
      const candidate =
        typeof decoded === "object" && decoded !== null
          ? (decoded as Record<string, unknown>)
          : undefined;
      const id =
        Number.isSafeInteger(candidate?.id) && (candidate?.id as number) >= 0
          ? (candidate?.id as number)
          : -1;
      this.rejectMalformedRequest(candidate, id, error, send);
      return;
    }
    try {
      if (
        !state.initialized &&
        request.method !== "daemon.info" &&
        request.method !== "connection.initialize" &&
        request.method !== "connection.ping"
      ) {
        throw new DaemonError(
          "not_initialized",
          "Initialize the connection before accessing sessions",
        );
      }
      if (request.method === "connection.initialize") {
        if (state.initialized) {
          throw new DaemonError(
            "connection_already_initialized",
            "Connection is already initialized",
          );
        }
        const attachmentCount = [...this.connectionStates].filter(
          (connection) => connection.initialized,
        ).length;
        if (attachmentCount >= MAX_ATTACHMENTS) {
          throw new DaemonError("rate_limited", "The daemon attachment limit has been reached");
        }
        const now = Date.now();
        state.initialized = true;
        state.attachmentId = randomUUID();
        state.client = request.params.client;
        state.connectedAt = now;
        state.lastSeenAt = now;
        state.grantedCapabilities = new Set(
          request.params.requestedCapabilities.filter((capability) =>
            WIRE_CAPABILITIES.includes(capability as (typeof WIRE_CAPABILITIES)[number]),
          ),
        );
      } else {
        if (request.method === "connection.ping" && state.initialized) {
          state.lastSeenAt = Date.now();
        }
        const capability = requiredCapability(request.method);
        if (capability !== undefined && !state.grantedCapabilities.has(capability)) {
          throw new DaemonError(
            "unsupported_capability",
            `Connection was not granted capability ${capability}`,
          );
        }
      }
      const cancellable =
        request.method === "session.history" ||
        request.method === "session.workspace.list" ||
        request.method === "session.workspace.read" ||
        request.method === "session.workspace.status" ||
        request.method === "session.workspace.diff";
      const controller = cancellable ? new AbortController() : undefined;
      if (controller !== undefined) state.cancellableRequests.set(request.id, controller);
      let dispatched: unknown;
      try {
        dispatched = await this.executeRequest(request, send, state, controller?.signal);
      } finally {
        if (controller !== undefined) state.cancellableRequests.delete(request.id);
      }
      const result = parseRpcResult(request.method, dispatched);
      send({
        kind: "success",
        id: request.id,
        method: request.method,
        result,
      } as ServerMessage);
      this.activateReadySubscriptions(state, send);
      if (
        request.method === "connection.initialize" ||
        request.method === "connection.ping" ||
        request.method === "session.subscribe" ||
        request.method === "session.unsubscribe"
      ) {
        this.publishPresence();
      }
    } catch (error) {
      const reportedCode =
        error instanceof DaemonError || error instanceof CommandJournalError
          ? error.code
          : error instanceof CanonicalEventSizeError
            ? "content_too_large"
            : "internal_error";
      const code = normalizeDaemonRpcErrorCode(request.method, reportedCode);
      send({
        kind: "error",
        id: request.id,
        method: request.method,
        error: {
          code,
          message: error instanceof Error ? error.message : "Request failed",
          retryable: isRpcErrorRetryable(code),
          ...((error instanceof DaemonError || error instanceof CommandJournalError) &&
          error.details !== undefined
            ? { details: error.details }
            : error instanceof CanonicalEventSizeError
              ? {
                  details: {
                    field: "canonicalEvent",
                    encodedBytes: error.encodedBytes,
                    maximumBytes: error.maximumBytes,
                  },
                }
              : {}),
        },
      });
    }
  }

  private async executeRequest(
    request: WireRequest,
    send: (message: ServerMessage) => void,
    state: ConnectionState,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let normalized = request;
    if (request.method === "session.create") {
      const cwd = await realpath(request.params.cwd).catch((cause: unknown) => {
        throw new DaemonError(
          "invalid_cwd",
          `Cannot open working directory ${request.params.cwd}`,
          {
            cause,
          },
        );
      });
      normalized = {
        ...request,
        params: { ...request.params, cwd, profile: request.params.profile ?? "minimal" },
      };
    } else if (request.method === "session.configure") {
      normalized = {
        ...request,
        params: { ...request.params, profile: request.params.profile ?? "minimal" },
      };
    } else if (request.method === "session.list" && request.params.cwd !== undefined) {
      const cwd = await realpath(request.params.cwd).catch((cause: unknown) => {
        throw new DaemonError(
          "invalid_cwd",
          `Cannot open working directory ${request.params.cwd}`,
          {
            cause,
          },
        );
      });
      normalized = { ...request, params: { ...request.params, cwd } };
    }
    if (!isRetryableMutationMethod(normalized.method)) {
      return this.dispatch(normalized, send, state, undefined, signal);
    }
    const idempotencyKey = normalized.idempotencyKey;
    if (idempotencyKey === undefined) {
      throw new DaemonError("invalid_idempotency_key", "Retryable mutation requires a key");
    }
    const journal = this.commandJournal;
    if (journal === undefined) throw new Error("Command journal is not open");
    const params = normalized.params as { readonly sessionId?: SessionId };
    const intendedSessionId =
      normalized.method === "session.create" ||
      normalized.method === "session.fork" ||
      normalized.method === "session.clone"
        ? parseSessionId(randomUUID(), "intendedSessionId")
        : undefined;
    const affectedOperationId =
      normalized.method === "session.interrupt"
        ? this.sessions.activeOperationId(normalized.params.sessionId)
        : undefined;
    const interactionId =
      normalized.method === "session.interaction.respond"
        ? normalized.params.interactionId
        : undefined;
    return journal.execute(
      {
        idempotencyKey,
        method: normalized.method as RetryableMutationMethod,
        requestHash: hashCanonicalRequest(normalized.method, normalized.params as never),
        ...(params.sessionId === undefined ? {} : { targetSessionId: params.sessionId }),
        ...(intendedSessionId === undefined ? {} : { intendedSessionId }),
        ...(affectedOperationId === undefined ? {} : { affectedOperationId }),
        ...(interactionId === undefined ? {} : { interactionId }),
      },
      (acceptance) => this.dispatch(normalized, send, state, acceptance) as never,
    );
  }

  private async dispatch(
    request: WireRequest,
    send: (message: ServerMessage) => void,
    state: ConnectionState,
    acceptance?: CommandAcceptance,
    signal?: AbortSignal,
  ): Promise<unknown> {
    switch (request.method) {
      case "daemon.info":
        return {
          securityMode: this.securityMode,
          sandboxProvider: this.sandboxProvider,
          ...(this.sandboxImage === undefined ? {} : { sandboxImage: this.sandboxImage }),
        };
      case "connection.initialize": {
        return {
          attachmentId: state.attachmentId,
          daemonInstanceId: this.daemonInstanceId,
          wireVersion: WIRE_PROTOCOL_VERSION,
          grantedCapabilities: [...state.grantedCapabilities],
          scope: "local_control",
          heartbeatIntervalMs: this.heartbeatIntervalMs,
          presenceTimeoutMs: this.presenceTimeoutMs,
        };
      }
      case "connection.ping":
        return {};
      case "request.cancel": {
        const controller = state.cancellableRequests.get(request.params.requestId);
        controller?.abort();
        return { cancellationRequested: controller !== undefined };
      }
      case "session.create": {
        const { cwd, modelId, thinkingLevel, profile } = request.params;
        if (profile !== undefined && profile !== "minimal") {
          throw new DaemonError(
            "unsupported_capability",
            `Session profile ${profile} is not available`,
          );
        }
        const reservation = this.creationReservation(acceptance);
        const created = await this.sessions.create(
          cwd,
          {
            ...(modelId === undefined ? {} : { modelId }),
            ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
          },
          reservation,
        );
        return this.sessions.describe(created.sessionId);
      }
      case "session.resume":
        await this.sessions.resume(request.params.sessionId);
        return this.sessions.describe(request.params.sessionId);
      case "session.list":
        return this.listSessions(state, request.params);
      case "session.history":
        return this.snapshotPage(state, request.params.snapshotId, request.params.pageCursor);
      case "session.ack":
        return this.acknowledge(state, request.params.subscriptionId, request.params.cursor);
      case "session.unsubscribe":
        return this.unsubscribe(state, request.params.subscriptionId);
      case "session.fork": {
        const forked = await this.sessions.fork(
          request.params.sessionId,
          request.params.fromEventId,
          this.creationReservation(acceptance),
        );
        return {
          ...this.sessions.describe(forked.sessionId),
          ...(forked.selectedText === undefined ? {} : { selectedText: forked.selectedText }),
        };
      }
      case "session.clone": {
        const cloned = await this.sessions.clone(
          request.params.sessionId,
          this.creationReservation(acceptance),
        );
        return {
          ...this.sessions.describe(cloned.sessionId),
          ...(cloned.selectedText === undefined ? {} : { selectedText: cloned.selectedText }),
        };
      }
      case "session.send":
        if (request.params.delivery !== "prompt") {
          throw new DaemonError(
            "unsupported_capability",
            `Delivery mode ${request.params.delivery} is not available`,
          );
        }
        return this.sessions.send(
          request.params.sessionId,
          request.params.content,
          this.mutationOperationId(acceptance),
        );
      case "session.queue.enqueue":
        return this.sessions.enqueue(
          request.params.sessionId,
          request.params.content,
          request.params.priority,
          this.mutationOperationId(acceptance),
        );
      case "session.queue.requeue":
        return this.sessions.requeue(
          request.params.sessionId,
          request.params.queueItemId,
          request.params.priority,
          this.mutationOperationId(acceptance),
        );
      case "session.shell":
        return this.sessions.shell(
          request.params.sessionId,
          request.params.operationId,
          request.params.command,
          request.params.excluded,
        );
      case "session.interrupt":
        return this.sessions.interrupt(request.params.sessionId);
      case "session.reload":
        return this.sessions.reload(request.params.sessionId, this.mutationOperationId(acceptance));
      case "session.configure": {
        const { sessionId, modelId, thinkingLevel, profile } = request.params;
        if (profile !== undefined && profile !== "minimal") {
          throw new DaemonError(
            "unsupported_capability",
            `Session profile ${profile} is not available`,
          );
        }
        return this.sessions.configure(
          sessionId,
          {
            ...(modelId === undefined ? {} : { modelId }),
            ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
          },
          this.mutationOperationId(acceptance),
        );
      }
      case "session.interaction.respond": {
        const { sessionId, interactionId, action, content } = request.params;
        return this.sessions.respondToInteraction(
          sessionId,
          interactionId,
          {
            action,
            ...(content === undefined ? {} : { content }),
          },
          this.mutationOperationId(acceptance),
        );
      }
      case "session.subscribe":
        return this.subscribe(state, send, request.params);
      case "session.blob.start":
        return this.sessions.startBlobUpload(request.params.sessionId, request.params);
      case "session.blob.chunk":
        return this.sessions.appendBlobChunk(
          request.params.sessionId,
          request.params.uploadId,
          request.params.offset,
          request.params.data,
        );
      case "session.blob.commit":
        return this.sessions.commitBlobUpload(request.params.sessionId, request.params.uploadId);
      case "session.blob.abort":
        return this.sessions.abortBlobUpload(request.params.sessionId, request.params.uploadId);
      case "session.blob.read":
        return this.sessions.readBlob(
          request.params.sessionId,
          request.params.sha256,
          request.params.offset,
          request.params.length,
        );
      case "session.workspace.list": {
        if (state.attachmentId === undefined) throw new Error("Initialized attachment has no ID");
        const { sessionId, ...params } = request.params;
        return this.sessions.workspaceList(state.attachmentId, sessionId, params, signal);
      }
      case "session.workspace.read": {
        if (state.attachmentId === undefined) throw new Error("Initialized attachment has no ID");
        const { sessionId, ...params } = request.params;
        return this.sessions.workspaceRead(state.attachmentId, sessionId, params, signal);
      }
      case "session.workspace.status": {
        const { sessionId, ...params } = request.params;
        return this.sessions.workspaceStatus(sessionId, params, signal);
      }
      case "session.workspace.checkpoint":
        return this.sessions.setWorkspaceCheckpoints(
          request.params.sessionId,
          request.params.enabled,
        );
      case "session.workspace.diff": {
        const { sessionId, ...params } = request.params;
        return this.sessions.workspaceDiff(sessionId, params, signal);
      }
      case "session.dispose":
        await this.sessions.dispose(request.params.sessionId, this.mutationOperationId(acceptance));
        return { disposed: true, historyPreserved: true };
    }
  }

  private mutationOperationId(
    acceptance: CommandAcceptance | undefined,
  ): ReturnType<typeof parseOperationId> | undefined {
    return acceptance === undefined
      ? undefined
      : parseOperationId(acceptance.operationId, "operationId");
  }

  private creationReservation(
    acceptance: CommandAcceptance | undefined,
  ):
    | { readonly sessionId: SessionId; readonly operationId: ReturnType<typeof parseOperationId> }
    | undefined {
    if (acceptance?.intendedSessionId === undefined) return undefined;
    return {
      sessionId: parseSessionId(acceptance.intendedSessionId, "intendedSessionId"),
      operationId: parseOperationId(acceptance.operationId, "operationId"),
    };
  }

  private async listSessions(
    state: ConnectionState,
    params: SessionListParams,
  ): Promise<{ readonly sessions: readonly SessionSummary[]; readonly nextPageCursor?: string }> {
    const queryKey = JSON.stringify({
      scope: params.scope,
      ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
      ...(params.query === undefined ? {} : { query: params.query }),
      order: params.order,
      pageSize: params.pageSize,
    });
    let sessions: readonly SessionSummary[];
    let offset: number;
    if (params.pageCursor !== undefined) {
      const page = state.sessionListPages.get(params.pageCursor);
      if (page === undefined || page.queryKey !== queryKey) {
        throw new DaemonError("unknown_cursor", "The session-list cursor is unknown");
      }
      sessions = page.sessions;
      offset = page.offset;
    } else {
      const query = params.query?.toLocaleLowerCase();
      const stored = await this.sessions.list();
      const filtered = stored.filter((summary) => {
        if (params.scope === "current_workspace" && summary.cwd !== params.cwd) return false;
        if (query === undefined || query.length === 0) return true;
        return [
          summary.sessionId,
          summary.cwd,
          summary.firstUserMessage ?? "",
          summary.lastUserMessage ?? "",
        ].some((value) => value.toLocaleLowerCase().includes(query));
      });
      const ordered =
        params.order === "recent" ? this.orderRecent(filtered) : this.orderThreaded(filtered);
      sessions = ordered.map((summary) => ({
        ...summary,
        runtime: this.sessions.runtimeState(summary.sessionId),
        attachmentCount: [...this.connectionStates].filter(
          (connection) =>
            connection.initialized &&
            [...connection.subscriptions.values()].some(
              (subscription) => subscription.sessionId === summary.sessionId,
            ),
        ).length,
      }));
      offset = 0;
    }
    const pageSessions = sessions.slice(offset, offset + params.pageSize);
    const nextOffset = offset + pageSessions.length;
    if (nextOffset >= sessions.length) return { sessions: pageSessions };
    const nextPageCursor = randomUUID();
    state.sessionListPages.set(nextPageCursor, { queryKey, sessions, offset: nextOffset });
    if (state.sessionListPages.size > 1_000) {
      const oldest = state.sessionListPages.keys().next().value;
      if (oldest !== undefined) state.sessionListPages.delete(oldest);
    }
    return { sessions: pageSessions, nextPageCursor };
  }

  private orderRecent<Summary extends { readonly updatedAt: number; readonly sessionId: string }>(
    sessions: readonly Summary[],
  ): readonly Summary[] {
    return sessions.toSorted(
      (left, right) =>
        right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId),
    );
  }

  private orderThreaded<
    Summary extends {
      readonly updatedAt: number;
      readonly sessionId: SessionId;
      readonly parentSessionId?: SessionId;
    },
  >(sessions: readonly Summary[]): readonly Summary[] {
    const included = new Set(sessions.map((session) => session.sessionId));
    const children = new Map<SessionId, Summary[]>();
    const roots: Summary[] = [];
    for (const session of sessions) {
      if (session.parentSessionId === undefined || !included.has(session.parentSessionId)) {
        roots.push(session);
        continue;
      }
      const siblings = children.get(session.parentSessionId) ?? [];
      siblings.push(session);
      children.set(session.parentSessionId, siblings);
    }
    const ordered: Summary[] = [];
    const visit = (session: Summary): void => {
      ordered.push(session);
      for (const child of this.orderRecent(children.get(session.sessionId) ?? [])) visit(child);
    };
    for (const root of this.orderRecent(roots)) visit(root);
    return ordered;
  }

  private subscribe(
    state: ConnectionState,
    send: (message: ServerMessage) => void,
    params: Extract<WireRequest, { readonly method: "session.subscribe" }>["params"],
  ): unknown {
    const subscriptionId = randomUUID();
    let owned!: ConnectionSubscription;
    const registered = this.sessions.subscribe(
      params.sessionId,
      (event) => {
        const position = owned.nextPosition;
        owned.nextPosition += 1;
        if (owned.active) this.deliverEvent(owned, event, position, send);
        else this.bufferSnapshotEvent(owned, event, position);
      },
      (frame) => {
        if (owned.active) {
          send({
            kind: "activity",
            subscriptionId: owned.id,
            sessionId: owned.sessionId,
            frame,
          });
        } else {
          this.bufferSnapshotActivity(owned, frame);
        }
      },
      params.fromNodeId,
    );

    const boundaryPosition = registered.allEvents.length - 1;
    const after = params.after;
    let resumedPosition: number | undefined;
    if (after !== undefined) {
      this.pruneCursors();
      const cursor = this.cursors.get(after);
      if (
        cursor === undefined ||
        !cursor.acknowledged ||
        cursor.sessionId !== params.sessionId ||
        cursor.fromNodeId !== params.fromNodeId
      ) {
        registered.unsubscribe();
        throw new DaemonError("snapshot_required", "The event cursor cannot resume this view");
      }
      resumedPosition = cursor.position;
      cursor.subscriptionId = subscriptionId;
    }

    const snapshotId = resumedPosition === undefined ? randomUUID() : undefined;
    const boundaryCursor =
      resumedPosition === undefined
        ? this.createCursor(subscriptionId, params.sessionId, params.fromNodeId, boundaryPosition)
        : undefined;
    const now = Date.now();
    owned = {
      id: subscriptionId,
      sessionId: params.sessionId,
      ...(params.fromNodeId === undefined ? {} : { fromNodeId: params.fromNodeId }),
      ...(boundaryCursor === undefined ? {} : { boundaryCursor }),
      ...(snapshotId === undefined ? {} : { snapshotId }),
      snapshotEvents: registered.snapshot,
      pageCursors: new Map(),
      pageResults: new Map(),
      bufferedEvents: [],
      bufferedActivity: registered.activity === undefined ? [] : [registered.activity],
      unsubscribe: registered.unsubscribe,
      nextPosition: registered.allEvents.length,
      sequence: 0,
      bufferedEventBytes: 0,
      acknowledgedPosition: resumedPosition ?? -2,
      ...(after === undefined ? {} : { acknowledgedCursor: after }),
      active: false,
      finalPageServed: false,
      activateAfterResponse: resumedPosition !== undefined,
      invalidated: false,
      createdAt: now,
      lastAccessAt: now,
    };
    state.subscriptions.set(subscriptionId, owned);

    if (resumedPosition !== undefined) {
      for (const [offset, event] of registered.allEvents.slice(resumedPosition + 1).entries()) {
        this.bufferSnapshotEvent(owned, event, resumedPosition + 1 + offset);
      }
      if (owned.invalidated) {
        state.subscriptions.delete(subscriptionId);
        throw new DaemonError(
          "snapshot_required",
          "The resumable tail exceeded its delivery limit",
        );
      }
      return {
        subscriptionId,
        sessionId: params.sessionId,
        ...(params.fromNodeId === undefined ? {} : { fromNodeId: params.fromNodeId }),
        resumedFrom: after,
      };
    }

    const firstPage = this.buildSnapshotPage(owned, 0);
    owned.finalPageServed = firstPage.complete;
    return {
      subscriptionId,
      sessionId: params.sessionId,
      ...(params.fromNodeId === undefined ? {} : { fromNodeId: params.fromNodeId }),
      snapshot: {
        snapshotId,
        sessionId: params.sessionId,
        ...(params.fromNodeId === undefined ? {} : { fromNodeId: params.fromNodeId }),
        boundaryCursor,
        eventCount: registered.snapshot.length,
        page: firstPage,
      },
    };
  }

  private snapshotPage(
    state: ConnectionState,
    snapshotId: string,
    pageCursor: string,
  ): { readonly snapshotId: string; readonly page: SnapshotPage } {
    const subscription = [...state.subscriptions.values()].find(
      (candidate) => candidate.snapshotId === snapshotId,
    );
    if (subscription === undefined) {
      throw new DaemonError("snapshot_required", "The snapshot is unknown or no longer available");
    }
    const cached = subscription.pageResults.get(pageCursor);
    if (cached !== undefined) return { snapshotId, page: cached };
    this.assertSnapshotAvailable(subscription);
    subscription.lastAccessAt = Date.now();
    const offset = subscription.pageCursors.get(pageCursor);
    if (offset === undefined) {
      throw new DaemonError("unknown_cursor", "The page cursor does not belong to this snapshot");
    }
    const page = this.buildSnapshotPage(subscription, offset);
    subscription.pageResults.set(pageCursor, page);
    if (page.complete) subscription.finalPageServed = true;
    return { snapshotId, page };
  }

  private acknowledge(
    state: ConnectionState,
    subscriptionId: string,
    cursor: EventCursor,
  ): { readonly cursor: EventCursor } {
    const subscription = state.subscriptions.get(subscriptionId);
    if (subscription === undefined) {
      throw new DaemonError("unknown_subscription", "The subscription is not attached here");
    }
    this.assertSnapshotAvailable(subscription);
    subscription.lastAccessAt = Date.now();
    this.pruneCursors();
    const record = this.cursors.get(cursor);
    if (record === undefined || record.subscriptionId !== subscriptionId) {
      throw new DaemonError("unknown_cursor", "The cursor does not belong to this subscription");
    }
    if (cursor === subscription.boundaryCursor) {
      if (!subscription.finalPageServed) {
        throw new DaemonError(
          "snapshot_required",
          "Finish the frozen snapshot before acknowledging it",
        );
      }
      subscription.activateAfterResponse = true;
    }
    record.acknowledged = true;
    if (record.position < subscription.acknowledgedPosition) {
      return { cursor: subscription.acknowledgedCursor ?? cursor };
    }
    subscription.acknowledgedPosition = record.position;
    subscription.acknowledgedCursor = cursor;
    for (const [candidate, candidateRecord] of this.cursors) {
      if (
        candidate !== cursor &&
        candidateRecord.subscriptionId === subscriptionId &&
        candidateRecord.position <= record.position
      ) {
        this.cursors.delete(candidate);
      }
    }
    return { cursor };
  }

  private unsubscribe(
    state: ConnectionState,
    subscriptionId: string,
  ): { readonly unsubscribed: boolean } {
    const subscription = state.subscriptions.get(subscriptionId);
    if (subscription === undefined) {
      throw new DaemonError("unknown_subscription", "The subscription is not attached here");
    }
    this.releaseSubscriptionCursors(subscription, false);
    subscription.unsubscribe();
    state.subscriptions.delete(subscriptionId);
    return { unsubscribed: true };
  }

  private buildSnapshotPage(subscription: ConnectionSubscription, start: number): SnapshotPage {
    const events: CanonicalEvent[] = [];
    let bytes = 0;
    let offset = start;
    while (
      offset < subscription.snapshotEvents.length &&
      events.length < MAX_SNAPSHOT_PAGE_EVENTS
    ) {
      const event = subscription.snapshotEvents[offset];
      if (event === undefined) break;
      const eventBytes = Buffer.byteLength(JSON.stringify(event));
      if (eventBytes > MAX_SNAPSHOT_PAGE_BYTES) {
        throw new DaemonError(
          "event_migration_required",
          `Event ${event.id} exceeds the canonical event limit`,
        );
      }
      if (events.length > 0 && bytes + eventBytes > MAX_SNAPSHOT_PAGE_BYTES) break;
      events.push(event);
      bytes += eventBytes;
      offset += 1;
    }
    const complete = offset >= subscription.snapshotEvents.length;
    if (complete) return { events, complete: true };
    const nextPageCursor = randomUUID();
    subscription.pageCursors.set(nextPageCursor, offset);
    return { events, nextPageCursor, complete: false };
  }

  private createCursor(
    subscriptionId: string,
    sessionId: SessionId,
    fromNodeId: EventId | undefined,
    position: number,
  ): EventCursor {
    this.pruneCursors();
    while (this.cursors.size >= MAX_EVENT_CURSORS) {
      const oldest = this.cursors.keys().next().value as EventCursor | undefined;
      if (oldest === undefined) break;
      this.cursors.delete(oldest);
    }
    const cursor = randomUUID();
    this.cursors.set(cursor, {
      subscriptionId,
      sessionId,
      ...(fromNodeId === undefined ? {} : { fromNodeId }),
      position,
      expiresAt: Date.now() + this.cursorLifetimeMs,
      acknowledged: false,
    });
    return cursor;
  }

  private pruneCursors(now = Date.now()): void {
    for (const [cursor, record] of this.cursors) {
      if (record.expiresAt <= now) this.cursors.delete(cursor);
    }
  }

  private releaseSubscriptionCursors(
    subscription: ConnectionSubscription,
    preserveAcknowledged: boolean,
  ): void {
    this.pruneCursors();
    for (const [cursor, record] of this.cursors) {
      if (
        record.subscriptionId === subscription.id &&
        (!preserveAcknowledged || cursor !== subscription.acknowledgedCursor)
      ) {
        this.cursors.delete(cursor);
      }
    }
  }

  private bufferSnapshotActivity(
    subscription: ConnectionSubscription,
    frame: SessionActivityFrame,
  ): void {
    if (subscription.invalidated) return;
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    if (
      subscription.bufferedActivity.length >= MAX_SNAPSHOT_TAIL_EVENTS ||
      subscription.bufferedEventBytes + bytes > MAX_SNAPSHOT_TAIL_BYTES
    ) {
      this.invalidateSnapshot(subscription);
      return;
    }
    subscription.bufferedActivity.push(frame);
    subscription.bufferedEventBytes += bytes;
  }

  private bufferSnapshotEvent(
    subscription: ConnectionSubscription,
    event: CanonicalEvent,
    position: number,
  ): void {
    if (subscription.invalidated) return;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (
      subscription.bufferedEvents.length >= MAX_SNAPSHOT_TAIL_EVENTS ||
      subscription.bufferedEventBytes + bytes > MAX_SNAPSHOT_TAIL_BYTES
    ) {
      this.invalidateSnapshot(subscription);
      return;
    }
    subscription.bufferedEvents.push({ event, position });
    subscription.bufferedEventBytes += bytes;
  }

  private assertSnapshotAvailable(subscription: ConnectionSubscription): void {
    const now = Date.now();
    if (
      subscription.invalidated ||
      (!subscription.active &&
        (now - subscription.lastAccessAt > this.snapshotIdleLifetimeMs ||
          now - subscription.createdAt > this.snapshotAbsoluteLifetimeMs))
    ) {
      this.invalidateSnapshot(subscription);
      throw new DaemonError("snapshot_required", "The snapshot is no longer available");
    }
  }

  private invalidateSnapshot(subscription: ConnectionSubscription): void {
    subscription.invalidated = true;
    this.releaseSubscriptionCursors(subscription, false);
    subscription.bufferedEvents.length = 0;
    subscription.bufferedActivity.length = 0;
    subscription.bufferedEventBytes = 0;
    subscription.unsubscribe();
  }

  private deliverEvent(
    subscription: ConnectionSubscription,
    event: CanonicalEvent,
    position: number,
    send: (message: ServerMessage) => void,
  ): void {
    subscription.sequence += 1;
    send({
      kind: "event",
      subscriptionId: subscription.id,
      sessionId: subscription.sessionId,
      sequence: subscription.sequence,
      cursor: this.createCursor(
        subscription.id,
        subscription.sessionId,
        subscription.fromNodeId,
        position,
      ),
      event,
    });
  }

  private activateReadySubscriptions(
    state: ConnectionState,
    send: (message: ServerMessage) => void,
  ): void {
    for (const subscription of state.subscriptions.values()) {
      if (!subscription.activateAfterResponse || subscription.active || subscription.invalidated) {
        continue;
      }
      subscription.activateAfterResponse = false;
      subscription.active = true;
      for (const buffered of subscription.bufferedEvents) {
        this.deliverEvent(subscription, buffered.event, buffered.position, send);
      }
      subscription.bufferedEvents.length = 0;
      subscription.bufferedEventBytes = 0;
      for (const frame of subscription.bufferedActivity) {
        send({
          kind: "activity",
          subscriptionId: subscription.id,
          sessionId: subscription.sessionId,
          frame,
        });
      }
      subscription.bufferedActivity.length = 0;
    }
  }

  private publishPresence(): void {
    const attachments: AttachmentPresence[] = [];
    for (const state of this.connectionStates) {
      if (
        !state.initialized ||
        state.attachmentId === undefined ||
        state.client === undefined ||
        state.connectedAt === undefined ||
        state.lastSeenAt === undefined
      ) {
        continue;
      }
      attachments.push({
        attachmentId: state.attachmentId,
        clientKind: state.client.kind,
        connectedAt: state.connectedAt,
        lastSeenAt: state.lastSeenAt,
        subscribedSessionIds: [
          ...new Set(
            [...state.subscriptions.values()].map((subscription) => subscription.sessionId),
          ),
        ],
        scope: "local_control",
      });
    }
    attachments.sort((left, right) => left.attachmentId.localeCompare(right.attachmentId));
    for (const state of this.connectionStates) {
      if (state.initialized && state.grantedCapabilities.has("session.presence")) {
        state.send({ kind: "presence", attachments });
      }
    }
  }

  private async removeOwnedSocket(): Promise<void> {
    const identity = this.socketIdentity;
    this.socketIdentity = undefined;
    if (!identity) return;
    try {
      const current = await lstat(this.socketPath);
      if (current.isSocket() && current.dev === identity.dev && current.ino === identity.ino) {
        await unlink(this.socketPath);
      }
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }
}
