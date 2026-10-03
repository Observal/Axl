// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * Prunes the witness high-water journal down to each lineage's newest entry.
 *
 * A restart checks a replica's record only against its lineage's newest journal entry, so older
 * entries are superseded. The pruner runs on a schedule under its own principal, which holds only
 * `Scan` and `DeleteItem` on the journal table: the witness service keeps no delete permission, and
 * the pruner cannot write entries. It reads every key, and in each partition deletes the entries
 * below the newest one it saw. An entry appended while it runs is newer still, so it is never
 * deleted, and the newest entry a run saw always survives it.
 */

import { pathToFileURL } from "node:url";

import {
  DeleteItemCommand,
  DynamoDBClient,
  ScanCommand,
  type ScanCommandOutput,
} from "@aws-sdk/client-dynamodb";

/** Deletes in flight at once; each is one small item. */
const DELETE_CONCURRENCY = 8;

export interface WitnessJournalPruneOptions {
  readonly tableName: string;
  readonly client?: DynamoDBClient;
}

export interface WitnessJournalPruneResult {
  /** Journal partitions seen: one per replica and lineage. */
  readonly partitions: number;
  readonly deleted: number;
}

export async function pruneWitnessJournal(
  options: WitnessJournalPruneOptions,
): Promise<WitnessJournalPruneResult> {
  if (options.tableName.length === 0) throw new TypeError("DynamoDB table name is required");
  const client = options.client ?? new DynamoDBClient({});
  const partitions = new Map<string, string[]>();
  let start: ScanCommandOutput["LastEvaluatedKey"];
  do {
    const page: ScanCommandOutput = await client.send(
      new ScanCommand({
        TableName: options.tableName,
        ProjectionExpression: "pk, sk",
        ConsistentRead: true,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      }),
    );
    for (const item of page.Items ?? []) {
      const pk = item.pk?.S;
      const sk = item.sk?.S;
      if (pk === undefined || sk === undefined || !pk.startsWith("journal#")) {
        throw new Error("Witness journal item is invalid");
      }
      let keys = partitions.get(pk);
      if (keys === undefined) {
        keys = [];
        partitions.set(pk, keys);
      }
      keys.push(sk);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);

  // Sequence keys are zero-padded, so their string order is their numeric order.
  const superseded: { readonly pk: string; readonly sk: string }[] = [];
  for (const [pk, keys] of partitions) {
    keys.sort();
    for (const sk of keys.slice(0, -1)) superseded.push({ pk, sk });
  }
  let next = 0;
  const worker = async () => {
    while (next < superseded.length) {
      const key = superseded[next];
      next += 1;
      if (key === undefined) return;
      await client.send(
        new DeleteItemCommand({
          TableName: options.tableName,
          Key: { pk: { S: key.pk }, sk: { S: key.sk } },
        }),
      );
    }
  };
  await Promise.all(Array.from({ length: DELETE_CONCURRENCY }, worker));
  return { partitions: partitions.size, deleted: superseded.length };
}

// Run as the scheduled pruning task: `node witness-journal-pruner.js`.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tableName = process.env.AXL_WITNESS_JOURNAL_TABLE ?? "";
  const result = await pruneWitnessJournal({ tableName });
  process.stdout.write(`${JSON.stringify({ event: "witness_journal_pruned", ...result })}\n`);
}
