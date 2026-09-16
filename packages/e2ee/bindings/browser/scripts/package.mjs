// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(root, "../../../..");
const build = () => execFileSync(process.execPath, [join(root, "scripts/build.mjs"), "production"], { stdio: "inherit" });
build();
const first = readFileSync(join(root, "dist/package/integrity.json"), "utf8");
build();
const second = readFileSync(join(root, "dist/package/integrity.json"), "utf8");
assert.equal(first, second, "integrity manifest is not reproducible");
const manifest = JSON.parse(second);
assert.equal(manifest.artifactKind, "production");
assert.equal(manifest.sourceBaseCommit, execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim());
for (const artifact of manifest.artifacts) {
  assert.equal(
    createHash("sha256").update(readFileSync(join(root, "dist/package", artifact.path))).digest("hex"),
    artifact.sha256,
  );
}
const packed = JSON.parse(
  execFileSync("npm", ["pack", "--json", "--ignore-scripts"], {
    cwd: join(root, "dist/package"),
    encoding: "utf8",
  }),
)[0];
const paths = packed.files.map((entry) => entry.path);
assert(paths.includes("wasm/axl_e2ee_browser_bg.wasm"));
assert(paths.includes("worker/index.js"));
assert(!paths.some((path) => /fixture|test/iu.test(path)), "production tarball contains test material");
const tarball = join(root, "dist/package", packed.filename);
const installRoot = mkdtempSync(join(tmpdir(), "axl-e2ee-browser-package-"));
try {
  writeFileSync(join(installRoot, "package.json"), '{"private":true,"type":"module"}\n');
  execFileSync("npm", ["install", "--ignore-scripts", tarball], { cwd: installRoot, stdio: "pipe" });
  const installed = join(installRoot, "node_modules/@axl/e2ee-browser");
  assert.equal(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).private, true);
  assert(readFileSync(join(installed, "loader/index.js"), "utf8").includes("new Worker"));
} finally {
  rmSync(installRoot, { recursive: true, force: true });
}
console.log(tarball);
