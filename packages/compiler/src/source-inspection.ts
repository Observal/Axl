// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from "node:crypto";
import { basename } from "node:path";
import { DiscoveryError } from "./errors.ts";
import {
  type BoundedFileSystem,
  findFile,
  nodeFileSystem,
  type TreeSnapshot,
} from "./filesystem.ts";
import { sha256 } from "./identity.ts";
import { DEFAULT_INSPECTION_LIMITS, type InspectionLimits } from "./limits.ts";
import {
  type ImmutableFileInventoryEntry,
  immutableTreeSha256,
  snapshotSourcePath,
} from "./local-snapshot.ts";
import { parseJsonObject } from "./parsing.ts";
import { isBlockedSourcePath, isPotentialSecretSource } from "./source-security.ts";

export interface SourceInspectionDiagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly relativePath: string;
}

export interface DetectedTest {
  readonly kind: "script" | "file";
  readonly name: string;
  readonly relativePath?: string;
}

export interface SourceDisclosureEntry extends ImmutableFileInventoryEntry {
  readonly disclose: boolean;
  readonly reason?: "blocked-path" | "potential-secret";
}

export interface SourceInspection {
  readonly canonicalRoot: string;
  readonly discoveryFingerprint: string;
  readonly treeSha256: string;
  readonly inventory: readonly ImmutableFileInventoryEntry[];
  readonly inventorySha256: string;
  readonly packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  readonly lockfiles: readonly string[];
  readonly tests: readonly DetectedTest[];
  readonly licenseFiles: readonly string[];
  readonly noticeFiles: readonly string[];
  readonly blockedPaths: readonly string[];
  readonly potentialSecretFiles: readonly string[];
  readonly capabilityIndicators: readonly string[];
  readonly disclosure: readonly SourceDisclosureEntry[];
  readonly disclosureSizeBytes: number;
  readonly diagnostics: readonly SourceInspectionDiagnostic[];
}

const SHA256 = /^[0-9a-f]{64}$/u;
const LOCKFILES = new Map<string, SourceInspection["packageManager"]>([
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
]);
const LICENSE = /^(?:licen[cs]e|copying)(?:\.[^.]+)?$/iu;
const NOTICE = /^(?:notice|third[-_ ]party(?:[-_ ]notices?)?)(?:\.[^.]+)?$/iu;
const TEST_FILE =
  /(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|$)|(?:\.test|\.spec)\.[cm]?[jt]sx?$/iu;
const TEXT_FILE =
  /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml|md|txt|sh|bash|zsh|fish|env|ini|cfg|conf)$/iu;
const CAPABILITIES: readonly [string, RegExp][] = [
  ["process.execute", /(?:node:)?child_process|\b(?:spawn|execFile|execSync)\s*\(/u],
  [
    "filesystem.read",
    /(?:node:)?fs(?:\/promises)?["']|\b(?:readFile|readdir|createReadStream)\s*\(/u,
  ],
  ["filesystem.write", /\b(?:writeFile|appendFile|createWriteStream|rm|unlink|rename)\s*\(/u],
  ["network.client", /(?:node:)?(?:http|https|net|tls)["']|\b(?:fetch|WebSocket)\s*\(/u],
  ["environment.read", /\bprocess\.env\b/u],
  ["ui.contribute", /\b(?:registerRenderer|registerShortcut|registerCommand)\s*\(/u],
  ["provider.register", /\bregisterProvider\s*\(/u],
  ["tool.register", /\bregisterTool\s*\(/u],
  ["resource.discover", /\bresources_discover\b/u],
];

function equalsFingerprint(expected: string, actual: string): boolean {
  if (!SHA256.test(expected) || !SHA256.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

function inventoryFor(snapshot: TreeSnapshot): readonly ImmutableFileInventoryEntry[] {
  return snapshot.files.map((file) => ({
    relativePath: file.relativePath,
    sha256: sha256(file.bytes),
    sizeBytes: file.bytes.byteLength,
    executable: (file.stat.mode & 0o111) !== 0,
  }));
}

function safeText(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function packageTestScripts(snapshot: TreeSnapshot, maximumBytes: number): DetectedTest[] {
  const manifest = findFile(snapshot, "package.json");
  if (manifest === undefined) return [];
  const parsed = parseJsonObject(manifest, maximumBytes);
  if (parsed.scripts === undefined) return [];
  if (
    parsed.scripts === null ||
    Array.isArray(parsed.scripts) ||
    typeof parsed.scripts !== "object"
  ) {
    throw new DiscoveryError(
      "adoption_manifest_invalid",
      "package scripts must be an object",
      "package.json",
    );
  }
  return Object.entries(parsed.scripts)
    .filter(
      ([name, command]) => /^(?:test|check|spec)(?::|$)/u.test(name) && typeof command === "string",
    )
    .map(([name]) => ({ kind: "script" as const, name }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export interface InspectSourceOptions {
  readonly sourceRoot: string;
  readonly expectedDiscoveryFingerprint?: string;
  readonly resolveDiscoveryFingerprint?: (snapshot: TreeSnapshot) => string | Promise<string>;
  readonly fileSystem?: BoundedFileSystem;
  readonly limits?: InspectionLimits;
}

/** Inspects hostile source as bounded data. It never executes discovered declarations. */
export async function inspectSource(options: InspectSourceOptions): Promise<SourceInspection> {
  const limits = options.limits ?? DEFAULT_INSPECTION_LIMITS;
  const snapshot = await snapshotSourcePath(
    options.sourceRoot,
    options.fileSystem ?? nodeFileSystem,
    limits,
  );
  if (snapshot.diagnostics.length > 0) {
    throw new DiscoveryError(
      "adoption_source_unavailable",
      "source contains unsupported filesystem entries",
    );
  }
  if (
    (options.expectedDiscoveryFingerprint === undefined) !==
    (options.resolveDiscoveryFingerprint === undefined)
  )
    throw new TypeError("discovery fingerprint and resolver must be supplied together");

  const inventory = inventoryFor(snapshot);
  const treeSha256 = immutableTreeSha256(inventory);
  const actualFingerprint =
    options.resolveDiscoveryFingerprint === undefined
      ? treeSha256
      : await options.resolveDiscoveryFingerprint(snapshot);
  if (
    options.expectedDiscoveryFingerprint !== undefined &&
    !equalsFingerprint(options.expectedDiscoveryFingerprint, actualFingerprint)
  ) {
    throw new DiscoveryError(
      "adoption_source_changed",
      "discovery fingerprint changed before acquisition",
    );
  }
  const lockfiles = inventory
    .map((entry) => entry.relativePath)
    .filter((path) => LOCKFILES.has(basename(path)))
    .sort();
  const managers = new Set(
    lockfiles.map((path) => LOCKFILES.get(basename(path))).filter((value) => value !== undefined),
  );
  const diagnostics: SourceInspectionDiagnostic[] = [];
  if (managers.size > 1)
    diagnostics.push({
      code: "multiple-package-managers",
      severity: "warning",
      relativePath: lockfiles[0] ?? "package.json",
    });

  const tests = [
    ...packageTestScripts(snapshot, limits.maxManifestBytes),
    ...inventory
      .filter((entry) => TEST_FILE.test(entry.relativePath))
      .map((entry) => ({
        kind: "file" as const,
        name: basename(entry.relativePath),
        relativePath: entry.relativePath,
      })),
  ].sort((left, right) =>
    `${left.kind}:${left.relativePath ?? left.name}`.localeCompare(
      `${right.kind}:${right.relativePath ?? right.name}`,
    ),
  );
  const licenseFiles = inventory
    .map((entry) => entry.relativePath)
    .filter((path) => LICENSE.test(basename(path)))
    .sort();
  const noticeFiles = inventory
    .map((entry) => entry.relativePath)
    .filter((path) => NOTICE.test(basename(path)))
    .sort();
  const blockedPaths: string[] = [];
  const potentialSecretFiles: string[] = [];
  const capabilities = new Set<string>();
  const disclosure: SourceDisclosureEntry[] = [];

  for (let index = 0; index < snapshot.files.length; index += 1) {
    const file = snapshot.files[index];
    const item = inventory[index];
    if (file === undefined || item === undefined) throw new Error("inspection inventory mismatch");
    const blocked = isBlockedSourcePath(item.relativePath);
    const potentialSecret = isPotentialSecretSource(item.relativePath, file.bytes);
    const text = TEXT_FILE.test(item.relativePath) ? safeText(file.bytes) : undefined;
    if (blocked) {
      blockedPaths.push(item.relativePath);
      diagnostics.push({
        code: "blocked-sensitive-path",
        severity: "error",
        relativePath: item.relativePath,
      });
    }
    if (potentialSecret) {
      potentialSecretFiles.push(item.relativePath);
      diagnostics.push({
        code: "potential-secret",
        severity: "error",
        relativePath: item.relativePath,
      });
    }
    if (/\.node$/iu.test(item.relativePath) || basename(item.relativePath) === "binding.gyp") {
      diagnostics.push({
        code: "native-addon-unsupported",
        severity: "error",
        relativePath: item.relativePath,
      });
      capabilities.add("native-code");
    }
    if (text !== undefined)
      for (const [capability, pattern] of CAPABILITIES)
        if (pattern.test(text)) capabilities.add(capability);
    disclosure.push({
      ...item,
      disclose: !blocked && !potentialSecret,
      ...(!blocked && !potentialSecret
        ? {}
        : { reason: blocked ? ("blocked-path" as const) : ("potential-secret" as const) }),
    });
  }

  const disclosureSizeBytes = disclosure
    .filter((entry) => entry.disclose)
    .reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const packageManager = managers.size === 1 ? [...managers][0] : undefined;
  return Object.freeze({
    canonicalRoot: snapshot.canonicalRoot,
    discoveryFingerprint: actualFingerprint,
    treeSha256,
    inventory: Object.freeze(inventory),
    inventorySha256: sha256(JSON.stringify(inventory)),
    ...(packageManager === undefined ? {} : { packageManager }),
    lockfiles: Object.freeze(lockfiles),
    tests: Object.freeze(tests),
    licenseFiles: Object.freeze(licenseFiles),
    noticeFiles: Object.freeze(noticeFiles),
    blockedPaths: Object.freeze(blockedPaths.sort()),
    potentialSecretFiles: Object.freeze(potentialSecretFiles.sort()),
    capabilityIndicators: Object.freeze([...capabilities].sort()),
    disclosure: Object.freeze(disclosure),
    disclosureSizeBytes,
    diagnostics: Object.freeze(
      diagnostics.sort((left, right) =>
        `${left.relativePath}:${left.code}`.localeCompare(`${right.relativePath}:${right.code}`),
      ),
    ),
  });
}
