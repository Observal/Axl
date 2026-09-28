// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import { type OperationId, parseOperationId } from "./event-envelope.ts";
import {
  type CryptoSessionId,
  type DeviceId,
  decodeBase64,
  encodeBase64,
  type InstallationId,
  parseCryptoSessionId,
  parseDeviceId,
  parseInstallationId,
} from "./remote-transport.ts";

export const PAIRING_CLAIM_MAX_BYTES = 17_320;
export const PAIRING_WELCOME_MAX_BYTES = 16_384;

/**
 * A short pairing link names a sealed full link the daemon parked on the control plane. The key
 * that opens it stays in the short link's fragment, so the control plane holds only ciphertext.
 */
export const PAIRING_LINK_PUBLISH_PATH = "/v1/e2ee/pairing/links";
export const PAIRING_LINK_FETCH_PATH = "/v1/e2ee/pairing/links/fetch";
export const PAIRING_LINK_ID_BYTES = 16;
export const PAIRING_LINK_SEALED_MAX_BYTES = 4_096;

export interface PublishPairingLinkRequest {
  readonly version: 1;
  readonly linkId: Uint8Array;
  readonly sealed: Uint8Array;
  readonly expiresAt: number;
}

export interface FetchPairingLinkRequest {
  readonly version: 1;
  readonly linkId: Uint8Array;
}

export interface PairingLinkPublication {
  readonly version: 1;
  readonly sealed: Uint8Array;
  readonly expiresAt: number;
}

export interface PublishPairingClaimRequest {
  readonly version: 1;
  readonly installationId: InstallationId;
  readonly deviceId: DeviceId;
  readonly cryptoSessionId: CryptoSessionId;
  readonly claim: Uint8Array;
  readonly claimHash: Uint8Array;
}

export interface ReservePairingClaimRequest {
  readonly version: 1;
  readonly installationId: InstallationId;
  readonly deviceId: DeviceId;
  readonly cryptoSessionId: CryptoSessionId;
  readonly claimHash: Uint8Array;
  readonly reservationId: OperationId;
}

export interface PairingReservation {
  readonly version: 1;
  readonly reservationId: OperationId;
  readonly claim: Uint8Array;
  readonly claimHash: Uint8Array;
  readonly expiresAt: number;
}

export interface PublishPairingWelcomeRequest extends ReservePairingClaimRequest {
  readonly welcome: Uint8Array;
  readonly welcomeHash: Uint8Array;
}

export interface FetchPairingWelcomeRequest {
  readonly version: 1;
  readonly installationId: InstallationId;
  readonly deviceId: DeviceId;
  readonly cryptoSessionId: CryptoSessionId;
  readonly claimHash: Uint8Array;
}

export interface PairingWelcomePublication {
  readonly version: 1;
  readonly welcome: Uint8Array;
  readonly welcomeHash: Uint8Array;
  readonly expiresAt: number;
}

export interface AcknowledgePairingWelcomeRequest extends FetchPairingWelcomeRequest {
  readonly welcomeHash: Uint8Array;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, path: string, fields: readonly string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some((field) => !(field in value))) {
    throw new TypeError(`${path} has invalid fields`);
  }
}

function timestamp(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function parseBinding(value: Record<string, unknown>, path: string) {
  return {
    installationId: parseInstallationId(value.installationId, `${path}.installationId`),
    deviceId: parseDeviceId(value.deviceId, `${path}.deviceId`),
    cryptoSessionId: parseCryptoSessionId(value.cryptoSessionId, `${path}.cryptoSessionId`),
    claimHash: decodeBase64(value.claimHash, `${path}.claimHash`, 48),
  };
}

function requireVersion(value: unknown, path: string): asserts value is 1 {
  if (value !== 1) throw new TypeError(`${path} must equal 1`);
}

export function parsePublishPairingClaimRequest(value: unknown): PublishPairingClaimRequest {
  const candidate = object(value, "pairingClaim");
  exact(candidate, "pairingClaim", [
    "version",
    "installationId",
    "deviceId",
    "cryptoSessionId",
    "claim",
    "claimHash",
  ]);
  requireVersion(candidate.version, "pairingClaim.version");
  const binding = parseBinding(candidate, "pairingClaim");
  const claim = decodeBase64(candidate.claim, "pairingClaim.claim", PAIRING_CLAIM_MAX_BYTES);
  if (claim.byteLength === 0 || binding.claimHash.byteLength !== 48) {
    throw new TypeError("Pairing claim or hash has an invalid length");
  }
  return { version: 1, ...binding, claim };
}

export function parseReservePairingClaimRequest(value: unknown): ReservePairingClaimRequest {
  const candidate = object(value, "pairingReservation");
  exact(candidate, "pairingReservation", [
    "version",
    "installationId",
    "deviceId",
    "cryptoSessionId",
    "claimHash",
    "reservationId",
  ]);
  requireVersion(candidate.version, "pairingReservation.version");
  return {
    version: 1,
    ...parseBinding(candidate, "pairingReservation"),
    reservationId: parseOperationId(candidate.reservationId, "pairingReservation.reservationId"),
  };
}

export function parsePublishPairingWelcomeRequest(value: unknown): PublishPairingWelcomeRequest {
  const candidate = object(value, "pairingWelcome");
  exact(candidate, "pairingWelcome", [
    "version",
    "installationId",
    "deviceId",
    "cryptoSessionId",
    "claimHash",
    "reservationId",
    "welcome",
    "welcomeHash",
  ]);
  requireVersion(candidate.version, "pairingWelcome.version");
  const welcome = decodeBase64(
    candidate.welcome,
    "pairingWelcome.welcome",
    PAIRING_WELCOME_MAX_BYTES,
  );
  const welcomeHash = decodeBase64(candidate.welcomeHash, "pairingWelcome.welcomeHash", 48);
  if (welcome.byteLength === 0 || welcomeHash.byteLength !== 48) {
    throw new TypeError("Pairing Welcome or hash has an invalid length");
  }
  return {
    ...parseReservePairingClaimRequest({
      version: 1,
      installationId: candidate.installationId,
      deviceId: candidate.deviceId,
      cryptoSessionId: candidate.cryptoSessionId,
      claimHash: candidate.claimHash,
      reservationId: candidate.reservationId,
    }),
    welcome,
    welcomeHash,
  };
}

export function parseFetchPairingWelcomeRequest(value: unknown): FetchPairingWelcomeRequest {
  const candidate = object(value, "pairingWelcomeFetch");
  exact(candidate, "pairingWelcomeFetch", [
    "version",
    "installationId",
    "deviceId",
    "cryptoSessionId",
    "claimHash",
  ]);
  requireVersion(candidate.version, "pairingWelcomeFetch.version");
  return { version: 1, ...parseBinding(candidate, "pairingWelcomeFetch") };
}

export function parseAcknowledgePairingWelcomeRequest(
  value: unknown,
): AcknowledgePairingWelcomeRequest {
  const candidate = object(value, "pairingWelcomeAcknowledgement");
  exact(candidate, "pairingWelcomeAcknowledgement", [
    "version",
    "installationId",
    "deviceId",
    "cryptoSessionId",
    "claimHash",
    "welcomeHash",
  ]);
  requireVersion(candidate.version, "pairingWelcomeAcknowledgement.version");
  const welcomeHash = decodeBase64(
    candidate.welcomeHash,
    "pairingWelcomeAcknowledgement.welcomeHash",
    48,
  );
  if (welcomeHash.byteLength !== 48) throw new TypeError("Welcome hash must contain 48 bytes");
  return {
    version: 1,
    ...parseBinding(candidate, "pairingWelcomeAcknowledgement"),
    welcomeHash,
  };
}

export function encodePairingReservation(value: PairingReservation): unknown {
  return {
    version: 1,
    reservationId: value.reservationId,
    claim: encodeBase64(value.claim),
    claimHash: encodeBase64(value.claimHash),
    expiresAt: timestamp(value.expiresAt, "pairingReservation.expiresAt"),
  };
}

export function encodePairingWelcomePublication(value: PairingWelcomePublication): unknown {
  return {
    version: 1,
    welcome: encodeBase64(value.welcome),
    welcomeHash: encodeBase64(value.welcomeHash),
    expiresAt: timestamp(value.expiresAt, "pairingWelcome.expiresAt"),
  };
}

function linkId(value: unknown, path: string): Uint8Array {
  const bytes = decodeBase64(value, path, PAIRING_LINK_ID_BYTES);
  if (bytes.byteLength !== PAIRING_LINK_ID_BYTES) {
    throw new TypeError(`${path} must contain ${PAIRING_LINK_ID_BYTES} bytes`);
  }
  return bytes;
}

function sealed(value: unknown, path: string): Uint8Array {
  const bytes = decodeBase64(value, path, PAIRING_LINK_SEALED_MAX_BYTES);
  if (bytes.byteLength === 0) throw new TypeError(`${path} must not be empty`);
  return bytes;
}

export function parsePublishPairingLinkRequest(value: unknown): PublishPairingLinkRequest {
  const candidate = object(value, "pairingLink");
  exact(candidate, "pairingLink", ["version", "linkId", "sealed", "expiresAt"]);
  requireVersion(candidate.version, "pairingLink.version");
  return {
    version: 1,
    linkId: linkId(candidate.linkId, "pairingLink.linkId"),
    sealed: sealed(candidate.sealed, "pairingLink.sealed"),
    expiresAt: timestamp(candidate.expiresAt, "pairingLink.expiresAt"),
  };
}

export function encodePublishPairingLinkRequest(value: PublishPairingLinkRequest): unknown {
  return {
    version: 1,
    linkId: encodeBase64(value.linkId),
    sealed: encodeBase64(value.sealed),
    expiresAt: timestamp(value.expiresAt, "pairingLink.expiresAt"),
  };
}

export function parseFetchPairingLinkRequest(value: unknown): FetchPairingLinkRequest {
  const candidate = object(value, "pairingLinkFetch");
  exact(candidate, "pairingLinkFetch", ["version", "linkId"]);
  requireVersion(candidate.version, "pairingLinkFetch.version");
  return { version: 1, linkId: linkId(candidate.linkId, "pairingLinkFetch.linkId") };
}

export function parsePairingLinkPublication(value: unknown): PairingLinkPublication {
  const candidate = object(value, "pairingLinkPublication");
  exact(candidate, "pairingLinkPublication", ["version", "sealed", "expiresAt"]);
  requireVersion(candidate.version, "pairingLinkPublication.version");
  return {
    version: 1,
    sealed: sealed(candidate.sealed, "pairingLinkPublication.sealed"),
    expiresAt: timestamp(candidate.expiresAt, "pairingLinkPublication.expiresAt"),
  };
}

export function encodePairingLinkPublication(value: PairingLinkPublication): unknown {
  return {
    version: 1,
    sealed: encodeBase64(value.sealed),
    expiresAt: timestamp(value.expiresAt, "pairingLinkPublication.expiresAt"),
  };
}
