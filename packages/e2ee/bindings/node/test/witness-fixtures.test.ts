// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const fixtures = new URL("../../../fixtures/v1/", import.meta.url);
const profile = Buffer.from("axl-e2ee-mls-pq-v1");
const requestDomain = Buffer.from("Axl rollback witness request v1");
const receiptDomain = Buffer.from("Axl rollback witness receipt v1");

class Cursor {
  readonly bytes: Buffer;
  offset: number;

  constructor(bytes: Buffer) {
    this.bytes = bytes;
    this.offset = 0;
  }
  take(length: number): Buffer {
    assert(Number.isSafeInteger(length) && length >= 0);
    const end = this.offset + length;
    assert(end <= this.bytes.length, "fixture is truncated");
    const value = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return value;
  }
  u8(): number {
    return this.take(1).readUInt8();
  }
  u16(): number {
    return this.take(2).readUInt16BE();
  }
  u64(): bigint {
    return this.take(8).readBigUInt64BE();
  }
  optional(length: number): Buffer | undefined {
    const present = this.u8();
    assert(present === 0 || present === 1);
    return present === 1 ? this.take(length) : undefined;
  }
  optionalU64(): bigint | undefined {
    return this.optional(8)?.readBigUInt64BE();
  }
  vector16(maximum: number): Buffer {
    const length = this.u16();
    assert(length > 0 && length <= maximum);
    return this.take(length);
  }
  optionalVector16(maximum: number): Buffer | undefined {
    const present = this.u8();
    assert(present === 0 || present === 1);
    return present === 1 ? this.vector16(maximum) : undefined;
  }
  finish(): void {
    assert.equal(this.offset, this.bytes.length, "fixture has trailing bytes");
  }
}

function metadata(): Record<string, string> {
  return Object.fromEntries(
    readFileSync(new URL("witness-expected.txt", fixtures), "utf8")
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=")),
  );
}

function required(record: Record<string, string>, key: string): string {
  const value = record[key];
  assert(value, `missing fixture metadata: ${key}`);
  return value;
}

function digest(bytes: Buffer): Buffer {
  return createHash("sha384").update(bytes).digest();
}

function publicKey(raw: Buffer) {
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    format: "der",
    type: "spki",
  });
}

function parseLineage(cursor: Cursor) {
  const profileBytes = cursor.take(cursor.u8());
  assert.deepEqual(profileBytes, profile);
  assert.equal(cursor.u16(), 1);
  const role = cursor.u8();
  assert(role === 1 || role === 2);
  return {
    role,
    accountId: cursor.take(16),
    installationId: cursor.take(16),
    deviceId: cursor.take(16),
    cryptoSessionId: cursor.take(16),
  };
}

function parseRequest(bytes: Buffer) {
  assert(bytes.length <= 1024);
  const cursor = new Cursor(bytes);
  assert.equal(cursor.u16(), 1);
  const kind = cursor.u8();
  assert(kind >= 1 && kind <= 3);
  const lineage = parseLineage(cursor);
  const operationId = cursor.take(16);
  const nonce = cursor.take(32);
  const expectedCounter = cursor.optionalU64();
  const expectedCommitment = cursor.optional(48);
  const proposedCounter = cursor.optionalU64();
  const proposedCommitment = cursor.optional(48);
  const previousCertificateHash = cursor.take(48);
  const credentialFingerprint = cursor.take(48);
  const credential = cursor.optionalVector16(512);
  const signed = bytes.subarray(0, cursor.offset);
  const signature = cursor.take(64);
  cursor.finish();
  return {
    kind,
    lineage,
    operationId,
    nonce,
    expectedCounter,
    expectedCommitment,
    proposedCounter,
    proposedCommitment,
    previousCertificateHash,
    credentialFingerprint,
    credential,
    signed,
    signature,
  };
}

function parseCredential(bytes: Buffer) {
  const cursor = new Cursor(bytes);
  assert.equal(cursor.u16(), 1);
  const role = cursor.u8();
  cursor.take(16 * 3);
  assert.deepEqual(cursor.take(cursor.u8()), profile);
  assert.equal(cursor.u16(), 1);
  const key = cursor.take(32);
  cursor.finish();
  return { role, key };
}

function parseReceipt(bytes: Buffer) {
  assert(bytes.length <= 1024);
  const cursor = new Cursor(bytes);
  assert.equal(cursor.u16(), 1);
  const result = cursor.u8();
  const replicaId = cursor.take(16);
  const keyId = cursor.take(16);
  const lineageHash = cursor.take(48);
  const counter = cursor.u64();
  const commitment = cursor.take(48);
  const predecessor = cursor.take(48);
  const operationId = cursor.take(16);
  const requestHash = cursor.take(48);
  const ledgerSequence = cursor.u64();
  const issuedAtMs = cursor.u64();
  const revocationGeneration = cursor.u64();
  const signed = bytes.subarray(0, cursor.offset);
  const signature = cursor.take(64);
  cursor.finish();
  return {
    result,
    replicaId,
    keyId,
    lineageHash,
    counter,
    commitment,
    predecessor,
    operationId,
    requestHash,
    ledgerSequence,
    issuedAtMs,
    revocationGeneration,
    signed,
    signature,
  };
}

function parseCertificate(bytes: Buffer) {
  assert(bytes.length <= 3 * 1024);
  const cursor = new Cursor(bytes);
  assert.equal(cursor.u16(), 1);
  assert.equal(cursor.u8(), 3);
  const receipts = Array.from({ length: 3 }, () => parseReceipt(cursor.vector16(1024)));
  cursor.finish();
  return receipts;
}

test("TypeScript independently consumes Rust witness fixtures", () => {
  const expected = metadata();
  const registerBytes = readFileSync(new URL("witness-register-v1.bin", fixtures));
  const readBytes = readFileSync(new URL("witness-read-v1.bin", fixtures));
  const advanceBytes = readFileSync(new URL("witness-advance-v1.bin", fixtures));
  const certificateBytes = readFileSync(new URL("witness-quorum-v1.bin", fixtures));
  const artifacts: Array<[string, Buffer]> = [
    ["register", registerBytes],
    ["read", readBytes],
    ["request", advanceBytes],
    ["certificate", certificateBytes],
  ];
  for (const [name, bytes] of artifacts) {
    assert.equal(bytes.length, Number(required(expected, `${name}_bytes`)));
    assert.equal(digest(bytes).toString("hex"), required(expected, `${name}_sha384`));
  }

  const register = parseRequest(registerBytes);
  const read = parseRequest(readBytes);
  const advance = parseRequest(advanceBytes);
  assert.equal(register.kind, 1);
  assert.equal(register.proposedCounter, 1n);
  assert(register.credential);
  const registrationCredential = parseCredential(register.credential);
  assert.equal(registrationCredential.role, register.lineage.role);
  assert.deepEqual(digest(register.credential), register.credentialFingerprint);
  assert(
    verify(
      null,
      Buffer.concat([requestDomain, register.signed]),
      publicKey(registrationCredential.key),
      register.signature,
    ),
  );

  assert.equal(read.kind, 2);
  assert.equal(read.expectedCounter, undefined);
  assert.equal(read.proposedCounter, undefined);
  assert.equal(read.credential, undefined);
  assert(
    verify(
      null,
      Buffer.concat([requestDomain, read.signed]),
      publicKey(Buffer.from(required(expected, "endpoint_public_key"), "hex")),
      read.signature,
    ),
  );

  assert.equal(advance.kind, 3);
  assert.equal(advance.expectedCounter, 1n);
  assert.equal(advance.proposedCounter, 2n);
  assert.equal(advance.credential, undefined);
  assert(
    verify(
      null,
      Buffer.concat([requestDomain, advance.signed]),
      publicKey(Buffer.from(required(expected, "endpoint_public_key"), "hex")),
      advance.signature,
    ),
  );

  const receipts = parseCertificate(certificateBytes);
  const firstReceipt = receipts[0];
  assert(firstReceipt);
  assert.equal(new Set(receipts.map((receipt) => receipt.replicaId.toString("hex"))).size, 3);
  for (const [index, receipt] of receipts.entries()) {
    const ordinal = index + 1;
    assert.equal(receipt.result, 3);
    assert.deepEqual(receipt.operationId, advance.operationId);
    assert.deepEqual(receipt.requestHash, digest(advanceBytes));
    assert.deepEqual(receipt.commitment, advance.proposedCommitment);
    assert.deepEqual(receipt.predecessor, advance.expectedCommitment);
    assert.equal(receipt.counter, advance.proposedCounter);
    assert.equal(receipt.revocationGeneration, firstReceipt.revocationGeneration);
    assert.equal(receipt.replicaId.toString("hex"), required(expected, `replica_${ordinal}_id`));
    assert.equal(receipt.keyId.toString("hex"), required(expected, `replica_${ordinal}_key_id`));
    assert(
      verify(
        null,
        Buffer.concat([receiptDomain, receipt.signed]),
        publicKey(Buffer.from(required(expected, `replica_${ordinal}_public_key`), "hex")),
        receipt.signature,
      ),
    );
  }
});
