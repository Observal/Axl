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
const glue = readFileSync(join(production, "wasm/axl_e2ee_browser.js"), "utf8");
const declarations = readFileSync(join(production, "index.d.ts"), "utf8");
const wasm = readFileSync(join(production, "wasm/axl_e2ee_browser_bg.wasm"));
const productionText = `${loader}\n${worker}\n${productionStorage}\n${glue}\n${wasm.toString("latin1")}`;
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
assert.match(worker, /import \{ ProductionBrowserStore \} from "\.\/storage\.js"/u, "worker must statically import production storage");
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
assert.match(productionStorage, /instanceof BrowserLineage/u, "store must require a Rust-owned lineage");
assert.match(productionStorage, /instanceof BrowserReplicaTrust/u, "store must require Rust-owned replica trust");
assert.match(productionStorage, /lifecycle: "prepared"/u, "successor key must commit as prepared");
assert.match(productionStorage, /mark_current_key_active\(\)/u, "continuation must report successor activation to Rust");
assert.match(productionStorage, /mark_obsolete_key_erased\(\)/u, "continuation must report obsolete-key erasure to Rust");
assert.match(productionStorage, /keyStore\.delete\(operationRecord\.obsoleteKeyId\)/u, "completion must erase the obsolete key");
assert.match(productionStorage, /unsupported_schema/u, "version 1 and newer stores must fail closed");
assert(
  !/subtle\.(encrypt|decrypt)\([^)]*iv:\s*(random|new Uint8Array|crypto)/u.test(productionStorage),
  "storage must not select AEAD nonces",
);
const storageMethods = [...productionStorage.matchAll(/^  (?:async )?(#?[a-zA-Z]+)\(/gmu)].map((match) => match[1]);
assert.deepEqual(
  storageMethods.filter((name) => !name.startsWith("#")),
  ["constructor", "create", "open", "pending", "commit", "continueWitness", "close"],
  "production storage public surface drift",
);
assert.match(loader, /new Worker\([^)]*new URL/u, "loader must use a static same-origin worker URL");
assert.match(glue, /getRandomValues/u, "generated glue must use browser secure randomness");
const productionClasses = [...glue.matchAll(/^export class ([A-Za-z0-9_]+)/gmu)].map((match) => match[1]).sort();
assert.deepEqual(
  productionClasses,
  [
    "BrowserCommittedTransition",
    "BrowserContinuation",
    "BrowserLineage",
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
    "get_binding_info_json",
    "inspect_committed_transition",
    "inspect_pairing_claim",
    "inspect_pairing_invitation",
    "open_committed_transition",
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
const testGlueClasses = [...readFileSync(join(testArtifact, "wasm/axl_e2ee_browser.js"), "utf8").matchAll(/^export class ([A-Za-z0-9_]+)/gmu)]
  .map((match) => match[1])
  .sort();
assert.deepEqual(
  testGlueClasses,
  [...productionClasses, "TestBrowserLineageFixture", "TestWitness"].sort(),
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
