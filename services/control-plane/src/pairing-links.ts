// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * Short pairing links. The daemon seals its full pairing link with a key it keeps in the short
 * link's fragment and parks the ciphertext here under a random ID, so the QR code `/remote` prints
 * carries a few dozen bytes instead of the whole invitation. This service stores ciphertext only
 * and cannot open it; it bounds how long and how many links it keeps.
 *
 * Fetching is unauthenticated: the phone holds no credential until it opens the link, and the ID
 * is 128 random bits. Publishing needs the account's credential.
 */

import type {
  FetchPairingLinkRequest,
  PairingLinkPublication,
  PublishPairingLinkRequest,
} from "@axl/protocol";

import { PairingRendezvousError } from "./pairing.ts";
import type { AccountPrincipal, Clock } from "./tickets.ts";

/** A link outlives the invitation it carries by a little at most. */
export const PAIRING_LINK_LIFETIME_MS = 15 * 60 * 1000;
const MAX_IN_MEMORY_LINKS = 10_000;

export interface PairingLinkRecord {
  /** Lowercase hexadecimal link ID. */
  readonly linkId: string;
  readonly accountId: string;
  readonly sealed: Uint8Array;
  readonly expiresAt: number;
}

export interface PairingLinkStore {
  /** Store `record` unless its ID is taken; returns the record already stored under the ID. */
  create(record: PairingLinkRecord): Promise<PairingLinkRecord | undefined>;
  get(linkId: string): Promise<PairingLinkRecord | undefined>;
}

export class InMemoryPairingLinkStore implements PairingLinkStore {
  readonly #records = new Map<string, PairingLinkRecord>();
  readonly #clock: Clock;

  constructor(clock: Clock = { now: Date.now }) {
    this.#clock = clock;
  }

  async create(record: PairingLinkRecord): Promise<PairingLinkRecord | undefined> {
    const existing = this.#records.get(record.linkId);
    if (existing !== undefined) return { ...existing, sealed: existing.sealed.slice() };
    if (this.#records.size >= MAX_IN_MEMORY_LINKS) {
      const now = this.#clock.now();
      for (const [id, stored] of this.#records) {
        if (stored.expiresAt <= now) this.#records.delete(id);
      }
      if (this.#records.size >= MAX_IN_MEMORY_LINKS) {
        throw new PairingRendezvousError("conflict", "Pairing capacity has been reached", 503);
      }
    }
    this.#records.set(record.linkId, { ...record, sealed: record.sealed.slice() });
    return undefined;
  }

  async get(linkId: string): Promise<PairingLinkRecord | undefined> {
    const stored = this.#records.get(linkId);
    return stored === undefined ? undefined : { ...stored, sealed: stored.sealed.slice() };
  }
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export class PairingLinkService {
  readonly #store: PairingLinkStore;
  readonly #clock: Clock;

  constructor(options: { readonly store: PairingLinkStore; readonly clock?: Clock }) {
    this.#store = options.store;
    this.#clock = options.clock ?? { now: Date.now };
  }

  async publish(principal: AccountPrincipal, request: PublishPairingLinkRequest): Promise<void> {
    const now = this.#clock.now();
    const expiresAt = Math.min(request.expiresAt, now + PAIRING_LINK_LIFETIME_MS);
    if (expiresAt <= now) {
      throw new PairingRendezvousError("expired", "Pairing link has already expired", 400);
    }
    const record: PairingLinkRecord = {
      linkId: hex(request.linkId),
      accountId: principal.accountId,
      sealed: request.sealed.slice(),
      expiresAt,
    };
    const existing = await this.#store.create(record);
    // A retried publish of the same link succeeds; anything else under its ID is refused.
    if (
      existing !== undefined &&
      (existing.accountId !== record.accountId || !equal(existing.sealed, record.sealed))
    ) {
      throw new PairingRendezvousError("conflict", "Pairing link ID is already used", 409);
    }
  }

  async fetch(request: FetchPairingLinkRequest): Promise<PairingLinkPublication> {
    const record = await this.#store.get(hex(request.linkId));
    // An expired link and an unknown one look the same to the caller.
    if (record === undefined || record.expiresAt <= this.#clock.now()) {
      throw new PairingRendezvousError("not_found", "Pairing link is unavailable", 404);
    }
    return { version: 1, sealed: record.sealed.slice(), expiresAt: record.expiresAt };
  }
}
