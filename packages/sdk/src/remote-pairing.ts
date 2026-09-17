// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import {
  type AcknowledgePairingWelcomeRequest,
  decodeBase64,
  encodeBase64,
  type FetchPairingWelcomeRequest,
  type PairingReservation,
  type PairingWelcomePublication,
  type PublishPairingClaimRequest,
  type PublishPairingWelcomeRequest,
  parseAcknowledgePairingWelcomeRequest,
  parsePublishPairingClaimRequest,
  parsePublishPairingWelcomeRequest,
  parseReservePairingClaimRequest,
  type ReservePairingClaimRequest,
} from "@axl/protocol";

const MAX_RESPONSE_BYTES = 24 * 1024;

export interface HostedPairingClientOptions {
  readonly origin: string;
  readonly authorization: () => Promise<string>;
  readonly fetch?: typeof fetch;
}

export class HostedPairingError extends Error {
  readonly status: number | undefined;
  readonly code: string;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "HostedPairingError";
    this.code = code;
    this.status = status;
  }
}

function endpoint(origin: string, path: string): URL {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.username !== "" || base.password !== "") {
    throw new TypeError("Pairing origin must be an HTTPS origin without user information");
  }
  return new URL(path, `${base.origin}/`);
}

function binding(value: FetchPairingWelcomeRequest): Record<string, unknown> {
  return {
    version: 1,
    installationId: value.installationId,
    deviceId: value.deviceId,
    cryptoSessionId: value.cryptoSessionId,
    claimHash: encodeBase64(value.claimHash),
  };
}

export class HostedPairingClient {
  readonly #options: HostedPairingClientOptions;

  constructor(options: HostedPairingClientOptions) {
    endpoint(options.origin, "/");
    this.#options = options;
  }

  async publishClaim(request: PublishPairingClaimRequest): Promise<void> {
    const value = parsePublishPairingClaimRequest({
      ...binding(request),
      claim: encodeBase64(request.claim),
    });
    await this.#post("/v1/e2ee/pairing/claims", {
      ...binding(value),
      claim: encodeBase64(value.claim),
    });
  }

  async reserveClaim(request: ReservePairingClaimRequest): Promise<PairingReservation> {
    const value = parseReservePairingClaimRequest({
      ...binding(request),
      reservationId: request.reservationId,
    });
    const response = await this.#post("/v1/e2ee/pairing/claims/reserve", {
      ...binding(value),
      reservationId: value.reservationId,
    });
    return {
      version: 1,
      reservationId: value.reservationId,
      claim: decodeBase64(response.claim, "pairingReservation.claim", 17_320),
      claimHash: decodeBase64(response.claimHash, "pairingReservation.claimHash", 48),
      expiresAt: this.#timestamp(response.expiresAt, "pairingReservation.expiresAt"),
    };
  }

  async publishWelcome(request: PublishPairingWelcomeRequest): Promise<PairingWelcomePublication> {
    const value = parsePublishPairingWelcomeRequest({
      ...binding(request),
      reservationId: request.reservationId,
      welcome: encodeBase64(request.welcome),
      welcomeHash: encodeBase64(request.welcomeHash),
    });
    return this.#welcome(
      await this.#post("/v1/e2ee/pairing/welcomes", {
        ...binding(value),
        reservationId: value.reservationId,
        welcome: encodeBase64(value.welcome),
        welcomeHash: encodeBase64(value.welcomeHash),
      }),
    );
  }

  async fetchWelcome(request: FetchPairingWelcomeRequest): Promise<PairingWelcomePublication> {
    return this.#welcome(await this.#post("/v1/e2ee/pairing/welcomes/fetch", binding(request)));
  }

  async acknowledgeWelcome(request: AcknowledgePairingWelcomeRequest): Promise<void> {
    const value = parseAcknowledgePairingWelcomeRequest({
      ...binding(request),
      welcomeHash: encodeBase64(request.welcomeHash),
    });
    await this.#post("/v1/e2ee/pairing/welcomes/acknowledge", {
      ...binding(value),
      welcomeHash: encodeBase64(value.welcomeHash),
    });
  }

  async #post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const token = await this.#options.authorization();
    if (token.length === 0 || token.length > 16 * 1024) {
      throw new HostedPairingError("unauthorized", "Pairing authorization is unavailable");
    }
    const response = await (this.#options.fetch ?? fetch)(endpoint(this.#options.origin, path), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) {
      throw new HostedPairingError("invalid_response", "Pairing response exceeds its bound");
    }
    if (response.status === 204) return {};
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new HostedPairingError(
        "invalid_response",
        "Pairing response is invalid",
        response.status,
      );
    }
    if (!response.ok) {
      const code =
        typeof decoded === "object" &&
        decoded !== null &&
        "error" in decoded &&
        typeof decoded.error === "object" &&
        decoded.error !== null &&
        "code" in decoded.error &&
        typeof decoded.error.code === "string"
          ? decoded.error.code
          : "service_unavailable";
      throw new HostedPairingError(code, "Pairing request failed", response.status);
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new HostedPairingError(
        "invalid_response",
        "Pairing response is invalid",
        response.status,
      );
    }
    return decoded as Record<string, unknown>;
  }

  #welcome(value: Record<string, unknown>): PairingWelcomePublication {
    if (value.version !== 1)
      throw new HostedPairingError("invalid_response", "Pairing response version is invalid");
    const welcome = decodeBase64(value.welcome, "pairingWelcome.welcome", 16_384);
    const welcomeHash = decodeBase64(value.welcomeHash, "pairingWelcome.welcomeHash", 48);
    if (welcome.byteLength === 0 || welcomeHash.byteLength !== 48) {
      throw new HostedPairingError("invalid_response", "Pairing response has invalid lengths");
    }
    return {
      version: 1,
      welcome,
      welcomeHash,
      expiresAt: this.#timestamp(value.expiresAt, "pairingWelcome.expiresAt"),
    };
  }

  #timestamp(value: unknown, path: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new HostedPairingError("invalid_response", `${path} is invalid`);
    }
    return value as number;
  }
}
