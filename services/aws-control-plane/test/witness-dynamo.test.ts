// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { WitnessHighWaterEntry, WitnessReplicaRecord } from "@axl/control-plane";

import {
  decodeWitnessValue,
  DynamoWitnessHighWaterJournal,
  DynamoWitnessReplicaStorage,
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
