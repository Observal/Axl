// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  encodeWitnessQuorumCertificate,
  encodeWitnessReplicaReceipt,
  encodeWitnessRequest,
  ProtocolValidationError,
  parseWitnessCredential,
  parseWitnessQuorumCertificate,
  parseWitnessReplicaReceipt,
  parseWitnessReplicaTrustSet,
  parseWitnessRequest,
  parseWitnessServiceErrorEnvelope,
  WITNESS_CERTIFICATE_MAX_BYTES,
  WITNESS_RECEIPT_MAX_BYTES,
  WITNESS_REQUEST_MAX_BYTES,
} from "../src/index.ts";

const fixtures = new URL("../../e2ee/fixtures/v1/", import.meta.url);
const registerBytes = readFileSync(new URL("witness-register-v1.bin", fixtures));
const readBytes = readFileSync(new URL("witness-read-v1.bin", fixtures));
const advanceBytes = readFileSync(new URL("witness-advance-v1.bin", fixtures));
const certificateBytes = readFileSync(new URL("witness-quorum-v1.bin", fixtures));

function changed(bytes: Uint8Array, index: number, value: number): Uint8Array {
  const result = bytes.slice();
  result[index] = value;
  return result;
}

function required<T>(value: T | undefined): T {
  assert(value !== undefined);
  return value;
}

test("independently parses and reproduces every Rust witness fixture", () => {
  const register = parseWitnessRequest(registerBytes);
  const read = parseWitnessRequest(readBytes);
  const advance = parseWitnessRequest(advanceBytes);
  assert.equal(register.kind, "register");
  assert.equal(read.kind, "read");
  assert.equal(advance.kind, "advance");
  assert.deepEqual(Buffer.from(encodeWitnessRequest(register)), registerBytes);
  assert.deepEqual(Buffer.from(encodeWitnessRequest(read)), readBytes);
  assert.deepEqual(Buffer.from(encodeWitnessRequest(advance)), advanceBytes);
  assert(register.credential);
  const credential = parseWitnessCredential(register.credential);
  assert.equal(credential.role, "device");
  assert.deepEqual(credential.accountId, register.lineage.accountId);
  assert.deepEqual(credential.installationId, register.lineage.installationId);
  assert.deepEqual(credential.deviceId, register.lineage.deviceId);

  const certificate = parseWitnessQuorumCertificate(certificateBytes);
  assert.deepEqual(
    Buffer.from(
      encodeWitnessQuorumCertificate(certificate.receipts.map((receipt) => receipt.exactBytes)),
    ),
    certificateBytes,
  );
  for (const [index, receipt] of certificate.receipts.entries()) {
    assert.deepEqual(
      Buffer.from(encodeWitnessReplicaReceipt(receipt, receipt.signature)),
      Buffer.from(receipt.exactBytes),
    );
    const standalone = parseWitnessReplicaReceipt(
      readFileSync(new URL(`witness-receipt-${index + 1}.bin`, fixtures)),
    );
    assert.deepEqual(Buffer.from(standalone.exactBytes), Buffer.from(receipt.exactBytes));
  }
});

test("rejects malformed, non-canonical, and oversized witness encodings", () => {
  for (const bytes of [registerBytes, readBytes, advanceBytes]) {
    assert.throws(
      () => parseWitnessRequest(bytes.subarray(0, bytes.length - 1)),
      ProtocolValidationError,
    );
    assert.throws(
      () => parseWitnessRequest(Uint8Array.from([...bytes, 0])),
      ProtocolValidationError,
    );
  }
  assert.throws(
    () => parseWitnessRequest(new Uint8Array(WITNESS_REQUEST_MAX_BYTES + 1)),
    ProtocolValidationError,
  );
  const receipt = parseWitnessQuorumCertificate(certificateBytes).receipts[0];
  assert.throws(
    () => parseWitnessReplicaReceipt(receipt.exactBytes.subarray(0, receipt.exactBytes.length - 1)),
    ProtocolValidationError,
  );
  assert.throws(
    () => parseWitnessReplicaReceipt(new Uint8Array(WITNESS_RECEIPT_MAX_BYTES + 1)),
    ProtocolValidationError,
  );
  assert.throws(
    () => parseWitnessQuorumCertificate(new Uint8Array(WITNESS_CERTIFICATE_MAX_BYTES + 1)),
    ProtocolValidationError,
  );
  for (const count of [1, 2]) {
    const incomplete = Uint8Array.from(certificateBytes);
    incomplete[2] = count;
    assert.throws(() => parseWitnessQuorumCertificate(incomplete), ProtocolValidationError);
  }

  assert.throws(() => parseWitnessRequest(changed(advanceBytes, 0, 1)), ProtocolValidationError);
  const invalidPresence = changed(advanceBytes, 137, 2);
  assert.throws(() => parseWitnessRequest(invalidPresence), ProtocolValidationError);
  const duplicate = parseWitnessQuorumCertificate(certificateBytes);
  assert.throws(
    () =>
      encodeWitnessQuorumCertificate([
        duplicate.receipts[0].exactBytes,
        duplicate.receipts[0].exactBytes,
        duplicate.receipts[2].exactBytes,
      ]),
    ProtocolValidationError,
  );
});

test("validates stable bounded witness service errors", () => {
  assert.deepEqual(
    parseWitnessServiceErrorEnvelope({
      error: { code: "witness_unavailable", message: "All replicas are required" },
    }),
    { error: { code: "witness_unavailable", message: "All replicas are required" } },
  );
  assert.throws(
    () => parseWitnessServiceErrorEnvelope({ error: { code: "fallback_to_two", message: "no" } }),
    ProtocolValidationError,
  );
});

test("validates bounded canonical replica trust sets", () => {
  const certificate = parseWitnessQuorumCertificate(certificateBytes);
  const replicas = certificate.receipts.map((receipt, index) => ({
    replicaId: receipt.replicaId,
    keys: [{ keyId: receipt.witnessKeyId, verificationKey: new Uint8Array(32).fill(index + 1) }],
  }));
  assert.equal(parseWitnessReplicaTrustSet(replicas).length, 3);
  assert.throws(
    () =>
      parseWitnessReplicaTrustSet([
        required(replicas[0]),
        required(replicas[0]),
        required(replicas[2]),
      ] as const),
    ProtocolValidationError,
  );
  assert.throws(() => parseWitnessReplicaTrustSet(replicas.slice(0, 2)), ProtocolValidationError);
});
