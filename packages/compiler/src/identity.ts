// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type {
  DiscoveryCandidate,
  DiscoveryDiagnostic,
  Ecosystem,
  ResourceKind,
  Scope,
} from "./types.ts";

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("unsupported canonical value");
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").normalize("NFC");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new TypeError("relative resource path is not canonical");
  }
  return normalized;
}

export function candidateId(input: {
  readonly ecosystem: Ecosystem;
  readonly scope: Scope;
  readonly canonicalSourceRoot: string;
  readonly packageIdentity?: string;
  readonly kind: ResourceKind;
  readonly relativeResourcePath: string;
}): string {
  const digest = createHash("sha256")
    .update(
      canonicalize({
        canonicalRelativeResourcePath: normalizeRelativePath(input.relativeResourcePath),
        canonicalSourceRoot: input.canonicalSourceRoot.normalize("NFC"),
        contractVersion: 1,
        ecosystem: input.ecosystem,
        kind: input.kind,
        packageIdentity: input.packageIdentity ?? null,
        scope: input.scope,
      }),
    )
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface FingerprintSourceFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly nlink: number;
}

export function discoveryFingerprint(input: {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly sourceSchemaVersion: string;
  readonly candidateId: string;
  readonly candidateMetadata: unknown;
  readonly sourceFiles: readonly FingerprintSourceFile[];
  readonly inspectionDecisions: readonly DiscoveryDiagnostic[];
  readonly limits: Readonly<Record<string, number>>;
}): string {
  return sha256(canonicalize(input));
}

export function finalizeCandidate(
  candidate: Omit<
    DiscoveryCandidate,
    | "candidateId"
    | "discoveryFingerprint"
    | "sourceFileCount"
    | "sourceTotalBytes"
    | "sourceExecutable"
  >,
  sourceFiles: readonly FingerprintSourceFile[],
  inspectionDecisions: readonly DiscoveryDiagnostic[],
  limits: Readonly<Record<string, number>>,
): DiscoveryCandidate {
  const id = candidateId({
    ecosystem: candidate.ecosystem,
    scope: candidate.scope,
    canonicalSourceRoot: candidate.provenance.canonicalRoot,
    ...(candidate.packageIdentity === undefined
      ? {}
      : { packageIdentity: candidate.packageIdentity }),
    kind: candidate.kind,
    relativeResourcePath: candidate.provenance.relativePath,
  });
  return {
    ...candidate,
    candidateId: id,
    sourceFileCount: sourceFiles.length,
    sourceTotalBytes: sourceFiles.reduce((total, file) => total + file.size, 0),
    sourceExecutable: sourceFiles.some((file) => (file.mode & 0o111) !== 0),
    discoveryFingerprint: discoveryFingerprint({
      adapterId: candidate.adapterId,
      adapterVersion: candidate.adapterVersion,
      sourceSchemaVersion: candidate.sourceSchemaVersion,
      candidateId: id,
      candidateMetadata: {
        ecosystem: candidate.ecosystem,
        scope: candidate.scope,
        kind: candidate.kind,
        displayName: candidate.displayName,
        packageIdentity: candidate.packageIdentity ?? null,
        provenance: candidate.provenance,
        primary: candidate.primary,
        executable: candidate.executable,
        malformed: candidate.malformed,
        surfaces: candidate.surfaces,
        inventory: candidate.inventory ?? null,
        diagnostics: candidate.diagnostics,
      },
      sourceFiles,
      inspectionDecisions,
      limits,
    }),
  };
}
