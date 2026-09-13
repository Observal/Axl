// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import {
  parseOpaqueOutboxRecord,
  type OpaqueOutboxRecord,
  type RequestId,
  type TransportAttemptId,
} from "@axl/protocol";

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

export interface OpaqueTransportAttempt {
  readonly attemptId: TransportAttemptId;
  readonly requestId: RequestId;
  readonly destinationRouteId: OpaqueOutboxRecord["destinationRouteId"];
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
    left.destinationRouteId === right.destinationRouteId &&
    left.createdAt === right.createdAt &&
    sameBytes(left.opaqueEnvelope, right.opaqueEnvelope)
  );
}

/** Reliable opaque-byte delivery state. It never encrypts or re-encrypts a request. */
export class OpaqueOutbox {
  private readonly store: OpaqueOutboxStore;
  private readonly attemptIds: TransportAttemptIdFactory;

  constructor(store: OpaqueOutboxStore, attemptIds: TransportAttemptIdFactory) {
    this.store = store;
    this.attemptIds = attemptIds;
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

  beginAttempt(requestId: RequestId): Promise<OpaqueTransportAttempt> {
    return this.store.transact(requestId, (current) => {
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
          destinationRouteId: record.destinationRouteId,
          opaqueEnvelope: record.opaqueEnvelope.slice(),
        },
      };
    });
  }

  markDaemonAccepted(requestId: RequestId): Promise<void> {
    return this.store.transact(requestId, (current) => {
      if (current === undefined) {
        throw new OpaqueOutboxError("unknown_request", "Outbox request does not exist");
      }
      return {
        record: parseOpaqueOutboxRecord({ ...current, state: "daemon_accepted" }),
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
            record: parseOpaqueOutboxRecord({ ...current, state: "queued_local" }),
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
