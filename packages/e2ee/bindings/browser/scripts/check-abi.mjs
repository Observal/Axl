// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FORBIDDEN_PRODUCTION_JS,
  FORBIDDEN_PRODUCTION_STRINGS,
  FORBIDDEN_PUBLIC_MEMBER,
  assertManifestShape,
  assertNoFixtureBytes,
  e2eeRoot,
  testOnlyIdentifiers,
} from "../../../scripts/artifact-policy.mjs";

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
assert(!readdirSync(production, { recursive: true }).map(String).some((name) => /fixture|test|\.env|\.pem|\.key$|\.git/iu.test(name)));

// Integrity manifest: exact hashes (verified above), source and lock provenance, no other keys.
const cargoLockSha256 = createHash("sha256").update(readFileSync(join(e2eeRoot, "Cargo.lock"))).digest("hex");
assertManifestShape(manifest, "browser", cargoLockSha256);
assert.deepEqual(
  manifest.artifacts.map((artifact) => artifact.path).sort(),
  ["wasm/axl_e2ee_browser.js", "wasm/axl_e2ee_browser_bg.wasm", "worker/endpoint.js", "worker/index.js", "worker/storage.js"],
  "every production module is hashed",
);

// Derived test-only identifiers and fixture bytes are absent from every production byte.
const derived = testOnlyIdentifiers();
const testWasm = readFileSync(join(testArtifact, "wasm/axl_e2ee_browser_bg.wasm"));
const testText = `${testGlue}\n${testWasm.toString("latin1")}`;
const positiveControls = derived.filter((name) => testText.includes(name));
assert(positiveControls.length >= 6, `test artifact should carry derived test identifiers; found ${positiveControls.length}`);
for (const name of ["test_browser_persistence_seed", "TestWitness", "TestPeerDaemonFixture"]) {
  assert(positiveControls.includes(name), `derived identifiers must include ${name}`);
}
for (const forbidden of [...derived, ...FORBIDDEN_PRODUCTION_STRINGS]) {
  assert(!productionText.includes(forbidden), `production artifact contains ${forbidden}`);
}
const ownProductionJs = `${loader}\n${worker}\n${productionStorage}\n${productionEndpoint}`;
for (const forbidden of FORBIDDEN_PRODUCTION_JS) {
  assert(!ownProductionJs.includes(forbidden), `production JavaScript contains ${forbidden}`);
}
// wasm-bindgen glue may warn only about its own static initialization conditions.
const glueConsole = [...glue.matchAll(/console\.[a-z]+\([^\n]*/gu)].map((match) => match[0]);
for (const call of glueConsole) {
  assert.match(call, /^console\.warn\((?:"`WebAssembly\.instantiateStreaming` failed|'using deprecated parameters)/u, `generated glue logs unexpectedly: ${call}`);
}
for (const forbidden of FORBIDDEN_PRODUCTION_JS.filter((entry) => !entry.startsWith("console."))) {
  assert(!glue.includes(forbidden), `generated glue contains ${forbidden}`);
}
assertNoFixtureBytes(wasm, "production WASM module");
assertNoFixtureBytes(Buffer.from(glue, "utf8"), "production WASM glue");

// The worker-internal WASM surface is pinned per class. Counters, commitments, nonces, key
// activation, erasure, finalization, and certificate confirmation exist only here, behind the
// dedicated worker, and never reach the page-visible API.
const glueSurface = {};
for (const name of productionClasses) {
  const body = glue.slice(glue.indexOf(`export class ${name}`));
  const classBody = body.slice(0, body.indexOf("\n}\n"));
  glueSurface[name] = [...classBody.matchAll(/^    (?:static )?(?:get )?([a-zA-Z_][a-zA-Z0-9_]*)\(/gmu)]
    .map((match) => match[1])
    .filter((member) => !["__wrap", "__destroy_into_raw", "free", "constructor"].includes(member))
    .sort();
}
assert.deepEqual(
  glueSurface,
  {
    BrowserCommittedTransition: ["commitment", "committed_record", "counter", "current_key_id", "fingerprint", "generation", "operation_id", "predecessor_commitment", "request_hash", "token", "witness_request"],
    BrowserCompletion: ["certificate_hash", "commitment", "counter"],
    BrowserCreatedEndpoint: ["take_endpoint", "take_transition"],
    BrowserEndpoint: ["accept_epoch_ready_confirmation", "apply_removal", "apply_update_commit", "completion_head", "confirm_quorum", "discard_candidate", "generation", "has_candidate", "has_obsolete_key", "head_commitment", "head_counter", "is_restored", "join", "local_commit_complete", "mark_current_key_active", "mark_obsolete_key_erased", "pending_descriptor", "pending_witness", "prepare_activation", "prepare_application", "prepare_epoch_ready", "prepare_replacement", "receive_application", "reconcile_witness", "release", "restore", "take_unpersisted_terminal", "terminal", "witness_read_request"],
    BrowserExactResult: ["bytes", "commit_id", "epoch", "epoch_authenticator", "hosted_generation", "logical_message_id", "message_class", "removal", "tag"],
    BrowserMutationOutcome: ["kind", "take_pending", "take_result", "take_transition"],
    BrowserPendingWitness: ["kind", "operation_id", "request_hash", "witness_request"],
    BrowserReplicaTrust: [],
    BrowserSealedEnvelopes: ["counter", "current_key_id", "generation", "inner_aad", "inner_nonce", "operation_id", "outer_aad", "outer_nonce", "sealed_inner", "sealed_outer"],
    BrowserTransition: ["complete", "counter", "current_key_id", "finalize", "fingerprint", "generation", "inner_aad", "inner_nonce", "operation_id", "outer_aad", "outer_nonce", "predecessor_commitment", "take_inner_payload", "token"],
  },
  "worker-internal WASM surface drift; review the trust boundary before accepting",
);
for (const member of ["sign", "decrypt", "export_key", "exportKey", "verify_certificate", "verifyCertificate", "raw_result", "plaintext_state", "wrapping_key"]) {
  for (const [name, members] of Object.entries(glueSurface)) {
    assert(!members.includes(member), `${name} exposes ${member}`);
  }
}

// The page-visible API declares none of the worker-internal capabilities.
const pageSurface = `${declarations}\n${loader}`;
for (const forbidden of ["counter", "commitment", "nonce", "finalize", "confirm_quorum", "confirmQuorum", "mark_current_key_active", "mark_obsolete_key_erased", "keyId", "key_id", "wrapKey", "unwrapKey", "witness_request", "witnessRequest", "certificate"]) {
  assert(!pageSurface.includes(forbidden), `page-visible API mentions ${forbidden}`);
}
for (const line of declarations.split("\n")) {
  const member = line.match(/^  (?:readonly )?([A-Za-z_][A-Za-z0-9_]*)\??[:(]/u);
  if (member) assert(!FORBIDDEN_PUBLIC_MEMBER.test(member[1]), `page-visible API exposes capability ${member[1]}`);
}
assert(!/import\s.*wasm\//u.test(loader), "the page loader must not import WASM glue directly");
assert(!/postMessage\([^)]*(?:transaction|IDBTransaction|db\b)/u.test(`${productionStorage}\n${productionEndpoint}\n${worker}`), "transaction handles must not leave the worker");
const storeClass = productionStorage.slice(productionStorage.indexOf("export class ProductionBrowserStore"));
assert(storeClass.length > 0, "production store class missing");
assert(!/return (?:transaction|tx|database|db|this\.#database);/u.test(storeClass), "the store must not hand out transaction or database handles");
for (const call of worker.matchAll(/fetch\(([^,)]*)/gu)) {
  assert.match(call[1], /^new URL\(/u, `worker fetch must use a static same-origin URL: ${call[0]}`);
}
console.log("Browser ABI, artifact separation, bounds, CSP sources, isolation, provenance, and integrity metadata match.");
