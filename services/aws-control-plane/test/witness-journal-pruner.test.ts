// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { WitnessHighWaterEntry } from "@axl/control-plane";

import { DynamoWitnessHighWaterJournal } from "../src/witness-dynamo.ts";
import { pruneWitnessJournal } from "../src/witness-journal-pruner.ts";
import { startFakeDynamoDb } from "./support/fake-dynamodb.ts";

function entry(lineage: number, sequence: number): WitnessHighWaterEntry {
  return {
    lineageHash: new Uint8Array(48).fill(lineage),
    sequence: BigInt(sequence),
    counter: BigInt(sequence),
    commitment: new Uint8Array(48).fill(sequence),
    revocationGeneration: 0n,
    eventHash: new Uint8Array(48).fill(sequence + 1),
  };
}

test("pruning keeps each lineage's newest journal entry and nothing older", async (context) => {
  const db = await startFakeDynamoDb();
  db.pageSize = 4;
  const client = new DynamoDBClient({
    endpoint: db.endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  context.after(async () => {
    client.destroy();
    await db.close();
  });
  const journals = [1, 2].map(
    (replica) =>
      new DynamoWitnessHighWaterJournal({
        tableName: "journal",
        replicaId: new Uint8Array(16).fill(replica),
        client,
      }),
  );
  for (const journal of journals) {
    for (let sequence = 1; sequence <= 12; sequence += 1) await journal.append(entry(7, sequence));
    for (let sequence = 1; sequence <= 3; sequence += 1) await journal.append(entry(8, sequence));
  }
  await journals[0]?.append(entry(9, 1));

  const result = await pruneWitnessJournal({ tableName: "journal", client });
  assert.deepEqual(result, { partitions: 5, deleted: 2 * (11 + 2) });
  assert.equal(db.items("journal").length, 5);

  // A restarted process sees the same newest entries and keeps appending after them.
  const restarted = new DynamoWitnessHighWaterJournal({
    tableName: "journal",
    replicaId: new Uint8Array(16).fill(1),
    client,
  });
  assert.deepEqual(await restarted.latest(entry(7, 1).lineageHash), entry(7, 12));
  assert.deepEqual(await restarted.latest(entry(9, 1).lineageHash), entry(9, 1));
  await restarted.append(entry(7, 12));
  await restarted.append(entry(7, 13));
  await assert.rejects(restarted.append(entry(7, 15)), /gap/u);

  // A run racing appends never removes the newest entry, and a later run removes the rest.
  await Promise.all([
    pruneWitnessJournal({ tableName: "journal", client }),
    (async () => {
      for (let sequence = 14; sequence <= 20; sequence += 1) {
        await restarted.append(entry(7, sequence));
      }
    })(),
  ]);
  assert.deepEqual(await restarted.latest(entry(7, 1).lineageHash), entry(7, 20));
  await pruneWitnessJournal({ tableName: "journal", client });
  assert.equal(db.items("journal").length, 5);

  // Twice in a row deletes nothing more.
  assert.equal((await pruneWitnessJournal({ tableName: "journal", client })).deleted, 0);
});
