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
assert.match(loader, /new Worker\([^)]*new URL/u, "loader must use a static same-origin worker URL");
assert.match(glue, /getRandomValues/u, "generated glue must use browser secure randomness");
assert.match(glue, /export class BrowserWitnessVerifier/u, "production WASM witness verifier missing");
assert.match(glue, /verify\(request_bytes, certificate_bytes\)/u, "witness verifier ABI drift");
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
  ["get_binding_info_json", "inspect_pairing_claim", "inspect_pairing_invitation", "secure_random_check"],
  "production Rust/WASM export drift",
);
const testWorker = readFileSync(join(testArtifact, "worker/index.js"), "utf8");
const testStorage = readFileSync(join(testArtifact, "worker/browser-storage.js"), "utf8");
assert.match(testWorker, /test_browser_persistence_seed/u);
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
