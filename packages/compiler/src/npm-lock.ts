// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
  type NpmAcquisitionResult,
  type NpmSourceLock,
  npmVersionSatisfies,
} from "./npm-acquisition.ts";
import { AcquisitionError } from "./remote-errors.ts";
import { normalizeRegistryOrigin } from "./source-locator.ts";

export const PINNED_NPM_RESOLVER_VERSION = "10.9.8" as const;

const EXACT_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SHA512_SRI = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u;
const ALLOWED_ROOT_KEYS = new Set(["name", "version", "lockfileVersion", "requires", "packages"]);
const ALLOWED_PACKAGE_KEYS = new Set([
  "version",
  "resolved",
  "integrity",
  "dev",
  "optional",
  "devOptional",
  "peer",
  "inBundle",
  "hasInstallScript",
  "license",
  "engines",
  "cpu",
  "os",
  "bin",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "funding",
]);

export interface NpmLockValidationPolicy {
  readonly expectedRootDependencies?: Readonly<Record<string, string>>;
  readonly approvedArtifactOrigins?: readonly string[];
  readonly target?: {
    readonly nodeVersion: string;
    readonly os: string;
    readonly cpu: string;
  };
}

export interface ValidatedNpmLockPackage {
  readonly path: string;
  readonly name: string;
  readonly version: string;
  readonly resolved: string;
  readonly integrity: string;
  readonly optional: boolean;
  readonly peer: boolean;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly optionalPeers: readonly string[];
  readonly engines: Readonly<Record<string, string>>;
  readonly os: readonly string[];
  readonly cpu: readonly string[];
}

export interface ValidatedNpmLock {
  readonly lockfileVersion: 3;
  readonly packages: readonly ValidatedNpmLockPackage[];
}

export interface SandboxedNpmLockResolution {
  readonly npmVersion: typeof PINNED_NPM_RESOLVER_VERSION;
  readonly command: readonly ["install", "--package-lock-only", "--ignore-scripts"];
  readonly noSourceMount: true;
  readonly noAmbientCredentials: true;
  readonly lockfile: unknown;
}

export interface SandboxedNpmLockResolver {
  resolve(input: {
    readonly packageName: string;
    readonly version: string;
    readonly registryOrigin: string;
    readonly syntheticManifest: Readonly<Record<string, unknown>>;
  }): Promise<SandboxedNpmLockResolution>;
}

function fail(message: string): never {
  throw new AcquisitionError("npm_metadata_invalid", message);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  name: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.has(key)) fail(`${name}.${key} is unsupported`);
}

function packageNameFromPath(path: string): string {
  const parts = path.split("/");
  const marker = parts.lastIndexOf("node_modules");
  if (marker < 0 || marker === parts.length - 1) fail("package-lock path is not a package path");
  const name = parts[marker + 1]?.startsWith("@")
    ? `${parts[marker + 1]}/${parts[marker + 2] ?? ""}`
    : (parts[marker + 1] ?? "");
  if (!PACKAGE_NAME.test(name) || marker + (name.startsWith("@") ? 3 : 2) !== parts.length)
    fail("package-lock path has an invalid package name");
  return name;
}

function validateDependencyMap(value: unknown, name: string): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  const input = record(value, name);
  if (Object.keys(input).length > 10_000) fail(`${name} exceeds dependency bounds`);
  const output: Record<string, string> = {};
  for (const dependency of Object.keys(input).sort()) {
    const selector = input[dependency];
    if (!PACKAGE_NAME.test(dependency) || typeof selector !== "string" || selector.length > 512)
      fail(`${name} contains an invalid dependency`);
    if (/^(?:file:|link:|workspace:|git(?:\+|:)|https?:)/iu.test(selector))
      fail(`${name} contains an unsupported non-registry dependency`);
    output[dependency] = selector;
  }
  return Object.freeze(output);
}

function optionalPeerNames(value: unknown, name: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  const input = record(value, name);
  const names: string[] = [];
  for (const dependency of Object.keys(input).sort()) {
    const metadata = record(input[dependency], `${name}.${dependency}`);
    exactKeys(metadata, new Set(["optional"]), `${name}.${dependency}`);
    if (metadata.optional !== true) fail(`${name}.${dependency} must be optional`);
    names.push(dependency);
  }
  return Object.freeze(names);
}

function stringMap(value: unknown, name: string): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  const input = record(value, name);
  if (Object.keys(input).length > 128) fail(`${name} exceeds bounds`);
  const output: Record<string, string> = {};
  for (const key of Object.keys(input).sort()) {
    const item = input[key];
    if (
      key.length === 0 ||
      Buffer.byteLength(key, "utf8") > 128 ||
      /[\0\r\n]/u.test(key) ||
      typeof item !== "string" ||
      item.length === 0 ||
      Buffer.byteLength(item, "utf8") > 512
    )
      fail(`${name}.${key} must be a bounded string`);
    output[key] = item;
  }
  return Object.freeze(output);
}

function stringList(value: unknown, name: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values) || values.length > 128) fail(`${name} must be a bounded string array`);
  return Object.freeze(
    values.map((item) => {
      if (typeof item !== "string" || item.length === 0 || Buffer.byteLength(item, "utf8") > 128)
        fail(`${name} contains an invalid value`);
      return item;
    }),
  );
}

function platformAllowed(values: readonly string[], target: string): boolean {
  const denied = values.filter((value) => value.startsWith("!")).map((value) => value.slice(1));
  if (denied.includes(target)) return false;
  const allowed = values.filter((value) => !value.startsWith("!"));
  return allowed.length === 0 || allowed.includes(target);
}

function validatedHttps(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length > 4_096) fail(`${name} is invalid`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${name} is invalid`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    fail(`${name} must be credential-free HTTPS`);
  return url.href;
}

export function validateNpmLockfileV3(
  value: unknown,
  policy: NpmLockValidationPolicy = {},
): ValidatedNpmLock {
  const input = record(value, "package-lock");
  exactKeys(input, ALLOWED_ROOT_KEYS, "package-lock");
  if (input.lockfileVersion !== 3 || input.requires !== true)
    fail("package-lock must be a required lockfileVersion 3 graph");
  const packages = record(input.packages, "package-lock.packages");
  if (Object.keys(packages).length > 20_001) fail("package-lock package count exceeds the limit");
  const rootPackage =
    packages[""] === undefined ? {} : record(packages[""], "package-lock.packages root");
  const rootDependencies = validateDependencyMap(
    rootPackage.dependencies,
    "package-lock.packages root.dependencies",
  );
  if (policy.expectedRootDependencies !== undefined) {
    const actual = JSON.stringify(Object.entries(rootDependencies).sort());
    const expected = JSON.stringify(Object.entries(policy.expectedRootDependencies).sort());
    if (actual !== expected) fail("package-lock root dependencies do not match the request");
  }
  const approvedOrigins =
    policy.approvedArtifactOrigins === undefined
      ? undefined
      : new Set(policy.approvedArtifactOrigins.map(normalizeRegistryOrigin));
  const result: ValidatedNpmLockPackage[] = [];
  for (const path of Object.keys(packages).sort()) {
    if (path === "") continue;
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      Buffer.byteLength(path, "utf8") > 4_096 ||
      path.endsWith("/node_modules/.bin")
    )
      fail("package-lock contains an unsafe package path");
    const item = record(packages[path], `package-lock.packages.${path}`);
    exactKeys(item, ALLOWED_PACKAGE_KEYS, `package-lock.packages.${path}`);
    if (item.inBundle === true || item.hasInstallScript === true || "link" in item)
      fail("bundled, linked, and install-generated packages are unsupported");
    if (typeof item.version !== "string" || !EXACT_VERSION.test(item.version))
      fail("package-lock package version must be exact");
    if (typeof item.integrity !== "string" || !SHA512_SRI.test(item.integrity))
      fail("package-lock package requires SHA-512 integrity");
    const resolved = validatedHttps(item.resolved, `package-lock.packages.${path}.resolved`);
    if (approvedOrigins !== undefined && !approvedOrigins.has(new URL(resolved).origin))
      fail("package-lock artifact uses an unapproved registry origin");
    const engines = stringMap(item.engines, `package-lock.packages.${path}.engines`);
    const os = stringList(item.os, `package-lock.packages.${path}.os`);
    const cpu = stringList(item.cpu, `package-lock.packages.${path}.cpu`);
    if (
      (Object.keys(engines).length > 0 || os.length > 0 || cpu.length > 0) &&
      policy.target === undefined
    )
      fail("package-lock platform constraints require an explicit target");
    if (
      policy.target !== undefined &&
      ((engines.node !== undefined &&
        !npmVersionSatisfies(policy.target.nodeVersion, engines.node)) ||
        !platformAllowed(os, policy.target.os) ||
        !platformAllowed(cpu, policy.target.cpu))
    )
      fail("package-lock package is incompatible with the target platform");
    result.push(
      Object.freeze({
        path,
        name: packageNameFromPath(path),
        version: item.version,
        resolved,
        integrity: item.integrity,
        optional: item.optional === true,
        peer: item.peer === true,
        dependencies: validateDependencyMap(
          item.dependencies,
          `package-lock.packages.${path}.dependencies`,
        ),
        optionalDependencies: validateDependencyMap(
          item.optionalDependencies,
          `package-lock.packages.${path}.optionalDependencies`,
        ),
        peerDependencies: validateDependencyMap(
          item.peerDependencies,
          `package-lock.packages.${path}.peerDependencies`,
        ),
        optionalPeers: optionalPeerNames(
          item.peerDependenciesMeta,
          `package-lock.packages.${path}.peerDependenciesMeta`,
        ),
        engines,
        os,
        cpu,
      }),
    );
  }
  const dependencySets = [
    {
      path: "",
      dependencies: rootDependencies,
      optionalDependencies: Object.freeze({}) as Readonly<Record<string, string>>,
      peerDependencies: Object.freeze({}) as Readonly<Record<string, string>>,
      optionalPeers: Object.freeze([]) as readonly string[],
    },
    ...result,
  ];
  for (const item of dependencySets) {
    const edges = [
      ...Object.entries(item.dependencies).map(([name, selector]) => ({
        name,
        selector,
        required: true,
      })),
      ...Object.entries(item.optionalDependencies).map(([name, selector]) => ({
        name,
        selector,
        required: false,
      })),
      ...Object.entries(item.peerDependencies).map(([name, selector]) => ({
        name,
        selector,
        required: !item.optionalPeers.includes(name),
      })),
    ];
    for (const { name: dependency, selector, required } of edges) {
      let directory = item.path;
      let found: ValidatedNpmLockPackage | undefined;
      while (true) {
        const candidate =
          directory === ""
            ? `node_modules/${dependency}`
            : `${directory}/node_modules/${dependency}`;
        found = result.find((locked) => locked.path === candidate);
        if (found !== undefined) break;
        const marker = directory.lastIndexOf("/node_modules/");
        if (marker < 0) {
          if (directory !== "") {
            directory = "";
            continue;
          }
          break;
        }
        directory = directory.slice(0, marker);
      }
      if (found === undefined && required)
        fail(`package-lock dependency ${dependency} has no locked package`);
      if (found !== undefined && !npmVersionSatisfies(found.version, selector))
        fail(`package-lock dependency ${dependency} does not satisfy its declared selector`);
    }
  }
  return Object.freeze({ lockfileVersion: 3, packages: Object.freeze(result) });
}

export async function resolveNpmDependencyLock(
  packageName: string,
  version: string,
  registryOrigin: string,
  resolver: SandboxedNpmLockResolver,
  policy: Omit<NpmLockValidationPolicy, "expectedRootDependencies"> = {},
): Promise<ValidatedNpmLock> {
  if (!PACKAGE_NAME.test(packageName) || !EXACT_VERSION.test(version))
    fail("synthetic resolver input must use an exact package identity");
  const normalizedRegistry = normalizeRegistryOrigin(registryOrigin);
  const resolution = await resolver.resolve({
    packageName,
    version,
    registryOrigin: normalizedRegistry,
    syntheticManifest: Object.freeze({
      name: "axl-adoption-resolution",
      version: "0.0.0",
      private: true,
      dependencies: Object.freeze({ [packageName]: version }),
    }),
  });
  if (
    resolution.npmVersion !== PINNED_NPM_RESOLVER_VERSION ||
    resolution.noSourceMount !== true ||
    resolution.noAmbientCredentials !== true ||
    resolution.command.join(" ") !== "install --package-lock-only --ignore-scripts"
  )
    fail("npm resolver did not attest the pinned no-script sandbox contract");
  return validateNpmLockfileV3(resolution.lockfile, {
    ...policy,
    expectedRootDependencies: { [packageName]: version },
    approvedArtifactOrigins: policy.approvedArtifactOrigins ?? [normalizedRegistry],
  });
}

export async function materializeNpmDependencyLock(
  lock: ValidatedNpmLock,
  destination: string,
  acquire: (item: ValidatedNpmLockPackage, destination: string) => Promise<NpmAcquisitionResult>,
): Promise<readonly NpmSourceLock[]> {
  const root = resolve(destination);
  await mkdir(root, { recursive: false, mode: 0o700 });
  const acquired: NpmSourceLock[] = [];
  for (const item of lock.packages) {
    const target = resolve(root, ...item.path.split("/"));
    const fromRoot = target.slice(root.length);
    if (!(fromRoot.startsWith(sep) && !fromRoot.startsWith(`${sep}..${sep}`)))
      fail("locked dependency path escapes the materialization root");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const result = await acquire(item, target);
    if (
      result.lock.packageName !== item.name ||
      result.lock.version !== item.version ||
      result.lock.integrity !== item.integrity ||
      result.sourceUri !== item.resolved
    )
      fail("materialized dependency does not match the validated lock");
    acquired.push(result.lock);
  }
  return Object.freeze(acquired);
}
