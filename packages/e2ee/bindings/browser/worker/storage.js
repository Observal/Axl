// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

const DATABASE_VERSION = 1;
const MAX_REQUEST_BYTES = 1_024;
const MAX_CERTIFICATE_BYTES = 3_072;
const MAX_RESULT_BYTES = 1_048_576;
const MAX_ENVELOPE_BYTES = 16 * 1_048_576;
const ZERO_HASH = "0".repeat(96);
const STORES = Object.freeze({
  metadata: "metadata_v1",
  wrapping: "wrapping_key_v1",
  keys: "wrapped_state_keys_v1",
  states: "sealed_states_v1",
  operations: "witness_operations_v1",
});

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

function openRequestResult(request, allowUpgrade) {
  return new Promise((resolve, reject) => {
    let upgraded = false;
    request.addEventListener("upgradeneeded", (event) => {
      upgraded = true;
      if (!allowUpgrade || event.oldVersion !== 0 || event.newVersion !== DATABASE_VERSION) {
        request.transaction?.abort();
        return;
      }
      const database = request.result;
      for (const store of Object.values(STORES)) database.createObjectStore(store);
    });
    request.addEventListener(
      "success",
      () => {
        if (!allowUpgrade && upgraded) {
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
      () => reject(request.error ?? failure(upgraded ? "state_loss" : "storage_unavailable")),
      { once: true },
    );
    request.addEventListener("blocked", () => reject(failure("lifecycle_busy")), { once: true });
  });
}

function random(size) {
  const output = new Uint8Array(size);
  globalThis.crypto.getRandomValues(output);
  return output;
}

function exactRecord(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...names].sort();
  return actual.length === expected.length && actual.every((name, index) => name === expected[index]);
}

function validateMetadata(value, sessionHex) {
  if (
    !exactRecord(value, ["generation", "profileId", "profileRevision", "session", "version"]) ||
    value.version !== DATABASE_VERSION ||
    value.profileId !== "axl-e2ee-mls-pq-v1" ||
    value.profileRevision !== 1 ||
    value.session !== sessionHex ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0
  ) {
    throw failure("corrupt_state");
  }
  return value;
}

function validateOperation(value, operationHex) {
  if (
    !exactRecord(value, [
      "generation",
      "keyId",
      "operationId",
      "request",
      "requestHash",
      "resultAad",
      "resultCiphertext",
      "resultNonce",
      "status",
    ]) ||
    value.operationId !== operationHex ||
    !Number.isSafeInteger(value.generation) ||
    typeof value.keyId !== "string" ||
    !(value.request instanceof Uint8Array) ||
    value.request.byteLength === 0 ||
    value.request.byteLength > MAX_REQUEST_BYTES ||
    !(value.requestHash instanceof Uint8Array) ||
    value.requestHash.byteLength !== 48 ||
    !(value.resultAad instanceof Uint8Array) ||
    !(value.resultCiphertext instanceof Uint8Array) ||
    !(value.resultNonce instanceof Uint8Array) ||
    value.resultNonce.byteLength !== 12 ||
    !["pending_quorum", "committed"].includes(value.status)
  ) {
    throw failure("corrupt_state");
  }
  return value;
}

function clonePending(value) {
  return Object.freeze({
    operationId: new Uint8Array(value.operationId),
    witnessRequest: new Uint8Array(value.witnessRequest),
    requestHash: new Uint8Array(value.requestHash),
    status: value.status,
  });
}

/**
 * Worker-private production persistence. The page protocol never receives this object, a CryptoKey,
 * an envelope, a transaction, or a plaintext state snapshot.
 */
export class ProductionBrowserStore {
  #session;
  #sessionHex;
  #databaseName;
  #database;
  #lockRelease;
  #lockTask;
  #closed = false;
  #verifyCertificate;

  constructor(sessionId, verifyCertificate) {
    this.#session = fixedBytes(sessionId, 16);
    this.#sessionHex = hex(this.#session);
    this.#databaseName = `axl-e2ee-production-v1:${this.#sessionHex}`;
    if (typeof verifyCertificate !== "function") throw failure("invalid_argument");
    this.#verifyCertificate = verifyCertificate;
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
      const transaction = database.transaction(
        [STORES.metadata, STORES.wrapping],
        "readwrite",
        { durability: "strict" },
      );
      if (transaction.durability !== "strict") {
        transaction.abort();
        throw failure("strict_durability_unavailable");
      }
      const metadataStore = transaction.objectStore(STORES.metadata);
      let creationFailure;
      const metadataWrite = metadataStore.add(
        {
          version: DATABASE_VERSION,
          profileId: "axl-e2ee-mls-pq-v1",
          profileRevision: 1,
          session: this.#sessionHex,
          generation: 0,
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
      return Object.freeze({ generation: 0 });
    } catch (cause) {
      database?.close();
      if (cause?.name === "ConstraintError") throw failure("already_exists");
      throw cause;
    }
  }

  async open() {
    await this.#acquireLock();
    if (this.#closed) throw failure("endpoint_closed");
    const database = await openRequestResult(globalThis.indexedDB.open(this.#databaseName), false);
    try {
      if (database.version !== DATABASE_VERSION) throw failure("corrupt_state");
      const required = new Set(Object.values(STORES));
      for (const name of database.objectStoreNames) required.delete(name);
      if (required.size !== 0) throw failure("corrupt_state");
      const transaction = database.transaction([STORES.metadata, STORES.wrapping], "readonly");
      validateMetadata(
        await requestResult(transaction.objectStore(STORES.metadata).get("current")),
        this.#sessionHex,
      );
      const wrappingKey = await requestResult(transaction.objectStore(STORES.wrapping).get("origin"));
      if (!(wrappingKey instanceof CryptoKey) || wrappingKey.extractable !== false) {
        throw failure("key_record_missing");
      }
      await transactionResult(transaction);
      this.#database = database;
      return Object.freeze({ opened: true });
    } catch (cause) {
      database.close();
      throw cause;
    }
  }

  async pending(operationId) {
    const operation = fixedBytes(operationId, 16);
    const record = await this.#readOperation(hex(operation));
    return clonePending({
      operationId: operation,
      witnessRequest: record.request,
      requestHash: record.requestHash,
      status: record.status,
    });
  }

  async commit({
    operationId,
    expectedGeneration,
    innerState,
    outerMetadata,
    innerAad,
    outerAad,
    witnessRequest,
    requestHash,
    exactResult,
  }) {
    if (!this.#database || this.#closed) throw failure("endpoint_closed");
    const operation = fixedBytes(operationId, 16);
    const operationHex = hex(operation);
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
      throw failure("invalid_argument");
    }
    const inner = bytes(innerState, 1, MAX_ENVELOPE_BYTES);
    const outer = bytes(outerMetadata, 1, MAX_ENVELOPE_BYTES);
    const innerAssociated = bytes(innerAad, 1, 4_096);
    const outerAssociated = bytes(outerAad, 1, 4_096);
    const request = bytes(witnessRequest, 1, MAX_REQUEST_BYTES);
    const requestDigest = fixedBytes(requestHash, 48);
    const result = bytes(exactResult, 0, MAX_RESULT_BYTES);
    let keyId;
    let wrappedKey;
    let innerNonce;
    let outerNonce;
    let resultNonce;
    let innerCiphertext;
    let outerCiphertext;
    let resultCiphertext;
    try {
      const existing = await this.#readOperation(operationHex, true);
      if (existing) {
        if (
          existing.requestHash.byteLength !== requestDigest.byteLength ||
          !existing.requestHash.every((value, index) => value === requestDigest[index])
        ) {
          throw failure("witness_operation_conflict");
        }
        return clonePending({
          operationId: operation,
          witnessRequest: existing.request,
          requestHash: existing.requestHash,
          status: existing.status,
        });
      }
      const wrappingTransaction = this.#database.transaction(STORES.wrapping, "readonly");
      const wrappingKey = await requestResult(
        wrappingTransaction.objectStore(STORES.wrapping).get("origin"),
      );
      await transactionResult(wrappingTransaction);
      if (!(wrappingKey instanceof CryptoKey) || wrappingKey.extractable !== false) {
        throw failure("key_record_missing");
      }
      const stateKey = await globalThis.crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      wrappedKey = new Uint8Array(
        await globalThis.crypto.subtle.wrapKey("raw", stateKey, wrappingKey, "AES-KW"),
      );
      keyId = hex(random(16));
      innerNonce = random(12);
      outerNonce = random(12);
      resultNonce = random(12);
      innerCiphertext = new Uint8Array(
        await globalThis.crypto.subtle.encrypt(
          { name: "AES-GCM", iv: innerNonce, additionalData: innerAssociated, tagLength: 128 },
          stateKey,
          inner,
        ),
      );
      outerCiphertext = new Uint8Array(
        await globalThis.crypto.subtle.encrypt(
          { name: "AES-GCM", iv: outerNonce, additionalData: outerAssociated, tagLength: 128 },
          stateKey,
          outer,
        ),
      );
      const resultAad = new TextEncoder().encode(
        `axl-e2ee-browser-result-v1:${this.#sessionHex}:${operationHex}`,
      );
      resultCiphertext = new Uint8Array(
        await globalThis.crypto.subtle.encrypt(
          { name: "AES-GCM", iv: resultNonce, additionalData: resultAad, tagLength: 128 },
          stateKey,
          result,
        ),
      );
      const storeNames = [STORES.metadata, STORES.keys, STORES.states, STORES.operations];
      const transaction = this.#database.transaction(storeNames, "readwrite", {
        durability: "strict",
      });
      if (transaction.durability !== "strict") {
        transaction.abort();
        throw failure("strict_durability_unavailable");
      }
      const metadataStore = transaction.objectStore(STORES.metadata);
      const operationStore = transaction.objectStore(STORES.operations);
      const metadataRequest = metadataStore.get("current");
      const operationRequest = operationStore.get(operationHex);
      let metadataValue;
      let operationValue;
      let metadataReady = false;
      let operationReady = false;
      let commitFailure;
      const writeWhenReady = () => {
        if (!metadataReady || !operationReady || commitFailure) return;
        try {
          const metadata = validateMetadata(metadataValue, this.#sessionHex);
          if (metadata.generation !== expectedGeneration) throw failure("conflict");
          if (operationValue !== undefined) throw failure("witness_operation_conflict");
          const generation = expectedGeneration + 1;
          transaction.objectStore(STORES.keys).add(
            { keyId, lifecycle: "active", wrappedKey: new Uint8Array(wrappedKey) },
            keyId,
          );
          transaction.objectStore(STORES.states).put(
            {
              generation,
              keyId,
              innerAad: new Uint8Array(innerAssociated),
              innerCiphertext: new Uint8Array(innerCiphertext),
              innerNonce: new Uint8Array(innerNonce),
              outerAad: new Uint8Array(outerAssociated),
              outerCiphertext: new Uint8Array(outerCiphertext),
              outerNonce: new Uint8Array(outerNonce),
            },
            "current",
          );
          operationStore.add(
            {
              generation,
              keyId,
              operationId: operationHex,
              request: new Uint8Array(request),
              requestHash: new Uint8Array(requestDigest),
              resultAad,
              resultCiphertext: new Uint8Array(resultCiphertext),
              resultNonce: new Uint8Array(resultNonce),
              status: "pending_quorum",
            },
            operationHex,
          );
          metadataStore.put({ ...metadata, generation }, "current");
        } catch (cause) {
          commitFailure = cause;
          transaction.abort();
        }
      };
      metadataRequest.addEventListener(
        "success",
        () => {
          metadataValue = metadataRequest.result;
          metadataReady = true;
          writeWhenReady();
        },
        { once: true },
      );
      operationRequest.addEventListener(
        "success",
        () => {
          operationValue = operationRequest.result;
          operationReady = true;
          writeWhenReady();
        },
        { once: true },
      );
      try {
        await transactionResult(transaction);
      } catch (cause) {
        throw commitFailure ?? cause;
      }
      return clonePending({
        operationId: operation,
        witnessRequest: request,
        requestHash: requestDigest,
        status: "pending_quorum",
      });
    } finally {
      for (const value of [
        inner,
        outer,
        innerAssociated,
        outerAssociated,
        request,
        requestDigest,
        result,
        wrappedKey,
        innerNonce,
        outerNonce,
        resultNonce,
        innerCiphertext,
        outerCiphertext,
        resultCiphertext,
      ]) {
        value?.fill(0);
      }
      keyId = undefined;
    }
  }

  async continueWitness(operationId, certificate) {
    if (!this.#database || this.#closed) throw failure("endpoint_closed");
    const operation = fixedBytes(operationId, 16);
    const certificateBytes = bytes(certificate, 1, MAX_CERTIFICATE_BYTES);
    const operationHex = hex(operation);
    let plaintext;
    let wrapped;
    try {
      const record = await this.#readOperation(operationHex);
      const verified = await this.#verifyCertificate(
        new Uint8Array(operation),
        new Uint8Array(record.request),
        new Uint8Array(record.requestHash),
        certificateBytes,
      );
      if (verified !== true) throw failure("witness_receipt_invalid");
      const transaction = this.#database.transaction([STORES.wrapping, STORES.keys], "readonly");
      const wrappingKey = await requestResult(transaction.objectStore(STORES.wrapping).get("origin"));
      const keyRecord = await requestResult(transaction.objectStore(STORES.keys).get(record.keyId));
      await transactionResult(transaction);
      if (
        !(wrappingKey instanceof CryptoKey) ||
        !exactRecord(keyRecord, ["keyId", "lifecycle", "wrappedKey"]) ||
        keyRecord.keyId !== record.keyId ||
        keyRecord.lifecycle !== "active" ||
        !(keyRecord.wrappedKey instanceof Uint8Array)
      ) {
        throw failure("key_record_missing");
      }
      wrapped = new Uint8Array(keyRecord.wrappedKey);
      const stateKey = await globalThis.crypto.subtle.unwrapKey(
        "raw",
        wrapped,
        wrappingKey,
        "AES-KW",
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"],
      );
      plaintext = new Uint8Array(
        await globalThis.crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: record.resultNonce,
            additionalData: record.resultAad,
            tagLength: 128,
          },
          stateKey,
          record.resultCiphertext,
        ),
      );
      const write = this.#database.transaction(STORES.operations, "readwrite", {
        durability: "strict",
      });
      if (write.durability !== "strict") {
        write.abort();
        throw failure("strict_durability_unavailable");
      }
      const operationStore = write.objectStore(STORES.operations);
      const currentRequest = operationStore.get(operationHex);
      let writeFailure;
      currentRequest.addEventListener(
        "success",
        () => {
          try {
            const current = validateOperation(currentRequest.result, operationHex);
            operationStore.put({ ...current, status: "committed" }, operationHex);
          } catch (cause) {
            writeFailure = cause;
            write.abort();
          }
        },
        { once: true },
      );
      try {
        await transactionResult(write);
      } catch (cause) {
        throw writeFailure ?? cause;
      }
      return new Uint8Array(plaintext);
    } catch (cause) {
      if (cause?.name === "OperationError") throw failure("corrupt_state");
      throw cause;
    } finally {
      operation.fill(0);
      certificateBytes.fill(0);
      plaintext?.fill(0);
      wrapped?.fill(0);
    }
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

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#database?.close();
    this.#database = undefined;
    this.#session.fill(0);
    this.#lockRelease?.();
    this.#lockRelease = undefined;
    try {
      await this.#lockTask;
    } finally {
      this.#lockTask = undefined;
    }
  }
}

export const PRODUCTION_BROWSER_STORAGE_SCHEMA = Object.freeze({
  databaseVersion: DATABASE_VERSION,
  stores: Object.freeze(Object.values(STORES)),
  zeroHash: ZERO_HASH,
});
