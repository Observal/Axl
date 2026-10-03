// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { WitnessHighWaterEntry, WitnessReplicaRecord } from "@axl/control-plane";

import {
  DynamoWitnessHighWaterJournal,
  DynamoWitnessReplicaStorage,
  decodeWitnessValue,
  encodeWitnessValue,
} from "../src/witness-dynamo.ts";
import { type FakeDynamoDb, startFakeDynamoDb } from "./support/fake-dynamodb.ts";

const replicaA = new Uint8Array(16).fill(1);
const replicaB = new Uint8Array(16).fill(2);
const lineage = new Uint8Array(48).fill(7);

async function fake(context: TestContext): Promise<{ db: FakeDynamoDb; client: DynamoDBClient }> {
  const db = await startFakeDynamoDb();
  const client = new DynamoDBClient({
    endpoint: db.endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  context.after(async () => {
    client.destroy();
    await db.close();
  });
  return { db, client };
}

function record(ledger: number, extra: Partial<WitnessReplicaRecord> = {}): WitnessReplicaRecord {
  return {
    lineageHash: lineage,
    binding: {
      lineageHash: lineage,
      credentialFingerprint: new Uint8Array(48).fill(3),
      credentialBytes: Uint8Array.of(1, 2, 3),
      verificationKey: new Uint8Array(32).fill(4),
    },
    ledger: Array.from({ length: ledger }, (_, index) => ({
      sequence: BigInt(index + 1),
      revocationGeneration: 0n,
      kind: index === 0 ? ("registered" as const) : ("advanced" as const),
      counter: BigInt(index + 1),
      commitment: new Uint8Array(48).fill(index),
    })),
    operations: [],
    retainedResponses: [],
    ...extra,
  };
}

test("witness values round-trip bytes and bigints exactly", () => {
  const value = {
    bytes: Uint8Array.of(0, 255, 7),
    // Node hashes are Buffers, whose toJSON would otherwise win.
    digest: Buffer.from([1, 2, 3]),
    counter: 2n ** 63n + 1n,
    nested: [{ empty: new Uint8Array(0), text: "$bytes", number: 3 }],
  };
  const decoded = decodeWitnessValue<typeof value>(encodeWitnessValue(value));
  assert.deepEqual(decoded, { ...value, digest: Uint8Array.of(1, 2, 3) });
  assert.ok(decoded.digest instanceof Uint8Array);
  assert.equal(encodeWitnessValue(decoded), encodeWitnessValue(value), "encoding is stable");
});

test("a record survives a new process and grows past one page", async (context) => {
  const { db, client } = await fake(context);
  db.pageSize = 3;
  const storage = new DynamoWitnessReplicaStorage({
    tableName: "witness",
    replicaId: replicaA,
    client,
  });
  assert.equal(await storage.read(lineage), undefined);
  assert.equal(
    await storage.transact(lineage, (current) => ({
      value: current === undefined,
      next: record(1),
    })),
    true,
  );
  for (let length = 2; length <= 8; length += 1) {
    await storage.transact(lineage, (current) => {
      assert.equal(current?.ledger.length, length - 1);
      return {
        value: undefined,
        next: {
          ...record(length),
          retainedResponses: [
            ...(current?.retainedResponses ?? []),
            {
              requestHash: new Uint8Array(48).fill(length),
              requestBytes: Uint8Array.of(length),
              exactReceipt: Uint8Array.of(length, length),
            },
          ],
          pendingJournalSequence: BigInt(length),
          derivedHead: {
            counter: BigInt(length),
            commitment: new Uint8Array(48).fill(length - 1),
            predecessorCommitment: new Uint8Array(48),
          },
        },
      };
    });
  }

  // A restarted replica has no cache: it reads every entry back across pages.
  const restarted = new DynamoWitnessReplicaStorage({
    tableName: "witness",
    replicaId: replicaA,
    client,
  });
  const loaded = await restarted.read(lineage);
  assert.equal(loaded?.ledger.length, 8);
  assert.equal(loaded?.retainedResponses.length, 7);
  assert.equal(loaded?.ledger[7]?.counter, 8n);
  assert.deepEqual(loaded?.retainedResponses[6]?.exactReceipt, Uint8Array.of(8, 8));
  assert.equal(loaded?.pendingJournalSequence, 8n);
  assert.deepEqual(await restarted.listLineageHashes(), [lineage]);
  // Another replica's partition is separate.
  const other = new DynamoWitnessReplicaStorage({
    tableName: "witness",
    replicaId: replicaB,
    client,
  });
  assert.deepEqual(await other.listLineageHashes(), []);
  assert.equal(await other.read(lineage), undefined);

  // Each step writes only its new entries and the head, not the whole record again.
  const items = db
    .items("witness")
    .filter((item) => String((item.pk as { S?: string } | undefined)?.S).startsWith("record#"));
  assert.equal(items.length, 1 + 8 + 7);
});

/** One step as the witness takes it: the next record appends to the ledger it was handed. */
function appended(current: WitnessReplicaRecord | undefined): WitnessReplicaRecord {
  const base = current ?? record(0);
  const sequence = BigInt(base.ledger.length + 1);
  return {
    ...base,
    ledger: [
      ...base.ledger,
      {
        sequence,
        revocationGeneration: 0n,
        kind: base.ledger.length === 0 ? ("registered" as const) : ("advanced" as const),
        counter: sequence,
        commitment: new Uint8Array(48).fill(Number(sequence)),
      },
    ],
    retainedResponses: [
      ...base.retainedResponses,
      {
        requestHash: new Uint8Array(48).fill(Number(sequence)),
        requestBytes: new Uint8Array(900),
        exactReceipt: new Uint8Array(300),
      },
    ],
  };
}

test("a step encodes only what it changed, however long the record is", async (context) => {
  const { client } = await fake(context);
  const storage = new DynamoWitnessReplicaStorage({
    tableName: "witness",
    replicaId: replicaA,
    client,
  });
  const stringify = context.mock.method(JSON, "stringify");
  const encodings = async () => {
    const before = stringify.mock.callCount();
    await storage.transact(lineage, (current) => ({ value: undefined, next: appended(current) }));
    return stringify.mock.callCount() - before;
  };
  for (let step = 0; step < 4; step += 1) await encodings();
  const short = await encodings();
  for (let step = 0; step < 60; step += 1) await encodings();
  assert.equal(await encodings(), short);
  assert.equal((await storage.read(lineage))?.ledger.length, 66);
});

test("a record handed out cannot change the cached state", async (context) => {
  const { client } = await fake(context);
  const storage = new DynamoWitnessReplicaStorage({
    tableName: "witness",
    replicaId: replicaA,
    client,
  });
  await storage.transact(lineage, (current) => ({ value: undefined, next: appended(current) }));
  await storage.transact(lineage, (current) => {
    assert.ok(current !== undefined && Object.isFrozen(current));
    assert.throws(() => (current.ledger as unknown[]).push(current.ledger[0]), TypeError);
    return { value: undefined, next: appended(current) };
  });
  const read = await storage.read(lineage);
  assert.ok(read !== undefined);
  assert.throws(() => {
    (read.retainedResponses[0] as { requestHash: Uint8Array }).requestHash = new Uint8Array(48);
  }, TypeError);
  assert.equal(read.ledger.length, 2);
  // A value a step answers with is the caller's own copy.
  const value = await storage.transact(lineage, (current) => ({ value: current?.ledger[0] }));
  assert.ok(value !== undefined && !Object.isFrozen(value));
});

test("history is append-only; only operations may be completed in place", async (context) => {
  const { client } = await fake(context);
  const storage = new DynamoWitnessReplicaStorage({
    tableName: "witness",
    replicaId: replicaA,
    client,
  });
  const operation = {
    operationId: new Uint8Array(16).fill(9),
    requestHash: new Uint8Array(48).fill(9),
    requestBytes: Uint8Array.of(9),
    result: "registered" as const,
    successor: {
      counter: 1n,
      commitment: new Uint8Array(48),
      predecessorCommitment: new Uint8Array(48),
    },
    acceptedAt: { sequence: 1n, revocationGeneration: 0n },
    receiptFields: {},
    journaled: false,
  } as unknown as WitnessReplicaRecord["operations"][number];
  await storage.transact(lineage, () => ({
    value: 0,
    next: record(2, { operations: [operation] }),
  }));
  await assert.rejects(
    storage.transact(lineage, () => ({ value: 0, next: record(1) })),
    /cannot shrink/u,
  );
  const rewritten = record(2);
  await assert.rejects(
    storage.transact(lineage, () => ({
      value: 0,
      next: {
        ...rewritten,
        operations: [operation],
        ledger: [{ ...required(rewritten.ledger[0]), counter: 5n }, required(rewritten.ledger[1])],
      },
    })),
    /write-once/u,
  );
  await storage.transact(lineage, (current) => ({
    value: 0,
    next: {
      ...required(current),
      operations: [{ ...operation, exactReceipt: Uint8Array.of(1), journaled: true }],
    },
  }));
  const reread = new DynamoWitnessReplicaStorage({
    tableName: "witness",
    replicaId: replicaA,
    client,
  });
  assert.equal((await reread.read(lineage))?.operations[0]?.journaled, true);
});

test("compaction deletes the compacted entries and keeps history positions", async (context) => {
  const { db, client } = await fake(context);
  const storage = new DynamoWitnessReplicaStorage({
    tableName: "witness",
    replicaId: replicaA,
    client,
  });
  const full = record(80);
  await storage.transact(lineage, () => ({
    value: 0,
    next: { ...full, ledger: full.ledger.slice(0, 60) },
  }));
  const compactedTo =
    (count: number, ledgerLength: number) => (current: WitnessReplicaRecord | undefined) => ({
      value: 0,
      next: {
        ...required(current),
        checkpoint: {
          sequence: BigInt(count),
          revocationGeneration: 0n,
          head: {
            counter: BigInt(count),
            commitment: new Uint8Array(48).fill(count - 1),
            predecessorCommitment: new Uint8Array(48),
          },
        },
        compacted: { ledger: count, operations: 0, retainedResponses: 0 },
        ledger: full.ledger.slice(count, ledgerLength),
      },
    });
  await storage.transact(lineage, compactedTo(16, 61));
  const ledgerKeys = () =>
    db
      .items("witness")
      .map((item) => String(item.sk?.S))
      .filter((key) => key.startsWith("ledger#"))
      .sort();
  assert.equal(ledgerKeys().length, 45);
  assert.equal(ledgerKeys()[0], "ledger#0000000016", "entries keep their history positions");

  // A new process reads the compacted record whole.
  const reread = new DynamoWitnessReplicaStorage({
    tableName: "witness",
    replicaId: replicaA,
    client,
  });
  const loaded = required(await reread.read(lineage));
  assert.equal(loaded.ledger.length, 45);
  assert.equal(loaded.ledger[0]?.sequence, 17n);
  assert.equal(loaded.checkpoint?.sequence, 16n);
  assert.deepEqual(loaded.compacted, { ledger: 16, operations: 0, retainedResponses: 0 });

  // Compaction only moves forward, and appends after it land at their history positions.
  await assert.rejects(reread.transact(lineage, compactedTo(8, 61)), /cannot move backwards/u);
  await reread.transact(lineage, compactedTo(32, 70));
  assert.equal(ledgerKeys().length, 38);
  assert.equal(ledgerKeys().at(-1), "ledger#0000000069");
  assert.equal((await storage.read(lineage))?.ledger.at(-1)?.sequence, 70n);
});

test("two processes writing one lineage never lose a step", async (context) => {
  const { client } = await fake(context);
  const first = new DynamoWitnessReplicaStorage({
    tableName: "witness",
    replicaId: replicaA,
    client,
  });
  const second = new DynamoWitnessReplicaStorage({
    tableName: "witness",
    replicaId: replicaA,
    client,
  });
  await first.transact(lineage, () => ({ value: 0, next: record(1) }));
  const step = (storage: DynamoWitnessReplicaStorage) =>
    storage.transact(lineage, (current) => ({
      value: 0,
      next: record((current?.ledger.length ?? 0) + 1),
    }));
  await Promise.all([step(first), step(second), step(first), step(second)]);
  assert.equal((await first.read(lineage))?.ledger.length, 5);
  assert.equal((await second.read(lineage))?.ledger.length, 5);
});

test("a cached record is never answered from once another process moved it", async (context) => {
  const { client } = await fake(context);
  const storage = () =>
    new DynamoWitnessReplicaStorage({ tableName: "witness", replicaId: replicaA, client });
  const first = storage();
  const second = storage();
  await first.transact(lineage, () => ({ value: 0, next: record(1) }));
  await second.transact(lineage, (current) => ({
    value: 0,
    next: record((current?.ledger.length ?? 0) + 1),
  }));
  // A step that writes nothing still sees the newer record, not the cached one.
  const seen = await first.transact(lineage, (current) => ({ value: current?.ledger.length }));
  assert.equal(seen, 2);
  // A writing step from the stale cache is refused by its condition and rerun on fresh state.
  await first.transact(lineage, (current) => ({
    value: 0,
    next: record((current?.ledger.length ?? 0) + 1),
  }));
  assert.equal((await second.read(lineage))?.ledger.length, 3);
});

test("a journal append from a stale process view still refuses a different entry", async (context) => {
  const { client } = await fake(context);
  const journal = () =>
    new DynamoWitnessHighWaterJournal({ tableName: "journal", replicaId: replicaA, client });
  const entry = (sequence: bigint, fill = 1): WitnessHighWaterEntry => ({
    lineageHash: lineage,
    sequence,
    counter: sequence,
    commitment: new Uint8Array(48).fill(fill),
    revocationGeneration: 0n,
    eventHash: new Uint8Array(48).fill(fill),
  });
  const first = journal();
  const second = journal();
  await first.append(entry(1n));
  await second.append(entry(2n, 2));
  // The first process last saw sequence 1, so it tries sequence 2 directly and must notice.
  await assert.rejects(first.append(entry(2n, 3)), /conflict/u);
  await first.append(entry(2n, 2));
  await first.append(entry(3n));
  assert.equal((await second.latest(lineage))?.sequence, 3n);
});

test("the journal is write-once, gapless, and per replica", async (context) => {
  const { client } = await fake(context);
  const journal = new DynamoWitnessHighWaterJournal({
    tableName: "journal",
    replicaId: replicaA,
    client,
  });
  const entry = (sequence: bigint, fill = 1): WitnessHighWaterEntry => ({
    lineageHash: lineage,
    sequence,
    counter: sequence,
    commitment: new Uint8Array(48).fill(fill),
    revocationGeneration: 0n,
    eventHash: new Uint8Array(48).fill(fill),
  });
  assert.equal(await journal.latest(lineage), undefined);
  await assert.rejects(journal.append(entry(2n)), /gap/u);
  await journal.append(entry(1n));
  await journal.append(entry(1n));
  await assert.rejects(journal.append(entry(1n, 2)), /conflict/u);
  await journal.append(entry(2n));
  for (let sequence = 3n; sequence <= 11n; sequence += 1n) await journal.append(entry(sequence));
  assert.equal((await journal.latest(lineage))?.sequence, 11n, "latest orders numerically");
  const other = new DynamoWitnessHighWaterJournal({
    tableName: "journal",
    replicaId: replicaB,
    client,
  });
  assert.equal(await other.latest(lineage), undefined);
});

function required<T>(value: T | undefined): T {
  assert(value !== undefined);
  return value;
}
