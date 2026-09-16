// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "production" && mode !== "test") throw new Error("usage: build.ts production|test");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const e2eeRoot = resolve(packageRoot, "../..");
const repositoryRoot = resolve(e2eeRoot, "../..");
const target = (() => {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64-gnu";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64-gnu";
  throw new Error(`unsupported build host: ${process.platform}-${process.arch}`);
})();
const targetDirectory = join(e2eeRoot, "target", `node-${mode}`);
const staging = join(packageRoot, "dist", mode === "production" ? "package" : "test-artifact");
rmSync(staging, { recursive: true, force: true });
mkdirSync(join(staging, "native"), { recursive: true });
const cargoArguments = ["build", "--locked", "--release", "-p", "axl-e2ee-node", "--target-dir", targetDirectory];
if (mode === "test") cargoArguments.push("--features", "test-fixtures");
execFileSync("cargo", cargoArguments, { cwd: e2eeRoot, stdio: "inherit" });
const library = join(targetDirectory, "release", process.platform === "darwin" ? "libaxl_e2ee_node.dylib" : "libaxl_e2ee_node.so");
const artifactName = `axl-e2ee-node.${target}.node`;
const artifactPath = join(staging, "native", artifactName);
cpSync(library, artifactPath);
const sha256 = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
const source = JSON.parse(readFileSync(join(packageRoot, "artifact/manifest-source.json"), "utf8"));
const sourceBaseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const sourceStatus = execFileSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=all", "--", "packages/e2ee"],
  { cwd: repositoryRoot, encoding: "utf8" },
).trim();
const sourcePaths = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "packages/e2ee"],
  { cwd: repositoryRoot },
)
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .sort();
if (sourcePaths.length === 0) throw new Error("native source snapshot is empty");
const sourceHash = createHash("sha256");
for (const path of sourcePaths) {
  sourceHash.update(path);
  sourceHash.update("\0");
  sourceHash.update(readFileSync(join(repositoryRoot, path)));
  sourceHash.update("\0");
}
const manifest = {
  ...source,
  sourceBaseCommit,
  sourceTreeState: sourceStatus === "" ? "clean" : "dirty",
  nativeSourceSha256: sourceHash.digest("hex"),
  artifactKind: mode,
  artifacts: [{ target, path: `native/${artifactName}`, sha256 }],
};
writeFileSync(join(staging, "integrity.json"), `${JSON.stringify(manifest, null, 2)}\n`);
if (mode === "production") {
  mkdirSync(join(staging, "loader"), { recursive: true });
  cpSync(join(packageRoot, "loader/index.js"), join(staging, "loader/index.js"));
  cpSync(join(packageRoot, "index.d.ts"), join(staging, "index.d.ts"));
  cpSync(join(packageRoot, "README.md"), join(staging, "README.md"));
  cpSync(join(repositoryRoot, "LICENSE"), join(staging, "LICENSE"));
  cpSync(join(repositoryRoot, "NOTICE"), join(staging, "NOTICE"));
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--format-version", "1"], { cwd: e2eeRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
  const selected = new Set(metadata.resolve.nodes.map((node) => node.id));
  const sections = [];
  const seenLicenses = new Set();
  for (const dependency of metadata.packages.filter((value) => selected.has(value.id) && value.source).sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))) {
    const directory = dirname(dependency.manifest_path);
    const licenseFiles = readdirSync(directory).filter((name) => /^(LICENSE|COPYING|UNLICENSE)/iu.test(name) && statSync(join(directory, name)).isFile()).sort();
    const texts = [];
    for (const name of licenseFiles) {
      const text = readFileSync(join(directory, name), "utf8");
      const digest = createHash("sha256").update(text).digest("hex");
      if (!seenLicenses.has(digest)) { seenLicenses.add(digest); texts.push(`--- ${name} ---\n${text.trim()}\n`); }
    }
    sections.push(`=== ${dependency.name} ${dependency.version} (${dependency.license ?? "license-file"}) ===\n${texts.join("\n")}`);
  }
  writeFileSync(join(staging, "THIRD_PARTY_LICENSES.txt"), `${sections.join("\n")}\n`);
  const sourcePackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const packaged = { name: sourcePackage.name, version: sourcePackage.version, private: true, type: "module", engines: sourcePackage.engines, exports: sourcePackage.exports, files: sourcePackage.files };
  writeFileSync(join(staging, "package.json"), `${JSON.stringify(packaged, null, 2)}\n`);
}
console.log(`${mode} ${target} ${sha256}`);
