// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ArchiveLimits, ExtractedArchive } from "./archive.ts";
import { extractBoundedTar } from "./archive.ts";
import { AcquisitionError } from "./remote-errors.ts";
import { normalizeRegistryOrigin } from "./source-locator.ts";
import { isUnsupportedNativeSourcePath, sensitiveSourceReason } from "./source-security.ts";

const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface NpmLocator {
  readonly kind: "npm";
  readonly registryOrigin: string;
  readonly packageName: string;
  readonly requested: string;
}

export interface NpmResolvedSource {
  readonly registryOrigin: string;
  readonly packageName: string;
  readonly version: string;
  readonly integrity: string;
  readonly tarballUrl: string;
}

export interface NpmSourceLock {
  readonly kind: "npm";
  readonly registryOrigin: string;
  readonly packageName: string;
  readonly version: string;
  readonly integrity: string;
  readonly tarballSha256: string;
}

export interface RegistryCredentialProvider {
  authorizationHeader(reference: string, registryOrigin: string): Promise<string>;
}

export interface ImmutableArtifactCache {
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, bytes: Uint8Array): Promise<void>;
  quarantine?(key: string): Promise<void>;
}

export interface NpmAcquisitionDependencies {
  readonly fetch?: typeof fetch;
  readonly credentials?: RegistryCredentialProvider;
  readonly cache?: ImmutableArtifactCache;
}

export interface NpmResolveOptions {
  readonly credentialReference?: string;
  readonly approvedRedirectOrigins?: readonly string[];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface NpmAcquireOptions extends NpmResolveOptions {
  readonly destination: string;
  readonly offline?: boolean;
  readonly lock?: NpmSourceLock;
  /** Credential-free tarball URL recorded alongside an immutable lock. */
  readonly lockedTarballUrl?: string;
  readonly archiveLimits?: ArchiveLimits;
}

export interface NpmAcquisitionResult {
  readonly lock: NpmSourceLock;
  readonly sourceUri: string;
  readonly snapshot: ExtractedArchive;
  readonly redirects: readonly string[];
  readonly finalOrigin: string;
  readonly credentialReferenceUsed?: string;
  readonly fromCache: boolean;
}

interface RegistryVersion {
  readonly name: string;
  readonly version: string;
  readonly dist: { readonly integrity: string; readonly tarball: string };
}

interface RegistryDocument {
  readonly tags: Readonly<Record<string, string>>;
  readonly versions: Readonly<Record<string, RegistryVersion>>;
}

interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string;
}

function normalizedHttpsUrl(input: string, path: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AcquisitionError("source_unavailable", `${path} is not a valid URL`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new AcquisitionError("source_unavailable", `${path} must be credential-free HTTPS`);
  }
  if (url.search !== "")
    throw new AcquisitionError("source_unavailable", `${path} must not contain a query`);
  return url;
}

function validatePackageName(input: string): string {
  if (
    Buffer.byteLength(input, "utf8") > 214 ||
    !/^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/.test(input)
  ) {
    throw new AcquisitionError("source_unavailable", "npm package name is invalid");
  }
  return input;
}

function parseSemver(input: string): Semver | undefined {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      input,
    );
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? "",
  };
}

function compareSemver(left: Semver, right: Semver): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === "") return 1;
  if (right.prerelease === "") return -1;
  const leftParts = left.prerelease.split(".");
  const rightParts = right.prerelease.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function partialVersion(input: string):
  | {
      readonly value: Semver;
      readonly precision: 1 | 2 | 3;
    }
  | undefined {
  const match = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*|x|X|\*))?(?:\.(0|[1-9]\d*|x|X|\*))?$/.exec(input);
  if (match === null) return undefined;
  const minor = match[2];
  const patch = match[3];
  const precision =
    minor === undefined || /^(?:x|X|\*)$/u.test(minor)
      ? 1
      : patch === undefined || /^(?:x|X|\*)$/u.test(patch)
        ? 2
        : 3;
  return {
    value: {
      major: Number(match[1]),
      minor: precision >= 2 ? Number(minor) : 0,
      patch: precision === 3 ? Number(patch) : 0,
      prerelease: "",
    },
    precision,
  };
}

function upperForPartial(value: Semver, precision: 1 | 2 | 3): Semver {
  return precision === 1
    ? { major: value.major + 1, minor: 0, patch: 0, prerelease: "" }
    : { major: value.major, minor: value.minor + 1, patch: 0, prerelease: "" };
}

function satisfiesComparator(version: Semver, token: string): boolean {
  const trimmed = token.trim();
  const explicitOperator = (["<=", ">=", "<", ">", "="] as const).find((candidate) =>
    trimmed.startsWith(candidate),
  );
  const operator = explicitOperator ?? "=";
  const targetText =
    explicitOperator === undefined ? trimmed : trimmed.slice(explicitOperator.length).trim();
  if (targetText === "") return false;
  const exact = parseSemver(targetText);
  const partial = exact === undefined ? partialVersion(targetText) : undefined;
  const target = exact ?? partial?.value;
  if (target === undefined) return false;
  if (operator === "=" && partial !== undefined && partial.precision < 3)
    return (
      compareSemver(version, target) >= 0 &&
      compareSemver(version, upperForPartial(target, partial.precision)) < 0
    );
  const comparison = compareSemver(version, target);
  return operator === ">"
    ? comparison > 0
    : operator === ">="
      ? comparison >= 0
      : operator === "<"
        ? comparison < 0
        : operator === "<="
          ? comparison <= 0
          : comparison === 0;
}

function satisfiesSet(version: Semver, request: string): boolean {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(request);
  if (hyphen !== null) {
    const lower = partialVersion(hyphen[1] ?? "")?.value ?? parseSemver(hyphen[1] ?? "");
    const upperInput = partialVersion(hyphen[2] ?? "");
    const upper = upperInput?.value ?? parseSemver(hyphen[2] ?? "");
    if (lower === undefined || upper === undefined) return false;
    const upperComparison =
      upperInput !== undefined && upperInput.precision < 3
        ? compareSemver(version, upperForPartial(upper, upperInput.precision)) < 0
        : compareSemver(version, upper) <= 0;
    return compareSemver(version, lower) >= 0 && upperComparison;
  }
  if (request.startsWith("^")) {
    const exactBase = parseSemver(request.slice(1));
    const partialBase = exactBase === undefined ? partialVersion(request.slice(1)) : undefined;
    const base = exactBase ?? partialBase?.value;
    if (base === undefined || compareSemver(version, base) < 0) return false;
    const upper =
      base.major > 0 || partialBase?.precision === 1
        ? { major: base.major + 1, minor: 0, patch: 0, prerelease: "" }
        : base.minor > 0 || partialBase?.precision === 2
          ? { major: 0, minor: base.minor + 1, patch: 0, prerelease: "" }
          : { major: 0, minor: 0, patch: base.patch + 1, prerelease: "" };
    return compareSemver(version, upper) < 0;
  }
  if (request.startsWith("~")) {
    const exactBase = parseSemver(request.slice(1));
    const partialBase = exactBase === undefined ? partialVersion(request.slice(1)) : undefined;
    const base = exactBase ?? partialBase?.value;
    if (base === undefined || compareSemver(version, base) < 0) return false;
    const upper =
      partialBase?.precision === 1
        ? { major: base.major + 1, minor: 0, patch: 0, prerelease: "" }
        : { major: base.major, minor: base.minor + 1, patch: 0, prerelease: "" };
    return compareSemver(version, upper) < 0;
  }
  const tokens: string[] = [];
  let start = -1;
  for (let index = 0; index <= request.length; index += 1) {
    const code = request.charCodeAt(index);
    const whitespace = code === 32 || (code >= 9 && code <= 13);
    if (!whitespace && index < request.length && start === -1) start = index;
    if ((whitespace || index === request.length) && start !== -1) {
      tokens.push(request.slice(start, index));
      start = -1;
    }
  }
  return tokens.length > 0 && tokens.every((token) => satisfiesComparator(version, token));
}

export function npmVersionSatisfies(versionText: string, range: string): boolean {
  const version = parseSemver(versionText);
  if (version === undefined) return false;
  const request = range.trim();
  if (request === "" || request === "*" || request.toLowerCase() === "latest")
    return version.prerelease === "";
  const sets = request.split("||").map((set) => set.trim());
  if (sets.some((set) => set === "")) return false;
  const explicitlyAllowsPrerelease = /\d\.\d\.\d-[0-9A-Za-z]/u.test(request);
  if (version.prerelease !== "" && !explicitlyAllowsPrerelease) return false;
  return sets.some((set) => satisfiesSet(version, set));
}

function registryPath(packageName: string): string {
  return packageName.startsWith("@") ? packageName.replaceAll("/", "%2f") : packageName;
}

function validateJsonBounds(input: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.depth > 32)
      throw new AcquisitionError("npm_metadata_invalid", "registry metadata nesting exceeds limit");
    if (current.value !== null && typeof current.value === "object") {
      const values = Array.isArray(current.value)
        ? current.value
        : Object.values(current.value as Record<string, unknown>);
      entries += values.length;
      if (entries > 100_000)
        throw new AcquisitionError(
          "npm_metadata_invalid",
          "registry metadata entry count exceeds limit",
        );
      for (const value of values) pending.push({ value, depth: current.depth + 1 });
    }
  }
}

function parseRegistryDocument(input: unknown, packageName: string): RegistryDocument {
  validateJsonBounds(input);
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new AcquisitionError("npm_metadata_invalid", "registry metadata must be an object");
  const record = input as Record<string, unknown>;
  const rawVersions = record.versions;
  const rawTags = record["dist-tags"];
  if (
    typeof rawVersions !== "object" ||
    rawVersions === null ||
    Array.isArray(rawVersions) ||
    typeof rawTags !== "object" ||
    rawTags === null ||
    Array.isArray(rawTags)
  ) {
    throw new AcquisitionError(
      "npm_metadata_invalid",
      "registry metadata omits versions or dist-tags",
    );
  }
  const versions: Record<string, RegistryVersion> = Object.create(null) as Record<
    string,
    RegistryVersion
  >;
  for (const [key, value] of Object.entries(rawVersions)) {
    if (
      parseSemver(key) === undefined ||
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    )
      continue;
    const version = value as Record<string, unknown>;
    const dist = version.dist;
    if (
      version.name !== packageName ||
      version.version !== key ||
      typeof dist !== "object" ||
      dist === null ||
      Array.isArray(dist)
    )
      continue;
    const distRecord = dist as Record<string, unknown>;
    if (typeof distRecord.integrity !== "string" || typeof distRecord.tarball !== "string")
      continue;
    versions[key] = {
      name: packageName,
      version: key,
      dist: { integrity: distRecord.integrity, tarball: distRecord.tarball },
    };
  }
  const tags: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [tag, value] of Object.entries(rawTags))
    if (typeof value === "string") tags[tag] = value;
  return { tags, versions };
}

function selectVersion(document: RegistryDocument, requested: string): RegistryVersion {
  const tagged = document.tags[requested];
  const selector = tagged ?? requested;
  const versions = Object.keys(document.versions).filter((version) =>
    npmVersionSatisfies(version, selector),
  );
  versions.sort((left, right) => {
    const parsedLeft = parseSemver(left);
    const parsedRight = parseSemver(right);
    if (parsedLeft === undefined || parsedRight === undefined) return left < right ? -1 : 1;
    return compareSemver(parsedRight, parsedLeft);
  });
  const selected = versions[0] === undefined ? undefined : document.versions[versions[0]];
  if (selected === undefined)
    throw new AcquisitionError(
      "source_mutable",
      "npm selector did not resolve to a verifiable exact version",
    );
  return selected;
}

function sha512Integrity(input: string): { integrity: string; digest: Buffer } {
  const token = input.split(/\s+/).find((value) => value.startsWith("sha512-"));
  if (token === undefined)
    throw new AcquisitionError("npm_metadata_invalid", "npm artifact requires SHA-512 integrity");
  const encoded = token.slice("sha512-".length);
  const digest = Buffer.from(encoded, "base64");
  if (digest.length !== 64 || digest.toString("base64") !== encoded)
    throw new AcquisitionError("npm_metadata_invalid", "npm SHA-512 integrity is invalid");
  return { integrity: token, digest };
}

function cacheKey(integrity: string): string {
  return `npm-sha512-${createHash("sha256").update(integrity).digest("hex")}`;
}

async function boundedResponseBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes))
    throw new AcquisitionError("network_unavailable", "response exceeds byte limit");
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new AcquisitionError("network_unavailable", "response exceeds byte limit");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof AcquisitionError) throw error;
    throw new AcquisitionError("network_unavailable", "registry response could not be read");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchFollowingRedirects(
  start: string,
  origin: string,
  dependencies: NpmAcquisitionDependencies,
  options: NpmResolveOptions,
  maximumBytes: number,
): Promise<{
  bytes: Uint8Array;
  redirects: readonly string[];
  finalUrl: URL;
  credentialUsed: boolean;
}> {
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  if (fetcher === undefined)
    throw new AcquisitionError("network_unavailable", "fetch is unavailable");
  const approved = new Set((options.approvedRedirectOrigins ?? []).map(normalizeRegistryOrigin));
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000)
    throw new AcquisitionError("network_unavailable", "npm acquisition timeout is invalid");
  const deadline = Date.now() + timeoutMs;
  let current = normalizedHttpsUrl(start, "registry URL");
  if (current.origin !== origin && !approved.has(current.origin)) {
    throw new AcquisitionError(
      "network_unavailable",
      "registry artifact uses an unapproved origin",
    );
  }
  const redirects: string[] = [];
  let credentialAllowed = current.origin === origin;
  let credentialUsed = false;
  for (let count = 0; count <= MAX_REDIRECTS; count += 1) {
    const headers = new Headers({ accept: "application/json, application/octet-stream" });
    if (credentialAllowed && options.credentialReference !== undefined) {
      if (dependencies.credentials === undefined)
        throw new AcquisitionError(
          "credential_unavailable",
          "registry credential provider is unavailable",
        );
      headers.set(
        "authorization",
        await dependencies.credentials.authorizationHeader(options.credentialReference, origin),
      );
      credentialUsed = true;
    }
    if (options.signal?.aborted)
      throw new AcquisitionError("acquisition_cancelled", "npm acquisition was cancelled");
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new AcquisitionError("acquisition_timed_out", "npm acquisition timed out");
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), remaining);
    const signal =
      options.signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([options.signal, timeoutController.signal]);
    let response: Response;
    try {
      response = await fetcher(current, { headers, redirect: "manual", signal });
    } catch {
      clearTimeout(timeout);
      if (options.signal?.aborted)
        throw new AcquisitionError("acquisition_cancelled", "npm acquisition was cancelled");
      if (timeoutController.signal.aborted)
        throw new AcquisitionError("acquisition_timed_out", "npm acquisition timed out");
      throw new AcquisitionError("network_unavailable", "registry request failed");
    }
    if (response.status >= 300 && response.status < 400) {
      try {
        if (count === MAX_REDIRECTS)
          throw new AcquisitionError("network_unavailable", "registry redirect limit exceeded");
        const location = response.headers.get("location");
        if (location === null)
          throw new AcquisitionError("network_unavailable", "registry redirect omits location");
        const next = normalizedHttpsUrl(new URL(location, current).href, "registry redirect");
        if (next.origin !== current.origin && !approved.has(next.origin))
          throw new AcquisitionError(
            "network_unavailable",
            "registry redirected to an unapproved origin",
          );
        if (next.origin !== current.origin) credentialAllowed = false;
        redirects.push(`${current.origin}${current.pathname} -> ${next.origin}${next.pathname}`);
        current = next;
      } finally {
        clearTimeout(timeout);
      }
      continue;
    }
    if (!response.ok) {
      clearTimeout(timeout);
      throw new AcquisitionError(
        "network_unavailable",
        `registry request failed with status ${response.status}`,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await boundedResponseBytes(response, maximumBytes);
    } catch (error) {
      clearTimeout(timeout);
      if (options.signal?.aborted)
        throw new AcquisitionError("acquisition_cancelled", "npm acquisition was cancelled");
      if (timeoutController.signal.aborted)
        throw new AcquisitionError("acquisition_timed_out", "npm acquisition timed out");
      throw error;
    }
    clearTimeout(timeout);
    return { bytes, redirects, finalUrl: current, credentialUsed };
  }
  throw new AcquisitionError("network_unavailable", "registry redirect limit exceeded");
}

export async function resolveNpmSource(
  locator: NpmLocator,
  dependencies: NpmAcquisitionDependencies = {},
  options: NpmResolveOptions = {},
): Promise<{
  resolved: NpmResolvedSource;
  redirects: readonly string[];
  credentialReferenceUsed?: string;
}> {
  const registryOrigin = normalizeRegistryOrigin(locator.registryOrigin);
  const packageName = validatePackageName(locator.packageName);
  if (Buffer.byteLength(locator.requested, "utf8") > 512)
    throw new AcquisitionError("source_unavailable", "npm selector exceeds byte limit");
  const metadata = await fetchFollowingRedirects(
    `${registryOrigin}/${registryPath(packageName)}`,
    registryOrigin,
    dependencies,
    options,
    MAX_METADATA_BYTES,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata.bytes));
  } catch {
    throw new AcquisitionError("npm_metadata_invalid", "registry metadata is not valid UTF-8 JSON");
  }
  const selected = selectVersion(parseRegistryDocument(parsed, packageName), locator.requested);
  const integrity = sha512Integrity(selected.dist.integrity).integrity;
  const tarballUrl = normalizedHttpsUrl(selected.dist.tarball, "npm tarball URL").href;
  return {
    resolved: { registryOrigin, packageName, version: selected.version, integrity, tarballUrl },
    redirects: metadata.redirects,
    ...(!metadata.credentialUsed || options.credentialReference === undefined
      ? {}
      : { credentialReferenceUsed: options.credentialReference }),
  };
}

export async function acquireNpmSource(
  locator: NpmLocator,
  options: NpmAcquireOptions,
  dependencies: NpmAcquisitionDependencies = {},
): Promise<NpmAcquisitionResult> {
  let lock = options.lock;
  let resolved: NpmResolvedSource;
  let redirects: readonly string[] = [];
  let credentialUsed = false;
  if (options.offline === true) {
    if (lock === undefined || !/^[0-9a-f]{64}$/.test(lock.tarballSha256))
      throw new AcquisitionError(
        "source_mutable",
        "offline npm acquisition requires an immutable lock",
      );
    if (
      lock.packageName !== locator.packageName ||
      lock.registryOrigin !== normalizeRegistryOrigin(locator.registryOrigin)
    )
      throw new AcquisitionError("source_unavailable", "offline lock does not match the locator");
    if (options.lockedTarballUrl === undefined)
      throw new AcquisitionError(
        "source_mutable",
        "offline npm acquisition requires its locked tarball URL",
      );
    resolved = { ...lock, tarballUrl: options.lockedTarballUrl };
  } else if (lock === undefined) {
    const resolution = await resolveNpmSource(locator, dependencies, options);
    resolved = resolution.resolved;
    redirects = resolution.redirects;
    credentialUsed = resolution.credentialReferenceUsed !== undefined;
  } else {
    if (
      lock.packageName !== locator.packageName ||
      lock.registryOrigin !== normalizeRegistryOrigin(locator.registryOrigin) ||
      !/^[0-9a-f]{64}$/.test(lock.tarballSha256) ||
      parseSemver(lock.version) === undefined
    )
      throw new AcquisitionError("source_unavailable", "npm lock does not match the locator");
    if (options.lockedTarballUrl === undefined)
      throw new AcquisitionError("source_unavailable", "npm lock omits its tarball URL");
    resolved = { ...lock, tarballUrl: options.lockedTarballUrl };
  }
  if (parseSemver(resolved.version) === undefined)
    throw new AcquisitionError("source_unavailable", "npm lock version is not exact");
  const lockedTarballUrl = normalizedHttpsUrl(resolved.tarballUrl, "npm tarball URL");
  const approvedOrigins = new Set(
    (options.approvedRedirectOrigins ?? []).map(normalizeRegistryOrigin),
  );
  if (
    lockedTarballUrl.origin !== resolved.registryOrigin &&
    !approvedOrigins.has(lockedTarballUrl.origin)
  ) {
    throw new AcquisitionError(
      "network_unavailable",
      "locked npm tarball uses an unapproved origin",
    );
  }
  const expectedIntegrity = sha512Integrity(resolved.integrity);
  let tarball = await dependencies.cache?.read(cacheKey(resolved.integrity));
  const fromCache = tarball !== undefined;
  let finalOrigin = lockedTarballUrl.origin;
  if (tarball === undefined) {
    if (options.offline === true)
      throw new AcquisitionError("source_unavailable", "offline npm artifact is not cached");
    const downloaded = await fetchFollowingRedirects(
      resolved.tarballUrl,
      resolved.registryOrigin,
      dependencies,
      options,
      MAX_TARBALL_BYTES,
    );
    tarball = downloaded.bytes;
    redirects = [...redirects, ...downloaded.redirects];
    finalOrigin = downloaded.finalUrl.origin;
    credentialUsed ||= downloaded.credentialUsed;
  }
  const actualIntegrity = createHash("sha512").update(tarball).digest();
  if (!timingSafeEqual(actualIntegrity, expectedIntegrity.digest)) {
    if (fromCache) await dependencies.cache?.quarantine?.(cacheKey(resolved.integrity));
    throw new AcquisitionError("integrity_mismatch", "npm artifact SHA-512 integrity mismatch");
  }
  const tarballSha256 = createHash("sha256").update(tarball).digest("hex");
  if (lock !== undefined && lock.tarballSha256 !== tarballSha256) {
    if (fromCache) await dependencies.cache?.quarantine?.(cacheKey(resolved.integrity));
    throw new AcquisitionError("integrity_mismatch", "npm artifact SHA-256 mismatch");
  }
  let snapshot: ExtractedArchive;
  try {
    snapshot = await extractBoundedTar(
      tarball,
      options.destination,
      options.archiveLimits === undefined
        ? { stripPackagePrefix: true }
        : { limits: options.archiveLimits, stripPackagePrefix: true },
    );
  } catch (error) {
    if (fromCache) await dependencies.cache?.quarantine?.(cacheKey(resolved.integrity));
    throw error;
  }
  for (const file of snapshot.files) {
    const unsupported =
      file.relativePath.startsWith("node_modules/") ||
      file.relativePath.includes("/node_modules/") ||
      isUnsupportedNativeSourcePath(file.relativePath);
    const bytes = await readFile(join(options.destination, ...file.relativePath.split("/")));
    if (unsupported || sensitiveSourceReason(file.relativePath, bytes) !== undefined) {
      if (fromCache) await dependencies.cache?.quarantine?.(cacheKey(resolved.integrity));
      await rm(options.destination, { recursive: true, force: true });
      throw new AcquisitionError(
        "npm_metadata_invalid",
        "sensitive files, bundled dependencies, and native add-ons are unsupported",
      );
    }
  }
  if (!fromCache) await dependencies.cache?.write(cacheKey(resolved.integrity), tarball);
  lock = Object.freeze({
    kind: "npm",
    registryOrigin: resolved.registryOrigin,
    packageName: resolved.packageName,
    version: resolved.version,
    integrity: resolved.integrity,
    tarballSha256,
  });
  return Object.freeze({
    lock,
    sourceUri: resolved.tarballUrl,
    snapshot,
    redirects: Object.freeze([...redirects]),
    finalOrigin,
    ...(!credentialUsed || options.credentialReference === undefined
      ? {}
      : { credentialReferenceUsed: options.credentialReference }),
    fromCache,
  });
}
