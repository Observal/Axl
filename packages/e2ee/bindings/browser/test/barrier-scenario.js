// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

// Test-only driver for the production browser device endpoint. It runs inside the dedicated test
// worker against the fixture WASM, the byte-identical production endpoint driver and store, the
// in-WASM deterministic three-replica witness, and an in-WASM peer daemon. It exports evidence
// values only; no key, transition, plaintext state, or store object leaves the worker.

import { TestPeerDaemonFixture, TestWitness } from "../wasm/axl_e2ee_browser.js";
import { BrowserDeviceEndpoint } from "./endpoint.js";
import { PRODUCTION_BROWSER_STORAGE_SCHEMA, ProductionBrowserStore } from "./storage.js";

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
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("blocked", () => reject(new Error("blocked")), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
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

async function metadata(name) {
  const [[, value]] = await readAll(name, "metadata_v2");
  return value;
}

function id(value) {
  return new Uint8Array(16).fill(value);
}

/**
 * Test-only: intercept the store's IndexedDB transactions matching `matches(names, mode, options)`
 * and abort them on their first write. Restored in `finally`.
 */
async function withAbortedTransaction(matches, run) {
  const original = IDBDatabase.prototype.transaction;
  let aborted = 0;
  IDBDatabase.prototype.transaction = function patched(names, mode, options) {
    const transaction = original.call(this, names, mode, options);
    if (matches(names, mode, options)) {
      let abortedThis = false;
      const objectStore = transaction.objectStore.bind(transaction);
      transaction.objectStore = (name) => {
        const store = objectStore(name);
        for (const method of ["put", "add", "delete"]) {
          store[method] = () => {
            if (!abortedThis) {
              abortedThis = true;
              aborted += 1;
              transaction.abort();
            }
            return {};
          };
        }
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
}

const isStrict = (mode, options) => mode === "readwrite" && options?.durability === "strict";
const isCommitTransaction = (names, mode, options) =>
  Array.isArray(names) && names.length === 4 && isStrict(mode, options);
const isActivationTransaction = (names, mode, options) =>
  names === "wrapped_state_keys_v2" && isStrict(mode, options);
const isLifecycleTransaction = (names, mode, options) =>
  names === "metadata_v2" && isStrict(mode, options);

function epochReadyPayload(peer, commit) {
  const payload = new Uint8Array(18 + 2 + 16 + 32 + 48 + 8 + 48);
  let offset = 0;
  const put = (bytes) => {
    payload.set(bytes, offset);
    offset += bytes.byteLength;
  };
  put(textEncoder.encode("Axl epoch ready v1"));
  put(new Uint8Array([0, 1]));
  put(peer.crypto_session_id());
  put(peer.group_id());
  put(commit.commit_id());
  const epoch = new DataView(new ArrayBuffer(8));
  epoch.setBigUint64(0, commit.target_epoch());
  put(new Uint8Array(epoch.buffer));
  put(commit.epoch_authenticator());
  return payload;
}

/** Fresh unanimous head, then the mutation, then the barrier; returns the typed result. */
async function witnessed(endpoint, witness, mutate) {
  const read = await endpoint.witnessReadRequest();
  const reconciliation = await endpoint.reconcileWitness(witness.respond(read));
  if (reconciliation.tag !== "ready") throw new Error(`reconcile:${reconciliation.tag}`);
  const outcome = await mutate();
  if (outcome.status === "completed") return outcome;
  return endpoint.continueWitness(outcome.operationId, witness.respond(outcome.witnessRequest));
}

async function openEndpoint(peer, witness) {
  return BrowserDeviceEndpoint.open({ cryptoSessionId: peer.crypto_session_id(), trust: witness.trust() });
}

function createOptions(peer, witness, operationId) {
  return {
    accountId: peer.account_id(),
    installationId: peer.installation_id(),
    deviceId: peer.device_id(),
    cryptoSessionId: peer.crypto_session_id(),
    trust: witness.trust(),
    operationId,
  };
}

export async function runDeviceBarrierScenario() {
  const witness = new TestWitness();
  const peer = new TestPeerDaemonFixture(0x91, Date.now());
  const session = peer.crypto_session_id();
  const databaseName = `axl-e2ee-production-v1:${hex(session)}`;
  const lockName = `axl-e2ee-v1:${hex(session)}`;
  const evidence = {};
  let stage = "delete";
  let device;
  let competing;
  try {
    await deleteDatabase(databaseName);

    stage = "create";
    const created = await BrowserDeviceEndpoint.create(createOptions(peer, witness, id(0x10)));
    device = created.endpoint;
    evidence.registerKind = created.pending.kind;
    evidence.registerStatus = created.pending.status;
    evidence.duplicateCreate = await codeFrom(
      BrowserDeviceEndpoint.create(createOptions(peer, witness, id(0x10))),
    );
    evidence.contention = await codeFrom(openEndpoint(peer, witness));
    evidence.mutationWhilePending = await codeFrom(
      device.prepareActivation(id(0x12), id(0x40), textEncoder.encode("x")),
    );
    evidence.duplicateWhilePending =
      hex((await device.pendingWitness()).witnessRequest) === hex(created.pending.witnessRequest);
    evidence.continueWrongOperation = await codeFrom(
      device.continueWitness(id(0x11), witness.respond(created.pending.witnessRequest)),
    );
    evidence.reconcileWithoutRead = await codeFrom(device.reconcileWitness(new Uint8Array([1])));

    stage = "register";
    const keyPackage = await device.continueWitness(
      created.pending.operationId,
      witness.respond(created.pending.witnessRequest),
    );
    evidence.registerResultTag = keyPackage.tag;
    evidence.keyPackageBytes = keyPackage.bytes.byteLength;
    evidence.mutationWithoutFreshHead = await codeFrom(
      device.join(id(0x11), new Uint8Array([1]), peer.group_id()),
    );
    evidence.completedPendingIsNull = (await device.pendingWitness()) === null;

    stage = "join";
    const welcome = peer.consume_key_package(keyPackage.bytes);
    const joined = await witnessed(device, witness, () => device.join(id(0x11), welcome, peer.group_id()));
    evidence.joined = { tag: joined.tag, epoch: Number(joined.epoch) };

    stage = "activation";
    const activationPayload = textEncoder.encode("browser activation payload");
    const activation = await witnessed(device, witness, () =>
      device.prepareActivation(id(0x12), id(0x40), activationPayload),
    );
    evidence.activationDelivered =
      textDecoder.decode(peer.receive_activation(activation.bytes, id(0x40))) ===
      "browser activation payload";

    stage = "application-send";
    const requestPayload = textEncoder.encode("browser application request");
    const sent = await witnessed(device, witness, () =>
      device.prepareApplication(id(0x13), id(0x41), 7n, requestPayload),
    );
    evidence.sentClass = sent.messageClass;
    evidence.requestDelivered =
      textDecoder.decode(peer.receive_application(sent.bytes, id(0x41), 7n)) ===
      "browser application request";

    stage = "application-receive";
    const delivery = peer.prepare_delivery(id(0x45), 7n, textEncoder.encode("daemon delivery"));
    const received = await witnessed(device, witness, () =>
      device.receiveApplication(id(0x14), id(0x45), 7n, delivery),
    );
    evidence.received = { tag: received.tag, plaintext: textDecoder.decode(received.bytes) };
    evidence.replayRejected = await (async () => {
      const read = await device.witnessReadRequest();
      await device.reconcileWitness(witness.respond(read));
      return codeFrom(device.receiveApplication(id(0x1a), id(0x45), 7n, delivery));
    })();

    stage = "duplicate-completed";
    const duplicate = await witnessed(device, witness, () =>
      device.prepareApplication(id(0x13), id(0x41), 7n, requestPayload),
    );
    evidence.duplicateStatus = duplicate.status;
    evidence.duplicateExactBytes = hex(duplicate.bytes) === hex(sent.bytes);
    evidence.headAfterDuplicate = Number((await metadata(databaseName)).confirmedCounter);

    stage = "restart-pending";
    const read = await device.witnessReadRequest();
    await device.reconcileWitness(witness.respond(read));
    const pendingSend = await device.prepareApplication(
      id(0x15),
      id(0x48),
      7n,
      textEncoder.encode("survives restart"),
    );
    evidence.restartPendingStatus = pendingSend.status;
    await device.close();
    evidence.closedCode = await codeFrom(device.pendingWitness());
    device = await openEndpoint(peer, witness);
    const recovered = await device.pendingWitness();
    evidence.recoveredExactRequest = hex(recovered.witnessRequest) === hex(pendingSend.witnessRequest);
    const recoveredRead = await device.witnessReadRequest();
    evidence.recoveredReconciliation = (await device.reconcileWitness(witness.respond(recoveredRead))).tag;
    evidence.mutationWhileRecovering = await codeFrom(
      device.prepareApplication(id(0x16), id(0x49), 7n, textEncoder.encode("blocked")),
    );
    const recoveredResult = await device.continueWitness(
      recovered.operationId,
      witness.respond(recovered.witnessRequest),
    );
    evidence.recoveredDelivered =
      textDecoder.decode(peer.receive_application(recoveredResult.bytes, id(0x48), 7n)) ===
      "survives restart";

    stage = "restart-completed";
    await device.close();
    device = await openEndpoint(peer, witness);
    evidence.completedAfterRestartPending = (await device.pendingWitness()) === null;
    evidence.completedAfterRestartDuplicate = await codeFrom(
      device.prepareApplication(id(0x15), id(0x48), 7n, textEncoder.encode("survives restart")),
    );
    // An older retained result is gated by the same restart rule as the latest one.
    evidence.olderAfterRestartDuplicate = await codeFrom(
      device.prepareApplication(id(0x13), id(0x41), 7n, requestPayload),
    );
    const confirmingRead = await device.witnessReadRequest();
    evidence.completedAfterRestartReconciliation = (
      await device.reconcileWitness(witness.respond(confirmingRead))
    ).tag;
    const confirmedDuplicate = await device.prepareApplication(
      id(0x15),
      id(0x48),
      7n,
      textEncoder.encode("survives restart"),
    );
    evidence.completedAfterRestartExactBytes =
      confirmedDuplicate.status === "completed" &&
      hex(confirmedDuplicate.bytes) === hex(recoveredResult.bytes);
    const olderDuplicate = await device.prepareApplication(id(0x13), id(0x41), 7n, requestPayload);
    evidence.olderAfterRestartExactBytes =
      olderDuplicate.status === "completed" && hex(olderDuplicate.bytes) === hex(sent.bytes);

    stage = "abort-before-commit";
    {
      const abortRead = await device.witnessReadRequest();
      await device.reconcileWitness(witness.respond(abortRead));
      const headBefore = await metadata(databaseName);
      const [code, aborted] = await withAbortedTransaction(isCommitTransaction, () =>
        codeFrom(device.prepareApplication(id(0x17), id(0x4a), 7n, textEncoder.encode("aborted"))),
      );
      evidence.abortedCommit = { code, aborted };
      evidence.afterAbort = await codeFrom(device.pendingWitness());
      const headAfter = await metadata(databaseName);
      evidence.abortLeftHead =
        headAfter.confirmedCounter === headBefore.confirmedCounter &&
        headAfter.generation === headBefore.generation &&
        headAfter.pendingOperationId === null;
      device = await openEndpoint(peer, witness);
      evidence.abortReopenPending = (await device.pendingWitness()) === null;
      const retried = await witnessed(device, witness, () =>
        device.prepareApplication(id(0x17), id(0x4a), 7n, textEncoder.encode("aborted")),
      );
      evidence.abortRetryDelivered =
        textDecoder.decode(peer.receive_application(retried.bytes, id(0x4a), 7n)) === "aborted";
    }

    stage = "committed-before-activation";
    {
      const read2 = await device.witnessReadRequest();
      await device.reconcileWitness(witness.respond(read2));
      const [code, aborted] = await withAbortedTransaction(isActivationTransaction, () =>
        codeFrom(device.prepareApplication(id(0x18), id(0x4b), 7n, textEncoder.encode("activation"))),
      );
      evidence.activationFailure = { code, aborted };
      const keys = await readAll(databaseName, "wrapped_state_keys_v2");
      evidence.keysAfterActivationFailure = keys.map(([, value]) => value.lifecycle).sort();
      evidence.afterActivationFailure = await codeFrom(device.pendingWitness());
      // Durable commit happened; the request was never exposed. Reopen activates and resends.
      device = await openEndpoint(peer, witness);
      const pending = await device.pendingWitness();
      evidence.activationRecoveredPending = pending !== null && pending.kind === "advance";
      evidence.keysAfterReopen = (await readAll(databaseName, "wrapped_state_keys_v2"))
        .map(([, value]) => value.lifecycle)
        .sort();
      const read3 = await device.witnessReadRequest();
      evidence.activationRecoveredReconciliation = (
        await device.reconcileWitness(witness.respond(read3))
      ).tag;
      const result = await device.continueWitness(pending.operationId, witness.respond(pending.witnessRequest));
      evidence.activationRecoveredDelivered =
        textDecoder.decode(peer.receive_application(result.bytes, id(0x4b), 7n)) === "activation";
      evidence.keysAfterRecoveredCompletion = (await readAll(databaseName, "wrapped_state_keys_v2"))
        .map(([, value]) => value.lifecycle)
        .sort();
    }

    stage = "unavailable-witness";
    {
      const read4 = await device.witnessReadRequest();
      await device.reconcileWitness(witness.respond(read4));
      const pending = await device.prepareApplication(id(0x19), id(0x4c), 7n, textEncoder.encode("later"));
      witness.set_unavailable(true);
      evidence.unavailableWitness = (() => {
        try {
          witness.respond(pending.witnessRequest);
          return "unexpected_success";
        } catch (cause) {
          return codeOf(cause);
        }
      })();
      witness.set_unavailable(false);
      const unavailableRead = await device.witnessReadRequest();
      witness.set_unavailable(true);
      evidence.unavailableRead = (() => {
        try {
          witness.respond(unavailableRead);
          return "unexpected_success";
        } catch (cause) {
          return codeOf(cause);
        }
      })();
      witness.set_unavailable(false);
      evidence.pendingSurvivesUnavailable =
        hex((await device.pendingWitness()).witnessRequest) === hex(pending.witnessRequest);
      const laterResult = await device.continueWitness(
        pending.operationId,
        witness.respond(pending.witnessRequest),
      );
      peer.receive_application(laterResult.bytes, id(0x4c), 7n);
    }

    stage = "lock-loss";
    {
      let releaseStolen;
      const stolenHeld = new Promise((resolve) => {
        releaseStolen = resolve;
      });
      const stolen = navigator.locks.request(lockName, { mode: "exclusive", steal: true }, () => stolenHeld);
      await new Promise((resolve) => setTimeout(resolve, 50));
      evidence.afterLockLoss = await codeFrom(device.pendingWitness());
      evidence.afterLockLossMutation = await codeFrom(
        device.prepareApplication(id(0x1b), id(0x4d), 7n, textEncoder.encode("lost")),
      );
      evidence.reopenWhileStolen = await codeFrom(openEndpoint(peer, witness));
      releaseStolen();
      await stolen;
      device = await openEndpoint(peer, witness);
      evidence.reopenAfterLockLoss = (await device.pendingWitness()) === null;
    }

    stage = "replacement-and-commit";
    const proposal = await witnessed(device, witness, () => device.prepareReplacement(id(0x1c), id(0x42), 7n));
    peer.receive_update_proposal(proposal.bytes, id(0x42), 7n);
    const commit = peer.prepare_commit(id(0x43), 7n);
    const applied = await witnessed(device, witness, () =>
      device.applyUpdateCommit(id(0x1d), id(0x43), 7n, commit.ciphertext()),
    );
    evidence.applied = {
      tag: applied.tag,
      epoch: Number(applied.epoch),
      removal: applied.removal,
      commitIdMatches: hex(applied.commitId) === hex(commit.commit_id()),
      authenticatorMatches: hex(applied.epochAuthenticator) === hex(commit.epoch_authenticator()),
    };
    evidence.peerEpochAfterCommit = Number(peer.epoch());
    // The epoch-ready send is a separate witnessed operation after the commit apply completed.
    evidence.pendingBetweenSplit = (await device.pendingWitness()) === null;
    const commitMetadata = {
      commitId: commit.commit_id(),
      targetEpoch: commit.target_epoch(),
      epochAuthenticator: commit.epoch_authenticator(),
    };
    {
      const wrongCommit = { ...commitMetadata, commitId: new Uint8Array(commitMetadata.commitId) };
      wrongCommit.commitId[0] ^= 1;
      const readyRead = await device.witnessReadRequest();
      await device.reconcileWitness(witness.respond(readyRead));
      evidence.epochReadyWrongCommit = await codeFrom(
        device.prepareEpochReady(id(0x1e), id(0x44), 0n, wrongCommit),
      );
    }
    const readyPayload = epochReadyPayload(peer, commit);
    const ready = await witnessed(device, witness, () =>
      device.prepareEpochReady(id(0x1e), id(0x44), 0n, commitMetadata),
    );
    evidence.epochReadyDelivered =
      hex(peer.receive_epoch_ready(ready.bytes, id(0x44), 0n)) === hex(readyPayload);
    {
      const secondRead = await device.witnessReadRequest();
      await device.reconcileWitness(witness.respond(secondRead));
      evidence.epochReadySecond = await codeFrom(
        device.prepareEpochReady(id(0x2e), id(0x4f), 0n, commitMetadata),
      );
    }
    const confirmation = peer.prepare_resync_control(id(0x46), 0n, textEncoder.encode("confirmed"));
    const confirmed = await witnessed(device, witness, () =>
      device.acceptEpochReadyConfirmation(id(0x1f), id(0x46), 0n, confirmation),
    );
    evidence.confirmation = {
      tag: confirmed.tag,
      messageClass: confirmed.messageClass,
      plaintext: textDecoder.decode(confirmed.bytes),
    };

    stage = "removal";
    const removal = peer.prepare_removal(id(0x47), 0n);
    const removed = await witnessed(device, witness, () =>
      device.applyRemoval(id(0x20), id(0x47), 0n, removal),
    );
    evidence.removed = { tag: removed.tag, epoch: Number(removed.epoch), removal: removed.removal };
    evidence.headAfterRemoval = Number((await metadata(databaseName)).confirmedCounter);

    stage = "quarantine-write-failure";
    {
      const read5 = await device.witnessReadRequest();
      await device.reconcileWitness(witness.respond(read5));
      // Same operation ID, different fingerprint: the terminal marker write is aborted. The
      // endpoint must fail closed rather than treat the unpersisted quarantine as done.
      const [code, aborted] = await withAbortedTransaction(isLifecycleTransaction, () =>
        codeFrom(device.applyRemoval(id(0x20), id(0x47), 1n, removal)),
      );
      evidence.quarantineWriteFailure = { code, aborted };
      evidence.lifecycleAfterFailedQuarantine = (await metadata(databaseName)).lifecycle;
      evidence.afterFailedQuarantine = await codeFrom(device.pendingWitness());
      evidence.storeAfterFailedQuarantine = await codeFrom(
        device.prepareApplication(id(0x21), id(0x4e), 7n, textEncoder.encode("x")),
      );
      await device.close();
    }

    stage = "conflict-quarantine";
    device = await openEndpoint(peer, witness);
    evidence.lifecycleBeforeConflict = (await metadata(databaseName)).lifecycle;
    {
      const read6 = await device.witnessReadRequest();
      await device.reconcileWitness(witness.respond(read6));
      evidence.conflict = await codeFrom(
        device.prepareActivation(id(0x12), id(0x40), textEncoder.encode("another activation payload")),
      );
      evidence.lifecycleAfterConflict = (await metadata(databaseName)).lifecycle;
      evidence.mutationAfterConflict = await codeFrom(
        device.prepareApplication(id(0x21), id(0x4e), 7n, textEncoder.encode("x")),
      );
      evidence.reconcileAfterConflict = (await device.reconcileWitness(new Uint8Array([1]))).tag;
      await device.close();
      evidence.reopenAfterConflict = await codeFrom(openEndpoint(peer, witness));
      device = undefined;
    }

    stage = "corrupt-stored-request";
    {
      // A fresh session with a pending register. The operation row caches the signed request
      // inside the sealed record; a corrupted cache must fail before open() exposes anything.
      const otherPeer = new TestPeerDaemonFixture(0xa1, Date.now());
      const otherName = `axl-e2ee-production-v1:${hex(otherPeer.crypto_session_id())}`;
      await deleteDatabase(otherName);
      const other = await BrowserDeviceEndpoint.create(createOptions(otherPeer, witness, id(0x10)));
      await other.endpoint.close();
      evidence.corruptedRequestOpen = [];
      for (const field of ["request", "requestHash"]) {
        const [[, intact]] = await readAll(otherName, "witness_operations_v2");
        await rewrite(otherName, "witness_operations_v2", intact.operationId, (value) => {
          const copy = new Uint8Array(value[field]);
          copy[copy.length - 1] ^= 1;
          return { ...value, [field]: copy };
        });
        evidence.corruptedRequestOpen.push(await codeFrom(openEndpoint(otherPeer, witness)));
        await rewrite(otherName, "witness_operations_v2", intact.operationId, () => intact);
      }
      const reopened = await openEndpoint(otherPeer, witness);
      const pending = await reopened.pendingWitness();
      evidence.intactRequestReopens = pending !== null && pending.kind === "register";

      stage = "forged-certificate";
      const genuine = witness.respond(pending.witnessRequest);
      const forged = new Uint8Array(genuine);
      forged[forged.length - 1] ^= 1;
      evidence.forgedCertificate = await codeFrom(reopened.continueWitness(pending.operationId, forged));
      evidence.lifecycleAfterForgery = (await metadata(otherName)).lifecycle;
      evidence.genuineAfterQuarantine = await codeFrom(
        reopened.continueWitness(pending.operationId, genuine),
      );
      await reopened.close();
      evidence.reopenAfterForgery = await codeFrom(openEndpoint(otherPeer, witness));
      await deleteDatabase(otherName);
      otherPeer.free();
    }

    stage = "schema";
    {
      const probes = [];
      const probeStore = () => {
        const probe = new ProductionBrowserStore(session);
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
      evidence.missingEndpointOpen = await codeFrom(openEndpoint(peer, witness));
      // A failed open or create owns nothing: with every probe still unclosed, the next opener
      // for the session must not see lifecycle_busy.
      const successor = probeStore();
      await successor.create();
      evidence.createAfterFailedOpen = "created";
      for (const probe of probes) await probe.close();
      evidence.schema = {
        version: PRODUCTION_BROWSER_STORAGE_SCHEMA.databaseVersion,
        stores: [...PRODUCTION_BROWSER_STORAGE_SCHEMA.stores],
      };
    }
    return evidence;
  } catch (cause) {
    throw new Error(`${stage}:${String(cause)}`);
  } finally {
    await device?.close();
    await competing?.close();
    await deleteDatabase(databaseName).catch(() => {});
    peer.free();
    witness.free();
  }
}

/**
 * Worker-termination evidence, phase 1: create the endpoint and leave its register pending with
 * the worker alive. The page terminates this worker afterwards.
 */
const terminationPeers = new Map();

export async function runDeviceTerminationPhaseOne() {
  const witness = new TestWitness();
  const peer = new TestPeerDaemonFixture(0xb1, Date.now());
  const databaseName = `axl-e2ee-production-v1:${hex(peer.crypto_session_id())}`;
  await deleteDatabase(databaseName);
  const created = await BrowserDeviceEndpoint.create(createOptions(peer, witness, id(0x10)));
  terminationPeers.set(databaseName, { device: created.endpoint, peer, witness });
  return {
    status: created.pending.status,
    kind: created.pending.kind,
    requestHex: hex(created.pending.witnessRequest),
    lifecycle: (await metadata(databaseName)).lifecycle,
  };
}

/**
 * Phase 2, in a fresh worker after termination: reopen, recover the exact pending request, and
 * complete it. The lock the terminated worker held must be gone.
 */
export async function runDeviceTerminationPhaseTwo() {
  const witness = new TestWitness();
  const peer = new TestPeerDaemonFixture(0xb1, Date.now());
  const databaseName = `axl-e2ee-production-v1:${hex(peer.crypto_session_id())}`;
  let device;
  try {
    device = await openEndpoint(peer, witness);
    const pending = await device.pendingWitness();
    const read = await device.witnessReadRequest();
    const reconciliation = (await device.reconcileWitness(witness.respond(read))).tag;
    const result = await device.continueWitness(pending.operationId, witness.respond(pending.witnessRequest));
    return {
      requestHex: hex(pending.witnessRequest),
      reconciliation,
      resultTag: result.tag,
      keyPackageBytes: result.bytes.byteLength,
      head: Number((await metadata(databaseName)).confirmedCounter),
    };
  } finally {
    await device?.close();
    await deleteDatabase(databaseName).catch(() => {});
    peer.free();
    witness.free();
  }
}
