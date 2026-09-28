// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-device identity for remote devices.
 *
 * Every pairing gets a fresh device ID. The daemon invites that ID with the digest of a one-time
 * enrollment secret it hands the device out of band (in the pairing link). The device creates its
 * own P-256 key, which never leaves it, and enrolls the public key with the secret. From then on a
 * relay ticket for that device is admitted only with a signature by that key over the ticket and a
 * fresh connection nonce, so one device's credentials cannot admit another and a copied link
 * cannot enroll a second key.
 */

import {
  type DeviceId,
  decodeBase64,
  encodeBase64,
  type InstallationId,
  parseDeviceId,
  parseInstallationId,
} from "./remote-transport.ts";

export const REMOTE_DEVICE_INVITATION_PATH = "/v1/devices/invitations";
export const REMOTE_DEVICE_ENROLLMENT_PATH = "/v1/devices/enroll";
export const REMOTE_DEVICE_REVOCATION_PATH = "/v1/devices/revoke";
/** A signed-in daemon registers its installation's own P-256 key here. */
export const REMOTE_INSTALLATION_REGISTRATION_PATH = "/v1/installations/register";
export const REMOTE_DEVICE_ENROLLMENT_SECRET_BYTES = 32;
export const REMOTE_DEVICE_SECRET_DIGEST_BYTES = 32;
/** An invited device must enroll within this window, the lifetime of a pairing invitation. */
export const REMOTE_DEVICE_ENROLLMENT_WINDOW_MS = 10 * 60_000;
/** A P-256 SubjectPublicKeyInfo is 91 bytes; the bound leaves room without admitting junk. */
export const REMOTE_DEVICE_PUBLIC_KEY_MAX_BYTES = 256;
/** ECDSA P-256 with SHA-256 in the fixed-width r || s form WebCrypto produces. */
export const REMOTE_DEVICE_PROOF_BYTES = 64;

const POSSESSION_DOMAIN = "Axl relay possession v1";

export interface RemoteDeviceInvitationRequest {
  readonly version: 1;
  readonly installationId: InstallationId;
  readonly deviceId: DeviceId;
  /** SHA-256 of the enrollment secret; the secret itself never reaches the control plane early. */
  readonly secretDigest: Uint8Array;
}

export interface RemoteDeviceEnrollmentRequest {
  readonly version: 1;
  readonly installationId: InstallationId;
  readonly deviceId: DeviceId;
  readonly secret: Uint8Array;
  /** DER SubjectPublicKeyInfo of the device's P-256 key. */
  readonly publicKey: Uint8Array;
}

export interface RemoteInstallationRegistrationRequest {
  readonly version: 1;
  readonly installationId: InstallationId;
  /** DER SubjectPublicKeyInfo of the daemon installation's P-256 key. */
  readonly publicKey: Uint8Array;
}

export interface RemoteDeviceRevocationRequest {
  readonly version: 1;
  readonly installationId: InstallationId;
  readonly deviceId: DeviceId;
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

function requireVersion(value: unknown, path: string): void {
  if (value !== 1) throw new TypeError(`${path} must equal 1`);
}

function sized(value: unknown, path: string, bytes: number): Uint8Array {
  const decoded = decodeBase64(value, path, bytes);
  if (decoded.byteLength !== bytes) throw new TypeError(`${path} must be ${bytes} bytes`);
  return decoded;
}

function identity(candidate: Record<string, unknown>, path: string) {
  return {
    installationId: parseInstallationId(candidate.installationId, `${path}.installationId`),
    deviceId: parseDeviceId(candidate.deviceId, `${path}.deviceId`),
  };
}

export function parseRemoteDeviceInvitationRequest(value: unknown): RemoteDeviceInvitationRequest {
  const candidate = object(value, "deviceInvitation");
  exact(candidate, "deviceInvitation", ["version", "installationId", "deviceId", "secretDigest"]);
  requireVersion(candidate.version, "deviceInvitation.version");
  return {
    version: 1,
    ...identity(candidate, "deviceInvitation"),
    secretDigest: sized(
      candidate.secretDigest,
      "deviceInvitation.secretDigest",
      REMOTE_DEVICE_SECRET_DIGEST_BYTES,
    ),
  };
}

export function encodeRemoteDeviceInvitationRequest(
  request: RemoteDeviceInvitationRequest,
): Record<string, unknown> {
  return {
    version: 1,
    installationId: request.installationId,
    deviceId: request.deviceId,
    secretDigest: encodeBase64(request.secretDigest),
  };
}

export function parseRemoteDeviceEnrollmentRequest(value: unknown): RemoteDeviceEnrollmentRequest {
  const candidate = object(value, "deviceEnrollment");
  exact(candidate, "deviceEnrollment", [
    "version",
    "installationId",
    "deviceId",
    "secret",
    "publicKey",
  ]);
  requireVersion(candidate.version, "deviceEnrollment.version");
  const publicKey = decodeBase64(
    candidate.publicKey,
    "deviceEnrollment.publicKey",
    REMOTE_DEVICE_PUBLIC_KEY_MAX_BYTES,
  );
  if (publicKey.byteLength === 0) throw new TypeError("deviceEnrollment.publicKey is empty");
  return {
    version: 1,
    ...identity(candidate, "deviceEnrollment"),
    secret: sized(
      candidate.secret,
      "deviceEnrollment.secret",
      REMOTE_DEVICE_ENROLLMENT_SECRET_BYTES,
    ),
    publicKey,
  };
}

export function encodeRemoteDeviceEnrollmentRequest(
  request: RemoteDeviceEnrollmentRequest,
): Record<string, unknown> {
  return {
    version: 1,
    installationId: request.installationId,
    deviceId: request.deviceId,
    secret: encodeBase64(request.secret),
    publicKey: encodeBase64(request.publicKey),
  };
}

export function parseRemoteInstallationRegistrationRequest(
  value: unknown,
): RemoteInstallationRegistrationRequest {
  const candidate = object(value, "installationRegistration");
  exact(candidate, "installationRegistration", ["version", "installationId", "publicKey"]);
  requireVersion(candidate.version, "installationRegistration.version");
  const publicKey = decodeBase64(
    candidate.publicKey,
    "installationRegistration.publicKey",
    REMOTE_DEVICE_PUBLIC_KEY_MAX_BYTES,
  );
  if (publicKey.byteLength === 0)
    throw new TypeError("installationRegistration.publicKey is empty");
  return {
    version: 1,
    installationId: parseInstallationId(
      candidate.installationId,
      "installationRegistration.installationId",
    ),
    publicKey,
  };
}

export function encodeRemoteInstallationRegistrationRequest(
  request: RemoteInstallationRegistrationRequest,
): Record<string, unknown> {
  return {
    version: 1,
    installationId: request.installationId,
    publicKey: encodeBase64(request.publicKey),
  };
}

export function parseRemoteDeviceRevocationRequest(value: unknown): RemoteDeviceRevocationRequest {
  const candidate = object(value, "deviceRevocation");
  exact(candidate, "deviceRevocation", ["version", "installationId", "deviceId"]);
  requireVersion(candidate.version, "deviceRevocation.version");
  return { version: 1, ...identity(candidate, "deviceRevocation") };
}

export function encodeRemoteDeviceRevocationRequest(
  request: RemoteDeviceRevocationRequest,
): Record<string, unknown> {
  return { version: 1, installationId: request.installationId, deviceId: request.deviceId };
}

/**
 * The bytes a device signs to be admitted with one relay ticket:
 * `"Axl relay possession v1" || 0x00 || ticket || 0x00 || connectionNonce`, all UTF-8. Tickets
 * are base64url and nonces are bounded printable strings, so the separators are unambiguous.
 */
export function remoteDevicePossessionMessage(ticket: string, connectionNonce: string): Uint8Array {
  if (ticket.length === 0 || ticket.includes("\0") || connectionNonce.includes("\0")) {
    throw new TypeError("Possession message parts must be non-empty and contain no NUL");
  }
  if (connectionNonce.length === 0) throw new TypeError("Connection nonce must not be empty");
  const encoder = new TextEncoder();
  const parts = [
    encoder.encode(POSSESSION_DOMAIN),
    encoder.encode(ticket),
    encoder.encode(connectionNonce),
  ];
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0) + 2);
  let offset = 0;
  parts.forEach((part, index) => {
    if (index > 0) output[offset++] = 0;
    output.set(part, offset);
    offset += part.byteLength;
  });
  return output;
}
