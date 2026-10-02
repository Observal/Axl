// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-device identity for remote devices, on both ends.
 *
 * The daemon mints a device ID and a one-time enrollment secret for each pairing and invites the
 * ID with the secret's digest. The device creates its own P-256 key in WebCrypto, enrolls the
 * public half with the secret, and proves possession of the private half, which it never exports,
 * for every relay ticket. See `remote-devices.ts` in `@axl/protocol` for the wire contract.
 */

import {
  type DeviceId,
  encodeRemoteDeviceEnrollmentRequest,
  encodeRemoteDeviceInvitationRequest,
  encodeRemoteDeviceRevocationRequest,
  type InstallationId,
  REMOTE_DEVICE_ENROLLMENT_PATH,
  REMOTE_DEVICE_ENROLLMENT_SECRET_BYTES,
  REMOTE_DEVICE_INVITATION_PATH,
  REMOTE_DEVICE_PROOF_BYTES,
  REMOTE_DEVICE_REVOCATION_PATH,
  remoteDevicePossessionMessage,
} from "@axl/protocol";

import type { RelayPossessionProofProvider, RemoteFetch } from "./remote-relay.ts";

const SIGNING = { name: "ECDSA", hash: "SHA-256" } as const;

/** WebCrypto's CryptoKey, declared by shape so the SDK needs neither DOM nor Node types. */
export interface RemoteDeviceCryptoKey {
  readonly type: string;
  readonly extractable: boolean;
  readonly algorithm: unknown;
  readonly usages: readonly string[];
}

export interface RemoteDeviceCryptoKeyPair {
  readonly privateKey: RemoteDeviceCryptoKey;
  readonly publicKey: RemoteDeviceCryptoKey;
}

type SubtleKey = Parameters<typeof crypto.subtle.sign>[1];

export class RemoteDeviceIdentityError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "RemoteDeviceIdentityError";
    this.code = code;
    this.status = status;
  }
}

/** A fresh one-time enrollment secret for one pairing. */
export function createRemoteDeviceEnrollmentSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(REMOTE_DEVICE_ENROLLMENT_SECRET_BYTES));
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
}

/** A device's own signing key. The private half is a non-extractable WebCrypto key. */
export interface RemoteDeviceKey {
  readonly privateKey: RemoteDeviceCryptoKey;
  /** DER SubjectPublicKeyInfo of the public half. */
  readonly publicKey: Uint8Array;
}

/**
 * Create a device key. The returned pair can be kept in IndexedDB (browsers store CryptoKey
 * objects without exposing their bytes) and passed back to `remoteDeviceKeyFromPair`.
 */
export async function createRemoteDeviceKeyPair(): Promise<RemoteDeviceCryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ])) as RemoteDeviceCryptoKeyPair;
}

export async function remoteDeviceKeyFromPair(
  pair: RemoteDeviceCryptoKeyPair,
): Promise<RemoteDeviceKey> {
  if (pair.privateKey.extractable) {
    throw new TypeError("A remote device key must not be extractable");
  }
  return {
    privateKey: pair.privateKey,
    publicKey: new Uint8Array(
      await crypto.subtle.exportKey("spki", pair.publicKey as unknown as SubtleKey),
    ),
  };
}

/** Relay admission signed by the device key: a fresh nonce and a signature over it and the ticket. */
export function remoteDevicePossession(key: RemoteDeviceKey): RelayPossessionProofProvider {
  return {
    async create(ticket) {
      const connectionNonce = crypto.randomUUID();
      const possessionProof = new Uint8Array(
        await crypto.subtle.sign(
          SIGNING,
          key.privateKey as unknown as SubtleKey,
          remoteDevicePossessionMessage(ticket.ticket, connectionNonce).slice(),
        ),
      );
      if (possessionProof.byteLength !== REMOTE_DEVICE_PROOF_BYTES) {
        throw new RemoteDeviceIdentityError(
          "invalid_device_key",
          "The device key produced an unexpected signature",
          0,
        );
      }
      return { connectionNonce, possessionProof };
    },
  };
}

export interface RemoteDeviceControlPlaneOptions {
  readonly controlPlaneOrigin: string;
  readonly authenticationHeaders: () => Promise<Readonly<Record<string, string>>>;
  readonly fetch?: RemoteFetch;
}

/** The control-plane calls for inviting, enrolling, and revoking remote devices. */
export class RemoteDeviceControlPlane {
  readonly #origin: string;
  readonly #options: RemoteDeviceControlPlaneOptions;
  readonly #fetch: RemoteFetch;

  constructor(options: RemoteDeviceControlPlaneOptions) {
    const url = new URL(options.controlPlaneOrigin);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      throw new TypeError("The control-plane origin must be HTTPS without credentials");
    }
    this.#origin = url.origin;
    this.#options = options;
    const fetcher = options.fetch ?? (globalThis as { fetch?: RemoteFetch }).fetch;
    if (fetcher === undefined) throw new TypeError("A fetch implementation is required");
    // Browsers reject a global fetch invoked as a method of another object.
    this.#fetch = (input, init) => fetcher(input, init);
  }

  /** Daemon side: invite `deviceId`, which may then enroll one key with `secret`. */
  async invite(
    installationId: InstallationId,
    deviceId: DeviceId,
    secret: Uint8Array,
  ): Promise<void> {
    await this.#post(
      REMOTE_DEVICE_INVITATION_PATH,
      encodeRemoteDeviceInvitationRequest({
        version: 1,
        installationId,
        deviceId,
        secretDigest: await sha256(secret),
      }),
    );
  }

  /** Device side: enroll this device's key. A retry with the same key succeeds. */
  async enroll(
    installationId: InstallationId,
    deviceId: DeviceId,
    secret: Uint8Array,
    key: RemoteDeviceKey,
  ): Promise<void> {
    await this.#post(
      REMOTE_DEVICE_ENROLLMENT_PATH,
      encodeRemoteDeviceEnrollmentRequest({
        version: 1,
        installationId,
        deviceId,
        secret,
        publicKey: key.publicKey,
      }),
    );
  }

  /** Daemon side: stop `deviceId` from reaching the relay. Revoking twice is fine. */
  async revoke(installationId: InstallationId, deviceId: DeviceId): Promise<void> {
    await this.#post(
      REMOTE_DEVICE_REVOCATION_PATH,
      encodeRemoteDeviceRevocationRequest({ version: 1, installationId, deviceId }),
    );
  }

  async #post(path: string, body: unknown): Promise<void> {
    const response = await this.#fetch(`${this.#origin}${path}`, {
      method: "POST",
      headers: {
        ...(await this.#options.authenticationHeaders()),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (response.ok) return;
    const failure = (await response.json().catch(() => undefined)) as
      | { readonly error?: { readonly code?: unknown; readonly message?: unknown } }
      | undefined;
    const code = typeof failure?.error?.code === "string" ? failure.error.code : "request_failed";
    const message =
      typeof failure?.error?.message === "string"
        ? failure.error.message
        : `Device request failed with HTTP ${response.status}`;
    throw new RemoteDeviceIdentityError(code, message, response.status);
  }
}
