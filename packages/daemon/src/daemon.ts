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
  type ClientIdentity,
  type EventCursor,
  type EventId,
  encodeWireMessage,
  hashCanonicalRequest,
  isRetryableMutationMethod,
  parseOperationId,
  ProtocolValidationError,
  parseRpcResult,
  parseSessionId,
  parseWireRequest,
  requiredCapability,
  type ServerMessage,
  type SessionActivityFrame,
  type SessionId,
  type SnapshotPage,
  type RetryableMutationMethod,
  WIRE_CAPABILITIES,
  WIRE_PROTOCOL_VERSION,
  type WireRequest,
} from "@axl/protocol";

import { type CommandAcceptance, CommandJournal, CommandJournalError } from "./command-journal.ts";
import { DaemonError, SessionManager, type SessionManagerOptions } from "./session-manager.ts";

export type DaemonSecurityMode = "sandboxed" | "unsafe";

export interface DaemonOptions extends SessionManagerOptions {
  readonly socketPath: string;
  readonly securityMode?: DaemonSecurityMode;
  readonly sandboxProvider?: string;
  readonly sandboxImage?: string;
}

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_PENDING_REQUESTS = 64;
const MAX_ATTACHMENTS = 256;
const MAX_SNAPSHOT_PAGE_BYTES = 768 * 1024;
const MAX_SNAPSHOT_PAGE_EVENTS = 5_000;
const MAX_SNAPSHOT_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_TAIL_EVENTS = 1_024;
const HEARTBEAT_INTERVAL_MS = 20_000;
const PRESENCE_TIMEOUT_MS = 60_000;
const SOCKET_PROBE_TIMEOUT_MS = 500;

interface CursorRecord {
  readonly subscriptionId: string;
  readonly sessionId: SessionId;
  readonly fromNodeId?: EventId;
  readonly position: number;
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
}

interface ConnectionState {
  initialized: boolean;
  attachmentId?: string;
  client?: ClientIdentity;
  connectedAt?: number;
  lastSeenAt?: number;
  grantedCapabilities: ReadonlySet<string>;
  pendingRequests: number;
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
  private readonly daemonInstanceId = randomUUID();
  private commandJournal: CommandJournal | undefined;
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
  }

  async start(): Promise<void> {
    if (this.server) throw new DaemonError("already_started", "Daemon already started");
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
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await removeStaleSocket(this.socketPath);

    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    try {
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
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      this.server = undefined;
      await this.removeOwnedSocket();
      throw error;
    }
  }

  async stop(): Promise<void> {
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    const server = this.server;
    this.server = undefined;
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await this.sessions.disposeAll();
    await this.removeOwnedSocket();
  }

  private accept(socket: Socket): void {
    this.connections.add(socket);
    const send = (message: ServerMessage): void => {
      if (!socket.destroyed) socket.write(encodeWireMessage(message));
    };
    const state: ConnectionState = {
      initialized: false,
      grantedCapabilities: new Set(),
      pendingRequests: 0,
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
        maxMessageBytes: MAX_REQUEST_BYTES,
        maxPendingRequests: MAX_PENDING_REQUESTS,
      },
    });

    let buffer = "";
    const decoder = new StringDecoder("utf8");
    socket.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES && !buffer.includes("\n")) {
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
        if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) {
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
            send({
              kind: "error",
              id: -1,
              error: {
                code: "rate_limited",
                message: "Too many pending requests",
                retryable: true,
              },
            });
            continue;
          }
          state.pendingRequests += 1;
          void this.handleLine(line, send, state).finally(() => {
            state.pendingRequests -= 1;
          });
        }
      }
    });
    const presenceTimer = setInterval(() => {
      if (state.lastSeenAt !== undefined && Date.now() - state.lastSeenAt > PRESENCE_TIMEOUT_MS) {
        socket.destroy();
      }
    }, HEARTBEAT_INTERVAL_MS);
    presenceTimer.unref();
    const cleanup = (): void => {
      clearInterval(presenceTimer);
      for (const subscription of state.subscriptions.values()) subscription.unsubscribe();
      state.subscriptions.clear();
      this.connections.delete(socket);
      this.connectionStates.delete(state);
      this.publishPresence();
    };
    socket.once("close", cleanup);
    socket.once("error", () => socket.destroy());
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
      send({
        kind: "error",
        id,
        error: {
          code:
            error instanceof ProtocolValidationError && error.path === "request.idempotencyKey"
              ? "invalid_idempotency_key"
              : "bad_request",
          message: error instanceof Error ? error.message : "Invalid request",
          retryable: false,
        },
      });
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
          "connection_not_initialized",
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
      const result = parseRpcResult(
        request.method,
        await this.executeRequest(request, send, state),
      );
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
      send({
        kind: "error",
        id: request.id,
        method: request.method,
        error: {
          code:
            error instanceof DaemonError || error instanceof CommandJournalError
              ? error.code
              : "internal_error",
          message: error instanceof Error ? error.message : "Request failed",
          retryable: error instanceof CommandJournalError ? error.retryable : false,
          ...(error instanceof CommandJournalError && error.details !== undefined
            ? { details: error.details }
            : {}),
        },
      });
    }
  }

  private async executeRequest(
    request: WireRequest,
    send: (message: ServerMessage) => void,
    state: ConnectionState,
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
      normalized = { ...request, params: { ...request.params, cwd } };
    }
    if (!isRetryableMutationMethod(normalized.method)) {
      return this.dispatch(normalized, send, state);
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
          heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
          presenceTimeoutMs: PRESENCE_TIMEOUT_MS,
        };
      }
      case "connection.ping":
        return {};
      case "session.create": {
        const { cwd, modelId, thinkingLevel } = request.params;
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
        return this.sessions.list();
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
      case "session.shell":
        return this.sessions.shell(
          request.params.sessionId,
          request.params.command,
          request.params.excluded,
        );
      case "session.interrupt":
        return this.sessions.interrupt(request.params.sessionId);
      case "session.reload":
        return this.sessions.reload(request.params.sessionId, this.mutationOperationId(acceptance));
      case "session.configure": {
        const { sessionId, modelId, thinkingLevel } = request.params;
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
        await this.sessions.respondToInteraction(
          sessionId,
          interactionId,
          {
            action,
            ...(content === undefined ? {} : { content }),
          },
          this.mutationOperationId(acceptance),
        );
        return { resolved: true };
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
      case "session.workspace.checkpoint":
        return this.sessions.setWorkspaceCheckpoints(
          request.params.sessionId,
          request.params.enabled,
        );
      case "session.workspace.diff":
        return this.sessions.workspaceDiff(request.params.sessionId, request.params.scope);
      case "session.dispose":
        await this.sessions.dispose(request.params.sessionId, this.mutationOperationId(acceptance));
        return { disposed: true };
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
    }

    const snapshotId = resumedPosition === undefined ? randomUUID() : undefined;
    const boundaryCursor =
      resumedPosition === undefined
        ? this.createCursor(subscriptionId, params.sessionId, params.fromNodeId, boundaryPosition)
        : undefined;
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
    if (subscription.invalidated) {
      throw new DaemonError("snapshot_required", "The snapshot tail exceeded its delivery limit");
    }
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
    if (subscription.invalidated) {
      throw new DaemonError("snapshot_required", "The snapshot tail exceeded its delivery limit");
    }
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
    const cursor = randomUUID();
    this.cursors.set(cursor, {
      subscriptionId,
      sessionId,
      ...(fromNodeId === undefined ? {} : { fromNodeId }),
      position,
      acknowledged: false,
    });
    return cursor;
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

  private invalidateSnapshot(subscription: ConnectionSubscription): void {
    subscription.invalidated = true;
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
