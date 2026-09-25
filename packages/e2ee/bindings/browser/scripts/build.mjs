// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "production" && mode !== "test") throw new Error("usage: build.mjs production|test");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const e2eeRoot = resolve(packageRoot, "../..");
const repositoryRoot = resolve(e2eeRoot, "../..");
const targetDirectory = join(e2eeRoot, "target", `browser-${mode}`);
const generated = join(packageRoot, "dist", `.generated-${mode}`);
const staging = join(packageRoot, "dist", mode === "production" ? "package" : "test-artifact");
const toolManifest = join(packageRoot, "scripts/wasm-bindgen-driver/Cargo.toml");
const wasmName = "axl_e2ee_browser";

rmSync(generated, { recursive: true, force: true });
rmSync(staging, { recursive: true, force: true });
mkdirSync(generated, { recursive: true });
mkdirSync(join(staging, "wasm"), { recursive: true });
mkdirSync(join(staging, "worker"), { recursive: true });

const cargoArguments = [
  "build",
  "--locked",
  "--release",
  "--target",
  "wasm32-unknown-unknown",
  "--target-dir",
  targetDirectory,
  "-p",
  "axl-e2ee-browser",
];
if (mode === "test") cargoArguments.push("--features", "test-fixtures");
execFileSync("cargo", cargoArguments, { cwd: e2eeRoot, stdio: "inherit" });
const inputWasm = join(targetDirectory, "wasm32-unknown-unknown/release", `${wasmName}.wasm`);
execFileSync(
  "cargo",
  [
    "run",
    "--locked",
    "--offline",
    "--release",
    "--manifest-path",
    toolManifest,
    "--",
    inputWasm,
    generated,
    wasmName,
  ],
  { cwd: packageRoot, stdio: "inherit" },
);

for (const name of [`${wasmName}.js`, `${wasmName}_bg.wasm`]) {
  cpSync(join(generated, name), join(staging, "wasm", name));
}
cpSync(
  mode === "production" ? join(packageRoot, "worker/index.js") : join(packageRoot, "test/worker.js"),
  join(staging, "worker/index.js"),
);
// The production endpoint driver and store are byte-identical in both artifacts. The test worker
// drives them against the fixture WASM so transitions and trust come from the same module instance.
for (const name of ["worker/storage.js", "worker/endpoint.js"]) {
  cpSync(join(packageRoot, name), join(staging, name));
}
if (mode === "test") {
  cpSync(join(packageRoot, "test/browser-storage.js"), join(staging, "worker/browser-storage.js"));
  cpSync(join(packageRoot, "test/barrier-scenario.js"), join(staging, "worker/barrier-scenario.js"));
}
if (mode === "production") {
  mkdirSync(join(staging, "loader"), { recursive: true });
  cpSync(join(packageRoot, "loader/index.js"), join(staging, "loader/index.js"));
  for (const name of ["index.d.ts", "README.md"]) cpSync(join(packageRoot, name), join(staging, name));
  for (const name of ["LICENSE", "NOTICE"]) {
    cpSync(join(repositoryRoot, name), join(staging, name));
  }
}

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
const sourceHash = createHash("sha256");
for (const path of sourcePaths) {
  sourceHash.update(path);
  sourceHash.update("\0");
  sourceHash.update(readFileSync(join(repositoryRoot, path)));
  sourceHash.update("\0");
}
const artifactFiles = [
  { kind: "glue", path: `wasm/${wasmName}.js` },
  { kind: "wasm", path: `wasm/${wasmName}_bg.wasm` },
  { kind: "worker", path: "worker/index.js" },
  { kind: "worker-storage", path: "worker/storage.js" },
  { kind: "worker-endpoint", path: "worker/endpoint.js" },
];
const artifacts = artifactFiles.map((entry) => ({
  ...entry,
  sha256: createHash("sha256").update(readFileSync(join(staging, entry.path))).digest("hex"),
}));
const manifest = {
  ...JSON.parse(readFileSync(join(packageRoot, "artifact/manifest-source.json"), "utf8")),
  sourceBaseCommit,
  sourceTreeState: sourceStatus === "" ? "clean" : "dirty",
  e2eeSourceSha256: sourceHash.digest("hex"),
  cargoLockSha256: createHash("sha256").update(readFileSync(join(e2eeRoot, "Cargo.lock"))).digest("hex"),
  artifactKind: mode,
  artifacts,
};
writeFileSync(join(staging, "integrity.json"), `${JSON.stringify(manifest, null, 2)}\n`);

if (mode === "production") {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--locked", "--format-version", "1"], {
      cwd: e2eeRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
  const selected = new Set(metadata.resolve.nodes.map((node) => node.id));
  const sections = [];
  const seenLicenses = new Set();
  for (const dependency of metadata.packages
    .filter((value) => selected.has(value.id) && value.source)
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))) {
    const directory = dirname(dependency.manifest_path);
    const licenseFiles = readdirSync(directory)
      .filter(
        (name) => /^(LICENSE|COPYING|UNLICENSE)/iu.test(name) && statSync(join(directory, name)).isFile(),
      )
      .sort();
    const texts = [];
    for (const name of licenseFiles) {
      const text = readFileSync(join(directory, name), "utf8");
      const digest = createHash("sha256").update(text).digest("hex");
      if (!seenLicenses.has(digest)) {
        seenLicenses.add(digest);
        texts.push(`--- ${name} ---\n${text.trim()}\n`);
      }
    }
    sections.push(
      `=== ${dependency.name} ${dependency.version} (${dependency.license ?? "license-file"}) ===\n${texts.join("\n")}`,
    );
  }
  writeFileSync(join(staging, "THIRD_PARTY_LICENSES.txt"), `${sections.join("\n")}\n`);
  const sourcePackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const packaged = {
    name: sourcePackage.name,
    version: sourcePackage.version,
    private: true,
    type: "module",
    exports: sourcePackage.exports,
    files: sourcePackage.files,
  };
  writeFileSync(join(staging, "package.json"), `${JSON.stringify(packaged, null, 2)}\n`);
}
console.log(`${mode} ${artifacts.find((entry) => entry.kind === "wasm").sha256}`);
