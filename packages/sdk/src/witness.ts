// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import {
  parseWitnessHttpResponseBody,
  WITNESS_CERTIFICATE_MAX_BYTES,
  WITNESS_HTTP_CONTENT_TYPE,
  WITNESS_HTTP_PATH,
  WITNESS_REQUEST_MAX_BYTES,
} from "@axl/protocol";

export interface PendingWitnessContinuation {
  readonly operationId: Uint8Array;
  readonly witnessRequest: Uint8Array;
  readonly requestHash: Uint8Array;
  readonly status: "pending_quorum" | "committed";
  continueWitness(operationId: Uint8Array, certificate: Uint8Array): Promise<Uint8Array>;
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

/** Sends only byte-identical committed requests and returns certificates to native continuations. */
export class HostedWitnessClient {
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

  async complete(pending: PendingWitnessContinuation): Promise<Uint8Array> {
    if (pending.status === "committed") {
      throw new HostedWitnessError("witness_operation_conflict", "Witness operation is complete");
    }
    if (
      !(pending.operationId instanceof Uint8Array) ||
      pending.operationId.byteLength !== 16 ||
      !(pending.requestHash instanceof Uint8Array) ||
      pending.requestHash.byteLength !== 48 ||
      !(pending.witnessRequest instanceof Uint8Array) ||
      pending.witnessRequest.byteLength === 0 ||
      pending.witnessRequest.byteLength > WITNESS_REQUEST_MAX_BYTES
    ) {
      throw new HostedWitnessError("witness_receipt_invalid", "Pending witness state is invalid");
    }
    const requestBytes = new Uint8Array(pending.witnessRequest);
    const operationId = new Uint8Array(pending.operationId);
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
      const certificate = parseWitnessHttpResponseBody(new Uint8Array(body));
      try {
        return await pending.continueWitness(operationId, certificate);
      } finally {
        certificate.fill(0);
      }
    } catch (cause) {
      if (cause instanceof HostedWitnessError) throw cause;
      if (controller.signal.aborted) {
        throw new HostedWitnessError("witness_unavailable", "Witness request timed out", { cause });
      }
      throw new HostedWitnessError("witness_unavailable", "Witness request failed", { cause });
    } finally {
      clearTimeout(timer);
      requestBytes.fill(0);
      operationId.fill(0);
    }
  }
}
