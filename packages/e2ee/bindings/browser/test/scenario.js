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
  worker.addEventListener("message", ({ data }) => {
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
      const requestId = (id += 1);
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        const message = { id: requestId, operation };
        const transfer = [];
        if (bytes !== undefined) {
          const copy = new Uint8Array(bytes);
          message.bytes = copy;
          transfer.push(copy.buffer);
        }
        worker.postMessage(message, transfer);
      });
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

export async function runAllScenarios() {
  return {
    lifecycle: await runLifecycleScenario(),
    negativeOpenMls: await runNegativeOpenMlsScenario(),
    boundaries: await runBoundaryScenario(),
    state: await runStateScenario(),
  };
}
