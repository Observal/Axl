// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { ProtocolValidationError } from "./event-envelope.ts";

export const WITNESS_PROTOCOL_VERSION = 1 as const;
export const WITNESS_REQUEST_MAX_BYTES = 1_024;
export const WITNESS_RECEIPT_MAX_BYTES = 1_024;
export const WITNESS_CERTIFICATE_MAX_BYTES = 3 * 1_024;
export const WITNESS_REPLICA_COUNT = 3;
export const WITNESS_MAX_KEYS_PER_REPLICA = 4;
export const WITNESS_CREDENTIAL_MAX_BYTES = 512;
export const WITNESS_PROFILE_ID = "axl-e2ee-mls-pq-v1";
export const WITNESS_PROFILE_REVISION = 1 as const;
export const WITNESS_REQUEST_SIGNATURE_DOMAIN = "Axl rollback witness request v1";
export const WITNESS_RECEIPT_SIGNATURE_DOMAIN = "Axl rollback witness receipt v1";
export const WITNESS_LINEAGE_HASH_DOMAIN = "Axl rollback witness lineage v1";
export const WITNESS_HTTP_CONTENT_TYPE = "application/vnd.axl.rollback-witness-v1";
export const WITNESS_HTTP_PATH = "/v1/e2ee/witness";
export const WITNESS_RECOVERY_EVIDENCE_MAX_AGE_MS = 60_000n;

export const WITNESS_REQUEST_KINDS = Object.freeze({ register: 1, read: 2, advance: 3 } as const);
export type WitnessRequestKind = keyof typeof WITNESS_REQUEST_KINDS;

export const WITNESS_RESULTS = Object.freeze({
  registered: 1,
  head: 2,
  advanced: 3,
  registration_conflict: 4,
  operation_conflict: 5,
  revoked: 6,
  forked: 7,
  stale_expected: 8,
  conflicting_successor: 9,
  historical_fork: 10,
  invalid_expected: 11,
} as const);
export type WitnessResult = keyof typeof WITNESS_RESULTS;

export const WITNESS_SERVICE_ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "witness_unavailable",
  "witness_auth_failed",
  "witness_receipt_invalid",
  "witness_operation_conflict",
  "witness_registration_conflict",
  "witness_conflict",
  "witness_invalid_expected",
  "endpoint_revoked",
  "service_unavailable",
] as const;
export type WitnessServiceErrorCode = (typeof WITNESS_SERVICE_ERROR_CODES)[number];

export interface WitnessLineage {
  readonly profileId: typeof WITNESS_PROFILE_ID;
  readonly profileRevision: typeof WITNESS_PROFILE_REVISION;
  readonly role: "daemon" | "device";
  readonly accountId: Uint8Array;
  readonly installationId: Uint8Array;
  readonly deviceId: Uint8Array;
  readonly cryptoSessionId: Uint8Array;
}

export interface WitnessCredential {
  readonly version: 1;
  readonly role: "daemon" | "device";
  readonly accountId: Uint8Array;
  readonly installationId: Uint8Array;
  readonly deviceId: Uint8Array;
  readonly profileId: typeof WITNESS_PROFILE_ID;
  readonly profileRevision: typeof WITNESS_PROFILE_REVISION;
  readonly verificationKey: Uint8Array;
  readonly exactBytes: Uint8Array;
}

export interface WitnessRequest {
  readonly protocolVersion: typeof WITNESS_PROTOCOL_VERSION;
  readonly kind: WitnessRequestKind;
  readonly lineage: WitnessLineage;
  readonly operationId: Uint8Array;
  readonly nonce: Uint8Array;
  readonly expectedCounter?: bigint;
  readonly expectedCommitment?: Uint8Array;
  readonly proposedCounter?: bigint;
  readonly proposedCommitment?: Uint8Array;
  readonly previousCertificateHash: Uint8Array;
  readonly credentialFingerprint: Uint8Array;
  readonly credential?: Uint8Array;
  readonly signature: Uint8Array;
  readonly signedBytes: Uint8Array;
  readonly exactBytes: Uint8Array;
}

export interface WitnessReplicaReceipt {
  readonly protocolVersion: typeof WITNESS_PROTOCOL_VERSION;
  readonly result: WitnessResult;
  readonly replicaId: Uint8Array;
  readonly witnessKeyId: Uint8Array;
  readonly lineageHash: Uint8Array;
  readonly counter: bigint;
  readonly commitment: Uint8Array;
  readonly predecessorCommitment: Uint8Array;
  readonly operationId: Uint8Array;
  readonly requestHash: Uint8Array;
  readonly ledgerSequence: bigint;
  readonly issuedAtMs: bigint;
  readonly revocationGeneration: bigint;
  readonly signature: Uint8Array;
  readonly signedBytes: Uint8Array;
  readonly exactBytes: Uint8Array;
}

export type UnsignedWitnessReplicaReceipt = Omit<
  WitnessReplicaReceipt,
  "protocolVersion" | "signature" | "signedBytes" | "exactBytes"
>;

export interface WitnessQuorumCertificate {
  readonly protocolVersion: typeof WITNESS_PROTOCOL_VERSION;
  readonly receipts: readonly [WitnessReplicaReceipt, WitnessReplicaReceipt, WitnessReplicaReceipt];
  readonly exactBytes: Uint8Array;
}

export interface WitnessReplicaTrustKey {
  readonly keyId: Uint8Array;
  readonly verificationKey: Uint8Array;
}

export interface WitnessReplicaTrust {
  readonly replicaId: Uint8Array;
  readonly keys: readonly WitnessReplicaTrustKey[];
}

export interface WitnessServiceErrorEnvelope {
  readonly error: {
    readonly code: WitnessServiceErrorCode;
    readonly message: string;
  };
}

function fail(path: string, message: string): never {
  throw new ProtocolValidationError(path, message);
}

function copy(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function witnessBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return equal(left, right);
}

export function witnessBytesHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function validUuidV7(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength === 16 &&
    !bytes.every((byte) => byte === 0) &&
    (bytes[6] ?? 0) >> 4 === 7 &&
    (bytes[8] ?? 0) >> 6 === 2
  );
}

class Cursor {
  private offset = 0;
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  position(): number {
    return this.offset;
  }

  take(length: number, path: string): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) {
      fail(path, "is truncated");
    }
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  u8(path: string): number {
    return this.take(1, path)[0] ?? fail(path, "is truncated");
  }

  u16(path: string): number {
    const bytes = this.take(2, path);
    return ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
  }

  u64(path: string): bigint {
    const bytes = this.take(8, path);
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    return value;
  }

  vector8(maximum: number, path: string): Uint8Array {
    const length = this.u8(`${path}.length`);
    if (length === 0 || length > maximum) fail(path, `must contain 1 through ${maximum} bytes`);
    return this.take(length, path);
  }

  vector16(maximum: number, path: string): Uint8Array {
    const length = this.u16(`${path}.length`);
    if (length === 0 || length > maximum) fail(path, `must contain 1 through ${maximum} bytes`);
    return this.take(length, path);
  }

  optionalBytes(length: number, path: string): Uint8Array | undefined {
    const present = this.u8(`${path}.present`);
    if (present !== 0 && present !== 1) fail(`${path}.present`, "must be zero or one");
    return present === 1 ? this.take(length, path) : undefined;
  }

  optionalU64(path: string): bigint | undefined {
    const present = this.u8(`${path}.present`);
    if (present !== 0 && present !== 1) fail(`${path}.present`, "must be zero or one");
    return present === 1 ? this.u64(path) : undefined;
  }

  optionalVector16(maximum: number, path: string): Uint8Array | undefined {
    const present = this.u8(`${path}.present`);
    if (present !== 0 && present !== 1) fail(`${path}.present`, "must be zero or one");
    return present === 1 ? this.vector16(maximum, path) : undefined;
  }

  finish(path: string): void {
    if (this.offset !== this.bytes.length) fail(path, "has trailing bytes");
  }
}

function putU16(output: number[], value: number): void {
  output.push((value >>> 8) & 0xff, value & 0xff);
}

function putU64(output: number[], value: bigint, path: string): void {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn)
    fail(path, "must be an unsigned 64-bit integer");
  for (let shift = 56n; shift >= 0n; shift -= 8n) output.push(Number((value >> shift) & 0xffn));
}

function putBytes(output: number[], bytes: Uint8Array, length: number, path: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
    fail(path, `must contain exactly ${length} bytes`);
  }
  output.push(...bytes);
}

function putVector8(output: number[], bytes: Uint8Array, maximum: number, path: string): void {
  if (bytes.byteLength === 0 || bytes.byteLength > maximum) {
    fail(path, `must contain 1 through ${maximum} bytes`);
  }
  output.push(bytes.byteLength, ...bytes);
}

function putVector16(output: number[], bytes: Uint8Array, maximum: number, path: string): void {
  if (bytes.byteLength === 0 || bytes.byteLength > maximum) {
    fail(path, `must contain 1 through ${maximum} bytes`);
  }
  putU16(output, bytes.byteLength);
  output.push(...bytes);
}

function putOptionalBytes(
  output: number[],
  bytes: Uint8Array | undefined,
  length: number,
  path: string,
): void {
  output.push(bytes === undefined ? 0 : 1);
  if (bytes !== undefined) putBytes(output, bytes, length, path);
}

function putOptionalU64(output: number[], value: bigint | undefined, path: string): void {
  output.push(value === undefined ? 0 : 1);
  if (value !== undefined) putU64(output, value, path);
}

function parseLineage(cursor: Cursor, path: string): WitnessLineage {
  const profile = new TextDecoder("ascii", { fatal: true }).decode(
    cursor.vector8(255, `${path}.profileId`),
  );
  if (profile !== WITNESS_PROFILE_ID) fail(`${path}.profileId`, "is unsupported");
  if (cursor.u16(`${path}.profileRevision`) !== WITNESS_PROFILE_REVISION) {
    fail(`${path}.profileRevision`, `must equal ${WITNESS_PROFILE_REVISION}`);
  }
  const roleTag = cursor.u8(`${path}.role`);
  const role =
    roleTag === 1 ? "daemon" : roleTag === 2 ? "device" : fail(`${path}.role`, "is invalid");
  const lineage: WitnessLineage = {
    profileId: WITNESS_PROFILE_ID,
    profileRevision: WITNESS_PROFILE_REVISION,
    role,
    accountId: cursor.take(16, `${path}.accountId`),
    installationId: cursor.take(16, `${path}.installationId`),
    deviceId: cursor.take(16, `${path}.deviceId`),
    cryptoSessionId: cursor.take(16, `${path}.cryptoSessionId`),
  };
  validateLineage(lineage, path);
  return lineage;
}

function validateLineage(lineage: WitnessLineage, path: string): void {
  if (!validUuidV7(lineage.installationId)) fail(`${path}.installationId`, "must be a UUIDv7");
  if (!validUuidV7(lineage.cryptoSessionId)) fail(`${path}.cryptoSessionId`, "must be a UUIDv7");
  const zeroDevice = lineage.deviceId.every((byte) => byte === 0);
  if (lineage.role === "daemon" && !zeroDevice) fail(`${path}.deviceId`, "must be zero for daemon");
  if (lineage.role === "device" && !validUuidV7(lineage.deviceId)) {
    fail(`${path}.deviceId`, "must be a UUIDv7 for device");
  }
}

function encodeLineage(lineage: WitnessLineage, path: string): number[] {
  validateLineage(lineage, path);
  if (lineage.profileId !== WITNESS_PROFILE_ID) fail(`${path}.profileId`, "is unsupported");
  if (lineage.profileRevision !== WITNESS_PROFILE_REVISION)
    fail(`${path}.profileRevision`, "is unsupported");
  const output: number[] = [];
  putVector8(output, new TextEncoder().encode(WITNESS_PROFILE_ID), 255, `${path}.profileId`);
  putU16(output, WITNESS_PROFILE_REVISION);
  output.push(lineage.role === "daemon" ? 1 : 2);
  putBytes(output, lineage.accountId, 16, `${path}.accountId`);
  putBytes(output, lineage.installationId, 16, `${path}.installationId`);
  putBytes(output, lineage.deviceId, 16, `${path}.deviceId`);
  putBytes(output, lineage.cryptoSessionId, 16, `${path}.cryptoSessionId`);
  return output;
}

export function encodeWitnessLineage(lineage: WitnessLineage): Uint8Array {
  return Uint8Array.from(encodeLineage(lineage, "lineage"));
}

export function parseWitnessCredential(value: Uint8Array, path = "credential"): WitnessCredential {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > WITNESS_CREDENTIAL_MAX_BYTES
  ) {
    fail(path, `must contain 1 through ${WITNESS_CREDENTIAL_MAX_BYTES} bytes`);
  }
  const cursor = new Cursor(value);
  if (cursor.u16(`${path}.version`) !== 1) fail(`${path}.version`, "must equal 1");
  const roleTag = cursor.u8(`${path}.role`);
  const role =
    roleTag === 1 ? "daemon" : roleTag === 2 ? "device" : fail(`${path}.role`, "is invalid");
  const accountId = cursor.take(16, `${path}.accountId`);
  const installationId = cursor.take(16, `${path}.installationId`);
  const deviceId = cursor.take(16, `${path}.deviceId`);
  const profileId = new TextDecoder("ascii", { fatal: true }).decode(
    cursor.vector8(255, `${path}.profileId`),
  );
  if (profileId !== WITNESS_PROFILE_ID) fail(`${path}.profileId`, "is unsupported");
  if (cursor.u16(`${path}.profileRevision`) !== WITNESS_PROFILE_REVISION) {
    fail(`${path}.profileRevision`, `must equal ${WITNESS_PROFILE_REVISION}`);
  }
  const verificationKey = cursor.take(32, `${path}.verificationKey`);
  cursor.finish(path);
  const lineage = {
    profileId: WITNESS_PROFILE_ID,
    profileRevision: WITNESS_PROFILE_REVISION,
    role,
    accountId,
    installationId,
    deviceId,
    cryptoSessionId: Uint8Array.from([0, 0, 0, 0, 0, 0, 0x70, 0, 0x80, 0, 0, 0, 0, 0, 0, 1]),
  } satisfies WitnessLineage;
  validateLineage(lineage, path);
  if (verificationKey.every((byte) => byte === 0))
    fail(`${path}.verificationKey`, "must not be zero");
  return {
    version: 1,
    role,
    accountId,
    installationId,
    deviceId,
    profileId: WITNESS_PROFILE_ID,
    profileRevision: WITNESS_PROFILE_REVISION,
    verificationKey,
    exactBytes: copy(value),
  };
}

function kindFromTag(tag: number, path: string): WitnessRequestKind {
  const entry = Object.entries(WITNESS_REQUEST_KINDS).find(([, value]) => value === tag);
  return (entry?.[0] as WitnessRequestKind | undefined) ?? fail(path, "is invalid");
}

function resultFromTag(tag: number, path: string): WitnessResult {
  const entry = Object.entries(WITNESS_RESULTS).find(([, value]) => value === tag);
  return (entry?.[0] as WitnessResult | undefined) ?? fail(path, "is invalid");
}

function validateRequestShape(request: WitnessRequest, path: string): void {
  if (request.operationId.every((byte) => byte === 0))
    fail(`${path}.operationId`, "must not be zero");
  if (request.nonce.every((byte) => byte === 0)) fail(`${path}.nonce`, "must not be zero");
  const valid =
    request.kind === "register"
      ? request.expectedCounter === undefined &&
        request.expectedCommitment === undefined &&
        request.proposedCounter === 1n &&
        request.proposedCommitment !== undefined &&
        request.previousCertificateHash.every((byte) => byte === 0) &&
        request.credential !== undefined
      : request.kind === "read"
        ? request.expectedCounter === undefined &&
          request.expectedCommitment === undefined &&
          request.proposedCounter === undefined &&
          request.proposedCommitment === undefined &&
          request.credential === undefined
        : request.expectedCounter !== undefined &&
          request.expectedCommitment !== undefined &&
          request.proposedCounter === request.expectedCounter + 1n &&
          request.proposedCommitment !== undefined &&
          request.credential === undefined;
  if (!valid) fail(path, "has fields inconsistent with its request kind");
}

export function parseWitnessRequest(value: Uint8Array, path = "witnessRequest"): WitnessRequest {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > WITNESS_REQUEST_MAX_BYTES
  ) {
    fail(path, `must contain 1 through ${WITNESS_REQUEST_MAX_BYTES} bytes`);
  }
  const cursor = new Cursor(value);
  if (cursor.u16(`${path}.protocolVersion`) !== WITNESS_PROTOCOL_VERSION) {
    fail(`${path}.protocolVersion`, `must equal ${WITNESS_PROTOCOL_VERSION}`);
  }
  const kind = kindFromTag(cursor.u8(`${path}.kind`), `${path}.kind`);
  const lineage = parseLineage(cursor, `${path}.lineage`);
  const operationId = cursor.take(16, `${path}.operationId`);
  const nonce = cursor.take(32, `${path}.nonce`);
  const expectedCounter = cursor.optionalU64(`${path}.expectedCounter`);
  const expectedCommitment = cursor.optionalBytes(48, `${path}.expectedCommitment`);
  const proposedCounter = cursor.optionalU64(`${path}.proposedCounter`);
  const proposedCommitment = cursor.optionalBytes(48, `${path}.proposedCommitment`);
  const previousCertificateHash = cursor.take(48, `${path}.previousCertificateHash`);
  const credentialFingerprint = cursor.take(48, `${path}.credentialFingerprint`);
  const credential = cursor.optionalVector16(WITNESS_CREDENTIAL_MAX_BYTES, `${path}.credential`);
  const signedBytes = value.slice(0, cursor.position());
  const signature = cursor.take(64, `${path}.signature`);
  cursor.finish(path);
  const request: WitnessRequest = {
    protocolVersion: WITNESS_PROTOCOL_VERSION,
    kind,
    lineage,
    operationId,
    nonce,
    ...(expectedCounter === undefined ? {} : { expectedCounter }),
    ...(expectedCommitment === undefined ? {} : { expectedCommitment }),
    ...(proposedCounter === undefined ? {} : { proposedCounter }),
    ...(proposedCommitment === undefined ? {} : { proposedCommitment }),
    previousCertificateHash,
    credentialFingerprint,
    ...(credential === undefined ? {} : { credential }),
    signature,
    signedBytes,
    exactBytes: copy(value),
  };
  validateRequestShape(request, path);
  if (!equal(encodeWitnessRequest(request), value)) fail(path, "is not canonical");
  return request;
}

export function encodeWitnessRequest(request: WitnessRequest): Uint8Array {
  validateRequestShape(request, "witnessRequest");
  const output = [0, WITNESS_PROTOCOL_VERSION, WITNESS_REQUEST_KINDS[request.kind]];
  output.push(...encodeLineage(request.lineage, "witnessRequest.lineage"));
  putBytes(output, request.operationId, 16, "witnessRequest.operationId");
  putBytes(output, request.nonce, 32, "witnessRequest.nonce");
  putOptionalU64(output, request.expectedCounter, "witnessRequest.expectedCounter");
  putOptionalBytes(output, request.expectedCommitment, 48, "witnessRequest.expectedCommitment");
  putOptionalU64(output, request.proposedCounter, "witnessRequest.proposedCounter");
  putOptionalBytes(output, request.proposedCommitment, 48, "witnessRequest.proposedCommitment");
  putBytes(output, request.previousCertificateHash, 48, "witnessRequest.previousCertificateHash");
  putBytes(output, request.credentialFingerprint, 48, "witnessRequest.credentialFingerprint");
  output.push(request.credential === undefined ? 0 : 1);
  if (request.credential !== undefined) {
    putVector16(
      output,
      request.credential,
      WITNESS_CREDENTIAL_MAX_BYTES,
      "witnessRequest.credential",
    );
  }
  putBytes(output, request.signature, 64, "witnessRequest.signature");
  const bytes = Uint8Array.from(output);
  if (bytes.byteLength > WITNESS_REQUEST_MAX_BYTES) fail("witnessRequest", "exceeds its bound");
  return bytes;
}

export function encodeUnsignedWitnessReplicaReceipt(
  receipt: UnsignedWitnessReplicaReceipt,
): Uint8Array {
  const output = [0, WITNESS_PROTOCOL_VERSION, WITNESS_RESULTS[receipt.result]];
  putBytes(output, receipt.replicaId, 16, "receipt.replicaId");
  putBytes(output, receipt.witnessKeyId, 16, "receipt.witnessKeyId");
  putBytes(output, receipt.lineageHash, 48, "receipt.lineageHash");
  putU64(output, receipt.counter, "receipt.counter");
  putBytes(output, receipt.commitment, 48, "receipt.commitment");
  putBytes(output, receipt.predecessorCommitment, 48, "receipt.predecessorCommitment");
  putBytes(output, receipt.operationId, 16, "receipt.operationId");
  putBytes(output, receipt.requestHash, 48, "receipt.requestHash");
  putU64(output, receipt.ledgerSequence, "receipt.ledgerSequence");
  putU64(output, receipt.issuedAtMs, "receipt.issuedAtMs");
  putU64(output, receipt.revocationGeneration, "receipt.revocationGeneration");
  return Uint8Array.from(output);
}

export function encodeWitnessReplicaReceipt(
  receipt: UnsignedWitnessReplicaReceipt,
  signature: Uint8Array,
): Uint8Array {
  const signed = encodeUnsignedWitnessReplicaReceipt(receipt);
  if (signature.byteLength !== 64) fail("receipt.signature", "must contain exactly 64 bytes");
  const bytes = Uint8Array.from([...signed, ...signature]);
  if (bytes.byteLength > WITNESS_RECEIPT_MAX_BYTES) fail("receipt", "exceeds its bound");
  return bytes;
}

export function parseWitnessReplicaReceipt(
  value: Uint8Array,
  path = "receipt",
): WitnessReplicaReceipt {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > WITNESS_RECEIPT_MAX_BYTES
  ) {
    fail(path, `must contain 1 through ${WITNESS_RECEIPT_MAX_BYTES} bytes`);
  }
  const cursor = new Cursor(value);
  if (cursor.u16(`${path}.protocolVersion`) !== WITNESS_PROTOCOL_VERSION) {
    fail(`${path}.protocolVersion`, `must equal ${WITNESS_PROTOCOL_VERSION}`);
  }
  const result = resultFromTag(cursor.u8(`${path}.result`), `${path}.result`);
  const replicaId = cursor.take(16, `${path}.replicaId`);
  const witnessKeyId = cursor.take(16, `${path}.witnessKeyId`);
  const lineageHash = cursor.take(48, `${path}.lineageHash`);
  const counter = cursor.u64(`${path}.counter`);
  const commitment = cursor.take(48, `${path}.commitment`);
  const predecessorCommitment = cursor.take(48, `${path}.predecessorCommitment`);
  const operationId = cursor.take(16, `${path}.operationId`);
  const requestHash = cursor.take(48, `${path}.requestHash`);
  const ledgerSequence = cursor.u64(`${path}.ledgerSequence`);
  const issuedAtMs = cursor.u64(`${path}.issuedAtMs`);
  const revocationGeneration = cursor.u64(`${path}.revocationGeneration`);
  const signedBytes = value.slice(0, cursor.position());
  const signature = cursor.take(64, `${path}.signature`);
  cursor.finish(path);
  if (replicaId.every((byte) => byte === 0)) fail(`${path}.replicaId`, "must not be zero");
  if (witnessKeyId.every((byte) => byte === 0)) fail(`${path}.witnessKeyId`, "must not be zero");
  const receipt: WitnessReplicaReceipt = {
    protocolVersion: WITNESS_PROTOCOL_VERSION,
    result,
    replicaId,
    witnessKeyId,
    lineageHash,
    counter,
    commitment,
    predecessorCommitment,
    operationId,
    requestHash,
    ledgerSequence,
    issuedAtMs,
    revocationGeneration,
    signature,
    signedBytes,
    exactBytes: copy(value),
  };
  if (!equal(encodeWitnessReplicaReceipt(receipt, signature), value))
    fail(path, "is not canonical");
  return receipt;
}

export function encodeWitnessQuorumCertificate(receipts: readonly Uint8Array[]): Uint8Array {
  if (receipts.length !== WITNESS_REPLICA_COUNT)
    fail("certificate.receipts", "must contain exactly three receipts");
  const parsed = receipts.map((receipt, index) =>
    parseWitnessReplicaReceipt(receipt, `certificate.receipts[${index}]`),
  );
  for (let index = 1; index < parsed.length; index += 1) {
    const previous = parsed[index - 1];
    const current = parsed[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareBytes(previous.replicaId, current.replicaId) >= 0
    ) {
      fail("certificate.receipts", "must use distinct replica IDs in ascending order");
    }
  }
  const output = [0, WITNESS_PROTOCOL_VERSION, WITNESS_REPLICA_COUNT];
  for (const receipt of receipts) {
    putU16(output, receipt.byteLength);
    output.push(...receipt);
  }
  const bytes = Uint8Array.from(output);
  if (bytes.byteLength > WITNESS_CERTIFICATE_MAX_BYTES) fail("certificate", "exceeds its bound");
  return bytes;
}

export function parseWitnessQuorumCertificate(
  value: Uint8Array,
  path = "certificate",
): WitnessQuorumCertificate {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > WITNESS_CERTIFICATE_MAX_BYTES
  ) {
    fail(path, `must contain 1 through ${WITNESS_CERTIFICATE_MAX_BYTES} bytes`);
  }
  const cursor = new Cursor(value);
  if (cursor.u16(`${path}.protocolVersion`) !== WITNESS_PROTOCOL_VERSION) {
    fail(`${path}.protocolVersion`, `must equal ${WITNESS_PROTOCOL_VERSION}`);
  }
  if (cursor.u8(`${path}.receiptCount`) !== WITNESS_REPLICA_COUNT) {
    fail(`${path}.receiptCount`, `must equal ${WITNESS_REPLICA_COUNT}`);
  }
  const receipts = [0, 1, 2].map((index) =>
    parseWitnessReplicaReceipt(
      cursor.vector16(WITNESS_RECEIPT_MAX_BYTES, `${path}.receipts[${index}]`),
      `${path}.receipts[${index}]`,
    ),
  ) as [WitnessReplicaReceipt, WitnessReplicaReceipt, WitnessReplicaReceipt];
  cursor.finish(path);
  if (
    compareBytes(receipts[0].replicaId, receipts[1].replicaId) >= 0 ||
    compareBytes(receipts[1].replicaId, receipts[2].replicaId) >= 0
  ) {
    fail(`${path}.receipts`, "must use distinct replica IDs in ascending order");
  }
  if (
    !equal(encodeWitnessQuorumCertificate(receipts.map((receipt) => receipt.exactBytes)), value)
  ) {
    fail(path, "is not canonical");
  }
  return { protocolVersion: WITNESS_PROTOCOL_VERSION, receipts, exactBytes: copy(value) };
}

export function parseWitnessReplicaTrustSet(
  value: readonly WitnessReplicaTrust[],
): readonly WitnessReplicaTrust[] {
  if (value.length !== WITNESS_REPLICA_COUNT)
    fail("trust.replicas", "must contain exactly three replicas");
  const replicas = value.map((replica, replicaIndex) => {
    putBytes([], replica.replicaId, 16, `trust.replicas[${replicaIndex}].replicaId`);
    if (replica.replicaId.every((byte) => byte === 0))
      fail(`trust.replicas[${replicaIndex}].replicaId`, "must not be zero");
    if (replica.keys.length === 0 || replica.keys.length > WITNESS_MAX_KEYS_PER_REPLICA) {
      fail(
        `trust.replicas[${replicaIndex}].keys`,
        `must contain 1 through ${WITNESS_MAX_KEYS_PER_REPLICA} keys`,
      );
    }
    const keys = replica.keys.map((key, keyIndex) => {
      putBytes([], key.keyId, 16, `trust.replicas[${replicaIndex}].keys[${keyIndex}].keyId`);
      putBytes(
        [],
        key.verificationKey,
        32,
        `trust.replicas[${replicaIndex}].keys[${keyIndex}].verificationKey`,
      );
      if (
        key.keyId.every((byte) => byte === 0) ||
        key.verificationKey.every((byte) => byte === 0)
      ) {
        fail(
          `trust.replicas[${replicaIndex}].keys[${keyIndex}]`,
          "must not contain a zero identifier or key",
        );
      }
      return { keyId: copy(key.keyId), verificationKey: copy(key.verificationKey) };
    });
    keys.sort((left, right) => compareBytes(left.keyId, right.keyId));
    return { replicaId: copy(replica.replicaId), keys };
  });
  replicas.sort((left, right) => compareBytes(left.replicaId, right.replicaId));
  const keyIds = new Set<string>();
  const publicKeys = new Set<string>();
  for (let index = 0; index < replicas.length; index += 1) {
    const replica = replicas[index];
    const prior = replicas[index - 1];
    if (
      replica === undefined ||
      (prior !== undefined && equal(prior.replicaId, replica.replicaId))
    ) {
      fail("trust.replicas", "must contain distinct replica IDs");
    }
    for (const key of replica.keys) {
      const keyId = witnessBytesHex(key.keyId);
      const publicKey = witnessBytesHex(key.verificationKey);
      if (keyIds.has(keyId) || publicKeys.has(publicKey))
        fail("trust.replicas", "must not reuse key IDs or verification keys");
      keyIds.add(keyId);
      publicKeys.add(publicKey);
    }
  }
  return replicas;
}

export function parseWitnessHttpRequestBody(value: Uint8Array): Uint8Array {
  parseWitnessRequest(value);
  return copy(value);
}

export function parseWitnessHttpResponseBody(value: Uint8Array): Uint8Array {
  parseWitnessQuorumCertificate(value);
  return copy(value);
}

export function parseWitnessServiceErrorEnvelope(value: unknown): WitnessServiceErrorEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("response", "must be an object");
  }
  const response = value as Record<string, unknown>;
  if (Object.keys(response).length !== 1 || !("error" in response)) {
    fail("response", "must contain only error");
  }
  if (
    typeof response.error !== "object" ||
    response.error === null ||
    Array.isArray(response.error)
  ) {
    fail("response.error", "must be an object");
  }
  const error = response.error as Record<string, unknown>;
  if (Object.keys(error).length !== 2 || !("code" in error) || !("message" in error)) {
    fail("response.error", "must contain only code and message");
  }
  if (
    typeof error.code !== "string" ||
    !(WITNESS_SERVICE_ERROR_CODES as readonly string[]).includes(error.code)
  ) {
    fail("response.error.code", "is not a stable witness service error code");
  }
  if (
    typeof error.message !== "string" ||
    error.message.length === 0 ||
    error.message.length > 256
  ) {
    fail("response.error.message", "must contain 1 through 256 characters");
  }
  return {
    error: {
      code: error.code as WitnessServiceErrorCode,
      message: error.message,
    },
  };
}
