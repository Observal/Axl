// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const target =
  process.platform === "darwin"
    ? `darwin-${process.arch}`
    : process.platform === "win32"
      ? `win32-${process.arch}-msvc`
      : `linux-${process.arch}-gnu`;
const productionRoot = join(root, "dist/package");
const manifest = JSON.parse(readFileSync(join(productionRoot, "integrity.json"), "utf8"));
const native = createRequire(import.meta.url)(join(productionRoot, manifest.artifacts[0].path));
const esm = await import(`${pathToFileURL(join(productionRoot, "loader/index.js")).href}?abi=${Date.now()}`);
const declarations = readFileSync(join(root, "index.d.ts"), "utf8");

const esmNames = ["AxlE2eeError", "ERROR_CODES", "createDaemonEndpoint", "createDeviceEndpoint", "getBindingInfo", "inspectPairingClaim", "inspectPairingInvitation", "openDaemonEndpoint", "openDeviceEndpoint"].sort();
assert.deepEqual(Object.keys(esm).sort(), esmNames);
const declaredValues = [...declarations.matchAll(/^export declare (?:class|const|function) ([A-Za-z0-9_]+)/gmu)].map((match) => match[1]).sort();
assert.deepEqual(declaredValues, esmNames);

const errorBlock = declarations.match(/export type AxlE2eeErrorCode =([\s\S]*?);/u)?.[1] ?? "";
const declaredErrors = [...errorBlock.matchAll(/"([a-z0-9_]+)"/gu)].map((match) => match[1]).sort();
assert.deepEqual(declaredErrors, [...native.errorCodes()].sort());

function interfaceMembers(interfaceName) {
  const match = declarations.match(
    new RegExp(`export interface ${interfaceName}(?: extends ([A-Za-z0-9_]+))? \\{([\\s\\S]*?)\\n\\}`, "u"),
  );
  assert(match, `missing interface ${interfaceName}`);
  const body = match[2];
  const own = [
    ...body.matchAll(/^  ([A-Za-z0-9_]+)\(/gmu),
    ...body.matchAll(/^  readonly ([A-Za-z0-9_]+)\??:/gmu),
  ].map((entry) => entry[1]);
  return match[1] ? [...interfaceMembers(match[1]), ...own] : own;
}

for (const className of [
  "DaemonEndpoint",
  "DeviceEndpoint",
  "WitnessOutcome",
  "NativeResult",
  "NativeOutbox",
  "NativePlaintext",
  "NativeAccepted",
  "NativeCommit",
  "NativeWelcome",
  "NativeActivationAcceptance",
  "NativeEpochReadyAcceptance",
  "NativeRePairRequirement",
]) {
  const declared = interfaceMembers(className).sort();
  const actual = Object.getOwnPropertyNames(native[className].prototype).filter((name) => name !== "constructor").sort();
  assert.deepEqual(declared, actual, `${className} declaration drift`);
}

for (const line of declarations.split("\n")) {
  if (/^  [a-zA-Z][a-zA-Z0-9_?]*:\s/u.test(line)) assert.match(line, /^  readonly /u, `mutable declared field: ${line}`);
}
for (const pattern of [
  /readonly expiresAtMs\??: bigint/u,
  /readonly epoch: bigint/u,
  /readonly targetEpoch\?: bigint/u,
  /hostedGrantGeneration: bigint/u,
]) assert.match(declarations, pattern, `missing bigint declaration: ${pattern}`);
assert(!/hostedGrantGeneration: number|readonly (?:epoch|expiresAtMs|targetEpoch)\??: number/u.test(declarations), "u64 exposed as number");
for (const discriminant of ["issued", "pending", "reserved", "active", "waiting_for_epoch_ready", "re_pair_required", "application_request", "application_delivery", "update_proposal", "commit", "epoch_ready", "pair_activation", "resync_control", "register", "advance", "ready", "resend_pending", "recover_accepted", "quarantined", "revoked", "released"]) assert(declarations.includes(`"${discriminant}"`), `missing discriminant ${discriminant}`);
for (const member of ["reservationId", "cryptoSessionId", "accountId", "installationId", "deviceId", "claimHash", "keyPackageHash", "expiresAtMs"]) {
  assert(interfaceMembers("ReservationIntent").includes(member), `ReservationIntent lacks ${member}`);
}
for (const code of ["unsupported_schema", "invalid_hash"]) assert(declaredErrors.includes(code), `missing error code ${code}`);
assert.equal(native.getBindingInfo().abiVersion, 2);
assert.match(declarations, /readonly abiVersion: 2;/u);
for (const forbidden of ["NativePendingWitness", "testWitnessPending", "rollbackAnchor", "RollbackAnchor"]) {
  assert(!declarations.includes(forbidden), `declarations expose removed API ${forbidden}`);
}

// Every u64 field, wherever declared, is a bigint.
for (const line of declarations.split("\n")) {
  const field = line.match(/^  readonly ([A-Za-z0-9_]+)\??: ([A-Za-z]+)/u);
  if (!field) continue;
  if (/(?:generation|epoch|counter|expiresAtMs|hostedGrantGeneration)$/iu.test(field[1]) && field[1] !== "abiVersion") {
    assert.equal(field[2], "bigint", `u64 field ${field[1]} declared as ${field[2]}`);
  }
}

// Production constructors stay disabled until the build-pinned trust gate.
for (const [constructor, code] of [
  ["createDaemonEndpoint", "secure_store_unavailable"],
  ["createDeviceEndpoint", "secure_store_unavailable"],
  ["openDaemonEndpoint", "rollback_anchor_unavailable"],
  ["openDeviceEndpoint", "rollback_anchor_unavailable"],
]) {
  await assert.rejects(
    Promise.resolve().then(() => esm[constructor]()),
    (cause) => cause instanceof esm.AxlE2eeError && cause.code === code,
    `${constructor} must fail closed with ${code}`,
  );
}

// No public member of any production class or export names a Rust-only capability.
const publicMembers = new Set(Object.keys(native));
for (const name of Object.keys(native)) {
  const value = native[name];
  if (typeof value === "function" && value.prototype) {
    for (const member of Object.getOwnPropertyNames(value.prototype)) publicMembers.add(member);
  }
}
for (const member of publicMembers) {
  assert(!FORBIDDEN_PUBLIC_MEMBER.test(member), `production binding exposes capability ${member}`);
}

// Integrity manifest: exact artifact hashes, source and lock provenance, no unexpected keys.
const cargoLockSha256 = createHash("sha256").update(readFileSync(join(e2eeRoot, "Cargo.lock"))).digest("hex");
assertManifestShape(manifest, "node", cargoLockSha256);
const nativeBytes = readFileSync(join(productionRoot, manifest.artifacts[0].path));
assert.equal(createHash("sha256").update(nativeBytes).digest("hex"), manifest.artifacts[0].sha256, "native artifact integrity drift");
assert.equal(manifest.artifacts[0].target, target);

// Production bytes carry no test-only identifier, fixture, fault control, or diagnostics hook.
const loaderText = readFileSync(join(productionRoot, "loader/index.js"), "utf8");
const testPath = join(root, "dist/test-artifact/native", `axl-e2ee-node.${target}.node`);
const testBytes = readFileSync(testPath);
const derived = testOnlyIdentifiers();
const positiveControls = derived.filter((name) => testBytes.includes(Buffer.from(name)));
assert(positiveControls.length >= 6, `test artifact should carry derived test identifiers; found ${positiveControls.length}`);
for (const name of ["testDaemonEndpoint", "TestWitness", "testPanic"]) {
  assert(positiveControls.includes(name), `derived identifiers must include ${name}`);
}
for (const forbidden of [...derived, ...FORBIDDEN_PRODUCTION_STRINGS]) {
  assert(!nativeBytes.includes(Buffer.from(forbidden)), `production binary contains ${forbidden}`);
  assert(!loaderText.includes(forbidden), `production loader contains ${forbidden}`);
}
for (const forbidden of FORBIDDEN_PRODUCTION_JS) {
  assert(!loaderText.includes(forbidden), `production loader contains ${forbidden}`);
}
// The deployment-test daemon constructor, its file key store, and its pinned trust are absent.
for (const forbidden of [
  "deploymentTestDaemonEndpoint",
  "deployment_test",
  "deployment-test-keys",
  "axl-deployment-test-keys",
]) {
  assert(!nativeBytes.includes(Buffer.from(forbidden)), `production binary contains ${forbidden}`);
  assert(!loaderText.includes(forbidden), `production loader contains ${forbidden}`);
}
assertNoFixtureBytes(nativeBytes, "production native binary");
assert(!readdirSync(productionRoot, { recursive: true }).map(String).some((entry) => /test|fixture|\.env|\.pem|\.key$|\.git/iu.test(entry)), "production package carries test or secret material");
const packaged = JSON.parse(readFileSync(join(productionRoot, "package.json"), "utf8"));
assert.equal(packaged.scripts, undefined, "production package must not run install-time scripts");
assert(!("dependencies" in packaged) && !("optionalDependencies" in packaged), "production package must not pull dependencies");

const testNative = createRequire(import.meta.url)(testPath);
assert(Object.keys(testNative).includes("testDaemonEndpoint"));
assert(Object.keys(testNative).includes("TestWitness"));
assert(!Object.keys(native).some((name) => /^test/iu.test(name)));
console.log("Node ABI, declarations, discriminants, bigint fields, readonly fields, isolation, and provenance match.");

// A deployment-test artifact, when built, is the production binding plus one daemon constructor.
const deploymentRoot = join(root, "dist/deployment-test");
if (existsSync(join(deploymentRoot, "integrity.json"))) {
  const deploymentManifest = JSON.parse(readFileSync(join(deploymentRoot, "integrity.json"), "utf8"));
  assert.equal(deploymentManifest.artifactKind, "deployment-test");
  const [deploymentArtifact] = deploymentManifest.artifacts;
  const deploymentBytes = readFileSync(join(deploymentRoot, deploymentArtifact.path));
  assert.equal(
    createHash("sha256").update(deploymentBytes).digest("hex"),
    deploymentArtifact.sha256,
    "deployment-test native integrity drift",
  );
  assert.equal(
    readFileSync(join(deploymentRoot, "loader/index.js"), "utf8"),
    `${loaderText}${readFileSync(join(root, "loader/deployment-test-exports.js"), "utf8")}`,
    "the deployment-test loader must be the production loader plus its one appended export",
  );
  assert(deploymentBytes.includes(Buffer.from("deploymentTestDaemonEndpoint")));
  // The constructor's own name contains `test_daemon_endpoint`; blank it before scanning.
  const scanned = Buffer.from(deploymentBytes);
  for (const own of ["deployment_test_daemon_endpoint", "deploymentTestDaemonEndpoint"]) {
    for (let at = scanned.indexOf(own); at >= 0; at = scanned.indexOf(own, at + own.length)) {
      scanned.fill(0, at, at + own.length);
    }
  }
  for (const forbidden of derived) {
    assert(!scanned.includes(Buffer.from(forbidden)), `deployment-test binary contains ${forbidden}`);
  }
  assertNoFixtureBytes(deploymentBytes, "deployment-test native binary");
}
