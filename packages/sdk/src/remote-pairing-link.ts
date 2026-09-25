// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * The deployment-test pairing contract shared by the daemon host and the browser device.
 *
 * A pairing link opens the hosted device page. Everything the device needs travels in the URL
 * fragment, which browsers never send to a server: the daemon's pairing invitation, the identities
 * it binds (as base64url bytes, so the link fits a terminal QR code), and the deployment-test
 * stack's shared access credentials. Those credentials are
 * test-only; production pairing must not put credentials in a link. Replica trust is never part of
 * a link: the device verifies witness certificates only against trust pinned into its build.
 *
 * Before the MLS group exists the device tells the daemon which claim it published with a pairing
 * notice: a fixed magic, a version, and the 48-byte claim hash, sent over the relay route. The
 * notice is unauthenticated; the daemon uses it only to reserve that claim from the control plane
 * and then verifies the claim itself, so a forged notice cannot pair anything.
 */

import {
  type CryptoSessionId,
  type DeviceId,
  type InstallationId,
  parseCryptoSessionId,
  parseDeviceId,
  parseInstallationId,
} from "@axl/protocol";

export const REMOTE_PAIRING_LINK_VERSION = 1;
const MAX_INVITATION_BYTES = 2_048;
const MAX_TOKEN_CHARACTERS = 4_096;
const MAX_PROOF_BYTES = 1_024;
const NOTICE_MAGIC = Uint8Array.of(0x41, 0x58, 0x4c, 0x50);
const NOTICE_VERSION = 1;
const CLAIM_HASH_BYTES = 48;
export const REMOTE_PAIRING_NOTICE_BYTES = NOTICE_MAGIC.byteLength + 1 + CLAIM_HASH_BYTES;

export interface RemotePairingLink {
  readonly invitation: Uint8Array;
  readonly accountId: string;
  readonly installationId: InstallationId;
  readonly deviceId: DeviceId;
  readonly cryptoSessionId: CryptoSessionId;
  /** Deployment-test bearer token for the control plane, relay tickets, and witness. */
  readonly accessToken: string;
  /** Deployment-test relay possession proof. */
  readonly possessionProof: Uint8Array;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string | null, field: string, maximumBytes: number): Uint8Array {
  if (value === null || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError(`Pairing link ${field} is missing or malformed`);
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  if (binary.length === 0 || binary.length > maximumBytes) {
    throw new TypeError(`Pairing link ${field} is outside its bound`);
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function required(values: URLSearchParams, name: string): string {
  const value = values.get(name);
  if (value === null || value.length === 0) throw new TypeError(`Pairing link ${name} is missing`);
  return value;
}

/** A UUID carried as its 16 bytes in base64url. */
function uuidField(values: URLSearchParams, name: string, field: string): string {
  const bytes = fromBase64Url(values.get(name), field, 16);
  if (bytes.byteLength !== 16) throw new TypeError(`Pairing link ${field} is malformed`);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Build the pairing link for the hosted device page at `pageUrl` (an HTTPS URL, no fragment). */
export function encodeRemotePairingLink(pageUrl: string, link: RemotePairingLink): string {
  const url = new URL(pageUrl);
  if (url.protocol !== "https:" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new TypeError("The pairing page must be an HTTPS URL without a fragment or credentials");
  }
  if (link.invitation.byteLength === 0 || link.invitation.byteLength > MAX_INVITATION_BYTES) {
    throw new TypeError("The pairing invitation is outside its bound");
  }
  const values = new URLSearchParams({
    v: String(REMOTE_PAIRING_LINK_VERSION),
    i: base64Url(link.invitation),
    a: base64Url(uuidToBytes(link.accountId)),
    n: base64Url(uuidToBytes(link.installationId)),
    d: base64Url(uuidToBytes(link.deviceId)),
    s: base64Url(uuidToBytes(link.cryptoSessionId)),
    t: link.accessToken,
    p: base64Url(link.possessionProof),
  });
  url.hash = values.toString();
  return url.toString();
}

/** Parse the fragment of a pairing link (with or without its leading `#`). */
export function parseRemotePairingLink(fragment: string): RemotePairingLink {
  const values = new URLSearchParams(fragment.startsWith("#") ? fragment.slice(1) : fragment);
  if (values.get("v") !== String(REMOTE_PAIRING_LINK_VERSION)) {
    throw new TypeError("Pairing link version is unsupported");
  }
  const accessToken = required(values, "t");
  if (accessToken.length > MAX_TOKEN_CHARACTERS) {
    throw new TypeError("Pairing link token is outside its bound");
  }
  return {
    invitation: fromBase64Url(values.get("i"), "invitation", MAX_INVITATION_BYTES),
    accountId: uuidField(values, "a", "account"),
    installationId: parseInstallationId(uuidField(values, "n", "installation")),
    deviceId: parseDeviceId(uuidField(values, "d", "device")),
    cryptoSessionId: parseCryptoSessionId(uuidField(values, "s", "session")),
    accessToken,
    possessionProof: fromBase64Url(values.get("p"), "proof", MAX_PROOF_BYTES),
  };
}

/** The 16 bytes of a canonical UUID string. */
export function uuidToBytes(value: string): Uint8Array {
  const hex = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/u.test(hex)) throw new TypeError("Invalid UUID");
  return Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

export function encodeRemotePairingNotice(claimHash: Uint8Array): Uint8Array {
  if (claimHash.byteLength !== CLAIM_HASH_BYTES) {
    throw new TypeError("A pairing notice carries a 48-byte claim hash");
  }
  const output = new Uint8Array(REMOTE_PAIRING_NOTICE_BYTES);
  output.set(NOTICE_MAGIC, 0);
  output[NOTICE_MAGIC.byteLength] = NOTICE_VERSION;
  output.set(claimHash, NOTICE_MAGIC.byteLength + 1);
  return output;
}

/** The claim hash of a pairing notice, or undefined when the payload is not one. */
export function parseRemotePairingNotice(payload: Uint8Array): Uint8Array | undefined {
  if (
    payload.byteLength !== REMOTE_PAIRING_NOTICE_BYTES ||
    !NOTICE_MAGIC.every((byte, index) => payload[index] === byte) ||
    payload[NOTICE_MAGIC.byteLength] !== NOTICE_VERSION
  ) {
    return undefined;
  }
  return payload.slice(NOTICE_MAGIC.byteLength + 1);
}
