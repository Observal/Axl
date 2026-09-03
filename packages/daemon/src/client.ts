// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";

import {
  encodeWireMessage,
  parseServerMessage,
  parseWireRequest,
  requiredCapability,
  WIRE_PROTOCOL_VERSION,
  type CapabilityId,
  type ClientIdentity,
  type ConnectionInitializeResult,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type WireActivity,
  type WireEvent,
} from "@axl/protocol";

export class WireClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: string,
    message: string,
    options?: {
      cause?: unknown;
      retryable?: boolean;
      details?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(message, options);
    this.name = "WireClientError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }
}

const MAX_LINE_BYTES = 1_048_576;
const HANDSHAKE_TIMEOUT_MS = 5_000;

/** Thin local client. Session state and the agent loop remain in the daemon. */
export class DaemonClient {
  private readonly socket: Socket;
  private readonly identity: ClientIdentity;
  private readonly requestedCapabilities: readonly CapabilityId[] | undefined;
  private readonly ready: Promise<void>;
  private settleReady: ((error?: Error) => void) | undefined;
  private nextId = 1;
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private helloReceived = false;
  private closed = false;
  private initialized: ConnectionInitializeResult | undefined;
  private readonly pending = new Map<
    number,
    {
      readonly method: RpcMethod;
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  private readonly eventListeners = new Set<(event: WireEvent) => void>();
  private readonly activityListeners = new Set<(event: WireActivity) => void>();
  private readonly disconnectListeners = new Set<(error: Error) => void>();

  private constructor(
    socket: Socket,
    identity: ClientIdentity,
    requestedCapabilities: readonly CapabilityId[] | undefined,
  ) {
    this.socket = socket;
    this.identity = identity;
    this.requestedCapabilities = requestedCapabilities;
    this.ready = new Promise<void>((resolve, reject) => {
      this.settleReady = (error) => {
        this.settleReady = undefined;
        if (error) reject(error);
        else resolve();
      };
    });
    socket.on("data", (chunk) => this.receive(chunk));
    socket.once("error", (cause) =>
      this.fail(new WireClientError("connection_error", cause.message, { cause })),
    );
    socket.once("close", () =>
      this.fail(new WireClientError("disconnected", "Daemon connection closed")),
    );
  }

  static async connect(
    socketPath: string,
    options: {
      readonly identity?: ClientIdentity;
      readonly requestedCapabilities?: readonly CapabilityId[];
    } = {},
  ): Promise<DaemonClient> {
    const socket = connect(socketPath);
    const client = new DaemonClient(
      socket,
      options.identity ?? { kind: "tui", version: "0.0.0", instanceId: randomUUID() },
      options.requestedCapabilities,
    );
    const timeout = setTimeout(
      () =>
        client.fail(
          new WireClientError("handshake_timeout", "Daemon did not send a protocol hello"),
        ),
      HANDSHAKE_TIMEOUT_MS,
    );
    timeout.unref();
    try {
      await client.ready;
      return client;
    } finally {
      clearTimeout(timeout);
    }
  }

  request<Method extends RpcMethod>(
    method: Method,
    params: RpcParams<Method>,
  ): Promise<RpcResult<Method>>;
  request<Method extends RpcMethod>(
    method: Method,
    params: Record<string, unknown>,
  ): Promise<RpcResult<Method>>;
  request<Method extends RpcMethod>(
    method: Method,
    params: RpcParams<Method> | Record<string, unknown>,
  ): Promise<RpcResult<Method>> {
    return this.ready.then(() => this.sendRequest(method, params as RpcParams<Method>));
  }

  private sendRequest<Method extends RpcMethod>(
    method: Method,
    params: RpcParams<Method>,
  ): Promise<RpcResult<Method>> {
    if (this.closed)
      return Promise.reject(new WireClientError("disconnected", "Daemon connection is closed"));
    const id = this.nextId++;
    let request: ReturnType<typeof parseWireRequest>;
    try {
      request = parseWireRequest({ kind: "request", id, method, params });
    } catch (cause) {
      return Promise.reject(new WireClientError("bad_request", "Invalid request", { cause }));
    }
    const capability = requiredCapability(request.method);
    if (
      this.initialized !== undefined &&
      capability !== undefined &&
      !this.initialized.grantedCapabilities.includes(capability)
    ) {
      return Promise.reject(
        new WireClientError(
          "unsupported_capability",
          `Connection was not granted capability ${capability}`,
        ),
      );
    }
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
    try {
      this.socket.write(encodeWireMessage(request), (error) => {
        if (error) {
          this.rejectRequest(
            id,
            new WireClientError("write_failed", error.message, { cause: error }),
          );
        }
      });
    } catch (cause) {
      this.rejectRequest(
        id,
        new WireClientError("write_failed", "Could not write to daemon", { cause }),
      );
    }
    return response as Promise<RpcResult<Method>>;
  }

  get connection(): ConnectionInitializeResult {
    if (this.initialized === undefined) {
      throw new WireClientError("connection_not_initialized", "Connection is not initialized");
    }
    return this.initialized;
  }

  onEvent(listener: (event: WireEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onActivity(listener: (event: WireActivity) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  close(): void {
    if (!this.closed) this.socket.destroy();
  }

  private receive(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES && !this.buffer.includes("\n")) {
      this.fail(new WireClientError("frame_too_large", "Daemon message exceeded the size limit"));
      return;
    }
    for (
      let newline = this.buffer.indexOf("\n");
      newline !== -1;
      newline = this.buffer.indexOf("\n")
    ) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        this.fail(new WireClientError("frame_too_large", "Daemon message exceeded the size limit"));
        return;
      }
      if (line.trim()) {
        try {
          this.handleMessage(parseServerMessage(JSON.parse(line) as unknown));
        } catch (cause) {
          this.fail(
            new WireClientError("protocol_error", "Daemon sent an invalid message", { cause }),
          );
          return;
        }
      }
    }
  }

  private handleMessage(message: ReturnType<typeof parseServerMessage>): void {
    if (!this.helloReceived) {
      if (message.kind !== "hello") {
        this.fail(new WireClientError("protocol_error", "Daemon did not send hello first"));
      } else if (message.wireVersion !== WIRE_PROTOCOL_VERSION) {
        this.fail(
          new WireClientError(
            "version_mismatch",
            `Daemon speaks wire version ${message.wireVersion}, client requires ${WIRE_PROTOCOL_VERSION}`,
          ),
        );
      } else {
        this.helloReceived = true;
        const requestedCapabilities = this.requestedCapabilities ?? message.capabilities;
        void this.sendRequest("connection.initialize", {
          client: this.identity,
          requestedCapabilities,
        }).then(
          (initialized) => {
            if (
              initialized.wireVersion !== WIRE_PROTOCOL_VERSION ||
              initialized.daemonInstanceId !== message.daemonInstanceId ||
              initialized.grantedCapabilities.some(
                (capability) =>
                  !message.capabilities.includes(capability) ||
                  !requestedCapabilities.includes(capability),
              )
            ) {
              this.fail(
                new WireClientError(
                  "protocol_error",
                  "Daemon initialization did not match its hello",
                ),
              );
              return;
            }
            this.initialized = initialized;
            this.settleReady?.();
          },
          (error: unknown) =>
            this.fail(
              error instanceof Error
                ? error
                : new WireClientError("protocol_error", "Daemon initialization failed"),
            ),
        );
      }
      return;
    }
    if (message.kind === "hello") {
      this.fail(new WireClientError("protocol_error", "Daemon sent a second hello"));
    } else if (message.kind === "success") {
      const pending = this.pending.get(message.id);
      if (pending === undefined) {
        this.fail(
          new WireClientError("protocol_error", `Daemon answered unknown request ${message.id}`),
        );
        return;
      }
      if (pending.method !== message.method) {
        this.fail(
          new WireClientError(
            "protocol_error",
            `Daemon answered ${pending.method} request with ${message.method}`,
          ),
        );
        return;
      }
      this.pending.delete(message.id);
      pending.resolve(message.result);
    } else if (message.kind === "error") {
      const pending = this.pending.get(message.id);
      if (message.id !== -1 && pending === undefined) {
        this.fail(
          new WireClientError("protocol_error", `Daemon rejected unknown request ${message.id}`),
        );
        return;
      }
      if (
        pending !== undefined &&
        message.method !== undefined &&
        message.method !== pending.method
      ) {
        this.fail(
          new WireClientError(
            "protocol_error",
            `Daemon rejected ${pending.method} request as ${message.method}`,
          ),
        );
        return;
      }
      const error = new WireClientError(message.error.code, message.error.message, {
        retryable: message.error.retryable,
        ...(message.error.details === undefined ? {} : { details: message.error.details }),
      });
      if (message.id === -1) this.fail(error);
      else this.rejectRequest(message.id, error);
    } else if (message.kind === "event") {
      for (const listener of this.eventListeners) listener(message);
    } else {
      for (const listener of this.activityListeners) listener(message);
    }
  }

  private rejectRequest(id: number, error: Error): void {
    this.pending.get(id)?.reject(error);
    this.pending.delete(id);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.settleReady?.(error);
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    for (const listener of this.disconnectListeners) listener(error);
    this.disconnectListeners.clear();
    this.socket.destroy();
  }
}
