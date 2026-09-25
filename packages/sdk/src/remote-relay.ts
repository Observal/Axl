// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import {
  type CryptoSessionId,
  type DeviceId,
  decodeRemoteDaemonMessage,
  encodeBase64,
  encodeRelayBinaryFrame,
  type IssueRelayTicketRequest,
  type IssueRelayTicketResult,
  type OpaqueOutboxRecord,
  parseDeviceId,
  parseIssueRelayTicketRequest,
  parseIssueRelayTicketResult,
  parseRelayBinaryFrame,
  parseRelayDiscoveryMessage,
  REMOTE_TRANSPORT_VERSION,
  type RelayDelivery,
  type RelayFailure,
  type RelayPeerRoute,
  type RelayReceipt,
  type RemoteDaemonMessage,
  type RemoteDeliveryState,
  type RequestId,
  type RouteId,
  type TransportAttemptId,
} from "@axl/protocol";

import type { RemoteOutbox, TransportAttemptIdFactory } from "./remote-outbox.ts";

const MAX_ADMISSION_BYTES = 4_096;
const DEFAULT_ROUTE_WAIT_MS = 10_000;

export interface RelayAdmissionCredential extends IssueRelayTicketResult {
  readonly connectionNonce: string;
  readonly possessionProof: Uint8Array;
}

export interface RelayTicketProvider {
  acquire(): Promise<RelayAdmissionCredential>;
}

export interface RelayPossessionProofProvider {
  create(
    ticket: IssueRelayTicketResult,
  ): Promise<{ readonly connectionNonce: string; readonly possessionProof: Uint8Array }>;
}

export interface RemoteFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type RemoteFetch = (
  input: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  },
) => Promise<RemoteFetchResponse>;

export interface HttpRelayTicketProviderOptions {
  readonly controlPlaneOrigin: string;
  readonly request: IssueRelayTicketRequest;
  readonly authenticationHeaders: () => Promise<Readonly<Record<string, string>>>;
  readonly proof: RelayPossessionProofProvider;
  readonly fetch?: RemoteFetch;
  /** Test-only escape hatch. Production control-plane traffic must use HTTPS. */
  readonly allowInsecureLoopbackForTests?: boolean;
}

function validatedControlPlaneOrigin(options: HttpRelayTicketProviderOptions): string {
  const url = new URL(options.controlPlaneOrigin);
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new TypeError("Control-plane origin must not contain credentials, query, or fragment");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(options.allowInsecureLoopbackForTests === true && loopback)) {
    throw new TypeError("Control-plane origin must use HTTPS");
  }
  return url.origin;
}

/** Acquires one-use relay admission without placing credentials in a URL. */
export class HttpRelayTicketProvider implements RelayTicketProvider {
  private readonly options: HttpRelayTicketProviderOptions;
  private readonly origin: string;
  private readonly request: RemoteFetch;
  private readonly ticketRequest: IssueRelayTicketRequest;

  constructor(options: HttpRelayTicketProviderOptions) {
    this.options = options;
    this.ticketRequest = parseIssueRelayTicketRequest(options.request);
    this.origin = validatedControlPlaneOrigin(options);
    const fetcher = options.fetch ?? (globalThis as { fetch?: RemoteFetch }).fetch;
    if (fetcher === undefined) throw new TypeError("A fetch implementation is required");
    this.request = fetcher;
  }

  async acquire(): Promise<RelayAdmissionCredential> {
    const authentication = await this.options.authenticationHeaders();
    const response = await this.request(`${this.origin}/v1/relay/tickets`, {
      method: "POST",
      headers: { ...authentication, "content-type": "application/json" },
      body: JSON.stringify(this.ticketRequest),
    });
    if (!response.ok) {
      throw new RemoteRelayError(
        "ticket_unavailable",
        `Relay ticket request failed with HTTP ${response.status}`,
      );
    }
    const ticket = parseIssueRelayTicketResult(await response.json());
    const proof = await this.options.proof.create(ticket);
    const nonceBytes = new TextEncoder().encode(proof.connectionNonce).byteLength;
    if (
      nonceBytes === 0 ||
      nonceBytes > 256 ||
      !(proof.possessionProof instanceof Uint8Array) ||
      proof.possessionProof.byteLength === 0 ||
      proof.possessionProof.byteLength > 1_024
    ) {
      throw new RemoteRelayError("invalid_admission", "Possession proof is outside relay bounds");
    }
    return { ...ticket, ...proof };
  }
}

interface RemoteWebSocketOpenEvent {
  readonly type: "open";
}

interface RemoteWebSocketMessageEvent {
  readonly type: "message";
  readonly data: unknown;
}

interface RemoteWebSocketCloseEvent {
  readonly type: "close";
  readonly code?: number;
  readonly reason?: string;
}

interface RemoteWebSocketErrorEvent {
  readonly type: "error";
}

export type RemoteWebSocketEvent =
  | RemoteWebSocketOpenEvent
  | RemoteWebSocketMessageEvent
  | RemoteWebSocketCloseEvent
  | RemoteWebSocketErrorEvent;

type RemoteWebSocketListener = (event: RemoteWebSocketEvent) => void;

export interface RemoteWebSocket {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: RemoteWebSocketEvent["type"], listener: RemoteWebSocketListener): void;
  removeEventListener(type: RemoteWebSocketEvent["type"], listener: RemoteWebSocketListener): void;
}

export interface RemoteWebSocketFactory {
  connect(url: string): RemoteWebSocket;
}

export class GlobalRemoteWebSocketFactory implements RemoteWebSocketFactory {
  connect(url: string): RemoteWebSocket {
    const Constructor = (globalThis as { WebSocket?: new (url: string) => RemoteWebSocket })
      .WebSocket;
    if (Constructor === undefined) throw new TypeError("A WebSocket implementation is required");
    return new Constructor(url);
  }
}

export type RemoteRelayConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

export interface RemoteReconnectPolicy {
  readonly maximumAttempts: number;
  readonly initialDelayMs: number;
  readonly maximumDelayMs: number;
  readonly jitterRatio: number;
}

const DEFAULT_RECONNECT_POLICY: RemoteReconnectPolicy = Object.freeze({
  maximumAttempts: 8,
  initialDelayMs: 250,
  maximumDelayMs: 10_000,
  jitterRatio: 0.2,
});

export interface RemoteRelayConnectionOptions {
  readonly tickets: RelayTicketProvider;
  readonly sockets?: RemoteWebSocketFactory;
  readonly destinationCryptoSessionId?: CryptoSessionId;
  readonly reconnect?: Partial<RemoteReconnectPolicy>;
  readonly routeWaitMs?: number;
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export type RemoteRelayErrorCode =
  | "ticket_unavailable"
  | "invalid_admission"
  | "connection_failed"
  | "connection_closed"
  | "daemon_offline"
  | "wrong_destination"
  | "bad_relay_message"
  | "frame_too_large";

export class RemoteRelayError extends Error {
  readonly code: RemoteRelayErrorCode;

  constructor(
    code: RemoteRelayErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "RemoteRelayError";
    this.code = code;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}

function reconnectPolicy(value: Partial<RemoteReconnectPolicy> = {}): RemoteReconnectPolicy {
  const policy = { ...DEFAULT_RECONNECT_POLICY, ...value };
  positiveInteger(policy.maximumAttempts, "maximumAttempts");
  positiveInteger(policy.initialDelayMs, "initialDelayMs");
  positiveInteger(policy.maximumDelayMs, "maximumDelayMs");
  if (policy.maximumDelayMs < policy.initialDelayMs) {
    throw new TypeError("maximumDelayMs must cover initialDelayMs");
  }
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new TypeError("jitterRatio must be from zero through one");
  }
  return policy;
}

function rejectOversizedMessage(): never {
  throw new RemoteRelayError("frame_too_large", "Relay message exceeds the negotiated frame limit");
}

function boundedBytes(bytes: Uint8Array, maximumBytes: number): Uint8Array {
  if (bytes.byteLength > maximumBytes) rejectOversizedMessage();
  return bytes;
}

async function messageBytes(value: unknown, maximumBytes: number): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return boundedBytes(value, maximumBytes);
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > maximumBytes) rejectOversizedMessage();
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength > maximumBytes) rejectOversizedMessage();
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    if (value.size > maximumBytes) rejectOversizedMessage();
    return boundedBytes(new Uint8Array(await value.arrayBuffer()), maximumBytes);
  }
  if (typeof value === "string") {
    if (value.length > maximumBytes) rejectOversizedMessage();
    return boundedBytes(new TextEncoder().encode(value), maximumBytes);
  }
  throw new RemoteRelayError("bad_relay_message", "Relay message is not supported binary data");
}

function isRelayFrame(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x41 &&
    bytes[1] === 0x58 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x52
  );
}

function admissionBytes(credential: RelayAdmissionCredential): Uint8Array {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: REMOTE_TRANSPORT_VERSION,
      ticket: credential.ticket,
      connectionNonce: credential.connectionNonce,
      possessionProof: encodeBase64(credential.possessionProof),
    }),
  );
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ADMISSION_BYTES) {
    throw new RemoteRelayError("invalid_admission", "Relay admission message exceeds its bound");
  }
  return bytes;
}

type RouteWaiter = {
  readonly resolve: (route: RouteId) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

/** Ticket-admitted opaque WebSocket connection with bounded reconnect and route discovery. */
export class RemoteRelayConnection {
  private readonly options: RemoteRelayConnectionOptions;
  private readonly sockets: RemoteWebSocketFactory;
  private readonly policy: RemoteReconnectPolicy;
  private readonly routeWaitMs: number;
  private readonly random: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly receiptListeners = new Set<(receipt: RelayReceipt) => void>();
  private readonly failureListeners = new Set<(failure: RelayFailure) => void>();
  private readonly deliveryListeners = new Set<(delivery: RelayDelivery) => void>();
  private readonly routeListeners = new Set<(peers: readonly RelayPeerRoute[]) => void>();
  private readonly stateListeners = new Set<(state: RemoteRelayConnectionState) => void>();
  private readonly routeWaiters = new Set<RouteWaiter>();
  private socket: RemoteWebSocket | undefined;
  private sourceRoute: RelayPeerRoute | undefined;
  private peers = new Map<RouteId, RelayPeerRoute>();
  private generation = 0;
  private lifecycleGeneration = 0;
  private stopped = true;
  private starting: Promise<void> | undefined;
  private reconnecting: Promise<void> | undefined;
  private activeMaxFrameBytes: number | undefined;
  private currentState: RemoteRelayConnectionState = "disconnected";

  constructor(options: RemoteRelayConnectionOptions) {
    this.options = options;
    this.sockets = options.sockets ?? new GlobalRemoteWebSocketFactory();
    this.policy = reconnectPolicy(options.reconnect);
    this.routeWaitMs = positiveInteger(options.routeWaitMs ?? DEFAULT_ROUTE_WAIT_MS, "routeWaitMs");
    this.random = options.random ?? Math.random;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  get state(): RemoteRelayConnectionState {
    return this.currentState;
  }

  get routes(): readonly RelayPeerRoute[] {
    return [...this.peers.values()];
  }

  get source(): RelayPeerRoute | undefined {
    return this.sourceRoute;
  }

  start(): Promise<void> {
    if (this.currentState === "connected") return Promise.resolve();
    if (this.starting !== undefined) return this.starting;
    if (this.reconnecting !== undefined) return this.reconnecting;
    this.stopped = false;
    const lifecycleGeneration = ++this.lifecycleGeneration;
    const operation = this.connectWithRetry("connecting", lifecycleGeneration);
    const starting = operation.finally(() => {
      if (this.starting === starting) this.starting = undefined;
    });
    this.starting = starting;
    return starting;
  }

  close(): void {
    if (this.stopped && this.currentState === "closed") return;
    this.stopped = true;
    this.lifecycleGeneration += 1;
    this.generation += 1;
    this.socket?.close(1000, "client_closed");
    this.socket = undefined;
    this.activeMaxFrameBytes = undefined;
    this.clearRoutes();
    this.rejectRouteWaiters(
      new RemoteRelayError("connection_closed", "Relay connection is closed"),
    );
    this.setState("closed");
  }

  onState(listener: (state: RemoteRelayConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onRoutes(listener: (peers: readonly RelayPeerRoute[]) => void): () => void {
    this.routeListeners.add(listener);
    return () => this.routeListeners.delete(listener);
  }

  onReceipt(listener: (receipt: RelayReceipt) => void): () => void {
    this.receiptListeners.add(listener);
    return () => this.receiptListeners.delete(listener);
  }

  onFailure(listener: (failure: RelayFailure) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  onDelivery(listener: (delivery: RelayDelivery) => void): () => void {
    this.deliveryListeners.add(listener);
    return () => this.deliveryListeners.delete(listener);
  }

  async resolve(destinationCryptoSessionId: CryptoSessionId): Promise<RouteId> {
    if (
      this.options.destinationCryptoSessionId === undefined ||
      destinationCryptoSessionId !== this.options.destinationCryptoSessionId
    ) {
      throw new RemoteRelayError(
        "wrong_destination",
        "Prepared envelope targets another crypto session",
      );
    }
    const current = this.daemonRoute();
    if (current !== undefined) return current;
    if (this.stopped) throw new RemoteRelayError("connection_closed", "Relay is not running");
    return new Promise<RouteId>((resolve, reject) => {
      const waiter: RouteWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.routeWaiters.delete(waiter);
          reject(new RemoteRelayError("daemon_offline", "Daemon route is unavailable"));
        }, this.routeWaitMs),
      };
      this.routeWaiters.add(waiter);
    });
  }

  send(
    destinationRouteId: RouteId,
    attemptId: RelayDelivery["attemptId"],
    payload: Uint8Array,
  ): void {
    const socket = this.socket;
    if (this.currentState !== "connected" || socket === undefined || socket.readyState !== 1) {
      throw new RemoteRelayError("connection_closed", "Relay connection is not connected");
    }
    const maximumBytes = this.activeMaxFrameBytes;
    if (maximumBytes === undefined) {
      throw new RemoteRelayError("connection_closed", "Relay connection has no active limits");
    }
    const frame = encodeRelayBinaryFrame({
      transportVersion: REMOTE_TRANSPORT_VERSION,
      attemptId,
      destinationRouteId,
      opaquePayload: payload,
    });
    if (frame.byteLength > maximumBytes) {
      throw new RemoteRelayError(
        "frame_too_large",
        "Relay frame exceeds the negotiated frame limit",
      );
    }
    socket.send(frame);
  }

  private async connectWithRetry(
    state: "connecting" | "reconnecting",
    lifecycleGeneration: number,
  ): Promise<void> {
    if (!this.lifecycleIsActive(lifecycleGeneration)) return;
    this.setState(state);
    let latest: unknown;
    for (let attempt = 0; attempt < this.policy.maximumAttempts; attempt += 1) {
      if (attempt > 0) {
        await this.sleep(this.retryDelay(attempt - 1));
        if (!this.lifecycleIsActive(lifecycleGeneration)) return;
      }
      try {
        await this.connectOnce(lifecycleGeneration);
        return;
      } catch (error) {
        latest = error;
        this.discardFailedSocket();
        if (!this.lifecycleIsActive(lifecycleGeneration)) return;
      }
    }
    if (!this.lifecycleIsActive(lifecycleGeneration)) return;
    this.stopped = true;
    this.setState("disconnected");
    throw new RemoteRelayError("connection_failed", "Relay reconnect attempts were exhausted", {
      cause: latest,
    });
  }

  private lifecycleIsActive(generation: number): boolean {
    return !this.stopped && generation === this.lifecycleGeneration;
  }

  private async connectOnce(lifecycleGeneration: number): Promise<void> {
    const credential = await this.options.tickets.acquire();
    if (!this.lifecycleIsActive(lifecycleGeneration)) return;
    if (credential.expiresAt <= Date.now()) {
      throw new RemoteRelayError("invalid_admission", "Relay ticket is already expired");
    }
    const generation = ++this.generation;
    const socket = this.sockets.connect(credential.relayUrl);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) resolve();
        else reject(error);
      };
      const timer = setTimeout(
        () => {
          socket.close(4008, "route_snapshot_timeout");
          finish(new RemoteRelayError("connection_failed", "Relay route snapshot timed out"));
        },
        Math.min(this.routeWaitMs, credential.limits.idleTimeoutMs),
      );
      const open: RemoteWebSocketListener = () => {
        try {
          const admission = admissionBytes(credential);
          if (admission.byteLength > credential.limits.maxFrameBytes) {
            throw new RemoteRelayError(
              "frame_too_large",
              "Relay admission exceeds the negotiated frame limit",
            );
          }
          socket.send(admission);
        } catch (cause) {
          finish(
            new RemoteRelayError("invalid_admission", "Could not send relay admission", { cause }),
          );
        }
      };
      const message: RemoteWebSocketListener = (event) => {
        if (event.type !== "message") return;
        void this.handleMessage(event.data, generation, credential.limits.maxFrameBytes)
          .then((snapshot) => {
            if (snapshot) finish();
          })
          .catch((cause: unknown) => {
            socket.close(4003, "bad_relay_message");
            finish(
              new RemoteRelayError("bad_relay_message", "Relay sent an invalid message", { cause }),
            );
          });
      };
      const closed: RemoteWebSocketListener = (event) => {
        if (event.type !== "close") return;
        const error = new RemoteRelayError(
          "connection_closed",
          `Relay closed during admission${event.reason ? `: ${event.reason}` : ""}`,
        );
        finish(error);
        this.handleSocketClosed(generation, error);
      };
      const failed: RemoteWebSocketListener = () =>
        finish(new RemoteRelayError("connection_failed", "Relay WebSocket failed"));
      socket.addEventListener("open", open);
      socket.addEventListener("message", message);
      socket.addEventListener("close", closed);
      socket.addEventListener("error", failed);
    });
    if (generation !== this.generation || this.stopped) {
      socket.close(1000, "stale_connection");
      throw new RemoteRelayError("connection_closed", "Relay connection became stale");
    }
    this.activeMaxFrameBytes = credential.limits.maxFrameBytes;
    this.setState("connected");
  }

  private async handleMessage(
    value: unknown,
    generation: number,
    maximumBytes: number,
  ): Promise<boolean> {
    if (generation !== this.generation || this.stopped) return false;
    const bytes = await messageBytes(value, maximumBytes);
    if (generation !== this.generation || this.stopped) return false;
    if (!isRelayFrame(bytes)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch (cause) {
        throw new RemoteRelayError("bad_relay_message", "Relay discovery is invalid JSON", {
          cause,
        });
      }
      const discovery = parseRelayDiscoveryMessage(parsed);
      this.applyDiscovery(discovery);
      return discovery.type === "route_snapshot";
    }
    const frame = parseRelayBinaryFrame(bytes);
    if ("status" in frame) {
      for (const listener of this.receiptListeners) listener(frame);
    } else if ("code" in frame) {
      for (const listener of this.failureListeners) listener(frame);
    } else if ("sourceRouteId" in frame) {
      for (const listener of this.deliveryListeners) listener(frame);
    } else {
      throw new RemoteRelayError("bad_relay_message", "Relay sent a client-only frame");
    }
    return false;
  }

  private discardFailedSocket(): void {
    const socket = this.socket;
    this.generation += 1;
    this.socket = undefined;
    this.activeMaxFrameBytes = undefined;
    socket?.close(1000, "connection_attempt_failed");
    this.clearRoutes();
  }

  private applyDiscovery(message: ReturnType<typeof parseRelayDiscoveryMessage>): void {
    if (message.type === "route_snapshot") {
      this.sourceRoute = message.sourceRoute;
      this.peers = new Map(message.peers.map((peer) => [peer.routeId, peer]));
    } else if (message.type === "route_available") {
      for (const peer of message.peers) {
        for (const [routeId, current] of this.peers) {
          if (current.role === peer.role && current.deviceId === peer.deviceId) {
            this.peers.delete(routeId);
          }
        }
        this.peers.set(peer.routeId, peer);
      }
    } else {
      for (const peer of message.peers) this.peers.delete(peer.routeId);
    }
    this.resolveRouteWaiters();
    for (const listener of this.routeListeners) listener(this.routes);
  }

  private daemonRoute(): RouteId | undefined {
    return this.routes.find((peer) => peer.role === "daemon")?.routeId;
  }

  private resolveRouteWaiters(): void {
    const route = this.daemonRoute();
    if (route === undefined) return;
    for (const waiter of this.routeWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(route);
    }
    this.routeWaiters.clear();
  }

  private rejectRouteWaiters(error: Error): void {
    for (const waiter of this.routeWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.routeWaiters.clear();
  }

  private clearRoutes(): void {
    this.sourceRoute = undefined;
    if (this.peers.size === 0) return;
    this.peers.clear();
    for (const listener of this.routeListeners) listener([]);
  }

  private handleSocketClosed(generation: number, error: Error): void {
    if (generation !== this.generation) return;
    const wasConnected = this.currentState === "connected";
    this.socket = undefined;
    this.activeMaxFrameBytes = undefined;
    this.clearRoutes();
    this.rejectRouteWaiters(error);
    if (!wasConnected || this.stopped || this.reconnecting !== undefined) return;
    const reconnecting = this.connectWithRetry("reconnecting", this.lifecycleGeneration).catch(
      () => undefined,
    );
    this.reconnecting = reconnecting;
    void reconnecting.finally(() => {
      if (this.reconnecting === reconnecting) this.reconnecting = undefined;
    });
  }

  private retryDelay(attempt: number): number {
    const unjittered = Math.min(
      this.policy.maximumDelayMs,
      this.policy.initialDelayMs * 2 ** attempt,
    );
    const random = this.random();
    if (!Number.isFinite(random) || random < 0 || random > 1) {
      throw new TypeError("Reconnect random source must return a value from zero through one");
    }
    const factor = 1 - this.policy.jitterRatio + 2 * this.policy.jitterRatio * random;
    return Math.max(1, Math.round(unjittered * factor));
  }

  private setState(state: RemoteRelayConnectionState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    for (const listener of this.stateListeners) listener(state);
  }
}

export interface AuthenticatedRemotePayload {
  readonly authenticatedPeerId: DeviceId;
  readonly plaintext: Uint8Array;
  /** Control-only records mutate native cryptographic state and are not decoded as daemon RPC. */
  readonly controlOnly?: boolean;
  /** Commits receive acknowledgement after the authenticated payload has been accepted locally. */
  readonly acknowledge?: () => Promise<void>;
}

export interface RemotePayloadOpener {
  open(opaqueEnvelope: Uint8Array): Promise<AuthenticatedRemotePayload>;
}

export interface RemoteDeliveryUpdate {
  readonly requestId: RequestId;
  readonly state: RemoteDeliveryState;
  readonly attemptId?: RelayReceipt["attemptId"];
  readonly relayFailure?: RelayFailure["code"];
}

export interface RemoteHostedDeliveryOptions {
  readonly connection: RemoteRelayConnection;
  readonly outbox: RemoteOutbox;
  readonly opener: RemotePayloadOpener;
  readonly expectedDaemonId: DeviceId;
  readonly attemptIds: TransportAttemptIdFactory;
}

/** Coordinates immutable prepared envelopes. It never creates or advances cryptographic state. */
export class RemoteHostedDelivery {
  private readonly options: RemoteHostedDeliveryOptions;
  private readonly attempts = new Map<RelayReceipt["attemptId"], RequestId>();
  private readonly deliveryListeners = new Set<(update: RemoteDeliveryUpdate) => void>();
  private readonly messageListeners = new Set<(message: RemoteDaemonMessage) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private flushTail: Promise<void> = Promise.resolve();
  private inboundTail: Promise<void> = Promise.resolve();
  private started = false;
  private starting: Promise<void> | undefined;

  constructor(options: RemoteHostedDeliveryOptions) {
    this.options = options;
    options.connection.onState((state) => {
      if (state === "reconnecting" || state === "disconnected") {
        this.attempts.clear();
        void options.outbox
          .resetSendingAfterDisconnect()
          .catch((cause: unknown) => this.reportError(cause, "Could not reset the remote outbox"));
      }
      if (state === "connected") {
        void this.flush().catch((cause: unknown) =>
          this.reportError(cause, "Could not flush the remote outbox"),
        );
      }
    });
    options.connection.onRoutes(() => {
      void this.flush().catch((cause: unknown) =>
        this.reportError(cause, "Could not flush the remote outbox"),
      );
    });
    options.connection.onReceipt((receipt) => this.handleReceipt(receipt));
    options.connection.onFailure((failure) => {
      void this.handleFailure(failure).catch((cause: unknown) =>
        this.reportError(cause, "Could not apply a relay failure"),
      );
    });
    options.connection.onDelivery((delivery) => {
      this.inboundTail = this.inboundTail
        .then(() => this.handleDelivery(delivery))
        .catch((cause) => {
          const error =
            cause instanceof Error
              ? cause
              : new RemoteRelayError("bad_relay_message", "Remote delivery failed", { cause });
          for (const listener of this.errorListeners) listener(error);
        });
    });
  }

  onDeliveryState(listener: (update: RemoteDeliveryUpdate) => void): () => void {
    this.deliveryListeners.add(listener);
    return () => this.deliveryListeners.delete(listener);
  }

  onMessage(listener: (message: RemoteDaemonMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.started && this.starting === undefined) return Promise.resolve();
    if (this.starting !== undefined) return this.starting;
    this.started = true;
    const operation = (async () => {
      // A process can stop after persisting `sending` but before receiving acceptance.
      // No live transport attempt survives startup, so every such record is retryable.
      await this.options.outbox.resetSendingAfterDisconnect();
      await this.options.connection.start();
      await this.flush();
    })().catch((error: unknown) => {
      this.started = false;
      throw error;
    });
    const starting = operation.finally(() => {
      if (this.starting === starting) this.starting = undefined;
    });
    this.starting = starting;
    return starting;
  }

  async drain(): Promise<void> {
    while (true) {
      const flush = this.flushTail;
      const inbound = this.inboundTail;
      await Promise.all([flush, inbound]);
      if (flush === this.flushTail && inbound === this.inboundTail) return;
    }
  }

  async shutdown(): Promise<void> {
    this.started = false;
    this.options.connection.close();
    await this.drain();
  }

  close(): void {
    this.started = false;
    this.options.connection.close();
  }

  async enqueuePrepared(record: OpaqueOutboxRecord): Promise<void> {
    await this.options.outbox.enqueue(record);
    this.publish({ requestId: record.requestId, state: "queued_local" });
    await this.flush();
  }

  async sendPreparedEphemeral(
    destinationCryptoSessionId: CryptoSessionId,
    opaqueEnvelope: Uint8Array,
  ): Promise<TransportAttemptId> {
    const destinationRouteId = await this.options.connection.resolve(destinationCryptoSessionId);
    const attemptId = this.options.attemptIds.create();
    this.options.connection.send(destinationRouteId, attemptId, opaqueEnvelope);
    return attemptId;
  }

  flush(): Promise<void> {
    const operation = this.flushTail.then(async () => {
      if (!this.started || this.options.connection.state !== "connected") return;
      const records = await this.options.outbox.list();
      let firstFailure: unknown;
      for (const record of records) {
        if (record.state !== "queued_local") continue;
        try {
          const attempt = await this.options.outbox.beginAttempt(record.requestId);
          this.attempts.set(attempt.attemptId, attempt.requestId);
          this.publish({
            requestId: attempt.requestId,
            state: "sending",
            attemptId: attempt.attemptId,
          });
          this.options.connection.send(
            attempt.destinationRouteId,
            attempt.attemptId,
            attempt.opaqueEnvelope,
          );
        } catch (cause) {
          await this.options.outbox.markQueued(record.requestId);
          firstFailure ??= cause;
          this.reportError(cause, "Could not send a prepared remote envelope");
        }
      }
      if (firstFailure !== undefined) throw firstFailure;
    });
    this.flushTail = operation.catch(() => undefined);
    return operation;
  }

  private handleReceipt(receipt: RelayReceipt): void {
    const requestId = this.attempts.get(receipt.attemptId);
    if (requestId === undefined) return;
    this.publish({
      requestId,
      state: receipt.status === "admitted" ? "relay_admitted" : "relay_forwarded",
      attemptId: receipt.attemptId,
    });
    if (receipt.status === "forwarded") this.attempts.delete(receipt.attemptId);
  }

  private async handleFailure(failure: RelayFailure): Promise<void> {
    const requestId = this.attempts.get(failure.attemptId);
    if (requestId === undefined) return;
    this.attempts.delete(failure.attemptId);
    await this.options.outbox.markQueued(requestId);
    this.publish({
      requestId,
      state: "failed",
      attemptId: failure.attemptId,
      relayFailure: failure.code,
    });
  }

  private async handleDelivery(delivery: RelayDelivery): Promise<void> {
    const opened = await this.options.opener.open(delivery.opaquePayload);
    if (parseDeviceId(opened.authenticatedPeerId) !== this.options.expectedDaemonId) {
      throw new RemoteRelayError(
        "bad_relay_message",
        "Delivery is not authenticated to the daemon",
      );
    }
    if (opened.controlOnly === true) {
      await opened.acknowledge?.();
      await this.flush();
      return;
    }
    const message = decodeRemoteDaemonMessage(opened.plaintext);
    if (message.type === "daemon_accepted") {
      const record = (await this.options.outbox.list()).find(
        (candidate) => candidate.requestId === message.requestId,
      );
      if (record === undefined) {
        // The daemon re-sends its replies when the device replays a request; the first
        // acceptance already removed this record, so the duplicate only needs acknowledging.
        await opened.acknowledge?.();
        return;
      }
      if (record.idempotencyKey !== message.idempotencyKey) {
        throw new RemoteRelayError(
          "bad_relay_message",
          "Daemon acceptance does not match the prepared request",
        );
      }
      await this.options.outbox.markDaemonAccepted(message.requestId);
      this.publish({ requestId: message.requestId, state: "daemon_accepted" });
      await this.options.outbox.removeAccepted(message.requestId);
    } else if (message.type === "daemon_result") {
      await this.options.outbox.markCompleted(message.requestId);
      this.publish({ requestId: message.requestId, state: "completed" });
    } else if (message.type === "daemon_error") {
      await this.options.outbox.markCompleted(message.requestId);
      this.publish({ requestId: message.requestId, state: "failed" });
    }
    for (const listener of this.messageListeners) listener(message);
    await opened.acknowledge?.();
  }

  private publish(update: RemoteDeliveryUpdate): void {
    for (const listener of this.deliveryListeners) listener(update);
  }

  private reportError(cause: unknown, message: string): void {
    const error =
      cause instanceof Error
        ? cause
        : new RemoteRelayError("connection_failed", message, { cause });
    for (const listener of this.errorListeners) listener(error);
  }
}
