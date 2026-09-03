// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import {
  encodeWireMessage,
  isRetryableMutationMethod,
  parseServerMessage,
  parseWireRequest,
  requiredCapability,
  WIRE_PROTOCOL_VERSION,
  type CapabilityId,
  type ClientIdentity,
  type ConnectionInitializeResult,
  type OperationId,
  type PresenceDelivery,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type ServerMessage,
  type SessionId,
  type WireActivity,
  type WireEvent,
} from "@axl/protocol";

export type ConnectionState =
  | "connecting"
  | "negotiating"
  | "loading_snapshot"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "incompatible";

export interface CredentialProvider<Credential = unknown> {
  acquire(): Promise<Credential | undefined>;
}

export interface AxlTransport {
  send(message: string): Promise<void> | void;
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: (cause?: Error) => void): () => void;
  close(): void;
}

export interface AxlTransportFactory<Credential = unknown> {
  connect(credential: Credential | undefined): Promise<AxlTransport>;
}

export interface IdempotencyKeyFactory {
  create(): string;
}

export interface CursorStore {
  load(key: string): Promise<string | undefined>;
  save(key: string, cursor: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RequestOptions {
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export class AxlClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: string,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly retryable?: boolean;
      readonly details?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AxlClientError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export interface AxlClientOptions<Credential = unknown> {
  readonly transport: AxlTransportFactory<Credential>;
  readonly identity: ClientIdentity;
  readonly idempotencyKeys: IdempotencyKeyFactory;
  readonly credentials?: CredentialProvider<Credential>;
  readonly requestedCapabilities?: readonly CapabilityId[];
  readonly handshakeTimeoutMs?: number;
}

type Pending = {
  readonly method: RpcMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
};

/** Typed protocol client. It owns connection mechanics, never session behavior. */
export class AxlClient {
  private readonly options: AxlClientOptions<unknown>;
  private transport: AxlTransport | undefined;
  private removeMessageListener: (() => void) | undefined;
  private removeCloseListener: (() => void) | undefined;
  private nextId = 1;
  private helloReceived = false;
  private initialized: ConnectionInitializeResult | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Set<(event: WireEvent) => void>();
  private readonly activityListeners = new Set<(event: WireActivity) => void>();
  private readonly presenceListeners = new Set<(presence: PresenceDelivery) => void>();
  private readonly disconnectListeners = new Set<(error: Error) => void>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private latestPresence: PresenceDelivery | undefined;
  private readonly shellResults = new Map<OperationId, RpcResult<"session.shell">>();
  private currentState: ConnectionState = "disconnected";
  private handshake:
    | { readonly resolve: () => void; readonly reject: (error: Error) => void }
    | undefined;
  private deliberatelyClosed = false;
  private reconnectPromise: Promise<void> | undefined;

  private constructor(options: AxlClientOptions<unknown>) {
    this.options = options;
  }

  static async connect<Credential>(options: AxlClientOptions<Credential>): Promise<AxlClient> {
    const client = new AxlClient(options as AxlClientOptions<unknown>);
    await client.open("connecting");
    return client;
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  get connection(): ConnectionInitializeResult {
    if (this.initialized === undefined) {
      throw new AxlClientError("connection_not_initialized", "Connection is not initialized");
    }
    return this.initialized;
  }

  async reconnect(): Promise<void> {
    if (this.deliberatelyClosed) {
      throw new AxlClientError("disconnected", "Client was closed");
    }
    if (this.reconnectPromise !== undefined) return this.reconnectPromise;
    const reconnect = (async () => {
      const previousCapabilities = this.initialized?.grantedCapabilities ?? [];
      this.detachTransport();
      this.initialized = undefined;
      this.helloReceived = false;
      this.latestPresence = undefined;
      await this.open("reconnecting");
      const removedCapabilities = previousCapabilities.filter(
        (capability) => !this.connection.grantedCapabilities.includes(capability),
      );
      if (removedCapabilities.length > 0) {
        const error = new AxlClientError(
          "capability_mismatch",
          `Daemon removed required capabilities during reconnect: ${removedCapabilities.join(", ")}`,
          { details: { removedCapabilities } },
        );
        this.initialized = undefined;
        this.setState("incompatible");
        this.fail(error, false);
        throw error;
      }
    })();
    this.reconnectPromise = reconnect;
    try {
      await reconnect;
    } finally {
      if (this.reconnectPromise === reconnect) this.reconnectPromise = undefined;
    }
  }

  request<Method extends RpcMethod>(
    method: Method,
    params: RpcParams<Method>,
    options: RequestOptions = {},
  ): Promise<RpcResult<Method>> {
    if (this.initialized === undefined && method !== "connection.initialize") {
      return Promise.reject(
        new AxlClientError("connection_not_initialized", "Connection is not initialized"),
      );
    }
    const idempotencyKey = isRetryableMutationMethod(method)
      ? (options.idempotencyKey ?? this.options.idempotencyKeys.create())
      : options.idempotencyKey;
    const attempt = () =>
      this.sendRequest(method, params, {
        ...options,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });
    return attempt().catch(async (error: unknown) => {
      if (
        !isRetryableMutationMethod(method) ||
        !(error instanceof AxlClientError) ||
        !["disconnected", "write_failed"].includes(error.code) ||
        this.deliberatelyClosed
      ) {
        throw error;
      }
      await this.reconnect();
      return attempt();
    });
  }

  async shell(
    params: RpcParams<"session.shell">,
    options: Omit<RequestOptions, "idempotencyKey"> = {},
  ): Promise<
    | { readonly state: "completed"; readonly result: RpcResult<"session.shell"> }
    | { readonly state: "uncertain"; readonly operationId: OperationId }
  > {
    try {
      const result = await this.request("session.shell", params, options);
      return { state: "completed", result };
    } catch (error) {
      if (
        error instanceof AxlClientError &&
        ["disconnected", "write_failed"].includes(error.code)
      ) {
        const recorded = this.shellResults.get(params.operationId);
        return recorded === undefined
          ? { state: "uncertain", operationId: params.operationId }
          : { state: "completed", result: recorded };
      }
      throw error;
    }
  }

  onEvent(listener: (event: WireEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onActivity(listener: (event: WireActivity) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  onPresence(listener: (presence: PresenceDelivery) => void): () => void {
    this.presenceListeners.add(listener);
    if (this.latestPresence !== undefined) listener(this.latestPresence);
    return () => this.presenceListeners.delete(listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.currentState);
    return () => this.stateListeners.delete(listener);
  }

  async loadingSnapshot<Result>(load: () => Promise<Result>): Promise<Result> {
    if (this.currentState === "connected") this.setState("loading_snapshot");
    try {
      return await load();
    } finally {
      if (this.currentState === "loading_snapshot") this.setState("connected");
    }
  }

  close(): void {
    this.deliberatelyClosed = true;
    this.fail(new AxlClientError("disconnected", "Client closed"), false);
  }

  private async open(state: "connecting" | "reconnecting"): Promise<void> {
    this.setState(state);
    let transport: AxlTransport;
    try {
      const credential = await this.options.credentials?.acquire();
      transport = await this.options.transport.connect(credential);
    } catch (cause) {
      this.setState("disconnected");
      throw new AxlClientError("connection_error", "Could not connect to the daemon", { cause });
    }
    this.transport = transport;
    const ready = new Promise<void>((resolve, reject) => {
      this.handshake = { resolve, reject };
    });
    this.removeMessageListener = transport.onMessage((message) => this.receive(message));
    this.removeCloseListener = transport.onClose((cause) =>
      this.fail(new AxlClientError("disconnected", "Daemon connection closed", { cause }), true),
    );
    const timeout = setTimeout(
      () => this.fail(new AxlClientError("handshake_timeout", "Daemon did not initialize"), true),
      this.options.handshakeTimeoutMs ?? 5_000,
    );
    try {
      await ready;
    } finally {
      clearTimeout(timeout);
    }
  }

  private sendRequest<Method extends RpcMethod>(
    method: Method,
    params: RpcParams<Method>,
    options: RequestOptions,
  ): Promise<RpcResult<Method>> {
    if (options.signal?.aborted) {
      return Promise.reject(new AxlClientError("cancelled", "Request was cancelled"));
    }
    const transport = this.transport;
    if (transport === undefined) {
      return Promise.reject(new AxlClientError("disconnected", "Daemon connection is closed"));
    }
    const id = this.nextId++;
    const idempotencyKey = options.idempotencyKey;
    let request: ReturnType<typeof parseWireRequest>;
    try {
      request = parseWireRequest({
        kind: "request",
        id,
        method,
        params,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });
    } catch (cause) {
      return Promise.reject(new AxlClientError("bad_request", "Invalid request", { cause }));
    }
    const capability =
      method === "session.send"
        ? (`session.send.${(params as RpcParams<"session.send">).delivery}` as CapabilityId)
        : requiredCapability(method);
    if (
      this.initialized !== undefined &&
      capability !== undefined &&
      !this.initialized.grantedCapabilities.includes(capability)
    ) {
      return Promise.reject(
        new AxlClientError(
          "unsupported_capability",
          `Connection was not granted capability ${capability}`,
        ),
      );
    }
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
    let removeAbort: (() => void) | undefined;
    if (options.signal !== undefined) {
      const abort = () => {
        if (!this.pending.has(id)) return;
        void this.sendRequest("request.cancel", { requestId: id }, {}).catch(() => undefined);
      };
      options.signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => options.signal?.removeEventListener("abort", abort);
    }
    Promise.resolve(transport.send(encodeWireMessage(request))).catch((cause: unknown) => {
      this.rejectRequest(
        id,
        new AxlClientError("write_failed", "Could not write to daemon", { cause }),
      );
    });
    return response.finally(removeAbort) as Promise<RpcResult<Method>>;
  }

  private receive(value: unknown): void {
    let message: ServerMessage;
    try {
      message = parseServerMessage(value);
    } catch (cause) {
      this.fail(new AxlClientError("protocol_error", "Daemon sent an invalid message", { cause }));
      return;
    }
    if (!this.helloReceived) {
      if (message.kind !== "hello") {
        this.fail(new AxlClientError("protocol_error", "Daemon did not send hello first"));
        return;
      }
      if (message.wireVersion !== WIRE_PROTOCOL_VERSION) {
        this.setState("incompatible");
        this.fail(
          new AxlClientError(
            "version_mismatch",
            `Daemon speaks wire version ${message.wireVersion}, client requires ${WIRE_PROTOCOL_VERSION}`,
          ),
          false,
        );
        return;
      }
      this.helloReceived = true;
      this.setState("negotiating");
      const requested = this.options.requestedCapabilities ?? message.capabilities;
      void this.sendRequest(
        "connection.initialize",
        { client: this.options.identity, requestedCapabilities: requested },
        {},
      ).then(
        (initialized) => {
          if (
            initialized.wireVersion !== WIRE_PROTOCOL_VERSION ||
            initialized.daemonInstanceId !== message.daemonInstanceId ||
            initialized.grantedCapabilities.some(
              (capability) =>
                !message.capabilities.includes(capability) || !requested.includes(capability),
            )
          ) {
            this.fail(
              new AxlClientError("protocol_error", "Initialization did not match daemon hello"),
            );
            return;
          }
          this.initialized = initialized;
          this.startHeartbeat(initialized.heartbeatIntervalMs);
          this.setState("connected");
          this.handshake?.resolve();
          this.handshake = undefined;
        },
        (error: unknown) =>
          this.fail(
            error instanceof Error
              ? error
              : new AxlClientError("protocol_error", "Daemon initialization failed"),
          ),
      );
      return;
    }
    if (message.kind === "hello") {
      this.fail(new AxlClientError("protocol_error", "Daemon sent a second hello"));
    } else if (message.kind === "success") {
      const pending = this.pending.get(message.id);
      if (pending === undefined || pending.method !== message.method) {
        this.fail(new AxlClientError("protocol_error", "Daemon response did not match request"));
        return;
      }
      this.pending.delete(message.id);
      pending.resolve(message.result);
    } else if (message.kind === "error") {
      const pending = this.pending.get(message.id);
      if (message.id !== -1 && pending === undefined) {
        this.fail(new AxlClientError("protocol_error", "Daemon rejected an unknown request"));
        return;
      }
      const error = new AxlClientError(message.error.code, message.error.message, {
        retryable: message.error.retryable,
        ...(message.error.details === undefined ? {} : { details: message.error.details }),
      });
      if (message.id === -1) this.fail(error);
      else this.rejectRequest(message.id, error);
    } else if (message.kind === "event") {
      if (message.event.type === "user.shell" && message.event.operationId !== undefined) {
        this.shellResults.set(message.event.operationId, {
          operationId: message.event.operationId,
          isError: message.event.payload.isError,
          resultEventId: message.event.id,
        });
      }
      for (const listener of this.eventListeners) listener(message);
    } else if (message.kind === "activity") {
      for (const listener of this.activityListeners) listener(message);
    } else if (message.kind === "presence") {
      if (
        this.initialized !== undefined &&
        !this.initialized.grantedCapabilities.includes("session.presence")
      ) {
        this.fail(
          new AxlClientError(
            "protocol_error",
            "Daemon sent presence without granting the capability",
          ),
        );
        return;
      }
      this.latestPresence = message;
      for (const listener of this.presenceListeners) listener(message);
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      void this.sendRequest("connection.ping", {}, {}).catch((error: unknown) =>
        this.fail(
          error instanceof Error
            ? error
            : new AxlClientError("connection_error", "Daemon heartbeat failed"),
        ),
      );
    }, intervalMs);
    const timer = this.heartbeatTimer as ReturnType<typeof setInterval> & { unref?: () => void };
    timer.unref?.();
  }

  private rejectRequest(id: number, error: Error): void {
    this.pending.get(id)?.reject(error);
    this.pending.delete(id);
  }

  private fail(error: Error, notify = true): void {
    this.handshake?.reject(error);
    this.handshake = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.detachTransport();
    if (this.currentState !== "incompatible") this.setState("disconnected");
    if (notify) for (const listener of this.disconnectListeners) listener(error);
  }

  private detachTransport(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.removeMessageListener?.();
    this.removeCloseListener?.();
    this.removeMessageListener = undefined;
    this.removeCloseListener = undefined;
    const transport = this.transport;
    this.transport = undefined;
    transport?.close();
  }

  private setState(state: ConnectionState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    for (const listener of this.stateListeners) listener(state);
  }
}

export function cursorStoreKey(
  daemonInstanceId: string,
  sessionId: SessionId,
  fromNodeId?: string,
): string {
  return `${daemonInstanceId}:${sessionId}:${fromNodeId ?? "tip"}`;
}
