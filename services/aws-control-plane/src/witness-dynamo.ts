// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * DynamoDB storage for the deployment-test rollback witness replicas.
 *
 * A replica record is an append-only ledger with its accepted operations, retained responses, and
 * used recovery reads. A record can outgrow one 400 KB item, so each entry is its own item under
 * the record's partition, next to a `head` item that carries the record's small fields, its entry
 * counts, and a revision. A transaction applies the replica's pure transaction function to the
 * record at its last known revision and writes only the new or changed entries together with the
 * next head in one `TransactWriteItems` conditioned on that revision, so a record another writer
 * moved is reloaded and the step rerun. A step that writes nothing is answered only after a
 * consistent head read confirms the revision it was computed from. Ledger, response, and recovery
 * entries are write-once; only an operation's receipt fields may be filled in later.
 *
 * The high-water journal lives in its own table as one write-once item per sequence number, so the
 * record table's credentials cannot rewrite it. An append after the last sequence this process
 * wrote or read is one conditional put; anything else first reads what is stored. Both tables serve all three replicas of one
 * process, which is the deployment-test limitation the design documents name: independent
 * replicas need separate accounts, stores, and recovery paths.
 */

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  type QueryCommandOutput,
  TransactionCanceledException,
  type TransactWriteItem,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import type {
  WitnessHighWaterEntry,
  WitnessHighWaterJournal,
  WitnessReplicaRecord,
  WitnessReplicaStorage,
  WitnessReplicaTransaction,
} from "@axl/control-plane";
import { witnessBytesEqual, witnessBytesHex } from "@axl/protocol";

/** DynamoDB accepts at most 100 items in one transaction; one witness step writes a few. */
const MAX_TRANSACTION_ITEMS = 100;
const MAX_CONFLICT_RETRIES = 8;
const INDEX_DIGITS = 10;
const SEQUENCE_DIGITS = 20;

/** JSON with Uint8Array and bigint values, which witness records and journal entries contain. */
export function encodeWitnessValue(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key, item: unknown) {
    // The holder's own value: JSON.stringify has already applied Buffer's toJSON to `item`, and
    // witness hashes are Buffers.
    const original = this[key];
    if (original instanceof Uint8Array) {
      return { $bytes: Buffer.from(original).toString("base64") };
    }
    if (typeof item === "bigint") return { $bigint: item.toString() };
    return item;
  });
}

export function decodeWitnessValue<T>(serialized: string): T {
  return JSON.parse(serialized, (_key, item: unknown) => {
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const keys = Object.keys(item);
      const tagged = item as Record<string, unknown>;
      if (keys.length === 1 && typeof tagged.$bytes === "string") {
        return new Uint8Array(Buffer.from(tagged.$bytes, "base64"));
      }
      if (keys.length === 1 && typeof tagged.$bigint === "string") {
        return BigInt(tagged.$bigint);
      }
    }
    return item;
  }) as T;
}

const ENTRY_KINDS = ["ledger", "operations", "retainedResponses", "recoveryRequestHashes"] as const;
type EntryKind = (typeof ENTRY_KINDS)[number];
/** Entry kinds whose items never change once written. */
const WRITE_ONCE: ReadonlySet<EntryKind> = new Set([
  "ledger",
  "retainedResponses",
  "recoveryRequestHashes",
]);

interface StoredHead {
  readonly lineageHash: Uint8Array;
  readonly binding: WitnessReplicaRecord["binding"];
  readonly pendingJournalSequence?: bigint;
  readonly derivedHead?: WitnessReplicaRecord["derivedHead"];
  readonly counts: Readonly<Record<EntryKind, number>>;
}

/** A record as loaded: its revision and the serialized form of every entry, for diffing. */
interface Loaded {
  readonly revision: number;
  readonly record?: WitnessReplicaRecord;
  readonly entries: Readonly<Record<EntryKind, readonly string[]>>;
}

const EMPTY: Loaded = {
  revision: 0,
  entries: { ledger: [], operations: [], retainedResponses: [], recoveryRequestHashes: [] },
};

function entryKey(kind: EntryKind, index: number): string {
  return `${kind}#${String(index).padStart(INDEX_DIGITS, "0")}`;
}

function serializedEntries(record: WitnessReplicaRecord): Record<EntryKind, string[]> {
  return {
    ledger: record.ledger.map(encodeWitnessValue),
    operations: record.operations.map(encodeWitnessValue),
    retainedResponses: record.retainedResponses.map(encodeWitnessValue),
    recoveryRequestHashes: (record.recoveryRequestHashes ?? []).map(encodeWitnessValue),
  };
}

function isConflict(cause: unknown): boolean {
  if (cause instanceof ConditionalCheckFailedException) return true;
  return (
    cause instanceof TransactionCanceledException &&
    (cause.CancellationReasons ?? []).some((reason) => reason.Code === "ConditionalCheckFailed")
  );
}

class StaleRead extends Error {}

export interface DynamoWitnessStorageOptions {
  readonly tableName: string;
  /** This replica's identifier; its records and lineage list are partitioned under it. */
  readonly replicaId: Uint8Array;
  readonly client?: DynamoDBClient;
}

/** One replica's lineage records, as a `WitnessReplicaStorage` over DynamoDB. */
export class DynamoWitnessReplicaStorage implements WitnessReplicaStorage {
  readonly #client: DynamoDBClient;
  readonly #tableName: string;
  readonly #replica: string;
  /** The last loaded or written state of each lineage, reused while its revision is current. */
  readonly #cache = new Map<string, Loaded>();
  readonly #queues = new Map<string, Promise<void>>();

  constructor(options: DynamoWitnessStorageOptions) {
    if (options.tableName.length === 0) throw new TypeError("DynamoDB table name is required");
    this.#tableName = options.tableName;
    this.#replica = witnessBytesHex(options.replicaId);
    this.#client = options.client ?? new DynamoDBClient({});
  }

  #partition(lineage: string): string {
    return `record#${this.#replica}#${lineage}`;
  }

  async transact<T>(
    lineageHash: Uint8Array,
    transaction: (current: WitnessReplicaRecord | undefined) => WitnessReplicaTransaction<T>,
  ): Promise<T> {
    const lineage = witnessBytesHex(lineageHash);
    return this.#serialized(lineage, async () => {
      for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
        // The conditional write proves a cached record current; a fresh load happens on a miss or
        // after another writer moved the record.
        const cached = this.#cache.get(lineage);
        const loaded = cached ?? (await this.#load(lineage));
        const outcome = transaction(
          loaded.record === undefined ? undefined : structuredClone(loaded.record),
        );
        if (outcome.next === undefined) {
          // Nothing is written, so nothing proves the record current: confirm its revision.
          if (cached !== undefined && (await this.#headRevision(lineage)) !== cached.revision) {
            this.#cache.delete(lineage);
            continue;
          }
          return structuredClone(outcome.value);
        }
        if (!witnessBytesEqual(outcome.next.lineageHash, lineageHash)) {
          throw new Error("A witness record cannot move to another lineage");
        }
        if (await this.#write(lineage, loaded, outcome.next)) {
          return structuredClone(outcome.value);
        }
        this.#cache.delete(lineage);
      }
      throw new Error("Witness record writes kept conflicting");
    });
  }

  async listLineageHashes(): Promise<readonly Uint8Array[]> {
    const lineages: Uint8Array[] = [];
    for await (const item of this.#query(`replica#${this.#replica}`)) {
      const lineage = item.lineage?.S;
      if (lineage === undefined || !/^[0-9a-f]{96}$/u.test(lineage)) {
        throw new Error("Stored witness lineage is invalid");
      }
      lineages.push(new Uint8Array(Buffer.from(lineage, "hex")));
    }
    return lineages;
  }

  async read(lineageHash: Uint8Array): Promise<WitnessReplicaRecord | undefined> {
    const loaded = await this.#load(witnessBytesHex(lineageHash));
    return loaded.record === undefined ? undefined : structuredClone(loaded.record);
  }

  async #serialized<T>(lineage: string, work: () => Promise<T>): Promise<T> {
    const prior = this.#queues.get(lineage) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.then(() => held);
    this.#queues.set(lineage, queued);
    await prior;
    try {
      return await work();
    } finally {
      release();
      if (this.#queues.get(lineage) === queued) this.#queues.delete(lineage);
    }
  }

  /** The stored head's revision, from a consistent read; 0 when the lineage has no record. */
  async #headRevision(lineage: string): Promise<number> {
    const head = await this.#client.send(
      new GetItemCommand({
        TableName: this.#tableName,
        Key: { pk: { S: this.#partition(lineage) }, sk: { S: "head" } },
        ConsistentRead: true,
      }),
    );
    if (head.Item === undefined) return 0;
    const revision = Number(head.Item.revision?.N);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error("Stored witness record head is invalid");
    }
    return revision;
  }

  /** The current record: one consistent head read, plus a full read when the cache is stale. */
  async #load(lineage: string): Promise<Loaded> {
    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
      const revision = await this.#headRevision(lineage);
      if (revision === 0) {
        this.#cache.delete(lineage);
        return EMPTY;
      }
      const cached = this.#cache.get(lineage);
      if (cached !== undefined && cached.revision === revision) return cached;
      try {
        const loaded = await this.#loadAll(lineage, revision);
        this.#cache.set(lineage, loaded);
        return loaded;
      } catch (cause) {
        if (!(cause instanceof StaleRead)) throw cause;
      }
    }
    throw new Error("Witness record kept changing while it was read");
  }

  async #loadAll(lineage: string, revision: number): Promise<Loaded> {
    let head: StoredHead | undefined;
    const found: Record<EntryKind, Map<number, string>> = {
      ledger: new Map(),
      operations: new Map(),
      retainedResponses: new Map(),
      recoveryRequestHashes: new Map(),
    };
    for await (const item of this.#query(this.#partition(lineage))) {
      const itemRevision = Number(item.revision?.N);
      const value = item.value?.S;
      const sk = item.sk?.S;
      if (!Number.isSafeInteger(itemRevision) || value === undefined || sk === undefined) {
        throw new Error("Stored witness record item is invalid");
      }
      // A page read after a concurrent write can hold newer items than the head it started with.
      if (itemRevision > revision) throw new StaleRead();
      if (sk === "head") {
        if (itemRevision !== revision) throw new StaleRead();
        head = decodeWitnessValue<StoredHead>(value);
        continue;
      }
      const [kind, index] = sk.split("#");
      if (!ENTRY_KINDS.includes(kind as EntryKind) || index === undefined) {
        throw new Error("Stored witness record entry is invalid");
      }
      found[kind as EntryKind].set(Number(index), value);
    }
    if (head === undefined) throw new StaleRead();
    const entries = {} as Record<EntryKind, string[]>;
    for (const kind of ENTRY_KINDS) {
      const count = head.counts[kind];
      const values: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const value = found[kind].get(index);
        if (value === undefined) throw new StaleRead();
        values.push(value);
      }
      entries[kind] = values;
    }
    const decode = <T>(values: readonly string[]) =>
      values.map((value) => decodeWitnessValue<T>(value));
    const record: WitnessReplicaRecord = {
      lineageHash: head.lineageHash,
      binding: head.binding,
      ledger: decode(entries.ledger),
      operations: decode(entries.operations),
      retainedResponses: decode(entries.retainedResponses),
      ...(entries.recoveryRequestHashes.length === 0
        ? {}
        : { recoveryRequestHashes: decode<Uint8Array>(entries.recoveryRequestHashes) }),
      ...(head.pendingJournalSequence === undefined
        ? {}
        : { pendingJournalSequence: head.pendingJournalSequence }),
      ...(head.derivedHead === undefined ? {} : { derivedHead: head.derivedHead }),
    };
    return { revision, record, entries };
  }

  /** Write `next` over `loaded`; false when another writer moved the record first. */
  async #write(lineage: string, loaded: Loaded, next: WitnessReplicaRecord): Promise<boolean> {
    const revision = loaded.revision + 1;
    const partition = this.#partition(lineage);
    const entries = serializedEntries(next);
    const items: TransactWriteItem[] = [];
    for (const kind of ENTRY_KINDS) {
      const before = loaded.entries[kind];
      const after = entries[kind];
      if (after.length < before.length) throw new Error(`Witness ${kind} cannot shrink`);
      after.forEach((value, index) => {
        const existing = before[index];
        if (existing === value) return;
        if (existing !== undefined && WRITE_ONCE.has(kind)) {
          throw new Error(`Witness ${kind} entries are write-once`);
        }
        items.push({
          Put: {
            TableName: this.#tableName,
            Item: {
              pk: { S: partition },
              sk: { S: entryKey(kind, index) },
              revision: { N: String(revision) },
              value: { S: value },
            },
            ...(existing === undefined ? { ConditionExpression: "attribute_not_exists(pk)" } : {}),
          },
        });
      });
    }
    const head: StoredHead = {
      lineageHash: next.lineageHash,
      binding: next.binding,
      ...(next.pendingJournalSequence === undefined
        ? {}
        : { pendingJournalSequence: next.pendingJournalSequence }),
      ...(next.derivedHead === undefined ? {} : { derivedHead: next.derivedHead }),
      counts: {
        ledger: entries.ledger.length,
        operations: entries.operations.length,
        retainedResponses: entries.retainedResponses.length,
        recoveryRequestHashes: entries.recoveryRequestHashes.length,
      },
    };
    items.push({
      Put: {
        TableName: this.#tableName,
        Item: {
          pk: { S: partition },
          sk: { S: "head" },
          revision: { N: String(revision) },
          value: { S: encodeWitnessValue(head) },
        },
        ...(loaded.revision === 0
          ? { ConditionExpression: "attribute_not_exists(pk)" }
          : {
              ConditionExpression: "revision = :revision",
              ExpressionAttributeValues: { ":revision": { N: String(loaded.revision) } },
            }),
      },
    });
    if (loaded.revision === 0) {
      items.push({
        Put: {
          TableName: this.#tableName,
          Item: {
            pk: { S: `replica#${this.#replica}` },
            sk: { S: `lineage#${lineage}` },
            lineage: { S: lineage },
            revision: { N: "1" },
            value: { S: "{}" },
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      });
    }
    if (items.length > MAX_TRANSACTION_ITEMS) {
      throw new Error("A witness step changed more entries than one transaction holds");
    }
    try {
      await this.#client.send(new TransactWriteItemsCommand({ TransactItems: items }));
    } catch (cause) {
      if (isConflict(cause)) return false;
      throw cause;
    }
    this.#cache.set(lineage, { revision, record: structuredClone(next), entries });
    return true;
  }

  async *#query(
    partition: string,
  ): AsyncGenerator<NonNullable<QueryCommandOutput["Items"]>[number]> {
    let start: QueryCommandOutput["LastEvaluatedKey"];
    do {
      const page: QueryCommandOutput = await this.#client.send(
        new QueryCommand({
          TableName: this.#tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": { S: partition } },
          ConsistentRead: true,
          ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        }),
      );
      yield* page.Items ?? [];
      start = page.LastEvaluatedKey;
    } while (start !== undefined);
  }
}

function sameEntry(left: WitnessHighWaterEntry, right: WitnessHighWaterEntry): boolean {
  return (
    left.sequence === right.sequence &&
    left.counter === right.counter &&
    left.revocationGeneration === right.revocationGeneration &&
    witnessBytesEqual(left.lineageHash, right.lineageHash) &&
    witnessBytesEqual(left.commitment, right.commitment) &&
    witnessBytesEqual(left.eventHash, right.eventHash)
  );
}

/** One replica's immutable high-water journal: a write-once item per lineage and sequence. */
export class DynamoWitnessHighWaterJournal implements WitnessHighWaterJournal {
  readonly #client: DynamoDBClient;
  readonly #tableName: string;
  readonly #replica: string;
  /** The newest sequence this process wrote or read per lineage. Stored items never change. */
  readonly #known = new Map<string, bigint>();

  constructor(options: DynamoWitnessStorageOptions) {
    if (options.tableName.length === 0) throw new TypeError("DynamoDB table name is required");
    this.#tableName = options.tableName;
    this.#replica = witnessBytesHex(options.replicaId);
    this.#client = options.client ?? new DynamoDBClient({});
  }

  #partition(lineageHash: Uint8Array): string {
    return `journal#${this.#replica}#${witnessBytesHex(lineageHash)}`;
  }

  #learn(lineageHash: Uint8Array, sequence: bigint): void {
    const lineage = witnessBytesHex(lineageHash);
    if (sequence > (this.#known.get(lineage) ?? 0n)) this.#known.set(lineage, sequence);
  }

  async append(entry: WitnessHighWaterEntry): Promise<void> {
    const sequence = entry.sequence.toString().padStart(SEQUENCE_DIGITS, "0");
    // The entry right after the newest one seen needs no read: the put's condition refuses it if
    // another writer got there first, and that case is checked below as before.
    const known = this.#known.get(witnessBytesHex(entry.lineageHash));
    if (known !== undefined && entry.sequence === known + 1n) {
      await this.#put(entry, sequence);
      return;
    }
    const existing = await this.#entry(entry.lineageHash, sequence);
    if (existing !== undefined) {
      if (!sameEntry(existing, entry)) throw new Error("immutable journal conflict");
      this.#learn(entry.lineageHash, entry.sequence);
      return;
    }
    if (entry.sequence !== ((await this.latest(entry.lineageHash))?.sequence ?? 0n) + 1n) {
      throw new Error("immutable journal gap");
    }
    await this.#put(entry, sequence);
  }

  async #put(entry: WitnessHighWaterEntry, sequence: string): Promise<void> {
    try {
      await this.#client.send(
        new PutItemCommand({
          TableName: this.#tableName,
          Item: {
            pk: { S: this.#partition(entry.lineageHash) },
            sk: { S: sequence },
            value: { S: encodeWitnessValue(entry) },
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (cause) {
      if (!isConflict(cause)) throw cause;
      const raced = await this.#entry(entry.lineageHash, sequence);
      if (raced === undefined || !sameEntry(raced, entry)) {
        throw new Error("immutable journal conflict");
      }
    }
    this.#learn(entry.lineageHash, entry.sequence);
  }

  async latest(lineageHash: Uint8Array): Promise<WitnessHighWaterEntry | undefined> {
    const page = await this.#client.send(
      new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": { S: this.#partition(lineageHash) } },
        ScanIndexForward: false,
        Limit: 1,
        ConsistentRead: true,
      }),
    );
    const value = page.Items?.[0]?.value?.S;
    if (value === undefined) return undefined;
    const latest = decodeWitnessValue<WitnessHighWaterEntry>(value);
    this.#learn(lineageHash, latest.sequence);
    return latest;
  }

  async #entry(
    lineageHash: Uint8Array,
    sequence: string,
  ): Promise<WitnessHighWaterEntry | undefined> {
    const result = await this.#client.send(
      new GetItemCommand({
        TableName: this.#tableName,
        Key: { pk: { S: this.#partition(lineageHash) }, sk: { S: sequence } },
        ConsistentRead: true,
      }),
    );
    const value = result.Item?.value?.S;
    return value === undefined ? undefined : decodeWitnessValue<WitnessHighWaterEntry>(value);
  }
}
