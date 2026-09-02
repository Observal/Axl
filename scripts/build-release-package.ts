// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSync } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "distribution", "npm", "package.json");
const STAGE = join(ROOT, ".release", "npm");
const ARTIFACTS = join(ROOT, ".release", "artifacts");

export interface ReleasePackageManifest {
  readonly name: "@observal/axl";
  readonly version: string;
  readonly description: string;
  readonly type: "module";
  readonly bin: Readonly<Record<"axl", string>>;
  readonly engines: Readonly<Record<"node", string>>;
  readonly files: readonly string[];
  readonly license: "Apache-2.0";
  readonly repository: Readonly<Record<string, string>>;
  readonly bugs: Readonly<Record<string, string>>;
  readonly homepage: string;
  readonly publishConfig: Readonly<Record<"access", "public">>;
  readonly dependencies: Readonly<Record<string, string>>;
}

export interface ReleasePackageResult {
  readonly version: string;
  readonly packagePath: string;
  readonly checksumPath: string;
  readonly installerPath: string;
}

export function validateReleaseVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(version)) {
    throw new Error(`Invalid Axl release version: ${version}`);
  }
}

export function publicManifest(
  source: Record<string, unknown>,
  version = String(source.version ?? ""),
): ReleasePackageManifest {
  validateReleaseVersion(version);
  if (source.name !== "@observal/axl") {
    throw new Error("Release package template must be named @observal/axl");
  }
  const dependencies = source.dependencies;
  if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
    throw new Error("Release package template must declare runtime dependencies");
  }
  return {
    name: "@observal/axl",
    version,
    description: String(source.description),
    type: "module",
    bin: { axl: "dist/axl.js" },
    engines: { node: "^22.19.0 || >=24.0.0" },
    files: ["dist", "LICENSE", "NOTICE", "README.md"],
    license: "Apache-2.0",
    repository: source.repository as Record<string, string>,
    bugs: source.bugs as Record<string, string>,
    homepage: String(source.homepage),
    publishConfig: { access: "public" },
    dependencies: dependencies as Record<string, string>,
  };
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function buildReleasePackage(versionOverride?: string): ReleasePackageResult {
  const source = JSON.parse(readFileSync(TEMPLATE, "utf8")) as Record<string, unknown>;
  const manifest = publicManifest(source, versionOverride ?? String(source.version ?? ""));

  rmSync(join(ROOT, ".release"), { recursive: true, force: true });
  mkdirSync(join(STAGE, "dist"), { recursive: true });
  mkdirSync(ARTIFACTS, { recursive: true });

  const executable = join(STAGE, "dist", "axl.js");
  buildSync({
    entryPoints: [join(ROOT, "packages", "cli", "src", "main.ts")],
    outfile: executable,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: false,
    legalComments: "none",
    external: ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*", "yaml"],
    define: {
      "process.env.AXL_BUILD_VERSION": JSON.stringify(manifest.version),
    },
  });
  let bundled = readFileSync(executable, "utf8");
  if (!bundled.startsWith("#!/usr/bin/env node\n")) {
    bundled = `#!/usr/bin/env node\n${bundled}`;
    writeFileSync(executable, bundled);
  }
  chmodSync(executable, 0o755);

  writeFileSync(join(STAGE, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(join(ROOT, "distribution", "npm", "README.md"), join(STAGE, "README.md"));
  copyFileSync(join(ROOT, "LICENSE"), join(STAGE, "LICENSE"));
  copyFileSync(join(ROOT, "NOTICE"), join(STAGE, "NOTICE"));

  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", STAGE, "--pack-destination", ARTIFACTS, "--json", "--ignore-scripts"],
      { cwd: ROOT, encoding: "utf8" },
    ),
  ) as readonly { readonly filename?: string }[];
  const filename = packed[0]?.filename;
  if (!filename) throw new Error("npm pack did not report an artifact filename");
  const produced = join(ARTIFACTS, filename);
  const canonical = join(ARTIFACTS, `observal-axl-${manifest.version}.tgz`);
  if (produced !== canonical) renameSync(produced, canonical);

  const installer = join(ARTIFACTS, "install.sh");
  copyFileSync(join(ROOT, "scripts", "install.sh"), installer);
  chmodSync(installer, 0o755);

  const checksumPath = join(ARTIFACTS, "checksums.txt");
  const checksums = [canonical, installer]
    .map((path) => `${digest(path)}  ${path.slice(path.lastIndexOf("/") + 1)}`)
    .join("\n");
  writeFileSync(checksumPath, `${checksums}\n`);

  return {
    version: manifest.version,
    packagePath: canonical,
    checksumPath,
    installerPath: installer,
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const versionIndex = process.argv.indexOf("--version");
  const version = versionIndex < 0 ? undefined : process.argv[versionIndex + 1];
  const result = buildReleasePackage(version);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
