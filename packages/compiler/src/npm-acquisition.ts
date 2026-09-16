// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { createHash, timingSafeEqual } from "node:crypto";
import type { ArchiveLimits, ExtractedArchive } from "./archive.ts";
import { extractBoundedTar } from "./archive.ts";
import { AcquisitionError } from "./remote-errors.ts";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
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

export interface NpmSourceLock extends NpmResolvedSource {
  readonly kind: "npm";
  readonly tarballSha256: string;
}

export interface RegistryCredentialProvider {
  authorizationHeader(reference: string, registryOrigin: string): Promise<string>;
}

export interface ImmutableArtifactCache {
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, bytes: Uint8Array): Promise<void>;
}

export interface NpmAcquisitionDependencies {
  readonly fetch?: typeof fetch;
  readonly credentials?: RegistryCredentialProvider;
  readonly cache?: ImmutableArtifactCache;
}

export interface NpmResolveOptions {
  readonly credentialReference?: string;
  readonly approvedRedirectOrigins?: readonly string[];
}

export interface NpmAcquireOptions extends NpmResolveOptions {
  readonly destination: string;
  readonly offline?: boolean;
  readonly lock?: NpmSourceLock;
  readonly archiveLimits?: ArchiveLimits;
}

export interface NpmAcquisitionResult {
  readonly lock: NpmSourceLock;
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

export function normalizeRegistryOrigin(input = DEFAULT_REGISTRY): string {
  const url = normalizedHttpsUrl(input, "registry origin");
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new AcquisitionError("source_unavailable", "registry origin must not contain a path");
  }
  return url.origin;
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
  return left.prerelease.localeCompare(right.prerelease);
}

function satisfiesComparator(version: Semver, token: string): boolean {
  const match = /^(<=|>=|<|>|=)?\s*(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/.exec(token);
  if (match === null) return false;
  const operator = match[1] ?? "=";
  const minor = match[3];
  const patch = match[4];
  if (operator === "=" && (minor === undefined || /^(?:x|X|\*)$/.test(minor)))
    return version.major === Number(match[2]);
  if (operator === "=" && (patch === undefined || /^(?:x|X|\*)$/.test(patch))) {
    return version.major === Number(match[2]) && version.minor === Number(minor);
  }
  const target: Semver = {
    major: Number(match[2]),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: "",
  };
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

function satisfies(versionText: string, range: string): boolean {
  const version = parseSemver(versionText);
  if (version === undefined) return false;
  const request = range.trim();
  if (request === "" || request === "*" || request.toLowerCase() === "latest")
    return version.prerelease === "";
  if (request.startsWith("^")) {
    const base = parseSemver(request.slice(1));
    if (base === undefined || compareSemver(version, base) < 0) return false;
    const upper =
      base.major > 0
        ? { major: base.major + 1, minor: 0, patch: 0, prerelease: "" }
        : base.minor > 0
          ? { major: 0, minor: base.minor + 1, patch: 0, prerelease: "" }
          : { major: 0, minor: 0, patch: base.patch + 1, prerelease: "" };
    return compareSemver(version, upper) < 0;
  }
  if (request.startsWith("~")) {
    const base = parseSemver(request.slice(1));
    return (
      base !== undefined &&
      compareSemver(version, base) >= 0 &&
      compareSemver(version, {
        major: base.major,
        minor: base.minor + 1,
        patch: 0,
        prerelease: "",
      }) < 0
    );
  }
  const exact = parseSemver(request);
  if (exact !== undefined) return compareSemver(version, exact) === 0;
  const tokens = request.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => satisfiesComparator(version, token));
}

function registryPath(packageName: string): string {
  return packageName.startsWith("@") ? packageName.replace("/", "%2f") : packageName;
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
  const versions = Object.keys(document.versions).filter((version) => satisfies(version, selector));
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
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes)
    throw new AcquisitionError("network_unavailable", "response exceeds byte limit");
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
    let response: Response;
    try {
      response = await fetcher(current, { headers, redirect: "manual" });
    } catch {
      throw new AcquisitionError("network_unavailable", "registry request failed");
    }
    if (response.status >= 300 && response.status < 400) {
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
      continue;
    }
    if (!response.ok)
      throw new AcquisitionError(
        "network_unavailable",
        `registry request failed with status ${response.status}`,
      );
    return {
      bytes: await boundedResponseBytes(response, maximumBytes),
      redirects,
      finalUrl: current,
      credentialUsed,
    };
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
    resolved = lock;
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
    resolved = lock;
  }
  if (parseSemver(resolved.version) === undefined)
    throw new AcquisitionError("source_unavailable", "npm lock version is not exact");
  const lockedTarballUrl = normalizedHttpsUrl(resolved.tarballUrl, "npm tarball URL");
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
  if (!timingSafeEqual(actualIntegrity, expectedIntegrity.digest))
    throw new AcquisitionError("integrity_mismatch", "npm artifact SHA-512 integrity mismatch");
  const tarballSha256 = createHash("sha256").update(tarball).digest("hex");
  if (lock !== undefined && lock.tarballSha256 !== tarballSha256)
    throw new AcquisitionError("integrity_mismatch", "npm artifact SHA-256 mismatch");
  await dependencies.cache?.write(cacheKey(resolved.integrity), tarball);
  const snapshot = await extractBoundedTar(
    tarball,
    options.destination,
    options.archiveLimits === undefined
      ? { stripPackagePrefix: true }
      : { limits: options.archiveLimits, stripPackagePrefix: true },
  );
  lock = Object.freeze({ kind: "npm", ...resolved, tarballSha256 });
  return Object.freeze({
    lock,
    snapshot,
    redirects: Object.freeze([...redirects]),
    finalOrigin,
    ...(!credentialUsed || options.credentialReference === undefined
      ? {}
      : { credentialReferenceUsed: options.credentialReference }),
    fromCache,
  });
}
