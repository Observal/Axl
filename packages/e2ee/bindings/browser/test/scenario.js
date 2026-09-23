// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import * as binding from "/package/loader/index.js";

function errorResult(error) {
  return { name: error.name, code: error.code, message: error.message };
}

function workerClient(url) {
  const worker = new Worker(url, { type: "module" });
  let id = 0;
  const pending = new Map();
  const events = [];
  const eventWaiters = [];
  worker.addEventListener("message", ({ data }) => {
    if (typeof data?.event === "string") {
      if (data.event === "fatal") {
        for (const entry of pending.values()) entry.reject(new binding.AxlE2eeError(data.code));
        pending.clear();
      }
      const waiter = eventWaiters.shift();
      if (waiter) waiter(data);
      else events.push(data);
      return;
    }
    const entry = pending.get(data?.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok === true) entry.resolve(data.value);
    else entry.reject(new binding.AxlE2eeError(data.code));
  });
  worker.addEventListener("error", () => {
    for (const entry of pending.values()) entry.reject(new binding.AxlE2eeError("internal_error"));
    pending.clear();
  });
  return {
    request(operation, bytes) {
      const message = { operation };
      const transfer = [];
      if (bytes !== undefined) {
        const copy = new Uint8Array(bytes);
        message.bytes = copy;
        transfer.push(copy.buffer);
      }
      return this.requestData(message, transfer);
    },
    requestData(message, transfer = []) {
      const requestId = (id += 1);
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        worker.postMessage({ id: requestId, ...message }, transfer);
      });
    },
    nextEvent() {
      if (events.length > 0) return Promise.resolve(events.shift());
      return new Promise((resolve) => eventWaiters.push(resolve));
    },
    requestUnchecked(operation, bytes) {
      const requestId = (id += 1);
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        worker.postMessage({ id: requestId, operation, bytes });
      });
    },
    close() {
      for (const entry of pending.values()) entry.reject(new binding.AxlE2eeError("endpoint_closed"));
      pending.clear();
      worker.terminate();
    },
  };
}

export function testWorker(query = "") {
  return workerClient(`/test-artifact/worker/index.js${query}`);
}

const persistenceWorker = (query = "") => testWorker(query);
const sender = false;
const receiver = true;
const op = (value) => value.toString(16).padStart(32, "0");

async function errorCode(promise) {
  try {
    await promise;
    return "unexpected_success";
  } catch (error) {
    return error.code;
  }
}

async function clean(receive = sender) {
  const worker = persistenceWorker();
  await worker.requestData({ operation: "persistence_delete", receive });
  worker.close();
}

async function closePersistence(worker) {
  await worker.requestData({ operation: "persistence_close" });
  worker.close();
}

async function acquireAfterEmbeddedPageTermination() {
  const frame = document.createElement("iframe");
  frame.src = "/";
  document.body.append(frame);
  await new Promise((resolve, reject) => {
    frame.addEventListener("load", resolve, { once: true });
    frame.addEventListener("error", reject, { once: true });
  });
  await new Promise((resolve) => {
    const poll = () => {
      if (frame.contentWindow?.axlBrowserTest) resolve();
      else setTimeout(poll, 10);
    };
    poll();
  });
  let frameWorker = frame.contentWindow.axlBrowserTest.testWorker();
  await frameWorker.requestData({ operation: "persistence_open", receive: sender });
  frame.remove();
  frameWorker = undefined;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const successor = persistenceWorker();
    try {
      const opened = await successor.requestData({ operation: "persistence_open", receive: sender });
      await closePersistence(successor);
      return opened.generation;
    } catch (error) {
      successor.close();
      if (error.code !== "lifecycle_busy") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new binding.AxlE2eeError("lifecycle_busy");
}

function productionWorker() {
  return workerClient("/package/worker/index.js");
}

export async function runLifecycleScenario() {
  const info = await binding.getBindingInfo();
  const invitation = new Uint8Array(
    await (await fetch("/fixtures/pairing-invitation.tls")).arrayBuffer(),
  );
  const claim = new Uint8Array(
    await (await fetch("/fixtures/pairing-claim-v1.tls")).arrayBuffer(),
  );
  const invitationPromise = binding.inspectPairingInvitation(invitation);
  const claimPromise = binding.inspectPairingClaim(claim);
  invitation.fill(0);
  claim.fill(0);
  const inspectedInvitation = await invitationPromise;
  const inspectedClaim = await claimPromise;

  const endpointErrors = [];
  for (const operation of [
    binding.createDaemonEndpoint,
    binding.openDaemonEndpoint,
    binding.createDeviceEndpoint,
    binding.openDeviceEndpoint,
  ]) {
    try {
      await operation();
    } catch (error) {
      endpointErrors.push(errorResult(error));
    }
  }

  const worker = testWorker();
  const lifecycle = await worker.request("openmls_lifecycle");
  worker.close();
  return {
    info,
    invitation: {
      ...inspectedInvitation,
      cryptoSessionId: [...inspectedInvitation.cryptoSessionId],
    },
    claim: { ...inspectedClaim, cryptoSessionId: [...inspectedClaim.cryptoSessionId] },
    endpointErrors,
    lifecycle,
  };
}

export async function runNegativeOpenMlsScenario() {
  const worker = testWorker();
  const evidence = await worker.request("openmls_negative_cases");
  worker.close();
  return evidence;
}

export async function runBoundaryScenario() {
  const maximumClaim = new Uint8Array(
    await (await fetch("/fixtures/pairing-claim-v1-maximum.tls")).arrayBuffer(),
  );
  let maximumClaimCode;
  try {
    await binding.inspectPairingClaim(maximumClaim);
  } catch (error) {
    maximumClaimCode = error.code;
  }
  let javascriptCode;
  try {
    await binding.inspectPairingInvitation(new Uint8Array(2049));
  } catch (error) {
    javascriptCode = error.code;
  }
  let redactedError;
  try {
    await binding.inspectPairingClaim(new TextEncoder().encode("SENSITIVE_SENTINEL"));
  } catch (error) {
    redactedError = errorResult(error);
  }

  const production = productionWorker();
  let workerInvitationCode;
  let workerClaimCode;
  let workerTypeCode;
  try {
    await production.request("inspect_invitation", new Uint8Array(2049));
  } catch (error) {
    workerInvitationCode = error.code;
  }
  try {
    await production.request("inspect_claim", new Uint8Array(17321));
  } catch (error) {
    workerClaimCode = error.code;
  }
  try {
    await production.requestUnchecked("inspect_claim", new ArrayBuffer(1));
  } catch (error) {
    workerTypeCode = error.code;
  }
  production.close();

  const rust = testWorker();
  let rustInvitationCode;
  let rustClaimCode;
  try {
    await rust.request("inspect_invitation_rust_bound", new Uint8Array(2049));
  } catch (error) {
    rustInvitationCode = error.code;
  }
  try {
    await rust.request("inspect_claim_rust_bound", new Uint8Array(17321));
  } catch (error) {
    rustClaimCode = error.code;
  }
  rust.close();
  return {
    maximumClaimCode,
    javascriptCode,
    redactedError,
    workerInvitationCode,
    workerClaimCode,
    workerTypeCode,
    rustInvitationCode,
    rustClaimCode,
  };
}

async function malformedResponseScenario() {
  const OriginalWorker = globalThis.Worker;
  let created = 0;
  class MalformedWorker {
    listeners = new Map();
    constructor() {
      created += 1;
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    postMessage(message) {
      queueMicrotask(() =>
        this.listeners.get("message")?.({ data: { id: message.id, ok: true, value: {} } }),
      );
    }
    terminate() {}
  }
  globalThis.Worker = MalformedWorker;
  try {
    const malformedBinding = await import(`/package/loader/index.js?malformed=${crypto.randomUUID()}`);
    const pendingCodes = await Promise.all(
      [malformedBinding.getBindingInfo(), malformedBinding.getBindingInfo()].map(async (promise) => {
        try {
          await promise;
          return "unexpected_success";
        } catch (error) {
          return error.code;
        }
      }),
    );
    let useAfterFatalCode;
    try {
      await malformedBinding.getBindingInfo();
    } catch (error) {
      useAfterFatalCode = error.code;
    }
    malformedBinding.closeBrowserBinding();
    return { pendingCodes, useAfterFatalCode, workersCreated: created };
  } finally {
    globalThis.Worker = OriginalWorker;
  }
}

export async function runStateScenario() {
  const normal = testWorker();
  const probe = await normal.request("secure_random_probe");
  normal.close();
  const unavailable = testWorker("?secureRandom=unavailable");
  let unavailableCode;
  try {
    await unavailable.request("secure_random_probe");
  } catch (error) {
    unavailableCode = error.code;
  }
  unavailable.close();

  const malformed = await malformedResponseScenario();
  const closeBinding = await import(`/package/loader/index.js?close=${crypto.randomUUID()}`);
  const pending = closeBinding.getBindingInfo();
  closeBinding.closeBrowserBinding();
  closeBinding.closeBrowserBinding();
  let pendingCode;
  let useAfterCloseCode;
  let endpointAfterCloseCode;
  try {
    await pending;
  } catch (error) {
    pendingCode = error.code;
  }
  try {
    await closeBinding.getBindingInfo();
  } catch (error) {
    useAfterCloseCode = error.code;
  }
  try {
    await closeBinding.openDeviceEndpoint();
  } catch (error) {
    endpointAfterCloseCode = error.code;
  }
  return {
    ...probe,
    unavailableCode,
    malformed,
    pendingCode,
    useAfterCloseCode,
    endpointAfterCloseCode,
  };
}

export async function runPersistenceScenario() {
  await clean(receiver);
  let creationWorker = persistenceWorker();
  const creationBeforePromise = creationWorker.requestData({
    operation: "persistence_create",
    receive: receiver,
    fault: "terminate_before_commit",
  });
  const creationBeforeEvent = await creationWorker.nextEvent();
  creationWorker.close();
  await errorCode(creationBeforePromise);
  creationWorker = persistenceWorker();
  const creationAfterBeforeTermination = await creationWorker.requestData({
    operation: "persistence_create",
    receive: receiver,
    fault: null,
  });
  await closePersistence(creationWorker);

  await clean(receiver);
  creationWorker = persistenceWorker();
  const creationAfterPromise = creationWorker.requestData({
    operation: "persistence_create",
    receive: receiver,
    fault: "terminate_after_commit",
  });
  const creationAfterEvent = await creationWorker.nextEvent();
  creationWorker.close();
  await errorCode(creationAfterPromise);
  creationWorker = persistenceWorker();
  const recoveredCreation = await creationWorker.requestData({
    operation: "persistence_create",
    receive: receiver,
    fault: null,
  });
  const recoveredCreationTransition = await creationWorker.requestData({
    operation: "persistence_operate",
    operationId: "c1".repeat(16),
    payload: recoveredCreation.input,
    fault: null,
  });
  await closePersistence(creationWorker);

  await clean();
  creationWorker = persistenceWorker();
  const creationAmbiguous = await errorCode(
    creationWorker.requestData({
      operation: "persistence_create",
      receive: sender,
      fault: "ambiguous_after_commit",
    }),
  );
  creationWorker.close();
  creationWorker = persistenceWorker();
  const recoveredAmbiguousCreation = await creationWorker.requestData({
    operation: "persistence_create",
    receive: sender,
    fault: null,
  });
  await closePersistence(creationWorker);

  await clean();
  let worker = persistenceWorker();
  const created = await worker.requestData({
    operation: "persistence_create",
    receive: sender,
    fault: null,
  });
  const first = await worker.requestData({
    operation: "persistence_operate",
    operationId: op(0x10),
    payload: "exact retry",
    fault: null,
  });
  await closePersistence(worker);

  worker = persistenceWorker();
  const reopened = await worker.requestData({ operation: "persistence_open", receive: sender });
  const duplicate = await worker.requestData({
    operation: "persistence_operate",
    operationId: op(0x10),
    payload: "exact retry",
    fault: null,
  });
  const conflict = await errorCode(
    worker.requestData({
      operation: "persistence_operate",
      operationId: op(0x10),
      payload: "conflicting input",
      fault: null,
    }),
  );
  const aborted = await errorCode(
    worker.requestData({
      operation: "persistence_operate",
      operationId: op(0x11),
      payload: "abort candidate",
      fault: "abort_before_commit",
    }),
  );
  const afterAbort = await worker.requestData({
    operation: "persistence_operate",
    operationId: op(0x11),
    payload: "abort candidate",
    fault: null,
  });
  const quota = await errorCode(
    worker.requestData({
      operation: "persistence_operate",
      operationId: op(0x12),
      payload: "quota candidate",
      fault: "quota",
    }),
  );
  const ambiguous = await errorCode(
    worker.requestData({
      operation: "persistence_operate",
      operationId: op(0x13),
      payload: "ambiguous candidate",
      fault: "ambiguous_after_commit",
    }),
  );
  worker.close();

  worker = persistenceWorker();
  await worker.requestData({ operation: "persistence_open", receive: sender });
  const recoveredAmbiguous = await worker.requestData({
    operation: "persistence_operate",
    operationId: op(0x13),
    payload: "ambiguous candidate",
    fault: null,
  });
  const held = worker;
  const contender = persistenceWorker();
  const contention = await errorCode(
    contender.requestData({ operation: "persistence_open", receive: sender }),
  );
  contender.close();
  await closePersistence(held);
  const afterPageTerminationGeneration = await acquireAfterEmbeddedPageTermination();

  worker = persistenceWorker();
  await worker.requestData({ operation: "persistence_open", receive: sender });
  const beforeCommitPromise = worker.requestData({
    operation: "persistence_operate",
    operationId: op(0x14),
    payload: "terminate before commit",
    fault: "terminate_before_commit",
  });
  const beforeEvent = await worker.nextEvent();
  worker.close();
  await errorCode(beforeCommitPromise);
  worker = persistenceWorker();
  await worker.requestData({ operation: "persistence_open", receive: sender });
  const afterTerminationBefore = await worker.requestData({
    operation: "persistence_operate",
    operationId: op(0x14),
    payload: "terminate before commit",
    fault: null,
  });

  const afterCommitPromise = worker.requestData({
    operation: "persistence_operate",
    operationId: op(0x15),
    payload: "terminate after commit",
    fault: "terminate_after_commit",
  });
  const afterEvent = await worker.nextEvent();
  worker.close();
  await errorCode(afterCommitPromise);
  worker = persistenceWorker();
  await worker.requestData({ operation: "persistence_open", receive: sender });
  const afterTerminationAfter = await worker.requestData({
    operation: "persistence_operate",
    operationId: op(0x15),
    payload: "terminate after commit",
    fault: null,
  });
  let ciphertextReleased = false;
  const completionPromise = worker
    .requestData({
      operation: "persistence_operate",
      operationId: op(0x16),
      payload: "completion ordering",
      fault: "observe_completion",
    })
    .then((value) => {
      ciphertextReleased = true;
      return value;
    });
  const completionEvent = await worker.nextEvent();
  const ciphertextReleasedBeforeCompletion = ciphertextReleased;
  await completionPromise;
  const callbackException = await errorCode(
    worker.requestData({ operation: "persistence_callback_exception" }),
  );
  worker.close();
  const callbackSuccessor = persistenceWorker();
  const afterCallback = await callbackSuccessor.requestData({
    operation: "persistence_open",
    receive: sender,
  });
  const inputBounds = {
    oversizedPlaintext: await errorCode(
      callbackSuccessor.requestData({
        operation: "persistence_operate",
        operationId: op(0x70),
        payload: "x".repeat(60_001),
        fault: null,
      }),
    ),
    oversizedCiphertext: await errorCode(
      callbackSuccessor.requestData({
        operation: "persistence_operate",
        operationId: op(0x71),
        payload: new Array(65_498).fill(0),
        fault: null,
      }),
    ),
    invalidByte: await errorCode(
      callbackSuccessor.requestData({
        operation: "persistence_operate",
        operationId: op(0x72),
        payload: [256],
        fault: null,
      }),
    ),
    sparseByteArray: await errorCode(
      callbackSuccessor.requestData({
        operation: "persistence_operate",
        operationId: op(0x74),
        payload: new Array(1),
        fault: null,
      }),
    ),
    unknownFault: await errorCode(
      callbackSuccessor.requestData({
        operation: "persistence_operate",
        operationId: op(0x73),
        payload: "unknown fault",
        fault: "not_a_fault",
      }),
    ),
    unknownTamper: await errorCode(
      callbackSuccessor.requestData({ operation: "persistence_tamper", kind: "not_a_tamper" }),
    ),
  };
  const forcedClose = await errorCode(
    callbackSuccessor.requestData({ operation: "persistence_tamper", kind: "forced_close" }),
  );
  callbackSuccessor.close();

  const unavailableWorker = persistenceWorker("?indexedDb=unavailable");
  const unavailable = await errorCode(
    unavailableWorker.requestData({ operation: "persistence_open", receive: sender }),
  );
  unavailableWorker.close();

  await clean();
  const orderingWorker = persistenceWorker();
  await orderingWorker.requestData({
    operation: "persistence_create",
    receive: sender,
    fault: null,
  });
  const highOperation = await orderingWorker.requestData({
    operation: "persistence_operate",
    operationId: op(0xf0),
    payload: "high operation id",
    fault: null,
  });
  const lowOperation = await orderingWorker.requestData({
    operation: "persistence_operate",
    operationId: op(0x80),
    payload: "low operation id",
    fault: null,
  });
  await closePersistence(orderingWorker);
  const orderingReopen = persistenceWorker();
  await orderingReopen.requestData({ operation: "persistence_open", receive: sender });
  const highRetry = await orderingReopen.requestData({
    operation: "persistence_operate",
    operationId: op(0xf0),
    payload: "high operation id",
    fault: null,
  });
  const lowRetry = await orderingReopen.requestData({
    operation: "persistence_operate",
    operationId: op(0x80),
    payload: "low operation id",
    fault: null,
  });
  await closePersistence(orderingReopen);

  await clean(receiver);
  const receiveWorker = persistenceWorker();
  const receiveCreated = await receiveWorker.requestData({
    operation: "persistence_create",
    receive: receiver,
    fault: null,
  });
  let plaintextReleased = false;
  const receivePromise = receiveWorker
    .requestData({
      operation: "persistence_operate",
      operationId: "c1".repeat(16),
      payload: receiveCreated.input,
      fault: "observe_completion",
    })
    .then((value) => {
      plaintextReleased = true;
      return value;
    });
  const receiveCompletionEvent = await receiveWorker.nextEvent();
  const plaintextReleasedBeforeCompletion = plaintextReleased;
  const receiveResult = await receivePromise;
  const secondReceiveResult = await receiveWorker.requestData({
    operation: "persistence_operate",
    operationId: "c2".repeat(16),
    payload: receiveCreated.additionalInput,
    fault: null,
  });
  await closePersistence(receiveWorker);
  const receiveReopen = persistenceWorker();
  await receiveReopen.requestData({ operation: "persistence_open", receive: receiver });
  const receiveDuplicate = await receiveReopen.requestData({
    operation: "persistence_operate",
    operationId: "c1".repeat(16),
    payload: receiveCreated.input,
    fault: null,
  });
  const secondReceiveDuplicate = await receiveReopen.requestData({
    operation: "persistence_operate",
    operationId: "c2".repeat(16),
    payload: receiveCreated.additionalInput,
    fault: null,
  });
  await closePersistence(receiveReopen);

  const corruption = {};
  for (const kind of [
    "manifest",
    "state",
    "schema",
    "rollback",
    "malformed",
    "unexpected",
    "cyclic",
    "oversized",
    "excessive",
  ]) {
    await clean();
    const corruptor = persistenceWorker();
    await corruptor.requestData({ operation: "persistence_create", receive: sender, fault: null });
    await corruptor.requestData({ operation: "persistence_tamper", kind });
    await closePersistence(corruptor);
    const opener = persistenceWorker();
    corruption[kind] = await errorCode(
      opener.requestData({ operation: "persistence_open", receive: sender }),
    );
    opener.close();
  }

  await clean();
  const lossWorker = persistenceWorker();
  await lossWorker.requestData({ operation: "persistence_create", receive: sender, fault: null });
  await lossWorker.requestData({ operation: "persistence_tamper", kind: "missing" });
  await closePersistence(lossWorker);
  let lossOpener = persistenceWorker();
  const stateLoss = await errorCode(
    lossOpener.requestData({ operation: "persistence_open", receive: sender }),
  );
  lossOpener.close();
  lossOpener = persistenceWorker();
  const rePairRequired = await errorCode(
    lossOpener.requestData({ operation: "persistence_open", receive: sender }),
  );
  lossOpener.close();

  await clean();
  const newerCreator = persistenceWorker();
  await newerCreator.requestData({ operation: "persistence_create", receive: sender, fault: null });
  await closePersistence(newerCreator);
  const newerUpgrader = persistenceWorker();
  await newerUpgrader.requestData({ operation: "persistence_newer_schema", receive: sender });
  newerUpgrader.close();
  const newerOpener = persistenceWorker();
  const newerDatabase = await errorCode(
    newerOpener.requestData({ operation: "persistence_open", receive: sender }),
  );
  newerOpener.close();

  await clean();
  const generationWorker = persistenceWorker();
  await generationWorker.requestData({ operation: "persistence_create", receive: sender, fault: null });
  const generationConflict = await errorCode(
    generationWorker.requestData({
      operation: "persistence_operate",
      operationId: op(0x30),
      payload: "generation conflict",
      fault: "generation_conflict",
    }),
  );
  await closePersistence(generationWorker);
  const generationSuccessor = persistenceWorker();
  const generationAfterConflict = await generationSuccessor.requestData({
    operation: "persistence_open",
    receive: sender,
  });
  const generationRetry = await generationSuccessor.requestData({
    operation: "persistence_operate",
    operationId: op(0x30),
    payload: "generation conflict",
    fault: null,
  });
  await closePersistence(generationSuccessor);

  const upgradeWorker = persistenceWorker();
  const upgrade = await upgradeWorker.requestData({
    operation: "persistence_upgrade",
    receive: sender,
  });
  upgradeWorker.close();

  await clean();
  return {
    creationBeforeEvent: creationBeforeEvent.event,
    creationAfterBeforeTerminationDuplicate: creationAfterBeforeTermination.duplicate,
    creationAfterEvent: creationAfterEvent.event,
    recoveredCreationDuplicate: recoveredCreation.duplicate,
    recoveredCreationGeneration: recoveredCreation.generation,
    recoveredCreationStrict: recoveredCreation.strictDurability,
    recoveredCreationPlaintext: new TextDecoder().decode(
      new Uint8Array(recoveredCreationTransition.bytes),
    ),
    creationAmbiguous,
    recoveredAmbiguousCreationDuplicate: recoveredAmbiguousCreation.duplicate,
    recoveredAmbiguousCreationGeneration: recoveredAmbiguousCreation.generation,
    created,
    reopened,
    exactRetry: first.bytes.join(",") === duplicate.bytes.join(","),
    duplicate: duplicate.duplicate,
    conflict,
    aborted,
    abortReleasedBytes: false,
    afterAbortDuplicate: afterAbort.duplicate,
    quota,
    ambiguous,
    ambiguousReleasedBytes: false,
    recoveredAmbiguous: recoveredAmbiguous.duplicate,
    contention,
    afterPageTerminationGeneration,
    beforeEvent: beforeEvent.event,
    afterTerminationBefore: afterTerminationBefore.duplicate,
    afterEvent: afterEvent.event,
    afterTerminationAfter: afterTerminationAfter.duplicate,
    completionEvent: completionEvent.event,
    ciphertextReleasedBeforeCompletion,
    callbackException,
    afterCallbackGeneration: afterCallback.generation,
    inputBounds,
    forcedClose,
    unavailable,
    canonicalOrdering: {
      highDuplicate: highRetry.duplicate,
      highExact: highOperation.bytes.join(",") === highRetry.bytes.join(","),
      lowDuplicate: lowRetry.duplicate,
      lowExact: lowOperation.bytes.join(",") === lowRetry.bytes.join(","),
    },
    receiveCompletionEvent: receiveCompletionEvent.event,
    plaintextReleasedBeforeCompletion,
    receivePlaintext: new TextDecoder().decode(new Uint8Array(receiveResult.bytes)),
    receiveDuplicate: receiveDuplicate.duplicate,
    receiveExact:
      receiveResult.bytes.join(",") === receiveDuplicate.bytes.join(","),
    secondReceivePlaintext: new TextDecoder().decode(new Uint8Array(secondReceiveResult.bytes)),
    secondReceiveDuplicate: secondReceiveDuplicate.duplicate,
    secondReceiveExact:
      secondReceiveResult.bytes.join(",") === secondReceiveDuplicate.bytes.join(","),
    corruption,
    stateLoss,
    rePairRequired,
    newerDatabase,
    generationConflict,
    generationAfterConflict: generationAfterConflict.generation,
    generationRetryDuplicate: generationRetry.duplicate,
    upgrade,
    lifecycleEvidence: "not_exposed_by_browser",
  };
}

export async function runProductionBarrierScenario() {
  const worker = testWorker();
  try {
    return await worker.requestData({ operation: "production_barrier_scenario" });
  } finally {
    worker.close();
  }
}

export async function runAllScenarios() {
  return {
    lifecycle: await runLifecycleScenario(),
    negativeOpenMls: await runNegativeOpenMlsScenario(),
    boundaries: await runBoundaryScenario(),
    state: await runStateScenario(),
    productionBarrier: await runProductionBarrierScenario(),
    persistence: await runPersistenceScenario(),
  };
}
