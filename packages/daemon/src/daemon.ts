// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import {
  type CanonicalEvent,
  encodeWireMessage,
  parseWireRequest,
  type ServerMessage,
  WIRE_PROTOCOL_VERSION,
  type WireRequest,
} from "@axl/protocol";

import { DaemonError, SessionManager, type SessionManagerOptions } from "./session-manager.ts";

export type DaemonSecurityMode = "sandboxed" | "unsafe";

export interface DaemonOptions extends SessionManagerOptions {
  readonly socketPath: string;
  readonly securityMode?: DaemonSecurityMode;
}

const MAX_REQUEST_BYTES = 1_048_576;
const SOCKET_PROBE_TIMEOUT_MS = 500;

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
  private server: Server | undefined;
  private socketIdentity: SocketIdentity | undefined;
  private readonly connections = new Set<Socket>();

  constructor(options: DaemonOptions) {
    this.sessions = new SessionManager(options);
    this.socketPath = options.socketPath;
    this.securityMode = options.securityMode ?? "sandboxed";
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
    const send = (message: ServerMessage): void => {
      if (!socket.destroyed) socket.write(encodeWireMessage(message));
    };
    send({ kind: "hello", wireVersion: WIRE_PROTOCOL_VERSION });

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES && !buffer.includes("\n")) {
        send({
          kind: "error",
          id: -1,
          code: "frame_too_large",
          message: "Request exceeded the size limit",
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
            code: "frame_too_large",
            message: "Request exceeded the size limit",
          });
          socket.destroy();
          return;
        }
        if (line.trim()) void this.handleLine(line, send, subscriptions);
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
  ): Promise<void> {
    let request: WireRequest;
    try {
      request = parseWireRequest(JSON.parse(line) as unknown);
    } catch (error) {
      send({
        kind: "error",
        id: -1,
        code: "bad_request",
        message: error instanceof Error ? error.message : "Undecodable request",
      });
      return;
    }
    try {
      send({
        kind: "response",
        id: request.id,
        result: await this.dispatch(request, send, subscriptions),
      });
    } catch (error) {
      send({
        kind: "error",
        id: request.id,
        code: error instanceof DaemonError ? error.code : "internal_error",
        message: error instanceof Error ? error.message : "Request failed",
      });
    }
  }

  private async dispatch(
    request: WireRequest,
    send: (message: ServerMessage) => void,
    subscriptions: Set<() => void>,
  ): Promise<unknown> {
    switch (request.method) {
      case "daemon.info":
        return { securityMode: this.securityMode };
      case "session.create": {
        const { cwd, modelId, thinkingLevel } = request.params;
        return this.sessions.create(cwd, {
          ...(modelId === undefined ? {} : { modelId }),
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        });
      }
      case "session.resume":
        return this.sessions.resume(request.params.sessionId);
      case "session.list":
        return this.sessions.list();
      case "session.fork":
        return this.sessions.fork(request.params.sessionId, request.params.fromEventId);
      case "session.clone":
        return this.sessions.clone(request.params.sessionId);
      case "session.send":
        return this.sessions.send(request.params.sessionId, request.params.content);
      case "session.interrupt":
        return this.sessions.interrupt(request.params.sessionId);
      case "session.reload":
        return this.sessions.reload(request.params.sessionId);
      case "session.configure": {
        const { sessionId, modelId, thinkingLevel } = request.params;
        return this.sessions.configure(sessionId, {
          ...(modelId === undefined ? {} : { modelId }),
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
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
        const subscription = this.sessions.subscribe(sessionId, listener, afterEventId);
        subscriptions.add(subscription.unsubscribe);
        return { snapshot: subscription.snapshot };
      }
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
