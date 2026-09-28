// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * Deployment-test rollback witness: three in-process replicas.
 *
 * This is not the production witness topology. The three replicas share one process, one account,
 * and one failure domain. Their state is kept in the storage the assembly passes, DynamoDB on the
 * AWS stack, or process memory when none is given. Signing keys come from Secrets Manager and
 * their public halves are the replica trust pinned into deployment-test client builds.
 *
 * Empty replicas start in bootstrap, which admits exactly one initial registration. They become
 * ready through the ordinary recovery exchange: the first endpoint-signed read after that
 * registration is answered by each replica's recovery head, and every replica recovers from the
 * other two receipts before the read itself is submitted.
 *
 * Replicas that start over durable state resume lineage by lineage. Endpoints make a fresh signed
 * read before every mutation, so the first read of each lineage after a restart recovers that
 * lineage on every replica the same way, and a paired phone keeps working without pairing again.
 */

import { createPrivateKey, createPublicKey, type KeyObject, sign } from "node:crypto";
import {
  type CanonicalWitnessReceipt,
  type HostedWitnessPrincipal,
  type WitnessAdmission,
  WitnessGateway,
  type WitnessHighWaterEntry,
  type WitnessHighWaterJournal,
  WitnessReplica,
  type WitnessReplicaRecord,
  type WitnessReplicaStorage,
  type WitnessReplicaTransaction,
  type WitnessSecurityAuditEvent,
  witnessLineageHash,
} from "@axl/control-plane";
import {
  parseWitnessRequest,
  WITNESS_RECEIPT_SIGNATURE_DOMAIN,
  type WitnessReplicaTrust,
  type WitnessRequest,
  witnessBytesEqual,
  witnessBytesHex,
} from "@axl/protocol";

const REPLICA_TRUST_CONFIG_VERSION = 1;
const REPLICA_DEADLINE_MS = 5_000;

export interface DeploymentTestWitnessKey {
  readonly replicaId: Uint8Array;
  readonly keyId: Uint8Array;
  readonly privateKey: KeyObject;
  readonly verificationKey: Uint8Array;
}

function id(value: unknown, name: string): Uint8Array {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/u.test(value) || /^0+$/u.test(value)) {
    throw new Error(`${name} must be 16 nonzero bytes of lowercase hex`);
  }
  return new Uint8Array(Buffer.from(value, "hex"));
}

/**
 * Parse the witness key secret: `{"replicas":[{"replicaId","keyId","privateKey"}x3]}` with hex
 * identifiers and base64 PKCS#8 Ed25519 private keys.
 */
export function parseDeploymentTestWitnessKeys(serialized: string): DeploymentTestWitnessKey[] {
  const value: unknown = JSON.parse(serialized);
  const replicas = (value as { replicas?: unknown } | null)?.replicas;
  if (!Array.isArray(replicas) || replicas.length !== 3) {
    throw new Error("The witness key secret must name exactly three replicas");
  }
  const keys = replicas.map((replica: unknown, index) => {
    const entry = replica as Record<string, unknown>;
    if (typeof entry.privateKey !== "string") {
      throw new Error(`Witness replica ${index} private key is missing`);
    }
    const privateKey = createPrivateKey({
      key: Buffer.from(entry.privateKey, "base64"),
      format: "der",
      type: "pkcs8",
    });
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error(`Witness replica ${index} key must be Ed25519`);
    }
    const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
    return {
      replicaId: id(entry.replicaId, `replicas[${index}].replicaId`),
      keyId: id(entry.keyId, `replicas[${index}].keyId`),
      privateKey,
      verificationKey: new Uint8Array(spki.subarray(spki.byteLength - 32)),
    };
  });
  const distinct = (field: "replicaId" | "keyId" | "verificationKey") =>
    new Set(keys.map((key) => witnessBytesHex(key[field]))).size === keys.length;
  if (!distinct("replicaId") || !distinct("keyId") || !distinct("verificationKey")) {
    throw new Error("Witness replica identities and keys must be distinct");
  }
  return keys;
}

export function deploymentTestWitnessTrust(
  keys: readonly DeploymentTestWitnessKey[],
): WitnessReplicaTrust[] {
  return keys.map((key) => ({
    replicaId: key.replicaId.slice(),
    keys: [{ keyId: key.keyId.slice(), verificationKey: key.verificationKey.slice() }],
  }));
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

/**
 * The canonical replica trust configuration the E2EE clients decode (`ReplicaTrustSet::decode_config`):
 * version, replica count, then each replica in identifier order with its keys in identifier order.
 */
export function encodeReplicaTrustConfig(trust: readonly WitnessReplicaTrust[]): Uint8Array {
  const replicas = [...trust].sort((left, right) => compareBytes(left.replicaId, right.replicaId));
  const parts: Uint8Array[] = [
    Uint8Array.of(REPLICA_TRUST_CONFIG_VERSION >> 8, REPLICA_TRUST_CONFIG_VERSION & 0xff),
    Uint8Array.of(replicas.length),
  ];
  for (const replica of replicas) {
    parts.push(replica.replicaId, Uint8Array.of(replica.keys.length));
    for (const key of [...replica.keys].sort((left, right) =>
      compareBytes(left.keyId, right.keyId),
    )) {
      parts.push(key.keyId, key.verificationKey);
    }
  }
  return new Uint8Array(Buffer.concat(parts));
}

class ReceiptSigner {
  readonly replicaId: Uint8Array;
  readonly keyId: Uint8Array;
  readonly #privateKey: KeyObject;

  constructor(key: DeploymentTestWitnessKey) {
    this.replicaId = key.replicaId.slice();
    this.keyId = key.keyId.slice();
    this.#privateKey = key.privateKey;
  }

  async sign(receipt: CanonicalWitnessReceipt): Promise<Uint8Array> {
    return new Uint8Array(
      sign(
        null,
        Buffer.concat([
          Buffer.from(WITNESS_RECEIPT_SIGNATURE_DOMAIN),
          Buffer.from(receipt.bytesForSigning()),
        ]),
        this.#privateKey,
      ),
    );
  }
}

/** Process-lifetime lineage records, serialized per lineage. */
class MemoryReplicaStorage implements WitnessReplicaStorage {
  readonly #records = new Map<string, WitnessReplicaRecord>();
  readonly #tails = new Map<string, Promise<void>>();

  async transact<T>(
    lineageHash: Uint8Array,
    transaction: (current: WitnessReplicaRecord | undefined) => WitnessReplicaTransaction<T>,
  ): Promise<T> {
    const key = witnessBytesHex(lineageHash);
    const prior = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = prior.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    this.#tails.set(key, tail);
    await prior;
    try {
      const current = this.#records.get(key);
      const outcome = transaction(current === undefined ? undefined : structuredClone(current));
      if (outcome.next !== undefined) this.#records.set(key, structuredClone(outcome.next));
      return structuredClone(outcome.value) as T;
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }

  async listLineageHashes(): Promise<readonly Uint8Array[]> {
    return [...this.#records.values()].map((record) => record.lineageHash.slice());
  }

  async read(lineageHash: Uint8Array): Promise<WitnessReplicaRecord | undefined> {
    const record = this.#records.get(witnessBytesHex(lineageHash));
    return record === undefined ? undefined : structuredClone(record);
  }
}

/** Process-lifetime append-only high-water journal. */
class MemoryHighWaterJournal implements WitnessHighWaterJournal {
  readonly #entries = new Map<string, WitnessHighWaterEntry[]>();

  async append(entry: WitnessHighWaterEntry): Promise<void> {
    const key = witnessBytesHex(entry.lineageHash);
    const entries = this.#entries.get(key) ?? [];
    const existing = entries.find((candidate) => candidate.sequence === entry.sequence);
    if (existing !== undefined) {
      if (
        existing.counter !== entry.counter ||
        existing.revocationGeneration !== entry.revocationGeneration ||
        !witnessBytesEqual(existing.commitment, entry.commitment) ||
        !witnessBytesEqual(existing.eventHash, entry.eventHash)
      ) {
        throw new Error("immutable journal conflict");
      }
      return;
    }
    if (entry.sequence !== (entries.at(-1)?.sequence ?? 0n) + 1n) {
      throw new Error("immutable journal gap");
    }
    entries.push(structuredClone(entry));
    this.#entries.set(key, entries);
  }

  async latest(lineageHash: Uint8Array): Promise<WitnessHighWaterEntry | undefined> {
    const entry = this.#entries.get(witnessBytesHex(lineageHash))?.at(-1);
    return entry === undefined ? undefined : structuredClone(entry);
  }
}

export interface DeploymentTestWitnessStores {
  readonly storage: WitnessReplicaStorage;
  readonly journal: WitnessHighWaterJournal;
}

export interface DeploymentTestWitnessFailure {
  readonly stage: "recovery" | "submit";
  readonly kind: WitnessRequest["kind"] | "unparsed";
  readonly lineageHash?: string;
  readonly cause: unknown;
}

export interface DeploymentTestWitnessOptions {
  readonly keys: readonly DeploymentTestWitnessKey[];
  /** The single deployment-test account, as the UUID the public authenticator returns. */
  readonly accountId: string;
  /** Durable stores for one replica. Without it, replica state lives in process memory. */
  readonly stores?: (key: DeploymentTestWitnessKey) => DeploymentTestWitnessStores;
  readonly audit?: (event: WitnessSecurityAuditEvent) => void;
  /** A witness request that failed, and why; recovery failures come before their request's. */
  readonly onFailure?: (failure: DeploymentTestWitnessFailure) => void;
}

function accountMatches(principal: HostedWitnessPrincipal, request: WitnessRequest): boolean {
  return (
    principal.accountId.replaceAll("-", "").toLowerCase() ===
    witnessBytesHex(request.lineage.accountId)
  );
}

export async function createDeploymentTestWitness(
  options: DeploymentTestWitnessOptions,
): Promise<WitnessGateway> {
  const trust = deploymentTestWitnessTrust(options.keys);
  const audit = {
    async emit(event: WitnessSecurityAuditEvent) {
      options.audit?.(event);
    },
  };
  const stores = options.keys.map(
    (key) =>
      options.stores?.(key) ?? {
        storage: new MemoryReplicaStorage(),
        journal: new MemoryHighWaterJournal(),
      },
  );
  const replicas = options.keys.map(
    (key, index) =>
      new WitnessReplica({
        storage: (stores[index] as DeploymentTestWitnessStores).storage,
        journal: (stores[index] as DeploymentTestWitnessStores).journal,
        signer: new ReceiptSigner(key),
        recoveryTrust: trust,
        admission: {
          async validate(admission, request) {
            return accountMatches(admission.principal, request) ? admission : undefined;
          },
        },
        credentials: {
          async authorizeRegistration(admission, request, credential) {
            return (
              accountMatches(admission.principal, request) &&
              witnessBytesEqual(credential.accountId, request.lineage.accountId)
            );
          },
          async lookupAuthorizedBinding(admission, request, binding) {
            return accountMatches(admission.principal, request) ? binding : undefined;
          },
        },
        clock: { nowMs: () => BigInt(Date.now()) },
        audit,
      }),
  );
  const held = await Promise.all(
    stores.map(async (store) => (await store.storage.listLineageHashes()).length > 0),
  );
  if (held.some((value) => value !== held[0])) {
    // A partly empty set of replicas cannot bootstrap or recover; it must not guess which is right.
    throw new Error("The witness replicas disagree about whether they hold any state");
  }
  const bootstrapping = held[0] !== true;
  await Promise.all(
    replicas.map((replica) => (bootstrapping ? replica.bootstrapEmpty() : replica.resumeDurable())),
  );
  const [first, second, third] = replicas;
  if (first === undefined || second === undefined || third === undefined) {
    throw new Error("The deployment-test witness requires three replicas");
  }
  const admit = async (
    principal: HostedWitnessPrincipal,
    request: WitnessRequest,
  ): Promise<WitnessAdmission | undefined> =>
    principal.accountId === options.accountId && accountMatches(principal, request)
      ? { principal, mode: "active" }
      : undefined;
  return new RecoveringWitnessGateway(
    {
      authorizer: { authorize: admit },
      replicas: [first, second, third],
      trust,
      deadline: {
        waitForReplica(_client, operation) {
          let timer: NodeJS.Timeout | undefined;
          const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("Witness replica deadline exceeded")),
              REPLICA_DEADLINE_MS,
            );
          });
          return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
        },
      },
      audit,
    },
    [first, second, third],
    admit,
    bootstrapping,
    options.onFailure,
  );
}

class RecoveringWitnessGateway extends WitnessGateway {
  readonly #replicas: readonly WitnessReplica[];
  readonly #admit: (
    principal: HostedWitnessPrincipal,
    request: WitnessRequest,
  ) => Promise<WitnessAdmission | undefined>;
  #ready: boolean;
  #bootstrapping: Promise<void> | undefined;
  readonly #recovering = new Map<string, Promise<void>>();
  readonly #onFailure: ((failure: DeploymentTestWitnessFailure) => void) | undefined;

  constructor(
    options: ConstructorParameters<typeof WitnessGateway>[0],
    replicas: readonly WitnessReplica[],
    admit: (
      principal: HostedWitnessPrincipal,
      request: WitnessRequest,
    ) => Promise<WitnessAdmission | undefined>,
    bootstrapping: boolean,
    onFailure?: (failure: DeploymentTestWitnessFailure) => void,
  ) {
    super(options);
    this.#replicas = replicas;
    this.#admit = admit;
    this.#ready = !bootstrapping;
    this.#onFailure = onFailure;
  }

  override async submit(
    principal: HostedWitnessPrincipal,
    exactRequest: Uint8Array,
  ): Promise<Uint8Array> {
    if (!this.#ready) await this.#completeBootstrap(principal, exactRequest);
    else await this.#recoverLineage(principal, exactRequest);
    try {
      return await super.submit(principal, exactRequest);
    } catch (cause) {
      if (this.#onFailure !== undefined) {
        let request: WitnessRequest | undefined;
        try {
          request = parseWitnessRequest(exactRequest);
        } catch {
          request = undefined;
        }
        this.#onFailure({
          stage: "submit",
          kind: request?.kind ?? "unparsed",
          ...(request === undefined
            ? {}
            : { lineageHash: witnessBytesHex(witnessLineageHash(request)) }),
          cause,
        });
      }
      throw cause;
    }
  }

  /**
   * Recover a resumed lineage with its first fresh read: every replica signs its head for that
   * read, and each one that has not recovered the lineage checks its own head against the other two.
   */
  async #recoverLineage(principal: HostedWitnessPrincipal, exactRequest: Uint8Array) {
    let request: WitnessRequest;
    try {
      request = parseWitnessRequest(exactRequest);
    } catch {
      return;
    }
    if (request.kind !== "read") return;
    const lineage = witnessLineageHash(request);
    const ready = () => this.#replicas.every((replica) => replica.lineageReady(lineage));
    if (ready()) return;
    const admission = await this.#admit(principal, request);
    if (admission === undefined) return;
    const key = witnessBytesHex(lineage);
    for (let pending = this.#recovering.get(key); pending !== undefined; ) {
      await pending.catch(() => undefined);
      pending = this.#recovering.get(key);
    }
    if (ready()) return;
    const attempt = (async () => {
      const receipts = await Promise.all(
        this.#replicas.map((replica) => replica.recoveryHead(admission, exactRequest)),
      );
      await Promise.all(
        this.#replicas.map((replica, own) =>
          replica.lineageReady(lineage)
            ? undefined
            : replica.recoverLineage(
                receipts
                  .filter((_receipt, index) => index !== own)
                  .map((receiptBytes) => ({ requestBytes: exactRequest, receiptBytes })),
              ),
        ),
      );
    })();
    this.#recovering.set(key, attempt);
    try {
      await attempt;
    } catch (cause) {
      // Not recovered: the submission below fails closed and a later read retries.
      this.#onFailure?.({ stage: "recovery", kind: "read", lineageHash: key, cause });
    } finally {
      this.#recovering.delete(key);
    }
  }

  /** Move every replica from bootstrap to ready with the first registered lineage's signed read. */
  async #completeBootstrap(principal: HostedWitnessPrincipal, exactRequest: Uint8Array) {
    let request: WitnessRequest;
    try {
      request = parseWitnessRequest(exactRequest);
    } catch {
      return;
    }
    if (request.kind !== "read") return;
    const admission = await this.#admit(principal, request);
    if (admission === undefined) return;
    while (this.#bootstrapping !== undefined) await this.#bootstrapping.catch(() => undefined);
    if (this.#ready) return;
    const attempt = (async () => {
      // Recovery heads change no replica state; a read for a lineage the replicas do not hold
      // fails here and the gateway answers it normally.
      const receipts = await Promise.all(
        this.#replicas.map((replica) => replica.recoveryHead(admission, exactRequest)),
      );
      await Promise.all(
        this.#replicas.map((replica, own) =>
          replica.recover(
            receipts
              .filter((_receipt, index) => index !== own)
              .map((receiptBytes) => ({ requestBytes: exactRequest, receiptBytes })),
          ),
        ),
      );
      this.#ready = true;
    })();
    this.#bootstrapping = attempt;
    try {
      await attempt;
    } catch {
      // Not ready yet: the submission below fails closed and a later read retries.
    } finally {
      this.#bootstrapping = undefined;
    }
  }
}
