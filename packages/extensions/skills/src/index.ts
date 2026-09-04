// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { Dirent } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { TerminalExtension } from "@axl/extension-api";
import type { KernelTool, PromptSection, ToolExecutionResult } from "@axl/kernel";
import type { JsonObject } from "@axl/protocol";
import { parseDocument } from "yaml";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_FILE_BYTES = 512_000;

export interface AgentSkill {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly allowedTools?: string;
  readonly directory: string;
  readonly instructions: string;
}

export interface DiscoverSkillsOptions {
  readonly cwd: string;
  readonly globalDirectory?: string;
}

export class SkillValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "SkillValidationError";
    this.path = path;
  }
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

export async function loadSkill(directory: string): Promise<AgentSkill> {
  const canonicalDirectory = await realpath(directory).catch((cause: unknown) => {
    throw new SkillValidationError(directory, `cannot resolve skill directory: ${String(cause)}`);
  });
  const skillPath = join(canonicalDirectory, "SKILL.md");
  const source = decodeUtf8(
    await readFile(skillPath).catch((cause: unknown) => {
      throw new SkillValidationError(skillPath, `cannot read SKILL.md: ${String(cause)}`);
    }),
    skillPath,
  );
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
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
  if (name !== basename(canonicalDirectory)) {
    throw new SkillValidationError(`${skillPath}:name`, "must match the parent directory name");
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
    directory: canonicalDirectory,
    instructions: match[2] as string,
  };
}

async function skillsIn(directory: string): Promise<AgentSkill[]> {
  let entries: Dirent[];
  let root: string;
  try {
    root = await realpath(directory);
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const skills: AgentSkill[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidatePath = join(root, entry.name);
    const candidate = await realpath(candidatePath).catch((cause: unknown) => {
      throw new SkillValidationError(candidatePath, `cannot resolve skill: ${String(cause)}`);
    });
    const fromRoot = relative(root, candidate);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new SkillValidationError(candidate, "skill directory escapes its discovery root");
    }
    skills.push(await loadSkill(candidate));
  }
  return skills;
}

/** Discovers global skills first, with project skills overriding by exact name. */
export async function discoverSkills(
  options: DiscoverSkillsOptions,
): Promise<readonly AgentSkill[]> {
  const discovered = new Map<string, AgentSkill>();
  for (const directory of [
    ...(options.globalDirectory === undefined ? [] : [options.globalDirectory]),
    join(resolve(options.cwd), ".axl", "skills"),
  ]) {
    for (const skill of await skillsIn(directory)) discovered.set(skill.name, skill);
  }
  return [...discovered.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function skillCatalogSection(skills: readonly AgentSkill[]): PromptSection | undefined {
  if (skills.length === 0) return undefined;
  return {
    name: "skills",
    source: "agent-skills",
    content: [
      "Available skills. Load one with the skill tool when its description matches the task:",
      ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
    ].join("\n"),
  };
}

async function readSkillFile(skill: AgentSkill, requestedPath: string): Promise<string> {
  if (!requestedPath || isAbsolute(requestedPath)) {
    throw new SkillValidationError(requestedPath || "path", "must be a relative skill path");
  }
  const candidate = await realpath(join(skill.directory, requestedPath)).catch((cause: unknown) => {
    throw new SkillValidationError(requestedPath, `cannot resolve resource: ${String(cause)}`);
  });
  const fromRoot = relative(skill.directory, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new SkillValidationError(requestedPath, "escapes the skill directory");
  }
  const file = await stat(candidate);
  if (!file.isFile()) throw new SkillValidationError(requestedPath, "is not a regular file");
  if (file.size > MAX_SKILL_FILE_BYTES) {
    throw new SkillValidationError(requestedPath, `exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
  }
  const content = await readFile(candidate);
  if (content.subarray(0, 8_192).includes(0)) {
    throw new SkillValidationError(requestedPath, "is binary and cannot be loaded as instructions");
  }
  return decodeUtf8(content, requestedPath);
}

function stringField(input: JsonObject, name: string): string | undefined {
  const value = input[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const skillTerminalExtension: TerminalExtension = {
  manifest: {
    id: "axl.skills",
    name: "Agent Skills",
    capabilities: ["terminal.tool-renderers"],
  },
  activate(api) {
    api.registerToolRenderer("skill", ({ arguments: input }) => {
      const action = typeof input.action === "string" ? input.action : "load";
      const name = typeof input.name === "string" ? input.name : undefined;
      const path = typeof input.path === "string" ? input.path : undefined;
      const target = [action, name ?? path].filter(Boolean).join(" · ");
      return {
        label: "SKILL",
        target,
        hideWhenSuccessfulInFocus: true,
      };
    });
  },
};

export function makeSkillTool(skills: readonly AgentSkill[]): KernelTool {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return {
    name: "skill",
    description:
      "List available Agent Skills, load a skill's full instructions, or read a referenced text resource within that skill.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "load", "read"] },
        name: { type: "string" },
        path: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(input: JsonObject): Promise<ToolExecutionResult> {
      for (const key of Object.keys(input)) {
        if (!["action", "name", "path"].includes(key)) {
          throw new SkillValidationError(`skill.${key}`, "is not allowed");
        }
      }
      const action = stringField(input, "action");
      if (action === "list") {
        return {
          content: [
            {
              type: "text",
              text: skills.map((skill) => `${skill.name}: ${skill.description}`).join("\n"),
            },
          ],
          isError: false,
        };
      }
      const name = stringField(input, "name");
      if (!name)
        throw new SkillValidationError("skill.name", `is required for ${action ?? "action"}`);
      const skill = byName.get(name);
      if (!skill) throw new SkillValidationError("skill.name", `unknown skill ${name}`);
      if (action === "load") {
        const attributes = [
          `name="${skill.name}"`,
          `location="${skill.directory}"`,
          ...(skill.allowedTools ? [`allowed-tools="${skill.allowedTools}"`] : []),
        ].join(" ");
        return {
          content: [
            {
              type: "text",
              text: `<skill ${attributes}>\n${skill.instructions}\n</skill>`,
            },
          ],
          isError: false,
          details: { name: skill.name, directory: skill.directory },
        };
      }
      if (action === "read") {
        const path = stringField(input, "path");
        if (!path) throw new SkillValidationError("skill.path", "is required for read");
        return {
          content: [{ type: "text", text: await readSkillFile(skill, path) }],
          isError: false,
          details: { name: skill.name, path },
        };
      }
      throw new SkillValidationError("skill.action", "must be list, load, or read");
    },
  };
}
