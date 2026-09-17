// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

for (const [className, interfaceName] of [
  ["DaemonEndpoint", "DaemonEndpoint"],
  ["DeviceEndpoint", "DeviceEndpoint"],
  ["NativePendingWitness", "NativePendingWitness"],
]) {
  const body = declarations.match(new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`, "u"))?.[1] ?? "";
  const declared = [
    ...body.matchAll(/^  ([A-Za-z0-9_]+)\(/gmu),
    ...body.matchAll(/^  readonly ([A-Za-z0-9_]+):/gmu),
  ].map((match) => match[1]).sort();
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
for (const discriminant of ["issued", "pending", "reserved", "active", "waiting_for_epoch_ready", "re_pair_required", "application_request", "application_delivery", "update_proposal", "commit", "epoch_ready", "pair_activation", "resync_control"]) assert(declarations.includes(`"${discriminant}"`), `missing discriminant ${discriminant}`);

const testPath = join(root, "dist/test-artifact/native", `axl-e2ee-node.${target}.node`);
const testNative = createRequire(import.meta.url)(testPath);
assert(Object.keys(testNative).includes("testDaemonEndpoint"));
assert(!Object.keys(native).some((name) => name.startsWith("test")));
console.log("Node ABI, declarations, discriminants, bigint fields, and readonly fields match.");
