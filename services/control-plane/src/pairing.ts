// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  parseOperationId,
  type AcknowledgePairingWelcomeRequest,
  type FetchPairingWelcomeRequest,
  type PairingReservation,
  type PairingWelcomePublication,
  type PublishPairingClaimRequest,
  type PublishPairingWelcomeRequest,
  type ReservePairingClaimRequest,
} from "@axl/protocol";

import type { AccountPrincipal, Clock } from "./tickets.ts";

const CLAIM_LIFETIME_MS = 10 * 60 * 1000;
const RESERVATION_LIFETIME_MS = 60 * 1000;
const MAX_PAIRING_RECORDS = 10_000;

export type PairingRendezvousState = "available" | "reserved" | "welcome" | "consumed";

export interface PairingRendezvousRecord {
  readonly key: string;
  readonly accountId: string;
  readonly installationId: string;
  readonly deviceId: string;
  readonly cryptoSessionId: string;
  readonly claim: Uint8Array;
  readonly claimHash: Uint8Array;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: PairingRendezvousState;
  readonly reservationId?: string;
  readonly reservationExpiresAt?: number;
  readonly welcome?: Uint8Array;
  readonly welcomeHash?: Uint8Array;
}

export interface PairingRendezvousTransaction<T> {
  readonly value: T;
  readonly next?: PairingRendezvousRecord;
}

export interface PairingRendezvousStore {
  transact<T>(
    key: string,
    update: (current: PairingRendezvousRecord | undefined) => PairingRendezvousTransaction<T>,
  ): Promise<T>;
}

export class PairingRendezvousError extends Error {
  readonly code:
    | "conflict"
    | "expired"
    | "not_found"
    | "reservation_busy"
    | "reservation_invalid"
    | "unauthorized";
  readonly httpStatus: number;

  constructor(code: PairingRendezvousError["code"], message: string, httpStatus: number) {
    super(message);
    this.name = "PairingRendezvousError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class InMemoryPairingRendezvousStore implements PairingRendezvousStore {
  readonly #records = new Map<string, PairingRendezvousRecord>();
  #tail: Promise<void> = Promise.resolve();

  transact<T>(
    key: string,
    update: (current: PairingRendezvousRecord | undefined) => PairingRendezvousTransaction<T>,
  ): Promise<T> {
    const operation = this.#tail.then(() => {
      const result = update(this.#records.get(key));
      if (result.next !== undefined) {
        if (!this.#records.has(key) && this.#records.size >= MAX_PAIRING_RECORDS) {
          throw new PairingRendezvousError("conflict", "Pairing capacity has been reached", 503);
        }
        this.#records.set(key, cloneRecord(result.next));
      }
      return result.value;
    });
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

function cloneRecord(record: PairingRendezvousRecord): PairingRendezvousRecord {
  return {
    ...record,
    claim: record.claim.slice(),
    claimHash: record.claimHash.slice(),
    ...(record.welcome === undefined ? {} : { welcome: record.welcome.slice() }),
    ...(record.welcomeHash === undefined ? {} : { welcomeHash: record.welcomeHash.slice() }),
  };
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function hash(bytes: Uint8Array): Uint8Array {
  return createHash("sha384").update(bytes).digest();
}

function key(value: {
  readonly installationId: string;
  readonly deviceId: string;
  readonly cryptoSessionId: string;
}): string {
  return `${value.installationId}#${value.deviceId}#${value.cryptoSessionId}`;
}

function authorize(principal: AccountPrincipal, record: { readonly accountId: string }): void {
  if (principal.accountId !== record.accountId) {
    throw new PairingRendezvousError("unauthorized", "Pairing record is unavailable", 404);
  }
}

export class PairingRendezvousService {
  readonly #store: PairingRendezvousStore;
  readonly #clock: Clock;

  constructor(options: {
    readonly store: PairingRendezvousStore;
    readonly clock?: Clock;
  }) {
    this.#store = options.store;
    this.#clock = options.clock ?? { now: Date.now };
  }

  async publishClaim(
    principal: AccountPrincipal,
    request: PublishPairingClaimRequest,
  ): Promise<void> {
    if (!equal(hash(request.claim), request.claimHash)) {
      throw new PairingRendezvousError("conflict", "Pairing claim hash is invalid", 400);
    }
    const now = this.#clock.now();
    return this.#store.transact(key(request), (current) => {
      if (current !== undefined) {
        authorize(principal, current);
        if (equal(current.claimHash, request.claimHash) && equal(current.claim, request.claim)) {
          return { value: undefined };
        }
        throw new PairingRendezvousError("conflict", "Pairing claim is already bound", 409);
      }
      return {
        value: undefined,
        next: {
          key: key(request),
          accountId: principal.accountId,
          installationId: request.installationId,
          deviceId: request.deviceId,
          cryptoSessionId: request.cryptoSessionId,
          claim: request.claim.slice(),
          claimHash: request.claimHash.slice(),
          createdAt: now,
          expiresAt: now + CLAIM_LIFETIME_MS,
          state: "available",
        },
      };
    });
  }

  async reserveClaim(
    principal: AccountPrincipal,
    request: ReservePairingClaimRequest,
  ): Promise<PairingReservation> {
    const now = this.#clock.now();
    return this.#store.transact(key(request), (current) => {
      if (current === undefined)
        throw new PairingRendezvousError("not_found", "Pairing claim is unavailable", 404);
      authorize(principal, current);
      if (current.expiresAt <= now)
        throw new PairingRendezvousError("expired", "Pairing claim expired", 410);
      if (!equal(current.claimHash, request.claimHash)) {
        throw new PairingRendezvousError("conflict", "Pairing claim hash does not match", 409);
      }
      if (current.state === "consumed")
        throw new PairingRendezvousError("not_found", "Pairing claim is unavailable", 404);
      if (current.state === "welcome") {
        throw new PairingRendezvousError("conflict", "Pairing Welcome is already published", 409);
      }
      if (
        current.state === "reserved" &&
        current.reservationExpiresAt !== undefined &&
        current.reservationExpiresAt > now &&
        current.reservationId !== request.reservationId
      ) {
        throw new PairingRendezvousError("reservation_busy", "Pairing claim is reserved", 409);
      }
      const expiresAt = Math.min(current.expiresAt, now + RESERVATION_LIFETIME_MS);
      const next: PairingRendezvousRecord = {
        ...current,
        state: "reserved",
        reservationId: parseOperationId(request.reservationId),
        reservationExpiresAt: expiresAt,
      };
      return {
        value: {
          version: 1,
          reservationId: request.reservationId,
          claim: current.claim.slice(),
          claimHash: current.claimHash.slice(),
          expiresAt,
        },
        next,
      };
    });
  }

  async publishWelcome(
    principal: AccountPrincipal,
    request: PublishPairingWelcomeRequest,
  ): Promise<PairingWelcomePublication> {
    if (!equal(hash(request.welcome), request.welcomeHash)) {
      throw new PairingRendezvousError("conflict", "Pairing Welcome hash is invalid", 400);
    }
    const now = this.#clock.now();
    return this.#store.transact(key(request), (current) => {
      if (current === undefined)
        throw new PairingRendezvousError("not_found", "Pairing claim is unavailable", 404);
      authorize(principal, current);
      if (current.expiresAt <= now)
        throw new PairingRendezvousError("expired", "Pairing claim expired", 410);
      if (!equal(current.claimHash, request.claimHash)) {
        throw new PairingRendezvousError("conflict", "Pairing claim hash does not match", 409);
      }
      if (current.state === "welcome") {
        if (
          current.welcome !== undefined &&
          current.welcomeHash !== undefined &&
          equal(current.welcome, request.welcome) &&
          equal(current.welcomeHash, request.welcomeHash)
        ) {
          return { value: this.#publication(current) };
        }
        throw new PairingRendezvousError("conflict", "Pairing Welcome is already bound", 409);
      }
      if (
        current.state !== "reserved" ||
        current.reservationId !== request.reservationId ||
        current.reservationExpiresAt === undefined ||
        current.reservationExpiresAt <= now
      ) {
        throw new PairingRendezvousError(
          "reservation_invalid",
          "Pairing reservation is invalid",
          409,
        );
      }
      const next: PairingRendezvousRecord = {
        ...current,
        state: "welcome",
        welcome: request.welcome.slice(),
        welcomeHash: request.welcomeHash.slice(),
      };
      return { value: this.#publication(next), next };
    });
  }

  async fetchWelcome(
    principal: AccountPrincipal,
    request: FetchPairingWelcomeRequest,
  ): Promise<PairingWelcomePublication> {
    const now = this.#clock.now();
    return this.#store.transact(key(request), (current) => {
      if (current === undefined || current.state === "consumed") {
        throw new PairingRendezvousError("not_found", "Pairing Welcome is unavailable", 404);
      }
      authorize(principal, current);
      if (current.expiresAt <= now)
        throw new PairingRendezvousError("expired", "Pairing Welcome expired", 410);
      if (
        current.state !== "welcome" ||
        current.welcome === undefined ||
        current.welcomeHash === undefined ||
        !equal(current.claimHash, request.claimHash)
      ) {
        throw new PairingRendezvousError("not_found", "Pairing Welcome is unavailable", 404);
      }
      return { value: this.#publication(current) };
    });
  }

  async acknowledgeWelcome(
    principal: AccountPrincipal,
    request: AcknowledgePairingWelcomeRequest,
  ): Promise<void> {
    const now = this.#clock.now();
    return this.#store.transact(key(request), (current) => {
      if (current === undefined)
        throw new PairingRendezvousError("not_found", "Pairing Welcome is unavailable", 404);
      authorize(principal, current);
      if (current.state === "consumed") return { value: undefined };
      if (
        current.expiresAt <= now ||
        current.state !== "welcome" ||
        current.welcomeHash === undefined ||
        !equal(current.claimHash, request.claimHash) ||
        !equal(current.welcomeHash, request.welcomeHash)
      ) {
        throw new PairingRendezvousError("conflict", "Pairing acknowledgement does not match", 409);
      }
      const { welcome: _discardedWelcome, ...retained } = current;
      return {
        value: undefined,
        next: {
          ...retained,
          state: "consumed",
          claim: new Uint8Array(),
        },
      };
    });
  }

  #publication(record: PairingRendezvousRecord): PairingWelcomePublication {
    if (record.welcome === undefined || record.welcomeHash === undefined) {
      throw new PairingRendezvousError("not_found", "Pairing Welcome is unavailable", 404);
    }
    return {
      version: 1,
      welcome: record.welcome.slice(),
      welcomeHash: record.welcomeHash.slice(),
      expiresAt: record.expiresAt,
    };
  }
}
