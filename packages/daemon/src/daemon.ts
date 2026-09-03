// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  type CanonicalEvent,
  encodeWireMessage,
  parseRpcResult,
  parseWireRequest,
  requiredCapability,
  type ServerMessage,
  type SessionActivityFrame,
  WIRE_CAPABILITIES,
  WIRE_PROTOCOL_VERSION,
  type WireRequest,
} from "@axl/protocol";

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
const HEARTBEAT_INTERVAL_MS = 20_000;
const PRESENCE_TIMEOUT_MS = 60_000;
const SOCKET_PROBE_TIMEOUT_MS = 500;

interface ConnectionState {
  initialized: boolean;
  attachmentId?: string;
  grantedCapabilities: ReadonlySet<string>;
  pendingRequests: number;
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
  private readonly daemonInstanceId = randomUUID();
  private server: Server | undefined;
  private socketIdentity: SocketIdentity | undefined;
  private readonly connections = new Set<Socket>();

  constructor(options: DaemonOptions) {
    this.sessions = new SessionManager(options);
    this.socketPath = options.socketPath;
    this.securityMode = options.securityMode ?? "sandboxed";
    this.sandboxProvider = options.sandboxProvider ?? "unknown";
    this.sandboxImage = options.sandboxImage;
  }

  async start(): Promise<void> {
    if (this.server) throw new DaemonError("already_started", "Daemon already started");
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
    const subscriptions = new Set<() => void>();
    const state: ConnectionState = {
      initialized: false,
      grantedCapabilities: new Set(),
      pendingRequests: 0,
    };
    const send = (message: ServerMessage): void => {
      if (!socket.destroyed) socket.write(encodeWireMessage(message));
    };
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
          void this.handleLine(line, send, subscriptions, state).finally(() => {
            state.pendingRequests -= 1;
          });
        }
      }
    });
    const cleanup = (): void => {
      for (const unsubscribe of subscriptions) unsubscribe();
      subscriptions.clear();
      this.connections.delete(socket);
    };
    socket.once("close", cleanup);
    socket.once("error", () => socket.destroy());
  }

  private async handleLine(
    line: string,
    send: (message: ServerMessage) => void,
    subscriptions: Set<() => void>,
    state: ConnectionState,
  ): Promise<void> {
    let request: WireRequest;
    try {
      request = parseWireRequest(JSON.parse(line) as unknown);
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
        state.initialized = true;
        state.attachmentId = randomUUID();
        state.grantedCapabilities = new Set(
          request.params.requestedCapabilities.filter((capability) =>
            WIRE_CAPABILITIES.includes(capability as (typeof WIRE_CAPABILITIES)[number]),
          ),
        );
      } else {
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
        await this.dispatch(request, send, subscriptions, state),
      );
      send({
        kind: "success",
        id: request.id,
        method: request.method,
        result,
      } as ServerMessage);
    } catch (error) {
      send({
        kind: "error",
        id: request.id,
        method: request.method,
        error: {
          code: error instanceof DaemonError ? error.code : "internal_error",
          message: error instanceof Error ? error.message : "Request failed",
          retryable: false,
        },
      });
    }
  }

  private async dispatch(
    request: WireRequest,
    send: (message: ServerMessage) => void,
    subscriptions: Set<() => void>,
    state: ConnectionState,
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
        const { cwd, modelId, thinkingLevel, webFetch, webSearch, profile } = request.params;
        return this.sessions.create(cwd, {
          ...(modelId === undefined ? {} : { modelId }),
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
          ...(webFetch === undefined ? {} : { webFetch }),
          ...(webSearch === undefined ? {} : { webSearch }),
          ...(profile === undefined ? {} : { profile }),
        });
      }
      case "session.resume": {
        const snapshot = await this.sessions.resume(request.params.sessionId);
        return request.params.includeEvents === false
          ? { sessionId: snapshot.sessionId, events: [] }
          : snapshot;
      }
      case "session.list":
        return this.sessions.list();
      case "session.history":
        return this.sessions.history(
          request.params.sessionId,
          request.params.afterEventId,
          request.params.limit,
        );
      case "session.fork":
        return this.sessions.fork(request.params.sessionId, request.params.fromEventId);
      case "session.clone":
        return this.sessions.clone(request.params.sessionId);
      case "session.send":
        return this.sessions.send(request.params.sessionId, request.params.content);
      case "session.steer":
        return this.sessions.steer(request.params.sessionId, request.params.content);
      case "session.followUp":
        return this.sessions.followUp(request.params.sessionId, request.params.content);
      case "session.compact":
        return this.sessions.compact(request.params.sessionId, request.params.instructions);
      case "session.shell":
        return this.sessions.shell(
          request.params.sessionId,
          request.params.command,
          request.params.excluded,
        );
      case "session.interrupt":
        return this.sessions.interrupt(request.params.sessionId);
      case "session.reload":
        return this.sessions.reload(request.params.sessionId);
      case "session.configure": {
        const { sessionId, modelId, thinkingLevel, webFetch, webSearch } = request.params;
        return this.sessions.configure(sessionId, {
          ...(modelId === undefined ? {} : { modelId }),
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
          ...(webFetch === undefined ? {} : { webFetch }),
          ...(webSearch === undefined ? {} : { webSearch }),
        });
      }
      case "session.interaction.respond": {
        const { sessionId, interactionId, action, content } = request.params;
        await this.sessions.respondToInteraction(sessionId, interactionId, {
          action,
          ...(content === undefined ? {} : { content }),
        });
        return { resolved: true };
      }
      case "session.subscribe": {
        const { sessionId, afterEventId } = request.params;
        const listener = (event: CanonicalEvent): void => send({ kind: "event", sessionId, event });
        const activityListener = (frame: SessionActivityFrame): void =>
          send({ kind: "activity", sessionId, frame });
        const subscription = this.sessions.subscribe(
          sessionId,
          listener,
          afterEventId,
          activityListener,
        );
        subscriptions.add(subscription.unsubscribe);
        return {
          snapshot: subscription.snapshot,
          ...(subscription.activity === undefined ? {} : { activity: subscription.activity }),
        };
      }
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
        await this.sessions.dispose(request.params.sessionId);
        return { disposed: true };
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
