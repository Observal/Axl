// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message);
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../../../..");
execFileSync(process.execPath, [join(packageRoot, "scripts/build.mjs"), "production"], { stdio: "inherit" });
const staging = join(packageRoot, "dist/package");
const first = readFileSync(join(staging, "integrity.json"), "utf8");
execFileSync(process.execPath, [join(packageRoot, "scripts/build.mjs"), "production"], { stdio: "inherit" });
const second = readFileSync(join(staging, "integrity.json"), "utf8");
if (first !== second) throw new Error("integrity manifest is not reproducible");
const manifest = JSON.parse(second);
if (manifest.artifactKind !== "production" || manifest.artifacts.length !== 1) throw new Error("invalid production manifest");
if ("sourceCommit" in manifest) throw new Error("ambiguous sourceCommit provenance is forbidden");
const sourceBaseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
assertEqual(manifest.sourceBaseCommit, sourceBaseCommit, "source base commit drift");
const sourceStatus = execFileSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=all", "--", "packages/e2ee"],
  { cwd: repositoryRoot, encoding: "utf8" },
).trim();
assertEqual(manifest.sourceTreeState, sourceStatus === "" ? "clean" : "dirty", "source tree state drift");
const sourcePaths = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "packages/e2ee"],
  { cwd: repositoryRoot },
)
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .sort();
const sourceHash = createHash("sha256");
for (const path of sourcePaths) {
  sourceHash.update(path);
  sourceHash.update("\0");
  sourceHash.update(readFileSync(join(repositoryRoot, path)));
  sourceHash.update("\0");
}
assertEqual(manifest.nativeSourceSha256, sourceHash.digest("hex"), "native source digest drift");
const nativeBytes = readFileSync(join(staging, manifest.artifacts[0].path));
for (const forbidden of [
  "testDaemonEndpoint",
  "testDeviceEndpoint",
  "testWitnessPending",
  "testWindowsDaemonEndpoint",
  "testWindowsDeviceEndpoint",
  "testPanic",
  "TestWitness",
  "test_witness",
  "test_pending_witness_operation",
  "sign_for_test",
  "from_receipts_for_test",
  "TestKeys",
  "TestAnchor",
  "FakeKeychain",
  "with_keychain",
  "AXL_RUN_MACOS_KEYCHAIN_TESTS",
]) {
  if (nativeBytes.includes(Buffer.from(forbidden))) throw new Error(`production binary contains test symbol ${forbidden}`);
}
const entries = readdirSync(staging, { recursive: true }).map(String);
if (entries.some((entry) => /test|fixture/i.test(entry))) throw new Error("production package contains test material");
const module = await import(`${pathToFileURL(join(staging, "loader/index.js")).href}?verify=${Date.now()}`);
const expected = ["AxlE2eeError", "ERROR_CODES", "createDaemonEndpoint", "createDeviceEndpoint", "getBindingInfo", "inspectPairingClaim", "inspectPairingInvitation", "openDaemonEndpoint", "openDeviceEndpoint"];
if (JSON.stringify(Object.keys(module).sort()) !== JSON.stringify(expected.sort())) throw new Error("production ESM export drift");
const nativeExports = Object.keys((await import("node:module")).createRequire(import.meta.url)(join(staging, manifest.artifacts[0].path)));
if (nativeExports.some((name) => /^test/iu.test(name))) throw new Error("production native exports test API");
for (const forbidden of ["NativePendingWitness", "setForgeSignature", "rollBackAll", "advanceForeign"]) {
  if (nativeExports.includes(forbidden) || nativeBytes.includes(Buffer.from(forbidden))) throw new Error(`production binary exposes ${forbidden}`);
}
const npm = (arguments_, options) =>
  process.platform === "win32"
    ? execFileSync(
        process.execPath,
        [join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), ...arguments_],
        options,
      )
    : execFileSync("npm", arguments_, options);
const result = JSON.parse(
  npm(["pack", "--json", "--ignore-scripts"], {
    cwd: staging,
    encoding: "utf8",
  }),
);
const files = result[0].files.map((entry) => entry.path);
if (files.some((entry) => /test|fixture/i.test(entry)) || files.filter((entry) => entry.endsWith(".node")).length !== 1) throw new Error("production tarball contents are unsafe");
const tarball = join(staging, result[0].filename);
const installRoot = mkdtempSync(join(tmpdir(), "axl-e2ee-node-package-"));
try {
  writeFileSync(join(installRoot, "package.json"), '{"private":true,"type":"module"}\n');
  npm(["install", "--ignore-scripts", tarball], {
    cwd: installRoot,
    stdio: "pipe",
  });
  const installedUrl = pathToFileURL(
    join(installRoot, "node_modules/@axl/e2ee-node/loader/index.js"),
  ).href;
  const installedExports = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const value = await import(${JSON.stringify(installedUrl)}); process.stdout.write(JSON.stringify(Object.keys(value).sort()));`,
      ],
      { cwd: installRoot, encoding: "utf8" },
    ),
  );
  assertEqual(
    JSON.stringify(installedExports),
    JSON.stringify(expected.sort()),
    "installed tarball export drift",
  );
} finally {
  rmSync(installRoot, { recursive: true, force: true });
}
console.log(tarball);
