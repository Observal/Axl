// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser device side of deployment-test remote access.
 *
 * The browser binding's device endpoint completes every witness barrier inside its worker, so this
 * adapter never sees a pending witness operation: it frames released ciphertext as remote E2EE
 * envelopes, moves them over the relay, and opens the daemon's replies. Pairing follows the
 * daemon host's contract: publish the claim, send the pairing notice, wait for the Welcome, join,
 * and send the MLS-protected activation until the daemon answers a request.
 *
 * Sealed requests stay in memory until the daemon answers them. Whenever the relay reconnects or
 * the daemon's route changes, every unanswered envelope is sent again byte for byte; the daemon
 * recognizes the exact bytes and replays its cached replies instead of running the request twice.
 */

import {
  type CryptoSessionId,
  type DeviceId,
  decodeRemoteDaemonMessage,
  encodeRemoteE2eeEnvelope,
  isRetryableMutationMethod,
  type OperationId,
  parseIdempotencyKey,
  parseOperationId,
  parseRemoteE2eeEnvelope,
  parseRemoteRequestId,
  parseTransportAttemptId,
  type RelayDelivery,
  type RelayPeerRoute,
  type RemoteDaemonMessage,
  RemoteDaemonMessageAssembler,
  type RouteId,
  type RpcMethod,
  type ServerMessage,
} from "@axl/protocol";

import type { HostedPairingClient } from "./remote-pairing.ts";
import {
  encodeRemotePairingNotice,
  type RemotePairingLink,
  uuidToBytes,
} from "./remote-pairing-link.ts";
import type { RemoteRelayConnection } from "./remote-relay.ts";

/** Released result of one browser device endpoint operation. */
export interface BrowserDeviceResult {
  readonly tag: string;
  readonly bytes?: Uint8Array;
  readonly logicalMessageId?: Uint8Array;
  readonly epoch?: bigint;
}

/** Structural subset of the browser binding's `DeviceEndpoint`. */
export interface BrowserDeviceEndpoint {
  pairingClaim(invitation: Uint8Array): Promise<Uint8Array>;
  joinPublished(operationId: Uint8Array, welcome: Uint8Array): Promise<BrowserDeviceResult>;
  preparePairActivation(
    operationId: Uint8Array,
    logicalMessageId: Uint8Array,
    claim: Uint8Array,
  ): Promise<BrowserDeviceResult>;
  prepareApplication(
    operationId: Uint8Array,
    logicalMessageId: Uint8Array,
    hostedGeneration: bigint,
    plaintext: Uint8Array,
  ): Promise<BrowserDeviceResult>;
  receiveApplication(
    operationId: Uint8Array,
    logicalMessageId: Uint8Array,
    hostedGeneration: bigint,
    ciphertext: Uint8Array,
  ): Promise<BrowserDeviceResult>;
  close(): Promise<void>;
}

const HOSTED_GRANT_GENERATION = 1;
const NOTICE_INTERVAL_MS = 3_000;
const WELCOME_WAIT_MS = 120_000;
const ACTIVATION_WAIT_MS = 60_000;
/**
 * A relay failure (the daemon briefly offline, a full queue) is retried after a pause that doubles
 * up to a bound, so a daemon that stays away does not turn every pending request into a loop.
 */
const RESEND_AFTER_FAILURE_MS = 2_000;
const MAX_RESEND_AFTER_FAILURE_MS = 30_000;
/** Pauses before repeating an endpoint operation whose witness round trip failed. */
const WITNESS_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

/**
 * Run one endpoint operation, repeating it while the hosted witness is briefly unreachable. The
 * endpoint binds each operation to its identity, so a repeat completes the same pending mutation
 * rather than starting another; every other failure is final.
 */
async function withWitnessRetry<T>(
  work: () => Promise<T>,
  trace?: (message: string) => void,
): Promise<T> {
  for (const delay of WITNESS_RETRY_DELAYS_MS) {
    try {
      return await work();
    } catch (cause) {
      if ((cause as { readonly code?: unknown }).code !== "witness_unavailable") throw cause;
      trace?.(`witness unavailable; retrying in ${delay} ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return work();
}

/** A fresh UUIDv7 for operation and logical message identities. */
export function randomOperationId(): OperationId {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return parseOperationId(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

function bytesToUuid(value: Uint8Array): OperationId {
  const hex = Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return parseOperationId(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

function released(result: BrowserDeviceResult, name: string): Uint8Array {
  if (!(result.bytes instanceof Uint8Array)) {
    throw new Error(`Device endpoint released ${result.tag} where ${name} was expected`);
  }
  return result.bytes;
}

async function sha384(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-384", new Uint8Array(bytes)));
}

/** Send one frame to the daemon, reporting instead of throwing when the relay is between sockets. */
async function sendToDaemon(
  relay: RemoteRelayConnection,
  cryptoSessionId: CryptoSessionId,
  payload: Uint8Array,
): Promise<boolean> {
  try {
    const route = await relay.resolve(cryptoSessionId);
    relay.send(route, parseTransportAttemptId(randomOperationId()), payload);
    return true;
  } catch {
    return false;
  }
}

export type RemoteBrowserPairingStep =
  | "claim"
  | "notice"
  | "welcome"
  | "join"
  | "activation"
  | "paired";

export interface RemoteBrowserPairingOptions {
  readonly link: RemotePairingLink;
  readonly endpoint: BrowserDeviceEndpoint;
  readonly pairing: HostedPairingClient;
  /** A started device-role relay connection bound to the link's crypto session. */
  readonly relay: RemoteRelayConnection;
  /**
   * Resolves once the daemon answers an authenticated request, proving it accepted the
   * activation. The activation is sent again until then, since the relay can lose it.
   */
  readonly confirm?: () => Promise<void>;
  readonly onStep?: (step: RemoteBrowserPairingStep) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Pair a fresh browser device endpoint with the daemon that issued `link`. Every step is safe to
 * repeat after a reload: the claim is deterministic, the control plane accepts the same claim
 * again, and the endpoint replays an already completed join or activation exactly.
 */
export async function pairRemoteBrowserDevice(options: RemoteBrowserPairingOptions): Promise<void> {
  const { link, endpoint, pairing, relay } = options;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const binding = {
    version: 1 as const,
    installationId: link.installationId,
    deviceId: link.deviceId,
    cryptoSessionId: link.cryptoSessionId,
  };
  options.onStep?.("claim");
  const claim = await endpoint.pairingClaim(link.invitation);
  const claimHash = await sha384(claim);
  try {
    await pairing.publishClaim({ ...binding, claim, claimHash });
  } catch (cause) {
    // A reload republishes the identical claim; the rendezvous already holds it.
    if ((cause as { readonly code?: unknown }).code !== "conflict") throw cause;
  }

  options.onStep?.("notice");
  const notice = encodeRemotePairingNotice(claimHash);
  const deadline = Date.now() + WELCOME_WAIT_MS;
  let welcome: Uint8Array | undefined;
  let welcomeHash: Uint8Array | undefined;
  while (welcome === undefined) {
    // A notice lost while the relay reconnects is sent again on the next round.
    await sendToDaemon(relay, link.cryptoSessionId, notice);
    options.onStep?.("welcome");
    const waitUntil = Date.now() + NOTICE_INTERVAL_MS;
    while (welcome === undefined && Date.now() < waitUntil) {
      try {
        const published = await pairing.fetchWelcome({ ...binding, claimHash });
        welcome = published.welcome;
        welcomeHash = published.welcomeHash;
      } catch (cause) {
        if ((cause as { readonly code?: unknown }).code !== "not_found") throw cause;
        await sleep(750);
      }
    }
    if (welcome === undefined && Date.now() > deadline) {
      throw new Error("The daemon did not answer the pairing request; run /remote again");
    }
  }

  options.onStep?.("join");
  // Operation identities derive from the claim so a repeated pairing replays the same results.
  const identity = claimHash.slice(0, 16);
  const operation = (domain: number) => {
    const value = identity.slice();
    value[0] = (value[0] ?? 0) ^ domain;
    value[6] = ((value[6] ?? 0) & 0x0f) | 0x70;
    value[8] = ((value[8] ?? 0) & 0x3f) | 0x80;
    return value;
  };
  await endpoint.joinPublished(operation(0x51), welcome);

  options.onStep?.("activation");
  const activationOperation = operation(0x52);
  const activationLogical = operation(0x53);
  const activation = await endpoint.preparePairActivation(
    activationOperation,
    activationLogical,
    claim,
  );
  const activationEnvelope = encodeRemoteE2eeEnvelope({
    operationId: bytesToUuid(activationOperation),
    logicalMessageId: bytesToUuid(activation.logicalMessageId ?? activationLogical),
    messageClass: "pair_activation",
    hostedGrantGeneration: HOSTED_GRANT_GENERATION,
    ciphertext: released(activation, "activation"),
  });
  const activationDeadline = Date.now() + ACTIVATION_WAIT_MS;
  for (;;) {
    // The daemon accepts the same activation bytes exactly once and ignores repeats.
    await sendToDaemon(relay, link.cryptoSessionId, activationEnvelope);
    if (options.confirm === undefined) break;
    try {
      await options.confirm();
      break;
    } catch (cause) {
      if (Date.now() > activationDeadline) {
        throw new Error("The daemon did not confirm the pairing; run /remote again", { cause });
      }
    }
  }
  if (welcomeHash !== undefined) {
    await pairing.acknowledgeWelcome({ ...binding, claimHash, welcomeHash }).catch(() => undefined);
  }
  options.onStep?.("paired");
}

export class RemoteBrowserRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "RemoteBrowserRequestError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface RemoteBrowserSessionOptions {
  readonly endpoint: BrowserDeviceEndpoint;
  readonly relay: RemoteRelayConnection;
  readonly deviceId: DeviceId;
  readonly cryptoSessionId: CryptoSessionId;
  readonly requestTimeoutMs?: number;
  /** Receives message types and request ids for diagnostics, never message content. */
  readonly trace?: (message: string) => void;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  /** The sealed envelope, set once sealing finished; resent until the daemon answers. */
  envelope?: Uint8Array;
  /** The relay connection and daemon route of the latest transmission. */
  sentOn?: { readonly connection: number; readonly route: RouteId } | undefined;
}

/** Paired browser device: sealed daemon requests out, opened daemon replies and deliveries in. */
export class RemoteBrowserSession {
  readonly #options: RemoteBrowserSessionOptions;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #attempts = new Map<string, string>();
  readonly #listeners = new Set<(message: ServerMessage) => void>();
  readonly #errors = new Set<(error: Error) => void>();
  readonly #reconnectListeners = new Set<() => void>();
  readonly #fragments = new RemoteDaemonMessageAssembler();
  readonly #releases: (() => void)[];
  #tail: Promise<unknown> = Promise.resolve();
  #connection = 0;
  #daemonRoute: RouteId | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retryDelay = RESEND_AFTER_FAILURE_MS;

  constructor(options: RemoteBrowserSessionOptions) {
    this.#options = options;
    const { relay } = options;
    this.#daemonRoute = relay.routes.find((peer) => peer.role === "daemon")?.routeId;
    this.#releases = [
      relay.onDelivery((delivery) => {
        void this.#serialized(() => this.#receive(delivery)).catch((cause: unknown) =>
          this.#report(cause),
        );
      }),
      relay.onState((state) => {
        if (state !== "connected") return;
        this.#connection += 1;
        this.#resend("relay reconnected");
        for (const listener of this.#reconnectListeners) listener();
      }),
      relay.onRoutes((peers) => this.#observeRoutes(peers)),
      relay.onFailure((failure) => {
        const requestId = this.#attempts.get(failure.attemptId);
        if (requestId === undefined) return;
        this.#attempts.delete(failure.attemptId);
        const pending = this.#pending.get(requestId);
        if (pending === undefined) return;
        this.#options.trace?.(`relay refused ${requestId}: ${failure.code}`);
        pending.sentOn = undefined;
        this.#scheduleRetry();
      }),
      relay.onReceipt((receipt) => {
        if (receipt.status === "forwarded") this.#attempts.delete(receipt.attemptId);
      }),
    ];
  }

  onServerMessage(listener: (message: ServerMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.#errors.add(listener);
    return () => this.#errors.delete(listener);
  }

  /**
   * Called after the relay connects again, or the daemon rejoins it. Deliveries sent while either
   * side was away are lost, so a listener resumes its subscriptions from their cursors.
   */
  onReconnect(listener: () => void): () => void {
    this.#reconnectListeners.add(listener);
    return () => this.#reconnectListeners.delete(listener);
  }

  /** Requests sealed but not yet answered by the daemon. */
  get unanswered(): number {
    return this.#pending.size;
  }

  /** Seal one authenticated request for the daemon and wait for its result. */
  async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const requestId = parseRemoteRequestId(randomOperationId());
    const request = {
      deviceId: this.#options.deviceId,
      requestId,
      // Retryable mutations carry an idempotency key; the daemon rejects one anywhere else.
      ...(isRetryableMutationMethod(method as RpcMethod)
        ? { idempotencyKey: parseIdempotencyKey(randomOperationId()) }
        : {}),
      method,
      params,
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(request));
    const operation = randomOperationId();
    const logical = randomOperationId();
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.#pending.delete(requestId);
          reject(new RemoteBrowserRequestError("timeout", `${method} timed out`, true));
        },
        timeoutMs ?? this.#options.requestTimeoutMs ?? 60_000,
      );
      this.#pending.set(requestId, { method, resolve, reject, timer });
    });
    try {
      const sealed = await this.#serialized(() =>
        withWitnessRetry(
          () =>
            this.#options.endpoint.prepareApplication(
              uuidToBytes(operation),
              uuidToBytes(logical),
              BigInt(HOSTED_GRANT_GENERATION),
              plaintext,
            ),
          this.#options.trace,
        ),
      );
      const pending = this.#pending.get(requestId);
      if (pending !== undefined) {
        pending.envelope = encodeRemoteE2eeEnvelope({
          operationId: operation,
          logicalMessageId: logical,
          messageClass: "application_request",
          hostedGrantGeneration: HOSTED_GRANT_GENERATION,
          ciphertext: released(sealed, "application"),
        });
        void this.#transmit(requestId);
      }
    } catch (cause) {
      const pending = this.#pending.get(requestId);
      this.#pending.delete(requestId);
      if (pending !== undefined) clearTimeout(pending.timer);
      throw cause;
    } finally {
      plaintext.fill(0);
    }
    return result;
  }

  close(): void {
    for (const release of this.#releases) release();
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RemoteBrowserRequestError("closed", "Remote session closed", false));
    }
    this.#pending.clear();
    this.#attempts.clear();
  }

  /**
   * Send one sealed request toward the daemon's current route. A request that cannot leave now
   * stays pending and goes out on the next reconnect, route change, or retry.
   */
  async #transmit(requestId: string): Promise<void> {
    const pending = this.#pending.get(requestId);
    if (pending?.envelope === undefined) return;
    const { relay, cryptoSessionId } = this.#options;
    if (relay.state !== "connected") return;
    let route: RouteId;
    try {
      route = await relay.resolve(cryptoSessionId);
    } catch {
      // The daemon is offline; its route announcement triggers the resend.
      return;
    }
    if (this.#pending.get(requestId) !== pending) return;
    const attemptId = parseTransportAttemptId(randomOperationId());
    try {
      relay.send(route, attemptId, pending.envelope);
    } catch (cause) {
      this.#options.trace?.(`send ${requestId} deferred: ${String(cause)}`);
      return;
    }
    this.#attempts.set(attemptId, requestId);
    pending.sentOn = { connection: this.#connection, route };
  }

  /** Resend every sealed request whose latest transmission predates the current path. */
  #resend(reason: string): void {
    const stale = [...this.#pending.entries()].filter(
      ([, pending]) =>
        pending.envelope !== undefined &&
        (pending.sentOn === undefined ||
          pending.sentOn.connection !== this.#connection ||
          pending.sentOn.route !== this.#daemonRoute),
    );
    if (stale.length === 0) return;
    this.#options.trace?.(`resending ${stale.length} unanswered after ${reason}`);
    for (const [requestId] of stale) void this.#transmit(requestId);
  }

  #observeRoutes(peers: readonly RelayPeerRoute[]): void {
    const route = peers.find((peer) => peer.role === "daemon")?.routeId;
    if (route === undefined || route === this.#daemonRoute) return;
    const rejoined = this.#daemonRoute !== undefined;
    this.#daemonRoute = route;
    this.#retryDelay = RESEND_AFTER_FAILURE_MS;
    this.#resend("daemon route change");
    if (rejoined) for (const listener of this.#reconnectListeners) listener();
  }

  #scheduleRetry(): void {
    if (this.#retryTimer !== undefined) return;
    const delay = this.#retryDelay;
    this.#retryDelay = Math.min(MAX_RESEND_AFTER_FAILURE_MS, delay * 2);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#resend("relay failure");
    }, delay);
  }

  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #receive(delivery: RelayDelivery): Promise<void> {
    const envelope = parseRemoteE2eeEnvelope(delivery.opaquePayload);
    if (envelope.messageClass !== "application_delivery") {
      throw new Error(`Unsupported ${envelope.messageClass} from the daemon`);
    }
    let opened: BrowserDeviceResult;
    try {
      opened = await withWitnessRetry(
        () =>
          this.#options.endpoint.receiveApplication(
            uuidToBytes(envelope.operationId),
            uuidToBytes(envelope.logicalMessageId),
            BigInt(envelope.hostedGrantGeneration),
            envelope.ciphertext,
          ),
        this.#options.trace,
      );
    } catch (cause) {
      // A resent request makes the daemon replay replies this device already opened.
      if ((cause as { readonly code?: unknown }).code === "replay_rejected") {
        this.#options.trace?.(`ignored a replayed reply ${envelope.operationId}`);
        return;
      }
      throw cause;
    }
    const decoded = decodeRemoteDaemonMessage(released(opened, "plaintext"));
    const message = decoded.type === "daemon_fragment" ? this.#fragments.accept(decoded) : decoded;
    if (message !== undefined) this.#dispatch(message);
  }

  #dispatch(message: RemoteDaemonMessage): void {
    this.#options.trace?.(
      `${message.type}${"requestId" in message ? ` ${message.requestId}${this.#pending.has(message.requestId) ? "" : " (not pending)"}` : ""}${message.type === "daemon_deliveries" ? ` x${message.messages.length}` : ""}`,
    );
    switch (message.type) {
      case "daemon_result":
        this.#settle(message.requestId, (pending) => pending.resolve(message.result));
        return;
      case "daemon_error":
        this.#settle(message.requestId, (pending) =>
          pending.reject(
            new RemoteBrowserRequestError(message.code, message.message, message.retryable),
          ),
        );
        return;
      case "daemon_delivery":
        for (const listener of this.#listeners) listener(message.message);
        return;
      case "daemon_deliveries":
        for (const item of message.messages) for (const listener of this.#listeners) listener(item);
        return;
      case "daemon_rejected":
        this.#report(
          new RemoteBrowserRequestError(message.code, "The daemon rejected a request", false),
        );
        return;
      default:
        return;
    }
  }

  #settle(requestId: string, run: (pending: PendingRequest) => void): void {
    // The daemon is answering again, so the next relay failure starts with a short pause.
    this.#retryDelay = RESEND_AFTER_FAILURE_MS;
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    run(pending);
  }

  #report(cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    for (const listener of this.#errors) listener(error);
  }
}
