// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { ContextResource } from "@axl/protocol";

/** One named section of the stable prompt; loggable as a `prompt.section` event. */
export interface PromptSection {
  readonly name: string;
  readonly source: string;
  readonly content: string;
}

/** The stable prompt: frozen at session start, the prompt-cache prefix. */
export interface StablePrompt {
  readonly text: string;
  readonly sections: readonly PromptSection[];
}

export const DEFAULT_IDENTITY =
  "You are Axl, a coding agent. You help users inspect repositories, run commands, edit code, and verify changes.";

/** Essential operating constraints — short, static, and free of feature instructions. */
export const ESSENTIAL_CONSTRAINTS: readonly string[] = [
  "Prefer small, verifiable steps and report what you actually did.",
  "When a command or edit fails, show the failure rather than working around it silently.",
  "Never fabricate file contents or command output.",
];

export interface StablePromptInput {
  readonly identity?: string;
  readonly cwd: string;
  /** Active tool names with one-line descriptions. Schemas travel to the provider separately. */
  readonly tools: readonly { readonly name: string; readonly description: string }[];
  /** Applicable AGENTS.md sections, e.g. from `loadAgentsInstructions`. */
  readonly instructions?: readonly PromptSection[];
  readonly constraints?: readonly string[];
}

function xmlAttribute(value: string): string {
  return `"${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}"`;
}

/**
 * Builds the stable base prompt: identity, working directory, active tools,
 * applicable AGENTS.md, and essential constraints — nothing else. No subagent
 * section, no skill bodies, no feature instructions, no dynamic values that
 * would invalidate the prompt-cache prefix. Byte-identical for identical
 * input, by construction.
 */
export function buildStablePrompt(input: StablePromptInput): StablePrompt {
  const instructions = input.instructions ?? [];
  const sections: PromptSection[] = [
    { name: "identity", source: "core", content: input.identity ?? DEFAULT_IDENTITY },
    {
      name: "tools",
      source: "core",
      content:
        input.tools.length === 0
          ? "Available tools:\n(none)"
          : `Available tools:\n${input.tools
              .map((tool) => `- ${tool.name}: ${tool.description}`)
              .join("\n")}`,
    },
    {
      name: "constraints",
      source: "core",
      content: `Guidelines:\n${(input.constraints ?? ESSENTIAL_CONSTRAINTS)
        .map((line) => `- ${line}`)
        .join("\n")}`,
    },
    ...(instructions.length === 0
      ? []
      : [
          {
            name: "project-context",
            source: "agents",
            content: [
              "<project_context>",
              "Project-specific instructions and guidelines:",
              ...instructions.map(
                (section) =>
                  `<project_instructions path=${xmlAttribute(section.source)}>\n${section.content}\n</project_instructions>`,
              ),
              "</project_context>",
            ].join("\n\n"),
          },
        ]),
    { name: "workspace", source: "core", content: `Current working directory: ${input.cwd}` },
  ];
  return {
    sections,
    text: sections.map((section) => section.content).join("\n\n"),
  };
}

export interface AgentsInstructionsInput {
  /** Working directory whose repository ancestry supplies project instructions. */
  readonly cwd: string;
  /** Global instructions file, e.g. `~/.axl/AGENTS.md`. Absent by default. */
  readonly globalPath?: string;
}

const MAX_AGENTS_BYTES = 512 * 1024;

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
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

async function repositoryRoot(cwd: string): Promise<string> {
  let directory = await realpath(resolve(cwd));
  for (;;) {
    if (await exists(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return await realpath(resolve(cwd));
    directory = parent;
  }
}

async function selectedAgentsPath(
  directory: string,
  defaultPath?: string,
): Promise<string | undefined> {
  const override = join(directory, "AGENTS.override.md");
  if (await exists(override)) return override;
  const candidate = defaultPath ?? join(directory, "AGENTS.md");
  return (await exists(candidate)) ? candidate : undefined;
}

async function readResource(
  requestedPath: string,
  root: string,
  scope: ContextResource["scope"],
): Promise<ContextResource> {
  const path = await realpath(requestedPath);
  if (!within(root, path))
    throw new Error(`AGENTS.md path escapes its trusted root: ${requestedPath}`);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`AGENTS.md path is not a regular file: ${requestedPath}`);
  if (metadata.size > MAX_AGENTS_BYTES) {
    throw new Error(`AGENTS.md files must not exceed ${MAX_AGENTS_BYTES} bytes: ${requestedPath}`);
  }
  const bytes = await readFile(path);
  if (bytes.includes(0)) throw new Error(`AGENTS.md file is binary: ${requestedPath}`);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch (cause) {
    throw new Error(`AGENTS.md file is not valid UTF-8: ${requestedPath}`, { cause });
  }
  return { kind: "agents", scope, path, content };
}

/** Discovers global and repository-scoped AGENTS.md resources in precedence order. */
export async function loadAgentsResources(
  input: AgentsInstructionsInput,
): Promise<readonly ContextResource[]> {
  const cwd = await realpath(resolve(input.cwd));
  const root = await repositoryRoot(cwd);
  const directories: string[] = [];
  for (let directory = cwd; ; directory = dirname(directory)) {
    directories.push(directory);
    if (directory === root) break;
  }
  directories.reverse();

  const candidates: Array<{ path: string; root: string; scope: ContextResource["scope"] }> = [];
  if (input.globalPath !== undefined) {
    const globalPath = resolve(input.globalPath);
    const selected = await selectedAgentsPath(dirname(globalPath), globalPath);
    if (selected !== undefined) {
      const globalRoot = await realpath(dirname(globalPath));
      candidates.push({ path: selected, root: globalRoot, scope: "global" });
    }
  }
  for (const directory of directories) {
    const selected = await selectedAgentsPath(directory);
    if (selected !== undefined) candidates.push({ path: selected, root, scope: "project" });
  }

  const resources: ContextResource[] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    const resource = await readResource(candidate.path, candidate.root, candidate.scope);
    if (resource.content.length === 0) continue;
    totalBytes += Buffer.byteLength(resource.content);
    if (totalBytes > MAX_AGENTS_BYTES) {
      throw new Error(`Combined AGENTS.md content must not exceed ${MAX_AGENTS_BYTES} bytes`);
    }
    resources.push(resource);
    if (Buffer.byteLength(JSON.stringify({ resources })) > 700 * 1024) {
      throw new Error("AGENTS.md resource snapshot exceeds the canonical event limit");
    }
  }
  return resources;
}

export function agentsInstructionsFromResources(
  resources: readonly ContextResource[],
): readonly PromptSection[] {
  return resources.map((resource, index) => ({
    name: `agents-${resource.scope}-${index}`,
    source: resource.path,
    content: resource.content,
  }));
}

/** Reads applicable AGENTS.md files as stable prompt sections. */
export async function loadAgentsInstructions(
  input: AgentsInstructionsInput,
): Promise<readonly PromptSection[]> {
  return agentsInstructionsFromResources(await loadAgentsResources(input));
}
