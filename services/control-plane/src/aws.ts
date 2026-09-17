// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  parseCryptoSessionId,
  parseDeviceId,
  parseInstallationId,
  parseRelayLimits,
  parseRouteId,
} from "@axl/protocol";
import { createRemoteJWKSet, jwtVerify } from "jose";

import type {
  PairingRendezvousRecord,
  PairingRendezvousStore,
  PairingRendezvousTransaction,
} from "./pairing.ts";
import type { PublicPrincipalAuthenticator } from "./server.ts";
import {
  type AccountPrincipal,
  RelayTicketError,
  type RelayTicketRecord,
  type RelayTicketStore,
} from "./tickets.ts";

const MAX_TOKEN_BYTES = 16 * 1024;

function requiredString(value: Record<string, unknown>, name: string): string {
  const result = value[name];
  if (typeof result !== "string" || result.length === 0)
    throw new Error(`Stored ${name} is invalid`);
  return result;
}

function requiredInteger(value: Record<string, unknown>, name: string): number {
  const result = value[name];
  if (!Number.isSafeInteger(result) || (result as number) < 0) {
    throw new Error(`Stored ${name} is invalid`);
  }
  return result as number;
}

function parseStoredTicket(serialized: string): RelayTicketRecord {
  const value: unknown = JSON.parse(serialized);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Stored relay ticket is invalid");
  }
  const record = value as Record<string, unknown>;
  const role = requiredString(record, "role");
  if (role !== "daemon" && role !== "device") throw new Error("Stored relay role is invalid");
  const device = record.deviceId;
  const consumedAt = record.consumedAt;
  const consumedBy = record.consumedByRelayInstanceId;
  return {
    installationId: parseInstallationId(requiredString(record, "installationId")),
    ...(device === undefined ? {} : { deviceId: parseDeviceId(device) }),
    role,
    accountId: requiredString(record, "accountId"),
    grantGeneration: requiredInteger(record, "grantGeneration"),
    ticketDigest: requiredString(record, "ticketDigest"),
    sourceRouteId: parseRouteId(requiredString(record, "sourceRouteId")),
    issuedAt: requiredInteger(record, "issuedAt"),
    expiresAt: requiredInteger(record, "expiresAt"),
    limits: parseRelayLimits(record.limits),
    ...(consumedAt === undefined ? {} : { consumedAt: requiredInteger(record, "consumedAt") }),
    ...(consumedBy === undefined
      ? {}
      : {
          consumedByRelayInstanceId: requiredString(record, "consumedByRelayInstanceId"),
        }),
  };
}

/** DynamoDB-backed one-use relay tickets. The raw bearer ticket is never stored. */
export class DynamoRelayTicketStore implements RelayTicketStore {
  readonly #client: DynamoDBClient;
  readonly #tableName: string;

  constructor(options: {
    readonly tableName: string;
    readonly client?: DynamoDBClient;
  }) {
    if (options.tableName.length === 0) throw new TypeError("DynamoDB table name is required");
    this.#tableName = options.tableName;
    this.#client = options.client ?? new DynamoDBClient({});
  }

  async insert(record: RelayTicketRecord): Promise<void> {
    try {
      await this.#client.send(
        new PutItemCommand({
          TableName: this.#tableName,
          ConditionExpression: "attribute_not_exists(pk)",
          Item: {
            pk: { S: `ticket#${record.ticketDigest}` },
            expiresAtSeconds: { N: String(Math.ceil(record.expiresAt / 1000)) },
            expiresAtMs: { N: String(record.expiresAt) },
            record: { S: JSON.stringify(record) },
          },
        }),
      );
    } catch (cause) {
      if (cause instanceof ConditionalCheckFailedException) {
        throw new Error("Relay ticket digest collision");
      }
      throw cause;
    }
  }

  async find(ticketDigest: string): Promise<Readonly<RelayTicketRecord> | undefined> {
    const result = await this.#client.send(
      new GetItemCommand({
        TableName: this.#tableName,
        Key: { pk: { S: `ticket#${ticketDigest}` } },
        ConsistentRead: true,
        ProjectionExpression: "#record",
        ExpressionAttributeNames: { "#record": "record" },
      }),
    );
    const serialized = result.Item?.record?.S;
    return serialized === undefined ? undefined : parseStoredTicket(serialized);
  }

  async consume(
    ticketDigest: string,
    relayInstanceId: string,
    now: number,
  ): Promise<Readonly<RelayTicketRecord>> {
    const current = await this.find(ticketDigest);
    if (current === undefined)
      throw new RelayTicketError("unauthorized", "Relay ticket is invalid", 401);
    if (current.expiresAt <= now) {
      throw new RelayTicketError("ticket_expired", "Relay ticket has expired", 401);
    }
    if (current.consumedAt !== undefined) {
      throw new RelayTicketError("ticket_consumed", "Relay ticket has already been consumed", 409);
    }
    const consumed: RelayTicketRecord = {
      ...current,
      consumedAt: now,
      consumedByRelayInstanceId: relayInstanceId,
    };
    try {
      await this.#client.send(
        new UpdateItemCommand({
          TableName: this.#tableName,
          Key: { pk: { S: `ticket#${ticketDigest}` } },
          ConditionExpression:
            "attribute_exists(pk) AND attribute_not_exists(consumedAt) AND expiresAtMs > :now",
          UpdateExpression: "SET consumedAt = :consumedAt, #record = :record",
          ExpressionAttributeNames: { "#record": "record" },
          ExpressionAttributeValues: {
            ":now": { N: String(now) },
            ":consumedAt": { N: String(now) },
            ":record": { S: JSON.stringify(consumed) },
          },
        }),
      );
    } catch (cause) {
      if (cause instanceof ConditionalCheckFailedException) {
        const latest = await this.find(ticketDigest);
        if (latest === undefined) {
          throw new RelayTicketError("unauthorized", "Relay ticket is invalid", 401);
        }
        if (latest.expiresAt <= now) {
          throw new RelayTicketError("ticket_expired", "Relay ticket has expired", 401);
        }
        throw new RelayTicketError(
          "ticket_consumed",
          "Relay ticket has already been consumed",
          409,
        );
      }
      throw cause;
    }
    return consumed;
  }
}

interface StoredPairingRecord {
  readonly key: string;
  readonly accountId: string;
  readonly installationId: string;
  readonly deviceId: string;
  readonly cryptoSessionId: string;
  readonly claim: string;
  readonly claimHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: PairingRendezvousRecord["state"];
  readonly reservationId?: string;
  readonly reservationExpiresAt?: number;
  readonly welcome?: string;
  readonly welcomeHash?: string;
}

function serializePairing(record: PairingRendezvousRecord): string {
  const {
    claim: _claim,
    claimHash: _claimHash,
    welcome: _welcome,
    welcomeHash: _welcomeHash,
    ...metadata
  } = record;
  const value: StoredPairingRecord = {
    ...metadata,
    claim: Buffer.from(record.claim).toString("base64"),
    claimHash: Buffer.from(record.claimHash).toString("base64"),
    ...(record.welcome === undefined
      ? {}
      : { welcome: Buffer.from(record.welcome).toString("base64") }),
    ...(record.welcomeHash === undefined
      ? {}
      : { welcomeHash: Buffer.from(record.welcomeHash).toString("base64") }),
  };
  return JSON.stringify(value);
}

function deserializePairing(value: string): PairingRendezvousRecord {
  const record = JSON.parse(value) as StoredPairingRecord;
  return {
    ...record,
    installationId: parseInstallationId(record.installationId),
    deviceId: parseDeviceId(record.deviceId),
    cryptoSessionId: parseCryptoSessionId(record.cryptoSessionId),
    claim: Buffer.from(record.claim, "base64"),
    claimHash: Buffer.from(record.claimHash, "base64"),
    ...(record.welcome === undefined ? {} : { welcome: Buffer.from(record.welcome, "base64") }),
    ...(record.welcomeHash === undefined
      ? {}
      : { welcomeHash: Buffer.from(record.welcomeHash, "base64") }),
  } as PairingRendezvousRecord;
}

/** Optimistically serialized pairing records backed by strongly consistent DynamoDB reads. */
export class DynamoPairingRendezvousStore implements PairingRendezvousStore {
  readonly #client: DynamoDBClient;
  readonly #tableName: string;

  constructor(options: {
    readonly tableName: string;
    readonly client?: DynamoDBClient;
  }) {
    if (options.tableName.length === 0) throw new TypeError("DynamoDB table name is required");
    this.#tableName = options.tableName;
    this.#client = options.client ?? new DynamoDBClient({});
  }

  async transact<T>(
    key: string,
    update: (current: PairingRendezvousRecord | undefined) => PairingRendezvousTransaction<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existing = await this.#client.send(
        new GetItemCommand({
          TableName: this.#tableName,
          Key: { pk: { S: `pairing#${key}` } },
          ConsistentRead: true,
        }),
      );
      const revision = Number(existing.Item?.revision?.N ?? "0");
      const serialized = existing.Item?.record?.S;
      const current = serialized === undefined ? undefined : deserializePairing(serialized);
      const result = update(current);
      if (result.next === undefined) return result.value;
      try {
        await this.#client.send(
          new PutItemCommand({
            TableName: this.#tableName,
            Item: {
              pk: { S: `pairing#${key}` },
              revision: { N: String(revision + 1) },
              expiresAtSeconds: {
                N: String(Math.ceil(result.next.expiresAt / 1000)),
              },
              record: { S: serializePairing(result.next) },
            },
            ConditionExpression:
              revision === 0 ? "attribute_not_exists(pk)" : "revision = :revision",
            ...(revision === 0
              ? {}
              : {
                  ExpressionAttributeValues: {
                    ":revision": { N: String(revision) },
                  },
                }),
          }),
        );
        return result.value;
      } catch (cause) {
        if (!(cause instanceof ConditionalCheckFailedException)) throw cause;
      }
    }
    throw new Error("Pairing rendezvous contention limit exceeded");
  }
}

/** OIDC bearer authentication for production control-plane requests. */
export class JwtPrincipalAuthenticator implements PublicPrincipalAuthenticator {
  readonly #issuer: string;
  readonly #audience: string;
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(options: { readonly issuer: string; readonly audience: string }) {
    this.#issuer = new URL(options.issuer).href.replace(/\/$/u, "");
    this.#audience = options.audience;
    this.#jwks = createRemoteJWKSet(new URL(`${this.#issuer}/.well-known/jwks.json`));
  }

  async authenticate(
    request: Parameters<PublicPrincipalAuthenticator["authenticate"]>[0],
  ): Promise<AccountPrincipal | undefined> {
    const header = request.headers.authorization;
    if (header === undefined || header.length > MAX_TOKEN_BYTES || !header.startsWith("Bearer ")) {
      return undefined;
    }
    try {
      const result = await jwtVerify(header.slice(7), this.#jwks, {
        issuer: this.#issuer,
        audience: this.#audience,
        algorithms: ["RS256", "ES256"],
      });
      return typeof result.payload.sub === "string" && result.payload.sub.length > 0
        ? { accountId: result.payload.sub }
        : undefined;
    } catch {
      return undefined;
    }
  }
}
