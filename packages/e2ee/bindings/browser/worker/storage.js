// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

import {
  BrowserTransition,
  inspect_committed_transition as inspectCommittedTransition,
} from "../wasm/axl_e2ee_browser.js";

const DATABASE_VERSION = 2;
const MAX_REQUEST_BYTES = 1_024;
const MAX_RECORD_BYTES = 16 * 1024 * 1024 + 65_497 + 4_096;
const WRAPPED_KEY_BYTES = 40;
const ZERO_HASH = "0".repeat(96);
const PROFILE_ID = "axl-e2ee-mls-pq-v1";
const PROFILE_REVISION = 1;
const STORES = Object.freeze({
  metadata: "metadata_v2",
  wrapping: "wrapping_key_v2",
  keys: "wrapped_state_keys_v2",
  states: "sealed_transitions_v2",
  operations: "witness_operations_v2",
});
const LIFECYCLES = Object.freeze(["ready", "quarantined", "revoked"]);
const KEY_LIFECYCLES = Object.freeze(["prepared", "active"]);
const DISPOSITIONS = Object.freeze(["pending", "completed"]);

function failure(code) {
  return new Error(`AXL_E2EE:${code}`);
}

function bytes(value, size, maximum = size) {
  if (!(value instanceof Uint8Array) || value.byteLength < size || value.byteLength > maximum) {
    throw failure(value instanceof Uint8Array ? "bound_exceeded" : "invalid_argument");
  }
  return new Uint8Array(value);
}

function fixedBytes(value, size) {
  return bytes(value, size, size);
}

function hex(value) {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value) {
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

function isHex(value, length) {
  if (typeof value !== "string" || value.length !== length) return false;
  for (const character of value) {
    if (!"0123456789abcdef".includes(character)) return false;
  }
  return true;
}

function isCounter(value) {
  return typeof value === "bigint" && value >= 0n && value <= 0xffff_ffff_ffff_ffffn;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(storageFailure(request.error)), { once: true });
  });
}

function transactionResult(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(storageFailure(transaction.error)), {
      once: true,
    });
    transaction.addEventListener("error", () => reject(storageFailure(transaction.error)), {
      once: true,
    });
  });
}

function openRequestResult(request, allowCreate) {
  return new Promise((resolve, reject) => {
    let upgraded = false;
    let rejected;
    request.addEventListener("upgradeneeded", (event) => {
      upgraded = true;
      // Only a brand-new database is created. A version 1 store has no witness commitment or
      // registration proof, and an unknown newer store is not readable here. Both abort the
      // upgrade transaction; the existing database is never deleted or rewritten.
      if (!allowCreate || event.oldVersion !== 0 || event.newVersion !== DATABASE_VERSION) {
        rejected = failure(event.oldVersion === 0 ? "state_loss" : "unsupported_schema");
        request.transaction?.abort();
        return;
      }
      const database = request.result;
      for (const store of Object.values(STORES)) database.createObjectStore(store);
    });
    request.addEventListener(
      "success",
      () => {
        if (!allowCreate && upgraded) {
          request.result.close();
          reject(failure("state_loss"));
          return;
        }
        resolve(request.result);
      },
      { once: true },
    );
    request.addEventListener(
      "error",
      () => {
        if (rejected) {
          reject(rejected);
          return;
        }
        const name = request.error?.name;
        reject(
          name === "VersionError"
            ? failure("unsupported_schema")
            : (request.error ?? failure(upgraded ? "state_loss" : "storage_unavailable")),
        );
      },
      { once: true },
    );
    request.addEventListener("blocked", () => reject(failure("lifecycle_busy")), { once: true });
  });
}

function exactRecord(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...names].sort();
  return actual.length === expected.length && actual.every((name, index) => name === expected[index]);
}

function validateMetadata(value, sessionHex) {
  if (
    !exactRecord(value, [
      "confirmedCommitment",
      "confirmedCounter",
      "currentKeyId",
      "generation",
      "lifecycle",
      "pendingOperationId",
      "previousCertificateHash",
      "profileId",
      "profileRevision",
      "session",
      "version",
    ]) ||
    value.version !== DATABASE_VERSION ||
    value.profileId !== PROFILE_ID ||
    value.profileRevision !== PROFILE_REVISION ||
    value.session !== sessionHex ||
    !LIFECYCLES.includes(value.lifecycle) ||
    !isCounter(value.generation) ||
    !isCounter(value.confirmedCounter) ||
    !isHex(value.confirmedCommitment, 96) ||
    !isHex(value.previousCertificateHash, 96) ||
    !(value.currentKeyId === null || isHex(value.currentKeyId, 32)) ||
    !(value.pendingOperationId === null || isHex(value.pendingOperationId, 32)) ||
    (value.confirmedCounter === 0n) !== (value.confirmedCommitment === ZERO_HASH) ||
    (value.currentKeyId === null) !== (value.generation === 0n)
  ) {
    throw failure("corrupt_state");
  }
  return value;
}

function validateOperation(value, operationHex) {
  if (
    !exactRecord(value, [
      "confirmedCommitment",
      "confirmedCounter",
      "counter",
      "disposition",
      "fingerprint",
      "generation",
      "keyId",
      "obsoleteKeyId",
      "operationId",
      "request",
      "requestHash",
    ]) ||
    value.operationId !== operationHex ||
    !isHex(value.fingerprint, 96) ||
    !isCounter(value.generation) ||
    !isCounter(value.counter) ||
    value.counter === 0n ||
    !isCounter(value.confirmedCounter) ||
    value.confirmedCounter + 1n !== value.counter ||
    !isHex(value.confirmedCommitment, 96) ||
    !isHex(value.keyId, 32) ||
    !(value.obsoleteKeyId === null || isHex(value.obsoleteKeyId, 32)) ||
    (value.obsoleteKeyId === null) !== (value.counter === 1n) ||
    !(value.request instanceof Uint8Array) ||
    value.request.byteLength === 0 ||
    value.request.byteLength > MAX_REQUEST_BYTES ||
    !(value.requestHash instanceof Uint8Array) ||
    value.requestHash.byteLength !== 48 ||
    !DISPOSITIONS.includes(value.disposition)
  ) {
    throw failure("corrupt_state");
  }
  return value;
}

function validateKeyRecord(value, keyIdHex) {
  if (
    !exactRecord(value, ["keyId", "lifecycle", "wrappedKey"]) ||
    value.keyId !== keyIdHex ||
    !KEY_LIFECYCLES.includes(value.lifecycle) ||
    !(value.wrappedKey instanceof Uint8Array) ||
    value.wrappedKey.byteLength !== WRAPPED_KEY_BYTES
  ) {
    throw failure("key_record_missing");
  }
  return value;
}

function validateTransitionRecord(value, operationHex, keyIdHex) {
  if (
    !exactRecord(value, ["generation", "keyId", "operationId", "record"]) ||
    value.operationId !== operationHex ||
    value.keyId !== keyIdHex ||
    !isCounter(value.generation) ||
    !(value.record instanceof Uint8Array) ||
    value.record.byteLength === 0 ||
    value.record.byteLength > MAX_RECORD_BYTES
  ) {
    throw failure("corrupt_state");
  }
  return value;
}

function validateWrappingKey(value) {
  if (
    !(value instanceof CryptoKey) ||
    value.extractable !== false ||
    value.algorithm?.name !== "AES-KW" ||
    value.algorithm?.length !== 256
  ) {
    throw failure("key_record_missing");
  }
  return value;
}

/** Immutable view of the metadata row with byte fields as bytes. */
function metadataView(metadata) {
  return Object.freeze({
    lifecycle: metadata.lifecycle,
    generation: metadata.generation,
    confirmedCounter: metadata.confirmedCounter,
    confirmedCommitment: fromHex(metadata.confirmedCommitment),
    previousCertificateHash: fromHex(metadata.previousCertificateHash),
    currentKeyId: metadata.currentKeyId === null ? null : fromHex(metadata.currentKeyId),
    pendingOperationId:
      metadata.pendingOperationId === null ? null : fromHex(metadata.pendingOperationId),
  });
}

/** Immutable view of the one operation row. */
function operationView(operation) {
  return Object.freeze({
    operationId: fromHex(operation.operationId),
    fingerprint: fromHex(operation.fingerprint),
    disposition: operation.disposition,
    counter: operation.counter,
    generation: operation.generation,
    confirmedCounter: operation.confirmedCounter,
    confirmedCommitment: fromHex(operation.confirmedCommitment),
    witnessRequest: new Uint8Array(operation.request),
    requestHash: new Uint8Array(operation.requestHash),
  });
}

/** Abort a transaction that may already have finished; a second abort must not escape a handler. */
function abortQuietly(transaction) {
  try {
    transaction.abort();
  } catch {
    // Already aborted or completed. The transaction outcome is reported by transactionResult.
  }
}

/** Map any non-Axl failure from IndexedDB or WebCrypto to a typed storage outcome. */
function storageFailure(cause) {
  if (cause instanceof Error && cause.message.startsWith("AXL_E2EE:")) return cause;
  return failure("storage_unavailable");
}

function strictTransaction(database, storeNames) {
  const transaction = database.transaction(storeNames, "readwrite", { durability: "strict" });
  if (transaction.durability !== "strict") {
    abortQuietly(transaction);
    throw failure("strict_durability_unavailable");
  }
  return transaction;
}

/**
 * Worker-private production persistence for one endpoint lineage.
 *
 * This class moves bytes between IndexedDB, WebCrypto, and the Rust endpoint. It verifies nothing
 * cryptographic itself: the endpoint owns lineage, commitments, requests, certificates, and the
 * output gate. The page protocol never receives this object, a CryptoKey, a transition, a
 * transaction, or a plaintext buffer.
 *
 * Key lifecycle: the successor key record is written `prepared` in the commit transaction, marked
 * `active` only after that transaction completes, and the obsolete key is deleted and observed
 * absent in the completion transaction. The endpoint releases the exact result only after this
 * class reports that erasure.
 */
export class ProductionBrowserStore {
  #session;
  #sessionHex;
  #databaseName;
  #database;
  #lockRelease;
  #lockTask;
  #closed = false;
  #onLost;
  /** Terminal lifecycle whose persistence failed. Set once; fails every later call closed. */
  #unpersistedLifecycle;

  /**
   * @param sessionId the 16-byte crypto session identifier
   * @param onLost called once if the lifetime Web Lock is lost while this store is open
   */
  constructor(sessionId, onLost) {
    this.#session = fixedBytes(sessionId, 16);
    this.#sessionHex = hex(this.#session);
    this.#databaseName = `axl-e2ee-production-v1:${this.#sessionHex}`;
    if (onLost !== undefined && typeof onLost !== "function") throw failure("invalid_argument");
    this.#onLost = onLost;
  }

  get sessionId() {
    return new Uint8Array(this.#session);
  }

  async #acquireLock() {
    if (this.#lockTask) return this.#lockTask;
    if (!globalThis.navigator?.locks || !globalThis.indexedDB || !globalThis.crypto?.subtle) {
      throw failure("storage_unavailable");
    }
    let acquired;
    const acquiredPromise = new Promise((resolve) => {
      acquired = resolve;
    });
    let release;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    this.#lockTask = globalThis.navigator.locks.request(
      `axl-e2ee-v1:${this.#sessionHex}`,
      { mode: "exclusive", ifAvailable: true, steal: false },
      async (lock) => {
        acquired(Boolean(lock));
        if (lock) await hold;
      },
    );
    if (!(await acquiredPromise)) {
      release();
      await this.#lockTask;
      this.#lockTask = undefined;
      throw failure("lifecycle_busy");
    }
    this.#lockRelease = release;
    this.#lockTask.catch(() => {
      this.#closed = true;
      this.#database?.close();
      this.#database = undefined;
      this.#onLost?.();
    });
  }

  async create() {
    await this.#acquireLock();
    if (this.#closed) throw failure("endpoint_closed");
    let database;
    try {
      database = await openRequestResult(
        globalThis.indexedDB.open(this.#databaseName, DATABASE_VERSION),
        true,
      );
      const wrappingKey = await globalThis.crypto.subtle.generateKey(
        { name: "AES-KW", length: 256 },
        false,
        ["wrapKey", "unwrapKey"],
      );
      const transaction = strictTransaction(database, [STORES.metadata, STORES.wrapping]);
      const metadataStore = transaction.objectStore(STORES.metadata);
      let creationFailure;
      const metadataWrite = metadataStore.add(
        {
          version: DATABASE_VERSION,
          profileId: PROFILE_ID,
          profileRevision: PROFILE_REVISION,
          session: this.#sessionHex,
          lifecycle: "ready",
          generation: 0n,
          confirmedCounter: 0n,
          confirmedCommitment: ZERO_HASH,
          previousCertificateHash: ZERO_HASH,
          currentKeyId: null,
          pendingOperationId: null,
        },
        "current",
      );
      const keyWrite = transaction.objectStore(STORES.wrapping).add(wrappingKey, "origin");
      for (const write of [metadataWrite, keyWrite]) {
        write.addEventListener(
          "error",
          () => {
            creationFailure =
              write.error?.name === "ConstraintError"
                ? failure("already_exists")
                : (write.error ?? failure("storage_unavailable"));
          },
          { once: true },
        );
      }
      try {
        await transactionResult(transaction);
      } catch (cause) {
        throw storageFailure(creationFailure ?? cause);
      }
      this.#database = database;
      return Object.freeze({ generation: 0n });
    } catch (cause) {
      database?.close();
      await this.#releaseLock();
      if (cause?.name === "ConstraintError") throw failure("already_exists");
      throw cause;
    }
  }

  async open() {
    await this.#acquireLock();
    if (this.#closed) throw failure("endpoint_closed");
    let database;
    try {
      database = await openRequestResult(globalThis.indexedDB.open(this.#databaseName), false);
      if (database.version !== DATABASE_VERSION) throw failure("unsupported_schema");
      const required = new Set(Object.values(STORES));
      for (const name of database.objectStoreNames) required.delete(name);
      if (required.size !== 0) throw failure("corrupt_state");
      const transaction = database.transaction([STORES.metadata, STORES.wrapping], "readonly");
      const metadata = validateMetadata(
        await requestResult(transaction.objectStore(STORES.metadata).get("current")),
        this.#sessionHex,
      );
      validateWrappingKey(await requestResult(transaction.objectStore(STORES.wrapping).get("origin")));
      await transactionResult(transaction);
      this.#database = database;
      // Restart recovery step: the key named by the committed record is activated or verified
      // before the endpoint may decrypt anything. The record itself is authenticated by the Rust
      // endpoint through unsealCurrent().
      const pending = await this.#pendingOperation(metadata);
      if (pending) await this.#ensureActivated(pending);
      return metadataView(metadata);
    } catch (cause) {
      database?.close();
      this.#database = undefined;
      await this.#releaseLock();
      throw cause;
    }
  }

  /** The metadata row. */
  async metadata() {
    return metadataView(await this.#metadata());
  }

  /** The one operation row, or `null` before the first commit. */
  async currentOperation() {
    const metadata = await this.#metadata();
    if (metadata.generation === 0n) return null;
    const transactionRecord = await this.#currentRecord();
    const operation = await this.#readOperation(transactionRecord.operationId);
    if (metadata.pendingOperationId !== null) {
      if (operation.disposition !== "pending" || metadata.pendingOperationId !== operation.operationId) {
        throw failure("corrupt_state");
      }
    } else if (operation.disposition !== "completed") {
      throw failure("corrupt_state");
    }
    if (metadata.currentKeyId !== operation.keyId || metadata.generation !== operation.generation) {
      throw failure("corrupt_state");
    }
    return operationView(operation);
  }

  /**
   * Decrypt the one committed record for the endpoint to authenticate. The key named by the
   * record's clear header is activated or verified first; plaintexts are handed over exactly once
   * and the caller erases them.
   */
  async unsealCurrent() {
    const metadata = await this.#metadata();
    this.#requireLive(metadata);
    if (metadata.generation === 0n) throw failure("state_loss");
    const transitionRecord = await this.#currentRecord();
    const operation = await this.#readOperation(transitionRecord.operationId);
    if (metadata.currentKeyId !== operation.keyId || metadata.generation !== operation.generation) {
      throw failure("corrupt_state");
    }
    await this.#ensureActivated(operation);
    const record = new Uint8Array(transitionRecord.record);
    const envelopes = inspectCommittedTransition(new Uint8Array(record));
    try {
      if (
        hex(envelopes.operation_id()) !== operation.operationId ||
        hex(envelopes.current_key_id()) !== operation.keyId ||
        envelopes.counter() !== operation.counter ||
        envelopes.generation() !== operation.generation
      ) {
        throw failure("corrupt_state");
      }
      const stateKey = await this.#unwrapStateKey(operation.keyId);
      const decrypt = (nonce, additionalData, sealed) =>
        globalThis.crypto.subtle
          .decrypt({ name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 }, stateKey, sealed)
          .then((plaintext) => new Uint8Array(plaintext));
      const innerPlaintext = await decrypt(
        envelopes.inner_nonce(),
        envelopes.inner_aad(),
        envelopes.sealed_inner(),
      );
      const outerPlaintext = await decrypt(
        envelopes.outer_nonce(),
        envelopes.outer_aad(),
        envelopes.sealed_outer(),
      );
      return {
        record,
        innerPlaintext,
        outerPlaintext,
        operation: operationView(operation),
        metadata: metadataView(metadata),
      };
    } catch (cause) {
      if (cause?.name === "OperationError") throw failure("corrupt_state");
      throw cause;
    } finally {
      envelopes.free();
    }
  }

  /**
   * Seal and durably commit one Rust-finalized transition, then activate its key. Returns the
   * committed transition for the endpoint to adopt. Any rejection after the strict transaction
   * started means the durable outcome is unknown to the caller.
   */
  async commit(transition) {
    if (!this.#database || this.#closed) throw failure("endpoint_closed");
    if (!(transition instanceof BrowserTransition)) throw failure("invalid_argument");
    const operationHex = hex(fixedBytes(transition.operation_id(), 16));
    const fingerprintHex = hex(fixedBytes(transition.fingerprint(), 48));
    const keyIdHex = hex(fixedBytes(transition.current_key_id(), 16));
    const counter = transition.counter();
    const generation = transition.generation();
    const predecessorHex = hex(fixedBytes(transition.predecessor_commitment(), 48));
    let wrappedKey;
    let innerPayload;
    let sealedInner;
    let outerPlaintext;
    let sealedOuter;
    let committed;
    try {
      const metadata = await this.#metadata();
      this.#requireLive(metadata);
      if (metadata.pendingOperationId !== null) throw failure("witness_unavailable");
      if (
        metadata.generation + 1n !== generation ||
        metadata.confirmedCounter + 1n !== counter ||
        metadata.confirmedCommitment !== predecessorHex
      ) {
        throw failure("conflict");
      }
      const wrappingKey = await this.#wrappingKey();
      const stateKey = await globalThis.crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt"],
      );
      wrappedKey = new Uint8Array(
        await globalThis.crypto.subtle.wrapKey("raw", stateKey, wrappingKey, "AES-KW"),
      );
      innerPayload = transition.take_inner_payload();
      sealedInner = new Uint8Array(
        await globalThis.crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: transition.inner_nonce(),
            additionalData: transition.inner_aad(),
            tagLength: 128,
          },
          stateKey,
          innerPayload,
        ),
      );
      innerPayload.fill(0);
      outerPlaintext = transition.finalize(sealedInner);
      sealedOuter = new Uint8Array(
        await globalThis.crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: transition.outer_nonce(),
            additionalData: transition.outer_aad(),
            tagLength: 128,
          },
          stateKey,
          outerPlaintext,
        ),
      );
      outerPlaintext.fill(0);
      committed = transition.complete(sealedOuter);
      const record = committed.committed_record();
      const request = committed.witness_request();
      const requestHash = committed.request_hash();
      if (request.byteLength === 0 || request.byteLength > MAX_REQUEST_BYTES) {
        throw failure("bound_exceeded");
      }
      const operationRecord = {
        operationId: operationHex,
        fingerprint: fingerprintHex,
        generation,
        counter,
        confirmedCounter: metadata.confirmedCounter,
        confirmedCommitment: metadata.confirmedCommitment,
        keyId: keyIdHex,
        obsoleteKeyId: metadata.currentKeyId,
        request,
        requestHash,
        disposition: "pending",
      };
      await this.#writeCommit(
        metadata,
        operationRecord,
        { keyId: keyIdHex, lifecycle: "prepared", wrappedKey: new Uint8Array(wrappedKey) },
        { operationId: operationHex, generation, keyId: keyIdHex, record },
      );
      // Durable local commit precedes successor-key activation, which precedes request exposure.
      await this.#ensureActivated(operationRecord);
      const adopted = committed;
      committed = undefined;
      return adopted;
    } finally {
      for (const value of [wrappedKey, innerPayload, sealedInner, outerPlaintext, sealedOuter]) {
        value?.fill(0);
      }
      committed?.free();
      transition.free();
    }
  }

  /**
   * Completion after the endpoint verified the certificate: recheck the successor key is active,
   * delete the obsolete key and observe it absent, mark the operation completed, and advance the
   * confirmed head, all in one strict transaction.
   */
  async complete(operationId, head) {
    if (!this.#database || this.#closed) throw failure("endpoint_closed");
    const operationHex = hex(fixedBytes(operationId, 16));
    const metadata = await this.#metadata();
    this.#requireLive(metadata);
    if (metadata.pendingOperationId !== operationHex) throw failure("not_found");
    const operation = await this.#readOperation(operationHex);
    if (operation.disposition !== "pending") throw failure("corrupt_state");
    const confirmedCounter = head?.confirmedCounter;
    if (!isCounter(confirmedCounter) || confirmedCounter !== operation.counter) {
      throw failure("invalid_argument");
    }
    await this.#writeCompletion(metadata, operation, {
      confirmedCounter,
      confirmedCommitment: hex(fixedBytes(head.confirmedCommitment, 48)),
      previousCertificateHash: hex(fixedBytes(head.previousCertificateHash, 48)),
    });
  }

  /** Persist a terminal lifecycle decided by the endpoint. Fails closed if the write fails. */
  async quarantine(lifecycle) {
    if (!this.#database || this.#closed) throw failure("endpoint_closed");
    if (lifecycle !== "quarantined" && lifecycle !== "revoked") throw failure("invalid_argument");
    await this.#quarantine(lifecycle);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#database?.close();
    this.#database = undefined;
    this.#session.fill(0);
    await this.#releaseLock();
  }

  /** Release the lifetime Web Lock. A failed create or open owns no endpoint and must not hold it. */
  async #releaseLock() {
    this.#lockRelease?.();
    this.#lockRelease = undefined;
    try {
      await this.#lockTask;
    } catch {
      // The lock callback already poisoned this store.
    } finally {
      this.#lockTask = undefined;
    }
  }

  #requireLive(metadata) {
    this.#requirePersistedLifecycle();
    if (metadata.lifecycle === "quarantined") throw failure("rollback_detected");
    if (metadata.lifecycle === "revoked") throw failure("endpoint_revoked");
  }

  async #metadata() {
    if (!this.#database || this.#closed) throw failure("endpoint_closed");
    const transaction = this.#database.transaction(STORES.metadata, "readonly");
    const value = await requestResult(transaction.objectStore(STORES.metadata).get("current"));
    await transactionResult(transaction);
    return validateMetadata(value, this.#sessionHex);
  }

  async #pendingOperation(metadata) {
    if (metadata.pendingOperationId === null) return undefined;
    const operation = await this.#readOperation(metadata.pendingOperationId);
    if (operation.disposition !== "pending" || metadata.currentKeyId !== operation.keyId) {
      throw failure("corrupt_state");
    }
    // The committed record's clear header, not the metadata row, names the key to activate.
    const transitionRecord = await this.#transitionRecord(operation);
    const envelopes = inspectCommittedTransition(new Uint8Array(transitionRecord.record));
    try {
      if (
        hex(envelopes.operation_id()) !== operation.operationId ||
        hex(envelopes.current_key_id()) !== operation.keyId ||
        envelopes.counter() !== operation.counter
      ) {
        throw failure("corrupt_state");
      }
    } finally {
      envelopes.free();
    }
    return operation;
  }

  async #currentRecord() {
    if (!this.#database || this.#closed) throw failure("endpoint_closed");
    const transaction = this.#database.transaction(STORES.states, "readonly");
    const value = await requestResult(transaction.objectStore(STORES.states).get("current"));
    await transactionResult(transaction);
    if (value === undefined) throw failure("state_loss");
    if (!exactRecord(value, ["generation", "keyId", "operationId", "record"]) || !isHex(value.operationId, 32)) {
      throw failure("corrupt_state");
    }
    return validateTransitionRecord(value, value.operationId, value.keyId);
  }

  async #readOperation(operationHex) {
    if (!this.#database || this.#closed) throw failure("endpoint_closed");
    const transaction = this.#database.transaction(STORES.operations, "readonly");
    const value = await requestResult(transaction.objectStore(STORES.operations).get(operationHex));
    await transactionResult(transaction);
    if (value === undefined) throw failure("not_found");
    return validateOperation(value, operationHex);
  }

  async #transitionRecord(operation) {
    const transaction = this.#database.transaction(STORES.states, "readonly");
    const value = await requestResult(transaction.objectStore(STORES.states).get("current"));
    await transactionResult(transaction);
    return validateTransitionRecord(value, operation.operationId, operation.keyId);
  }

  async #wrappingKey() {
    const transaction = this.#database.transaction(STORES.wrapping, "readonly");
    const value = await requestResult(transaction.objectStore(STORES.wrapping).get("origin"));
    await transactionResult(transaction);
    return validateWrappingKey(value);
  }

  async #keyRecord(keyIdHex) {
    const transaction = this.#database.transaction(STORES.keys, "readonly");
    const value = await requestResult(transaction.objectStore(STORES.keys).get(keyIdHex));
    await transactionResult(transaction);
    return validateKeyRecord(value, keyIdHex);
  }

  /** Unwrap the state key non-extractable and decrypt-only. It never leaves this worker. */
  async #unwrapStateKey(keyIdHex) {
    const wrappingKey = await this.#wrappingKey();
    const keyRecord = await this.#keyRecord(keyIdHex);
    if (keyRecord.lifecycle !== "active") throw failure("key_record_missing");
    const wrapped = new Uint8Array(keyRecord.wrappedKey);
    try {
      return await globalThis.crypto.subtle.unwrapKey(
        "raw",
        wrapped,
        wrappingKey,
        "AES-KW",
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"],
      );
    } finally {
      wrapped.fill(0);
    }
  }

  /**
   * Activate the successor key named by the committed operation, or verify that it is active.
   * Idempotent, so an interrupted first activation is finished by the next open, pending, or
   * continuation call before anything is exposed.
   */
  async #ensureActivated(operation) {
    const keyRecord = await this.#keyRecord(operation.keyId);
    if (keyRecord.lifecycle === "active") return;
    const transaction = strictTransaction(this.#database, STORES.keys);
    const store = transaction.objectStore(STORES.keys);
    const current = store.get(operation.keyId);
    let activationFailure;
    current.addEventListener(
      "success",
      () => {
        try {
          const value = validateKeyRecord(current.result, operation.keyId);
          if (value.lifecycle !== "active") store.put({ ...value, lifecycle: "active" }, operation.keyId);
        } catch (cause) {
          activationFailure = cause;
          abortQuietly(transaction);
        }
      },
      { once: true },
    );
    try {
      await transactionResult(transaction);
    } catch (cause) {
      throw storageFailure(activationFailure ?? cause);
    }
  }

  /**
   * Persist a terminal lifecycle. If the write does not complete, the terminal decision has not
   * been recorded; this live store then refuses every further operation so a later certificate
   * cannot be tried against an endpoint that should have stopped.
   */
  async #quarantine(lifecycle) {
    let transaction;
    let writeFailure;
    try {
      transaction = strictTransaction(this.#database, STORES.metadata);
      const store = transaction.objectStore(STORES.metadata);
      const current = store.get("current");
      current.addEventListener(
        "success",
        () => {
          try {
            const metadata = validateMetadata(current.result, this.#sessionHex);
            if (metadata.lifecycle === "ready") store.put({ ...metadata, lifecycle }, "current");
          } catch (cause) {
            writeFailure = cause;
            abortQuietly(transaction);
          }
        },
        { once: true },
      );
      await transactionResult(transaction);
    } catch (cause) {
      this.#unpersistedLifecycle = lifecycle;
      throw storageFailure(writeFailure ?? cause);
    }
  }

  #requirePersistedLifecycle() {
    if (this.#unpersistedLifecycle === undefined) return;
    throw failure(
      this.#unpersistedLifecycle === "revoked" ? "endpoint_revoked" : "rollback_detected",
    );
  }

  /** One strict transaction over every affected store, rechecking the head it was prepared on. */
  #writeCommit(expected, operationRecord, keyRecord, transitionRecord) {
    const transaction = strictTransaction(this.#database, [
      STORES.metadata,
      STORES.keys,
      STORES.states,
      STORES.operations,
    ]);
    const metadataStore = transaction.objectStore(STORES.metadata);
    const operationStore = transaction.objectStore(STORES.operations);
    const metadataRequest = metadataStore.get("current");
    const operationRequest = operationStore.get(operationRecord.operationId);
    let metadataValue;
    let operationValue;
    let ready = 0;
    let commitFailure;
    const writeWhenReady = () => {
      ready += 1;
      if (ready !== 2 || commitFailure) return;
      try {
        const metadata = validateMetadata(metadataValue, this.#sessionHex);
        if (
          metadata.lifecycle !== "ready" ||
          metadata.generation !== expected.generation ||
          metadata.confirmedCounter !== expected.confirmedCounter ||
          metadata.confirmedCommitment !== expected.confirmedCommitment ||
          metadata.currentKeyId !== expected.currentKeyId ||
          metadata.pendingOperationId !== null
        ) {
          throw failure("conflict");
        }
        if (operationValue !== undefined) throw failure("witness_operation_conflict");
        transaction.objectStore(STORES.keys).add(keyRecord, keyRecord.keyId);
        transaction.objectStore(STORES.states).put(transitionRecord, "current");
        operationStore.add(operationRecord, operationRecord.operationId);
        metadataStore.put(
          {
            ...metadata,
            generation: operationRecord.generation,
            currentKeyId: operationRecord.keyId,
            pendingOperationId: operationRecord.operationId,
          },
          "current",
        );
      } catch (cause) {
        commitFailure = cause;
        abortQuietly(transaction);
      }
    };
    metadataRequest.addEventListener(
      "success",
      () => {
        metadataValue = metadataRequest.result;
        writeWhenReady();
      },
      { once: true },
    );
    operationRequest.addEventListener(
      "success",
      () => {
        operationValue = operationRequest.result;
        writeWhenReady();
      },
      { once: true },
    );
    return transactionResult(transaction).catch((cause) => {
      throw storageFailure(commitFailure ?? cause);
    });
  }

  /**
   * Completion: recheck the successor key is active, delete the obsolete key and observe it absent,
   * mark the operation completed, and advance the confirmed head, all in one strict transaction.
   */
  #writeCompletion(expected, operationRecord, head) {
    const transaction = strictTransaction(this.#database, [
      STORES.metadata,
      STORES.keys,
      STORES.operations,
    ]);
    const keyStore = transaction.objectStore(STORES.keys);
    const metadataStore = transaction.objectStore(STORES.metadata);
    const operationStore = transaction.objectStore(STORES.operations);
    let completionFailure;
    const fail = (cause) => {
      completionFailure = cause;
      abortQuietly(transaction);
    };
    const successorRequest = keyStore.get(operationRecord.keyId);
    successorRequest.addEventListener(
      "success",
      () => {
        try {
          const successor = validateKeyRecord(successorRequest.result, operationRecord.keyId);
          if (successor.lifecycle !== "active") throw failure("key_record_missing");
          const metadataRequest = metadataStore.get("current");
          metadataRequest.addEventListener(
            "success",
            () => {
              try {
                const metadata = validateMetadata(metadataRequest.result, this.#sessionHex);
                if (
                  metadata.lifecycle !== "ready" ||
                  metadata.pendingOperationId !== operationRecord.operationId ||
                  metadata.generation !== expected.generation ||
                  metadata.currentKeyId !== operationRecord.keyId
                ) {
                  throw failure("corrupt_state");
                }
                const finish = () => {
                  operationStore.put(
                    { ...operationRecord, disposition: "completed" },
                    operationRecord.operationId,
                  );
                  metadataStore.put(
                    { ...metadata, ...head, pendingOperationId: null },
                    "current",
                  );
                };
                if (operationRecord.obsoleteKeyId === null) {
                  finish();
                  return;
                }
                keyStore.delete(operationRecord.obsoleteKeyId);
                const absent = keyStore.get(operationRecord.obsoleteKeyId);
                absent.addEventListener(
                  "success",
                  () => {
                    if (absent.result !== undefined) {
                      fail(failure("key_record_missing"));
                      return;
                    }
                    try {
                      finish();
                    } catch (cause) {
                      fail(cause);
                    }
                  },
                  { once: true },
                );
              } catch (cause) {
                fail(cause);
              }
            },
            { once: true },
          );
        } catch (cause) {
          fail(cause);
        }
      },
      { once: true },
    );
    return transactionResult(transaction).catch((cause) => {
      throw storageFailure(completionFailure ?? cause);
    });
  }
}

export const PRODUCTION_BROWSER_STORAGE_SCHEMA = Object.freeze({
  databaseVersion: DATABASE_VERSION,
  stores: Object.freeze(Object.values(STORES)),
  zeroHash: ZERO_HASH,
});
