// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/;

export function renderOpenVex(version: string, timestamp: string): string {
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid release version: ${version}`);
  if (Number.isNaN(Date.parse(timestamp)))
    throw new Error(`Invalid release timestamp: ${timestamp}`);

  return `${JSON.stringify(
    {
      "@context": "https://openvex.dev/ns/v0.2.0",
      "@id": `https://github.com/Observal/Axl/releases/tag/v${version}#vex`,
      author: "https://github.com/Observal",
      role: "Project maintainer",
      timestamp,
      version: 1,
      tooling: "Axl release workflow",
      statements: [],
    },
    null,
    2,
  )}\n`;
}

function run(
  command: string,
  args: readonly string[],
  cwd = ROOT,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

export function buildReleaseMetadata(version: string): {
  readonly sbom: string;
  readonly vex: string;
  readonly checksums: string;
} {
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid release version: ${version}`);

  const staging = join(ROOT, ".release", "npm");
  const artifacts = join(ROOT, ".release", "artifacts");
  const sbom = join(artifacts, `observal-axl-${version}.cdx.json`);
  const vex = join(artifacts, `observal-axl-${version}.openvex.json`);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "axl-release-sbom-"));
  const temporary = join(temporaryRoot, "@observal", "axl");

  try {
    mkdirSync(temporary, { recursive: true });
    cpSync(staging, temporary, { recursive: true });
    const npmUserConfig = join(temporaryRoot, ".npmrc-release");
    writeFileSync(npmUserConfig, "");
    const npmEnvironment = { ...process.env };
    for (const name of Object.keys(npmEnvironment)) {
      if (/^(?:npm|pnpm)_/i.test(name)) delete npmEnvironment[name];
    }
    npmEnvironment.NPM_CONFIG_USERCONFIG = npmUserConfig;
    run(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
      temporary,
      npmEnvironment,
    );
    const parsed = JSON.parse(
      run(
        "npm",
        ["sbom", "--omit", "dev", "--sbom-format", "cyclonedx"],
        temporary,
        npmEnvironment,
      ),
    ) as {
      serialNumber?: string;
      readonly specVersion?: string;
      readonly metadata?: {
        timestamp?: string;
        readonly component?: { readonly name?: string; readonly version?: string };
      };
    };
    const component = parsed.metadata?.component;
    if (
      parsed.specVersion !== "1.5" ||
      component?.name !== "@observal/axl" ||
      component.version !== version
    ) {
      throw new Error("Generated SBOM does not describe the expected @observal/axl release");
    }
    delete parsed.serialNumber;
    if (parsed.metadata) delete parsed.metadata.timestamp;
    writeFileSync(sbom, `${JSON.stringify(parsed, null, 2)}\n`);

    const timestamp = run("git", ["show", "-s", "--format=%cI", "HEAD"]);
    writeFileSync(vex, renderOpenVex(version, timestamp));

    const checksums = join(artifacts, "checksums.txt");
    const subjects = [
      join(artifacts, `observal-axl-${version}.tgz`),
      join(artifacts, "install.sh"),
      sbom,
      vex,
    ];
    writeFileSync(
      checksums,
      `${subjects
        .map(
          (path) =>
            `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${basename(path)}`,
        )
        .join("\n")}\n`,
    );
    return { sbom, vex, checksums };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv.slice(2).find((argument) => argument !== "--");
  if (!version) throw new Error("Usage: node scripts/build-release-metadata.ts VERSION");
  const result = buildReleaseMetadata(version);
  process.stdout.write(`${result.sbom}\n${result.vex}\n${result.checksums}\n`);
}
