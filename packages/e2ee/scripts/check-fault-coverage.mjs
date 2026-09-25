// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

// Crash and recovery matrix sweep.
//
// Every `FaultPoint` the native provider can inject must be exercised by at least one test, and
// every browser fault the test worker can inject must be exercised by the Playwright scenarios.
// A new fault point without a test, or a test that stops naming a fault point, fails this check.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const e2eeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(path) {
  return readFileSync(join(e2eeRoot, path), "utf8");
}

function walk(directory, predicate) {
  const output = [];
  for (const entry of readdirSync(join(e2eeRoot, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!["target", "node_modules", "dist"].includes(entry.name)) output.push(...walk(path, predicate));
    } else if (predicate(entry.name)) {
      output.push(path);
    }
  }
  return output;
}

const failures = [];

// Native fault points.
const persistence = read("src/persistence.rs");
const enumBody = persistence.match(/pub\(crate\) enum FaultPoint \{([\s\S]*?)\n\}/u)?.[1];
if (!enumBody) throw new Error("FaultPoint enum not found");
const variants = [...enumBody.matchAll(/^\s+([A-Z][A-Za-z0-9]*),/gmu)].map((match) => match[1]);
if (variants.length < 20) throw new Error(`unexpectedly few fault points: ${variants.length}`);
const nativeTests = walk("src", (name) => /_tests?\.rs$/u.test(name) || name === "test_witness.rs")
  .concat(walk("bindings/node", (name) => name.endsWith(".rs") || name.endsWith(".mjs")))
  .map(read)
  .join("\n");
for (const variant of variants) {
  if (!nativeTests.includes(`FaultPoint::${variant}`)) failures.push(`native fault point ${variant} has no test`);
}

// Native restart-state matrix: each reconciliation outcome must be produced by a test.
const witnessSource = read("src/witness.rs");
const witnessTestModule = witnessSource.slice(witnessSource.indexOf("\nmod tests {"));
if (witnessTestModule.length < 100) throw new Error("witness test module not found");
const reconciliationTests = `${read("src/persistence_tests.rs")}\n${witnessTestModule}`;
for (const outcome of [
  "EndpointReconciliation::Ready",
  "EndpointReconciliation::ResendPending",
  "EndpointReconciliation::RecoverAccepted",
  "EndpointReconciliation::WitnessUnavailable",
  "EndpointReconciliation::Revoked",
  "EndpointQuarantineReason::StateLoss",
  "EndpointQuarantineReason::PendingWithoutLocalState",
  "EndpointQuarantineReason::WitnessLineageMissing",
  "EndpointQuarantineReason::CommitmentConflict",
  "EndpointQuarantineReason::LocalAheadMoreThanOne",
  "EndpointQuarantineReason::WitnessBehindMoreThanOne",
  "EndpointQuarantineReason::WitnessInconsistent",
  "EndpointQuarantineReason::ImmediateFork",
  "EndpointQuarantineReason::HistoricalFork",
]) {
  if (!reconciliationTests.includes(outcome)) failures.push(`native restart state ${outcome} has no test`);
}

// Browser fault points: everything the test worker accepts as a fault name must be exercised.
const browserTestWorker = read("bindings/browser/test/worker.js");
const browserScenarios = walk("bindings/browser/test", (name) => /\.(?:js|mjs)$/u.test(name)).map(read).join("\n");
const browserFaults = new Set(
  [...browserTestWorker.matchAll(/"([a-z_]+(?:_before_|_after_|_during_|_loss|_abort|_terminat)[a-z_]*)"/gu)].map((match) => match[1]),
);
for (const fault of browserFaults) {
  const uses = browserScenarios.split(fault).length - 1 - (browserTestWorker.split(fault).length - 1);
  if (uses <= 0) failures.push(`browser fault ${fault} is declared by the test worker but never injected by a scenario`);
}

// Browser mutation inventory: every operation kind the Rust runner defines maps to one production
// endpoint method, and the Playwright barrier scenario must drive each of those methods.
const browserEndpoint = read("src/witness/browser/endpoint.rs");
const kindBlock = browserEndpoint.match(/pub mod op_kind \{([\s\S]*?)\n\}/u)?.[1];
if (!kindBlock) throw new Error("browser op_kind module not found");
const kinds = [...kindBlock.matchAll(/pub const ([A-Z_]+): u16 = (\d+);/gu)].map((match) => match[1]);
const kindMethods = {
  WELCOME_JOIN: "join",
  ACTIVATION_SEND: "prepareActivation",
  APPLICATION_SEND: "prepareApplication",
  APPLICATION_RECEIVE: "receiveApplication",
  PROPOSAL_SEND: "prepareReplacement",
  COMMIT_APPLY: "applyUpdateCommit",
  EPOCH_READY_SEND: "prepareEpochReady",
  EPOCH_READY_CONFIRM_RECEIVE: "acceptEpochReadyConfirmation",
  REMOVAL_APPLY: "applyRemoval",
  LEGACY_CREATE: "create",
};
const barrierScenario = read("bindings/browser/test/barrier-scenario.js");
for (const kind of kinds) {
  const method = kindMethods[kind];
  if (method === undefined) {
    failures.push(`browser operation kind ${kind} has no known endpoint method; extend the sweep`);
    continue;
  }
  if (method === "create") continue; // exercised by every scenario's endpoint creation
  if (!barrierScenario.includes(`.${method}(`)) failures.push(`browser operation kind ${kind} (${method}) is not driven by the barrier scenario`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `Fault coverage: ${variants.length} native fault points, 14 restart states, ${browserFaults.size} browser faults, ${kinds.length} browser operation kinds are all exercised.`,
);
