// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

// Worker-owned witness barrier. Every mutation runs the complete sequence inside the worker: a
// fresh read reconciled against the confirmed head, recovery of any pending operation, the one
// transition, and the unanimous certificate for it. The page receives only the exact released
// result, never a witness request, a certificate, or an unreleased outcome. Requests and
// certificates cross the same-origin witness gateway byte for byte; the Rust endpoint alone
// verifies certificates and releases results.

const WITNESS_PATH = "/v1/e2ee/witness";
const WITNESS_CONTENT_TYPE = "application/vnd.axl.rollback-witness-v1";
const WITNESS_TIMEOUT_MS = 10_000;
const MAX_CERTIFICATE_BYTES = 3_072;
const MAX_ERROR_BYTES = 4_096;
const MAX_RECOVERY_ROUNDS = 3;
/** Gateway error codes that keep their meaning across the boundary; anything else is unavailable. */
const GATEWAY_CODES = new Set([
  "witness_auth_failed",
  "witness_receipt_invalid",
  "witness_operation_conflict",
  "witness_registration_conflict",
  "witness_conflict",
  "witness_invalid_expected",
  "endpoint_revoked",
]);

function failure(code) {
  return new Error(`AXL_E2EE:${code}`);
}

async function readBounded(response, maximum) {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(declared) || declared > maximum) return undefined;
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function gatewayCode(body) {
  try {
    const code = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))?.error?.code;
    return GATEWAY_CODES.has(code) ? code : "witness_unavailable";
  } catch {
    return "witness_unavailable";
  }
}

export class WorkerWitnessBarrier {
  #authorization;

  /** The account credential the gateway authenticates. It never leaves the worker. */
  authorize(authorization) {
    if (typeof authorization !== "string" || authorization.length === 0 || authorization.length > 16_384) {
      throw failure("invalid_argument");
    }
    this.#authorization = authorization;
  }

  async #respond(request) {
    if (this.#authorization === undefined) throw failure("witness_auth_failed");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WITNESS_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await fetch(new URL(WITNESS_PATH, self.location.origin), {
          method: "POST",
          headers: { authorization: this.#authorization, "content-type": WITNESS_CONTENT_TYPE },
          body: request,
          cache: "no-store",
          credentials: "same-origin",
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw failure("witness_unavailable");
      }
      if (response.status === 401 || response.status === 403) throw failure("witness_auth_failed");
      if (!response.ok) {
        const body = await readBounded(response, MAX_ERROR_BYTES);
        throw failure(body === undefined ? "witness_unavailable" : gatewayCode(body));
      }
      if (response.headers.get("content-type") !== WITNESS_CONTENT_TYPE) {
        throw failure("witness_receipt_invalid");
      }
      const certificate = await readBounded(response, MAX_CERTIFICATE_BYTES);
      if (certificate === undefined || certificate.byteLength === 0) {
        throw failure("witness_receipt_invalid");
      }
      return certificate;
    } finally {
      clearTimeout(timer);
    }
  }

  async #reconcile(endpoint) {
    const read = await endpoint.witnessReadRequest();
    const certificate = await this.#respond(read);
    try {
      return await endpoint.reconcileWitness(certificate);
    } finally {
      certificate.fill(0);
    }
  }

  async #complete(endpoint, pending) {
    const certificate = await this.#respond(pending.witnessRequest);
    try {
      return await endpoint.continueWitness(pending.operationId, certificate);
    } finally {
      certificate.fill(0);
    }
  }

  /** Reconcile until one mutation is authorized, finishing any resend or accepted recovery. */
  async recover(endpoint) {
    for (let round = 0; round < MAX_RECOVERY_ROUNDS; round += 1) {
      const outcome = await this.#reconcile(endpoint);
      const { tag } = outcome;
      if (tag === "ready") return;
      if (tag === "revoked") throw failure("endpoint_revoked");
      if (tag === "quarantined") throw failure("rollback_detected");
      if (tag !== "resend_pending" && tag !== "recover_accepted") {
        throw failure("witness_unavailable");
      }
      const pending = await endpoint.pendingWitness();
      if (pending === null) throw failure("internal_error");
      await this.#complete(endpoint, pending);
    }
    throw failure("witness_unavailable");
  }

  /** Certify the counter-1 registration of a freshly created endpoint. */
  register(endpoint, pending) {
    return this.#complete(endpoint, pending);
  }

  /** One state-changing call through the complete barrier; resolves with the released result. */
  async mutate(endpoint, run) {
    await this.recover(endpoint);
    const outcome = await run(endpoint);
    return outcome.status === "completed" ? outcome : this.#complete(endpoint, outcome);
  }
}
