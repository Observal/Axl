// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

// Test-only browser persistence feasibility adapter. This file is copied only into the separate
// test artifact. Production create/open remain fail-closed in worker/index.js.

const STATE_VERSION = 1;
const KEY_VERSION = 1;
const PROFILE_ID = "axl-e2ee-mls-pq-v1";
const PROFILE_REVISION = 1;
const PLAINTEXT_MAX_BYTES = 60_000;
const CIPHERTEXT_MAX_BYTES = 65_497;
const SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
const SEALED_STATE_MAX_BYTES = SNAPSHOT_MAX_BYTES * 2 + 4_096;
const MAX_RECORDS = 1_024;
const OPERATION_ID_PATTERN = /^[0-9a-f]{32}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{96}$/u;
const KEY_ID_PATTERN = /^[0-9a-f]{32}$/u;
const OPERATION_FAULTS = Object.freeze([
  null,
  "terminate_before_commit",
  "generation_conflict",
  "abort_before_commit",
  "quota",
  "ambiguous_after_commit",
  "terminate_after_commit",
  "observe_completion",
]);
const CREATE_FAULTS = Object.freeze([
  null,
  "terminate_before_commit",
  "ambiguous_after_commit",
  "terminate_after_commit",
]);
const STATE_STORES = Object.freeze([
  "metadata_v1",
  "sealed_state_v1",
  "manifest_v1",
  "operations_v1",
  "outbox_v1",
  "accepted_messages_v1",
  "pending_plaintext_v1",
  "creation_v1",
]);
const KEY_STORES = Object.freeze(["wrapping_key_v1", "wrapped_deks_v1", "test_anchor_v1"]);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export class PersistenceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const fail = (code) => new PersistenceError(code);
const bytes = (value) => (value instanceof Uint8Array ? value : new Uint8Array(value));
const hex = (value) =>
  [...bytes(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

function exactObject(value, expectedKeys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw fail("corrupt_state");
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw fail("corrupt_state");
  }
  return value;
}

function exactBytes(value, maximum, { allowEmpty = false } = {}) {
  if (!(value instanceof Uint8Array) || value.byteLength > maximum) throw fail("corrupt_state");
  if (!allowEmpty && value.byteLength === 0) throw fail("corrupt_state");
  return value;
}

function exactInputByteArray(value, maximum) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > maximum ||
    Object.keys(value).length !== value.length
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (
      !Object.hasOwn(value, index) ||
      !Number.isInteger(value[index]) ||
      value[index] < 0 ||
      value[index] > 255
    ) {
      return false;
    }
  }
  return true;
}

function safeCounter(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_RECORDS) {
    throw fail("corrupt_state");
  }
  return value;
}

function exactId(value, pattern = OPERATION_ID_PATTERN) {
  if (typeof value !== "string" || !pattern.test(value)) throw fail("corrupt_state");
  return value;
}

function strictTransaction(database, stores) {
  let transaction;
  try {
    transaction = database.transaction(stores, "readwrite", { durability: "strict" });
  } catch (cause) {
    throw mapStorageError(cause);
  }
  if (transaction.durability !== "strict") {
    transaction.abort();
    throw fail("strict_durability_unavailable");
  }
  return transaction;
}

const fromHex = (value) => {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(value)) {
    throw fail("corrupt_state");
  }
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
};

function normalize(value) {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return { bytes: hex(value) };
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize(value[key])]),
    );
  }
  return value;
}

const canonical = (value) => textEncoder.encode(JSON.stringify(normalize(value)));
const digest = async (value) => hex(await crypto.subtle.digest("SHA-384", canonical(value)));

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? fail("storage_unavailable"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? fail("transaction_aborted"));
    transaction.onerror = () => {};
  });
}

function mapStorageError(cause, fallback = "storage_unavailable") {
  if (cause instanceof PersistenceError) return cause;
  if (cause?.name === "QuotaExceededError") return fail("quota_exceeded");
  if (cause?.name === "VersionError") return fail("unsupported_schema");
  if (cause?.name === "AbortError") return fail("transaction_aborted");
  return fail(fallback);
}

function openDatabase(name, version, stores, unavailable) {
  if (unavailable || typeof indexedDB === "undefined") {
    return Promise.reject(fail("storage_unavailable"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    try {
      request = indexedDB.open(name, version);
    } catch (cause) {
      reject(mapStorageError(cause));
      return;
    }
    request.onupgradeneeded = (event) => {
      try {
        if (event.oldVersion !== 0) throw fail("unsupported_schema");
        for (const store of stores) request.result.createObjectStore(store, { keyPath: "id" });
      } catch (cause) {
        request.transaction?.abort();
        if (!settled) {
          settled = true;
          reject(mapStorageError(cause, "unsupported_schema"));
        }
      }
    };
    request.onblocked = () => {
      if (!settled) {
        settled = true;
        reject(fail("storage_unavailable"));
      }
    };
    request.onerror = () => {
      if (!settled) {
        settled = true;
        reject(mapStorageError(request.error));
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      resolve(request.result);
    };
  });
}

function validateDatabaseStores(database, expectedStores) {
  const actual = [...database.objectStoreNames].sort();
  const expected = [...expectedStores].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    database.close();
    throw fail("unsupported_schema");
  }
  return database;
}

function parseFramed(value, magic, fields) {
  const input = bytes(value);
  let offset = 0;
  const take = (length) => {
    const end = offset + length;
    if (!Number.isSafeInteger(end) || end > input.length) throw fail("corrupt_state");
    const result = input.slice(offset, end);
    offset = end;
    return result;
  };
  if (textDecoder.decode(take(8)) !== magic) throw fail("corrupt_state");
  const result = {};
  for (const [name, kind] of fields) {
    if (kind === "u8") result[name] = take(1)[0];
    else if (kind === "id") result[name] = take(16);
    else {
      const lengthBytes = take(4);
      const length = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, 4).getUint32(0);
      result[name] = take(length);
    }
  }
  if (offset !== input.length) throw fail("corrupt_state");
  return result;
}

export function parseSeed(value) {
  return parseFramed(value, "AXLBSE01", [
    ["role", "u8"],
    ["sessionId", "id"],
    ["snapshot", "blob"],
    ["input", "blob"],
    ["additionalInput", "blob"],
  ]);
}

export function parseMutation(value) {
  return parseFramed(value, "AXLBPM01", [
    ["snapshot", "blob"],
    ["result", "blob"],
  ]);
}

function stateAad(metadata) {
  return canonical({
    schemaVersion: metadata.schemaVersion,
    profileId: metadata.profileId,
    profileRevision: metadata.profileRevision,
    cryptoSessionId: metadata.cryptoSessionId,
    generation: metadata.generation,
    rollbackCounter: metadata.rollbackCounter,
    currentKeyId: metadata.currentKeyId,
  });
}

function canonicalRecords(records) {
  return [...records].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function manifestProjection(metadata, operations, outbox, accepted, pendingPlaintext, creation) {
  return {
    metadata: {
      schemaVersion: metadata.schemaVersion,
      lifecycle: metadata.lifecycle,
      profileId: metadata.profileId,
      profileRevision: metadata.profileRevision,
      cryptoSessionId: metadata.cryptoSessionId,
      generation: metadata.generation,
      rollbackCounter: metadata.rollbackCounter,
      currentKeyId: metadata.currentKeyId,
    },
    operations: canonicalRecords(operations),
    outbox: canonicalRecords(outbox),
    accepted: canonicalRecords(accepted),
    pendingPlaintext: canonicalRecords(pendingPlaintext),
    creation,
  };
}

function validateMetadata(record) {
  exactObject(record, [
    "id",
    "schemaVersion",
    "lifecycle",
    "profileId",
    "profileRevision",
    "cryptoSessionId",
    "generation",
    "rollbackCounter",
    "currentKeyId",
  ]);
  if (
    record.id !== "current" ||
    record.schemaVersion !== 1 ||
    record.lifecycle !== "ready" ||
    record.profileId !== PROFILE_ID ||
    record.profileRevision !== PROFILE_REVISION ||
    typeof record.cryptoSessionId !== "string" ||
    !OPERATION_ID_PATTERN.test(record.cryptoSessionId)
  ) {
    throw fail(record.schemaVersion !== 1 ? "unsupported_schema" : "corrupt_state");
  }
  safeCounter(record.generation, 1);
  safeCounter(record.rollbackCounter, 1);
  exactId(record.currentKeyId, KEY_ID_PATTERN);
  return record;
}

function validateStateRecord(record) {
  exactObject(record, ["id", "keyId", "iv", "ciphertext"]);
  if (record.id !== "current") throw fail("corrupt_state");
  exactId(record.keyId, KEY_ID_PATTERN);
  if (exactBytes(record.iv, 12).byteLength !== 12) throw fail("corrupt_state");
  exactBytes(record.ciphertext, SEALED_STATE_MAX_BYTES);
  return record;
}

function validateManifestRecord(record) {
  exactObject(record, ["id", "digest"]);
  if (
    record.id !== "current" ||
    typeof record.digest !== "string" ||
    !DIGEST_PATTERN.test(record.digest)
  ) {
    throw fail("corrupt_state");
  }
  return record;
}

function validateOperationRecord(record) {
  exactObject(record, ["id", "fingerprint", "generation", "resultKind"]);
  exactId(record.id);
  if (
    typeof record.fingerprint !== "string" ||
    !DIGEST_PATTERN.test(record.fingerprint) ||
    !["created", "ciphertext", "plaintext"].includes(record.resultKind)
  ) {
    throw fail("corrupt_state");
  }
  safeCounter(record.generation, 1);
  return record;
}

function validateOutboxRecord(record) {
  exactObject(record, ["id", "ciphertext"]);
  exactId(record.id);
  exactBytes(record.ciphertext, CIPHERTEXT_MAX_BYTES);
  return record;
}

function validateAcceptedRecord(record) {
  exactObject(record, ["id", "acknowledged"]);
  exactId(record.id);
  if (record.acknowledged !== false) throw fail("corrupt_state");
  return record;
}

function validatePendingRecord(record) {
  exactObject(record, ["id", "keyId", "iv", "ciphertext"]);
  exactId(record.id);
  exactId(record.keyId, KEY_ID_PATTERN);
  if (exactBytes(record.iv, 12).byteLength !== 12) throw fail("corrupt_state");
  exactBytes(record.ciphertext, PLAINTEXT_MAX_BYTES + 16);
  return record;
}

function validateCreationRecord(record) {
  exactObject(record, ["id", "input", "additionalInput"]);
  if (record.id !== "current") throw fail("corrupt_state");
  exactBytes(record.input, CIPHERTEXT_MAX_BYTES, { allowEmpty: true });
  exactBytes(record.additionalInput, CIPHERTEXT_MAX_BYTES, { allowEmpty: true });
  return record;
}

function readBounded(store, validate, maximum = MAX_RECORDS) {
  return new Promise((resolve, reject) => {
    const records = [];
    const request = store.openCursor();
    request.onerror = () => reject(mapStorageError(request.error));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(records);
        return;
      }
      try {
        if (records.length >= maximum) throw fail("corrupt_state");
        const record = validate(cursor.value);
        if (cursor.primaryKey !== record.id) throw fail("corrupt_state");
        records.push(record);
        cursor.continue();
      } catch (cause) {
        reject(cause instanceof PersistenceError ? cause : fail("corrupt_state"));
      }
    };
  });
}

async function readSingleton(store, validate, optional = false) {
  const records = await readBounded(store, validate, 1);
  if (records.length === 0 && optional) return undefined;
  if (records.length !== 1) throw fail("corrupt_state");
  return records[0];
}

function validateWrappingKey(record) {
  try {
    exactObject(record, ["id", "key"]);
  } catch {
    throw fail("secure_store_unavailable");
  }
  const usages = [...(record.key?.usages ?? [])].sort();
  if (
    record.id !== "current" ||
    !(record.key instanceof CryptoKey) ||
    record.key.extractable !== false ||
    record.key.algorithm?.name !== "AES-KW" ||
    record.key.algorithm?.length !== 256 ||
    usages.join(",") !== "unwrapKey,wrapKey"
  ) {
    throw fail("secure_store_unavailable");
  }
  return record;
}

function validateWrappedDek(record) {
  exactObject(record, ["id", "cryptoSessionId", "status", "wrapped"]);
  exactId(record.id, KEY_ID_PATTERN);
  if (
    typeof record.cryptoSessionId !== "string" ||
    !OPERATION_ID_PATTERN.test(record.cryptoSessionId) ||
    !["prepared", "active", "retained"].includes(record.status)
  ) {
    throw fail("secure_store_unavailable");
  }
  try {
    if (exactBytes(record.wrapped, 40).byteLength !== 40) throw fail("secure_store_unavailable");
  } catch {
    throw fail("secure_store_unavailable");
  }
  return record;
}

function validateAnchor(record) {
  exactObject(record, ["id", "counter", "lossReported"]);
  if (record.id !== "anchor" || typeof record.lossReported !== "boolean") {
    throw fail("secure_store_unavailable");
  }
  safeCounter(record.counter);
  return record;
}

async function seal(key, plaintext, additionalData) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData, tagLength: 128 },
    key,
    plaintext,
  );
  return { iv, ciphertext: new Uint8Array(ciphertext) };
}

async function unseal(key, record, additionalData) {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes(record.iv), additionalData, tagLength: 128 },
        key,
        bytes(record.ciphertext),
      ),
    );
  } catch {
    throw fail("corrupt_state");
  }
}

export class BrowserPersistenceEndpoint {
  constructor({
    sessionId,
    seedFactory,
    transition,
    receive = false,
    unavailable = false,
    notify = () => {},
    terminate = () => {},
  }) {
    if (!(sessionId instanceof Uint8Array) || sessionId.byteLength !== 16) {
      throw fail("invalid_argument");
    }
    this.seedFactory = seedFactory;
    this.transition = transition;
    this.receive = receive;
    this.unavailable = unavailable;
    this.notify = notify;
    this.terminate = terminate;
    this.sessionHex = hex(sessionId);
    this.stateName = `axl-e2ee-state-v1:${this.sessionHex}`;
    this.keyName = `axl-e2ee-keys-v1:${this.sessionHex}`;
    this.lockName = `axl-e2ee-v1:${this.sessionHex}`;
    this.stateDb = undefined;
    this.keyDb = undefined;
    this.closed = false;
    this.poisoned = false;
    this.closing = false;
    this.queue = Promise.resolve();
  }

  run(operation) {
    const result = this.queue.then(async () => {
      if (this.closed || this.poisoned) throw fail("endpoint_closed");
      return operation();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  async acquire() {
    if (this.lockHeld) return;
    if (typeof navigator?.locks?.request !== "function") throw fail("storage_unavailable");
    let acquiredResolve;
    let acquiredReject;
    const acquired = new Promise((resolve, reject) => {
      acquiredResolve = resolve;
      acquiredReject = reject;
    });
    this.lifetime = new Promise((resolve, reject) => {
      this.releaseLock = resolve;
      this.rejectLock = reject;
    });
    this.lockRequest = navigator.locks
      .request(this.lockName, { mode: "exclusive", ifAvailable: true }, async (lock) => {
        if (!lock) {
          acquiredReject(fail("lifecycle_busy"));
          return;
        }
        this.lockHeld = true;
        acquiredResolve();
        await this.lifetime;
        this.lockHeld = false;
      })
      .then(
        () => {
          if (!this.closing) this.poison("lock_lost");
        },
        () => {
          if (!this.closing) this.poison("lock_lost");
        },
      );
    await acquired;
  }

  poison(code) {
    this.poisoned = true;
    this.stateDb?.close();
    this.keyDb?.close();
    this.stateDb = undefined;
    this.keyDb = undefined;
    this.notify({ event: "fatal", code });
    queueMicrotask(() => this.terminate());
  }

  async databases() {
    if (!this.lockHeld) throw fail("lifecycle_busy");
    if (!this.keyDb) {
      this.keyDb = validateDatabaseStores(
        await openDatabase(this.keyName, KEY_VERSION, KEY_STORES, this.unavailable),
        KEY_STORES,
      );
      this.keyDb.onversionchange = () => this.poison("storage_unavailable");
    }
    if (!this.stateDb) {
      this.stateDb = validateDatabaseStores(
        await openDatabase(this.stateName, STATE_VERSION, STATE_STORES, this.unavailable),
        STATE_STORES,
      );
      this.stateDb.onversionchange = () => this.poison("storage_unavailable");
      this.stateDb.onclose = () => {
        if (!this.closing) this.poison("storage_unavailable");
      };
    }
    return { stateDb: this.stateDb, keyDb: this.keyDb };
  }

  strictTransaction(database, stores) {
    const transaction = strictTransaction(database, stores);
    this.strictDurabilityVerified = true;
    return transaction;
  }

  async create(fault = null) {
    return this.run(async () => {
      if (!CREATE_FAULTS.includes(fault)) throw fail("invalid_argument");
      await this.acquire();
      await this.databases();
      const operationId = "00000000000000000000000000000001";
      const fingerprint = await digest({ kind: "create", session: this.sessionHex });
      const existing = await this.readRaw();
      if (existing.metadata) {
        const committed = await this.readCommitted();
        const operation = committed.operations.find((record) => record.id === operationId);
        if (!operation || operation.fingerprint !== fingerprint || operation.resultKind !== "created") {
          throw fail("operation_conflict");
        }
        const recovered = await this.committedResult(committed, operation);
        return {
          generation: committed.metadata.generation,
          lockName: this.lockName,
          sessionId: this.sessionHex,
          input: recovered.input,
          additionalInput: recovered.additionalInput,
          duplicate: true,
          strictDurability: this.strictDurabilityVerified === true,
        };
      }
      const seed = this.seedFactory();
      if (
        seed.role !== (this.receive ? 1 : 2) ||
        !(seed.sessionId instanceof Uint8Array) ||
        seed.sessionId.byteLength !== 16 ||
        hex(seed.sessionId) !== this.sessionHex ||
        !(seed.snapshot instanceof Uint8Array) ||
        seed.snapshot.byteLength === 0 ||
        seed.snapshot.byteLength > SNAPSHOT_MAX_BYTES ||
        !(seed.input instanceof Uint8Array) ||
        seed.input.byteLength > CIPHERTEXT_MAX_BYTES ||
        !(seed.additionalInput instanceof Uint8Array) ||
        seed.additionalInput.byteLength > CIPHERTEXT_MAX_BYTES
      ) {
        throw fail("corrupt_state");
      }
      const pending = {
        expectedGeneration: 0,
        operationId,
        fingerprint,
        snapshot: seed.snapshot,
        result: new Uint8Array(),
        resultKind: "created",
        creation: {
          id: "current",
          input: new Uint8Array(seed.input),
          additionalInput: new Uint8Array(seed.additionalInput),
        },
      };
      if (fault === "terminate_before_commit") {
        this.notify({ event: "prepared", operationId });
        await new Promise(() => {});
      }
      await this.commitPrepared(pending, fault);
      if (fault === "ambiguous_after_commit" || fault === "terminate_after_commit") {
        this.notify({ event: "committed", operationId });
        if (fault === "terminate_after_commit") await new Promise(() => {});
        throw fail("ambiguous_commit");
      }
      return {
        generation: 1,
        lockName: this.lockName,
        sessionId: this.sessionHex,
        input: [...seed.input],
        additionalInput: [...seed.additionalInput],
        duplicate: false,
        strictDurability: this.strictDurabilityVerified === true,
      };
    });
  }

  async open() {
    return this.run(async () => {
      await this.acquire();
      await this.databases();
      const committed = await this.readCommitted();
      return {
        generation: committed.metadata.generation,
        lockName: this.lockName,
        sessionId: this.sessionHex,
        strictDurability: this.strictDurabilityVerified === true,
      };
    });
  }

  async operate(operationId, payload, fault) {
    return this.run(async () => {
      if (!OPERATION_ID_PATTERN.test(operationId) || !OPERATION_FAULTS.includes(fault)) {
        throw fail("invalid_argument");
      }
      let input;
      if (this.receive) {
        if (!exactInputByteArray(payload, CIPHERTEXT_MAX_BYTES)) {
          throw fail("invalid_argument");
        }
        input = new Uint8Array(payload);
      } else {
        if (typeof payload !== "string" || payload.length > PLAINTEXT_MAX_BYTES) {
          throw fail("invalid_argument");
        }
        input = textEncoder.encode(payload);
        if (input.byteLength === 0 || input.byteLength > PLAINTEXT_MAX_BYTES) {
          throw fail("bound_exceeded");
        }
      }
      const fingerprint = await digest({
        kind: this.receive ? "receive" : "send",
        operationId,
        input,
      });
      const committed = await this.readCommitted();
      const prior = committed.operations.find((record) => record.id === operationId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw fail("operation_conflict");
        return this.committedResult(committed, prior);
      }
      const operationIdBytes = fromHex(operationId);
      const mutationBytes = this.transition(
        new Uint8Array(committed.snapshot),
        operationIdBytes,
        new Uint8Array(input),
        Date.now(),
      );
      operationIdBytes.fill(0);
      if (
        !(mutationBytes instanceof Uint8Array) ||
        mutationBytes.byteLength > SNAPSHOT_MAX_BYTES + CIPHERTEXT_MAX_BYTES + 20
      ) {
        throw fail("bound_exceeded");
      }
      const mutation = parseMutation(mutationBytes);
      bytes(mutationBytes).fill(0);
      if (
        mutation.snapshot.byteLength === 0 ||
        mutation.snapshot.byteLength > SNAPSHOT_MAX_BYTES ||
        mutation.result.byteLength === 0 ||
        mutation.result.byteLength > (this.receive ? PLAINTEXT_MAX_BYTES : CIPHERTEXT_MAX_BYTES)
      ) {
        mutation.snapshot.fill(0);
        mutation.result.fill(0);
        throw fail("bound_exceeded");
      }
      const pending = {
        expectedGeneration: committed.metadata.generation,
        operationId,
        fingerprint,
        snapshot: mutation.snapshot,
        result: mutation.result,
        resultKind: this.receive ? "plaintext" : "ciphertext",
      };
      if (fault === "terminate_before_commit") {
        this.notify({ event: "prepared", operationId });
        await new Promise(() => {});
      }
      if (fault === "generation_conflict") pending.expectedGeneration -= 1;
      try {
        await this.commitPrepared(pending, fault);
      } catch (cause) {
        pending.result.fill(0);
        pending.snapshot.fill(0);
        if (cause?.code === "duplicate") {
          const reloaded = await this.readCommitted();
          const operation = reloaded.operations.find((record) => record.id === operationId);
          if (!operation || operation.fingerprint !== fingerprint) throw fail("operation_conflict");
          return this.committedResult(reloaded, operation);
        }
        throw cause;
      }
      if (fault === "ambiguous_after_commit" || fault === "terminate_after_commit") {
        this.notify({ event: "committed", operationId });
        if (fault === "terminate_after_commit") await new Promise(() => {});
        pending.result.fill(0);
        pending.snapshot.fill(0);
        throw fail("ambiguous_commit");
      }
      const output = new Uint8Array(pending.result);
      pending.result.fill(0);
      pending.snapshot.fill(0);
      return { kind: pending.resultKind, bytes: [...output], duplicate: false };
    });
  }

  async committedResult(committed, operation) {
    if (operation.resultKind === "ciphertext") {
      const record = committed.outbox.find((value) => value.id === operation.id);
      if (!record) throw fail("corrupt_state");
      return { kind: "ciphertext", bytes: [...bytes(record.ciphertext)], duplicate: true };
    }
    if (operation.resultKind === "plaintext") {
      const record = committed.pendingPlaintext.find((value) => value.id === operation.id);
      if (!record) throw fail("corrupt_state");
      const key = await this.loadDek(record.keyId, true);
      const plaintext = await unseal(
        key,
        record,
        canonical({ kind: "pending_plaintext", operationId: operation.id }),
      );
      return { kind: "plaintext", bytes: [...plaintext], duplicate: true };
    }
    if (operation.resultKind === "created") {
      if (!committed.creation) throw fail("corrupt_state");
      return {
        kind: "created",
        input: [...committed.creation.input],
        additionalInput: [...committed.creation.additionalInput],
        duplicate: true,
      };
    }
    throw fail("corrupt_state");
  }

  async ensureWrappingKey(create) {
    const { keyDb } = await this.databases();
    const transaction = keyDb.transaction(["wrapping_key_v1"], "readonly");
    const store = transaction.objectStore("wrapping_key_v1");
    let record = await readSingleton(store, validateWrappingKey, true);
    if (!record && create) {
      const key = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
        "wrapKey",
        "unwrapKey",
      ]);
      record = { id: "current", key };
      const write = this.strictTransaction(keyDb, ["wrapping_key_v1"]);
      write.objectStore("wrapping_key_v1").put(record);
      await transactionDone(write);
    }
    return validateWrappingKey(record).key;
  }

  async prepareDek() {
    const wrappingKey = await this.ensureWrappingKey(true);
    const dek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    const wrapped = new Uint8Array(
      await crypto.subtle.wrapKey("raw", dek, wrappingKey, "AES-KW"),
    );
    const id = hex(crypto.getRandomValues(new Uint8Array(16)));
    const { keyDb } = await this.databases();
    const transaction = this.strictTransaction(keyDb, ["wrapped_deks_v1"]);
    transaction.objectStore("wrapped_deks_v1").add({
      id,
      cryptoSessionId: this.sessionHex,
      status: "prepared",
      wrapped,
    });
    await transactionDone(transaction);
    return { id, dek };
  }

  async loadDek(id, allowPrepared) {
    const wrappingKey = await this.ensureWrappingKey(false);
    const { keyDb } = await this.databases();
    const transaction = keyDb.transaction(["wrapped_deks_v1"], "readonly");
    const rawRecord = await requestResult(transaction.objectStore("wrapped_deks_v1").get(id));
    let record;
    try {
      record = validateWrappedDek(rawRecord);
    } catch {
      throw fail("secure_store_unavailable");
    }
    if (
      record.cryptoSessionId !== this.sessionHex ||
      (record.status !== "active" &&
        record.status !== "retained" &&
        !(allowPrepared && record.status === "prepared"))
    ) {
      throw fail("secure_store_unavailable");
    }
    try {
      return await crypto.subtle.unwrapKey(
        "raw",
        bytes(record.wrapped),
        wrappingKey,
        "AES-KW",
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    } catch {
      throw fail("secure_store_unavailable");
    }
  }

  async activateDek(id, rollbackCounter, retainedKeyIds = new Set()) {
    const { keyDb } = await this.databases();
    const transaction = this.strictTransaction(keyDb, ["wrapped_deks_v1", "test_anchor_v1"]);
    const done = transactionDone(transaction);
    const keyStore = transaction.objectStore("wrapped_deks_v1");
    const anchorStore = transaction.objectStore("test_anchor_v1");
    const recordsPromise = readBounded(keyStore, validateWrappedDek);
    const anchorPromise = readSingleton(anchorStore, validateAnchor, true);
    try {
      const [records, rawAnchor] = await Promise.all([recordsPromise, anchorPromise]);
      const current = records.find((record) => record.id === id);
      if (!current || !["prepared", "active"].includes(current.status)) {
        throw fail("secure_store_unavailable");
      }
      for (const record of records) {
        if (record.id === id && record.status !== "active") {
          keyStore.put({ ...record, status: "active" });
        } else if (record.id !== id && retainedKeyIds.has(record.id)) {
          if (record.status !== "retained") keyStore.put({ ...record, status: "retained" });
        } else if (record.id !== id) {
          keyStore.delete(record.id);
        }
      }
      const anchor = rawAnchor
        ? validateAnchor(rawAnchor)
        : { id: "anchor", counter: 0, lossReported: false };
      if (anchor.counter > rollbackCounter) throw fail("rollback_detected");
      anchorStore.put({ ...anchor, counter: rollbackCounter });
      await done;
    } catch (cause) {
      try {
        transaction.abort();
      } catch {}
      await done.catch(() => {});
      throw cause instanceof PersistenceError ? cause : mapStorageError(cause, "rollback_detected");
    }
  }

  async removePrepared(id) {
    if (!this.keyDb) return;
    const transaction = this.strictTransaction(this.keyDb, ["wrapped_deks_v1"]);
    const store = transaction.objectStore("wrapped_deks_v1");
    const request = store.get(id);
    request.onsuccess = () => {
      try {
        if (request.result && validateWrappedDek(request.result).status === "prepared") store.delete(id);
      } catch {
        transaction.abort();
      }
    };
    await transactionDone(transaction).catch(() => {});
  }

  async commitPrepared(pending, fault) {
    const committed = await this.readRaw();
    const currentOperations = committed.operations ?? [];
    const currentOutbox = committed.outbox ?? [];
    const currentAccepted = committed.accepted ?? [];
    const currentPending = committed.pendingPlaintext ?? [];
    const currentCreation = committed.creation;
    if (currentOperations.length >= MAX_RECORDS) throw fail("bound_exceeded");
    const preparedKey = await this.prepareDek();
    const nextGeneration = pending.expectedGeneration + 1;
    const metadata = {
      id: "current",
      schemaVersion: 1,
      lifecycle: "ready",
      profileId: PROFILE_ID,
      profileRevision: PROFILE_REVISION,
      cryptoSessionId: this.sessionHex,
      generation: nextGeneration,
      rollbackCounter: nextGeneration,
      currentKeyId: preparedKey.id,
    };
    const operation = {
      id: pending.operationId,
      fingerprint: pending.fingerprint,
      generation: nextGeneration,
      resultKind: pending.resultKind,
    };
    const operations = [...currentOperations, operation];
    const outbox = [...currentOutbox];
    const accepted = [...currentAccepted];
    const pendingPlaintext = [...currentPending];
    let creation = currentCreation;
    if (pending.resultKind === "ciphertext") {
      outbox.push({ id: pending.operationId, ciphertext: new Uint8Array(pending.result) });
    } else if (pending.resultKind === "plaintext") {
      const sealedPlaintext = await seal(
        preparedKey.dek,
        pending.result,
        canonical({ kind: "pending_plaintext", operationId: pending.operationId }),
      );
      pendingPlaintext.push({
        id: pending.operationId,
        keyId: preparedKey.id,
        ...sealedPlaintext,
      });
      accepted.push({ id: pending.operationId, acknowledged: false });
    } else if (pending.resultKind === "created") {
      creation = pending.creation;
    } else {
      throw fail("corrupt_state");
    }
    const manifestDigest = await digest(
      manifestProjection(metadata, operations, outbox, accepted, pendingPlaintext, creation),
    );
    const statePlaintext = canonical({
      schemaVersion: 1,
      profileId: PROFILE_ID,
      profileRevision: PROFILE_REVISION,
      cryptoSessionId: this.sessionHex,
      generation: nextGeneration,
      rollbackCounter: nextGeneration,
      manifestDigest,
      endpointSnapshot: hex(pending.snapshot),
    });
    const sealedState = await seal(preparedKey.dek, statePlaintext, stateAad(metadata));
    const stateRecord = { id: "current", keyId: preparedKey.id, ...sealedState };
    const manifestRecord = { id: "current", digest: manifestDigest };

    try {
      await this.writeStateTransaction({
        expectedGeneration: pending.expectedGeneration,
        operation,
        metadata,
        stateRecord,
        manifestRecord,
        outboxRecord: outbox.find((record) => record.id === pending.operationId),
        acceptedRecord: accepted.find((record) => record.id === pending.operationId),
        pendingRecord: pendingPlaintext.find((record) => record.id === pending.operationId),
        creationRecord: pending.resultKind === "created" ? creation : undefined,
        fault,
      });
    } catch (cause) {
      await this.removePrepared(preparedKey.id);
      throw mapStorageError(cause);
    }
    if (fault === "observe_completion") {
      this.notify({ event: "transaction_complete", operationId: pending.operationId });
    }
    if (fault === "ambiguous_after_commit" || fault === "terminate_after_commit") return;
    await this.activateDek(
      preparedKey.id,
      nextGeneration,
      new Set(pendingPlaintext.map((record) => record.keyId)),
    );
  }

  writeStateTransaction(values) {
    const { stateDb } = this;
    if (!stateDb) return Promise.reject(fail("storage_unavailable"));
    return new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = this.strictTransaction(stateDb, STATE_STORES);
      } catch (cause) {
        reject(mapStorageError(cause));
        return;
      }
      let outcome;
      transaction.oncomplete = () => resolve(outcome);
      transaction.onabort = () =>
        reject(
          outcome === "generation_conflict" ||
            outcome === "operation_conflict" ||
            outcome === "duplicate"
            ? fail(outcome)
            : outcome instanceof Error
              ? outcome
              : transaction.error ?? fail("transaction_aborted"),
        );
      transaction.onerror = () => {};
      const metadataStore = transaction.objectStore("metadata_v1");
      const operationStore = transaction.objectStore("operations_v1");
      const metadataRequest = metadataStore.get("current");
      const operationRequest = operationStore.get(values.operation.id);
      let storedMetadata;
      metadataRequest.onsuccess = () => {
        storedMetadata = metadataRequest.result;
      };
      operationRequest.onsuccess = () => {
        const actualGeneration = storedMetadata?.generation ?? 0;
        if (
          actualGeneration !== values.expectedGeneration ||
          (storedMetadata &&
            (storedMetadata.profileId !== PROFILE_ID ||
              storedMetadata.profileRevision !== PROFILE_REVISION ||
              storedMetadata.cryptoSessionId !== this.sessionHex ||
              storedMetadata.rollbackCounter !== values.expectedGeneration))
        ) {
          outcome = "generation_conflict";
          transaction.abort();
          return;
        }
        if (operationRequest.result) {
          outcome =
            operationRequest.result.fingerprint === values.operation.fingerprint
              ? "duplicate"
              : "operation_conflict";
          transaction.abort();
          return;
        }
        if (values.fault === "abort_before_commit") {
          outcome = "transaction_aborted";
          transaction.abort();
          return;
        }
        try {
          if (values.fault === "quota") throw new DOMException("test quota", "QuotaExceededError");
          metadataStore.put(values.metadata);
          transaction.objectStore("sealed_state_v1").put(values.stateRecord);
          transaction.objectStore("manifest_v1").put(values.manifestRecord);
          operationStore.add(values.operation);
          if (values.outboxRecord) transaction.objectStore("outbox_v1").add(values.outboxRecord);
          if (values.acceptedRecord) {
            transaction.objectStore("accepted_messages_v1").add(values.acceptedRecord);
          }
          if (values.pendingRecord) {
            transaction.objectStore("pending_plaintext_v1").add(values.pendingRecord);
          }
          if (values.creationRecord) {
            transaction.objectStore("creation_v1").put(values.creationRecord);
          }
          outcome = "committed";
        } catch (cause) {
          outcome = cause;
          transaction.abort();
        }
      };
    });
  }

  async readRaw() {
    const { stateDb } = await this.databases();
    let transaction;
    try {
      transaction = stateDb.transaction(STATE_STORES, "readonly");
    } catch (cause) {
      throw mapStorageError(cause);
    }
    const done = transactionDone(transaction);
    const values = {
      metadata: readSingleton(
        transaction.objectStore("metadata_v1"),
        validateMetadata,
        true,
      ),
      state: readSingleton(
        transaction.objectStore("sealed_state_v1"),
        validateStateRecord,
        true,
      ),
      manifest: readSingleton(
        transaction.objectStore("manifest_v1"),
        validateManifestRecord,
        true,
      ),
      operations: readBounded(transaction.objectStore("operations_v1"), validateOperationRecord),
      outbox: readBounded(transaction.objectStore("outbox_v1"), validateOutboxRecord),
      accepted: readBounded(
        transaction.objectStore("accepted_messages_v1"),
        validateAcceptedRecord,
      ),
      pendingPlaintext: readBounded(
        transaction.objectStore("pending_plaintext_v1"),
        validatePendingRecord,
      ),
      creation: readSingleton(
        transaction.objectStore("creation_v1"),
        validateCreationRecord,
        true,
      ),
    };
    const entriesPromise = Promise.all(
      Object.entries(values).map(async ([name, promise]) => [name, await promise]),
    );
    const [, entries] = await Promise.all([done, entriesPromise]);
    return Object.fromEntries(entries);
  }

  async readCommitted() {
    const raw = await this.readRaw();
    if (!raw.metadata || !raw.state || !raw.manifest) {
      await this.recordStateLoss();
    }
    const metadata = raw.metadata;
    if (
      metadata.cryptoSessionId !== this.sessionHex ||
      metadata.rollbackCounter !== metadata.generation ||
      raw.state.keyId !== metadata.currentKeyId
    ) {
      throw fail("identity_mismatch");
    }
    if (
      raw.operations.length !== metadata.generation ||
      new Set(raw.operations.map((record) => record.generation)).size !== metadata.generation ||
      raw.operations.some(
        (record) => record.generation < 1 || record.generation > metadata.generation,
      )
    ) {
      throw fail("corrupt_state");
    }
    const creationOperation = raw.operations.find((record) => record.resultKind === "created");
    if (
      !creationOperation ||
      creationOperation.generation !== 1 ||
      creationOperation.id !== "00000000000000000000000000000001" ||
      !raw.creation ||
      raw.outbox.some(
        (record) =>
          raw.operations.find((operation) => operation.id === record.id)?.resultKind !== "ciphertext",
      ) ||
      raw.pendingPlaintext.some(
        (record) =>
          raw.operations.find((operation) => operation.id === record.id)?.resultKind !== "plaintext",
      ) ||
      raw.accepted.some(
        (record) =>
          raw.operations.find((operation) => operation.id === record.id)?.resultKind !== "plaintext",
      ) ||
      raw.operations.some(
        (operation) =>
          (operation.resultKind === "ciphertext" &&
            !raw.outbox.some((record) => record.id === operation.id)) ||
          (operation.resultKind === "plaintext" &&
            (!raw.pendingPlaintext.some((record) => record.id === operation.id) ||
              !raw.accepted.some((record) => record.id === operation.id))),
      )
    ) {
      throw fail("corrupt_state");
    }
    const dek = await this.loadDek(metadata.currentKeyId, true);
    const plaintext = await unseal(dek, raw.state, stateAad(metadata));
    let state;
    try {
      state = JSON.parse(textDecoder.decode(plaintext));
      exactObject(state, [
        "schemaVersion",
        "profileId",
        "profileRevision",
        "cryptoSessionId",
        "generation",
        "rollbackCounter",
        "manifestDigest",
        "endpointSnapshot",
      ]);
      if (
        typeof state.manifestDigest !== "string" ||
        !DIGEST_PATTERN.test(state.manifestDigest) ||
        typeof state.endpointSnapshot !== "string" ||
        state.endpointSnapshot.length === 0 ||
        state.endpointSnapshot.length > SNAPSHOT_MAX_BYTES * 2 ||
        state.endpointSnapshot.length % 2 !== 0 ||
        !/^[0-9a-f]+$/u.test(state.endpointSnapshot)
      ) {
        throw fail("corrupt_state");
      }
    } catch {
      throw fail("corrupt_state");
    } finally {
      plaintext.fill(0);
    }
    const expectedManifest = await digest(
      manifestProjection(
        metadata,
        raw.operations,
        raw.outbox,
        raw.accepted,
        raw.pendingPlaintext,
        raw.creation,
      ),
    );
    if (
      raw.manifest.digest !== expectedManifest ||
      state.manifestDigest !== expectedManifest ||
      state.schemaVersion !== 1 ||
      state.profileId !== PROFILE_ID ||
      state.profileRevision !== PROFILE_REVISION ||
      state.cryptoSessionId !== this.sessionHex ||
      state.generation !== metadata.generation ||
      state.rollbackCounter !== metadata.rollbackCounter
    ) {
      throw fail("corrupt_state");
    }
    await this.reconcileAnchor(metadata);
    await this.activateDek(
      metadata.currentKeyId,
      metadata.rollbackCounter,
      new Set(raw.pendingPlaintext.map((record) => record.keyId)),
    );
    for (const record of raw.pendingPlaintext) {
      const pendingKey = await this.loadDek(record.keyId, false);
      const pendingPlaintext = await unseal(
        pendingKey,
        record,
        canonical({ kind: "pending_plaintext", operationId: record.id }),
      );
      if (pendingPlaintext.byteLength > PLAINTEXT_MAX_BYTES) throw fail("corrupt_state");
      pendingPlaintext.fill(0);
    }
    return { ...raw, snapshot: fromHex(state.endpointSnapshot) };
  }

  async reconcileAnchor(metadata) {
    const { keyDb } = await this.databases();
    const transaction = keyDb.transaction(["test_anchor_v1"], "readonly");
    let anchor;
    try {
      anchor = await readSingleton(transaction.objectStore("test_anchor_v1"), validateAnchor, true);
    } catch {
      throw fail("secure_store_unavailable");
    }
    if (anchor?.counter > metadata.rollbackCounter) throw fail("rollback_detected");
  }

  async recordStateLoss() {
    const { keyDb } = await this.databases();
    const transaction = this.strictTransaction(keyDb, ["test_anchor_v1"]);
    const done = transactionDone(transaction);
    const store = transaction.objectStore("test_anchor_v1");
    let repeated = false;
    try {
      const current = await readSingleton(store, validateAnchor, true);
      const anchor = current ?? { id: "anchor", counter: 0, lossReported: false };
      repeated = anchor.lossReported === true;
      store.put({ ...anchor, lossReported: true });
      await done;
    } catch (cause) {
      try {
        transaction.abort();
      } catch {}
      await done.catch(() => {});
      throw cause instanceof PersistenceError ? cause : fail("secure_store_unavailable");
    }
    throw fail(repeated ? "re_pair_required" : "state_loss");
  }

  async tamper(kind) {
    return this.run(async () => {
      const { stateDb } = await this.databases();
      if (kind === "forced_close") {
        stateDb.close();
        this.stateDb = undefined;
        throw fail("storage_unavailable");
      }
      const stores =
        kind === "manifest"
          ? ["manifest_v1"]
          : kind === "state"
            ? ["sealed_state_v1"]
            : kind === "missing"
              ? ["sealed_state_v1", "manifest_v1"]
              : ["metadata_v1", "operations_v1", "pending_plaintext_v1"];
      const transaction = this.strictTransaction(stateDb, stores);
      if (kind === "manifest") {
        const store = transaction.objectStore("manifest_v1");
        const request = store.get("current");
        request.onsuccess = () => store.put({ ...request.result, digest: "00".repeat(48) });
      } else if (kind === "state") {
        const store = transaction.objectStore("sealed_state_v1");
        const request = store.get("current");
        request.onsuccess = () => {
          const ciphertext = new Uint8Array(request.result.ciphertext);
          ciphertext[0] ^= 1;
          store.put({ ...request.result, ciphertext });
        };
      } else if (kind === "missing") {
        transaction.objectStore("sealed_state_v1").delete("current");
        transaction.objectStore("manifest_v1").delete("current");
      } else if (kind === "schema") {
        const store = transaction.objectStore("metadata_v1");
        const request = store.get("current");
        request.onsuccess = () => store.put({ ...request.result, schemaVersion: 2 });
      } else if (kind === "rollback") {
        transaction.abort();
        const keyTransaction = this.strictTransaction(this.keyDb, ["test_anchor_v1"]);
        const keyStore = keyTransaction.objectStore("test_anchor_v1");
        const request = keyStore.get("anchor");
        request.onsuccess = () => {
          const anchor = validateAnchor(request.result);
          keyStore.put({ ...anchor, counter: anchor.counter + 1 });
        };
        await transactionDone(keyTransaction);
        return;
      } else if (kind === "malformed") {
        const store = transaction.objectStore("metadata_v1");
        const request = store.get("current");
        request.onsuccess = () => store.put({ ...request.result, generation: "not-a-counter" });
      } else if (kind === "unexpected") {
        const store = transaction.objectStore("operations_v1");
        const request = store.get("00000000000000000000000000000001");
        request.onsuccess = () => store.put({ ...request.result, unexpected: true });
      } else if (kind === "cyclic") {
        const record = {
          id: "ffffffffffffffffffffffffffffffff",
          fingerprint: "00".repeat(48),
          generation: 1,
          resultKind: "ciphertext",
        };
        record.self = record;
        transaction.objectStore("operations_v1").put(record);
      } else if (kind === "oversized") {
        transaction.objectStore("pending_plaintext_v1").put({
          id: "ffffffffffffffffffffffffffffffff",
          keyId: "00".repeat(16),
          iv: new Uint8Array(12),
          ciphertext: new Uint8Array(PLAINTEXT_MAX_BYTES + 17),
        });
      } else if (kind === "excessive") {
        const store = transaction.objectStore("operations_v1");
        for (let index = 0; index <= MAX_RECORDS; index += 1) {
          store.put({
            id: (index + 0x1000).toString(16).padStart(32, "0"),
            fingerprint: "00".repeat(48),
            generation: 1,
            resultKind: "ciphertext",
          });
        }
      } else {
        transaction.abort();
        throw fail("invalid_argument");
      }
      await transactionDone(transaction);
    });
  }

  async callbackException() {
    this.rejectLock?.(new Error("test callback exception"));
    await this.lockRequest;
    throw fail("lock_lost");
  }

  async close() {
    if (this.closed) return;
    this.closing = true;
    this.closed = true;
    this.stateDb?.close();
    this.keyDb?.close();
    this.stateDb = undefined;
    this.keyDb = undefined;
    this.releaseLock?.();
    await this.lockRequest;
  }
}

export async function deleteTestDatabases(sessionId) {
  const sessionHex = hex(sessionId);
  for (const name of [`axl-e2ee-state-v1:${sessionHex}`, `axl-e2ee-keys-v1:${sessionHex}`]) {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(mapStorageError(request.error));
      request.onblocked = () => reject(fail("storage_unavailable"));
    });
  }
}

export async function createNewerStateDatabase(sessionId) {
  const name = `axl-e2ee-state-v1:${hex(sessionId)}`;
  await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, STATE_VERSION + 1);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(mapStorageError(request.error));
    request.onblocked = () => reject(fail("storage_unavailable"));
  });
}

export async function schemaUpgradeEvidence(sessionId) {
  const sessionHex = hex(sessionId);
  const name = `axl-e2ee-upgrade-v1:${sessionHex}`;
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
  const old = await openDatabase(name, 1, ["old_v1"], false);
  let blocked = false;
  const blockedRequest = indexedDB.open(name, 2);
  blockedRequest.onblocked = () => {
    blocked = true;
    old.close();
  };
  const upgraded = await requestResult(blockedRequest);
  upgraded.close();

  let failed = false;
  await new Promise((resolve) => {
    const request = indexedDB.open(name, 3);
    request.onupgradeneeded = () => request.transaction.abort();
    request.onerror = () => {
      failed = true;
      resolve();
    };
  });
  const preserved = await requestResult(indexedDB.open(name, 2));
  const version = preserved.version;
  preserved.close();
  await requestResult(indexedDB.deleteDatabase(name));
  return { blocked, failed, preservedVersion: version };
}
