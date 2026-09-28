// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import { createHash, createPublicKey, type KeyObject, timingSafeEqual, verify } from "node:crypto";

import {
  type ConsumeRelayTicketRequest,
  type DeviceId,
  type InstallationId,
  parseRemoteDeviceEnrollmentRequest,
  parseRemoteDeviceInvitationRequest,
  parseRemoteDeviceRevocationRequest,
  REMOTE_DEVICE_ENROLLMENT_WINDOW_MS,
  REMOTE_DEVICE_PROOF_BYTES,
  remoteDevicePossessionMessage,
} from "@axl/protocol";

import type { AccountPrincipal, Clock, RelayTicketRecord } from "./tickets.ts";

/** One remote device of one installation, from invitation through enrollment to revocation. */
export interface RemoteDeviceRecord {
  readonly accountId: string;
  readonly installationId: InstallationId;
  readonly deviceId: DeviceId;
  /** Hex SHA-256 of the one-time enrollment secret. */
  readonly secretDigest: string;
  readonly invitedAt: number;
  readonly enrollBy: number;
  /** Base64 DER SubjectPublicKeyInfo of the device's P-256 key, once enrolled. */
  readonly publicKey?: string;
  readonly enrolledAt?: number;
  readonly revokedAt?: number;
  /** Starts at 1 and increases with every write. */
  readonly revision: number;
}

export interface RemoteDeviceStore {
  get(
    accountId: string,
    installationId: InstallationId,
    deviceId: DeviceId,
  ): Promise<Readonly<RemoteDeviceRecord> | undefined>;
  /**
   * Store `record` only if the stored revision is `expectedRevision` (0 when absent). Returns
   * false when another writer got there first.
   */
  put(record: RemoteDeviceRecord, expectedRevision: number): Promise<boolean>;
}

export type RemoteDeviceErrorCode =
  | "device_conflict"
  | "device_not_found"
  | "device_revoked"
  | "enrollment_expired"
  | "enrollment_denied"
  | "invalid_device_key";

const STATUS: Readonly<Record<RemoteDeviceErrorCode, number>> = {
  device_conflict: 409,
  device_not_found: 404,
  device_revoked: 403,
  enrollment_expired: 410,
  enrollment_denied: 403,
  invalid_device_key: 400,
};

export class RemoteDeviceError extends Error {
  readonly code: RemoteDeviceErrorCode;
  readonly httpStatus: number;

  constructor(code: RemoteDeviceErrorCode, message: string) {
    super(message);
    this.name = "RemoteDeviceError";
    this.code = code;
    this.httpStatus = STATUS[code];
  }
}

export class InMemoryRemoteDeviceStore implements RemoteDeviceStore {
  readonly #records = new Map<string, RemoteDeviceRecord>();

  async get(
    accountId: string,
    installationId: InstallationId,
    deviceId: DeviceId,
  ): Promise<Readonly<RemoteDeviceRecord> | undefined> {
    return this.#records.get(`${accountId}/${installationId}/${deviceId}`);
  }

  async put(record: RemoteDeviceRecord, expectedRevision: number): Promise<boolean> {
    const key = `${record.accountId}/${record.installationId}/${record.deviceId}`;
    if ((this.#records.get(key)?.revision ?? 0) !== expectedRevision) return false;
    this.#records.set(key, record);
    return true;
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function devicePublicKey(bytes: Uint8Array): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(bytes), format: "der", type: "spki" });
  } catch {
    throw new RemoteDeviceError("invalid_device_key", "The device key is not a public key");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new RemoteDeviceError("invalid_device_key", "The device key must be a P-256 key");
  }
  return key;
}

export interface RemoteDeviceServiceOptions {
  readonly store: RemoteDeviceStore;
  readonly clock?: Clock;
}

/**
 * Invitation, enrollment, and revocation of remote devices, and the checks relay tickets use:
 * a device is authorized while enrolled and not revoked, and its possession proof must verify
 * against the key it enrolled.
 */
export class RemoteDeviceService {
  readonly #store: RemoteDeviceStore;
  readonly #clock: Clock;

  constructor(options: RemoteDeviceServiceOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? { now: () => Date.now() };
  }

  async invite(principal: AccountPrincipal, value: unknown): Promise<void> {
    const request = parseRemoteDeviceInvitationRequest(value);
    const secretDigest = Buffer.from(request.secretDigest).toString("hex");
    const existing = await this.#store.get(
      principal.accountId,
      request.installationId,
      request.deviceId,
    );
    if (existing !== undefined) {
      // A retried invitation is accepted; a different one for the same device ID is not.
      if (existing.secretDigest === secretDigest && existing.revokedAt === undefined) return;
      throw new RemoteDeviceError("device_conflict", "This device was already invited");
    }
    const now = this.#clock.now();
    const stored = await this.#store.put(
      {
        accountId: principal.accountId,
        installationId: request.installationId,
        deviceId: request.deviceId,
        secretDigest,
        invitedAt: now,
        enrollBy: now + REMOTE_DEVICE_ENROLLMENT_WINDOW_MS,
        revision: 1,
      },
      0,
    );
    if (!stored) throw new RemoteDeviceError("device_conflict", "This device was already invited");
  }

  async enroll(principal: AccountPrincipal, value: unknown): Promise<void> {
    const request = parseRemoteDeviceEnrollmentRequest(value);
    const publicKey = Buffer.from(request.publicKey).toString("base64");
    devicePublicKey(request.publicKey);
    const record = await this.#store.get(
      principal.accountId,
      request.installationId,
      request.deviceId,
    );
    if (record === undefined) {
      throw new RemoteDeviceError("device_not_found", "This device was not invited");
    }
    if (record.revokedAt !== undefined) {
      throw new RemoteDeviceError("device_revoked", "This device was removed");
    }
    const presented = Buffer.from(digest(request.secret), "hex");
    if (!timingSafeEqual(presented, Buffer.from(record.secretDigest, "hex"))) {
      throw new RemoteDeviceError("enrollment_denied", "The enrollment secret does not match");
    }
    if (record.publicKey !== undefined) {
      // The same key enrolling again is a retry; any other key is a second holder of the link.
      if (record.publicKey === publicKey) return;
      throw new RemoteDeviceError("device_conflict", "This device already enrolled another key");
    }
    const now = this.#clock.now();
    if (now > record.enrollBy) {
      throw new RemoteDeviceError("enrollment_expired", "The enrollment window has closed");
    }
    const stored = await this.#store.put(
      { ...record, publicKey, enrolledAt: now, revision: record.revision + 1 },
      record.revision,
    );
    if (!stored) {
      // Another enrollment raced this one; it succeeded only if it enrolled the same key.
      const current = await this.#store.get(
        principal.accountId,
        request.installationId,
        request.deviceId,
      );
      if (current?.publicKey !== publicKey || current.revokedAt !== undefined) {
        throw new RemoteDeviceError("device_conflict", "This device already enrolled another key");
      }
    }
  }

  async revoke(principal: AccountPrincipal, value: unknown): Promise<void> {
    const request = parseRemoteDeviceRevocationRequest(value);
    for (;;) {
      const record = await this.#store.get(
        principal.accountId,
        request.installationId,
        request.deviceId,
      );
      if (record === undefined) {
        throw new RemoteDeviceError("device_not_found", "This device was not invited");
      }
      if (record.revokedAt !== undefined) return;
      const next = { ...record, revokedAt: this.#clock.now(), revision: record.revision + 1 };
      if (await this.#store.put(next, record.revision)) return;
    }
  }

  /** The grant generation of an enrolled device, or undefined while it cannot use the relay. */
  async generation(
    principal: AccountPrincipal,
    installationId: InstallationId,
    deviceId: DeviceId,
  ): Promise<number | undefined> {
    const record = await this.#store.get(principal.accountId, installationId, deviceId);
    return record?.publicKey !== undefined && record.revokedAt === undefined ? 1 : undefined;
  }

  /** Whether a relay ticket's possession proof is a signature by the device's enrolled key. */
  async verifyPossession(
    ticket: Readonly<RelayTicketRecord>,
    request: ConsumeRelayTicketRequest,
  ): Promise<boolean> {
    if (ticket.role !== "device" || ticket.deviceId === undefined) return false;
    if (request.possessionProof.byteLength !== REMOTE_DEVICE_PROOF_BYTES) return false;
    const record = await this.#store.get(ticket.accountId, ticket.installationId, ticket.deviceId);
    if (record?.publicKey === undefined || record.revokedAt !== undefined) return false;
    try {
      return verify(
        "sha256",
        remoteDevicePossessionMessage(request.ticket, request.connectionNonce),
        {
          key: devicePublicKey(Buffer.from(record.publicKey, "base64")),
          dsaEncoding: "ieee-p1363",
        },
        request.possessionProof,
      );
    } catch {
      return false;
    }
  }
}
