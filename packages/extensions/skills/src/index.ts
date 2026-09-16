// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { Dirent } from "node:fs";
import { lstat, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { TerminalExtension } from "@axl/extension-api";
import { CapabilityIndex, type CapabilityService } from "@axl/kernel";
import type {
  CapabilityActivationResult,
  CapabilityRecord,
  CapabilitySearchResult,
  CapabilitySummary,
  CapabilityTrust,
} from "@axl/protocol";
import { parseDocument } from "yaml";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_FILE_BYTES = 512_000;
const MAX_FRONTMATTER_BYTES = 64 * 1024;
const SKILL_AUTHORITY = "skills.activate";

interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly allowedTools?: string;
}

export interface AgentSkill extends SkillFrontmatter {
  readonly directory: string;
  readonly path: string;
  readonly instructions: string;
}

export interface DiscoveredSkill {
  readonly record: CapabilityRecord;
  readonly directory: string;
  readonly entryPath: string;
  readonly discoveryRoot: string;
}

export interface SkillDiscoveryLocation {
  readonly directory: string;
  readonly containmentRoot: string;
  readonly scope: "global" | "project";
  readonly provenance: string;
}

export interface DiscoverSkillsOptions {
  readonly cwd: string;
  readonly globalDirectories?: readonly string[];
  readonly trust?: (location: SkillDiscoveryLocation, name: string) => CapabilityTrust;
  readonly enabled?: (location: SkillDiscoveryLocation, name: string) => boolean;
}

export interface SkillCapabilityServiceOptions {
  readonly grantedAuthorities: ReadonlySet<string>;
  readonly authorize?: (record: CapabilityRecord) => string | undefined;
}

export class SkillValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "SkillValidationError";
    this.path = path;
  }
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function projectDirectories(cwd: string): Promise<readonly string[]> {
  const canonicalCwd = await realpath(resolve(cwd));
  let root = canonicalCwd;
  for (let directory = canonicalCwd; ; directory = dirname(directory)) {
    if (await exists(join(directory, ".git"))) {
      root = directory;
      break;
    }
    if (dirname(directory) === directory) break;
  }
  const directories: string[] = [];
  for (let directory = canonicalCwd; ; directory = dirname(directory)) {
    directories.push(directory);
    if (directory === root) break;
  }
  return directories.reverse();
}

function characterLength(value: string): number {
  return [...value].length;
}

function optionalString(value: unknown, path: string, maximum?: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new SkillValidationError(path, "must be a non-empty string");
  }
  if (maximum !== undefined && characterLength(value) > maximum) {
    throw new SkillValidationError(path, `must contain at most ${maximum} characters`);
  }
  return value;
}

function decodeUtf8(value: Uint8Array, path: string): string {
  if (value.includes(0)) throw new SkillValidationError(path, "must be text, not binary data");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (cause) {
    throw new SkillValidationError(path, `must be valid UTF-8: ${String(cause)}`);
  }
}

function parseMetadata(value: unknown, path: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SkillValidationError(path, "must be a mapping of string keys to string values");
  }
  const metadata: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new SkillValidationError(`${path}.${key}`, "must be a string");
    }
    metadata[key] = item;
  }
  return metadata;
}

function parseFrontmatter(source: string, skillPath: string): SkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) throw new SkillValidationError(skillPath, "must contain YAML frontmatter");
  const document = parseDocument(match[1] as string, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new SkillValidationError(
      skillPath,
      document.errors.map((error) => error.message).join("; "),
    );
  }
  const frontmatter = document.toJS({ maxAliasCount: 100 }) as unknown;
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
    throw new SkillValidationError(skillPath, "frontmatter must be a mapping");
  }
  const fields = frontmatter as Record<string, unknown>;
  const name = optionalString(fields.name, `${skillPath}:name`, 64);
  const description = optionalString(fields.description, `${skillPath}:description`, 1024);
  if (!name) throw new SkillValidationError(`${skillPath}:name`, "is required");
  if (!description) throw new SkillValidationError(`${skillPath}:description`, "is required");
  if (!SKILL_NAME.test(name)) {
    throw new SkillValidationError(
      `${skillPath}:name`,
      "must contain lowercase letters, digits, and single hyphens only",
    );
  }
  const license = optionalString(fields.license, `${skillPath}:license`);
  const compatibility = optionalString(fields.compatibility, `${skillPath}:compatibility`, 500);
  const allowedTools = optionalString(fields["allowed-tools"], `${skillPath}:allowed-tools`);
  return {
    name,
    description,
    ...(license === undefined ? {} : { license }),
    ...(compatibility === undefined ? {} : { compatibility }),
    metadata: parseMetadata(fields.metadata, `${skillPath}:metadata`),
    ...(allowedTools === undefined ? {} : { allowedTools }),
  };
}

async function readFrontmatter(handle: FileHandle, path: string): Promise<SkillFrontmatter> {
  const buffer = Buffer.alloc(MAX_FRONTMATTER_BYTES);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  return parseFrontmatter(decodeUtf8(buffer.subarray(0, bytesRead), path), path);
}

async function validateOptionalDirectories(directory: string): Promise<void> {
  for (const name of ["scripts", "references", "assets"]) {
    const requested = join(directory, name);
    if (!(await exists(requested))) continue;
    const canonical = await realpath(requested);
    if (!within(directory, canonical)) {
      throw new SkillValidationError(requested, "escapes the skill directory");
    }
    if (!(await stat(canonical)).isDirectory()) {
      throw new SkillValidationError(requested, "must be a directory");
    }
  }
}

async function skillMetadata(
  entryPath: string,
  discoveryRoot: string,
  location: SkillDiscoveryLocation,
  options: DiscoverSkillsOptions,
): Promise<DiscoveredSkill> {
  const directory = await realpath(entryPath).catch((cause: unknown) => {
    throw new SkillValidationError(entryPath, `cannot resolve skill: ${String(cause)}`);
  });
  if (!within(discoveryRoot, directory)) {
    throw new SkillValidationError(directory, "skill directory escapes its discovery root");
  }
  const requestedSkillPath = join(directory, "SKILL.md");
  const skillPath = await realpath(requestedSkillPath).catch((cause: unknown) => {
    throw new SkillValidationError(requestedSkillPath, `cannot resolve SKILL.md: ${String(cause)}`);
  });
  if (!within(directory, skillPath)) {
    throw new SkillValidationError(requestedSkillPath, "escapes the skill directory");
  }
  const handle = await open(skillPath, "r").catch((cause: unknown) => {
    throw new SkillValidationError(skillPath, `cannot read SKILL.md: ${String(cause)}`);
  });
  let frontmatter: SkillFrontmatter;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new SkillValidationError(skillPath, "is not a regular file");
    if (metadata.size > MAX_SKILL_FILE_BYTES) {
      throw new SkillValidationError(skillPath, `exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
    }
    frontmatter = await readFrontmatter(handle, skillPath);
  } finally {
    await handle.close();
  }
  if (frontmatter.name !== basename(directory)) {
    throw new SkillValidationError(`${skillPath}:name`, "must match the parent directory name");
  }
  await validateOptionalDirectories(directory);
  const identity = `skill:${frontmatter.name}`;
  return {
    record: {
      identity,
      kind: "skill",
      name: frontmatter.name,
      description: frontmatter.description,
      aliases: [],
      path: skillPath,
      scope: location.scope,
      provenance: location.provenance,
      enabled: options.enabled?.(location, frontmatter.name) ?? true,
      trust: options.trust?.(location, frontmatter.name) ?? "trusted",
      available: true,
      requiredAuthority: [SKILL_AUTHORITY],
    },
    directory,
    entryPath,
    discoveryRoot,
  };
}

async function skillsIn(
  location: SkillDiscoveryLocation,
  options: DiscoverSkillsOptions,
): Promise<readonly DiscoveredSkill[]> {
  let entries: Dirent[];
  let root: string;
  try {
    root = await realpath(location.directory);
    const containmentRoot = await realpath(location.containmentRoot);
    if (!within(containmentRoot, root)) {
      throw new SkillValidationError(
        location.directory,
        "skills directory escapes its trusted root",
      );
    }
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const skills: DiscoveredSkill[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    skills.push(await skillMetadata(join(root, entry.name), root, location, options));
  }
  return skills;
}

/** Discovers global, then broad-to-nearest project Skills with later identities winning. */
export async function discoverSkills(
  options: DiscoverSkillsOptions,
): Promise<readonly DiscoveredSkill[]> {
  const directories = await projectDirectories(options.cwd);
  const locations: SkillDiscoveryLocation[] = [
    ...(options.globalDirectories ?? []).map((directory) => ({
      directory,
      containmentRoot: dirname(directory),
      scope: "global" as const,
      provenance: `global:${directory}`,
    })),
    ...directories.flatMap((directory) => [
      {
        directory: join(directory, ".axl", "skills"),
        containmentRoot: directory,
        scope: "project" as const,
        provenance: `project:${join(directory, ".axl", "skills")}`,
      },
      {
        directory: join(directory, ".agents", "skills"),
        containmentRoot: directory,
        scope: "project" as const,
        provenance: `project:${join(directory, ".agents", "skills")}`,
      },
    ]),
  ];
  const discovered = new Map<string, DiscoveredSkill>();
  for (const location of locations) {
    for (const skill of await skillsIn(location, options)) {
      discovered.set(skill.record.identity, skill);
    }
  }
  return [...discovered.values()].sort((left, right) =>
    left.record.identity.localeCompare(right.record.identity),
  );
}

export async function loadSkill(directory: string): Promise<AgentSkill> {
  const canonicalDirectory = await realpath(directory).catch((cause: unknown) => {
    throw new SkillValidationError(directory, `cannot resolve skill directory: ${String(cause)}`);
  });
  const requestedSkillPath = join(canonicalDirectory, "SKILL.md");
  const skillPath = await realpath(requestedSkillPath).catch((cause: unknown) => {
    throw new SkillValidationError(requestedSkillPath, `cannot resolve SKILL.md: ${String(cause)}`);
  });
  if (!within(canonicalDirectory, skillPath)) {
    throw new SkillValidationError(requestedSkillPath, "escapes the skill directory");
  }
  const metadata = await stat(skillPath).catch((cause: unknown) => {
    throw new SkillValidationError(skillPath, `cannot stat SKILL.md: ${String(cause)}`);
  });
  if (!metadata.isFile()) throw new SkillValidationError(skillPath, "is not a regular file");
  if (metadata.size > MAX_SKILL_FILE_BYTES) {
    throw new SkillValidationError(skillPath, `exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
  }
  const source = decodeUtf8(await readFile(skillPath), skillPath);
  const frontmatter = parseFrontmatter(source, skillPath);
  if (frontmatter.name !== basename(canonicalDirectory)) {
    throw new SkillValidationError(`${skillPath}:name`, "must match the parent directory name");
  }
  await validateOptionalDirectories(canonicalDirectory);
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match) throw new SkillValidationError(skillPath, "must contain YAML frontmatter");
  return {
    ...frontmatter,
    directory: canonicalDirectory,
    path: skillPath,
    instructions: match[1] as string,
  };
}

function summary(record: CapabilityRecord): CapabilitySummary {
  const { identity, kind, name, description, path, scope, provenance } = record;
  return { identity, kind, name, description, path, scope, provenance };
}

function eligibilityReason(
  record: CapabilityRecord,
  grantedAuthorities: ReadonlySet<string>,
): string | undefined {
  if (!record.enabled) return "capability is disabled";
  if (!record.available) return "capability is unavailable";
  if (record.trust !== "trusted") return "capability is not trusted";
  const missing = record.requiredAuthority.find((authority) => !grantedAuthorities.has(authority));
  return missing === undefined ? undefined : `missing authority ${missing}`;
}

function xmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export class SkillCapabilityService implements CapabilityService {
  readonly records: readonly CapabilityRecord[];
  private readonly skills: ReadonlyMap<string, DiscoveredSkill>;
  private readonly index: CapabilityIndex;
  private readonly options: SkillCapabilityServiceOptions;

  constructor(skills: readonly DiscoveredSkill[], options: SkillCapabilityServiceOptions) {
    this.skills = new Map(skills.map((skill) => [skill.record.identity, skill]));
    this.options = options;
    this.records = skills.map((skill) =>
      options.authorize?.(skill.record) === undefined
        ? skill.record
        : { ...skill.record, available: false },
    );
    this.index = new CapabilityIndex(this.records, options.grantedAuthorities);
  }

  async search(query: string, limit: number): Promise<CapabilitySearchResult> {
    return { results: this.index.search(query, limit) };
  }

  async activate(identities: readonly string[]): Promise<CapabilityActivationResult> {
    const activated: CapabilityActivationResult["activated"][number][] = [];
    const denied: CapabilityActivationResult["denied"][number][] = [];
    for (const identity of identities) {
      const discovered = this.skills.get(identity);
      if (discovered === undefined) {
        denied.push({ identity, reason: "capability is not indexed" });
        continue;
      }
      const reason =
        eligibilityReason(discovered.record, this.options.grantedAuthorities) ??
        this.options.authorize?.(discovered.record);
      if (reason !== undefined) {
        denied.push({ identity, reason });
        continue;
      }
      try {
        const currentDirectory = await realpath(discovered.entryPath);
        if (
          currentDirectory !== discovered.directory ||
          !within(discovered.discoveryRoot, currentDirectory)
        ) {
          throw new SkillValidationError(
            discovered.entryPath,
            "no longer identifies the indexed skill",
          );
        }
        const skill = await loadSkill(currentDirectory);
        if (`skill:${skill.name}` !== identity || skill.path !== discovered.record.path) {
          throw new SkillValidationError(skill.path, "no longer matches the indexed identity");
        }
        const attributes = [
          `name="${xmlAttribute(skill.name)}"`,
          `path="${xmlAttribute(skill.path)}"`,
          ...(skill.allowedTools === undefined
            ? []
            : [`allowed-tools="${xmlAttribute(skill.allowedTools)}"`]),
        ].join(" ");
        activated.push({
          capability: summary(discovered.record),
          content: `<skill ${attributes}>\n${skill.instructions}\n\nRead relative Skill resources with capability_search action="read", identity="${xmlAttribute(identity)}", and the relative path. Do not use read or bash on the Skill source path.\n</skill>`,
        });
      } catch (error) {
        denied.push({
          identity,
          reason: error instanceof Error ? error.message : "capability activation failed",
        });
      }
    }
    return { activated, denied };
  }

  async read(identity: string, requestedPath: string): Promise<string> {
    const discovered = this.skills.get(identity);
    if (discovered === undefined)
      throw new SkillValidationError(identity, "capability is not indexed");
    const reason =
      eligibilityReason(discovered.record, this.options.grantedAuthorities) ??
      this.options.authorize?.(discovered.record);
    if (reason !== undefined) throw new SkillValidationError(identity, reason);
    if (isAbsolute(requestedPath)) {
      throw new SkillValidationError(requestedPath, "must be relative to the Skill directory");
    }
    const currentDirectory = await realpath(discovered.entryPath);
    if (
      currentDirectory !== discovered.directory ||
      !within(discovered.discoveryRoot, currentDirectory)
    ) {
      throw new SkillValidationError(
        discovered.entryPath,
        "no longer identifies the indexed skill",
      );
    }
    const path = await realpath(join(currentDirectory, requestedPath)).catch((cause: unknown) => {
      throw new SkillValidationError(requestedPath, `cannot resolve resource: ${String(cause)}`);
    });
    if (!within(currentDirectory, path)) {
      throw new SkillValidationError(requestedPath, "escapes the Skill directory");
    }
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new SkillValidationError(requestedPath, "is not a regular file");
    if (metadata.size > MAX_SKILL_FILE_BYTES) {
      throw new SkillValidationError(requestedPath, `exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
    }
    return decodeUtf8(await readFile(path), requestedPath);
  }
}

export const skillTerminalExtension: TerminalExtension = {
  manifest: {
    id: "axl.skills",
    name: "Agent Skills",
    capabilities: ["terminal.tool-renderers"],
  },
  activate(api) {
    api.registerToolRenderer("capability_search", ({ arguments: input }) => {
      const action = typeof input.action === "string" ? input.action : "search";
      const target =
        action === "activate" && Array.isArray(input.identities)
          ? input.identities
              .filter((value): value is string => typeof value === "string")
              .join(", ")
          : action === "read"
            ? [input.identity, input.path]
                .filter((value): value is string => typeof value === "string")
                .join(" · ")
            : typeof input.query === "string"
              ? input.query
              : undefined;
      return {
        label: "CAPABILITY",
        target: [action, target].filter(Boolean).join(" · "),
        hideWhenSuccessfulInFocus: true,
      };
    });
  },
};
