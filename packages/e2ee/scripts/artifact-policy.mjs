// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

// Shared production artifact isolation policy for the Node and browser bindings.
//
// The Rust sources declare every test-only surface behind a feature gate or in a test-only module.
// This module derives the identifiers of those surfaces from the sources at check time, so a new
// test constructor, fixture, fault control, or deterministic signer is rejected from production
// artifacts without anyone remembering to extend a hand-written list. Hand-written entries below
// cover identifiers that are not declared as Rust items (JavaScript names, environment variables,
// fixture families) and capability names that must never become public.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const e2eeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Rust modules whose every public item is test-only. */
const TEST_ONLY_MODULES = [
  "src/test_witness.rs",
  "src/browser_test_fixtures.rs",
  "bindings/node/src/test_store.rs",
];

/** Rust modules containing feature-gated test items among production items. */
const MIXED_MODULES = ["src/lib.rs", "bindings/node/src/lib.rs", "bindings/browser/src/lib.rs"];

const TEST_GATE = /#\[cfg\((?:any\()?(?:test|feature = "(?:test-fixtures|test-witness|browser-test-fixtures|node-test-fixtures)")/u;
/**
 * Deployment-test items are neither production nor test code: they ship only in deployment-test
 * artifacts, whose checks forbid test identifiers separately. They must not count as production
 * declarations, or a name such as `deployment_test_daemon_endpoint` would hide the test-only
 * `test_daemon_endpoint` it contains.
 */
const DEPLOYMENT_GATE = /#\[cfg\(feature = "deployment-test"\)\]/u;
const DEPLOYMENT_TEST_MODULES = ["bindings/node/src/deployment_store.rs"];
const ITEM = /^\s*pub(?:\(crate\))? (?:async )?(?:fn|struct|enum|trait) ([A-Za-z_][A-Za-z0-9_]*)/u;

function camel(name) {
  return name.replace(/_([a-z0-9])/gu, (_, letter) => letter.toUpperCase());
}

function itemsOf(lines) {
  const names = [];
  for (const line of lines) {
    const match = line.match(ITEM);
    if (match) names.push(match[1]);
  }
  return names;
}

function productionModules() {
  const modules = [];
  const walk = (directory) => {
    for (const entry of readdirSync(join(e2eeRoot, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!["target", "node_modules", "dist", "test", "tests"].includes(entry.name)) walk(path);
      } else if (entry.name.endsWith(".rs") && !/_tests?\.rs$/u.test(entry.name)) {
        modules.push(path);
      }
    }
  };
  walk("src");
  walk("bindings/node/src");
  walk("bindings/browser/src");
  return modules.filter(
    (module) => !TEST_ONLY_MODULES.includes(module) && !DEPLOYMENT_TEST_MODULES.includes(module),
  );
}

/** Identifiers declared by production (ungated) Rust items. */
function productionDeclaredIdentifiers() {
  const names = new Set();
  for (const module of productionModules()) {
    const lines = readFileSync(join(e2eeRoot, module), "utf8").split("\n");
    let gated = 0;
    for (const line of lines) {
      if (TEST_GATE.test(line) || DEPLOYMENT_GATE.test(line)) {
        gated = 12;
        continue;
      }
      if (gated > 0) {
        gated -= 1;
        if (/^\s*(?:#\[|\/\/)/u.test(line)) continue;
        gated = 0;
        continue; // the gated item itself
      }
      const match = line.match(ITEM);
      if (match) names.add(match[1]);
    }
  }
  return names;
}

/**
 * Identifiers declared only under a test gate or in a test-only module. Returned in both Rust
 * snake_case and the camelCase spelling that napi-rs and wasm-bindgen export to JavaScript.
 */
export function testOnlyIdentifiers() {
  const names = new Set();
  for (const module of TEST_ONLY_MODULES) {
    for (const name of itemsOf(readFileSync(join(e2eeRoot, module), "utf8").split("\n"))) {
      names.add(name);
    }
  }
  for (const module of MIXED_MODULES) {
    const lines = readFileSync(join(e2eeRoot, module), "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!TEST_GATE.test(lines[index])) continue;
      // The gated item is the next declaration; skip attributes and doc comments between.
      for (let cursor = index + 1; cursor < Math.min(lines.length, index + 12); cursor += 1) {
        const line = lines[cursor];
        if (/^\s*(?:#\[|\/\/)/u.test(line)) continue;
        const match = line.match(ITEM);
        if (match) names.add(match[1]);
        break;
      }
    }
  }
  // Names that production code also declares (fixture peers mirror production method names, and
  // generic constructors) are not isolation signals; only names unique to test code remain.
  const production = productionDeclaredIdentifiers();
  for (const name of production) names.delete(name);
  for (const generic of ["new", "default"]) names.delete(generic);
  const output = new Set();
  for (const name of names) {
    // A test name that is a substring of a production identifier (or its camelCase form) cannot be
    // matched byte-wise without false positives; the hand-written list carries those explicitly.
    const ambiguous = [...production].some(
      (candidate) => candidate.includes(name) || camel(candidate).includes(camel(name)),
    );
    if (ambiguous || name.length < 8) continue;
    output.add(name);
    output.add(camel(name));
  }
  return [...output].sort();
}

/** JavaScript-side and environment names that never belong in a production artifact. */
export const FORBIDDEN_PRODUCTION_STRINGS = Object.freeze([
  // test constructors and controls
  "testDaemonEndpoint",
  "testDeviceEndpoint",
  "testWindowsDaemonEndpoint",
  "testWindowsDeviceEndpoint",
  "testWitnessPending",
  "testPanic",
  "testWitness",
  "TestWitness",
  "TestAnchor",
  "test_anchor_v1",
  "TestKeys",
  "FakeKeychain",
  "with_keychain",
  "NativePendingWitness",
  "setForgeSignature",
  "set_forge_signature",
  "rollBackAll",
  "roll_back_all",
  "advanceForeign",
  "advance_foreign",
  "setUnavailable",
  "set_unavailable",
  "OneShotFault",
  "browser-storage.js",
  "barrier-scenario",
  // deterministic signers and fixtures
  "sign_for_test",
  "from_receipts_for_test",
  "test_uuid_v7",
  "TestBrowserLineage",
  "TestPeerDaemon",
  "TestCommitFixture",
  // snapshot import and export of private state
  "export_snapshot",
  "import_snapshot",
  "exportSnapshot",
  "importSnapshot",
  "dump_state",
  "dumpState",
  // test-only environment switches
  "AXL_RUN_MACOS_KEYCHAIN_TESTS",
  "AXL_RUN_WINDOWS_DPAPI_TESTS",
  "AXL_E2EE_NODE_TEST_ARTIFACT",
  "AXL_RUN_HOSTED_PATH_INTEGRATION",
]);

/**
 * Capability names that must not appear as public JavaScript members of any production class or
 * export: signing, counters, commitments, nonces, key selection, activation, erasure, transition
 * finalization, raw result decryption, and generic certificate verification stay inside Rust.
 */
export const FORBIDDEN_PUBLIC_MEMBER = /^(?:sign|verify|verifyCertificate|verifyReceipt|commitment|nonce|counter|selectKey|keyId|activateKey|markCurrentKeyActive|eraseKey|markObsoleteKeyErased|finalize|finalizeTransition|decrypt|decryptResult|openCommitted|releaseResult|exportKey|wrapKey|unwrapKey|signingKey|privateKey|secretKey)$/iu;

/**
 * Keys permitted in an integrity manifest. Anything else is a secret-exposure or provenance
 * ambiguity risk and fails the check.
 */
export const MANIFEST_KEYS = Object.freeze({
  node: [
    "abiVersion",
    "profileId",
    "profileRevision",
    "nodeApi",
    "productionStorageReady",
    "integrityPurpose",
    "intendedTargets",
    "sourceBaseCommit",
    "sourceTreeState",
    "nativeSourceSha256",
    "cargoLockSha256",
    "artifactKind",
    "artifacts",
  ],
  browser: [
    "abiVersion",
    "profileId",
    "profileRevision",
    "productionStorageReady",
    "workerModel",
    "wasmThreads",
    "sharedMemory",
    "integrityPurpose",
    "sourceBaseCommit",
    "sourceTreeState",
    "e2eeSourceSha256",
    "cargoLockSha256",
    "artifactKind",
    "artifacts",
  ],
});

/** Patterns that indicate dynamic code, host access, or diagnostics leaking from production JS. */
export const FORBIDDEN_PRODUCTION_JS = Object.freeze([
  "eval(",
  "new Function",
  "importScripts",
  "child_process",
  "process.env",
  "process.argv",
  "console.log",
  "console.error",
  "console.warn",
  "console.debug",
  "console.trace",
  "debugger",
]);

/** Test fixture bytes that must not be embedded in a production binary or WASM module. */
export function fixtureSecretFragments() {
  const fragments = [];
  // Every fixture in the versioned corpus is test material; a production artifact that embeds any
  // 32-byte window of one has embedded a fixture key, request, receipt, or certificate.
  for (const name of [
    "witness-advance-v1.bin",
    "witness-read-v1.bin",
    "witness-register-v1.bin",
    "witness-receipt-1.bin",
    "witness-receipt-2.bin",
    "witness-receipt-3.bin",
    "witness-quorum-v1.bin",
    "pairing-invitation.tls",
    "pairing-claim-v1.tls",
  ]) {
    const bytes = readFileSync(join(e2eeRoot, "fixtures/v1", name));
    for (let offset = 0; offset + 32 <= bytes.byteLength; offset += 16) {
      const window = bytes.subarray(offset, offset + 32);
      // Structural padding and repeated bytes occur in any binary; only high-entropy windows
      // (keys, hashes, signatures, nonces) identify fixture material.
      if (new Set(window).size < 20) continue;
      fragments.push({ name, offset, bytes: window });
    }
  }
  return fragments;
}

export function assertNoFixtureBytes(artifactBytes, label) {
  for (const fragment of fixtureSecretFragments()) {
    if (artifactBytes.includes(fragment.bytes)) {
      throw new Error(`${label} embeds fixture ${fragment.name} bytes at fixture offset ${fragment.offset}`);
    }
  }
}

export function assertManifestShape(manifest, kind, cargoLockSha256) {
  const allowed = MANIFEST_KEYS[kind];
  const keys = Object.keys(manifest).sort();
  const unexpected = keys.filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`integrity manifest carries unexpected keys ${unexpected.join(", ")}`);
  const missing = allowed.filter((key) => !keys.includes(key));
  if (missing.length > 0) throw new Error(`integrity manifest lacks ${missing.join(", ")}`);
  if (manifest.cargoLockSha256 !== cargoLockSha256) throw new Error("integrity manifest lock provenance drift");
  if (!/^[0-9a-f]{40}$/u.test(manifest.sourceBaseCommit)) throw new Error("integrity manifest source commit is not a full SHA-1");
  if (!["clean", "dirty"].includes(manifest.sourceTreeState)) throw new Error("integrity manifest tree state is invalid");
  if (manifest.productionStorageReady !== false) throw new Error("production storage must remain not ready");
  for (const artifact of manifest.artifacts) {
    if (!/^[0-9a-f]{64}$/u.test(artifact.sha256)) throw new Error(`artifact ${artifact.path} lacks a SHA-256`);
    if (/\.\.|^\/|test|fixture/iu.test(artifact.path)) throw new Error(`artifact path ${artifact.path} is unsafe`);
  }
  const text = JSON.stringify(manifest);
  if (/BEGIN [A-Z ]*PRIVATE KEY|secret|token|password|passphrase/iu.test(text)) {
    throw new Error("integrity manifest carries secret-like content");
  }
}
