// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

import {
  parseWitnessHttpResponseBody,
  WITNESS_CERTIFICATE_MAX_BYTES,
  WITNESS_HTTP_CONTENT_TYPE,
  WITNESS_HTTP_PATH,
  WITNESS_REQUEST_MAX_BYTES,
} from "@axl/protocol";

/** The one durable pending witness operation of an endpoint, exactly as the endpoint signed it. */
export interface WitnessPendingOperation {
  readonly operationId: Uint8Array;
  readonly request: Uint8Array;
  readonly requestHash: Uint8Array;
  readonly kind: "register" | "advance";
}

export type WitnessReconciliation =
  | {
      readonly tag:
        | "ready"
        | "resend_pending"
        | "recover_accepted"
        | "witness_unavailable"
        | "revoked";
    }
  | { readonly tag: "quarantined"; readonly reason: string };

/**
 * Exact typed result released by a completed witness barrier. The endpoint populates exactly the
 * accessor named by `tag`; adapters read that one accessor and reject every other shape.
 */
export interface WitnessTypedResult {
  readonly tag: string;
  readonly status?: string;
  readonly outbox?: unknown;
  readonly plaintext?: unknown;
  readonly accepted?: unknown;
  readonly commit?: unknown;
  readonly epochReady?: unknown;
}

/** Result of every state-changing endpoint call. */
export interface WitnessMutationOutcome {
  readonly tag: "pending" | "released";
  readonly pending?: WitnessPendingOperation;
  readonly result?: WitnessTypedResult;
}

/** Endpoint-owned witness operations implemented by the native and browser bindings. */
export interface WitnessEndpointOperations {
  witnessReadRequest(): Promise<Uint8Array>;
  reconcileWitness(certificate: Uint8Array): Promise<WitnessReconciliation>;
  pendingWitness(): Promise<WitnessPendingOperation | null>;
  continueWitness(operationId: Uint8Array, certificate: Uint8Array): Promise<WitnessTypedResult>;
}

/**
 * Submits one exact signed witness request and returns the certificate bytes. The transport never
 * inspects, alters, or decides on request or certificate bytes; the endpoint verifies them.
 */
export interface WitnessCertificateTransport {
  respond(request: Uint8Array): Promise<Uint8Array>;
}

export interface WitnessFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}

export type WitnessFetch = (
  input: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
    readonly signal: AbortSignal;
  },
) => Promise<WitnessFetchResponse>;

export interface HostedWitnessClientOptions {
  readonly controlPlaneOrigin: string;
  readonly authenticationHeaders: () => Promise<Readonly<Record<string, string>>>;
  readonly fetch?: WitnessFetch;
  readonly timeoutMs?: number;
  readonly allowInsecureLoopbackForTests?: boolean;
}

export type HostedWitnessErrorCode =
  | "witness_unavailable"
  | "witness_auth_failed"
  | "witness_receipt_invalid"
  | "witness_operation_conflict"
  | "witness_registration_conflict"
  | "witness_conflict"
  | "witness_invalid_expected";

export class HostedWitnessError extends Error {
  readonly code: HostedWitnessErrorCode;

  constructor(code: HostedWitnessErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "HostedWitnessError";
    this.code = code;
  }
}

const witnessCodes = new Set<HostedWitnessErrorCode>([
  "witness_unavailable",
  "witness_auth_failed",
  "witness_receipt_invalid",
  "witness_operation_conflict",
  "witness_registration_conflict",
  "witness_conflict",
  "witness_invalid_expected",
]);

function origin(options: HostedWitnessClientOptions): string {
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
 * The shared hosted HTTP transport. It sends byte-identical signed requests, whether fresh reads
 * or committed advances, and returns the bounded certificate to the caller that owns the endpoint.
 */
export class HostedWitnessClient implements WitnessCertificateTransport {
  private readonly options: HostedWitnessClientOptions;
  private readonly origin: string;
  private readonly request: WitnessFetch;
  private readonly timeoutMs: number;

  constructor(options: HostedWitnessClientOptions) {
    this.options = options;
    this.origin = origin(options);
    const request = options.fetch ?? (globalThis as { fetch?: WitnessFetch }).fetch;
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
      throw new HostedWitnessError("witness_receipt_invalid", "Witness request is outside bounds");
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
        let code: HostedWitnessErrorCode = "witness_unavailable";
        try {
          const body = (await response.json()) as { readonly error?: { readonly code?: unknown } };
          if (
            typeof body.error?.code === "string" &&
            witnessCodes.has(body.error.code as HostedWitnessErrorCode)
          ) {
            code = body.error.code as HostedWitnessErrorCode;
          }
        } catch {
          // The bounded public code remains witness_unavailable.
        }
        throw new HostedWitnessError(
          code,
          `Witness gateway rejected the request with HTTP ${response.status}`,
        );
      }
      if (response.headers.get("content-type") !== WITNESS_HTTP_CONTENT_TYPE) {
        throw new HostedWitnessError(
          "witness_receipt_invalid",
          "Witness response content type is invalid",
        );
      }
      const body = await response.arrayBuffer();
      if (body.byteLength === 0 || body.byteLength > WITNESS_CERTIFICATE_MAX_BYTES) {
        throw new HostedWitnessError(
          "witness_receipt_invalid",
          "Witness certificate is outside bounds",
        );
      }
      return parseWitnessHttpResponseBody(new Uint8Array(body));
    } catch (cause) {
      if (cause instanceof HostedWitnessError) throw cause;
      if (controller.signal.aborted) {
        throw new HostedWitnessError("witness_unavailable", "Witness request timed out", { cause });
      }
      throw new HostedWitnessError("witness_unavailable", "Witness request failed", { cause });
    } finally {
      clearTimeout(timer);
      requestBytes.fill(0);
    }
  }
}

export type WitnessBarrierErrorCode =
  | "witness_unavailable"
  | "witness_quarantined"
  | "endpoint_revoked"
  | "witness_result_mismatch";

/** Raised when the barrier cannot authorize a mutation or the endpoint released the wrong shape. */
export class WitnessBarrierError extends Error {
  readonly code: WitnessBarrierErrorCode;
  readonly reason: string | undefined;

  constructor(code: WitnessBarrierErrorCode, message: string, reason?: string) {
    super(message);
    this.name = "WitnessBarrierError";
    this.code = code;
    this.reason = reason;
  }
}

/** Reconciliation attempts before the barrier reports the witness as unavailable. */
const MAX_RECOVERY_ROUNDS = 3;

/**
 * One endpoint whose every mutation completes through the witness barrier before any result is
 * visible. Calls are serialized so that two adapters sharing one endpoint never interleave their
 * fresh read, mutation, and continuation. The barrier moves bytes between the endpoint and the
 * transport unchanged; the endpoint alone verifies certificates and releases results.
 */
export class WitnessedEndpoint<E extends WitnessEndpointOperations> {
  private readonly endpoint: E;
  private readonly transport: WitnessCertificateTransport;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(endpoint: E, transport: WitnessCertificateTransport) {
    this.endpoint = endpoint;
    this.transport = transport;
  }

  /** Submit a fresh read and let the endpoint reconcile against its confirmed head. */
  reconcile(): Promise<WitnessReconciliation> {
    return this.serialized(() => this.reconcileNow());
  }

  /** Reconcile until one mutation is authorized, completing any recovered pending operation. */
  recover(): Promise<void> {
    return this.serialized(() => this.recoverNow());
  }

  /** Run one state-changing endpoint call through the complete barrier and return its result. */
  mutate(run: (endpoint: E) => Promise<WitnessMutationOutcome>): Promise<WitnessTypedResult> {
    return this.serialized(async () => {
      await this.recoverNow();
      const outcome = await run(this.endpoint);
      if (outcome.tag === "released") {
        if (outcome.result === undefined) {
          throw new WitnessBarrierError(
            "witness_result_mismatch",
            "Endpoint released a mutation without a result",
          );
        }
        return outcome.result;
      }
      if (outcome.tag !== "pending" || outcome.pending === undefined) {
        throw new WitnessBarrierError(
          "witness_result_mismatch",
          "Endpoint returned an invalid witness outcome",
        );
      }
      return this.completeNow(outcome.pending);
    });
  }

  /** Run one read-only endpoint call in order with the barrier operations. */
  read<T>(run: (endpoint: E) => Promise<T>): Promise<T> {
    return this.serialized(() => run(this.endpoint));
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async reconcileNow(): Promise<WitnessReconciliation> {
    const read = await this.endpoint.witnessReadRequest();
    const certificate = await this.transport.respond(read);
    try {
      return await this.endpoint.reconcileWitness(certificate);
    } finally {
      certificate.fill(0);
    }
  }

  private async completeNow(pending: WitnessPendingOperation): Promise<WitnessTypedResult> {
    const certificate = await this.transport.respond(pending.request);
    try {
      return await this.endpoint.continueWitness(pending.operationId, certificate);
    } finally {
      certificate.fill(0);
    }
  }

  private async recoverNow(): Promise<void> {
    for (let round = 0; round < MAX_RECOVERY_ROUNDS; round += 1) {
      const outcome = await this.reconcileNow();
      switch (outcome.tag) {
        case "ready":
          return;
        case "resend_pending":
        case "recover_accepted": {
          const pending = await this.endpoint.pendingWitness();
          if (pending === null) {
            throw new WitnessBarrierError(
              "witness_result_mismatch",
              "Endpoint reported a pending operation it cannot recover",
            );
          }
          await this.completeNow(pending);
          break;
        }
        case "revoked":
          throw new WitnessBarrierError("endpoint_revoked", "The endpoint is revoked");
        case "quarantined":
          throw new WitnessBarrierError(
            "witness_quarantined",
            "The endpoint is quarantined",
            outcome.reason,
          );
        default:
          throw new WitnessBarrierError("witness_unavailable", "The witness is unavailable");
      }
    }
    throw new WitnessBarrierError(
      "witness_unavailable",
      "The witness did not authorize a mutation",
    );
  }
}

/** Read the one accessor a released result must carry for its expected tag. */
export function releasedField<T>(
  result: WitnessTypedResult,
  tag: string,
  field: keyof WitnessTypedResult,
): T {
  const value = result[field];
  if (result.tag !== tag || value === undefined || value === null) {
    throw new WitnessBarrierError(
      "witness_result_mismatch",
      `Expected a released ${tag} result, received ${result.tag}`,
    );
  }
  return value as T;
}
