// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { basename, posix } from "node:path";
import { DiscoveryError } from "../errors.ts";
import type { InspectionLimits } from "../limits.ts";
import { finalizeCandidate, sha256 } from "../identity.ts";
import type { SnapshotFile, TreeSnapshot } from "../filesystem.ts";
import type {
  DiscoveryCandidate,
  DiscoveryDiagnostic,
  Ecosystem,
  PackageInventory,
  ResourceKind,
  ResourceSurface,
  Scope,
} from "../types.ts";

export interface CandidateInput {
  readonly ecosystem: Ecosystem;
  readonly scope: Scope;
  readonly snapshot: TreeSnapshot;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly sourceSchemaVersion: string;
  readonly kind: ResourceKind;
  readonly relativePath: string;
  readonly displayName?: string;
  readonly executable: boolean;
  readonly malformed?: boolean;
  readonly packageIdentity?: string;
  readonly surfaces?: readonly ResourceSurface[];
  readonly inventory?: PackageInventory;
  readonly sourcePrecedence?: number;
  readonly sourcePrefix?: string;
  readonly diagnostics?: readonly DiscoveryDiagnostic[];
}

export function createCandidate(
  input: CandidateInput,
  limits: InspectionLimits,
): DiscoveryCandidate {
  const displayName = input.displayName ?? basename(input.relativePath).replace(/\.[^.]+$/u, "");
  const surfaces = input.surfaces ?? [
    {
      kind: input.kind,
      name: displayName,
      relativePath: input.relativePath,
      primary: true,
      executable: input.executable,
      registrations: [],
      dynamicBehavior: false,
      metadata: {},
    },
  ];
  const packageRoot = input.sourcePrefix ?? posix.dirname(input.relativePath);
  const packagePrefix = packageRoot === "." || packageRoot === "" ? "" : `${packageRoot}/`;
  const relevant = input.snapshot.files.filter((file) =>
    input.kind === "package"
      ? file.relativePath.startsWith(packagePrefix)
      : file.relativePath === input.relativePath ||
        file.relativePath.startsWith(`${input.relativePath}/`),
  );
  const sourceFiles = relevant.map((file) => ({
    path: file.relativePath,
    sha256: sha256(file.bytes),
    size: file.bytes.byteLength,
  }));
  return finalizeCandidate(
    {
      ecosystem: input.ecosystem,
      scope: input.scope,
      kind: input.kind,
      displayName,
      ...(input.packageIdentity === undefined ? {} : { packageIdentity: input.packageIdentity }),
      provenance: {
        canonicalRoot: input.snapshot.canonicalRoot,
        relativePath: input.relativePath,
        ...(sourceFiles[0] === undefined ? {} : { sourceFileSha256: sourceFiles[0].sha256 }),
        ...(input.sourcePrecedence === undefined
          ? {}
          : { sourcePrecedence: input.sourcePrecedence }),
      },
      primary: true,
      executable: input.executable,
      malformed: input.malformed ?? false,
      adapterId: input.adapterId,
      adapterVersion: input.adapterVersion,
      sourceSchemaVersion: input.sourceSchemaVersion,
      surfaces,
      ...(input.inventory === undefined ? {} : { inventory: input.inventory }),
      diagnostics: input.diagnostics ?? [],
    },
    sourceFiles,
    limits as unknown as Readonly<Record<string, number>>,
  );
}

export function diagnosticsForError(error: unknown, root: string): DiscoveryDiagnostic {
  if (error instanceof DiscoveryError) {
    return {
      code: error.code,
      severity: error.code === "adoption_source_unavailable" ? "warning" : "error",
      message: `could not inspect ${root}: ${error.message}`,
      ...(error.relativePath === undefined ? {} : { relativePath: error.relativePath }),
    };
  }
  return {
    code: "root-unavailable",
    severity: "warning",
    message: `could not inspect ${root}: ${error instanceof Error ? error.message : String(error)}`,
  };
}

export function fileMap(snapshot: TreeSnapshot): ReadonlyMap<string, SnapshotFile> {
  return new Map(snapshot.files.map((file) => [file.relativePath, file]));
}

export function conventionalFiles(
  snapshot: TreeSnapshot,
  directory: string,
  extensions?: ReadonlySet<string>,
): readonly SnapshotFile[] {
  const prefix = directory === "" ? "" : `${directory}/`;
  return snapshot.files.filter((file) => {
    if (!file.relativePath.startsWith(prefix)) return false;
    const rest = file.relativePath.slice(prefix.length);
    if (rest.includes("/") && !rest.endsWith("/SKILL.md")) return false;
    if (extensions === undefined) return true;
    const suffix = rest.includes(".") ? rest.slice(rest.lastIndexOf(".")) : "";
    return extensions.has(suffix);
  });
}

export function inventoryExtensionSource(text: string): {
  readonly registrations: readonly string[];
  readonly dynamicBehavior: boolean;
  readonly metadata: Readonly<Record<string, boolean>>;
} {
  const calls = [
    "registerTool",
    "registerCommand",
    "registerShortcut",
    "registerFlag",
    "on",
    "registerProvider",
    "registerRenderer",
    "registerUI",
    "resources_discover",
  ];
  const registrations: string[] = [];
  let dynamicBehavior = false;
  for (const call of calls) {
    const pattern = new RegExp(`\\b${call}\\s*\\(\\s*(["'])([^"']+)\\1`, "gu");
    let found = false;
    for (const match of text.matchAll(pattern)) {
      registrations.push(`${call}:${match[2] ?? ""}`);
      found = true;
    }
    const anyCall = new RegExp(`\\b${call}\\s*\\(`, "u").test(text);
    if (anyCall && !found) dynamicBehavior = true;
  }
  const metadata = {
    staticAnalysisComplete: false,
    builtInOverride: /\b(registerTool|tool)\s*\(\s*["'](?:bash|read|write|edit)["']/u.test(text),
    shellOrProcess: /\b(?:child_process|exec|execFile|spawn|Bun\.spawn|Deno\.Command)\b/u.test(
      text,
    ),
    ui: /\b(?:registerRenderer|registerUI|setWidget|setStatus)\s*\(/u.test(text),
  };
  return { registrations: [...new Set(registrations)].sort(), dynamicBehavior, metadata };
}
