// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  type ExtensionInstallSource,
  type ExtensionListResult,
  type ExtensionRecord,
  parseExtensionId,
} from "@axl/protocol";

import {
  DaemonExtensionError,
  type DiscoveredDaemonExtension,
  discoverDaemonExtensions,
} from "./index.ts";

const execute = promisify(execFile);
const CONFIG_VERSION = 1;
const API_VERSION = 1;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MODULE_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".mts"]);
const NPM_PACKAGE =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@[^\s]+)?$/i;
const GIT_COMMIT = /^[a-f0-9]{40}$/i;

type ExtensionSourceKind = ExtensionRecord["source"];

interface StoredPackage {
  readonly id: string;
  readonly name: string;
  readonly spec: string;
  readonly source: "npm" | "git";
}

interface ExtensionConfiguration {
  readonly version: 1;
  readonly disabled: readonly string[];
  readonly paths: readonly string[];
  readonly trustedProjects: readonly string[];
  readonly packages: readonly StoredPackage[];
}

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly axl?: unknown;
}

interface AxlManifest {
  readonly id: string;
  readonly apiVersion: 1;
  readonly daemon: string;
  readonly tui?: string;
  readonly web?: string;
}

interface RegistryEntry extends DiscoveredDaemonExtension {
  readonly source: ExtensionSourceKind;
  readonly version?: string;
  readonly packageName?: string;
  readonly missing?: boolean;
}

type CommandRunner = (
  file: string,
  arguments_: readonly string[],
  options: { readonly maxBuffer: number; readonly timeout: number; readonly signal?: AbortSignal },
) => Promise<unknown>;

const emptyConfiguration = (): ExtensionConfiguration => ({
  version: CONFIG_VERSION,
  disabled: [],
  paths: [],
  trustedProjects: [],
  packages: [],
});

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DaemonExtensionError(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new DaemonExtensionError(path, `unknown field ${key}`);
  }
}

function strings(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DaemonExtensionError(path, "must be an array of strings");
  }
  return [...new Set(value as string[])];
}

function within(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return (
    suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))
  );
}

function parseConfiguration(value: unknown, path: string): ExtensionConfiguration {
  const input = object(value, path);
  exact(input, path, ["version", "disabled", "paths", "trustedProjects", "packages"]);
  if (input.version !== CONFIG_VERSION) {
    throw new DaemonExtensionError(path, `version must be ${CONFIG_VERSION}`);
  }
  const packages = input.packages;
  if (!Array.isArray(packages)) throw new DaemonExtensionError(path, "packages must be an array");
  const parsedPackages = packages.map((value, index): StoredPackage => {
    const itemPath = `${path}.packages[${index}]`;
    const item = object(value, itemPath);
    exact(item, itemPath, ["id", "name", "spec", "source"]);
    const id = parseExtensionId(item.id, `${itemPath}.id`);
    if (typeof item.name !== "string" || item.name.length === 0) {
      throw new DaemonExtensionError(itemPath, "name must be a non-empty string");
    }
    if (typeof item.spec !== "string" || item.spec.length === 0) {
      throw new DaemonExtensionError(itemPath, "spec must be a non-empty string");
    }
    if (item.source !== "npm" && item.source !== "git") {
      throw new DaemonExtensionError(itemPath, "source must be npm or git");
    }
    return { id, name: item.name, spec: item.spec, source: item.source };
  });
  return {
    version: CONFIG_VERSION,
    disabled: strings(input.disabled, `${path}.disabled`).map((id, index) =>
      parseExtensionId(id, `${path}.disabled[${index}]`),
    ),
    paths: strings(input.paths, `${path}.paths`),
    trustedProjects: strings(input.trustedProjects, `${path}.trustedProjects`),
    packages: parsedPackages,
  };
}

async function readJson(path: string): Promise<unknown> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new DaemonExtensionError(path, "must be a regular file, not a symlink");
  }
  if (metadata.size > MAX_CONFIG_BYTES) {
    throw new DaemonExtensionError(path, `must not exceed ${MAX_CONFIG_BYTES} bytes`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (cause) {
    if (cause instanceof DaemonExtensionError) throw cause;
    throw new DaemonExtensionError(path, `invalid JSON: ${String(cause)}`, { cause });
  }
}

async function readConfiguration(path: string): Promise<ExtensionConfiguration> {
  try {
    return parseConfiguration(await readJson(path), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyConfiguration();
    throw error;
  }
}

async function projectRoot(cwd: string): Promise<string> {
  let current = await realpath(cwd);
  while (true) {
    try {
      const marker = await stat(join(current, ".git"));
      if (marker.isDirectory() || marker.isFile()) return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return await realpath(cwd);
    current = parent;
  }
}

function parseManifest(
  value: unknown,
  path: string,
): { manifest: AxlManifest; packageName: string; version?: string } {
  const packageJson = object(value, path) as PackageManifest;
  if (typeof packageJson.name !== "string" || packageJson.name.length === 0) {
    throw new DaemonExtensionError(path, "package name is required");
  }
  const axl = object(packageJson.axl, `${path}.axl`);
  exact(axl, `${path}.axl`, ["id", "apiVersion", "daemon", "tui", "web"]);
  const id = parseExtensionId(axl.id, `${path}.axl.id`);
  if (axl.apiVersion !== API_VERSION) {
    throw new DaemonExtensionError(path, `axl.apiVersion must be ${API_VERSION}`);
  }
  if (typeof axl.daemon !== "string" || axl.daemon.length === 0) {
    throw new DaemonExtensionError(path, "axl.daemon must be a non-empty relative path");
  }
  if (isAbsolute(axl.daemon)) throw new DaemonExtensionError(path, "axl.daemon must be relative");
  for (const key of ["tui", "web"] as const) {
    if (axl[key] !== undefined && (typeof axl[key] !== "string" || isAbsolute(axl[key]))) {
      throw new DaemonExtensionError(path, `axl.${key} must be a relative path`);
    }
  }
  return {
    manifest: {
      id,
      apiVersion: API_VERSION,
      daemon: axl.daemon,
      ...(typeof axl.tui === "string" ? { tui: axl.tui } : {}),
      ...(typeof axl.web === "string" ? { web: axl.web } : {}),
    },
    packageName: packageJson.name,
    ...(typeof packageJson.version === "string" ? { version: packageJson.version } : {}),
  };
}

async function packageEntry(packageDirectory: string): Promise<RegistryEntry> {
  const root = await realpath(packageDirectory);
  const manifestPath = join(root, "package.json");
  const parsed = parseManifest(await readJson(manifestPath), manifestPath);
  const path = await realpath(resolve(root, parsed.manifest.daemon));
  if (
    !within(root, path) ||
    !(await stat(path)).isFile() ||
    !MODULE_EXTENSIONS.has(extname(path))
  ) {
    throw new DaemonExtensionError(
      path,
      "daemon entry must be a JavaScript or TypeScript file inside the package",
    );
  }
  return {
    id: parsed.manifest.id,
    path,
    source: "package",
    packageName: parsed.packageName,
    ...(parsed.version === undefined ? {} : { version: parsed.version }),
  };
}

async function pathEntry(path: string, source: "explicit" | "project"): Promise<RegistryEntry> {
  const canonical = await realpath(path);
  const metadata = await stat(canonical);
  if (metadata.isDirectory()) {
    try {
      const packaged = await packageEntry(canonical);
      return { ...packaged, source };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const name of ["index.ts", "index.mts", "index.js", "index.mjs"]) {
      const entry = join(canonical, name);
      try {
        if ((await stat(entry)).isFile()) {
          return { id: parseExtensionId(basename(canonical), "extension.id"), path: entry, source };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new DaemonExtensionError(canonical, "extension directory has no supported entry point");
  }
  if (!metadata.isFile() || !MODULE_EXTENSIONS.has(extname(canonical))) {
    throw new DaemonExtensionError(
      canonical,
      "extension path must be a JavaScript or TypeScript file",
    );
  }
  return {
    id: parseExtensionId(basename(canonical, extname(canonical)), "extension.id"),
    path: canonical,
    source,
  };
}

function npmPackageName(spec: string): string {
  if (!NPM_PACKAGE.test(spec) || spec.startsWith("-")) {
    throw new Error("npm extension spec must be a package name with an optional version");
  }
  if (spec.startsWith("@"))
    return spec.slice(0, spec.indexOf("@", 1) === -1 ? undefined : spec.indexOf("@", 1));
  const version = spec.indexOf("@");
  return version === -1 ? spec : spec.slice(0, version);
}

function gitSpec(url: string, ref: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Git extension URL must be valid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error("Git extension URL must be credential-free HTTPS");
  }
  if (!GIT_COMMIT.test(ref)) throw new Error("Git extension ref must be a full commit hash");
  return `git+${parsed.href}#${ref}`;
}

/** Owns daemon extension discovery, trust, enablement, and package installation. */
export class DaemonExtensionRegistry {
  readonly configPath: string;
  readonly globalDirectory: string;
  readonly packageDirectory: string;
  private pending = Promise.resolve();
  private readonly run: CommandRunner;
  private readonly failures = new Map<string, string>();

  constructor(axlHome: string, run: CommandRunner = execute) {
    this.run = run;
    this.configPath = join(axlHome, "extensions.json");
    this.globalDirectory = join(axlHome, "extensions");
    this.packageDirectory = join(this.globalDirectory, ".packages");
  }

  private async selectedEntries(
    cwd: string,
    config: ExtensionConfiguration,
  ): Promise<{ readonly root: string; readonly entries: readonly RegistryEntry[] }> {
    const groups: RegistryEntry[][] = [
      (await discoverDaemonExtensions(this.globalDirectory)).map((entry) => ({
        ...entry,
        source: "global" as const,
      })),
      await Promise.all(
        config.packages.map(async (item): Promise<RegistryEntry> => {
          const path = join(this.packageDirectory, "node_modules", item.name);
          try {
            const entry = await packageEntry(path);
            if (entry.id !== item.id) {
              throw new DaemonExtensionError(
                entry.path,
                `manifest id changed from ${item.id} to ${entry.id}`,
              );
            }
            return entry;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            this.failures.set(item.id, `Configured package ${item.name} is missing`);
            return { id: item.id, path, source: "package", packageName: item.name, missing: true };
          }
        }),
      ),
      await Promise.all(
        config.paths.map(async (path): Promise<RegistryEntry> => {
          try {
            return await pathEntry(path, "explicit");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const id = parseExtensionId(basename(path, extname(path)), "extension.id");
            this.failures.set(id, `Configured extension path ${path} is missing`);
            return { id, path, source: "explicit", missing: true };
          }
        }),
      ),
    ];
    const root = await projectRoot(cwd);
    if (config.trustedProjects.includes(root)) {
      groups.push(
        (await discoverDaemonExtensions(join(root, ".axl", "extensions"))).map((entry) => ({
          ...entry,
          source: "project" as const,
        })),
      );
    }
    const selected = new Map<string, RegistryEntry>();
    for (const group of groups) {
      for (const entry of group) {
        if (!entry.missing) selected.set(entry.id, entry);
      }
    }
    return {
      root,
      entries: [...selected.values()].sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  async entries(cwd: string): Promise<readonly RegistryEntry[]> {
    const config = await readConfiguration(this.configPath);
    const selected = await this.selectedEntries(cwd, config);
    return selected.entries.filter(
      (entry) => !entry.missing && !config.disabled.includes(entry.id),
    );
  }

  async list(cwd: string): Promise<ExtensionListResult> {
    const config = await readConfiguration(this.configPath);
    const selected = await this.selectedEntries(cwd, config);
    return {
      configPath: this.configPath,
      project: { root: selected.root, trusted: config.trustedProjects.includes(selected.root) },
      extensions: selected.entries.map((entry) => {
        const error = this.failures.get(entry.id);
        return {
          id: entry.id,
          path: entry.path,
          source: entry.source,
          enabled: !entry.missing && !config.disabled.includes(entry.id),
          ...(entry.version === undefined ? {} : { version: entry.version }),
          ...(entry.packageName === undefined ? {} : { packageName: entry.packageName }),
          ...(error === undefined ? {} : { error }),
        };
      }),
      commands: [],
    };
  }

  recordFailure(id: string, error: Error): void {
    this.failures.set(id, error.message.slice(0, 2_000));
  }

  clearFailure(id: string): void {
    this.failures.delete(id);
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.mutate((config) => ({
      ...config,
      disabled: enabled
        ? config.disabled.filter((value) => value !== id)
        : [...new Set([...config.disabled, id])].sort(),
    }));
  }

  trustProject(path: string, trusted: boolean): Promise<void> {
    return this.mutate(async (config) => {
      const canonical = await realpath(path);
      if (!(await stat(canonical)).isDirectory())
        throw new Error("Project path must be a directory");
      return {
        ...config,
        trustedProjects: trusted
          ? [...new Set([...config.trustedProjects, canonical])].sort()
          : config.trustedProjects.filter((value) => value !== canonical),
      };
    });
  }

  async install(source: ExtensionInstallSource, signal?: AbortSignal): Promise<string> {
    if (source.type === "path") {
      const entry = await pathEntry(source.path, "explicit");
      await this.mutate((config) => ({
        ...config,
        paths: [...new Set([...config.paths, entry.path])].sort(),
      }));
      return entry.id;
    }
    const spec = source.type === "npm" ? source.spec : gitSpec(source.url, source.ref);
    const expectedName = source.type === "npm" ? npmPackageName(source.spec) : undefined;
    return this.serial(async () => {
      await mkdir(this.packageDirectory, { recursive: true, mode: 0o700 });
      const before = await this.packageDependencies();
      await this.run("npm", ["install", "--save-exact", "--prefix", this.packageDirectory, spec], {
        maxBuffer: MAX_CONFIG_BYTES,
        timeout: 120_000,
        ...(signal === undefined ? {} : { signal }),
      });
      const after = await this.packageDependencies();
      const packageName =
        expectedName ?? Object.keys(after).find((name) => before[name] !== after[name]);
      if (packageName === undefined)
        throw new Error("Installed Git package could not be identified");
      const entry = await packageEntry(join(this.packageDirectory, "node_modules", packageName));
      const config = await readConfiguration(this.configPath);
      await this.write({
        ...config,
        packages: [
          ...config.packages.filter((item) => item.id !== entry.id && item.name !== packageName),
          { id: entry.id, name: packageName, spec, source: source.type },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      });
      return entry.id;
    });
  }

  async update(id: string, signal?: AbortSignal): Promise<void> {
    parseExtensionId(id, "extensionId");
    await this.serial(async () => {
      const config = await readConfiguration(this.configPath);
      const installed = config.packages.find((item) => item.id === id);
      if (installed === undefined) throw new Error(`Extension ${id} is not an installed package`);
      await this.run(
        "npm",
        ["install", "--save-exact", "--prefix", this.packageDirectory, installed.spec],
        {
          maxBuffer: MAX_CONFIG_BYTES,
          timeout: 120_000,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      const entry = await packageEntry(join(this.packageDirectory, "node_modules", installed.name));
      if (entry.id !== id) throw new Error(`Updated package changed extension id to ${entry.id}`);
    });
  }

  async remove(id: string, signal?: AbortSignal): Promise<void> {
    parseExtensionId(id, "extensionId");
    await this.serial(async () => {
      const config = await readConfiguration(this.configPath);
      const installed = config.packages.find((item) => item.id === id);
      if (installed !== undefined) {
        await this.run("npm", ["uninstall", "--prefix", this.packageDirectory, installed.name], {
          maxBuffer: MAX_CONFIG_BYTES,
          timeout: 120_000,
          ...(signal === undefined ? {} : { signal }),
        });
      }
      await this.write({
        ...config,
        disabled: config.disabled.filter((value) => value !== id),
        paths: await this.pathsWithoutId(config.paths, id),
        packages: config.packages.filter((item) => item.id !== id),
      });
    });
  }

  private async pathsWithoutId(paths: readonly string[], id: string): Promise<readonly string[]> {
    const kept: string[] = [];
    for (const path of paths) {
      try {
        if ((await pathEntry(path, "explicit")).id !== id) kept.push(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return kept;
  }

  private async packageDependencies(): Promise<Record<string, string>> {
    try {
      const packageJson = object(
        await readJson(join(this.packageDirectory, "package.json")),
        this.packageDirectory,
      );
      return object(
        packageJson.dependencies ?? {},
        `${this.packageDirectory}.dependencies`,
      ) as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private mutate(
    update: (
      config: ExtensionConfiguration,
    ) => ExtensionConfiguration | Promise<ExtensionConfiguration>,
  ): Promise<void> {
    return this.serial(async () =>
      this.write(await update(await readConfiguration(this.configPath))),
    );
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async write(config: ExtensionConfiguration): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.configPath}.${process.pid}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify(config, null, 2)}\n`;
    if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) {
      throw new DaemonExtensionError(this.configPath, `must not exceed ${MAX_CONFIG_BYTES} bytes`);
    }
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.configPath);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}
