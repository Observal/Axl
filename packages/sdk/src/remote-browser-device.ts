// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser device side of deployment-test remote access.
 *
 * The browser binding's device endpoint completes every witness barrier inside its worker, so this
 * adapter never sees a pending witness operation: it frames released ciphertext as remote E2EE
 * envelopes, moves them over the relay, and opens the daemon's replies. Pairing follows the
 * daemon host's contract: publish the claim, send the pairing notice, wait for the Welcome, join,
 * and send the MLS-protected activation.
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
  type RemoteDaemonMessage,
  RemoteDaemonMessageAssembler,
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
  const route = await relay.resolve(link.cryptoSessionId);
  const notice = encodeRemotePairingNotice(claimHash);
  const deadline = Date.now() + WELCOME_WAIT_MS;
  let welcome: Uint8Array | undefined;
  let welcomeHash: Uint8Array | undefined;
  while (welcome === undefined) {
    relay.send(route, parseTransportAttemptId(randomOperationId()), notice);
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
  relay.send(
    await relay.resolve(link.cryptoSessionId),
    parseTransportAttemptId(randomOperationId()),
    encodeRemoteE2eeEnvelope({
      operationId: bytesToUuid(activationOperation),
      logicalMessageId: bytesToUuid(activation.logicalMessageId ?? activationLogical),
      messageClass: "pair_activation",
      hostedGrantGeneration: HOSTED_GRANT_GENERATION,
      ciphertext: released(activation, "activation"),
    }),
  );
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
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Paired browser device: sealed daemon requests out, opened daemon replies and deliveries in. */
export class RemoteBrowserSession {
  readonly #options: RemoteBrowserSessionOptions;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Set<(message: ServerMessage) => void>();
  readonly #errors = new Set<(error: Error) => void>();
  readonly #fragments = new RemoteDaemonMessageAssembler();
  #tail: Promise<unknown> = Promise.resolve();
  #release: () => void;

  constructor(options: RemoteBrowserSessionOptions) {
    this.#options = options;
    this.#release = options.relay.onDelivery((delivery) => {
      void this.#serialized(() => this.#receive(delivery)).catch((cause: unknown) =>
        this.#report(cause),
      );
    });
  }

  onServerMessage(listener: (message: ServerMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.#errors.add(listener);
    return () => this.#errors.delete(listener);
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
      this.#pending.set(requestId, { resolve, reject, timer });
    });
    try {
      const sealed = await this.#serialized(() =>
        this.#options.endpoint.prepareApplication(
          uuidToBytes(operation),
          uuidToBytes(logical),
          BigInt(HOSTED_GRANT_GENERATION),
          plaintext,
        ),
      );
      const route = await this.#options.relay.resolve(this.#options.cryptoSessionId);
      this.#options.relay.send(
        route,
        parseTransportAttemptId(randomOperationId()),
        encodeRemoteE2eeEnvelope({
          operationId: operation,
          logicalMessageId: logical,
          messageClass: "application_request",
          hostedGrantGeneration: HOSTED_GRANT_GENERATION,
          ciphertext: released(sealed, "application"),
        }),
      );
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
    this.#release();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RemoteBrowserRequestError("closed", "Remote session closed", false));
    }
    this.#pending.clear();
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
    const opened = await this.#options.endpoint.receiveApplication(
      uuidToBytes(envelope.operationId),
      uuidToBytes(envelope.logicalMessageId),
      BigInt(envelope.hostedGrantGeneration),
      envelope.ciphertext,
    );
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
