// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { parseInstallationId } from "@axl/protocol";

import { DynamoRemoteInstallationStore } from "../src/aws.ts";
import { startFakeDynamoDb } from "./support/fake-dynamodb.ts";

test("DynamoDB installations are written once, never expire, and read back exactly", async (context) => {
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
  const store = new DynamoRemoteInstallationStore({ tableName: "control-plane", client });
  const record = {
    accountId: "4f1c2a3b-5d6e-4f70-8192-a3b4c5d6e7f8",
    installationId: parseInstallationId("01890a5d-ac96-774b-bcce-b302099a8057"),
    publicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE",
    registeredAt: 1_900_000_000_000,
  };

  assert.equal(await store.create(record), undefined);
  assert.deepEqual(await store.get(record.installationId), record);
  // A second write under the ID keeps the first and reports it.
  assert.deepEqual(
    await store.create({ ...record, accountId: "another", publicKey: "AA==" }),
    record,
  );
  assert.equal(
    await store.get(parseInstallationId("01890a5d-ac96-774b-bcce-b302099a8059")),
    undefined,
  );

  const [item] = db.items("control-plane");
  assert.equal(item?.pk?.S, `installation#${record.installationId}`);
  assert.equal(item?.expiresAtSeconds, undefined);
});
