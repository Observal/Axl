// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  defaultRelayLimits,
  parseIssueRelayTicketRequest,
  parseIssueRelayTicketResult,
  parseRelayLimits,
  parseRouteId,
  RELAY_CONNECTION_LEASE_MS,
  RELAY_TICKET_LIFETIME_MS,
  type ConsumeRelayTicketRequest,
  type ConsumeRelayTicketResult,
  type IssueRelayTicketRequest,
  type IssueRelayTicketResult,
  type RelayLimits,
} from "@axl/protocol";

export interface AccountPrincipal {
  readonly accountId: string;
}

export interface Clock {
  now(): number;
}

export interface RelayTicketAuthorizer {
  currentGeneration(
    principal: AccountPrincipal,
    request: IssueRelayTicketRequest,
  ): Promise<number | undefined>;
}

export interface RelayTicketProofVerifier {
  verify(ticket: Readonly<RelayTicketRecord>, request: ConsumeRelayTicketRequest): Promise<boolean>;
}

export interface RelayTicketRecord extends IssueRelayTicketRequest {
  readonly accountId: string;
  readonly grantGeneration: number;
  readonly ticketDigest: string;
  readonly sourceRouteId: ConsumeRelayTicketResult["sourceRouteId"];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly limits: RelayLimits;
  consumedAt?: number;
  consumedByRelayInstanceId?: string;
}

export interface RelayTicketStore {
  insert(record: RelayTicketRecord): Promise<void>;
  find(ticketDigest: string): Promise<Readonly<RelayTicketRecord> | undefined>;
  /** Atomically returns and marks one unexpired ticket as consumed. */
  consume(
    ticketDigest: string,
    relayInstanceId: string,
    now: number,
  ): Promise<Readonly<RelayTicketRecord>>;
}

export type RelayTicketErrorCode =
  | "unauthorized"
  | "forbidden_route"
  | "ticket_expired"
  | "ticket_consumed"
  | "ticket_revoked"
  | "service_unavailable";

export class RelayTicketError extends Error {
  readonly code: RelayTicketErrorCode;
  readonly httpStatus: number;

  constructor(code: RelayTicketErrorCode, message: string, httpStatus: number) {
    super(message);
    this.name = "RelayTicketError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class InMemoryRelayTicketStore implements RelayTicketStore {
  private readonly records = new Map<string, RelayTicketRecord>();

  async insert(record: RelayTicketRecord): Promise<void> {
    if (this.records.has(record.ticketDigest)) throw new Error("Relay ticket digest collision");
    this.records.set(record.ticketDigest, record);
  }

  async find(ticketDigest: string): Promise<Readonly<RelayTicketRecord> | undefined> {
    return this.records.get(ticketDigest);
  }

  async consume(
    ticketDigest: string,
    relayInstanceId: string,
    now: number,
  ): Promise<Readonly<RelayTicketRecord>> {
    const record = this.records.get(ticketDigest);
    if (record === undefined) {
      throw new RelayTicketError("unauthorized", "Relay ticket is invalid", 401);
    }
    if (record.expiresAt <= now) {
      throw new RelayTicketError("ticket_expired", "Relay ticket has expired", 401);
    }
    if (record.consumedAt !== undefined) {
      throw new RelayTicketError("ticket_consumed", "Relay ticket has already been consumed", 409);
    }
    record.consumedAt = now;
    record.consumedByRelayInstanceId = relayInstanceId;
    return record;
  }
}

export interface RelayTicketServiceOptions {
  readonly store: RelayTicketStore;
  readonly authorizer: RelayTicketAuthorizer;
  readonly proofVerifier: RelayTicketProofVerifier;
  readonly relayUrl: string;
  readonly clock?: Clock;
  /** Overrides the per-role defaults for both roles. */
  readonly limits?: RelayLimits;
  /** Window in which an issued ticket must be consumed. */
  readonly ticketLifetimeMs?: number;
  /** Hard deadline of the admitted connection, measured from consumption. */
  readonly connectionLeaseMs?: number;
  readonly randomToken?: () => string;
  readonly randomId?: () => string;
}

const MAX_CONNECTION_LEASE_MS = 24 * 60 * 60_000;

function digestTicket(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

export class RelayTicketService {
  private readonly options: RelayTicketServiceOptions;
  private readonly clock: Clock;
  private readonly limits: RelayLimits | undefined;
  private readonly ticketLifetimeMs: number;
  private readonly connectionLeaseMs: number;
  private readonly randomToken: () => string;
  private readonly randomId: () => string;

  constructor(options: RelayTicketServiceOptions) {
    this.options = options;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.limits = options.limits === undefined ? undefined : parseRelayLimits(options.limits);
    this.ticketLifetimeMs = options.ticketLifetimeMs ?? RELAY_TICKET_LIFETIME_MS;
    this.connectionLeaseMs = options.connectionLeaseMs ?? RELAY_CONNECTION_LEASE_MS;
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
    this.randomId = options.randomId ?? randomUUID;
    if (
      !Number.isSafeInteger(this.ticketLifetimeMs) ||
      this.ticketLifetimeMs <= 0 ||
      this.ticketLifetimeMs > RELAY_TICKET_LIFETIME_MS
    ) {
      throw new TypeError(`Ticket lifetime must be from 1 through ${RELAY_TICKET_LIFETIME_MS} ms`);
    }
    if (
      !Number.isSafeInteger(this.connectionLeaseMs) ||
      this.connectionLeaseMs < this.ticketLifetimeMs ||
      this.connectionLeaseMs > MAX_CONNECTION_LEASE_MS
    ) {
      throw new TypeError(
        `Connection lease must be from the ticket lifetime through ${MAX_CONNECTION_LEASE_MS} ms`,
      );
    }
  }

  async issue(principal: AccountPrincipal, value: unknown): Promise<IssueRelayTicketResult> {
    const request = parseIssueRelayTicketRequest(value);
    const grantGeneration = await this.options.authorizer.currentGeneration(principal, request);
    if (grantGeneration === undefined) {
      throw new RelayTicketError("forbidden_route", "Principal cannot access this route", 403);
    }
    if (!Number.isSafeInteger(grantGeneration) || grantGeneration <= 0) {
      throw new Error("Grant generation must be a positive safe integer");
    }
    const now = this.clock.now();
    const ticket = this.randomToken();
    const record: RelayTicketRecord = {
      ...request,
      accountId: principal.accountId,
      grantGeneration,
      ticketDigest: digestTicket(ticket),
      sourceRouteId: parseRouteId(this.randomId(), "sourceRouteId"),
      issuedAt: now,
      expiresAt: now + this.ticketLifetimeMs,
      limits: this.limits ?? defaultRelayLimits(request.role),
    };
    await this.options.store.insert(record);
    return parseIssueRelayTicketResult({
      ticket,
      relayUrl: this.options.relayUrl,
      expiresAt: record.expiresAt,
      proofSchemeVersion: 1,
      limits: record.limits,
    });
  }

  async consume(request: ConsumeRelayTicketRequest): Promise<ConsumeRelayTicketResult> {
    const ticketDigest = digestTicket(request.ticket);
    const candidate = await this.options.store.find(ticketDigest);
    if (candidate === undefined) {
      throw new RelayTicketError("unauthorized", "Relay ticket is invalid", 401);
    }
    if (!(await this.options.proofVerifier.verify(candidate, request))) {
      throw new RelayTicketError("unauthorized", "Possession proof is invalid", 401);
    }
    const currentGeneration = await this.options.authorizer.currentGeneration(
      { accountId: candidate.accountId },
      candidate,
    );
    if (currentGeneration === undefined || currentGeneration !== candidate.grantGeneration) {
      throw new RelayTicketError("ticket_revoked", "Relay ticket grant is no longer current", 401);
    }
    const consumedAt = this.clock.now();
    const consumed = await this.options.store.consume(
      ticketDigest,
      request.relayInstanceId,
      consumedAt,
    );
    return {
      installationId: consumed.installationId,
      ...(consumed.deviceId === undefined ? {} : { deviceId: consumed.deviceId }),
      sourceRouteId: consumed.sourceRouteId,
      role: consumed.role,
      grantGeneration: consumed.grantGeneration,
      // The ticket only bounds admission; the connection gets its own lease from consumption.
      leaseExpiresAt: consumedAt + this.connectionLeaseMs,
      limits: consumed.limits,
    };
  }
}
