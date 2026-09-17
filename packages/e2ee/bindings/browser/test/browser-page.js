// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import * as binding from "/package/loader/index.js";
import { ProductionBrowserStore } from "/package/worker/storage.js";
import {
  runAllScenarios,
  runBoundaryScenario,
  runLifecycleScenario,
  runNegativeOpenMlsScenario,
  runPersistenceScenario,
  runStateScenario,
  testWorker,
} from "/test/scenario.js";

async function deleteDatabase(name) {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener("success", resolve, { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("blocked", () => reject(new Error("blocked")), { once: true });
  });
}

function decodeHex(value) {
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

async function runProductionWitnessVerifierScenario() {
  const wasm = await import("/package/wasm/axl_e2ee_browser.js");
  const bytes = await (await fetch("/package/wasm/axl_e2ee_browser_bg.wasm")).arrayBuffer();
  await wasm.default({ module_or_path: bytes });
  const expected = Object.fromEntries(
    (await (await fetch("/fixtures/witness-expected.txt")).text())
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=")),
  );
  const replicaIds = new Uint8Array(48);
  const keyIds = new Uint8Array(48);
  const publicKeys = new Uint8Array(96);
  for (let index = 0; index < 3; index += 1) {
    replicaIds.set(decodeHex(expected[`replica_${index + 1}_id`]), index * 16);
    keyIds.set(decodeHex(expected[`replica_${index + 1}_key_id`]), index * 16);
    publicKeys.set(decodeHex(expected[`replica_${index + 1}_public_key`]), index * 32);
  }
  const request = new Uint8Array(
    await (await fetch("/fixtures/witness-advance-v1.bin")).arrayBuffer(),
  );
  const certificate = new Uint8Array(
    await (await fetch("/fixtures/witness-quorum-v1.bin")).arrayBuffer(),
  );
  const verifier = new wasm.BrowserWitnessVerifier(replicaIds, keyIds, publicKeys);
  verifier.verify(request, certificate);
  certificate[certificate.length - 1] ^= 1;
  let invalid;
  try {
    verifier.verify(request, certificate);
    invalid = "unexpected_success";
  } catch (cause) {
    invalid = String(cause).includes("witness_receipt_invalid")
      ? "witness_receipt_invalid"
      : String(cause);
  }
  verifier.free();
  return { invalid, requestBytes: request.length };
}

async function runProductionStorageScenario() {
  const session = crypto.getRandomValues(new Uint8Array(16));
  const databaseName = `axl-e2ee-production-v1:${[...session]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
  const operation = new Uint8Array(16).fill(7);
  const request = new Uint8Array(128).fill(8);
  const requestHash = new Uint8Array(48).fill(9);
  const certificate = new Uint8Array(256).fill(10);
  const exactResult = new TextEncoder().encode("committed browser output");
  let verificationCount = 0;
  const verify = async (receivedOperation, receivedRequest, receivedHash, receivedCertificate) => {
    verificationCount += 1;
    return (
      receivedOperation.every((value, index) => value === operation[index]) &&
      receivedRequest.every((value, index) => value === request[index]) &&
      receivedHash.every((value, index) => value === requestHash[index]) &&
      receivedCertificate.every((value, index) => value === certificate[index])
    );
  };
  const first = new ProductionBrowserStore(session, verify);
  const competing = new ProductionBrowserStore(session, verify);
  let stage = "delete";
  try {
    await deleteDatabase(databaseName);
    stage = "create";
    await first.create();
    stage = "contention";
    let contention;
    try {
      await competing.open();
      contention = "unexpected_success";
    } catch (cause) {
      contention = String(cause).includes("lifecycle_busy") ? "lifecycle_busy" : String(cause);
    }
    stage = "commit";
    const pending = await first.commit({
      operationId: operation,
      expectedGeneration: 0,
      innerState: new Uint8Array([1, 2, 3]),
      outerMetadata: new Uint8Array([4, 5, 6]),
      innerAad: new Uint8Array([11]),
      outerAad: new Uint8Array([12]),
      witnessRequest: request,
      requestHash,
      exactResult,
    });
    stage = "pending";
    const recoveredPending = await first.pending(operation);
    stage = "continue";
    const output = await first.continueWitness(operation, certificate);
    stage = "close";
    await first.close();
    const reopened = new ProductionBrowserStore(session, verify);
    stage = "reopen";
    await reopened.open();
    stage = "restart-pending";
    const afterRestart = await reopened.pending(operation);
    stage = "repeat";
    const repeated = await reopened.continueWitness(operation, certificate);
    stage = "reopened-close";
    await reopened.close();
    return {
      contention,
      pendingStatus: pending.status,
      recoveredStatus: recoveredPending.status,
      restartStatus: afterRestart.status,
      exact: new TextDecoder().decode(output),
      repeated: new TextDecoder().decode(repeated),
      verificationCount,
    };
  } catch (cause) {
    throw new Error(`${stage}:${String(cause)}`);
  } finally {
    await first.close();
    await competing.close();
    await deleteDatabase(databaseName);
    operation.fill(0);
    request.fill(0);
    requestHash.fill(0);
    certificate.fill(0);
    exactResult.fill(0);
  }
}

window.axlBrowserTest = Object.freeze({
  binding,
  runAllScenarios,
  runBoundaryScenario,
  runLifecycleScenario,
  runNegativeOpenMlsScenario,
  runPersistenceScenario,
  runProductionStorageScenario,
  runProductionWitnessVerifierScenario,
  runStateScenario,
  testWorker,
});
