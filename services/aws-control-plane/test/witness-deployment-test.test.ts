// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import test, { type TestContext } from "node:test";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { WitnessServiceError } from "@axl/control-plane";
import {
  parseWitnessQuorumCertificate,
  WITNESS_REQUEST_SIGNATURE_DOMAIN,
  witnessBytesHex,
} from "@axl/protocol";

import {
  createDeploymentTestWitness,
  type DeploymentTestWitnessKey,
} from "../src/witness-deployment-test.ts";
import {
  DynamoWitnessHighWaterJournal,
  DynamoWitnessReplicaStorage,
} from "../src/witness-dynamo.ts";
import { startFakeDynamoDb } from "./support/fake-dynamodb.ts";

const PROFILE = new TextEncoder().encode("axl-e2ee-mls-pq-v1");
const ACCOUNT = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const ACCOUNT_ID = [
  witnessBytesHex(ACCOUNT.subarray(0, 4)),
  witnessBytesHex(ACCOUNT.subarray(4, 6)),
  witnessBytesHex(ACCOUNT.subarray(6, 8)),
  witnessBytesHex(ACCOUNT.subarray(8, 10)),
  witnessBytesHex(ACCOUNT.subarray(10)),
].join("-");
const principal = { accountId: ACCOUNT_ID };

function raw(key: KeyObject): Uint8Array {
  return new Uint8Array(createPublicKey(key).export({ format: "der", type: "spki" })).slice(-32);
}

function uuid(value: number): Uint8Array {
  const bytes = new Uint8Array(16).fill(value);
  bytes[6] = 0x70 | (value & 0x0f);
  bytes[8] = 0x80 | (value & 0x3f);
  return bytes;
}

const u16 = (value: number) => [(value >>> 8) & 0xff, value & 0xff];
const u64 = (value: bigint) =>
  Array.from({ length: 8 }, (_, index) => Number((value >> BigInt(56 - index * 8)) & 0xffn));

/** One device endpoint with its own lineage, signing witness requests the way endpoints do. */
function endpoint(session: number) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const installationId = uuid(2);
  const deviceId = uuid(3);
  const credential = Uint8Array.from([
    ...u16(1),
    2,
    ...ACCOUNT,
    ...installationId,
    ...deviceId,
    PROFILE.byteLength,
    ...PROFILE,
    ...u16(1),
    ...raw(privateKey),
  ]);
  let operation = session * 16;
  const request = (
    kind: 1 | 2 | 3,
    fields: { readonly expected?: bigint; readonly commitment?: number } = {},
  ) => {
    operation += 1;
    const operationId = new Uint8Array(16).fill(operation);
    const counter = fields.expected;
    const prefix = Uint8Array.from([
      ...u16(1),
      kind,
      PROFILE.byteLength,
      ...PROFILE,
      ...u16(1),
      2,
      ...ACCOUNT,
      ...installationId,
      ...deviceId,
      ...uuid(session),
      ...operationId,
      ...new Uint8Array(32).fill(operation),
      ...(counter === undefined ? [0] : [1, ...u64(counter)]),
      ...(counter === undefined ? [0] : [1, ...new Uint8Array(48).fill(Number(counter))]),
      ...(kind === 2 ? [0] : [1, ...u64((counter ?? 0n) + 1n)]),
      ...(kind === 2 ? [0] : [1, ...new Uint8Array(48).fill(fields.commitment ?? 0)]),
      ...new Uint8Array(48),
      ...createHash("sha384").update(credential).digest(),
      ...(kind === 1 ? [1, ...u16(credential.byteLength), ...credential] : [0]),
    ]);
    const signature = sign(
      null,
      Buffer.concat([Buffer.from(WITNESS_REQUEST_SIGNATURE_DOMAIN), Buffer.from(prefix)]),
      privateKey,
    );
    return Uint8Array.from([...prefix, ...signature]);
  };
  return {
    register: () => request(1, { commitment: 1 }),
    read: () => request(2),
    /** Advance from counter `expected`, whose commitment is filled with `expected`. */
    advance: (expected: bigint) => request(3, { expected, commitment: Number(expected) + 1 }),
  };
}

function keys(): DeploymentTestWitnessKey[] {
  return [1, 2, 3].map((index) => {
    const { privateKey } = generateKeyPairSync("ed25519");
    return {
      replicaId: new Uint8Array(16).fill(0x40 + index),
      keyId: new Uint8Array(16).fill(0x50 + index),
      privateKey,
      verificationKey: raw(privateKey),
    };
  });
}

async function durable(context: TestContext) {
  const db = await startFakeDynamoDb();
  db.pageSize = 5;
  const client = new DynamoDBClient({
    endpoint: db.endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  context.after(async () => {
    client.destroy();
    await db.close();
  });
  const witnessKeys = keys();
  return (tableName = "witness") =>
    createDeploymentTestWitness({
      keys: witnessKeys,
      accountId: ACCOUNT_ID,
      stores: (key) => ({
        storage: new DynamoWitnessReplicaStorage({
          tableName: key === witnessKeys[0] ? tableName : "witness",
          replicaId: key.replicaId,
          client,
        }),
        journal: new DynamoWitnessHighWaterJournal({
          tableName: "journal",
          replicaId: key.replicaId,
          client,
        }),
      }),
    });
}

function result(certificate: Uint8Array) {
  const receipt = parseWitnessQuorumCertificate(certificate).receipts[0];
  return { result: receipt?.result, counter: receipt?.counter };
}

test("paired endpoints keep their witness heads across a control-plane restart", async (context) => {
  const start = await durable(context);
  const phone = endpoint(4);
  const daemon = endpoint(5);
  let witness = await start();
  assert.deepEqual(result(await witness.submit(principal, phone.register())), {
    result: "registered",
    counter: 1n,
  });
  assert.deepEqual(result(await witness.submit(principal, phone.read())), {
    result: "head",
    counter: 1n,
  });
  const accepted = phone.advance(1n);
  const acceptedCertificate = await witness.submit(principal, accepted);
  assert.deepEqual(result(acceptedCertificate), { result: "advanced", counter: 2n });
  await witness.submit(principal, daemon.register());

  witness = await start();
  // Nothing is voted on for a lineage until a fresh read recovers it.
  await assert.rejects(
    witness.submit(principal, phone.advance(2n)),
    (error) => error instanceof WitnessServiceError && error.code === "witness_unavailable",
  );
  assert.deepEqual(result(await witness.submit(principal, phone.read())), {
    result: "head",
    counter: 2n,
  });
  assert.deepEqual(result(await witness.submit(principal, phone.advance(2n))), {
    result: "advanced",
    counter: 3n,
  });
  // A retried operation from before the restart gets its original certificate back.
  assert.deepEqual(await witness.submit(principal, accepted), acceptedCertificate);
  assert.deepEqual(result(await witness.submit(principal, daemon.read())), {
    result: "head",
    counter: 1n,
  });
  // A new pairing registers without waiting for any other lineage.
  const next = endpoint(6);
  assert.deepEqual(result(await witness.submit(principal, next.register())), {
    result: "registered",
    counter: 1n,
  });

  // A second restart resumes again from the same durable state.
  witness = await start();
  assert.deepEqual(result(await witness.submit(principal, phone.read())), {
    result: "head",
    counter: 3n,
  });
});

test("replicas that disagree about holding state refuse to start", async (context) => {
  const start = await durable(context);
  const witness = await start();
  await witness.submit(principal, endpoint(7).register());
  await assert.rejects(start("empty-witness"), /disagree/u);
});

test("without durable stores the witness starts empty in process memory", async () => {
  const witness = await createDeploymentTestWitness({ keys: keys(), accountId: ACCOUNT_ID });
  assert.equal(
    result(await witness.submit(principal, endpoint(8).register())).result,
    "registered",
  );
});
