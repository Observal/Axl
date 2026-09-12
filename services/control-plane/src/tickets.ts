// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  DEFAULT_RELAY_LIMITS,
  parseIssueRelayTicketRequest,
  parseIssueRelayTicketResult,
  parseRelayLimits,
  parseRouteId,
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
  authorize(principal: AccountPrincipal, request: IssueRelayTicketRequest): Promise<boolean>;
}

export interface RelayTicketProofVerifier {
  verify(ticket: Readonly<RelayTicketRecord>, request: ConsumeRelayTicketRequest): Promise<boolean>;
}

export interface RelayTicketRecord extends IssueRelayTicketRequest {
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
  readonly limits?: RelayLimits;
  readonly ticketLifetimeMs?: number;
  readonly randomToken?: () => string;
  readonly randomId?: () => string;
}

function digestTicket(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

export class RelayTicketService {
  private readonly options: RelayTicketServiceOptions;
  private readonly clock: Clock;
  private readonly limits: RelayLimits;
  private readonly ticketLifetimeMs: number;
  private readonly randomToken: () => string;
  private readonly randomId: () => string;

  constructor(options: RelayTicketServiceOptions) {
    this.options = options;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.limits = parseRelayLimits(options.limits ?? DEFAULT_RELAY_LIMITS);
    this.ticketLifetimeMs = options.ticketLifetimeMs ?? RELAY_TICKET_LIFETIME_MS;
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
    this.randomId = options.randomId ?? randomUUID;
    if (
      !Number.isSafeInteger(this.ticketLifetimeMs) ||
      this.ticketLifetimeMs <= 0 ||
      this.ticketLifetimeMs > RELAY_TICKET_LIFETIME_MS
    ) {
      throw new TypeError(`Ticket lifetime must be from 1 through ${RELAY_TICKET_LIFETIME_MS} ms`);
    }
  }

  async issue(principal: AccountPrincipal, value: unknown): Promise<IssueRelayTicketResult> {
    const request = parseIssueRelayTicketRequest(value);
    if (!(await this.options.authorizer.authorize(principal, request))) {
      throw new RelayTicketError("forbidden_route", "Principal cannot access this route", 403);
    }
    const now = this.clock.now();
    const ticket = this.randomToken();
    const record: RelayTicketRecord = {
      ...request,
      ticketDigest: digestTicket(ticket),
      sourceRouteId: parseRouteId(this.randomId(), "sourceRouteId"),
      issuedAt: now,
      expiresAt: now + this.ticketLifetimeMs,
      limits: this.limits,
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
    const consumed = await this.options.store.consume(
      ticketDigest,
      request.relayInstanceId,
      this.clock.now(),
    );
    return {
      installationId: consumed.installationId,
      ...(consumed.deviceId === undefined ? {} : { deviceId: consumed.deviceId }),
      sourceRouteId: consumed.sourceRouteId,
      role: consumed.role,
      leaseExpiresAt: consumed.expiresAt,
      limits: consumed.limits,
    };
  }
}
