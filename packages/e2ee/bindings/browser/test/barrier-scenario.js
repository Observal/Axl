// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

// Test-only driver for the production browser store. It runs inside the dedicated test worker,
// produces transitions through the fixture lineage and answers requests with the in-WASM test
// witness. The production store itself is the byte-identical worker/storage.js.

import {
  BrowserTransition,
  TestBrowserLineageFixture,
  TestWitness,
} from "../wasm/axl_e2ee_browser.js";
import { PRODUCTION_BROWSER_STORAGE_SCHEMA, ProductionBrowserStore } from "./storage.js";

const ZERO_HASH = new Uint8Array(48);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function hex(value) {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function codeOf(cause) {
  const match = /AXL_E2EE:([a-z0-9_]+)/u.exec(String(cause));
  return match?.[1] ?? `unexpected:${String(cause)}`;
}

async function codeFrom(promise) {
  try {
    await promise;
    return "unexpected_success";
  } catch (cause) {
    return codeOf(cause);
  }
}

function requestDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("blocked"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("aborted"));
  });
}

async function deleteDatabase(name) {
  await requestDone(indexedDB.deleteDatabase(name));
}

async function readAll(name, store) {
  const database = await requestDone(indexedDB.open(name));
  try {
    const transaction = database.transaction(store, "readonly");
    const values = await requestDone(transaction.objectStore(store).getAll());
    const keys = await requestDone(transaction.objectStore(store).getAllKeys());
    await transactionDone(transaction);
    return keys.map((key, index) => [key, values[index]]);
  } finally {
    database.close();
  }
}

async function rewrite(name, store, key, update) {
  const database = await requestDone(indexedDB.open(name));
  try {
    const transaction = database.transaction(store, "readwrite");
    const objectStore = transaction.objectStore(store);
    const current = await requestDone(objectStore.get(key));
    objectStore.put(update(current), key);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

/** Confirmed head as the store's metadata records it, read directly from IndexedDB. */
async function metadata(name) {
  const [[, value]] = await readAll(name, "metadata_v2");
  return value;
}

function fromHex(value) {
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

export async function runProductionBarrierScenario() {
  const session = new Uint8Array(16).fill(0xb7);
  const databaseName = `axl-e2ee-production-v1:${hex(session)}`;
  const witness = new TestWitness();
  const fixture = new TestBrowserLineageFixture(0x51, true);
  const lineage = fixture.lineage();
  const trust = witness.trust();
  const opId = (value) => new Uint8Array(16).fill(value);
  const fingerprint = (value) => new Uint8Array(48).fill(value);
  const store = () => new ProductionBrowserStore(session, lineage, trust);
  const nextTransition = (operationId, fingerprintByte, innerState, exactResult) =>
    metadata(databaseName).then((head) =>
      fixture.transition(
        head.confirmedCounter,
        fromHex(head.confirmedCommitment),
        fromHex(head.previousCertificateHash),
        operationId,
        fingerprint(fingerprintByte),
        textEncoder.encode(innerState),
        textEncoder.encode(exactResult),
      ),
    );
  const evidence = {};
  let stage = "delete";
  let first;
  let competing;
  let reopened;
  try {
    await deleteDatabase(databaseName);
    stage = "create";
    first = store();
    await first.create();
    evidence.duplicateCreate = await codeFrom(store().create());
    stage = "contention";
    competing = store();
    evidence.contention = await codeFrom(competing.open());
    await competing.close();
    competing = undefined;
    stage = "javascript-selected-internals";
    evidence.plainObjectCommit = await codeFrom(
      first.commit({ operationId: opId(1), innerState: new Uint8Array([1]) }),
    );
    stage = "result-bound";
    evidence.oversizedResult = codeOf(
      (() => {
        try {
          fixture.transition(
            0n,
            ZERO_HASH,
            ZERO_HASH,
            opId(9),
            fingerprint(9),
            new Uint8Array([1]),
            new Uint8Array(65_498),
          );
          return "unexpected_success";
        } catch (cause) {
          return cause;
        }
      })(),
    );
    stage = "register";
    const registerTransition = await nextTransition(opId(1), 1, "first inner", "first result");
    const registerPending = await first.commit(registerTransition);
    evidence.registerStatus = registerPending.status;
    evidence.registerRequestBytes = registerPending.witnessRequest.byteLength;
    const requestHash = new Uint8Array(
      await crypto.subtle.digest("SHA-384", registerPending.witnessRequest),
    );
    evidence.requestHashMatches = hex(requestHash) === hex(registerPending.requestHash);
    stage = "pending-barrier";
    const blocked = await nextTransition(opId(2), 2, "x", "y").catch((cause) => cause);
    evidence.secondWhilePending =
      blocked instanceof BrowserTransition ? await codeFrom(first.commit(blocked)) : codeOf(blocked);
    stage = "duplicate-pending";
    const duplicate = await first.commit(
      fixture.transition(
        0n,
        ZERO_HASH,
        ZERO_HASH,
        opId(1),
        fingerprint(1),
        textEncoder.encode("ignored candidate"),
        textEncoder.encode("ignored"),
      ),
    );
    evidence.duplicateExactRequest = hex(duplicate.witnessRequest) === hex(registerPending.witnessRequest);
    stage = "key-lifecycle-after-commit";
    const keysAfterCommit = await readAll(databaseName, "wrapped_state_keys_v2");
    evidence.keysAfterCommit = keysAfterCommit.map(([, value]) => value.lifecycle);
    stage = "quarantine-write-failure";
    const genuine = witness.respond(registerPending.witnessRequest);
    const forged = new Uint8Array(genuine);
    forged[forged.length - 1] ^= 1;
    // Test-only: abort the store's metadata-only strict transaction, which is the terminal
    // lifecycle write. An unpersisted quarantine must fail closed rather than be treated as done.
    const withAbortedLifecycleWrite = async (run) => {
      const original = IDBDatabase.prototype.transaction;
      let aborted = 0;
      IDBDatabase.prototype.transaction = function patched(names, mode, options) {
        const transaction = original.call(this, names, mode, options);
        if (names === "metadata_v2" && mode === "readwrite" && options?.durability === "strict") {
          const objectStore = transaction.objectStore.bind(transaction);
          transaction.objectStore = (name) => {
            const store = objectStore(name);
            store.put = () => {
              aborted += 1;
              transaction.abort();
              return {};
            };
            return store;
          };
        }
        return transaction;
      };
      try {
        return [await run(), aborted];
      } finally {
        IDBDatabase.prototype.transaction = original;
      }
    };
    const [quarantineWriteFailure, abortedLifecycleWrites] = await withAbortedLifecycleWrite(() =>
      codeFrom(first.continueWitness(registerPending.operationId, forged)),
    );
    evidence.quarantineWriteFailure = quarantineWriteFailure;
    evidence.abortedLifecycleWrites = abortedLifecycleWrites;
    evidence.lifecycleAfterFailedQuarantine = (await metadata(databaseName)).lifecycle;
    evidence.genuineAfterFailedQuarantine = await codeFrom(
      first.continueWitness(registerPending.operationId, genuine),
    );
    evidence.pendingAfterFailedQuarantine = await codeFrom(first.pending());
    await first.close();
    first = store();
    evidence.reopenAfterFailedQuarantine = (await first.open()).lifecycle;
    stage = "forged-certificate";
    evidence.forgedCertificate = await codeFrom(
      first.continueWitness(registerPending.operationId, forged),
    );
    evidence.lifecycleAfterForgery = (await metadata(databaseName)).lifecycle;
    evidence.genuineAfterQuarantine = await codeFrom(
      first.continueWitness(registerPending.operationId, genuine),
    );
    stage = "reset-quarantine";
    // Test-only: undo the durable quarantine marker to keep exercising the same lineage. The
    // production store never clears it.
    await first.close();
    await rewrite(databaseName, "metadata_v2", "current", (value) => ({
      ...value,
      lifecycle: "ready",
    }));
    stage = "corrupt-stored-request";
    // The operation row caches the signed request inside the sealed record. A corrupted cache
    // must fail authentication before open() or pending() can expose anything for resend.
    const flipLastByte = (field) => (value) => {
      const copy = new Uint8Array(value[field]);
      copy[copy.length - 1] ^= 1;
      return { ...value, [field]: copy };
    };
    evidence.corruptedRequestOpen = [];
    for (const field of ["request", "requestHash"]) {
      const [[, intact]] = (await readAll(databaseName, "witness_operations_v2")).filter(
        ([key]) => key === hex(opId(1)),
      );
      await rewrite(databaseName, "witness_operations_v2", hex(opId(1)), flipLastByte(field));
      const probe = store();
      evidence.corruptedRequestOpen.push(await codeFrom(probe.open()));
      await probe.close();
      await rewrite(databaseName, "witness_operations_v2", hex(opId(1)), () => intact);
    }
    first = store();
    const reopenedWithPending = await first.open();
    evidence.reopenReportsPending =
      reopenedWithPending.pendingOperationId !== null &&
      hex(reopenedWithPending.pendingOperationId) === hex(opId(1));
    stage = "recover-pending";
    const recovered = await first.pending();
    evidence.recoveredExactRequest = hex(recovered.witnessRequest) === hex(registerPending.witnessRequest);
    stage = "complete-register";
    const registerResult = await first.continueWitness(recovered.operationId, genuine);
    evidence.registerResult = textDecoder.decode(registerResult);
    evidence.headAfterRegister = Number((await metadata(databaseName)).confirmedCounter);
    evidence.pendingAfterRegister = await codeFrom(first.pending());
    stage = "cached-repeat";
    const repeated = await first.continueWitness(recovered.operationId, genuine);
    evidence.repeatedResult = textDecoder.decode(repeated);
    const cachedDuplicate = await first.commit(
      fixture.transition(
        0n,
        ZERO_HASH,
        ZERO_HASH,
        opId(1),
        fingerprint(1),
        textEncoder.encode("ignored candidate"),
        textEncoder.encode("ignored"),
      ),
    );
    evidence.cachedDuplicate = {
      status: cachedDuplicate.status,
      exactResult: textDecoder.decode(cachedDuplicate.exactResult),
    };
    stage = "advance";
    const advanceTransition = await nextTransition(opId(2), 2, "second inner", "second result");
    const advancePending = await first.commit(advanceTransition);
    evidence.advanceStatus = advancePending.status;
    const keysAfterAdvance = await readAll(databaseName, "wrapped_state_keys_v2");
    evidence.keysAfterAdvanceCommit = keysAfterAdvance.map(([, value]) => value.lifecycle).sort();
    stage = "restart-before-activation";
    await first.close();
    const successorKeyId = (await metadata(databaseName)).currentKeyId;
    evidence.successorKeyRecorded = keysAfterAdvance.some(([key]) => key === successorKeyId);
    await rewrite(databaseName, "wrapped_state_keys_v2", successorKeyId, (value) => ({
      ...value,
      lifecycle: "prepared",
    }));
    reopened = store();
    await reopened.open();
    const keysAfterReopen = await readAll(databaseName, "wrapped_state_keys_v2");
    evidence.keyReactivatedOnOpen = keysAfterReopen.find(
      ([key]) => key === successorKeyId,
    )?.[1].lifecycle;
    stage = "unavailable-witness";
    witness.set_unavailable(true);
    evidence.unavailable = (() => {
      try {
        witness.respond(advancePending.witnessRequest);
        return "unexpected_success";
      } catch (cause) {
        return codeOf(cause);
      }
    })();
    witness.set_unavailable(false);
    stage = "complete-advance";
    const advanceResult = await reopened.continueWitness(
      advancePending.operationId,
      witness.respond(advancePending.witnessRequest),
    );
    evidence.advanceResult = textDecoder.decode(advanceResult);
    const keysAfterCompletion = await readAll(databaseName, "wrapped_state_keys_v2");
    evidence.keysAfterCompletion = keysAfterCompletion.map(([key, value]) => [
      key === successorKeyId ? "successor" : "other",
      value.lifecycle,
    ]);
    const headAfterAdvance = await metadata(databaseName);
    evidence.headAfterAdvance = Number(headAfterAdvance.confirmedCounter);
    evidence.headCommitmentRecorded =
      headAfterAdvance.confirmedCommitment !== PRODUCTION_BROWSER_STORAGE_SCHEMA.zeroHash &&
      headAfterAdvance.previousCertificateHash !== PRODUCTION_BROWSER_STORAGE_SCHEMA.zeroHash;
    stage = "restart-completed-cache";
    await reopened.close();
    reopened = store();
    await reopened.open();
    evidence.completedAfterRestart = await codeFrom(
      reopened.continueWitness(
        advancePending.operationId,
        witness.respond(advancePending.witnessRequest),
      ),
    );
    stage = "same-id-different-fingerprint";
    const conflicting = await nextTransition(opId(2), 3, "third inner", "third result");
    evidence.conflict = await codeFrom(reopened.commit(conflicting));
    evidence.lifecycleAfterConflict = (await metadata(databaseName)).lifecycle;
    const afterConflict = await nextTransition(opId(3), 3, "x", "y");
    evidence.mutationAfterQuarantine = await codeFrom(reopened.commit(afterConflict));
    await reopened.close();
    reopened = undefined;
    stage = "schema";
    const probes = [];
    const probeStore = () => {
      const probe = store();
      probes.push(probe);
      return probe;
    };
    await deleteDatabase(databaseName);
    const versionOne = await requestDone(
      Object.assign(indexedDB.open(databaseName, 1), {
        onupgradeneeded: (event) => event.target.result.createObjectStore("metadata_v1"),
      }),
    );
    versionOne.close();
    evidence.versionOneOpen = await codeFrom(probeStore().open());
    evidence.versionOneCreate = await codeFrom(probeStore().create());
    const preserved = await requestDone(indexedDB.open(databaseName));
    evidence.versionOnePreserved = preserved.version;
    preserved.close();
    await deleteDatabase(databaseName);
    const newer = await requestDone(
      Object.assign(indexedDB.open(databaseName, PRODUCTION_BROWSER_STORAGE_SCHEMA.databaseVersion + 1), {
        onupgradeneeded: (event) => event.target.result.createObjectStore("future"),
      }),
    );
    newer.close();
    evidence.newerOpen = await codeFrom(probeStore().open());
    evidence.newerCreate = await codeFrom(probeStore().create());
    await deleteDatabase(databaseName);
    evidence.missingOpen = await codeFrom(probeStore().open());
    // A failed open or create owns nothing: with every probe still unclosed, the next opener for
    // the session must not see lifecycle_busy.
    const successor = store();
    await successor.create();
    evidence.createAfterFailedOpen = "created";
    await successor.close();
    for (const probe of probes) await probe.close();
    evidence.schema = {
      version: PRODUCTION_BROWSER_STORAGE_SCHEMA.databaseVersion,
      stores: [...PRODUCTION_BROWSER_STORAGE_SCHEMA.stores],
    };
    return evidence;
  } catch (cause) {
    throw new Error(`${stage}:${String(cause)}`);
  } finally {
    await first?.close();
    await competing?.close();
    await reopened?.close();
    await deleteDatabase(databaseName).catch(() => {});
    lineage.free();
    trust.free();
    fixture.free();
    witness.free();
  }
}
