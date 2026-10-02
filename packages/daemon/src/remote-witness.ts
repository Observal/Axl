// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

import {
  parseWitnessHttpResponseBody,
  WITNESS_CERTIFICATE_MAX_BYTES,
  WITNESS_HTTP_CONTENT_TYPE,
  WITNESS_HTTP_PATH,
  WITNESS_REQUEST_MAX_BYTES,
} from "@axl/protocol";

/** The one durable pending witness operation of the daemon endpoint, exactly as it was signed. */
export interface DaemonWitnessPending {
  readonly operationId: Uint8Array;
  readonly request: Uint8Array;
  readonly requestHash: Uint8Array;
  readonly kind: "register" | "advance";
}

export type DaemonWitnessReconciliation =
  | {
      readonly tag:
        | "ready"
        | "resend_pending"
        | "recover_accepted"
        | "witness_unavailable"
        | "revoked";
    }
  | { readonly tag: "quarantined"; readonly reason: string };

/** Exact typed result released by a completed barrier; only the accessor named by `tag` is set. */
export interface DaemonWitnessResult {
  readonly tag: string;
  readonly status?: string;
  readonly outbox?: unknown;
  readonly plaintext?: unknown;
  readonly accepted?: unknown;
  readonly epochReady?: unknown;
}

/** Result of every state-changing native endpoint call. */
export interface DaemonWitnessOutcome {
  readonly tag: "pending" | "released";
  readonly pending?: DaemonWitnessPending;
  readonly result?: DaemonWitnessResult;
}

/** Endpoint-owned witness operations of the private native daemon binding. */
export interface DaemonWitnessEndpointOperations {
  witnessReadRequest(): Promise<Uint8Array>;
  reconcileWitness(certificate: Uint8Array): Promise<DaemonWitnessReconciliation>;
  pendingWitness(): Promise<DaemonWitnessPending | null>;
  continueWitness(operationId: Uint8Array, certificate: Uint8Array): Promise<DaemonWitnessResult>;
}

/**
 * Daemon-owned authenticated witness transport. It submits one exact signed request and returns
 * the certificate bytes unchanged; the native endpoint verifies them.
 */
export interface DaemonWitnessTransport {
  respond(request: Uint8Array): Promise<Uint8Array>;
}

export type DaemonWitnessErrorCode =
  | "witness_unavailable"
  | "witness_auth_failed"
  | "witness_receipt_invalid"
  | "witness_operation_conflict"
  | "witness_registration_conflict"
  | "witness_conflict"
  | "witness_invalid_expected"
  | "witness_quarantined"
  | "endpoint_revoked"
  | "witness_result_mismatch";

const GATEWAY_ERROR_CODES = new Set<DaemonWitnessErrorCode>([
  "witness_unavailable",
  "witness_auth_failed",
  "witness_receipt_invalid",
  "witness_operation_conflict",
  "witness_registration_conflict",
  "witness_conflict",
  "witness_invalid_expected",
]);

export class DaemonWitnessError extends Error {
  readonly code: DaemonWitnessErrorCode;
  readonly reason: string | undefined;

  constructor(code: DaemonWitnessErrorCode, message: string, reason?: string) {
    super(message);
    this.name = "DaemonWitnessError";
    this.code = code;
    this.reason = reason;
  }
}

const MAX_RECOVERY_ROUNDS = 3;

/**
 * Runs the daemon endpoint's witness barrier: fresh read, reconciliation, one mutation, and the
 * continuation that releases the exact result. The caller serializes barriers; this class does
 * not. Bytes pass between the endpoint and the transport unchanged.
 */
export class DaemonWitnessBarrier<E extends DaemonWitnessEndpointOperations> {
  readonly #endpoint: E;
  readonly #transport: DaemonWitnessTransport;

  constructor(endpoint: E, transport: DaemonWitnessTransport) {
    this.#endpoint = endpoint;
    this.#transport = transport;
  }

  async reconcile(): Promise<DaemonWitnessReconciliation> {
    const read = await this.#endpoint.witnessReadRequest();
    const certificate = await this.#transport.respond(read);
    try {
      return await this.#endpoint.reconcileWitness(certificate);
    } finally {
      certificate.fill(0);
    }
  }

  async complete(pending: DaemonWitnessPending): Promise<DaemonWitnessResult> {
    const certificate = await this.#transport.respond(pending.request);
    try {
      return await this.#endpoint.continueWitness(pending.operationId, certificate);
    } finally {
      certificate.fill(0);
    }
  }

  /** Reconcile until one mutation is authorized, completing any recovered pending operation. */
  async recover(): Promise<void> {
    for (let round = 0; round < MAX_RECOVERY_ROUNDS; round += 1) {
      const outcome = await this.reconcile();
      switch (outcome.tag) {
        case "ready":
          return;
        case "resend_pending":
        case "recover_accepted": {
          const pending = await this.#endpoint.pendingWitness();
          if (pending === null) {
            throw new DaemonWitnessError(
              "witness_result_mismatch",
              "Endpoint reported a pending operation it cannot recover",
            );
          }
          await this.complete(pending);
          break;
        }
        case "revoked":
          throw new DaemonWitnessError("endpoint_revoked", "The endpoint is revoked");
        case "quarantined":
          throw new DaemonWitnessError(
            "witness_quarantined",
            "The endpoint is quarantined",
            outcome.reason,
          );
        default:
          throw new DaemonWitnessError("witness_unavailable", "The witness is unavailable");
      }
    }
    throw new DaemonWitnessError("witness_unavailable", "The witness did not authorize a mutation");
  }

  /** One complete barrier around one state-changing endpoint call. */
  async mutate(run: (endpoint: E) => Promise<DaemonWitnessOutcome>): Promise<DaemonWitnessResult> {
    await this.recover();
    const outcome = await run(this.#endpoint);
    if (outcome.tag === "released") {
      if (outcome.result === undefined) {
        throw new DaemonWitnessError(
          "witness_result_mismatch",
          "Endpoint released a mutation without a result",
        );
      }
      return outcome.result;
    }
    if (outcome.tag !== "pending" || outcome.pending === undefined) {
      throw new DaemonWitnessError(
        "witness_result_mismatch",
        "Endpoint returned an invalid witness outcome",
      );
    }
    return this.complete(outcome.pending);
  }
}

/** Read the one accessor a released result must carry for its expected tag. */
export function releasedField<T>(
  result: DaemonWitnessResult,
  tag: string,
  field: keyof DaemonWitnessResult,
): T {
  const value = result[field];
  if (result.tag !== tag || value === undefined || value === null) {
    throw new DaemonWitnessError(
      "witness_result_mismatch",
      `Expected a released ${tag} result, received ${result.tag}`,
    );
  }
  return value as T;
}

export interface DaemonWitnessFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  /** Streamed so the transport can stop reading at its size bound. */
  readonly body: ReadableStream<Uint8Array> | null;
}

/** Longest gateway error body the transport decodes for a bounded public code. */
const WITNESS_ERROR_BODY_MAX_BYTES = 4_096;

/**
 * Read a response body while enforcing the size bound, so an oversized gateway response is never
 * fully allocated. Returns undefined once the bound is exceeded; the remainder is cancelled.
 */
async function readBounded(
  response: {
    readonly headers: { get(name: string): string | null };
    readonly body: ReadableStream<Uint8Array> | null;
  },
  maximumBytes: number,
): Promise<Uint8Array | undefined> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) return undefined;
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) return undefined;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function gatewayErrorCode<Code extends string>(
  bytes: Uint8Array | undefined,
  known: ReadonlySet<Code>,
  fallback: Code,
): Code {
  if (bytes === undefined) return fallback;
  try {
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
      readonly error?: { readonly code?: unknown };
    };
    const code = body.error?.code;
    return typeof code === "string" && known.has(code as Code) ? (code as Code) : fallback;
  } catch {
    return fallback;
  }
}

export type DaemonWitnessFetch = (
  input: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
    readonly signal: AbortSignal;
  },
) => Promise<DaemonWitnessFetchResponse>;

export interface HostedDaemonWitnessTransportOptions {
  readonly controlPlaneOrigin: string;
  /** Daemon credential headers, referenced by the host and never logged. */
  readonly authenticationHeaders: () => Promise<Readonly<Record<string, string>>>;
  readonly fetch?: DaemonWitnessFetch;
  readonly timeoutMs?: number;
  readonly allowInsecureLoopbackForTests?: boolean;
}

function witnessOrigin(options: HostedDaemonWitnessTransportOptions): string {
  const value = new URL(options.controlPlaneOrigin);
  if (value.username || value.password || value.search || value.hash) {
    throw new TypeError("Witness origin must not contain credentials, query, or fragment");
  }
  const loopback = value.hostname === "127.0.0.1" || value.hostname === "[::1]";
  if (
    value.protocol !== "https:" &&
    !(options.allowInsecureLoopbackForTests === true && loopback)
  ) {
    throw new TypeError("Witness origin must use HTTPS");
  }
  return value.origin;
}

/**
 * The daemon's authenticated HTTP witness transport. It submits byte-identical signed requests,
 * fresh reads and committed advances alike, over HTTPS with bounded sizes and a timeout, and
 * returns the bounded certificate to the native endpoint that verifies it. Transport and gateway
 * failures map to bounded public codes; timeouts and network failures are `witness_unavailable`.
 */
export class HostedDaemonWitnessTransport implements DaemonWitnessTransport {
  private readonly options: HostedDaemonWitnessTransportOptions;
  private readonly origin: string;
  private readonly request: DaemonWitnessFetch;
  private readonly timeoutMs: number;

  constructor(options: HostedDaemonWitnessTransportOptions) {
    this.options = options;
    this.origin = witnessOrigin(options);
    const request = options.fetch ?? (globalThis as { fetch?: DaemonWitnessFetch }).fetch;
    if (request === undefined) throw new TypeError("A fetch implementation is required");
    this.request = request;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 60_000) {
      throw new TypeError("Witness timeout must be from 1 through 60000 milliseconds");
    }
  }

  async respond(request: Uint8Array): Promise<Uint8Array> {
    if (
      !(request instanceof Uint8Array) ||
      request.byteLength === 0 ||
      request.byteLength > WITNESS_REQUEST_MAX_BYTES
    ) {
      throw new DaemonWitnessError("witness_receipt_invalid", "Witness request is outside bounds");
    }
    const requestBytes = new Uint8Array(request);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const authentication = await this.options.authenticationHeaders();
      const response = await this.request(`${this.origin}${WITNESS_HTTP_PATH}`, {
        method: "POST",
        headers: { ...authentication, "content-type": WITNESS_HTTP_CONTENT_TYPE },
        body: requestBytes,
        signal: controller.signal,
      });
      if (!response.ok) {
        // An oversized or malformed error body keeps the bounded public code.
        const code = gatewayErrorCode(
          await readBounded(response, WITNESS_ERROR_BODY_MAX_BYTES),
          GATEWAY_ERROR_CODES,
          "witness_unavailable" as DaemonWitnessErrorCode,
        );
        throw new DaemonWitnessError(
          code,
          `Witness gateway rejected the request with HTTP ${response.status}`,
        );
      }
      if (response.headers.get("content-type") !== WITNESS_HTTP_CONTENT_TYPE) {
        throw new DaemonWitnessError(
          "witness_receipt_invalid",
          "Witness response content type is invalid",
        );
      }
      const body = await readBounded(response, WITNESS_CERTIFICATE_MAX_BYTES);
      if (body === undefined || body.byteLength === 0) {
        throw new DaemonWitnessError(
          "witness_receipt_invalid",
          "Witness certificate is outside bounds",
        );
      }
      return parseWitnessHttpResponseBody(body);
    } catch (cause) {
      if (cause instanceof DaemonWitnessError) throw cause;
      if (controller.signal.aborted) {
        throw new DaemonWitnessError("witness_unavailable", "Witness request timed out");
      }
      throw new DaemonWitnessError("witness_unavailable", "Witness request failed");
    } finally {
      clearTimeout(timer);
      requestBytes.fill(0);
    }
  }
}

/** Exponential backoff for witness recovery retries after `witness_unavailable`. */
export interface DaemonWitnessRecoveryPolicy {
  readonly initialDelayMs: number;
  readonly maximumDelayMs: number;
  /** Fraction of the unjittered delay that bounded jitter may add or remove, from 0 through 1. */
  readonly jitterRatio: number;
}

export const DEFAULT_WITNESS_RECOVERY_POLICY: DaemonWitnessRecoveryPolicy = Object.freeze({
  initialDelayMs: 1_000,
  maximumDelayMs: 30_000,
  jitterRatio: 0.2,
});

export function witnessRecoveryPolicy(
  overrides: Partial<DaemonWitnessRecoveryPolicy> | undefined,
): DaemonWitnessRecoveryPolicy {
  const policy = { ...DEFAULT_WITNESS_RECOVERY_POLICY, ...overrides };
  for (const key of ["initialDelayMs", "maximumDelayMs"] as const) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0) {
      throw new TypeError(`${key} must be a positive integer`);
    }
  }
  if (policy.maximumDelayMs < policy.initialDelayMs) {
    throw new TypeError("maximumDelayMs must cover initialDelayMs");
  }
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new TypeError("jitterRatio must be from zero through one");
  }
  return policy;
}

/**
 * Delay before retry number `attempt` (zero-based): the initial delay doubled per attempt, capped
 * at the maximum, with bounded symmetric jitter. The result never exceeds the maximum.
 */
export function witnessRecoveryDelay(
  policy: DaemonWitnessRecoveryPolicy,
  attempt: number,
  random: () => number,
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new TypeError("attempt must be a non-negative integer");
  }
  const unjittered = Math.min(
    policy.maximumDelayMs,
    policy.initialDelayMs * 2 ** Math.min(attempt, 31),
  );
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new TypeError("Recovery random source must return a value from zero through one");
  }
  const factor = 1 - policy.jitterRatio + 2 * policy.jitterRatio * sample;
  return Math.min(policy.maximumDelayMs, Math.max(1, Math.round(unjittered * factor)));
}
