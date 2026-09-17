// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import {
  encodeRemoteE2eeEnvelope,
  parseCryptoSessionId,
  parseIdempotencyKey,
  parseOpaqueOutboxRecord,
  parseOperationId,
  parseRemoteRequestId,
  type CryptoSessionId,
  type OpaqueOutboxRecord,
  type RequestId,
  type RemoteE2eeMessageClass,
  type RouteId,
  type TransportAttemptId,
} from "@axl/protocol";

export interface RemoteOutbox {
  enqueue(value: OpaqueOutboxRecord): Promise<void>;
  beginAttempt(requestId: RequestId): Promise<OpaqueTransportAttempt>;
  markQueued(requestId: RequestId): Promise<void>;
  markDaemonAccepted(requestId: RequestId): Promise<void>;
  removeAccepted(requestId: RequestId): Promise<void>;
  resetSendingAfterDisconnect(): Promise<void>;
  list(): Promise<readonly OpaqueOutboxRecord[]>;
}

export interface OpaqueOutboxTransaction<Result> {
  readonly record?: OpaqueOutboxRecord;
  readonly result: Result;
}

/** Platform stores must commit each transaction atomically and durably. */
export interface OpaqueOutboxStore {
  transact<Result>(
    requestId: RequestId,
    operation: (current: OpaqueOutboxRecord | undefined) => OpaqueOutboxTransaction<Result>,
  ): Promise<Result>;
  list(): Promise<readonly OpaqueOutboxRecord[]>;
}

export interface TransportAttemptIdFactory {
  create(): TransportAttemptId;
}

export interface OpaqueRouteResolver {
  resolve(destinationCryptoSessionId: CryptoSessionId): Promise<RouteId>;
}

export interface OpaqueTransportAttempt {
  readonly attemptId: TransportAttemptId;
  readonly requestId: RequestId;
  readonly destinationRouteId: RouteId;
  readonly opaqueEnvelope: Uint8Array;
}

export class OpaqueOutboxError extends Error {
  readonly code: "outbox_conflict" | "unknown_request" | "not_daemon_accepted";

  constructor(code: OpaqueOutboxError["code"], message: string) {
    super(message);
    this.name = "OpaqueOutboxError";
    this.code = code;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function sameRecord(left: OpaqueOutboxRecord, right: OpaqueOutboxRecord): boolean {
  return (
    left.requestId === right.requestId &&
    left.idempotencyKey === right.idempotencyKey &&
    left.destinationCryptoSessionId === right.destinationCryptoSessionId &&
    left.createdAt === right.createdAt &&
    sameBytes(left.opaqueEnvelope, right.opaqueEnvelope)
  );
}

/** Reliable opaque-byte delivery state. It never encrypts or re-encrypts a request. */
export class OpaqueOutbox implements RemoteOutbox {
  private readonly store: OpaqueOutboxStore;
  private readonly attemptIds: TransportAttemptIdFactory;
  private readonly routes: OpaqueRouteResolver;

  constructor(
    store: OpaqueOutboxStore,
    attemptIds: TransportAttemptIdFactory,
    routes: OpaqueRouteResolver,
  ) {
    this.store = store;
    this.attemptIds = attemptIds;
    this.routes = routes;
  }

  enqueue(value: OpaqueOutboxRecord): Promise<void> {
    const record = parseOpaqueOutboxRecord(value);
    if (record.state !== "queued_local") {
      throw new OpaqueOutboxError("outbox_conflict", "A new outbox record must be queued locally");
    }
    return this.store.transact(record.requestId, (current) => {
      if (current !== undefined && !sameRecord(current, record)) {
        throw new OpaqueOutboxError(
          "outbox_conflict",
          "Request ID is already bound to different opaque bytes or metadata",
        );
      }
      return { record: current ?? record, result: undefined };
    });
  }

  async beginAttempt(requestId: RequestId): Promise<OpaqueTransportAttempt> {
    const prepared = await this.store.transact(requestId, (current) => {
      if (current === undefined) {
        throw new OpaqueOutboxError("unknown_request", "Outbox request does not exist");
      }
      if (current.state === "daemon_accepted") {
        throw new OpaqueOutboxError("outbox_conflict", "Accepted request must not be resent");
      }
      const record = parseOpaqueOutboxRecord({ ...current, state: "sending" });
      return {
        record,
        result: {
          attemptId: this.attemptIds.create(),
          requestId: record.requestId,
          destinationCryptoSessionId: record.destinationCryptoSessionId,
          opaqueEnvelope: record.opaqueEnvelope.slice(),
        },
      };
    });
    const destinationRouteId = await this.routes.resolve(prepared.destinationCryptoSessionId);
    return {
      attemptId: prepared.attemptId,
      requestId: prepared.requestId,
      destinationRouteId,
      opaqueEnvelope: prepared.opaqueEnvelope,
    };
  }

  markQueued(requestId: RequestId): Promise<void> {
    return this.store.transact(requestId, (current) => {
      if (current === undefined) {
        throw new OpaqueOutboxError("unknown_request", "Outbox request does not exist");
      }
      if (current.state === "daemon_accepted") {
        return { record: current, result: undefined };
      }
      return {
        record: parseOpaqueOutboxRecord({ ...current, state: "queued_local" }),
        result: undefined,
      };
    });
  }

  markDaemonAccepted(requestId: RequestId): Promise<void> {
    return this.store.transact(requestId, (current) => {
      if (current === undefined) {
        throw new OpaqueOutboxError("unknown_request", "Outbox request does not exist");
      }
      return {
        record: parseOpaqueOutboxRecord({
          ...current,
          state: "daemon_accepted",
        }),
        result: undefined,
      };
    });
  }

  removeAccepted(requestId: RequestId): Promise<void> {
    return this.store.transact(requestId, (current) => {
      if (current === undefined) return { result: undefined };
      if (current.state !== "daemon_accepted") {
        throw new OpaqueOutboxError(
          "not_daemon_accepted",
          "Only a daemon-accepted request may leave the outbox",
        );
      }
      return { result: undefined };
    });
  }

  resetSendingAfterDisconnect(): Promise<void> {
    return this.store.list().then(async (records) => {
      for (const record of records) {
        if (record.state !== "sending") continue;
        await this.store.transact(record.requestId, (current) => {
          if (current === undefined) return { result: undefined };
          if (current.state !== "sending") return { record: current, result: undefined };
          return {
            record: parseOpaqueOutboxRecord({
              ...current,
              state: "queued_local",
            }),
            result: undefined,
          };
        });
      }
    });
  }

  list(): Promise<readonly OpaqueOutboxRecord[]> {
    return this.store
      .list()
      .then((records) =>
        records
          .map((record) => parseOpaqueOutboxRecord(record))
          .sort(
            (left, right) =>
              left.createdAt - right.createdAt || left.requestId.localeCompare(right.requestId),
          ),
      );
  }
}

export interface NativeDurableOutboxRecord {
  readonly operationId: Uint8Array;
  readonly cryptoSessionId: Uint8Array;
  readonly logicalMessageId: Uint8Array;
  readonly messageClass: RemoteE2eeMessageClass;
  readonly hostedGrantGeneration: bigint;
  readonly retryState: "pending" | "acknowledged";
  readonly ciphertext: Uint8Array;
}

export interface NativeDurableOutboxEndpoint {
  pendingOutbox(): Promise<readonly NativeDurableOutboxRecord[]>;
  acknowledgeOutbox(
    operationId: Uint8Array,
    targetOperationId: Uint8Array,
  ): Promise<NativeDurableOutboxRecord>;
}

function uuidText(bytes: Uint8Array): string {
  if (bytes.byteLength !== 16) throw new TypeError("Native outbox identity must contain 16 bytes");
  const encoded = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${encoded.slice(0, 8)}-${encoded.slice(8, 12)}-${encoded.slice(12, 16)}-${encoded.slice(16, 20)}-${encoded.slice(20)}`;
}

function requestIdFor(record: NativeDurableOutboxRecord): RequestId {
  const bytes = record.logicalMessageId.slice();
  if (record.messageClass === "application_request") bytes[0] = (bytes[0] ?? 0) ^ 0x41;
  return parseRemoteRequestId(uuidText(bytes));
}

function nativeEnvelope(record: NativeDurableOutboxRecord): Uint8Array {
  const hostedGrantGeneration = Number(record.hostedGrantGeneration);
  if (!Number.isSafeInteger(hostedGrantGeneration) || hostedGrantGeneration <= 0) {
    throw new OpaqueOutboxError(
      "outbox_conflict",
      "Native outbox record has no valid hosted grant generation",
    );
  }
  return encodeRemoteE2eeEnvelope({
    operationId: parseOperationId(uuidText(record.operationId)),
    logicalMessageId: parseOperationId(uuidText(record.logicalMessageId)),
    messageClass: record.messageClass,
    hostedGrantGeneration,
    ciphertext: record.ciphertext,
  });
}

/**
 * Projects the native endpoint's authoritative durable outbox into relay attempts. Sending state
 * remains process-local; after reconnect every unacknowledged native record is retried exactly.
 */
export class NativeEndpointOutbox implements RemoteOutbox {
  readonly #endpoint: NativeDurableOutboxEndpoint;
  readonly #attemptIds: TransportAttemptIdFactory;
  readonly #routes: OpaqueRouteResolver;
  readonly #sending = new Set<RequestId>();
  readonly #accepted = new Set<RequestId>();

  constructor(
    endpoint: NativeDurableOutboxEndpoint,
    attemptIds: TransportAttemptIdFactory,
    routes: OpaqueRouteResolver,
  ) {
    this.#endpoint = endpoint;
    this.#attemptIds = attemptIds;
    this.#routes = routes;
  }

  async enqueue(value: OpaqueOutboxRecord): Promise<void> {
    const expected = parseOpaqueOutboxRecord(value);
    const record = (await this.#endpoint.pendingOutbox()).find(
      (candidate) => requestIdFor(candidate) === expected.requestId,
    );
    if (record === undefined || !sameBytes(nativeEnvelope(record), expected.opaqueEnvelope)) {
      throw new OpaqueOutboxError(
        "outbox_conflict",
        "Prepared bytes are not present in the native durable outbox",
      );
    }
  }

  async beginAttempt(requestId: RequestId): Promise<OpaqueTransportAttempt> {
    const record = await this.#required(requestId);
    if (this.#accepted.has(requestId)) {
      throw new OpaqueOutboxError("outbox_conflict", "Accepted request must not be resent");
    }
    this.#sending.add(requestId);
    return {
      attemptId: this.#attemptIds.create(),
      requestId,
      destinationRouteId: await this.#routes.resolve(
        parseCryptoSessionId(uuidText(record.cryptoSessionId)),
      ),
      opaqueEnvelope: nativeEnvelope(record),
    };
  }

  async markQueued(requestId: RequestId): Promise<void> {
    if (this.#accepted.has(requestId)) return;
    await this.#required(requestId);
    this.#sending.delete(requestId);
  }

  async markDaemonAccepted(requestId: RequestId): Promise<void> {
    const record = await this.#required(requestId);
    const acknowledgement = record.operationId.slice();
    acknowledgement[0] = (acknowledgement[0] ?? 0) ^ 0x44;
    await this.#endpoint.acknowledgeOutbox(acknowledgement, record.operationId);
    this.#sending.delete(requestId);
    this.#accepted.add(requestId);
  }

  async removeAccepted(requestId: RequestId): Promise<void> {
    if (!this.#accepted.delete(requestId)) {
      const exists = (await this.list()).some((record) => record.requestId === requestId);
      if (exists) {
        throw new OpaqueOutboxError(
          "not_daemon_accepted",
          "Only a daemon-accepted request may leave the outbox",
        );
      }
    }
  }

  async resetSendingAfterDisconnect(): Promise<void> {
    this.#sending.clear();
  }

  async list(): Promise<readonly OpaqueOutboxRecord[]> {
    const records = await this.#endpoint.pendingOutbox();
    return records.map((record) => {
      const requestId = requestIdFor(record);
      return parseOpaqueOutboxRecord({
        requestId,
        idempotencyKey: parseIdempotencyKey(uuidText(record.operationId)),
        destinationCryptoSessionId: parseCryptoSessionId(uuidText(record.cryptoSessionId)),
        opaqueEnvelope: nativeEnvelope(record),
        createdAt: 0,
        state: this.#sending.has(requestId) ? "sending" : "queued_local",
      });
    });
  }

  async #required(requestId: RequestId): Promise<NativeDurableOutboxRecord> {
    const record = (await this.#endpoint.pendingOutbox()).find(
      (candidate) => requestIdFor(candidate) === requestId,
    );
    if (record === undefined) {
      throw new OpaqueOutboxError("unknown_request", "Native outbox request does not exist");
    }
    return record;
  }
}
