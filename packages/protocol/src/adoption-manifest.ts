// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import {
  type AdoptionApprovalId,
  type AdoptionCompatibility,
  type AdoptionEcosystem,
  type AdoptionId,
  type AdoptionResourceKind,
  type AdoptionRevisionId,
  type AdoptionScope,
  type AdoptionSourceLock,
  parseAdoptionApprovalId,
  parseAdoptionCompatibility,
  parseAdoptionEcosystem,
  parseAdoptionId,
  parseAdoptionResourceKind,
  parseAdoptionRevisionId,
  parseAdoptionScope,
  parseAdoptionSourceLock,
} from "./adoption.ts";
import { ProtocolValidationError } from "./event-envelope.ts";

export const ADOPTION_MANIFEST_VERSION = 1 as const;

export interface AdoptionManifestFile {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly executable: boolean;
}

export interface AdoptionManifestSurface {
  readonly surfaceId: string;
  readonly kind: AdoptionResourceKind;
  readonly name: string;
  readonly primary: boolean;
  readonly executable: boolean;
  readonly compatibility: AdoptionCompatibility;
  readonly rationale: string;
  readonly sourcePath?: string;
  readonly generatedPaths: readonly string[];
}

export interface AdoptionManifestLicense {
  readonly expression?: string;
  readonly files: readonly AdoptionManifestFile[];
  readonly notices: readonly AdoptionManifestFile[];
  readonly warnings: readonly string[];
}

export interface AdoptionManifestModel {
  readonly converterVersion: string;
  readonly targetContractVersion: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly thinking?: string;
  readonly requestSettings: Readonly<Record<string, string | number | boolean>>;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly durationMs?: number;
  readonly childSessionId?: string;
}

export interface AdoptionManifestVerificationStep {
  readonly name: string;
  readonly version: string;
  readonly status: "passed" | "failed" | "omitted";
  readonly rationale?: string;
  readonly logSha256?: string;
}

export interface AdoptionManifestVerification {
  readonly verifierVersion: string;
  readonly environment: string;
  readonly sandboxControls: readonly string[];
  readonly steps: readonly AdoptionManifestVerificationStep[];
}

export interface AdoptionManifestApproval {
  readonly approvalId: AdoptionApprovalId;
  readonly kind: "conversion" | "partial" | "activation";
  readonly actorId: string;
  readonly approvedAt: string;
  readonly bindingSha256: string;
}

export interface AdoptionManifestDependency {
  readonly name: string;
  readonly source: string;
  readonly immutableIdentity: string;
  readonly integrity?: string;
  readonly auditStatus: "passed" | "warning" | "unsupported";
}

export interface AdoptionManifest {
  readonly version: typeof ADOPTION_MANIFEST_VERSION;
  readonly adoptionId: AdoptionId;
  readonly revisionId: AdoptionRevisionId;
  readonly ecosystem: AdoptionEcosystem;
  readonly scope: AdoptionScope;
  readonly packageId: string;
  readonly sourceUri: string;
  readonly sourceLock: AdoptionSourceLock;
  readonly sourceContentSha256: string;
  readonly fileInventorySha256: string;
  readonly sourceFiles: readonly AdoptionManifestFile[];
  readonly license: AdoptionManifestLicense;
  readonly model: AdoptionManifestModel;
  readonly surfaces: readonly AdoptionManifestSurface[];
  readonly requestedCapabilities: readonly string[];
  readonly approvedCapabilities: readonly string[];
  readonly deniedCapabilities: readonly string[];
  readonly generatedFiles: readonly AdoptionManifestFile[];
  readonly dependencies: readonly AdoptionManifestDependency[];
  readonly verification: AdoptionManifestVerification;
  readonly unsupportedBehavior: readonly string[];
  readonly partialAdoptionAcknowledged: boolean;
  readonly approvals: readonly AdoptionManifestApproval[];
  readonly parentRevisionId?: AdoptionRevisionId;
  readonly overlayHashes: readonly string[];
}

const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const CAPABILITY = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const MAX = Object.freeze({ array: 10_000, string: 4_096, rationale: 16_384, settings: 128 });

type JsonObject = Record<string, unknown>;

function fail(path: string, reason: string): never {
  throw new ProtocolValidationError(path, reason);
}

function object(value: unknown, path: string, keys: readonly string[]): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(path, "must be an object");
  const record = value as JsonObject;
  for (const key of Object.keys(record))
    if (!keys.includes(key)) fail(`${path}.${key}`, "is not allowed");
  return record;
}

function string(value: unknown, path: string, max: number = MAX.string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > max
  )
    fail(path, "must be a non-empty bounded string");
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) fail(path, "contains control characters");
  }
  return value;
}

function optionalString(
  value: unknown,
  path: string,
  max: number = MAX.string,
): string | undefined {
  return value === undefined ? undefined : string(value, path, max);
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail(path, "must be a non-negative safe integer");
  return value as number;
}

function numberValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    fail(path, "must be a non-negative finite number");
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function array<T>(
  value: unknown,
  path: string,
  parse: (item: unknown, path: string) => T,
): readonly T[] {
  if (!Array.isArray(value) || value.length > MAX.array) fail(path, "must be a bounded array");
  return Object.freeze(value.map((item, index) => parse(item, `${path}[${index}]`)));
}

function sha(value: unknown, path: string): string {
  const parsed = string(value, path, 64);
  if (!SHA256.test(parsed)) fail(path, "must be lowercase SHA-256");
  return parsed;
}

function relativePath(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (
    parsed.startsWith("/") ||
    parsed.includes("\\") ||
    parsed.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    fail(path, "must be a canonical relative path");
  return parsed.normalize("NFC");
}

function safeUri(value: unknown, path: string): string {
  const parsed = string(value, path);
  let uri: URL;
  try {
    uri = new URL(parsed);
  } catch {
    fail(path, "must be an absolute URI");
  }
  if (uri.username !== "" || uri.password !== "" || uri.search !== "" || uri.hash !== "")
    fail(path, "must not contain credentials, a query, or a fragment");
  return uri.href;
}

function parseFile(value: unknown, path: string): AdoptionManifestFile {
  const input = object(value, path, ["path", "sha256", "sizeBytes", "executable"]);
  return Object.freeze({
    path: relativePath(input.path, `${path}.path`),
    sha256: sha(input.sha256, `${path}.sha256`),
    sizeBytes: integer(input.sizeBytes, `${path}.sizeBytes`),
    executable: boolean(input.executable, `${path}.executable`),
  });
}

function parseSurface(value: unknown, path: string): AdoptionManifestSurface {
  const input = object(value, path, [
    "surfaceId",
    "kind",
    "name",
    "primary",
    "executable",
    "compatibility",
    "rationale",
    "sourcePath",
    "generatedPaths",
  ]);
  const sourcePath =
    input.sourcePath === undefined
      ? undefined
      : relativePath(input.sourcePath, `${path}.sourcePath`);
  return Object.freeze({
    surfaceId: string(input.surfaceId, `${path}.surfaceId`, 256),
    kind: parseAdoptionResourceKind(input.kind, `${path}.kind`),
    name: string(input.name, `${path}.name`, 256),
    primary: boolean(input.primary, `${path}.primary`),
    executable: boolean(input.executable, `${path}.executable`),
    compatibility: parseAdoptionCompatibility(input.compatibility, `${path}.compatibility`),
    rationale: string(input.rationale, `${path}.rationale`, MAX.rationale),
    ...(sourcePath === undefined ? {} : { sourcePath }),
    generatedPaths: array(input.generatedPaths, `${path}.generatedPaths`, relativePath),
  });
}

function parseLicense(value: unknown, path: string): AdoptionManifestLicense {
  const input = object(value, path, ["expression", "files", "notices", "warnings"]);
  const expression = optionalString(input.expression, `${path}.expression`, 512);
  return Object.freeze({
    ...(expression === undefined ? {} : { expression }),
    files: array(input.files, `${path}.files`, parseFile),
    notices: array(input.notices, `${path}.notices`, parseFile),
    warnings: array(input.warnings, `${path}.warnings`, (item, itemPath) =>
      string(item, itemPath, MAX.rationale),
    ),
  });
}

function parseSettings(
  value: unknown,
  path: string,
): Readonly<Record<string, string | number | boolean>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(path, "must be an object");
  const keys = Object.keys(value as JsonObject).sort();
  if (keys.length > MAX.settings) fail(path, "has too many settings");
  const output: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    string(key, `${path} key`, 128);
    if (/credential|secret|token|password|auth/i.test(key))
      fail(`${path}.${key}`, "may contain credentials");
    const item = (value as JsonObject)[key];
    if (typeof item === "string") output[key] = string(item, `${path}.${key}`, 1_024);
    else if (typeof item === "boolean") output[key] = item;
    else if (typeof item === "number" && Number.isFinite(item)) output[key] = item;
    else fail(`${path}.${key}`, "must be a scalar JSON value");
  }
  return Object.freeze(output);
}

function parseModel(value: unknown, path: string): AdoptionManifestModel {
  const input = object(value, path, [
    "converterVersion",
    "targetContractVersion",
    "providerId",
    "modelId",
    "thinking",
    "requestSettings",
    "inputTokens",
    "outputTokens",
    "costUsd",
    "durationMs",
    "childSessionId",
  ]);
  const optional: Record<string, unknown> = {};
  for (const key of ["providerId", "modelId", "thinking", "childSessionId"] as const) {
    const parsed = optionalString(input[key], `${path}.${key}`, 512);
    if (parsed !== undefined) optional[key] = parsed;
  }
  for (const key of ["inputTokens", "outputTokens", "durationMs"] as const)
    if (input[key] !== undefined) optional[key] = integer(input[key], `${path}.${key}`);
  if (input.costUsd !== undefined) optional.costUsd = numberValue(input.costUsd, `${path}.costUsd`);
  return Object.freeze({
    converterVersion: string(input.converterVersion, `${path}.converterVersion`, 512),
    targetContractVersion: string(
      input.targetContractVersion,
      `${path}.targetContractVersion`,
      512,
    ),
    ...optional,
    requestSettings: parseSettings(input.requestSettings, `${path}.requestSettings`),
  }) as AdoptionManifestModel;
}

function parseStep(value: unknown, path: string): AdoptionManifestVerificationStep {
  const input = object(value, path, ["name", "version", "status", "rationale", "logSha256"]);
  if (!(["passed", "failed", "omitted"] as const).includes(input.status as never))
    fail(`${path}.status`, "is invalid");
  const rationale = optionalString(input.rationale, `${path}.rationale`, MAX.rationale);
  const logSha256 =
    input.logSha256 === undefined ? undefined : sha(input.logSha256, `${path}.logSha256`);
  return Object.freeze({
    name: string(input.name, `${path}.name`, 256),
    version: string(input.version, `${path}.version`, 512),
    status: input.status as AdoptionManifestVerificationStep["status"],
    ...(rationale === undefined ? {} : { rationale }),
    ...(logSha256 === undefined ? {} : { logSha256 }),
  });
}

function parseVerification(value: unknown, path: string): AdoptionManifestVerification {
  const input = object(value, path, ["verifierVersion", "environment", "sandboxControls", "steps"]);
  return Object.freeze({
    verifierVersion: string(input.verifierVersion, `${path}.verifierVersion`, 512),
    environment: string(input.environment, `${path}.environment`, 1_024),
    sandboxControls: array(input.sandboxControls, `${path}.sandboxControls`, (item, itemPath) =>
      string(item, itemPath, 512),
    ),
    steps: array(input.steps, `${path}.steps`, parseStep),
  });
}

function parseApproval(value: unknown, path: string): AdoptionManifestApproval {
  const input = object(value, path, [
    "approvalId",
    "kind",
    "actorId",
    "approvedAt",
    "bindingSha256",
  ]);
  if (!(["conversion", "partial", "activation"] as const).includes(input.kind as never))
    fail(`${path}.kind`, "is invalid");
  const approvedAt = string(input.approvedAt, `${path}.approvedAt`, 64);
  if (!ISO_DATE.test(approvedAt) || Number.isNaN(Date.parse(approvedAt)))
    fail(`${path}.approvedAt`, "must be an ISO timestamp");
  return Object.freeze({
    approvalId: parseAdoptionApprovalId(input.approvalId, `${path}.approvalId`),
    kind: input.kind as AdoptionManifestApproval["kind"],
    actorId: string(input.actorId, `${path}.actorId`, 512),
    approvedAt,
    bindingSha256: sha(input.bindingSha256, `${path}.bindingSha256`),
  });
}

function parseDependency(value: unknown, path: string): AdoptionManifestDependency {
  const input = object(value, path, [
    "name",
    "source",
    "immutableIdentity",
    "integrity",
    "auditStatus",
  ]);
  if (!(["passed", "warning", "unsupported"] as const).includes(input.auditStatus as never))
    fail(`${path}.auditStatus`, "is invalid");
  const integrity = optionalString(input.integrity, `${path}.integrity`, 512);
  return Object.freeze({
    name: string(input.name, `${path}.name`, 256),
    source: safeUri(input.source, `${path}.source`),
    immutableIdentity: string(input.immutableIdentity, `${path}.immutableIdentity`, 1_024),
    ...(integrity === undefined ? {} : { integrity }),
    auditStatus: input.auditStatus as AdoptionManifestDependency["auditStatus"],
  });
}

function capabilities(value: unknown, path: string): readonly string[] {
  const parsed = array(value, path, (item, itemPath) => string(item, itemPath, 256));
  for (const item of parsed)
    if (!CAPABILITY.test(item)) fail(path, "contains an invalid capability");
  if (new Set(parsed).size !== parsed.length) fail(path, "contains duplicates");
  return parsed;
}

export function parseAdoptionManifest(value: unknown, path = "adoptionManifest"): AdoptionManifest {
  const input = object(value, path, [
    "version",
    "adoptionId",
    "revisionId",
    "ecosystem",
    "scope",
    "packageId",
    "sourceUri",
    "sourceLock",
    "sourceContentSha256",
    "fileInventorySha256",
    "sourceFiles",
    "license",
    "model",
    "surfaces",
    "requestedCapabilities",
    "approvedCapabilities",
    "deniedCapabilities",
    "generatedFiles",
    "dependencies",
    "verification",
    "unsupportedBehavior",
    "partialAdoptionAcknowledged",
    "approvals",
    "parentRevisionId",
    "overlayHashes",
  ]);
  if (input.version !== ADOPTION_MANIFEST_VERSION)
    fail(`${path}.version`, `must be ${ADOPTION_MANIFEST_VERSION}`);
  const surfaces = array(input.surfaces, `${path}.surfaces`, parseSurface);
  if (surfaces.filter((surface) => surface.primary).length !== 1)
    fail(`${path}.surfaces`, "must contain exactly one primary surface");
  const parentRevisionId =
    input.parentRevisionId === undefined
      ? undefined
      : parseAdoptionRevisionId(input.parentRevisionId, `${path}.parentRevisionId`);
  return Object.freeze({
    version: ADOPTION_MANIFEST_VERSION,
    adoptionId: parseAdoptionId(input.adoptionId, `${path}.adoptionId`),
    revisionId: parseAdoptionRevisionId(input.revisionId, `${path}.revisionId`),
    ecosystem: parseAdoptionEcosystem(input.ecosystem, `${path}.ecosystem`),
    scope: parseAdoptionScope(input.scope, `${path}.scope`),
    packageId: string(input.packageId, `${path}.packageId`, 512),
    sourceUri: safeUri(input.sourceUri, `${path}.sourceUri`),
    sourceLock: parseAdoptionSourceLock(input.sourceLock, `${path}.sourceLock`),
    sourceContentSha256: sha(input.sourceContentSha256, `${path}.sourceContentSha256`),
    fileInventorySha256: sha(input.fileInventorySha256, `${path}.fileInventorySha256`),
    sourceFiles: array(input.sourceFiles, `${path}.sourceFiles`, parseFile),
    license: parseLicense(input.license, `${path}.license`),
    model: parseModel(input.model, `${path}.model`),
    surfaces,
    requestedCapabilities: capabilities(
      input.requestedCapabilities,
      `${path}.requestedCapabilities`,
    ),
    approvedCapabilities: capabilities(input.approvedCapabilities, `${path}.approvedCapabilities`),
    deniedCapabilities: capabilities(input.deniedCapabilities, `${path}.deniedCapabilities`),
    generatedFiles: array(input.generatedFiles, `${path}.generatedFiles`, parseFile),
    dependencies: array(input.dependencies, `${path}.dependencies`, parseDependency),
    verification: parseVerification(input.verification, `${path}.verification`),
    unsupportedBehavior: array(
      input.unsupportedBehavior,
      `${path}.unsupportedBehavior`,
      (item, itemPath) => string(item, itemPath, MAX.rationale),
    ),
    partialAdoptionAcknowledged: boolean(
      input.partialAdoptionAcknowledged,
      `${path}.partialAdoptionAcknowledged`,
    ),
    approvals: array(input.approvals, `${path}.approvals`, parseApproval),
    ...(parentRevisionId === undefined ? {} : { parentRevisionId }),
    overlayHashes: array(input.overlayHashes, `${path}.overlayHashes`, sha),
  });
}
