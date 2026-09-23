// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

// Test-side witness barrier driver.
//
// Production transports live in the SDK and daemon (later integration commits). These helpers
// exercise the endpoint-owned witness API exactly as that transport must: fresh read, reconcile,
// mutate, send the exact pending request, continue with the unanimous certificate. Nothing here
// inspects or alters request or certificate bytes.

import { AxlE2eeError } from "./fixture-loader.mjs";

export async function reconcile(endpoint, witness) {
  const read = await endpoint.witnessReadRequest();
  return endpoint.reconcileWitness(witness.respond(read));
}

export async function complete(endpoint, witness, pending) {
  return endpoint.continueWitness(pending.operationId, witness.respond(pending.request));
}

/** Reconcile until one mutation is authorized, finishing any resend or accepted recovery. */
export async function authorize(endpoint, witness) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = await reconcile(endpoint, witness);
    switch (outcome.tag) {
      case "ready":
        return;
      case "resend_pending":
      case "recover_accepted": {
        const pending = await endpoint.pendingWitness();
        if (!pending) throw new AxlE2eeError("fresh_witness_required");
        await complete(endpoint, witness, pending);
        break;
      }
      case "revoked":
        throw new AxlE2eeError("endpoint_revoked");
      case "quarantined":
        throw new AxlE2eeError("rollback_detected");
      default:
        throw new AxlE2eeError("witness_unavailable");
    }
  }
  throw new AxlE2eeError("witness_unavailable");
}

/** Full barrier for one mutation: fresh read, reconcile, mutate, and continue. */
export async function witnessed(endpoint, witness, mutate) {
  await authorize(endpoint, witness);
  const outcome = await mutate();
  if (outcome.tag === "released") return outcome.result;
  return complete(endpoint, witness, outcome.pending);
}

function requireField(result, field) {
  const value = result[field];
  if (value === undefined || value === null) {
    throw new TypeError(`expected a ${field} result, received ${result.tag}`);
  }
  return value;
}

function derivedOperationId(operationId, salt) {
  const derived = Buffer.from(operationId);
  derived[0] ^= salt;
  return derived;
}

/**
 * Adapt a witnessed endpoint to the direct-result shape the SDK and daemon adapters still expect
 * before their own witness integration. Every call runs the complete barrier against the given
 * in-process witness and returns only released exact results. Calls are serialized so that two
 * SDK operations never interleave their read, mutate, and continue steps on one endpoint.
 */
export function witnessedFacade(endpoint, witness) {
  let tail = Promise.resolve();
  const serialized = (work) => {
    const run = tail.then(work, work);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const run = (mutate) => serialized(() => witnessed(endpoint, witness, mutate));
  const facade = {
    prepareApplication: (...args) =>
      run(() => endpoint.prepareApplication(...args)).then((r) => requireField(r, "outbox")),
    receiveApplication: (...args) =>
      run(() => endpoint.receiveApplication(...args)).then((r) => requireField(r, "plaintext")),
    prepareReplacement: (...args) =>
      run(() => endpoint.prepareReplacement(...args)).then((r) => requireField(r, "outbox")),
    receiveReplacementProposal: (...args) =>
      run(() => endpoint.receiveReplacementProposal(...args)).then(() => "accepted"),
    createUpdateCommit: (...args) =>
      run(() => endpoint.createUpdateCommit(...args)).then((r) => requireField(r, "outbox")),
    acceptEpochReady: (...args) =>
      run(() => endpoint.acceptEpochReady(...args)).then((r) => requireField(r, "epochReady")),
    prepareEpochReadyConfirmation: (...args) =>
      run(() => endpoint.prepareEpochReadyConfirmation(...args)).then((r) => requireField(r, "outbox")),
    async applyReceivedUpdateCommit(operationId, ciphertext, commitLogicalId, generation, readyLogicalId) {
      const applied = await run(() =>
        endpoint.applyReceivedUpdateCommit(operationId, ciphertext, commitLogicalId, generation),
      );
      const commit = requireField(applied, "commit");
      const ready = await run(() =>
        endpoint.prepareEpochReady(derivedOperationId(operationId, 0x5a), readyLogicalId, generation, commit),
      );
      const record = requireField(ready, "outbox");
      // The pre-integration SDK frames the epoch-ready envelope under the apply operation ID.
      // The durable record keeps its own operation ID; only this returned view is renamed.
      return Object.freeze({
        operationId: Buffer.from(operationId),
        cryptoSessionId: record.cryptoSessionId,
        logicalMessageId: record.logicalMessageId,
        messageClass: record.messageClass,
        epoch: record.epoch,
        hostedGrantGeneration: record.hostedGrantGeneration,
        profileRevision: record.profileRevision,
        retryState: record.retryState,
        ciphertext: record.ciphertext,
      });
    },
    acceptEpochReadyConfirmation: (...args) =>
      run(() => endpoint.acceptEpochReadyConfirmation(...args)).then((r) => requireField(r, "status")),
    acknowledgeOutbox: (...args) =>
      run(() => endpoint.acknowledgeOutbox(...args)).then((r) => requireField(r, "outbox")),
    acknowledgeReceive: (...args) =>
      run(() => endpoint.acknowledgeReceive(...args)).then(() => "acknowledged"),
    pendingOutbox: () => serialized(() => endpoint.pendingOutbox()),
    pairStatus: () => serialized(() => endpoint.pairStatus()),
    close: () => endpoint.close(),
  };
  return facade;
}
