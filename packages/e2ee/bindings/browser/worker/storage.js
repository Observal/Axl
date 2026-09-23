// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

import {
  BrowserLineage,
  BrowserReplicaTrust,
  BrowserTransition,
  inspect_committed_transition as inspectCommittedTransition,
  open_committed_transition as openCommittedTransition,
} from "../wasm/axl_e2ee_browser.js";

const DATABASE_VERSION = 2;
const MAX_REQUEST_BYTES = 1_024;
const MAX_CERTIFICATE_BYTES = 3_072;
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
    request.addEventListener("error", () => reject(request.error ?? failure("storage_unavailable")), {
      once: true,
    });
  });
}

function transactionResult(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? failure("storage_unavailable")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? failure("storage_unavailable")),
      { once: true },
    );
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

function pendingView(operation) {
  return Object.freeze({
    operationId: fromHex(operation.operationId),
    witnessRequest: new Uint8Array(operation.request),
    requestHash: new Uint8Array(operation.requestHash),
    status: "pending_quorum",
  });
}

function completedView(operation, exactResult) {
  return Object.freeze({
    operationId: fromHex(operation.operationId),
    status: "completed",
    exactResult,
  });
}

function same(left, right) {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function strictTransaction(database, storeNames) {
  const transaction = database.transaction(storeNames, "readwrite", { durability: "strict" });
  if (transaction.durability !== "strict") {
    transaction.abort();
    throw failure("strict_durability_unavailable");
  }
  return transaction;
}

/**
 * Worker-private production persistence for one endpoint lineage.
 *
 * The page protocol never receives this object, a CryptoKey, a transition, a continuation, a
 * transaction, or a plaintext buffer. `commit` accepts only a Rust-finalized transition: the
 * header, nonces, AADs, key ID, commitment, exact signed request, and canonical record come from
 * WASM, and this class only moves bytes between WebCrypto, WASM, and IndexedDB.
 *
 * Key lifecycle: the successor key record is written `prepared` in the commit transaction, marked
 * `active` only after that transaction completes, and the obsolete key is deleted and observed
 * absent in the completion transaction before the exact result leaves Rust.
 */
export class ProductionBrowserStore {
  #session;
  #sessionHex;
  #databaseName;
  #database;
  #lockRelease;
  #lockTask;
  #closed = false;
  #lineage;
  #trust;
  /** Certificates verified in this live lifetime, keyed by operation. Never persisted. */
  #released = new Map();
  /** Terminal lifecycle whose persistence failed. Set once; fails every later call closed. */
  #unpersistedLifecycle;

  constructor(sessionId, lineage, trust) {
    this.#session = fixedBytes(sessionId, 16);
    this.#sessionHex = hex(this.#session);
    this.#databaseName = `axl-e2ee-production-v1:${this.#sessionHex}`;
    if (!(lineage instanceof BrowserLineage) || !(trust instanceof BrowserReplicaTrust)) {
      throw failure("invalid_argument");
    }
    this.#lineage = lineage;
    this.#trust = trust;
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
        throw creationFailure ?? cause;
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
      // Restart recovery step: the key named by the committed record is activated or verified,
      // then the committed record is decrypted and authenticated in Rust against the stored
      // operation row. The pending request itself is only exposed by pending().
      const pending = await this.#pendingOperation(metadata);
      if (pending) await this.#authenticatePending(pending);
      return Object.freeze({
        opened: true,
        lifecycle: metadata.lifecycle,
        generation: metadata.generation,
        pendingOperationId: pending ? pendingView(pending).operationId : null,
      });
    } catch (cause) {
      database?.close();
      this.#database = undefined;
      await this.#releaseLock();
      throw cause;
    }
  }

  /**
   * Reload the one durable pending request. Exposed only after the successor key is active and
   * the sealed committed record has been authenticated against the stored request and hash.
   */
  async pending() {
    const metadata = await this.#metadata();
    this.#requireLive(metadata);
    const operation = await this.#pendingOperation(metadata);
    if (!operation) throw failure("not_found");
    await this.#authenticatePending(operation);
    return pendingView(operation);
  }

  async commit(transition) {
    if (!this.#database || this.#closed) throw failure("endpoint_closed");
    if (!(transition instanceof BrowserTransition)) throw failure("invalid_argument");
    const operation = fixedBytes(transition.operation_id(), 16);
    const operationHex = hex(operation);
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
      const existing = await this.#readOperation(operationHex, true);
      if (existing) {
        if (existing.fingerprint !== fingerprintHex) {
          await this.#quarantine("quarantined");
          throw failure("witness_operation_conflict");
        }
        if (existing.disposition === "pending") {
          await this.#ensureActivated(existing);
          return pendingView(existing);
        }
        const verified = this.#released.get(operationHex);
        if (!verified) throw failure("fresh_witness_required");
        return completedView(existing, await this.#release(metadata, existing, verified));
      }
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
      await this.#writeCommit(metadata, operationRecord, {
        keyId: keyIdHex,
        lifecycle: "prepared",
        wrappedKey: new Uint8Array(wrappedKey),
      }, { operationId: operationHex, generation, keyId: keyIdHex, record });
      // The successor record supersedes every earlier committed record, so no earlier completed
      // result can be released from this store again without the endpoint's own retention.
      for (const verified of this.#released.values()) verified.fill(0);
      this.#released.clear();
      // Durable local commit precedes successor-key activation, which precedes request exposure.
      await this.#ensureActivated(operationRecord);
      return pendingView(operationRecord);
    } finally {
      for (const value of [wrappedKey, innerPayload, sealedInner, outerPlaintext, sealedOuter]) {
        value?.fill(0);
      }
      committed?.free();
      transition.free();
    }
  }

  async continueWitness(operationId, certificate) {
    if (!this.#database || this.#closed) throw failure("endpoint_closed");
    const operation = fixedBytes(operationId, 16);
    const certificateBytes = bytes(certificate, 1, MAX_CERTIFICATE_BYTES);
    const operationHex = hex(operation);
    try {
      const metadata = await this.#metadata();
      this.#requireLive(metadata);
      const record = await this.#readOperation(operationHex);
      if (record.disposition === "completed") {
        // A completed marker is a cache. It is reusable only inside the live lifetime that
        // verified the certificate; after restart a fresh unanimous head is required first.
        if (!this.#released.has(operationHex)) throw failure("fresh_witness_required");
      } else if (metadata.pendingOperationId !== operationHex) {
        throw failure("corrupt_state");
      }
      return await this.#release(metadata, record, certificateBytes);
    } finally {
      operation.fill(0);
      certificateBytes.fill(0);
    }
  }

  /**
   * Fixed order: successor key active, exact record opened and authenticated in Rust, unanimous
   * certificate verified, completion transaction (obsolete key deleted and observed absent, head
   * advanced), obsolete erasure reported, and only then the exact result.
   */
  async #release(metadata, record, certificateBytes) {
    let continuation;
    try {
      continuation = await this.#openAuthenticated(record);
      try {
        continuation.confirm_quorum(new Uint8Array(certificateBytes), this.#trust);
      } catch (cause) {
        const terminal = continuation.terminal();
        if (terminal) await this.#quarantine(terminal);
        throw cause;
      }
      if (record.disposition === "pending") {
        const certificateHash = continuation.certificate_hash();
        if (!(certificateHash instanceof Uint8Array) || certificateHash.byteLength !== 48) {
          throw failure("internal_error");
        }
        await this.#writeCompletion(metadata, record, {
          confirmedCounter: record.counter,
          confirmedCommitment: hex(continuation.commitment()),
          previousCertificateHash: hex(certificateHash),
        });
        this.#released.set(record.operationId, new Uint8Array(certificateBytes));
      }
      if (continuation.has_obsolete_key()) continuation.mark_obsolete_key_erased();
      return new Uint8Array(continuation.exact_result());
    } finally {
      continuation?.free();
    }
  }

  /**
   * Activate or verify the successor key, decrypt the sealed committed record with it, and let
   * Rust authenticate lineage, commitment, signed request, and heads. The caller frees the
   * returned continuation. Nothing about the operation is exposed before this succeeds.
   */
  async #openAuthenticated(record) {
    let innerPlaintext;
    let outerPlaintext;
    let envelopes;
    let continuation;
    try {
      await this.#ensureActivated(record);
      const transitionRecord = await this.#transitionRecord(record);
      envelopes = inspectCommittedTransition(transitionRecord.record);
      if (
        hex(envelopes.operation_id()) !== record.operationId ||
        hex(envelopes.current_key_id()) !== record.keyId ||
        envelopes.counter() !== record.counter ||
        envelopes.generation() !== record.generation
      ) {
        throw failure("corrupt_state");
      }
      const stateKey = await this.#unwrapStateKey(record.keyId);
      innerPlaintext = new Uint8Array(
        await globalThis.crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: envelopes.inner_nonce(),
            additionalData: envelopes.inner_aad(),
            tagLength: 128,
          },
          stateKey,
          envelopes.sealed_inner(),
        ),
      );
      outerPlaintext = new Uint8Array(
        await globalThis.crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: envelopes.outer_nonce(),
            additionalData: envelopes.outer_aad(),
            tagLength: 128,
          },
          stateKey,
          envelopes.sealed_outer(),
        ),
      );
      continuation = openCommittedTransition(
        transitionRecord.record,
        innerPlaintext,
        outerPlaintext,
        this.#lineage,
      );
      // The stored operation row is a cache of the signed request inside the authenticated
      // record. It is never sent unless it matches that record byte for byte.
      if (
        !same(continuation.request_hash(), record.requestHash) ||
        !same(continuation.witness_request(), record.request)
      ) {
        throw failure("corrupt_state");
      }
      continuation.mark_current_key_active();
      const opened = continuation;
      continuation = undefined;
      return opened;
    } catch (cause) {
      if (cause?.name === "OperationError") throw failure("corrupt_state");
      throw cause;
    } finally {
      innerPlaintext?.fill(0);
      outerPlaintext?.fill(0);
      envelopes?.free();
      continuation?.free();
    }
  }

  /** Restart recovery: a pending request is resent only after the record authenticates. */
  async #authenticatePending(operation) {
    const continuation = await this.#openAuthenticated(operation);
    continuation.free();
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#database?.close();
    this.#database = undefined;
    this.#session.fill(0);
    for (const certificate of this.#released.values()) certificate.fill(0);
    this.#released.clear();
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
    const envelopes = inspectCommittedTransition(transitionRecord.record);
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

  async #readOperation(operationHex, optional = false) {
    if (!this.#database || this.#closed) throw failure("endpoint_closed");
    const transaction = this.#database.transaction(STORES.operations, "readonly");
    const value = await requestResult(transaction.objectStore(STORES.operations).get(operationHex));
    await transactionResult(transaction);
    if (value === undefined && optional) return undefined;
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
          transaction.abort();
        }
      },
      { once: true },
    );
    try {
      await transactionResult(transaction);
    } catch (cause) {
      throw activationFailure ?? cause;
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
            transaction.abort();
          }
        },
        { once: true },
      );
      await transactionResult(transaction);
    } catch (cause) {
      this.#unpersistedLifecycle = lifecycle;
      throw writeFailure ?? cause ?? failure("storage_unavailable");
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
        transaction.abort();
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
      throw commitFailure ?? cause;
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
      transaction.abort();
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
      throw completionFailure ?? cause;
    });
  }
}

export const PRODUCTION_BROWSER_STORAGE_SCHEMA = Object.freeze({
  databaseVersion: DATABASE_VERSION,
  stores: Object.freeze(Object.values(STORES)),
  zeroHash: ZERO_HASH,
});
