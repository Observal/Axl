// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

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
  | "witness_quarantined"
  | "endpoint_revoked"
  | "witness_result_mismatch";

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
