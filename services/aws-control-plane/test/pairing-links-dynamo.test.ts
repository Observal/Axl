// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { DynamoPairingLinkStore } from "../src/aws.ts";
import { startFakeDynamoDb } from "./support/fake-dynamodb.ts";

test("DynamoDB pairing links are written once, read back exactly, and expire by TTL", async (context) => {
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
  const store = new DynamoPairingLinkStore({ tableName: "control-plane", client });
  const record = {
    linkId: "0102030405060708090a0b0c0d0e0f10",
    accountId: "account-a",
    sealed: Uint8Array.from({ length: 300 }, (_, index) => index % 256),
    expiresAt: 1_900_000_600_500,
  };

  assert.equal(await store.create(record), undefined);
  assert.deepEqual(await store.get(record.linkId), record);
  // A second write under the ID keeps the first and reports it.
  const existing = await store.create({
    ...record,
    accountId: "account-b",
    sealed: Uint8Array.of(1),
  });
  assert.deepEqual(existing, record);
  assert.equal(await store.get("ffffffffffffffffffffffffffffffff"), undefined);

  const [item] = db.items("control-plane");
  assert.equal(item?.pk?.S, `pairing-link#${record.linkId}`);
  // DynamoDB's TTL removes the item within days of the second after it expires.
  assert.equal(item?.expiresAtSeconds?.N, "1900000601");
});
