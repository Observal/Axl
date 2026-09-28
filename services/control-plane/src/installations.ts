// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * Daemon installations of an account. A daemon that signs in creates an installation ID and its
 * own P-256 key, and registers the public key under its account. From then on a daemon relay
 * ticket for that installation is admitted only with a signature by that key, the same possession
 * proof a device gives, so no daemon shares a credential with another.
 */

import { createPublicKey, type KeyObject, verify } from "node:crypto";

import {
  type ConsumeRelayTicketRequest,
  type InstallationId,
  parseRemoteInstallationRegistrationRequest,
  REMOTE_DEVICE_PROOF_BYTES,
  remoteDevicePossessionMessage,
} from "@axl/protocol";

import { RemoteDeviceError } from "./devices.ts";
import type { AccountPrincipal, Clock, RelayTicketRecord } from "./tickets.ts";

export interface RemoteInstallationRecord {
  readonly accountId: string;
  readonly installationId: InstallationId;
  /** Base64 DER SubjectPublicKeyInfo of the daemon's P-256 key. */
  readonly publicKey: string;
  readonly registeredAt: number;
}

export interface RemoteInstallationStore {
  get(installationId: InstallationId): Promise<Readonly<RemoteInstallationRecord> | undefined>;
  /** Store `record` unless its installation is taken; returns the record already stored. */
  create(record: RemoteInstallationRecord): Promise<Readonly<RemoteInstallationRecord> | undefined>;
}

export class InMemoryRemoteInstallationStore implements RemoteInstallationStore {
  readonly #records = new Map<string, RemoteInstallationRecord>();

  async get(installationId: InstallationId) {
    return this.#records.get(installationId);
  }

  async create(record: RemoteInstallationRecord) {
    const existing = this.#records.get(record.installationId);
    if (existing !== undefined) return existing;
    this.#records.set(record.installationId, record);
    return undefined;
  }
}

function installationKey(bytes: Uint8Array): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(bytes), format: "der", type: "spki" });
  } catch {
    throw new RemoteDeviceError("invalid_device_key", "The installation key is not a public key");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new RemoteDeviceError("invalid_device_key", "The installation key must be a P-256 key");
  }
  return key;
}

export class RemoteInstallationService {
  readonly #store: RemoteInstallationStore;
  readonly #clock: Clock;

  constructor(options: { readonly store: RemoteInstallationStore; readonly clock?: Clock }) {
    this.#store = options.store;
    this.#clock = options.clock ?? { now: () => Date.now() };
  }

  /**
   * Register a daemon installation's key. Registering the same key again succeeds; an
   * installation already registered with another key, or by another account, is refused.
   */
  async register(principal: AccountPrincipal, value: unknown): Promise<void> {
    if (principal.scope === "phone") {
      throw new RemoteDeviceError("installation_conflict", "A phone cannot register a daemon");
    }
    const request = parseRemoteInstallationRegistrationRequest(value);
    installationKey(request.publicKey);
    const publicKey = Buffer.from(request.publicKey).toString("base64");
    const existing = await this.#store.create({
      accountId: principal.accountId,
      installationId: request.installationId,
      publicKey,
      registeredAt: this.#clock.now(),
    });
    if (
      existing !== undefined &&
      (existing.accountId !== principal.accountId || existing.publicKey !== publicKey)
    ) {
      throw new RemoteDeviceError(
        "installation_conflict",
        "This installation is registered with another key",
      );
    }
  }

  /** Whether `installationId` is registered to the principal's account. */
  async owns(principal: AccountPrincipal, installationId: InstallationId): Promise<boolean> {
    return (await this.#store.get(installationId))?.accountId === principal.accountId;
  }

  /** Whether a daemon ticket's possession proof is a signature by the installation's key. */
  async verifyPossession(
    ticket: Readonly<RelayTicketRecord>,
    request: ConsumeRelayTicketRequest,
  ): Promise<boolean> {
    if (
      ticket.role !== "daemon" ||
      request.possessionProof.byteLength !== REMOTE_DEVICE_PROOF_BYTES
    ) {
      return false;
    }
    const record = await this.#store.get(ticket.installationId);
    if (record === undefined || record.accountId !== ticket.accountId) return false;
    try {
      return verify(
        "sha256",
        remoteDevicePossessionMessage(request.ticket, request.connectionNonce),
        {
          key: installationKey(Buffer.from(record.publicKey, "base64")),
          dsaEncoding: "ieee-p1363",
        },
        request.possessionProof,
      );
    } catch {
      return false;
    }
  }
}
