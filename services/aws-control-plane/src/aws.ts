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
  type AccountPrincipal,
  type PairingLinkRecord,
  type PairingLinkStore,
  type PairingRendezvousRecord,
  type PairingRendezvousStore,
  type PairingRendezvousTransaction,
  type PublicPrincipalAuthenticator,
  RelayTicketError,
  type RelayTicketRecord,
  type RelayTicketStore,
  type RemoteDeviceRecord,
  type RemoteDeviceStore,
  type RemoteInstallationRecord,
  type RemoteInstallationStore,
} from "@axl/control-plane";
import {
  type DeviceId,
  type InstallationId,
  parseCryptoSessionId,
  parseDeviceId,
  parseInstallationId,
  parseRelayLimits,
  parseRouteId,
} from "@axl/protocol";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

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

/** Short pairing links: one write-once item each, removed by the table's TTL after expiry. */
export class DynamoPairingLinkStore implements PairingLinkStore {
  readonly #client: DynamoDBClient;
  readonly #tableName: string;

  constructor(options: { readonly tableName: string; readonly client?: DynamoDBClient }) {
    if (options.tableName.length === 0) throw new TypeError("DynamoDB table name is required");
    this.#tableName = options.tableName;
    this.#client = options.client ?? new DynamoDBClient({});
  }

  async create(record: PairingLinkRecord): Promise<PairingLinkRecord | undefined> {
    try {
      await this.#client.send(
        new PutItemCommand({
          TableName: this.#tableName,
          Item: {
            pk: { S: `pairing-link#${record.linkId}` },
            accountId: { S: record.accountId },
            sealed: { B: record.sealed },
            expiresAtMs: { N: String(record.expiresAt) },
            expiresAtSeconds: { N: String(Math.ceil(record.expiresAt / 1000)) },
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return undefined;
    } catch (cause) {
      if (!(cause instanceof ConditionalCheckFailedException)) throw cause;
    }
    const existing = await this.get(record.linkId);
    if (existing === undefined) throw new Error("Pairing link vanished while it was written");
    return existing;
  }

  async get(linkId: string): Promise<PairingLinkRecord | undefined> {
    const result = await this.#client.send(
      new GetItemCommand({
        TableName: this.#tableName,
        Key: { pk: { S: `pairing-link#${linkId}` } },
        ConsistentRead: true,
      }),
    );
    const item = result.Item;
    if (item === undefined) return undefined;
    const accountId = item.accountId?.S;
    const sealed = item.sealed?.B;
    const expiresAt = Number(item.expiresAtMs?.N);
    if (accountId === undefined || sealed === undefined || !Number.isSafeInteger(expiresAt)) {
      throw new Error("Stored pairing link is invalid");
    }
    return { linkId, accountId, sealed: new Uint8Array(sealed), expiresAt };
  }
}

function parseStoredDevice(serialized: string): RemoteDeviceRecord {
  const value: unknown = JSON.parse(serialized);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Stored remote device is invalid");
  }
  const record = value as Record<string, unknown>;
  const optional = (name: string) =>
    record[name] === undefined ? {} : { [name]: requiredInteger(record, name) };
  return {
    accountId: requiredString(record, "accountId"),
    installationId: parseInstallationId(requiredString(record, "installationId")),
    deviceId: parseDeviceId(requiredString(record, "deviceId")),
    secretDigest: requiredString(record, "secretDigest"),
    invitedAt: requiredInteger(record, "invitedAt"),
    enrollBy: requiredInteger(record, "enrollBy"),
    ...(record.publicKey === undefined ? {} : { publicKey: requiredString(record, "publicKey") }),
    ...optional("enrolledAt"),
    ...optional("revokedAt"),
    revision: requiredInteger(record, "revision"),
  };
}

/**
 * DynamoDB-backed remote devices, written with a revision condition. An invitation that is never
 * enrolled expires with the table's TTL a day after its window; enrolled devices do not expire.
 */
export class DynamoRemoteDeviceStore implements RemoteDeviceStore {
  readonly #client: DynamoDBClient;
  readonly #tableName: string;

  constructor(options: { readonly tableName: string; readonly client?: DynamoDBClient }) {
    if (options.tableName.length === 0) throw new TypeError("DynamoDB table name is required");
    this.#tableName = options.tableName;
    this.#client = options.client ?? new DynamoDBClient({});
  }

  #key(accountId: string, installationId: InstallationId, deviceId: DeviceId) {
    return { pk: { S: `device#${accountId}#${installationId}#${deviceId}` } };
  }

  async get(
    accountId: string,
    installationId: InstallationId,
    deviceId: DeviceId,
  ): Promise<Readonly<RemoteDeviceRecord> | undefined> {
    const result = await this.#client.send(
      new GetItemCommand({
        TableName: this.#tableName,
        Key: this.#key(accountId, installationId, deviceId),
        ConsistentRead: true,
      }),
    );
    const serialized = result.Item?.record?.S;
    return serialized === undefined ? undefined : parseStoredDevice(serialized);
  }

  async put(record: RemoteDeviceRecord, expectedRevision: number): Promise<boolean> {
    try {
      await this.#client.send(
        new PutItemCommand({
          TableName: this.#tableName,
          Item: {
            ...this.#key(record.accountId, record.installationId, record.deviceId),
            revision: { N: String(record.revision) },
            record: { S: JSON.stringify(record) },
            ...(record.publicKey === undefined
              ? { expiresAtSeconds: { N: String(Math.ceil(record.enrollBy / 1000) + 86_400) } }
              : {}),
          },
          ConditionExpression:
            expectedRevision === 0 ? "attribute_not_exists(pk)" : "revision = :revision",
          ...(expectedRevision === 0
            ? {}
            : { ExpressionAttributeValues: { ":revision": { N: String(expectedRevision) } } }),
        }),
      );
      return true;
    } catch (cause) {
      if (cause instanceof ConditionalCheckFailedException) return false;
      throw cause;
    }
  }
}

function parseStoredInstallation(serialized: string): RemoteInstallationRecord {
  const value: unknown = JSON.parse(serialized);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Stored remote installation is invalid");
  }
  const record = value as Record<string, unknown>;
  return {
    accountId: requiredString(record, "accountId"),
    installationId: parseInstallationId(requiredString(record, "installationId")),
    publicKey: requiredString(record, "publicKey"),
    registeredAt: requiredInteger(record, "registeredAt"),
  };
}

/** DynamoDB-backed daemon installations. A record is written once and never expires. */
export class DynamoRemoteInstallationStore implements RemoteInstallationStore {
  readonly #client: DynamoDBClient;
  readonly #tableName: string;

  constructor(options: { readonly tableName: string; readonly client?: DynamoDBClient }) {
    if (options.tableName.length === 0) throw new TypeError("DynamoDB table name is required");
    this.#tableName = options.tableName;
    this.#client = options.client ?? new DynamoDBClient({});
  }

  #key(installationId: InstallationId) {
    return { pk: { S: `installation#${installationId}` } };
  }

  async get(
    installationId: InstallationId,
  ): Promise<Readonly<RemoteInstallationRecord> | undefined> {
    const result = await this.#client.send(
      new GetItemCommand({
        TableName: this.#tableName,
        Key: this.#key(installationId),
        ConsistentRead: true,
      }),
    );
    const serialized = result.Item?.record?.S;
    return serialized === undefined ? undefined : parseStoredInstallation(serialized);
  }

  async create(
    record: RemoteInstallationRecord,
  ): Promise<Readonly<RemoteInstallationRecord> | undefined> {
    try {
      await this.#client.send(
        new PutItemCommand({
          TableName: this.#tableName,
          Item: { ...this.#key(record.installationId), record: { S: JSON.stringify(record) } },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return undefined;
    } catch (cause) {
      if (!(cause instanceof ConditionalCheckFailedException)) throw cause;
    }
    const existing = await this.get(record.installationId);
    if (existing === undefined) throw new Error("Remote installation vanished after a conflict");
    return existing;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Production accounts: people signed in through the Cognito user pool, with Google as the identity
 * provider. The account is the pool's `sub`, a UUID that also binds the account's witness lineages.
 *
 * Two app clients reach the control plane. The daemon's client (`axl remote login`) gets the full
 * account; the phone page's client gets the phone scope, which pairs and runs a device and never
 * reaches the daemon's routes. Remote access is opt-in per account: a token is accepted only when the
 * person is in the pool's remote group, so anyone may sign in and only those added may use it.
 */
export class CognitoAccountAuthenticator implements PublicPrincipalAuthenticator {
  readonly #issuer: string;
  readonly #daemonClientId: string;
  readonly #phoneClientId: string;
  readonly #group: string;
  readonly #keys: JWTVerifyGetKey;

  constructor(options: {
    /** `https://cognito-idp.<region>.amazonaws.com/<user pool ID>`. */
    readonly issuer: string;
    readonly daemonClientId: string;
    readonly phoneClientId: string;
    /** The Cognito group whose members may use remote access. */
    readonly group: string;
    /** The pool's signing keys; fetched from the issuer's JWKS when omitted. */
    readonly keys?: JWTVerifyGetKey;
  }) {
    if (
      options.daemonClientId.length === 0 ||
      options.phoneClientId.length === 0 ||
      options.daemonClientId === options.phoneClientId ||
      options.group.length === 0
    ) {
      throw new TypeError("Two distinct Cognito client IDs and a group are required");
    }
    this.#issuer = new URL(options.issuer).href.replace(/\/$/u, "");
    this.#daemonClientId = options.daemonClientId;
    this.#phoneClientId = options.phoneClientId;
    this.#group = options.group;
    this.#keys =
      options.keys ?? createRemoteJWKSet(new URL(`${this.#issuer}/.well-known/jwks.json`));
  }

  async authenticate(
    request: Parameters<PublicPrincipalAuthenticator["authenticate"]>[0],
  ): Promise<AccountPrincipal | undefined> {
    const header = request.headers.authorization;
    if (header === undefined || header.length > MAX_TOKEN_BYTES || !header.startsWith("Bearer ")) {
      return undefined;
    }
    try {
      const { payload } = await jwtVerify(header.slice(7), this.#keys, {
        issuer: this.#issuer,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "exp"],
      });
      if (payload.token_use !== "access" || typeof payload.sub !== "string") return undefined;
      if (!UUID.test(payload.sub)) return undefined;
      const groups = payload["cognito:groups"];
      if (!Array.isArray(groups) || !groups.includes(this.#group)) return undefined;
      if (payload.client_id === this.#daemonClientId) return { accountId: payload.sub };
      if (payload.client_id === this.#phoneClientId) {
        return { accountId: payload.sub, scope: "phone" };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * A person signed in on the phone page through the Cognito user pool (Google as the identity
 * provider). It verifies the pool's access tokens for the page's app client and grants the account
 * a phone scope: pairing and running a device, never the daemon's routes. Which Google accounts may
 * sign in is the user pool's decision; the pairing link's enrollment secret still decides which
 * phone pairs.
 */
export class CognitoPhoneAuthenticator implements PublicPrincipalAuthenticator {
  readonly #issuer: string;
  readonly #clientId: string;
  readonly #accountId: string;
  readonly #keys: JWTVerifyGetKey;

  constructor(options: {
    /** `https://cognito-idp.<region>.amazonaws.com/<user pool ID>`. */
    readonly issuer: string;
    readonly clientId: string;
    readonly accountId: string;
    /** The pool's signing keys; fetched from the issuer's JWKS when omitted. */
    readonly keys?: JWTVerifyGetKey;
  }) {
    if (options.clientId.length === 0 || options.accountId.length === 0) {
      throw new TypeError("Cognito client and account IDs are required");
    }
    this.#issuer = new URL(options.issuer).href.replace(/\/$/u, "");
    this.#clientId = options.clientId;
    this.#accountId = options.accountId;
    this.#keys =
      options.keys ?? createRemoteJWKSet(new URL(`${this.#issuer}/.well-known/jwks.json`));
  }

  async authenticate(
    request: Parameters<PublicPrincipalAuthenticator["authenticate"]>[0],
  ): Promise<AccountPrincipal | undefined> {
    const header = request.headers.authorization;
    if (header === undefined || header.length > MAX_TOKEN_BYTES || !header.startsWith("Bearer ")) {
      return undefined;
    }
    try {
      const { payload } = await jwtVerify(header.slice(7), this.#keys, {
        issuer: this.#issuer,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "exp"],
      });
      // Cognito access tokens carry the app client in `client_id` rather than `aud`; an ID token
      // or another client's token is refused.
      if (payload.token_use !== "access" || payload.client_id !== this.#clientId) return undefined;
      return { accountId: this.#accountId, scope: "phone" };
    } catch {
      return undefined;
    }
  }
}
