// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const production = join(root, "dist/package");
const testArtifact = join(root, "dist/test-artifact");
const manifest = JSON.parse(readFileSync(join(production, "integrity.json"), "utf8"));
assert.equal(manifest.abiVersion, 1);
assert.equal(manifest.profileId, "axl-e2ee-mls-pq-v1");
assert.equal(manifest.profileRevision, 1);
assert.equal(manifest.productionStorageReady, false);
assert.equal(manifest.workerModel, "dedicated-module-worker");
assert.equal(manifest.wasmThreads, false);
assert.equal(manifest.sharedMemory, false);
for (const artifact of manifest.artifacts) {
  const digest = createHash("sha256").update(readFileSync(join(production, artifact.path))).digest("hex");
  assert.equal(digest, artifact.sha256, `${artifact.path} integrity drift`);
}

const loader = readFileSync(join(production, "loader/index.js"), "utf8");
const worker = readFileSync(join(production, "worker/index.js"), "utf8");
const productionStorage = readFileSync(join(production, "worker/storage.js"), "utf8");
const productionEndpoint = readFileSync(join(production, "worker/endpoint.js"), "utf8");
const glue = readFileSync(join(production, "wasm/axl_e2ee_browser.js"), "utf8");
const declarations = readFileSync(join(production, "index.d.ts"), "utf8");
const wasm = readFileSync(join(production, "wasm/axl_e2ee_browser_bg.wasm"));
const productionText = `${loader}\n${worker}\n${productionStorage}\n${productionEndpoint}\n${glue}\n${wasm.toString("latin1")}`;
for (const forbidden of [
  "test_browser_persistence_receive",
  "test_browser_persistence_seed",
  "test_browser_persistence_send",
  "BrowserPersistenceEndpoint",
  "test_anchor_v1",
  "test_openmls_lifecycle_json",
  "test_openmls_negative_cases_json",
  "test_secure_random_probe",
  "testOpenmlsLifecycleJson",
  "testOpenmlsNegativeCasesJson",
  "testSecureRandomProbe",
  "TestWitness",
  "TestBrowserLineage",
  "TestPeerDaemon",
  "TestCommitFixture",
  "test_uuid_v7",
  "test_witness",
  "sign_for_test",
  "from_receipts_for_test",
  "set_forge_signature",
  "roll_back_all",
  "advance_foreign",
  "barrier-scenario",
  "BrowserWitnessVerifier",
  "verifyCertificate",
  "1_048_576",
  "SharedArrayBuffer",
  "Math.random",
  "randomFillSync",
  "module.require",
  "msCrypto",
  "eval(",
  "exportKey(",
  "new Function",
  "http://",
  "https://",
]) {
  assert(!productionText.includes(forbidden), `production artifact contains ${forbidden}`);
}
assert(!/(?:fetch|import|new URL)\s*\(\s*["'`](?:blob|data):/u.test(productionText), "production artifact contains an inline-code URL");
assert.match(worker, /import \{ BrowserDeviceEndpoint \} from "\.\/endpoint\.js"/u, "worker must statically import the production endpoint driver");
assert.match(worker, /const PRODUCTION_REPLICA_TRUST = undefined;/u, "production replica trust must remain unpinned until its gate");
assert.match(productionEndpoint, /import \{ ProductionBrowserStore \} from "\.\/storage\.js"/u, "endpoint driver must statically import production storage");
assert.match(worker, /import initializeWasm,/u, "worker must statically import WASM glue");
assert.match(productionStorage, /indexedDB/u, "production storage must use IndexedDB");
assert.match(productionStorage, /navigator\.locks/u, "production storage must use Web Locks");
assert.match(productionStorage, /durability: "strict"/u, "production storage must request strict durability");
assert.match(productionStorage, /transaction\.durability !== "strict"/u, "production storage must verify strict durability");
assert.match(productionStorage, /extractable !== false/u, "production wrapping key must be non-extractable");
assert.match(productionStorage, /wrapKey\("raw"/u, "production storage must wrap state keys");
assert.match(productionStorage, /unwrapKey\(/u, "production storage must recover state keys in the worker");
assert(!/test|fixture|fault/iu.test(productionStorage), "production storage contains test controls");
assert.match(productionStorage, /^const DATABASE_VERSION = 2;$/mu, "production storage schema version drift");
assert.match(productionStorage, /instanceof BrowserTransition/u, "commit must accept only Rust-finalized transitions");
assert.match(productionStorage, /lifecycle: "prepared"/u, "successor key must commit as prepared");
assert.match(productionStorage, /keyStore\.delete\(operationRecord\.obsoleteKeyId\)/u, "completion must erase the obsolete key");
assert.match(productionStorage, /unsupported_schema/u, "version 1 and newer stores must fail closed");
assert(
  !/confirm_quorum|verify\(|open_committed|BrowserLineage|BrowserReplicaTrust|\.release\(\)/u.test(productionStorage),
  "storage must not verify certificates or gate results; the Rust endpoint owns both",
);
assert(!/test|fixture|fault/iu.test(productionEndpoint), "production endpoint driver contains test controls");
assert.match(productionEndpoint, /instanceof BrowserReplicaTrust/u, "endpoint driver must require Rust-owned replica trust");
assert.match(productionEndpoint, /mark_current_key_active\(\)/u, "driver must report successor activation to Rust");
assert.match(productionEndpoint, /mark_obsolete_key_erased\(\)/u, "driver must report obsolete-key erasure to Rust");
assert.match(productionEndpoint, /recovery_required/u, "driver must destroy the transient endpoint on uncertain outcomes");
const continuation = productionEndpoint.slice(productionEndpoint.indexOf("async continueWitness("));
const order = ["confirm_quorum(", "completion_head()", "#store.complete(", "mark_obsolete_key_erased()", "release()"]
  .map((marker) => continuation.indexOf(marker));
assert(order.every((index, position) => index >= 0 && (position === 0 || index > order[position - 1])), "continuation order drift: certificate, completion transaction, erasure, release");
const endpointMethods = [...productionEndpoint.matchAll(/^  (?:static )?(?:async )?(#?[a-zA-Z]+)\(/gmu)].map((match) => match[1]);
assert.deepEqual(
  endpointMethods.filter((name) => !name.startsWith("#")),
  [
    "create",
    "open",
    "witnessReadRequest",
    "reconcileWitness",
    "pendingWitness",
    "continueWitness",
    "join",
    "prepareActivation",
    "prepareApplication",
    "receiveApplication",
    "prepareReplacement",
    "applyUpdateCommit",
    "prepareEpochReady",
    "acceptEpochReadyConfirmation",
    "applyRemoval",
    "close",
  ],
  "production endpoint driver surface drift",
);
assert(
  !/subtle\.(encrypt|decrypt)\([^)]*iv:\s*(random|new Uint8Array|crypto)/u.test(productionStorage),
  "storage must not select AEAD nonces",
);
const storageMethods = [...productionStorage.matchAll(/^  (?:async )?(#?[a-zA-Z]+)\(/gmu)].map((match) => match[1]);
assert.deepEqual(
  storageMethods.filter((name) => !name.startsWith("#")),
  [
    "constructor",
    "create",
    "open",
    "metadata",
    "currentOperation",
    "unsealCurrent",
    "commit",
    "complete",
    "quarantine",
    "close",
  ],
  "production storage public surface drift",
);
assert.match(loader, /new Worker\([^)]*new URL/u, "loader must use a static same-origin worker URL");
assert.match(glue, /getRandomValues/u, "generated glue must use browser secure randomness");
const productionClasses = [...glue.matchAll(/^export class ([A-Za-z0-9_]+)/gmu)].map((match) => match[1]).sort();
assert.deepEqual(
  productionClasses,
  [
    "BrowserCommittedTransition",
    "BrowserCompletion",
    "BrowserCreatedEndpoint",
    "BrowserEndpoint",
    "BrowserExactResult",
    "BrowserMutationOutcome",
    "BrowserPendingWitness",
    "BrowserReplicaTrust",
    "BrowserSealedEnvelopes",
    "BrowserTransition",
  ],
  "production WASM class drift",
);
for (const name of productionClasses) {
  const body = glue.slice(glue.indexOf(`export class ${name}`));
  const classBody = body.slice(0, body.indexOf("\n}\n"));
  assert(!/^\s+constructor\(/mu.test(classBody), `${name} must not be constructible from JavaScript`);
}
assert.match(loader, /2048/u, "JavaScript invitation bound missing");
assert.match(loader, /17320/u, "JavaScript claim bound missing");
assert.match(worker, /2048/u, "worker invitation bound missing");
assert.match(worker, /17320/u, "worker claim bound missing");
assert.match(loader, /endpoint_closed/u, "loader close state missing");

const declaredErrors = [
  ...(declarations.match(/export type AxlE2eeErrorCode =([\s\S]*?);/u)?.[1] ?? "").matchAll(
    /"([a-z0-9_]+)"/gu,
  ),
].map((match) => match[1]).sort();
const loaderErrors = [...loader.matchAll(/^  "([a-z0-9_]+)",$/gmu)].map((match) => match[1]);
const errorListStart = loaderErrors.indexOf("already_exists");
assert.deepEqual(
  declaredErrors,
  loaderErrors.slice(errorListStart, errorListStart + declaredErrors.length).sort(),
  "browser error declaration drift",
);

const valueExports = [
  "AxlE2eeError",
  "ERROR_CODES",
  "closeBrowserBinding",
  "createDaemonEndpoint",
  "createDeviceEndpoint",
  "getBindingInfo",
  "inspectPairingClaim",
  "inspectPairingInvitation",
  "openDaemonEndpoint",
  "openDeviceEndpoint",
].sort();
const declared = [...declarations.matchAll(/^export declare (?:class|const|function) ([A-Za-z0-9_]+)/gmu)]
  .map((match) => match[1])
  .sort();
assert.deepEqual(declared, valueExports, "source declarations drift from the public ESM surface");
const generatedExports = [...glue.matchAll(/^export function ([a-z0-9_]+)/gmu)]
  .map((match) => match[1])
  .sort();
assert.deepEqual(
  generatedExports,
  [
    "create_device_endpoint",
    "get_binding_info_json",
    "inspect_committed_transition",
    "inspect_pairing_claim",
    "inspect_pairing_invitation",
    "open_device_endpoint",
    "secure_random_check",
  ],
  "production Rust/WASM export drift",
);
const testWorker = readFileSync(join(testArtifact, "worker/index.js"), "utf8");
const testStorage = readFileSync(join(testArtifact, "worker/browser-storage.js"), "utf8");
assert.match(testWorker, /test_browser_persistence_seed/u);
assert.equal(
  readFileSync(join(testArtifact, "worker/storage.js"), "utf8"),
  productionStorage,
  "the test artifact must exercise the byte-identical production store",
);
assert.equal(
  readFileSync(join(testArtifact, "worker/endpoint.js"), "utf8"),
  productionEndpoint,
  "the test artifact must exercise the byte-identical production endpoint driver",
);
const testGlueClasses = [...readFileSync(join(testArtifact, "wasm/axl_e2ee_browser.js"), "utf8").matchAll(/^export class ([A-Za-z0-9_]+)/gmu)]
  .map((match) => match[1])
  .sort();
assert.deepEqual(
  testGlueClasses,
  [...productionClasses, "TestCommitFixture", "TestPeerDaemonFixture", "TestWitness"].sort(),
  "test-only WASM class drift",
);
assert.match(testStorage, /indexedDB/u);
assert.match(testStorage, /navigator\.locks/u);
assert.match(testStorage, /durability: "strict"/u);
assert.match(testStorage, /transaction\.durability !== "strict"/u);
assert.match(testStorage, /strict_durability_unavailable/u);
assert.match(testStorage, /extractable !== false/u);
const testGlue = readFileSync(join(testArtifact, "wasm/axl_e2ee_browser.js"), "utf8");
const testGeneratedExports = [...testGlue.matchAll(/^export function ([a-z0-9_]+)/gmu)]
  .map((match) => match[1])
  .sort();
assert.deepEqual(
  testGeneratedExports,
  [
    ...generatedExports,
    "test_browser_persistence_receive",
    "test_browser_persistence_seed",
    "test_browser_persistence_send",
    "test_openmls_lifecycle_json",
    "test_openmls_negative_cases_json",
    "test_secure_random_probe",
  ].sort(),
  "test-only Rust/WASM export drift",
);
assert(!readdirSync(production, { recursive: true }).map(String).some((name) => /fixture|test/iu.test(name)));
console.log("Browser ABI, artifact separation, bounds, CSP sources, and integrity metadata match.");
