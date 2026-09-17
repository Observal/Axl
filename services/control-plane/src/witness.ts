// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { createHash, createPublicKey, verify } from "node:crypto";

import {
  encodeWitnessQuorumCertificate,
  parseWitnessCredential,
  parseWitnessQuorumCertificate,
  parseWitnessReplicaReceipt,
  parseWitnessReplicaTrustSet,
  parseWitnessRequest,
  WITNESS_CERTIFICATE_MAX_BYTES,
  WITNESS_LINEAGE_HASH_DOMAIN,
  WITNESS_RECEIPT_SIGNATURE_DOMAIN,
  WITNESS_RECOVERY_EVIDENCE_MAX_AGE_MS,
  WITNESS_REPLICA_COUNT,
  WITNESS_REQUEST_MAX_BYTES,
  WITNESS_REQUEST_SIGNATURE_DOMAIN,
  type WitnessCredential,
  type WitnessReplicaReceipt,
  type WitnessReplicaTrust,
  type WitnessRequest,
  type WitnessResult,
  type WitnessServiceErrorCode,
  witnessBytesEqual,
  witnessBytesHex,
} from "@axl/protocol";

export interface HostedWitnessPrincipal {
  readonly accountId: string;
}

export interface WitnessAdmission {
  readonly principal: HostedWitnessPrincipal;
  readonly mode: "active" | "receipt_recovery";
}

export interface HostedWitnessAuthorizer {
  authorize(
    principal: HostedWitnessPrincipal,
    request: WitnessRequest,
  ): Promise<WitnessAdmission | undefined>;
}

export interface WitnessReplicaAdmissionVerifier {
  validate(
    admission: WitnessAdmission,
    request: WitnessRequest,
  ): Promise<WitnessAdmission | undefined>;
}

export interface WitnessCredentialBinding {
  readonly lineageHash: Uint8Array;
  readonly credentialFingerprint: Uint8Array;
  readonly credentialBytes: Uint8Array;
  readonly verificationKey: Uint8Array;
}

export interface WitnessEndpointCredentialDirectory {
  authorizeRegistration(
    admission: WitnessAdmission,
    request: WitnessRequest,
    credential: WitnessCredential,
  ): Promise<boolean>;
  lookupAuthorizedBinding(
    admission: WitnessAdmission,
    request: WitnessRequest,
    immutableBinding: WitnessCredentialBinding,
  ): Promise<WitnessCredentialBinding | undefined>;
}

export interface WitnessClock {
  nowMs(): bigint;
}

export interface WitnessSecurityAuditEvent {
  readonly code:
    | "admission_rejected"
    | "endpoint_proof_invalid"
    | "replica_unavailable"
    | "receipt_invalid"
    | "replica_disagreement"
    | "journal_inconsistent"
    | "replica_behind";
  readonly lineageHash?: string;
  readonly replicaId?: string;
}

export interface WitnessSecurityAuditSink {
  emit(event: WitnessSecurityAuditEvent): Promise<void>;
}

export class WitnessServiceError extends Error {
  readonly code: WitnessServiceErrorCode;
  readonly httpStatus: number;

  constructor(code: WitnessServiceErrorCode, message: string, httpStatus: number) {
    super(message);
    this.name = "WitnessServiceError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface WitnessHead {
  readonly counter: bigint;
  readonly commitment: Uint8Array;
  readonly predecessorCommitment: Uint8Array;
}

export interface WitnessLedgerPosition {
  readonly sequence: bigint;
  readonly revocationGeneration: bigint;
}

export interface WitnessAcceptedOperation {
  readonly operationId: Uint8Array;
  readonly requestHash: Uint8Array;
  readonly requestBytes: Uint8Array;
  readonly result: "registered" | "advanced";
  readonly successor: WitnessHead;
  readonly acceptedAt: WitnessLedgerPosition;
  readonly receiptFields: WitnessReceiptFields;
  readonly exactReceipt?: Uint8Array;
  readonly journaled: boolean;
}

export interface WitnessSuccessor {
  readonly predecessorCounter: bigint;
  readonly predecessorCommitment: Uint8Array;
  readonly head: WitnessHead;
}

export interface WitnessReplicaLedgerEvent {
  readonly sequence: bigint;
  readonly revocationGeneration: bigint;
  readonly kind: "registered" | "advanced" | "forked" | "revoked";
  readonly requestHash?: Uint8Array;
  readonly requestBytes?: Uint8Array;
  readonly operationId?: Uint8Array;
  readonly predecessorCounter?: bigint;
  readonly predecessorCommitment?: Uint8Array;
  readonly counter: bigint;
  readonly commitment: Uint8Array;
  readonly forkResult?: "conflicting_successor" | "historical_fork";
}

export interface WitnessReplicaRecord {
  readonly lineageHash: Uint8Array;
  readonly binding: WitnessCredentialBinding;
  readonly ledger: readonly WitnessReplicaLedgerEvent[];
  readonly operations: readonly WitnessAcceptedOperation[];
  readonly retainedResponses: readonly {
    readonly requestHash: Uint8Array;
    readonly requestBytes: Uint8Array;
    readonly exactReceipt: Uint8Array;
  }[];
  readonly pendingJournalSequence?: bigint;
  readonly recoveryRequestHashes?: readonly Uint8Array[];
  readonly derivedHead?: WitnessHead;
}

export interface WitnessReplicaTransaction<T> {
  readonly value: T;
  readonly next?: WitnessReplicaRecord;
}

export interface WitnessReplicaStorage {
  transact<T>(
    lineageHash: Uint8Array,
    transaction: (current: WitnessReplicaRecord | undefined) => WitnessReplicaTransaction<T>,
  ): Promise<T>;
  listLineageHashes(): Promise<readonly Uint8Array[]>;
  read(lineageHash: Uint8Array): Promise<WitnessReplicaRecord | undefined>;
}

export interface WitnessHighWaterEntry {
  readonly lineageHash: Uint8Array;
  readonly sequence: bigint;
  readonly counter: bigint;
  readonly commitment: Uint8Array;
  readonly revocationGeneration: bigint;
  readonly eventHash: Uint8Array;
}

export interface WitnessHighWaterJournal {
  append(entry: WitnessHighWaterEntry): Promise<void>;
  latest(lineageHash: Uint8Array): Promise<WitnessHighWaterEntry | undefined>;
}

const receiptToken = Symbol("canonical-witness-receipt");

export class CanonicalWitnessReceipt {
  readonly #token: symbol;
  readonly #signedBytes: Uint8Array;

  constructor(token: typeof receiptToken, signedBytes: Uint8Array) {
    if (token !== receiptToken) throw new TypeError("Canonical witness receipts are internal");
    this.#token = token;
    this.#signedBytes = signedBytes.slice();
  }

  bytesForSigning(): Uint8Array {
    if (this.#token !== receiptToken) throw new TypeError("Invalid canonical witness receipt");
    return this.#signedBytes.slice();
  }
}

export interface WitnessReceiptSigner {
  readonly replicaId: Uint8Array;
  readonly keyId: Uint8Array;
  sign(receipt: CanonicalWitnessReceipt): Promise<Uint8Array>;
}

export interface WitnessReplicaClient {
  readonly replicaId: Uint8Array;
  submit(admission: WitnessAdmission, exactRequest: Uint8Array): Promise<Uint8Array>;
}

export interface WitnessReplicaRevocationClient {
  readonly replicaId: Uint8Array;
  revoke(lineageHash: Uint8Array, generation: bigint): Promise<void>;
}

export interface HostedWitnessRevocationAuthorizer {
  authorize(
    principal: HostedWitnessPrincipal,
    lineageHash: Uint8Array,
    generation: bigint,
  ): Promise<boolean>;
}

export interface WitnessGatewayDeadline {
  waitForReplica(client: WitnessReplicaClient, operation: Promise<Uint8Array>): Promise<Uint8Array>;
}

interface WitnessReceiptFields {
  readonly result: WitnessResult;
  readonly lineageHash: Uint8Array;
  readonly counter: bigint;
  readonly commitment: Uint8Array;
  readonly predecessorCommitment: Uint8Array;
  readonly operationId: Uint8Array;
  readonly requestHash: Uint8Array;
  readonly ledgerSequence: bigint;
  readonly issuedAtMs: bigint;
  readonly revocationGeneration: bigint;
}

interface ReplicaDecision {
  readonly result: WitnessResult;
  readonly mutation?: "accept" | "fork";
  readonly exactReceipt?: Uint8Array;
  readonly existing?: WitnessAcceptedOperation;
  readonly forkResult?: "conflicting_successor" | "historical_fork";
}

interface RebuiltState {
  readonly head: WitnessHead;
  readonly successors: readonly WitnessSuccessor[];
  readonly revocation?: WitnessLedgerPosition;
  readonly forkResult?: "conflicting_successor" | "historical_fork";
  readonly lastSequence: bigint;
  readonly revocationGeneration: bigint;
}

function digest(...parts: readonly Uint8Array[]): Uint8Array {
  const hash = createHash("sha384");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function zero(length: number): Uint8Array {
  return new Uint8Array(length);
}

function cloneHead(head: WitnessHead): WitnessHead {
  return {
    counter: head.counter,
    commitment: head.commitment.slice(),
    predecessorCommitment: head.predecessorCommitment.slice(),
  };
}

function lineageHash(request: WitnessRequest): Uint8Array {
  const profile = utf8(request.lineage.profileId);
  const encoded = Uint8Array.from([
    profile.byteLength,
    ...profile,
    0,
    request.lineage.profileRevision,
    request.lineage.role === "daemon" ? 1 : 2,
    ...request.lineage.accountId,
    ...request.lineage.installationId,
    ...request.lineage.deviceId,
    ...request.lineage.cryptoSessionId,
  ]);
  return digest(utf8(WITNESS_LINEAGE_HASH_DOMAIN), encoded);
}

function operation(request: WitnessRequest): WitnessHead {
  if (request.proposedCounter === undefined || request.proposedCommitment === undefined) {
    throw new WitnessServiceError("bad_request", "A mutating request has no successor", 400);
  }
  return {
    counter: request.proposedCounter,
    commitment: request.proposedCommitment.slice(),
    predecessorCommitment: request.expectedCommitment?.slice() ?? zero(48),
  };
}

function requestHead(request: WitnessRequest, rebuilt: RebuiltState): WitnessHead {
  return request.kind === "read" ? rebuilt.head : operation(request);
}

function publicKey(raw: Uint8Array) {
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
}

function endpointSignatureValid(request: WitnessRequest, key: Uint8Array): boolean {
  return verify(
    null,
    Buffer.concat([
      Buffer.from(WITNESS_REQUEST_SIGNATURE_DOMAIN),
      Buffer.from(request.signedBytes),
    ]),
    publicKey(key),
    request.signature,
  );
}

function receiptSignatureValid(receipt: WitnessReplicaReceipt, key: Uint8Array): boolean {
  return verify(
    null,
    Buffer.concat([
      Buffer.from(WITNESS_RECEIPT_SIGNATURE_DOMAIN),
      Buffer.from(receipt.signedBytes),
    ]),
    publicKey(key),
    receipt.signature,
  );
}

function verifyReceiptForRequest(
  request: WitnessRequest,
  receipt: WitnessReplicaReceipt,
  trust: readonly WitnessReplicaTrust[],
): void {
  const replica = trust.find((candidate) =>
    witnessBytesEqual(candidate.replicaId, receipt.replicaId),
  );
  const key = replica?.keys.find((candidate) =>
    witnessBytesEqual(candidate.keyId, receipt.witnessKeyId),
  );
  if (key === undefined || !receiptSignatureValid(receipt, key.verificationKey)) {
    throw new WitnessServiceError(
      "witness_receipt_invalid",
      "Witness receipt signature is invalid",
      400,
    );
  }
  if (
    !witnessBytesEqual(receipt.lineageHash, lineageHash(request)) ||
    !witnessBytesEqual(receipt.operationId, request.operationId) ||
    !witnessBytesEqual(receipt.requestHash, digest(request.exactBytes))
  ) {
    throw new WitnessServiceError(
      "witness_receipt_invalid",
      "Witness receipt does not bind the exact request",
      400,
    );
  }
}

function sameHead(left: WitnessHead, right: WitnessHead): boolean {
  return left.counter === right.counter && witnessBytesEqual(left.commitment, right.commitment);
}

function rebuild(record: WitnessReplicaRecord): RebuiltState {
  let head: WitnessHead = { counter: 0n, commitment: zero(48), predecessorCommitment: zero(48) };
  let expectedSequence = 1n;
  let revocationGeneration = 0n;
  let revocation: WitnessLedgerPosition | undefined;
  let forkResult: RebuiltState["forkResult"];
  const successors: WitnessSuccessor[] = [];
  for (const event of record.ledger) {
    if (event.sequence !== expectedSequence || event.revocationGeneration < revocationGeneration) {
      throw new WitnessServiceError(
        "service_unavailable",
        "Witness append-only history is corrupt",
        503,
      );
    }
    expectedSequence += 1n;
    revocationGeneration = event.revocationGeneration;
    if (event.kind === "registered" || event.kind === "advanced") {
      if (forkResult !== undefined || revocation !== undefined) {
        throw new WitnessServiceError(
          "service_unavailable",
          "Witness history advances after a terminal event",
          503,
        );
      }
      const predecessorCounter = event.predecessorCounter ?? 0n;
      const predecessorCommitment = event.predecessorCommitment ?? zero(48);
      if (
        predecessorCounter !== head.counter ||
        !witnessBytesEqual(predecessorCommitment, head.commitment) ||
        event.counter !== head.counter + 1n
      ) {
        throw new WitnessServiceError(
          "service_unavailable",
          "Witness predecessor chain is corrupt",
          503,
        );
      }
      const successor = {
        predecessorCounter,
        predecessorCommitment: predecessorCommitment.slice(),
        head: {
          counter: event.counter,
          commitment: event.commitment.slice(),
          predecessorCommitment: predecessorCommitment.slice(),
        },
      };
      successors.push(successor);
      head = cloneHead(successor.head);
    } else if (event.kind === "forked") {
      if (forkResult !== undefined)
        throw new WitnessServiceError(
          "service_unavailable",
          "Witness has duplicate fork events",
          503,
        );
      forkResult = event.forkResult ?? "historical_fork";
    } else {
      if (event.revocationGeneration === 0n || revocation !== undefined) {
        throw new WitnessServiceError(
          "service_unavailable",
          "Witness revocation history is corrupt",
          503,
        );
      }
      revocation = { sequence: event.sequence, revocationGeneration: event.revocationGeneration };
    }
  }
  if (record.derivedHead !== undefined && !sameHead(record.derivedHead, head)) {
    // Mutable heads are disposable. The caller rewrites this derived value after validating the journal.
  }
  return {
    head,
    successors,
    ...(revocation === undefined ? {} : { revocation }),
    ...(forkResult === undefined ? {} : { forkResult }),
    lastSequence: expectedSequence - 1n,
    revocationGeneration,
  };
}

function findOperation(
  record: WitnessReplicaRecord,
  operationId: Uint8Array,
): WitnessAcceptedOperation | undefined {
  return record.operations.find((candidate) =>
    witnessBytesEqual(candidate.operationId, operationId),
  );
}

function findSuccessor(
  rebuilt: RebuiltState,
  counter: bigint,
  commitment: Uint8Array,
): WitnessSuccessor | undefined {
  return rebuilt.successors.find(
    (candidate) =>
      candidate.predecessorCounter === counter &&
      witnessBytesEqual(candidate.predecessorCommitment, commitment),
  );
}

function acceptedBeforeRevocation(
  operationValue: WitnessAcceptedOperation,
  rebuilt: RebuiltState,
): boolean {
  return (
    rebuilt.revocation !== undefined &&
    operationValue.acceptedAt.sequence < rebuilt.revocation.sequence &&
    operationValue.acceptedAt.revocationGeneration < rebuilt.revocation.revocationGeneration
  );
}

function decide(
  record: WitnessReplicaRecord | undefined,
  request: WitnessRequest,
  requestHash: Uint8Array,
): ReplicaDecision {
  if (record === undefined) {
    return request.kind === "register"
      ? { result: "registered", mutation: "accept" }
      : { result: "invalid_expected" };
  }
  const rebuilt = rebuild(record);
  const existing = findOperation(record, request.operationId);
  if (existing !== undefined) {
    if (!witnessBytesEqual(existing.requestHash, requestHash))
      return { result: "operation_conflict" };
    if (rebuilt.forkResult !== undefined) return { result: "forked" };
    if (rebuilt.revocation !== undefined && !acceptedBeforeRevocation(existing, rebuilt))
      return { result: "revoked" };
    if (existing.exactReceipt !== undefined)
      return { result: existing.result, exactReceipt: existing.exactReceipt, existing };
    return { result: existing.result, existing };
  }
  if (rebuilt.forkResult !== undefined) return { result: "forked" };
  if (rebuilt.revocation !== undefined) return { result: "revoked" };
  if (request.kind === "register") return { result: "registration_conflict" };
  if (request.kind === "read") return { result: "head" };
  const expectedCounter = request.expectedCounter ?? -1n;
  const expectedCommitment = request.expectedCommitment ?? zero(48);
  const proposed = operation(request);
  if (expectedCounter + 1n !== proposed.counter) return { result: "invalid_expected" };
  if (
    expectedCounter === rebuilt.head.counter &&
    witnessBytesEqual(expectedCommitment, rebuilt.head.commitment)
  ) {
    return { result: "advanced", mutation: "accept" };
  }
  if (expectedCounter < rebuilt.head.counter) {
    const actual = findSuccessor(rebuilt, expectedCounter, expectedCommitment);
    if (actual === undefined) return { result: "stale_expected" };
    if (sameHead(actual.head, proposed)) return { result: "stale_expected" };
    const forkResult =
      expectedCounter + 1n === rebuilt.head.counter ? "conflicting_successor" : "historical_fork";
    return { result: forkResult, mutation: "fork", forkResult };
  }
  return { result: "invalid_expected" };
}

function eventHash(event: WitnessReplicaLedgerEvent): Uint8Array {
  const fields = JSON.stringify({
    sequence: event.sequence.toString(),
    revocationGeneration: event.revocationGeneration.toString(),
    kind: event.kind,
    requestHash: event.requestHash === undefined ? undefined : witnessBytesHex(event.requestHash),
    operationId: event.operationId === undefined ? undefined : witnessBytesHex(event.operationId),
    predecessorCounter: event.predecessorCounter?.toString(),
    predecessorCommitment:
      event.predecessorCommitment === undefined
        ? undefined
        : witnessBytesHex(event.predecessorCommitment),
    counter: event.counter.toString(),
    commitment: witnessBytesHex(event.commitment),
    forkResult: event.forkResult,
  });
  return digest(utf8("Axl rollback witness journal event v1"), utf8(fields));
}

function journalEntry(
  lineage: Uint8Array,
  event: WitnessReplicaLedgerEvent,
): WitnessHighWaterEntry {
  return {
    lineageHash: lineage.slice(),
    sequence: event.sequence,
    counter: event.counter,
    commitment: event.commitment.slice(),
    revocationGeneration: event.revocationGeneration,
    eventHash: eventHash(event),
  };
}

function receiptFields(
  request: WitnessRequest,
  requestHash: Uint8Array,
  result: WitnessResult,
  rebuilt: RebuiltState,
  clock: WitnessClock,
): WitnessReceiptFields {
  const head = requestHead(request, rebuilt);
  return {
    result,
    lineageHash: lineageHash(request),
    counter: head.counter,
    commitment: head.commitment.slice(),
    predecessorCommitment: head.predecessorCommitment.slice(),
    operationId: request.operationId.slice(),
    requestHash: requestHash.slice(),
    ledgerSequence: rebuilt.lastSequence,
    issuedAtMs: clock.nowMs(),
    revocationGeneration: rebuilt.revocationGeneration,
  };
}

function unsignedReceiptBytes(
  fields: WitnessReceiptFields,
  signer: WitnessReceiptSigner,
): Uint8Array {
  const output: number[] = [0, 1];
  const resultTag: Record<WitnessResult, number> = {
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
  };
  output.push(resultTag[fields.result]);
  const add = (bytes: Uint8Array) => output.push(...bytes);
  add(signer.replicaId);
  add(signer.keyId);
  add(fields.lineageHash);
  for (let shift = 56n; shift >= 0n; shift -= 8n)
    output.push(Number((fields.counter >> shift) & 0xffn));
  add(fields.commitment);
  add(fields.predecessorCommitment);
  add(fields.operationId);
  add(fields.requestHash);
  for (const value of [fields.ledgerSequence, fields.issuedAtMs, fields.revocationGeneration]) {
    for (let shift = 56n; shift >= 0n; shift -= 8n) output.push(Number((value >> shift) & 0xffn));
  }
  return Uint8Array.from(output);
}

async function signReceipt(
  fields: WitnessReceiptFields,
  signer: WitnessReceiptSigner,
): Promise<Uint8Array> {
  const signedBytes = unsignedReceiptBytes(fields, signer);
  const signature = await signer.sign(new CanonicalWitnessReceipt(receiptToken, signedBytes));
  if (signature.byteLength !== 64)
    throw new WitnessServiceError(
      "service_unavailable",
      "Witness signer returned an invalid signature",
      503,
    );
  return Uint8Array.from([...signedBytes, ...signature]);
}

function requestCredential(request: WitnessRequest): WitnessCredential {
  if (request.credential === undefined)
    throw new WitnessServiceError("bad_request", "Registration credential is missing", 400);
  const credential = parseWitnessCredential(request.credential);
  if (
    credential.role !== request.lineage.role ||
    !witnessBytesEqual(credential.accountId, request.lineage.accountId) ||
    !witnessBytesEqual(credential.installationId, request.lineage.installationId) ||
    !witnessBytesEqual(credential.deviceId, request.lineage.deviceId)
  ) {
    throw new WitnessServiceError(
      "witness_auth_failed",
      "Registration credential does not match the lineage",
      401,
    );
  }
  if (!witnessBytesEqual(digest(credential.exactBytes), request.credentialFingerprint)) {
    throw new WitnessServiceError(
      "witness_auth_failed",
      "Registration credential fingerprint is invalid",
      401,
    );
  }
  if (!endpointSignatureValid(request, credential.verificationKey)) {
    throw new WitnessServiceError("witness_auth_failed", "Endpoint proof is invalid", 401);
  }
  return credential;
}

function bindingFrom(
  request: WitnessRequest,
  credential: WitnessCredential,
): WitnessCredentialBinding {
  return {
    lineageHash: lineageHash(request),
    credentialFingerprint: request.credentialFingerprint.slice(),
    credentialBytes: credential.exactBytes.slice(),
    verificationKey: credential.verificationKey.slice(),
  };
}

export interface WitnessReplicaOptions {
  readonly storage: WitnessReplicaStorage;
  readonly journal: WitnessHighWaterJournal;
  readonly signer: WitnessReceiptSigner;
  readonly recoveryTrust: readonly WitnessReplicaTrust[];
  readonly admission: WitnessReplicaAdmissionVerifier;
  readonly credentials: WitnessEndpointCredentialDirectory;
  readonly clock: WitnessClock;
  readonly audit: WitnessSecurityAuditSink;
}

export class WitnessReplica implements WitnessReplicaClient {
  readonly replicaId: Uint8Array;
  readonly #options: WitnessReplicaOptions;
  readonly #recoveryTrust: readonly WitnessReplicaTrust[];
  readonly #lineageQueues = new Map<string, Promise<void>>();
  #state: "recovery_required" | "bootstrap" | "ready" = "recovery_required";

  constructor(options: WitnessReplicaOptions) {
    if (options.signer.replicaId.byteLength !== 16 || options.signer.keyId.byteLength !== 16) {
      throw new TypeError("Witness signer identity must use 16-byte identifiers");
    }
    const recoveryTrust = parseWitnessReplicaTrustSet(options.recoveryTrust);
    const ownTrust = recoveryTrust.find((replica) =>
      witnessBytesEqual(replica.replicaId, options.signer.replicaId),
    );
    if (
      ownTrust === undefined ||
      !ownTrust.keys.some((key) => witnessBytesEqual(key.keyId, options.signer.keyId))
    ) {
      throw new TypeError("Witness signer is absent from the recovery trust set");
    }
    this.#options = { ...options, recoveryTrust };
    this.#recoveryTrust = recoveryTrust;
    this.replicaId = options.signer.replicaId.slice();
  }

  async bootstrapEmpty(): Promise<void> {
    this.#state = "recovery_required";
    const lineages = await this.#options.storage.listLineageHashes();
    if (lineages.length !== 0) {
      throw new WitnessServiceError(
        "service_unavailable",
        "A non-empty witness replica must complete recovery",
        503,
      );
    }
    this.#state = "bootstrap";
  }

  async submit(admission: WitnessAdmission, exactRequest: Uint8Array): Promise<Uint8Array> {
    const request = parseWitnessRequest(exactRequest);
    if (this.#state === "recovery_required") {
      throw new WitnessServiceError(
        "witness_unavailable",
        "Witness replica recovery is required",
        503,
      );
    }
    if (this.#state === "bootstrap" && request.kind !== "register") {
      throw new WitnessServiceError(
        "witness_unavailable",
        "An empty witness replica may bootstrap only an initial registration",
        503,
      );
    }
    const key = witnessBytesHex(lineageHash(request));
    const prior = this.#lineageQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.then(() => held);
    this.#lineageQueues.set(key, queued);
    await prior;
    try {
      return await this.#submit(admission, exactRequest);
    } finally {
      release();
      if (this.#lineageQueues.get(key) === queued) this.#lineageQueues.delete(key);
    }
  }

  async #submit(admission: WitnessAdmission, exactRequest: Uint8Array): Promise<Uint8Array> {
    if (exactRequest.byteLength === 0 || exactRequest.byteLength > WITNESS_REQUEST_MAX_BYTES) {
      throw new WitnessServiceError("bad_request", "Witness request exceeds its bound", 400);
    }
    const request = parseWitnessRequest(exactRequest);
    const hash = digest(exactRequest);
    const lineage = lineageHash(request);
    if (this.#state === "bootstrap") {
      const retained = await this.#options.storage.listLineageHashes();
      if (
        retained.length > 0 &&
        !retained.some((candidate) => witnessBytesEqual(candidate, lineage))
      ) {
        throw new WitnessServiceError(
          "witness_unavailable",
          "Bootstrap cannot create another witness lineage",
          503,
        );
      }
    }
    const verifiedAdmission = await this.#options.admission.validate(admission, request);
    if (verifiedAdmission === undefined) {
      await this.#audit("admission_rejected", lineage);
      throw new WitnessServiceError(
        "witness_auth_failed",
        "Hosted witness admission is invalid",
        401,
      );
    }
    let credential: WitnessCredential | undefined;
    let binding: WitnessCredentialBinding | undefined;
    const current = await this.#options.storage.read(lineage);
    if (request.kind === "register") {
      credential = requestCredential(request);
      binding = bindingFrom(request, credential);
      if (
        !(await this.#options.credentials.authorizeRegistration(
          verifiedAdmission,
          request,
          credential,
        ))
      ) {
        await this.#audit("admission_rejected", lineage);
        throw new WitnessServiceError("forbidden", "Witness registration is not authorized", 403);
      }
    } else {
      if (
        current === undefined ||
        !witnessBytesEqual(current.binding.credentialFingerprint, request.credentialFingerprint)
      ) {
        await this.#audit("endpoint_proof_invalid", lineage);
        throw new WitnessServiceError(
          "witness_auth_failed",
          "Endpoint credential is not bound to this lineage",
          401,
        );
      }
      binding = current.binding;
      if (!endpointSignatureValid(request, binding.verificationKey)) {
        await this.#audit("endpoint_proof_invalid", lineage);
        throw new WitnessServiceError("witness_auth_failed", "Endpoint proof is invalid", 401);
      }
      const authorizedBinding = await this.#options.credentials.lookupAuthorizedBinding(
        verifiedAdmission,
        request,
        binding,
      );
      if (
        authorizedBinding === undefined ||
        !witnessBytesEqual(authorizedBinding.lineageHash, binding.lineageHash) ||
        !witnessBytesEqual(
          authorizedBinding.credentialFingerprint,
          binding.credentialFingerprint,
        ) ||
        !witnessBytesEqual(authorizedBinding.credentialBytes, binding.credentialBytes) ||
        !witnessBytesEqual(authorizedBinding.verificationKey, binding.verificationKey)
      ) {
        await this.#audit("admission_rejected", lineage);
        throw new WitnessServiceError("forbidden", "Witness operation is not authorized", 403);
      }
    }

    const initialDecision = decide(current, request, hash);
    if (verifiedAdmission.mode === "receipt_recovery") {
      if (initialDecision.exactReceipt !== undefined) return initialDecision.exactReceipt.slice();
      if (initialDecision.existing === undefined) {
        throw new WitnessServiceError(
          "endpoint_revoked",
          "Recovery does not authorize new witness work",
          403,
        );
      }
    }
    if (initialDecision.exactReceipt !== undefined) return initialDecision.exactReceipt.slice();
    if (initialDecision.existing !== undefined) {
      return this.#finalizeMutation(lineage, request, hash);
    }

    if (initialDecision.mutation === undefined) {
      const rebuilt =
        current === undefined
          ? ({
              head: { counter: 0n, commitment: zero(48), predecessorCommitment: zero(48) },
              successors: [],
              lastSequence: 0n,
              revocationGeneration: 0n,
            } satisfies RebuiltState)
          : rebuild(current);
      const fields = receiptFields(
        request,
        hash,
        initialDecision.result,
        rebuilt,
        this.#options.clock,
      );
      const exactReceipt = await signReceipt(fields, this.#options.signer);
      return this.#retainResponse(lineage, exactRequest, hash, exactReceipt, current);
    }

    const stored = await this.#options.storage.transact<ReplicaDecision>(lineage, (record) => {
      const decision = decide(record, request, hash);
      if (decision.exactReceipt !== undefined) return { value: decision };
      if (decision.mutation === undefined) return { value: decision };
      const base =
        record === undefined
          ? ({
              head: { counter: 0n, commitment: zero(48), predecessorCommitment: zero(48) },
              successors: [],
              lastSequence: 0n,
              revocationGeneration: 0n,
            } satisfies RebuiltState)
          : rebuild(record);
      const sequence = base.lastSequence + 1n;
      const successor = requestHead(request, base);
      const event: WitnessReplicaLedgerEvent =
        decision.mutation === "fork"
          ? {
              sequence,
              revocationGeneration: base.revocationGeneration,
              kind: "forked",
              requestHash: hash.slice(),
              requestBytes: exactRequest.slice(),
              operationId: request.operationId.slice(),
              counter: base.head.counter,
              commitment: base.head.commitment.slice(),
              forkResult: decision.forkResult ?? "historical_fork",
            }
          : {
              sequence,
              revocationGeneration: base.revocationGeneration,
              kind: request.kind === "register" ? "registered" : "advanced",
              requestHash: hash.slice(),
              requestBytes: exactRequest.slice(),
              operationId: request.operationId.slice(),
              predecessorCounter: base.head.counter,
              predecessorCommitment: base.head.commitment.slice(),
              counter: successor.counter,
              commitment: successor.commitment.slice(),
            };
      const nextLedger = [...(record?.ledger ?? []), event];
      const nextBinding = record?.binding ?? binding;
      if (nextBinding === undefined) {
        throw new WitnessServiceError(
          "service_unavailable",
          "Witness credential binding is missing",
          503,
        );
      }
      const nextBase: WitnessReplicaRecord = {
        lineageHash: lineage.slice(),
        binding: nextBinding,
        ledger: nextLedger,
        operations: record?.operations ?? [],
        retainedResponses: record?.retainedResponses ?? [],
        pendingJournalSequence: sequence,
        derivedHead: decision.mutation === "accept" ? cloneHead(successor) : cloneHead(base.head),
      };
      const nextRebuilt = rebuild(nextBase);
      const fields = receiptFields(
        request,
        hash,
        decision.result,
        nextRebuilt,
        this.#options.clock,
      );
      const next =
        decision.mutation === "accept"
          ? {
              ...nextBase,
              operations: [
                ...nextBase.operations,
                {
                  operationId: request.operationId.slice(),
                  requestHash: hash.slice(),
                  requestBytes: exactRequest.slice(),
                  result:
                    request.kind === "register" ? ("registered" as const) : ("advanced" as const),
                  successor: cloneHead(successor),
                  acceptedAt: { sequence, revocationGeneration: base.revocationGeneration },
                  receiptFields: fields,
                  journaled: false,
                },
              ],
            }
          : nextBase;
      const accepted = next.operations.at(-1);
      return {
        value: { ...decision, ...(accepted === undefined ? {} : { existing: accepted }) },
        next,
      };
    });

    if (stored.mutation === undefined) {
      return this.#submit(verifiedAdmission, exactRequest);
    }
    return this.#finalizeMutation(lineage, request, hash);
  }

  async revoke(lineage: Uint8Array, generation: bigint): Promise<void> {
    if (this.#state !== "ready") {
      throw new WitnessServiceError(
        "witness_unavailable",
        "Witness replica recovery is required",
        503,
      );
    }
    const key = witnessBytesHex(lineage);
    const prior = this.#lineageQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.then(() => held);
    this.#lineageQueues.set(key, queued);
    await prior;
    try {
      await this.#revoke(lineage, generation);
    } finally {
      release();
      if (this.#lineageQueues.get(key) === queued) this.#lineageQueues.delete(key);
    }
  }

  async #revoke(lineage: Uint8Array, generation: bigint): Promise<void> {
    if (generation <= 0n) throw new TypeError("Revocation generation must be positive");
    const event = await this.#options.storage.transact(lineage, (record) => {
      if (record === undefined)
        throw new WitnessServiceError("bad_request", "Witness lineage is absent", 404);
      const state = rebuild(record);
      if (generation <= state.revocationGeneration) {
        if (generation === state.revocationGeneration) return { value: record.ledger.at(-1) };
        throw new WitnessServiceError("bad_request", "Revocation generation cannot decrease", 409);
      }
      const nextEvent: WitnessReplicaLedgerEvent = {
        sequence: state.lastSequence + 1n,
        revocationGeneration: generation,
        kind: "revoked",
        counter: state.head.counter,
        commitment: state.head.commitment.slice(),
      };
      return {
        value: nextEvent,
        next: {
          ...record,
          ledger: [...record.ledger, nextEvent],
          pendingJournalSequence: nextEvent.sequence,
        },
      };
    });
    if (event !== undefined) {
      await this.#options.journal.append(journalEntry(lineage, event));
      await this.#markJournaled(lineage, event.sequence);
    }
  }

  async recover(peerEvidence: readonly WitnessPeerHeadEvidence[] = []): Promise<void> {
    this.#state = "recovery_required";
    try {
      const lineages = await this.#options.storage.listLineageHashes();
      if (lineages.length === 0) {
        throw new WitnessServiceError(
          "witness_unavailable",
          "An empty witness replica requires explicit bootstrap",
          503,
        );
      }
      const parsedEvidence = peerEvidence.map((evidence) => ({
        request: parseWitnessRequest(evidence.requestBytes),
        receipt: parseWitnessReplicaReceipt(evidence.receiptBytes),
      }));
      const usedEvidence = new Set<number>();
      const otherReplicaIds = this.#recoveryTrust
        .map((replica) => replica.replicaId)
        .filter((replicaId) => !witnessBytesEqual(replicaId, this.replicaId));
      if (otherReplicaIds.length !== 2) {
        throw new WitnessServiceError(
          "service_unavailable",
          "Recovery trust does not contain two other replicas",
          503,
        );
      }

      for (const lineage of lineages) {
        const stored = await this.#options.storage.read(lineage);
        if (stored === undefined) {
          throw new WitnessServiceError(
            "service_unavailable",
            "Witness lineage disappeared during recovery",
            503,
          );
        }
        const { record, state } = await this.#validateLocalState(lineage, stored);
        const matches = parsedEvidence
          .map((value, index) => ({ ...value, index }))
          .filter((value) => witnessBytesEqual(lineageHash(value.request), lineage));
        if (matches.length !== 2) {
          throw new WitnessServiceError(
            "witness_unavailable",
            "Recovery requires fresh evidence from both other replicas",
            503,
          );
        }
        const first = matches[0];
        const second = matches[1];
        if (first === undefined || second === undefined) {
          throw new WitnessServiceError("witness_unavailable", "Peer evidence is incomplete", 503);
        }
        usedEvidence.add(first.index);
        usedEvidence.add(second.index);
        if (!witnessBytesEqual(first.request.exactBytes, second.request.exactBytes)) {
          throw new WitnessServiceError(
            "witness_receipt_invalid",
            "Peer heads do not answer the same fresh read request",
            400,
          );
        }
        const readRequest = first.request;
        if (
          readRequest.kind !== "read" ||
          !witnessBytesEqual(
            readRequest.credentialFingerprint,
            record.binding.credentialFingerprint,
          ) ||
          !endpointSignatureValid(readRequest, record.binding.verificationKey)
        ) {
          throw new WitnessServiceError(
            "witness_auth_failed",
            "Recovery read request endpoint proof is invalid",
            401,
          );
        }
        const recoveryHash = digest(readRequest.exactBytes);
        if (
          (record.recoveryRequestHashes ?? []).some((value) =>
            witnessBytesEqual(value, recoveryHash),
          )
        ) {
          throw new WitnessServiceError(
            "witness_receipt_invalid",
            "Recovery read evidence has already been used",
            400,
          );
        }
        const expectedPeerIds = new Set(otherReplicaIds.map(witnessBytesHex));
        const actualPeerIds = new Set([
          witnessBytesHex(first.receipt.replicaId),
          witnessBytesHex(second.receipt.replicaId),
        ]);
        if (
          actualPeerIds.size !== 2 ||
          actualPeerIds.has(witnessBytesHex(this.replicaId)) ||
          [...actualPeerIds].some((replicaId) => !expectedPeerIds.has(replicaId))
        ) {
          throw new WitnessServiceError(
            "witness_receipt_invalid",
            "Recovery evidence must come from both other distinct replicas",
            400,
          );
        }
        const expectedResult: WitnessResult =
          state.forkResult !== undefined
            ? "forked"
            : state.revocation !== undefined
              ? "revoked"
              : "head";
        const now = this.#options.clock.nowMs();
        for (const { receipt } of matches) {
          verifyReceiptForRequest(readRequest, receipt, this.#recoveryTrust);
          if (
            receipt.result !== expectedResult ||
            receipt.issuedAtMs > now ||
            now - receipt.issuedAtMs > WITNESS_RECOVERY_EVIDENCE_MAX_AGE_MS
          ) {
            throw new WitnessServiceError(
              "witness_receipt_invalid",
              "Recovery peer evidence is stale or has the wrong terminal state",
              400,
            );
          }
        }
        if (
          first.receipt.counter !== second.receipt.counter ||
          !witnessBytesEqual(first.receipt.commitment, second.receipt.commitment) ||
          !witnessBytesEqual(
            first.receipt.predecessorCommitment,
            second.receipt.predecessorCommitment,
          ) ||
          first.receipt.revocationGeneration !== second.receipt.revocationGeneration
        ) {
          throw new WitnessServiceError("witness_unavailable", "Recovery peer heads conflict", 503);
        }
        if (
          first.receipt.counter !== state.head.counter ||
          !witnessBytesEqual(first.receipt.commitment, state.head.commitment) ||
          !witnessBytesEqual(
            first.receipt.predecessorCommitment,
            state.head.predecessorCommitment,
          ) ||
          first.receipt.revocationGeneration !== state.revocationGeneration
        ) {
          await this.#audit("replica_behind", lineage);
          throw new WitnessServiceError(
            "witness_unavailable",
            "Local and peer witness heads do not match",
            503,
          );
        }
        await this.#options.storage.transact(lineage, (current) => {
          if (current === undefined) {
            throw new WitnessServiceError(
              "service_unavailable",
              "Witness lineage disappeared during recovery",
              503,
            );
          }
          const currentState = rebuild(current);
          if (!sameHead(currentState.head, state.head)) {
            throw new WitnessServiceError(
              "service_unavailable",
              "Witness lineage changed during recovery",
              503,
            );
          }
          return {
            value: undefined,
            next: {
              ...current,
              recoveryRequestHashes: [
                ...(current.recoveryRequestHashes ?? []),
                recoveryHash.slice(),
              ],
              derivedHead: cloneHead(state.head),
            },
          };
        });
      }
      if (usedEvidence.size !== peerEvidence.length) {
        throw new WitnessServiceError(
          "witness_receipt_invalid",
          "Recovery evidence contains an unknown lineage",
          400,
        );
      }
      this.#state = "ready";
    } catch (error) {
      this.#state = "recovery_required";
      throw error;
    }
  }

  async recoveryHead(
    admission: WitnessAdmission,
    exactReadRequest: Uint8Array,
  ): Promise<Uint8Array> {
    const request = parseWitnessRequest(exactReadRequest);
    if (request.kind !== "read") {
      throw new WitnessServiceError(
        "bad_request",
        "Replica recovery accepts only a signed read request",
        400,
      );
    }
    const lineage = lineageHash(request);
    const stored = await this.#options.storage.read(lineage);
    if (stored === undefined) {
      throw new WitnessServiceError("witness_unavailable", "Recovery lineage is missing", 503);
    }
    const { record, state } = await this.#validateLocalState(lineage, stored);
    const verifiedAdmission = await this.#options.admission.validate(admission, request);
    if (verifiedAdmission === undefined) {
      throw new WitnessServiceError("witness_auth_failed", "Hosted admission is invalid", 401);
    }
    const authorizedBinding = await this.#options.credentials.lookupAuthorizedBinding(
      verifiedAdmission,
      request,
      record.binding,
    );
    if (
      authorizedBinding === undefined ||
      !witnessBytesEqual(
        authorizedBinding.credentialFingerprint,
        record.binding.credentialFingerprint,
      ) ||
      !endpointSignatureValid(request, record.binding.verificationKey)
    ) {
      throw new WitnessServiceError(
        "witness_auth_failed",
        "Recovery read endpoint proof is invalid",
        401,
      );
    }
    const result: WitnessResult =
      state.forkResult !== undefined
        ? "forked"
        : state.revocation !== undefined
          ? "revoked"
          : "head";
    const hash = digest(exactReadRequest);
    const receipt = await signReceipt(
      receiptFields(request, hash, result, state, this.#options.clock),
      this.#options.signer,
    );
    return this.#retainResponse(lineage, exactReadRequest, hash, receipt, record);
  }

  async #validateLocalState(
    lineage: Uint8Array,
    stored: WitnessReplicaRecord,
  ): Promise<{ readonly record: WitnessReplicaRecord; readonly state: RebuiltState }> {
    const state = rebuild(stored);
    if (state.lastSequence === 0n) {
      throw new WitnessServiceError("service_unavailable", "Witness ledger is empty", 503);
    }
    const lastEvent = stored.ledger.at(-1);
    if (lastEvent === undefined) {
      throw new WitnessServiceError("service_unavailable", "Witness ledger is missing", 503);
    }
    const expected = journalEntry(lineage, lastEvent);
    const latest = await this.#options.journal.latest(lineage);
    if (latest === undefined || latest.sequence < expected.sequence) {
      if (stored.pendingJournalSequence !== expected.sequence) {
        await this.#audit("journal_inconsistent", lineage);
        throw new WitnessServiceError(
          "service_unavailable",
          "Witness journal is below committed authoritative history",
          503,
        );
      }
      await this.#options.journal.append(expected);
      await this.#markJournaled(lineage, expected.sequence);
    } else if (
      latest.sequence !== expected.sequence ||
      latest.counter !== expected.counter ||
      !witnessBytesEqual(latest.commitment, expected.commitment) ||
      latest.revocationGeneration !== expected.revocationGeneration ||
      !witnessBytesEqual(latest.eventHash, expected.eventHash)
    ) {
      await this.#audit("journal_inconsistent", lineage);
      throw new WitnessServiceError(
        "service_unavailable",
        "Witness journal disagrees with authoritative history",
        503,
      );
    }
    const record = await this.#options.storage.read(lineage);
    if (record === undefined) {
      throw new WitnessServiceError("service_unavailable", "Witness lineage disappeared", 503);
    }
    return { record, state: rebuild(record) };
  }

  async catchUp(chain: readonly WitnessRecoveryEvidence[]): Promise<void> {
    this.#state = "recovery_required";
    for (const evidence of chain) {
      const request = parseWitnessRequest(evidence.requestBytes);
      const result = parseAndVerifyWitnessCertificate(
        evidence.requestBytes,
        evidence.certificateBytes,
        this.#options.recoveryTrust,
      );
      if (result !== "registered" && result !== "advanced") {
        throw new WitnessServiceError(
          "witness_receipt_invalid",
          "Recovery certificate is not an accepted transition",
          400,
        );
      }
      const certificate = parseWitnessQuorumCertificate(evidence.certificateBytes);
      const ownReceipt = certificate.receipts.find((receipt) =>
        witnessBytesEqual(receipt.replicaId, this.replicaId),
      );
      if (ownReceipt === undefined)
        throw new WitnessServiceError(
          "witness_receipt_invalid",
          "Recovery certificate omits this replica",
          400,
        );
      const lineage = lineageHash(request);
      const requestHash = digest(evidence.requestBytes);
      const credential = request.kind === "register" ? requestCredential(request) : undefined;
      const event = await this.#options.storage.transact<WitnessReplicaLedgerEvent>(
        lineage,
        (record) => {
          const state =
            record === undefined
              ? ({
                  head: { counter: 0n, commitment: zero(48), predecessorCommitment: zero(48) },
                  successors: [],
                  lastSequence: 0n,
                  revocationGeneration: 0n,
                } satisfies RebuiltState)
              : rebuild(record);
          if (request.kind === "register" ? record !== undefined : record === undefined) {
            throw new WitnessServiceError(
              "service_unavailable",
              "Recovery chain does not start at the local head",
              503,
            );
          }
          const successor = operation(request);
          if (
            request.kind === "advance" &&
            (request.expectedCounter !== state.head.counter ||
              request.expectedCommitment === undefined ||
              !witnessBytesEqual(request.expectedCommitment, state.head.commitment))
          ) {
            throw new WitnessServiceError(
              "service_unavailable",
              "Recovery chain has a missing predecessor",
              503,
            );
          }
          if (record !== undefined && findOperation(record, request.operationId) !== undefined) {
            throw new WitnessServiceError(
              "service_unavailable",
              "Recovery chain repeats an operation",
              503,
            );
          }
          if (
            request.kind === "advance" &&
            record !== undefined &&
            !endpointSignatureValid(request, record.binding.verificationKey)
          ) {
            throw new WitnessServiceError(
              "witness_auth_failed",
              "Recovery request endpoint proof is invalid",
              401,
            );
          }
          const nextEvent: WitnessReplicaLedgerEvent = {
            sequence: state.lastSequence + 1n,
            revocationGeneration: ownReceipt.revocationGeneration,
            kind: request.kind === "register" ? "registered" : "advanced",
            requestHash: requestHash.slice(),
            requestBytes: evidence.requestBytes.slice(),
            operationId: request.operationId.slice(),
            predecessorCounter: state.head.counter,
            predecessorCommitment: state.head.commitment.slice(),
            counter: successor.counter,
            commitment: successor.commitment.slice(),
          };
          const fields = receiptFields(
            request,
            requestHash,
            result,
            {
              ...state,
              head: cloneHead(successor),
              lastSequence: nextEvent.sequence,
              revocationGeneration: ownReceipt.revocationGeneration,
            },
            this.#options.clock,
          );
          const nextBinding =
            record?.binding ??
            (credential === undefined ? undefined : bindingFrom(request, credential));
          if (nextBinding === undefined) {
            throw new WitnessServiceError(
              "service_unavailable",
              "Recovery credential binding is missing",
              503,
            );
          }
          const next: WitnessReplicaRecord = {
            lineageHash: lineage.slice(),
            binding: nextBinding,
            ledger: [...(record?.ledger ?? []), nextEvent],
            operations: [
              ...(record?.operations ?? []),
              {
                operationId: request.operationId.slice(),
                requestHash: requestHash.slice(),
                requestBytes: evidence.requestBytes.slice(),
                result,
                successor: cloneHead(successor),
                acceptedAt: {
                  sequence: nextEvent.sequence,
                  revocationGeneration: ownReceipt.revocationGeneration,
                },
                receiptFields: fields,
                exactReceipt: ownReceipt.exactBytes.slice(),
                journaled: true,
              },
            ],
            retainedResponses: record?.retainedResponses ?? [],
            pendingJournalSequence: nextEvent.sequence,
            derivedHead: cloneHead(successor),
          };
          return { value: nextEvent, next };
        },
      );
      await this.#options.journal.append(journalEntry(lineage, event));
      await this.#markJournaled(lineage, event.sequence);
    }
  }

  async #markJournaled(lineage: Uint8Array, sequence: bigint): Promise<void> {
    await this.#options.storage.transact(lineage, (record) => {
      if (record === undefined) {
        throw new WitnessServiceError("service_unavailable", "Witness lineage disappeared", 503);
      }
      if (record.pendingJournalSequence === undefined) return { value: undefined };
      if (record.pendingJournalSequence !== sequence) {
        throw new WitnessServiceError(
          "service_unavailable",
          "Witness journal acknowledgement does not match authoritative history",
          503,
        );
      }
      const journaled = { ...record };
      delete journaled.pendingJournalSequence;
      return { value: undefined, next: journaled };
    });
  }

  async #finalizeMutation(
    lineage: Uint8Array,
    request: WitnessRequest,
    hash: Uint8Array,
  ): Promise<Uint8Array> {
    let record = await this.#options.storage.read(lineage);
    if (record === undefined)
      throw new WitnessServiceError(
        "service_unavailable",
        "Witness state was not durably retained",
        503,
      );
    const operationValue = findOperation(record, request.operationId);
    const event = record.ledger.find(
      (candidate) =>
        candidate.requestHash !== undefined && witnessBytesEqual(candidate.requestHash, hash),
    );
    if (event === undefined)
      throw new WitnessServiceError("service_unavailable", "Witness ledger event is missing", 503);
    try {
      await this.#options.journal.append(journalEntry(lineage, event));
      await this.#markJournaled(lineage, event.sequence);
    } catch {
      await this.#audit("journal_inconsistent", lineage);
      throw new WitnessServiceError(
        "witness_unavailable",
        "Witness journal durability is uncertain",
        503,
      );
    }
    if (operationValue === undefined) {
      const rebuilt = rebuild(record);
      const fields = receiptFields(
        request,
        hash,
        event.forkResult ?? "forked",
        rebuilt,
        this.#options.clock,
      );
      const receipt = await signReceipt(fields, this.#options.signer);
      return this.#retainResponse(lineage, request.exactBytes, hash, receipt, record);
    }
    if (operationValue.exactReceipt !== undefined) return operationValue.exactReceipt.slice();
    const receipt = await signReceipt(operationValue.receiptFields, this.#options.signer);
    await this.#options.storage.transact(lineage, (current) => {
      if (current === undefined)
        throw new WitnessServiceError("service_unavailable", "Witness state disappeared", 503);
      const operations = current.operations.map((candidate) =>
        witnessBytesEqual(candidate.operationId, request.operationId)
          ? { ...candidate, exactReceipt: receipt.slice(), journaled: true }
          : candidate,
      );
      return { value: undefined, next: { ...current, operations } };
    });
    record = await this.#options.storage.read(lineage);
    const retained =
      record === undefined ? undefined : findOperation(record, request.operationId)?.exactReceipt;
    if (retained === undefined || !witnessBytesEqual(retained, receipt)) {
      throw new WitnessServiceError(
        "witness_unavailable",
        "Witness receipt retention is uncertain",
        503,
      );
    }
    return retained.slice();
  }

  async #retainResponse(
    lineage: Uint8Array,
    requestBytes: Uint8Array,
    requestHash: Uint8Array,
    receipt: Uint8Array,
    known: WitnessReplicaRecord | undefined,
  ): Promise<Uint8Array> {
    if (known === undefined) return receipt;
    return this.#options.storage.transact(lineage, (record) => {
      if (record === undefined)
        throw new WitnessServiceError("service_unavailable", "Witness lineage disappeared", 503);
      const retained = record.retainedResponses.find((candidate) =>
        witnessBytesEqual(candidate.requestHash, requestHash),
      );
      if (retained !== undefined) return { value: retained.exactReceipt.slice() };
      return {
        value: receipt.slice(),
        next: {
          ...record,
          retainedResponses: [
            ...record.retainedResponses,
            {
              requestHash: requestHash.slice(),
              requestBytes: requestBytes.slice(),
              exactReceipt: receipt.slice(),
            },
          ],
        },
      };
    });
  }

  async #audit(code: WitnessSecurityAuditEvent["code"], lineage?: Uint8Array): Promise<void> {
    await this.#options.audit.emit({
      code,
      ...(lineage === undefined ? {} : { lineageHash: witnessBytesHex(lineage) }),
      replicaId: witnessBytesHex(this.replicaId),
    });
  }
}

export interface WitnessRevocationCoordinatorOptions {
  readonly authorizer: HostedWitnessRevocationAuthorizer;
  readonly replicas: readonly [
    WitnessReplicaRevocationClient,
    WitnessReplicaRevocationClient,
    WitnessReplicaRevocationClient,
  ];
  readonly audit: WitnessSecurityAuditSink;
}

export class WitnessRevocationCoordinator {
  readonly #options: WitnessRevocationCoordinatorOptions;

  constructor(options: WitnessRevocationCoordinatorOptions) {
    const identities = options.replicas.map((replica) => witnessBytesHex(replica.replicaId));
    if (new Set(identities).size !== WITNESS_REPLICA_COUNT) {
      throw new TypeError("Witness revocation requires three distinct replica identities");
    }
    this.#options = options;
  }

  async revoke(
    principal: HostedWitnessPrincipal,
    lineageHash: Uint8Array,
    generation: bigint,
  ): Promise<void> {
    if (lineageHash.byteLength !== 48 || generation <= 0n) {
      throw new WitnessServiceError("bad_request", "Witness revocation is malformed", 400);
    }
    if (!(await this.#options.authorizer.authorize(principal, lineageHash, generation))) {
      await this.#options.audit.emit({
        code: "admission_rejected",
        lineageHash: witnessBytesHex(lineageHash),
      });
      throw new WitnessServiceError("forbidden", "Witness revocation is not authorized", 403);
    }
    try {
      await Promise.all(
        this.#options.replicas.map((replica) => replica.revoke(lineageHash.slice(), generation)),
      );
    } catch {
      await this.#options.audit.emit({
        code: "replica_unavailable",
        lineageHash: witnessBytesHex(lineageHash),
      });
      throw new WitnessServiceError(
        "witness_unavailable",
        "All three witness replicas must retain the revocation",
        503,
      );
    }
  }
}

export interface WitnessPeerHeadEvidence {
  readonly requestBytes: Uint8Array;
  readonly receiptBytes: Uint8Array;
}

export interface WitnessRecoveryEvidence {
  readonly requestBytes: Uint8Array;
  readonly certificateBytes: Uint8Array;
}

export interface WitnessGatewayOptions {
  readonly authorizer: HostedWitnessAuthorizer;
  readonly replicas: readonly [WitnessReplicaClient, WitnessReplicaClient, WitnessReplicaClient];
  readonly trust: readonly WitnessReplicaTrust[];
  readonly deadline: WitnessGatewayDeadline;
  readonly audit: WitnessSecurityAuditSink;
}

export class WitnessGateway {
  readonly #options: WitnessGatewayOptions;
  readonly #trust: readonly WitnessReplicaTrust[];

  constructor(options: WitnessGatewayOptions) {
    this.#trust = parseWitnessReplicaTrustSet(options.trust);
    const expected = this.#trust.map((replica) => witnessBytesHex(replica.replicaId));
    const clients = options.replicas.map((replica) => witnessBytesHex(replica.replicaId));
    if (
      new Set(clients).size !== WITNESS_REPLICA_COUNT ||
      clients.some((id) => !expected.includes(id))
    ) {
      throw new TypeError("Witness gateway requires one client for each pinned replica identity");
    }
    this.#options = options;
  }

  async submit(principal: HostedWitnessPrincipal, exactRequest: Uint8Array): Promise<Uint8Array> {
    const request = parseWitnessRequest(exactRequest);
    const admission = await this.#options.authorizer.authorize(principal, request);
    if (admission === undefined) {
      await this.#options.audit.emit({
        code: "admission_rejected",
        lineageHash: witnessBytesHex(lineageHash(request)),
      });
      throw new WitnessServiceError("forbidden", "Witness request is not authorized", 403);
    }
    let responses: Uint8Array[];
    try {
      responses = await Promise.all(
        this.#options.replicas.map((replica) =>
          this.#options.deadline.waitForReplica(
            replica,
            replica.submit(admission, exactRequest.slice()),
          ),
        ),
      );
    } catch (error) {
      await this.#options.audit.emit({
        code: "replica_unavailable",
        lineageHash: witnessBytesHex(lineageHash(request)),
      });
      if (error instanceof WitnessServiceError) throw error;
      throw new WitnessServiceError(
        "witness_unavailable",
        "All three witness replicas are required",
        503,
      );
    }
    if (responses.length !== WITNESS_REPLICA_COUNT)
      throw new WitnessServiceError(
        "witness_unavailable",
        "All three witness replicas are required",
        503,
      );
    const receipts = responses.map((bytes, index) => {
      try {
        return parseWitnessReplicaReceipt(bytes, `receipts[${index}]`);
      } catch {
        throw new WitnessServiceError(
          "witness_receipt_invalid",
          "A witness replica returned a malformed receipt",
          503,
        );
      }
    });
    try {
      this.#verifyReceipts(request, receipts);
    } catch (error) {
      await this.#options.audit.emit({
        code: "receipt_invalid",
        lineageHash: witnessBytesHex(lineageHash(request)),
      });
      throw error;
    }
    try {
      return encodeWitnessQuorumCertificate(
        [...receipts]
          .sort((left, right) =>
            witnessBytesHex(left.replicaId).localeCompare(witnessBytesHex(right.replicaId)),
          )
          .map((receipt) => receipt.exactBytes),
      );
    } catch {
      throw new WitnessServiceError(
        "witness_receipt_invalid",
        "Witness receipts cannot form a canonical certificate",
        503,
      );
    }
  }

  #verifyReceipts(request: WitnessRequest, receipts: readonly WitnessReplicaReceipt[]): void {
    const requestHash = digest(request.exactBytes);
    const expectedLineageHash = lineageHash(request);
    const first = receipts[0];
    if (
      first === undefined ||
      new Set(receipts.map((receipt) => witnessBytesHex(receipt.replicaId))).size !==
        WITNESS_REPLICA_COUNT
    ) {
      throw new WitnessServiceError(
        "witness_receipt_invalid",
        "Witness replica identities must be distinct",
        503,
      );
    }
    for (const receipt of receipts) {
      const replica = this.#trust.find((candidate) =>
        witnessBytesEqual(candidate.replicaId, receipt.replicaId),
      );
      const key = replica?.keys.find((candidate) =>
        witnessBytesEqual(candidate.keyId, receipt.witnessKeyId),
      );
      if (key === undefined || !receiptSignatureValid(receipt, key.verificationKey)) {
        throw new WitnessServiceError(
          "witness_receipt_invalid",
          "Witness receipt signature is invalid",
          503,
        );
      }
      if (
        receipt.result !== first.result ||
        receipt.counter !== first.counter ||
        !witnessBytesEqual(receipt.commitment, first.commitment) ||
        !witnessBytesEqual(receipt.predecessorCommitment, first.predecessorCommitment) ||
        !witnessBytesEqual(receipt.operationId, request.operationId) ||
        !witnessBytesEqual(receipt.requestHash, requestHash) ||
        !witnessBytesEqual(receipt.lineageHash, expectedLineageHash) ||
        receipt.revocationGeneration !== first.revocationGeneration
      ) {
        throw new WitnessServiceError(
          "witness_receipt_invalid",
          "Witness replicas returned mixed receipt tuples",
          503,
        );
      }
    }
    const expectedHead =
      request.kind === "read"
        ? undefined
        : {
            counter: request.proposedCounter,
            commitment: request.proposedCommitment,
            predecessor: request.expectedCommitment ?? zero(48),
          };
    if (
      expectedHead !== undefined &&
      (first.counter !== expectedHead.counter ||
        expectedHead.commitment === undefined ||
        !witnessBytesEqual(first.commitment, expectedHead.commitment) ||
        !witnessBytesEqual(first.predecessorCommitment, expectedHead.predecessor))
    ) {
      throw new WitnessServiceError(
        "witness_receipt_invalid",
        "Witness receipt does not bind the request tuple",
        503,
      );
    }
  }
}

export function parseAndVerifyWitnessCertificate(
  requestBytes: Uint8Array,
  certificateBytes: Uint8Array,
  trustValue: readonly WitnessReplicaTrust[],
): WitnessResult {
  if (certificateBytes.byteLength > WITNESS_CERTIFICATE_MAX_BYTES) {
    throw new WitnessServiceError(
      "witness_receipt_invalid",
      "Witness certificate exceeds its bound",
      400,
    );
  }
  const request = parseWitnessRequest(requestBytes);
  const certificate = parseWitnessQuorumCertificate(certificateBytes);
  const receipts = certificate.receipts;
  const requestHash = digest(request.exactBytes);
  const expectedLineageHash = lineageHash(request);
  const trust = parseWitnessReplicaTrustSet(trustValue);
  const first = receipts[0];
  const identities = new Set(receipts.map((receipt) => witnessBytesHex(receipt.replicaId)));
  if (identities.size !== WITNESS_REPLICA_COUNT) {
    throw new WitnessServiceError(
      "witness_receipt_invalid",
      "Witness certificate repeats a replica identity",
      400,
    );
  }
  for (const receipt of receipts) {
    const replica = trust.find((candidate) =>
      witnessBytesEqual(candidate.replicaId, receipt.replicaId),
    );
    const key = replica?.keys.find((candidate) =>
      witnessBytesEqual(candidate.keyId, receipt.witnessKeyId),
    );
    if (key === undefined || !receiptSignatureValid(receipt, key.verificationKey))
      throw new WitnessServiceError(
        "witness_receipt_invalid",
        "Witness receipt signature is invalid",
        400,
      );
    if (
      receipt.result !== first.result ||
      receipt.counter !== first.counter ||
      !witnessBytesEqual(receipt.commitment, first.commitment) ||
      !witnessBytesEqual(receipt.predecessorCommitment, first.predecessorCommitment) ||
      !witnessBytesEqual(receipt.operationId, request.operationId) ||
      !witnessBytesEqual(receipt.requestHash, requestHash) ||
      !witnessBytesEqual(receipt.lineageHash, expectedLineageHash) ||
      receipt.revocationGeneration !== first.revocationGeneration
    ) {
      throw new WitnessServiceError(
        "witness_receipt_invalid",
        "Witness certificate contains mixed receipt tuples",
        400,
      );
    }
  }
  if (request.kind !== "read") {
    if (
      request.proposedCounter === undefined ||
      request.proposedCommitment === undefined ||
      first.counter !== request.proposedCounter ||
      !witnessBytesEqual(first.commitment, request.proposedCommitment) ||
      !witnessBytesEqual(first.predecessorCommitment, request.expectedCommitment ?? zero(48))
    ) {
      throw new WitnessServiceError(
        "witness_receipt_invalid",
        "Witness certificate does not bind the request head",
        400,
      );
    }
  }
  return first.result;
}
