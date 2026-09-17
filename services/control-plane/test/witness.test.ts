// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";

import {
  parseWitnessQuorumCertificate,
  parseWitnessReplicaReceipt,
  parseWitnessRequest,
  WITNESS_HTTP_CONTENT_TYPE,
  WITNESS_HTTP_PATH,
  WITNESS_RECEIPT_SIGNATURE_DOMAIN,
  WITNESS_REQUEST_SIGNATURE_DOMAIN,
  type WitnessCredential,
  type WitnessReplicaTrust,
  type WitnessRequest,
  witnessBytesEqual,
} from "@axl/protocol";

import { HostedWitnessClient } from "../../../packages/sdk/src/witness.ts";

import {
  type CanonicalWitnessReceipt,
  createControlPlaneHandler,
  type HostedWitnessAuthorizer,
  InMemoryRelayTicketStore,
  parseAndVerifyWitnessCertificate,
  RelayTicketService,
  type WitnessAdmission,
  type WitnessEndpointCredentialDirectory,
  WitnessGateway,
  type WitnessReceiptSigner,
  WitnessReplica,
  type WitnessReplicaClient,
  WitnessRevocationCoordinator,
  type WitnessSecurityAuditEvent,
  WitnessServiceError,
} from "../src/index.ts";
import {
  InMemoryWitnessHighWaterJournal,
  InMemoryWitnessReplicaStorage,
} from "./support/in-memory-witness.ts";

const profile = new TextEncoder().encode("axl-e2ee-mls-pq-v1");
const fixtureDirectory = new URL("../../../packages/e2ee/fixtures/v1/", import.meta.url);

function required<T>(value: T | undefined): T {
  assert(value !== undefined);
  return value;
}

function proposedCommitment(request: Uint8Array): Uint8Array {
  return required(parseWitnessRequest(request).proposedCommitment);
}

function id(value: number): Uint8Array {
  return new Uint8Array(16).fill(value);
}

function uuid(value: number): Uint8Array {
  const bytes = id(value);
  bytes[6] = 0x70 | (value & 0x0f);
  bytes[8] = 0x80 | (value & 0x3f);
  return bytes;
}

function privateKey(seed: number): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.alloc(32, seed),
    ]),
    format: "der",
    type: "pkcs8",
  });
}

function rawPublicKey(key: KeyObject): Uint8Array {
  return new Uint8Array(createPublicKey(key).export({ format: "der", type: "spki" })).slice(-32);
}

function sha384(...values: readonly Uint8Array[]): Uint8Array {
  const hash = createHash("sha384");
  for (const value of values) hash.update(value);
  return hash.digest();
}

function u16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function u64(value: bigint): number[] {
  const output: number[] = [];
  for (let shift = 56n; shift >= 0n; shift -= 8n) output.push(Number((value >> shift) & 0xffn));
  return output;
}

function optional(value: Uint8Array | undefined): number[] {
  return value === undefined ? [0] : [1, ...value];
}

function optionalCounter(value: bigint | undefined): number[] {
  return value === undefined ? [0] : [1, ...u64(value)];
}

interface EndpointFixture {
  readonly key: KeyObject;
  readonly accountId: Uint8Array;
  readonly installationId: Uint8Array;
  readonly deviceId: Uint8Array;
  readonly cryptoSessionId: Uint8Array;
  readonly credential: Uint8Array;
}

function endpointFixture(seed = 70): EndpointFixture {
  const key = privateKey(seed);
  const accountId = id(1);
  const installationId = uuid(2);
  const deviceId = uuid(3);
  const cryptoSessionId = uuid(4);
  const credential = Uint8Array.from([
    ...u16(1),
    2,
    ...accountId,
    ...installationId,
    ...deviceId,
    profile.byteLength,
    ...profile,
    ...u16(1),
    ...rawPublicKey(key),
  ]);
  return { key, accountId, installationId, deviceId, cryptoSessionId, credential };
}

function requestBytes(
  endpoint: EndpointFixture,
  value: {
    readonly kind: 1 | 2 | 3;
    readonly operationId: Uint8Array;
    readonly nonce?: Uint8Array;
    readonly expectedCounter?: bigint;
    readonly expectedCommitment?: Uint8Array;
    readonly proposedCounter?: bigint;
    readonly proposedCommitment?: Uint8Array;
    readonly previousCertificateHash?: Uint8Array;
    readonly credential?: Uint8Array;
    readonly credentialFingerprint?: Uint8Array;
  },
): Uint8Array {
  const credential = value.credential ?? (value.kind === 1 ? endpoint.credential : undefined);
  const prefix = Uint8Array.from([
    ...u16(1),
    value.kind,
    profile.byteLength,
    ...profile,
    ...u16(1),
    2,
    ...endpoint.accountId,
    ...endpoint.installationId,
    ...endpoint.deviceId,
    ...endpoint.cryptoSessionId,
    ...value.operationId,
    ...(value.nonce ?? new Uint8Array(32).fill(value.operationId[0] ?? 1)),
    ...optionalCounter(value.expectedCounter),
    ...optional(value.expectedCommitment),
    ...optionalCounter(value.proposedCounter),
    ...optional(value.proposedCommitment),
    ...(value.previousCertificateHash ?? new Uint8Array(48)),
    ...(value.credentialFingerprint ?? sha384(endpoint.credential)),
    ...(credential === undefined ? [0] : [1, ...u16(credential.byteLength), ...credential]),
  ]);
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(WITNESS_REQUEST_SIGNATURE_DOMAIN), Buffer.from(prefix)]),
    endpoint.key,
  );
  return Uint8Array.from([...prefix, ...signature]);
}

class TestReceiptSigner implements WitnessReceiptSigner {
  readonly replicaId: Uint8Array;
  readonly keyId: Uint8Array;
  readonly #key: KeyObject;
  calls = 0;

  constructor(index: number) {
    this.replicaId = id(20 + index);
    this.keyId = id(30 + index);
    this.#key = privateKey(80 + index);
  }

  verificationKey(): Uint8Array {
    return rawPublicKey(this.#key);
  }

  signBytes(bytes: Uint8Array): Uint8Array {
    return sign(
      null,
      Buffer.concat([Buffer.from(WITNESS_RECEIPT_SIGNATURE_DOMAIN), Buffer.from(bytes)]),
      this.#key,
    );
  }

  async sign(receipt: CanonicalWitnessReceipt): Promise<Uint8Array> {
    this.calls += 1;
    return this.signBytes(receipt.bytesForSigning());
  }
}

interface Harness {
  readonly gateway: WitnessGateway;
  readonly replicas: readonly [WitnessReplica, WitnessReplica, WitnessReplica];
  readonly stores: readonly [
    InMemoryWitnessReplicaStorage,
    InMemoryWitnessReplicaStorage,
    InMemoryWitnessReplicaStorage,
  ];
  readonly journals: readonly [
    InMemoryWitnessHighWaterJournal,
    InMemoryWitnessHighWaterJournal,
    InMemoryWitnessHighWaterJournal,
  ];
  readonly signers: readonly [TestReceiptSigner, TestReceiptSigner, TestReceiptSigner];
  readonly trust: readonly WitnessReplicaTrust[];
  readonly audits: WitnessSecurityAuditEvent[];
  setActive(value: boolean): void;
}

async function harness(): Promise<Harness> {
  let active = true;
  let now = 1_900_000_000_000n;
  const stores = [0, 1, 2].map(
    () => new InMemoryWitnessReplicaStorage(),
  ) as unknown as Harness["stores"];
  const journals = [0, 1, 2].map(
    () => new InMemoryWitnessHighWaterJournal(),
  ) as unknown as Harness["journals"];
  const signers = [0, 1, 2].map(
    (index) => new TestReceiptSigner(index),
  ) as unknown as Harness["signers"];
  const audits: WitnessSecurityAuditEvent[] = [];
  const directory: WitnessEndpointCredentialDirectory = {
    async authorizeRegistration(admission, request, credential: WitnessCredential) {
      return (
        admission.principal.accountId === Buffer.from(request.lineage.accountId).toString("hex") &&
        witnessBytesEqual(credential.accountId, request.lineage.accountId)
      );
    },
    async lookupAuthorizedBinding(admission, request, binding) {
      return admission.principal.accountId ===
        Buffer.from(request.lineage.accountId).toString("hex")
        ? binding
        : undefined;
    },
  };
  const replicas = signers.map(
    (signer, index) =>
      new WitnessReplica({
        storage: required(stores[index]),
        journal: required(journals[index]),
        signer,
        recoveryTrust: signers.map((candidate) => ({
          replicaId: candidate.replicaId,
          keys: [{ keyId: candidate.keyId, verificationKey: candidate.verificationKey() }],
        })),
        admission: {
          async validate(candidate) {
            return candidate;
          },
        },
        credentials: directory,
        clock: { nowMs: () => now++ },
        audit: {
          async emit(event) {
            audits.push(event);
          },
        },
      }),
  ) as unknown as Harness["replicas"];
  const trust = signers.map((signer) => ({
    replicaId: signer.replicaId,
    keys: [{ keyId: signer.keyId, verificationKey: signer.verificationKey() }],
  }));
  const authorizer: HostedWitnessAuthorizer = {
    async authorize(principal): Promise<WitnessAdmission> {
      return { principal, mode: active ? "active" : "receipt_recovery" };
    },
  };
  await Promise.all(replicas.map((replica) => replica.bootstrapEmpty()));
  const gateway = new WitnessGateway({
    authorizer,
    replicas,
    trust,
    deadline: {
      async waitForReplica(_client, operation) {
        return operation;
      },
    },
    audit: {
      async emit(event) {
        audits.push(event);
      },
    },
  });
  return {
    gateway,
    replicas,
    stores,
    journals,
    signers,
    trust,
    audits,
    setActive(value) {
      active = value;
    },
  };
}

function principal(endpoint: EndpointFixture) {
  return { accountId: Buffer.from(endpoint.accountId).toString("hex") };
}

function register(
  endpoint: EndpointFixture,
  operationId = id(40),
  commitment = new Uint8Array(48).fill(17),
) {
  return requestBytes(endpoint, {
    kind: 1,
    operationId,
    proposedCounter: 1n,
    proposedCommitment: commitment,
  });
}

let recoveryRequestOrdinal = 100;

function reconstructedReplica(
  service: Harness,
  index: 0 | 1 | 2,
  nowMs = 1_900_000_000_100n,
): WitnessReplica {
  return new WitnessReplica({
    storage: service.stores[index],
    journal: service.journals[index],
    signer: service.signers[index],
    recoveryTrust: service.trust,
    admission: {
      async validate(candidate) {
        return candidate;
      },
    },
    credentials: {
      async authorizeRegistration() {
        return true;
      },
      async lookupAuthorizedBinding(_admission, _request, binding) {
        return binding;
      },
    },
    clock: { nowMs: () => nowMs },
    audit: {
      async emit(event) {
        service.audits.push(event);
      },
    },
  });
}

async function peerHeadEvidence(
  service: Harness,
  endpoint: EndpointFixture,
  recoveringIndex: 0 | 1 | 2,
  ordinal: number,
) {
  const request = requestBytes(endpoint, {
    kind: 2,
    operationId: id(ordinal),
    nonce: new Uint8Array(32).fill(ordinal),
  });
  const admission = { principal: principal(endpoint), mode: "active" } as const;
  const evidence = await Promise.all(
    service.replicas
      .map((replica, index) => ({ replica, index }))
      .filter(({ index }) => index !== recoveringIndex)
      .map(async ({ replica }) => ({
        requestBytes: request,
        receiptBytes: await replica.recoveryHead(admission, request),
      })),
  );
  return { request, evidence };
}

async function recoverReplicas(service: Harness, endpoint: EndpointFixture): Promise<void> {
  recoveryRequestOrdinal += 1;
  const ordinal = recoveryRequestOrdinal % 250;
  const request = requestBytes(endpoint, {
    kind: 2,
    operationId: id(ordinal),
    nonce: new Uint8Array(32).fill(ordinal),
  });
  const admission = { principal: principal(endpoint), mode: "active" } as const;
  const receipts = await Promise.all(
    service.replicas.map((replica) => replica.recoveryHead(admission, request)),
  );
  await Promise.all(
    service.replicas.map((replica, ownIndex) =>
      replica.recover(
        receipts
          .map((receiptBytes, index) => ({ receiptBytes, index }))
          .filter(({ index }) => index !== ownIndex)
          .map(({ receiptBytes }) => ({ requestBytes: request, receiptBytes })),
      ),
    ),
  );
}

function advance(
  endpoint: EndpointFixture,
  operationId: Uint8Array,
  expectedCounter: bigint,
  expectedCommitment: Uint8Array,
  proposedCommitment: Uint8Array,
) {
  return requestBytes(endpoint, {
    kind: 3,
    operationId,
    expectedCounter,
    expectedCommitment,
    proposedCounter: expectedCounter + 1n,
    proposedCommitment,
    previousCertificateHash: new Uint8Array(48).fill(Number(expectedCounter)),
  });
}

test("independently verifies Rust fixture endpoint and replica signatures", () => {
  const registerFixture = readFileSync(new URL("witness-register-v1.bin", fixtureDirectory));
  const advanceFixture = readFileSync(new URL("witness-advance-v1.bin", fixtureDirectory));
  const certificateFixture = readFileSync(new URL("witness-quorum-v1.bin", fixtureDirectory));
  const metadata = Object.fromEntries(
    readFileSync(new URL("witness-expected.txt", fixtureDirectory), "utf8")
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=")),
  );
  const registration = parseWitnessRequest(registerFixture);
  const parsedAdvance = parseWitnessRequest(advanceFixture);
  assert(registration.credential);
  const credentialKey = registration.credential.slice(-32);
  const endpointKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), credentialKey]),
    format: "der",
    type: "spki",
  });
  assert(
    createHash("sha384")
      .update(registration.credential)
      .digest()
      .equals(registration.credentialFingerprint),
  );
  assert(verifyRequest(registration, endpointKey));
  assert(verifyRequest(parsedAdvance, endpointKey));
  const trust = [1, 2, 3].map((ordinal) => ({
    replicaId: Buffer.from(required(metadata[`replica_${ordinal}_id`]), "hex"),
    keys: [
      {
        keyId: Buffer.from(required(metadata[`replica_${ordinal}_key_id`]), "hex"),
        verificationKey: Buffer.from(required(metadata[`replica_${ordinal}_public_key`]), "hex"),
      },
    ],
  }));
  assert.equal(
    parseAndVerifyWitnessCertificate(advanceFixture, certificateFixture, trust),
    "advanced",
  );
});

function verifyRequest(request: WitnessRequest, key: KeyObject): boolean {
  return verify(
    null,
    Buffer.concat([
      Buffer.from(WITNESS_REQUEST_SIGNATURE_DOMAIN),
      Buffer.from(request.signedBytes),
    ]),
    key,
    request.signature,
  );
}

test("registers, recovers byte-identical duplicates, advances, and serves nonce-bound reads", async () => {
  const endpoint = endpointFixture();
  const service = await harness();
  const registration = register(endpoint);
  const first = await service.gateway.submit(principal(endpoint), registration);
  const duplicate = await service.gateway.submit(principal(endpoint), registration);
  assert.deepEqual(duplicate, first);
  assert.equal(parseWitnessQuorumCertificate(first).receipts[0].result, "registered");
  await recoverReplicas(service, endpoint);

  const commitment1 = proposedCommitment(registration);
  const next = advance(endpoint, id(41), 1n, commitment1, new Uint8Array(48).fill(18));
  const advanced = await service.gateway.submit(principal(endpoint), next);
  assert.equal(parseWitnessQuorumCertificate(advanced).receipts[0].result, "advanced");
  assert.deepEqual(await service.gateway.submit(principal(endpoint), next), advanced);

  const read1 = requestBytes(endpoint, {
    kind: 2,
    operationId: id(42),
    nonce: new Uint8Array(32).fill(42),
  });
  const read2 = requestBytes(endpoint, {
    kind: 2,
    operationId: id(43),
    nonce: new Uint8Array(32).fill(43),
  });
  const receipt1 = parseWitnessQuorumCertificate(
    await service.gateway.submit(principal(endpoint), read1),
  ).receipts[0];
  const receipt2 = parseWitnessQuorumCertificate(
    await service.gateway.submit(principal(endpoint), read2),
  ).receipts[0];
  assert.equal(receipt1.result, "head");
  assert.equal(receipt1.counter, 2n);
  assert(!witnessBytesEqual(receipt1.requestHash, receipt2.requestHash));
});

test("makes concurrent advance choose one winner and makes immediate forks sticky", async () => {
  const endpoint = endpointFixture();
  const service = await harness();
  const registration = register(endpoint);
  await service.gateway.submit(principal(endpoint), registration);
  await recoverReplicas(service, endpoint);
  const head = proposedCommitment(registration);
  const left = advance(endpoint, id(50), 1n, head, new Uint8Array(48).fill(50));
  const right = advance(endpoint, id(51), 1n, head, new Uint8Array(48).fill(51));
  const results = await Promise.all([
    service.gateway.submit(principal(endpoint), left),
    service.gateway.submit(principal(endpoint), right),
  ]);
  const values = results.map((value) => parseWitnessQuorumCertificate(value).receipts[0].result);
  assert.deepEqual(new Set(values), new Set(["advanced", "conflicting_successor"]));
  const later = requestBytes(endpoint, { kind: 2, operationId: id(52) });
  assert.equal(
    parseWitnessQuorumCertificate(await service.gateway.submit(principal(endpoint), later))
      .receipts[0].result,
    "forked",
  );
});

test("classifies stale, historical fork, operation conflict, and registration conflict", async () => {
  const endpoint = endpointFixture();
  const service = await harness();
  const registration = register(endpoint);
  await service.gateway.submit(principal(endpoint), registration);
  await recoverReplicas(service, endpoint);
  const c1 = proposedCommitment(registration);
  const a2 = advance(endpoint, id(60), 1n, c1, new Uint8Array(48).fill(20));
  await service.gateway.submit(principal(endpoint), a2);
  const c2 = proposedCommitment(a2);
  const stale = advance(endpoint, id(61), 1n, c1, c2);
  assert.equal(
    parseWitnessQuorumCertificate(await service.gateway.submit(principal(endpoint), stale))
      .receipts[0].result,
    "stale_expected",
  );
  const conflictingOperation = advance(endpoint, id(60), 2n, c2, new Uint8Array(48).fill(21));
  assert.equal(
    parseWitnessQuorumCertificate(
      await service.gateway.submit(principal(endpoint), conflictingOperation),
    ).receipts[0].result,
    "operation_conflict",
  );

  const registrationConflict = register(endpoint, id(62), new Uint8Array(48).fill(22));
  assert.equal(
    parseWitnessQuorumCertificate(
      await service.gateway.submit(principal(endpoint), registrationConflict),
    ).receipts[0].result,
    "registration_conflict",
  );

  const a3 = advance(endpoint, id(63), 2n, c2, new Uint8Array(48).fill(23));
  await service.gateway.submit(principal(endpoint), a3);
  const historical = advance(endpoint, id(64), 1n, c1, new Uint8Array(48).fill(24));
  assert.equal(
    parseWitnessQuorumCertificate(await service.gateway.submit(principal(endpoint), historical))
      .receipts[0].result,
    "historical_fork",
  );
});

test("orders revocation against advances and permits only exact accepted-operation recovery", async () => {
  const endpoint = endpointFixture();
  const service = await harness();
  const registration = register(endpoint);
  await service.gateway.submit(principal(endpoint), registration);
  await recoverReplicas(service, endpoint);
  const c1 = proposedCommitment(registration);
  const request = advance(endpoint, id(70), 1n, c1, new Uint8Array(48).fill(25));
  const accepted = await service.gateway.submit(principal(endpoint), request);
  const lineage = parseWitnessQuorumCertificate(accepted).receipts[0].lineageHash;
  const revocations = new WitnessRevocationCoordinator({
    authorizer: {
      async authorize() {
        return true;
      },
    },
    replicas: service.replicas,
    audit: {
      async emit(event) {
        service.audits.push(event);
      },
    },
  });
  await revocations.revoke(principal(endpoint), lineage, 1n);
  service.setActive(false);
  assert.deepEqual(await service.gateway.submit(principal(endpoint), request), accepted);
  const next = advance(
    endpoint,
    id(71),
    2n,
    new Uint8Array(48).fill(25),
    new Uint8Array(48).fill(26),
  );
  await assert.rejects(
    service.gateway.submit(principal(endpoint), next),
    (error) => error instanceof WitnessServiceError && error.code === "endpoint_revoked",
  );
});

test("orders concurrent revocation and advance by append-ledger position", async () => {
  const endpoint = endpointFixture();
  const advanceFirst = await harness();
  const registration = register(endpoint);
  const registered = await advanceFirst.gateway.submit(principal(endpoint), registration);
  await recoverReplicas(advanceFirst, endpoint);
  const lineage = parseWitnessQuorumCertificate(registered).receipts[0].lineageHash;
  const c1 = proposedCommitment(registration);
  const request = advance(endpoint, id(75), 1n, c1, new Uint8Array(48).fill(27));
  const acceptedPromise = advanceFirst.gateway.submit(principal(endpoint), request);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const revocationPromise = Promise.all(
    advanceFirst.replicas.map((replica) => replica.revoke(lineage, 1n)),
  );
  const accepted = await acceptedPromise;
  await revocationPromise;
  assert.equal(parseWitnessQuorumCertificate(accepted).receipts[0].result, "advanced");

  const revokeFirst = await harness();
  const secondRegistration = register(endpoint);
  const secondRegistered = await revokeFirst.gateway.submit(
    principal(endpoint),
    secondRegistration,
  );
  await recoverReplicas(revokeFirst, endpoint);
  const secondLineage = parseWitnessQuorumCertificate(secondRegistered).receipts[0].lineageHash;
  const revokeFirstPromise = Promise.all(
    revokeFirst.replicas.map((replica) => replica.revoke(secondLineage, 1n)),
  );
  const rejectedPromise = revokeFirst.gateway.submit(principal(endpoint), request);
  await revokeFirstPromise;
  const rejected = await rejectedPromise;
  assert.equal(parseWitnessQuorumCertificate(rejected).receipts[0].result, "revoked");
});

test("returns no signature when primary or journal durability fails or is uncertain", async () => {
  const endpoint = endpointFixture();
  for (const boundary of ["primary", "journal"] as const) {
    for (const fault of ["fail", "uncertain_before", "uncertain_after"] as const) {
      const service = await harness();
      if (boundary === "primary") service.stores[0].failNext(fault);
      else service.journals[0].failNext(fault);
      await assert.rejects(service.gateway.submit(principal(endpoint), register(endpoint)));
      assert.equal(service.signers[0].calls, 0);
    }
  }
});

test("explicit empty-store bootstrap permits only initial registration", async () => {
  const endpoint = endpointFixture();
  const service = await harness();
  const replica = reconstructedReplica(service, 0);
  const admission = { principal: principal(endpoint), mode: "active" } as const;
  await assert.rejects(
    replica.submit(admission, register(endpoint)),
    (error) => error instanceof WitnessServiceError && error.code === "witness_unavailable",
  );
  await assert.rejects(replica.recover([]));
  await replica.bootstrapEmpty();
  await replica.submit(admission, register(endpoint));
  await assert.rejects(
    replica.submit(admission, requestBytes(endpoint, { kind: 2, operationId: id(79) })),
    (error) => error instanceof WitnessServiceError && error.code === "witness_unavailable",
  );
  const anotherLineage = { ...endpoint, cryptoSessionId: uuid(9) };
  await assert.rejects(
    replica.submit(
      { principal: principal(anotherLineage), mode: "active" },
      register(anotherLineage, id(78)),
    ),
    (error) => error instanceof WitnessServiceError && error.code === "witness_unavailable",
  );
});

test("reconstructed replicas require two fresh distinct peer heads before voting", async () => {
  const endpoint = endpointFixture();
  const service = await harness();
  const registration = register(endpoint);
  await service.gateway.submit(principal(endpoint), registration);
  const restarted = reconstructedReplica(service, 0);
  const read = requestBytes(endpoint, { kind: 2, operationId: id(80) });
  await assert.rejects(
    restarted.submit({ principal: principal(endpoint), mode: "active" }, read),
    (error) => error instanceof WitnessServiceError && error.code === "witness_unavailable",
  );
  await assert.rejects(restarted.revoke(sha384(profile), 1n));
  await assert.rejects(restarted.recover([]));

  const fresh = await peerHeadEvidence(service, endpoint, 0, 81);
  const firstPeerEvidence = required(fresh.evidence[0]);
  await assert.rejects(restarted.recover(fresh.evidence.slice(0, 1)));
  await assert.rejects(
    restarted.recover([firstPeerEvidence, firstPeerEvidence]),
    (error) => error instanceof WitnessServiceError && error.code === "witness_receipt_invalid",
  );
  const ownReceipt = await service.replicas[0].recoveryHead(
    { principal: principal(endpoint), mode: "active" },
    fresh.request,
  );
  await assert.rejects(
    restarted.recover([
      { requestBytes: fresh.request, receiptBytes: ownReceipt },
      firstPeerEvidence,
    ]),
    (error) => error instanceof WitnessServiceError && error.code === "witness_receipt_invalid",
  );

  const mismatchedRead = await peerHeadEvidence(service, endpoint, 0, 89);
  await assert.rejects(
    restarted.recover([
      { requestBytes: mismatchedRead.request, receiptBytes: firstPeerEvidence.receiptBytes },
      required(mismatchedRead.evidence[1]),
    ]),
    (error) => error instanceof WitnessServiceError && error.code === "witness_receipt_invalid",
  );

  const staleRestart = reconstructedReplica(service, 0, 1_900_000_100_001n);
  await assert.rejects(
    staleRestart.recover(fresh.evidence),
    (error) => error instanceof WitnessServiceError && error.code === "witness_receipt_invalid",
  );

  await restarted.recover(fresh.evidence);
  assert.equal(
    parseWitnessReplicaReceipt(
      await restarted.submit({ principal: principal(endpoint), mode: "active" }, read),
    ).result,
    "head",
  );
  await assert.rejects(
    restarted.recover(fresh.evidence),
    (error) => error instanceof WitnessServiceError && error.code === "witness_receipt_invalid",
  );
  await assert.rejects(restarted.submit({ principal: principal(endpoint), mode: "active" }, read));
});

test("conflicting peer heads and local journal disagreement keep recovery unavailable", async () => {
  const endpoint = endpointFixture();
  const service = await harness();
  const registration = register(endpoint);
  const certificate = await service.gateway.submit(principal(endpoint), registration);
  const receipt = parseWitnessQuorumCertificate(certificate).receipts[0];
  const fresh = await peerHeadEvidence(service, endpoint, 0, 82);
  const firstPeerEvidence = required(fresh.evidence[0]);
  const secondPeerEvidence = required(fresh.evidence[1]);
  const conflictingReceipt = secondPeerEvidence.receiptBytes.slice();
  conflictingReceipt[91] = (conflictingReceipt[91] ?? 0) ^ 1;
  conflictingReceipt.set(
    service.signers[2].signBytes(conflictingReceipt.subarray(0, -64)),
    conflictingReceipt.length - 64,
  );
  const restarted = reconstructedReplica(service, 0);
  await assert.rejects(
    restarted.recover([
      firstPeerEvidence,
      { ...secondPeerEvidence, receiptBytes: conflictingReceipt },
    ]),
    (error) => error instanceof WitnessServiceError && error.code === "witness_unavailable",
  );
  await assert.rejects(
    restarted.submit(
      { principal: principal(endpoint), mode: "active" },
      requestBytes(endpoint, { kind: 2, operationId: id(83) }),
    ),
  );

  service.stores[0].corruptDerivedHead(receipt.lineageHash, receipt);
  service.journals[0].corruptLatest(receipt.lineageHash);
  const corruptRestart = reconstructedReplica(service, 0);
  const nextFresh = await peerHeadEvidence(service, endpoint, 0, 84);
  await assert.rejects(
    corruptRestart.recover(nextFresh.evidence),
    (error) => error instanceof WitnessServiceError && error.code === "service_unavailable",
  );
  await assert.rejects(
    corruptRestart.submit(
      { principal: principal(endpoint), mode: "active" },
      requestBytes(endpoint, { kind: 2, operationId: id(85) }),
    ),
  );
});

test("catches up only from a valid unanimous certificate and complete predecessor chain", async () => {
  const endpoint = endpointFixture();
  const service = await harness();
  const registration = register(endpoint);
  const registrationCertificate = await service.gateway.submit(principal(endpoint), registration);
  await recoverReplicas(service, endpoint);
  const c1 = proposedCommitment(registration);
  const request = advance(endpoint, id(85), 1n, c1, new Uint8Array(48).fill(28));
  const advanceCertificate = await service.gateway.submit(principal(endpoint), request);

  const store = new InMemoryWitnessReplicaStorage();
  const journal = new InMemoryWitnessHighWaterJournal();
  const replica = new WitnessReplica({
    storage: store,
    journal,
    signer: service.signers[0],
    recoveryTrust: service.trust,
    admission: {
      async validate(candidate) {
        return candidate;
      },
    },
    credentials: {
      async authorizeRegistration() {
        return true;
      },
      async lookupAuthorizedBinding(_admission, _request, binding) {
        return binding;
      },
    },
    clock: { nowMs: () => 1_900_000_000_100n },
    audit: {
      async emit(event) {
        service.audits.push(event);
      },
    },
  });
  await assert.rejects(
    replica.catchUp([{ requestBytes: request, certificateBytes: advanceCertificate }]),
    (error) => error instanceof WitnessServiceError && error.code === "service_unavailable",
  );
  await replica.catchUp([
    { requestBytes: registration, certificateBytes: registrationCertificate },
  ]);
  const aheadEvidence = await peerHeadEvidence(service, endpoint, 0, 86);
  await assert.rejects(
    replica.recover(aheadEvidence.evidence),
    (error) => error instanceof WitnessServiceError && error.code === "witness_unavailable",
  );
  const invalidCertificate = advanceCertificate.slice();
  invalidCertificate[invalidCertificate.length - 1] =
    (invalidCertificate[invalidCertificate.length - 1] ?? 0) ^ 1;
  await assert.rejects(
    replica.catchUp([{ requestBytes: request, certificateBytes: invalidCertificate }]),
    (error) => error instanceof WitnessServiceError && error.code === "witness_receipt_invalid",
  );
  await replica.catchUp([{ requestBytes: request, certificateBytes: advanceCertificate }]);
  await assert.rejects(
    replica.submit(
      { principal: principal(endpoint), mode: "active" },
      requestBytes(endpoint, { kind: 2, operationId: id(87) }),
    ),
  );
  const recoveredEvidence = await peerHeadEvidence(service, endpoint, 0, 87);
  await replica.recover(recoveredEvidence.evidence);
  const read = requestBytes(endpoint, {
    kind: 2,
    operationId: id(88),
    nonce: new Uint8Array(32).fill(88),
  });
  const receipt = parseWitnessReplicaReceipt(
    await replica.submit({ principal: principal(endpoint), mode: "active" }, read),
  );
  assert.equal(receipt.counter, 2n);
  assert.deepEqual(receipt.commitment, new Uint8Array(48).fill(28));
});

test("gateway rejects unavailable, duplicate, unpinned, invalid, and mixed replica receipts", async () => {
  const endpoint = endpointFixture();
  const service = await harness();
  const request = register(endpoint);
  const principalValue = principal(endpoint);
  const good = await Promise.all(
    service.replicas.map((replica) =>
      replica.submit({ principal: principalValue, mode: "active" }, request),
    ),
  );
  const oneFailure = {
    ...service.replicas[2],
    replicaId: service.replicas[2].replicaId,
    async submit() {
      throw new Error("timeout");
    },
  } as WitnessReplicaClient;
  const partial = new WitnessGateway({
    authorizer: {
      async authorize(p) {
        return { principal: p, mode: "active" };
      },
    },
    replicas: [service.replicas[0], service.replicas[1], oneFailure],
    trust: service.trust,
    deadline: {
      async waitForReplica(_client, operation) {
        return operation;
      },
    },
    audit: { async emit() {} },
  });
  await assert.rejects(
    partial.submit(principalValue, request),
    (error) => error instanceof WitnessServiceError && error.code === "witness_unavailable",
  );

  assert.throws(
    () =>
      new WitnessGateway({
        authorizer: {
          async authorize(p) {
            return { principal: p, mode: "active" };
          },
        },
        replicas: [service.replicas[0], service.replicas[0], service.replicas[2]],
        trust: service.trust,
        deadline: {
          async waitForReplica(_client, operation) {
            return operation;
          },
        },
        audit: { async emit() {} },
      }),
  );

  const tampered = required(good[2]).slice();
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
  const badClient = {
    replicaId: service.replicas[2].replicaId,
    async submit() {
      return tampered;
    },
  };
  const invalid = new WitnessGateway({
    authorizer: {
      async authorize(p) {
        return { principal: p, mode: "active" };
      },
    },
    replicas: [
      {
        replicaId: service.replicas[0].replicaId,
        async submit() {
          return required(good[0]);
        },
      },
      {
        replicaId: service.replicas[1].replicaId,
        async submit() {
          return required(good[1]);
        },
      },
      badClient,
    ],
    trust: service.trust,
    deadline: {
      async waitForReplica(_client, operation) {
        return operation;
      },
    },
    audit: { async emit() {} },
  });
  await assert.rejects(
    invalid.submit(principalValue, request),
    (error) => error instanceof WitnessServiceError && error.code === "witness_receipt_invalid",
  );

  // Result, lineage, counter, commitment, predecessor, operation, request hash, and revocation.
  for (const offset of [2, 35, 83, 91, 139, 187, 203, 267]) {
    const mixedReceipt = required(good[1]).slice();
    mixedReceipt[offset] = offset === 2 ? 6 : (mixedReceipt[offset] ?? 0) ^ 1;
    mixedReceipt.set(
      service.signers[1].signBytes(mixedReceipt.subarray(0, -64)),
      mixedReceipt.length - 64,
    );
    const mixed = new WitnessGateway({
      authorizer: {
        async authorize(p) {
          return { principal: p, mode: "active" };
        },
      },
      replicas: [
        {
          replicaId: service.replicas[0].replicaId,
          async submit() {
            return required(good[0]);
          },
        },
        {
          replicaId: service.replicas[1].replicaId,
          async submit() {
            return mixedReceipt;
          },
        },
        {
          replicaId: service.replicas[2].replicaId,
          async submit() {
            return required(good[2]);
          },
        },
      ],
      trust: service.trust,
      deadline: {
        async waitForReplica(_client, operation) {
          return operation;
        },
      },
      audit: { async emit() {} },
    });
    await assert.rejects(
      mixed.submit(principalValue, request),
      (error) => error instanceof WitnessServiceError && error.code === "witness_receipt_invalid",
    );
  }
  const auditText = JSON.stringify(service.audits);
  assert(!auditText.includes(Buffer.from(request).toString("base64")));
  assert(!auditText.includes(Buffer.from(endpoint.credential).toString("hex")));
});

test("serves the bounded authenticated binary witness route", async (context) => {
  const endpoint = endpointFixture();
  const service = await harness();
  const tickets = new RelayTicketService({
    store: new InMemoryRelayTicketStore(),
    authorizer: {
      async currentGeneration() {
        return undefined;
      },
    },
    proofVerifier: {
      async verify() {
        return false;
      },
    },
    relayUrl: "wss://relay.invalid/v1/connect",
  });
  const server = createServer(
    createControlPlaneHandler({
      tickets,
      witness: service.gateway,
      publicAuthentication: {
        async authenticate(request) {
          return request.headers.authorization === "Bearer witness-test"
            ? principal(endpoint)
            : undefined;
        },
      },
      internalAuthentication: {
        async authenticate() {
          return false;
        },
      },
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}${WITNESS_HTTP_PATH}`, {
    method: "POST",
    headers: {
      authorization: "Bearer witness-test",
      "content-type": WITNESS_HTTP_CONTENT_TYPE,
    },
    body: Buffer.from(register(endpoint)),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), WITNESS_HTTP_CONTENT_TYPE);
  assert.equal(
    parseWitnessQuorumCertificate(new Uint8Array(await response.arrayBuffer())).receipts[0].result,
    "registered",
  );
  const unauthorized = await fetch(`http://127.0.0.1:${address.port}${WITNESS_HTTP_PATH}`, {
    method: "POST",
    headers: { "content-type": WITNESS_HTTP_CONTENT_TYPE },
    body: Buffer.from(register(endpoint)),
  });
  assert.equal(unauthorized.status, 401);
});

test("local three-replica gateway completes the SDK witness continuation", async (context) => {
  const endpoint = endpointFixture();
  const service = await harness();
  const request = register(endpoint);
  const tickets = new RelayTicketService({
    store: new InMemoryRelayTicketStore(),
    authorizer: {
      async currentGeneration() {
        return undefined;
      },
    },
    proofVerifier: {
      async verify() {
        return false;
      },
    },
    relayUrl: "wss://relay.invalid/v1/connect",
  });
  const server = createServer(
    createControlPlaneHandler({
      tickets,
      witness: service.gateway,
      publicAuthentication: {
        async authenticate(candidate) {
          return candidate.headers.authorization === "Bearer local-witness"
            ? principal(endpoint)
            : undefined;
        },
      },
      internalAuthentication: {
        async authenticate() {
          return false;
        },
      },
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const operationId = parseWitnessRequest(request).operationId;
  const exactResult = new TextEncoder().encode("locally witnessed result");
  let continuationCalls = 0;
  const client = new HostedWitnessClient({
    controlPlaneOrigin: `http://127.0.0.1:${address.port}`,
    allowInsecureLoopbackForTests: true,
    authenticationHeaders: async () => ({ authorization: "Bearer local-witness" }),
  });
  const result = await client.complete({
    operationId,
    witnessRequest: request,
    requestHash: createHash("sha384").update(request).digest(),
    status: "pending_quorum",
    async continueWitness(receivedOperationId, certificate) {
      continuationCalls += 1;
      assert.deepEqual(receivedOperationId, operationId);
      assert.equal(
        parseAndVerifyWitnessCertificate(request, certificate, service.trust),
        "registered",
      );
      return exactResult.slice();
    },
  });
  assert.deepEqual(result, exactResult);
  assert.equal(continuationCalls, 1);
  assert.deepEqual(
    service.signers.map((signer) => signer.calls),
    [1, 1, 1],
  );
});

test("rejects credential replacement, wrong fingerprint, and endpoint signature changes", async () => {
  const endpoint = endpointFixture();
  const service = await harness();
  const registration = register(endpoint);
  await service.gateway.submit(principal(endpoint), registration);
  await recoverReplicas(service, endpoint);
  const head = proposedCommitment(registration);
  const wrongFingerprint = requestBytes(endpoint, {
    kind: 3,
    operationId: id(90),
    expectedCounter: 1n,
    expectedCommitment: head,
    proposedCounter: 2n,
    proposedCommitment: new Uint8Array(48).fill(30),
    credentialFingerprint: new Uint8Array(48).fill(99),
  });
  await assert.rejects(service.gateway.submit(principal(endpoint), wrongFingerprint));
  const wrongSignature = advance(endpoint, id(91), 1n, head, new Uint8Array(48).fill(31));
  wrongSignature[wrongSignature.length - 1] = (wrongSignature[wrongSignature.length - 1] ?? 0) ^ 1;
  await assert.rejects(
    service.gateway.submit(principal(endpoint), wrongSignature),
    (error) => error instanceof WitnessServiceError && error.code === "witness_auth_failed",
  );

  const replacement = endpointFixture(71);
  const replacementRegistration = requestBytes(replacement, {
    kind: 1,
    operationId: id(92),
    proposedCounter: 1n,
    proposedCommitment: new Uint8Array(48).fill(32),
  });
  // The fixture IDs are identical, so this attempts to replace only the bound credential and key.
  assert.equal(
    parseWitnessQuorumCertificate(
      await service.gateway.submit(principal(endpoint), replacementRegistration),
    ).receipts[0].result,
    "registration_conflict",
  );
});
