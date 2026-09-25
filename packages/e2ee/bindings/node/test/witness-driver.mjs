// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

// Test-side witness barrier driver for the binding tests.
//
// The SDK `WitnessedEndpoint` and the daemon `DaemonWitnessBarrier` are the production sequencers.
// These helpers drive the endpoint-owned witness API the same way against the in-process test
// witness: fresh read, reconcile, mutate, send the exact pending request, continue with the
// unanimous certificate. Nothing here inspects or alters request or certificate bytes.

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

/**
 * Terse released-result view of one endpoint for the binding lifecycle test. Every call runs the
 * complete barrier and returns only the released typed field. Calls are serialized so that two
 * barriers never interleave on one endpoint. Test scaffolding; not part of the artifact.
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
  const released = (field, mutate) =>
    serialized(() => witnessed(endpoint, witness, mutate)).then((r) => requireField(r, field));
  return {
    prepareApplication: (...args) => released("outbox", () => endpoint.prepareApplication(...args)),
    receiveApplication: (...args) => released("plaintext", () => endpoint.receiveApplication(...args)),
    prepareReplacement: (...args) => released("outbox", () => endpoint.prepareReplacement(...args)),
    receiveReplacementProposal: (...args) =>
      released("accepted", () => endpoint.receiveReplacementProposal(...args)).then(() => "accepted"),
    createUpdateCommit: (...args) => released("outbox", () => endpoint.createUpdateCommit(...args)),
    acceptEpochReady: (...args) => released("epochReady", () => endpoint.acceptEpochReady(...args)),
    prepareEpochReadyConfirmation: (...args) =>
      released("outbox", () => endpoint.prepareEpochReadyConfirmation(...args)),
    acceptEpochReadyConfirmation: (...args) =>
      released("status", () => endpoint.acceptEpochReadyConfirmation(...args)),
    acknowledgeOutbox: (...args) => released("outbox", () => endpoint.acknowledgeOutbox(...args)),
    acknowledgeReceive: (...args) =>
      released("accepted", () => endpoint.acknowledgeReceive(...args)).then(() => "acknowledged"),
    pendingOutbox: () => serialized(() => endpoint.pendingOutbox()),
    pairStatus: () => serialized(() => endpoint.pairStatus()),
    close: () => endpoint.close(),
  };
}
