// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { TerminalExtension } from "@axl/extension-api";
import { parseDocument } from "yaml";

const TEMPLATE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_TEMPLATE_BYTES = 256_000;
const MAX_TEMPLATES_PER_DIRECTORY = 256;
const MAX_ARGUMENT_CHARACTERS = 32_000;
const MAX_EXPANDED_BYTES = 512_000;
const PLACEHOLDER = /\{\{\s*(all|[1-9]\d?)(?:\s*=\s*([^{}]*))?\s*\}\}/gu;

export interface PromptTemplate {
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
  readonly content: string;
  readonly path: string;
  readonly scope: "global" | "project";
}

export interface PromptTemplateDiscoveryOptions {
  readonly cwd: string;
  readonly globalDirectory?: string;
}

export class PromptTemplateError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "PromptTemplateError";
    this.path = path;
  }
}

function decodeTemplate(bytes: Uint8Array, path: string): string {
  if (bytes.includes(0)) throw new PromptTemplateError(path, "must be a text file");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new PromptTemplateError(path, `must be valid UTF-8: ${String(cause)}`);
  }
}

function optionalMetadata(
  fields: Record<string, unknown>,
  key: "description" | "usage",
  path: string,
  maximum: number,
): string | undefined {
  const value = fields[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new PromptTemplateError(`${path}:${key}`, "must be a non-empty string");
  }
  const normalized = value.trim();
  if ([...normalized].length > maximum) {
    throw new PromptTemplateError(`${path}:${key}`, `must contain at most ${maximum} characters`);
  }
  return normalized;
}

function parseTemplateSource(
  source: string,
  path: string,
): {
  readonly description?: string;
  readonly usage?: string;
  readonly content: string;
} {
  let body = source;
  let fields: Record<string, unknown> = {};
  if (/^---\r?\n/u.test(source)) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(source);
    if (!match) throw new PromptTemplateError(path, "has unterminated YAML frontmatter");
    const document = parseDocument(match[1] as string, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw new PromptTemplateError(path, document.errors.map((error) => error.message).join("; "));
    }
    const metadata = document.toJS({ maxAliasCount: 20 }) as unknown;
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      throw new PromptTemplateError(path, "frontmatter must be a mapping");
    }
    fields = metadata as Record<string, unknown>;
    const unknown = Object.keys(fields).find((key) => key !== "description" && key !== "usage");
    if (unknown !== undefined) {
      throw new PromptTemplateError(`${path}:${unknown}`, "is not a supported field");
    }
    body = match[2] as string;
  }
  const content = body.trim();
  if (!content) throw new PromptTemplateError(path, "template body cannot be empty");
  const description = optionalMetadata(fields, "description", path, 256);
  const usage = optionalMetadata(fields, "usage", path, 128);
  return {
    ...(description === undefined ? {} : { description }),
    ...(usage === undefined ? {} : { usage }),
    content,
  };
}

function inferredDescription(content: string): string {
  const line = content
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find(Boolean) as string;
  const plain = line.replace(/^#{1,6}\s+/u, "").replace(/\s+/gu, " ");
  return plain.length <= 160 ? plain : `${plain.slice(0, 159)}…`;
}

async function loadPromptTemplate(
  path: string,
  name: string,
  scope: PromptTemplate["scope"],
): Promise<PromptTemplate> {
  if (!TEMPLATE_NAME.test(name)) {
    throw new PromptTemplateError(
      path,
      "filename must start with a lowercase letter and contain lowercase letters, digits, or single hyphens",
    );
  }
  const file = await stat(path);
  if (!file.isFile()) throw new PromptTemplateError(path, "must be a regular file");
  if (file.size > MAX_TEMPLATE_BYTES) {
    throw new PromptTemplateError(path, `exceeds ${MAX_TEMPLATE_BYTES} bytes`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_TEMPLATE_BYTES) {
    throw new PromptTemplateError(path, `exceeds ${MAX_TEMPLATE_BYTES} bytes`);
  }
  const parsed = parseTemplateSource(decodeTemplate(bytes, path), path);
  return {
    name,
    description: parsed.description ?? inferredDescription(parsed.content),
    ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
    content: parsed.content,
    path,
    scope,
  };
}

async function templatesIn(
  directory: string,
  scope: PromptTemplate["scope"],
): Promise<readonly PromptTemplate[]> {
  let root: string;
  let entries: Dirent[];
  try {
    root = await realpath(directory);
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const markdown = entries
    .filter((entry) => extname(entry.name) === ".md")
    .sort((left, right) => left.name.localeCompare(right.name));
  if (markdown.length > MAX_TEMPLATES_PER_DIRECTORY) {
    throw new PromptTemplateError(
      directory,
      `contains more than ${MAX_TEMPLATES_PER_DIRECTORY} prompt templates`,
    );
  }
  const templates: PromptTemplate[] = [];
  for (const entry of markdown) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const candidatePath = join(root, entry.name);
    const candidate = await realpath(candidatePath).catch((cause: unknown) => {
      throw new PromptTemplateError(candidatePath, `cannot resolve template: ${String(cause)}`);
    });
    const fromRoot = relative(root, candidate);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new PromptTemplateError(candidatePath, "template escapes its discovery root");
    }
    templates.push(
      await loadPromptTemplate(candidate, basename(entry.name, extname(entry.name)), scope),
    );
  }
  return templates;
}

/** Discovers global templates first, with project templates overriding by exact name. */
export async function discoverPromptTemplates(
  options: PromptTemplateDiscoveryOptions,
): Promise<readonly PromptTemplate[]> {
  const discovered = new Map<string, PromptTemplate>();
  const sources: Array<{ directory: string; scope: PromptTemplate["scope"] }> = [
    ...(options.globalDirectory === undefined
      ? []
      : [{ directory: options.globalDirectory, scope: "global" as const }]),
    { directory: join(resolve(options.cwd), ".axl", "prompts"), scope: "project" },
  ];
  for (const source of sources) {
    for (const template of await templatesIn(source.directory, source.scope)) {
      discovered.set(template.name, template);
    }
  }
  return [...discovered.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function parseTemplateArguments(source: string, template: PromptTemplate): readonly string[] {
  if ([...source].length > MAX_ARGUMENT_CHARACTERS) {
    throw new PromptTemplateError(template.path, "template arguments are too long");
  }
  const values: string[] = [];
  let value = "";
  let active = false;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const character of source) {
    if (escaped) {
      value += character;
      active = true;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
      active = true;
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else value += character;
      active = true;
    } else if (character === '"' || character === "'") {
      quote = character;
      active = true;
    } else if (/\s/u.test(character)) {
      if (active) {
        values.push(value);
        value = "";
        active = false;
      }
    } else {
      value += character;
      active = true;
    }
  }
  if (escaped) throw new PromptTemplateError(template.path, "arguments end with an escape");
  if (quote !== undefined)
    throw new PromptTemplateError(template.path, "arguments have an open quote");
  if (active) values.push(value);
  return values;
}

export function expandPromptTemplate(template: PromptTemplate, source: string): string {
  const values = parseTemplateArguments(source, template);
  let placeholders = 0;
  let highestPosition = 0;
  let acceptsAll = false;
  const expanded = template.content.replace(
    PLACEHOLDER,
    (_placeholder, key: string, defaultValue: string | undefined) => {
      placeholders += 1;
      const fallback = defaultValue?.trim();
      if (key === "all") {
        acceptsAll = true;
        const all = values.join(" ");
        if (all) return all;
        if (fallback !== undefined) return fallback;
        throw new PromptTemplateError(template.path, `/prompt ${template.name} requires arguments`);
      }
      const position = Number(key);
      highestPosition = Math.max(highestPosition, position);
      const value = values[position - 1];
      if (value) return value;
      if (fallback !== undefined) return fallback;
      throw new PromptTemplateError(
        template.path,
        `/prompt ${template.name} requires argument ${position}`,
      );
    },
  );
  if (!acceptsAll && values.length > highestPosition) {
    const expected =
      placeholders === 0
        ? "no arguments"
        : `at most ${highestPosition} argument${highestPosition === 1 ? "" : "s"}`;
    throw new PromptTemplateError(template.path, `/prompt ${template.name} accepts ${expected}`);
  }
  if (Buffer.byteLength(expanded) > MAX_EXPANDED_BYTES) {
    throw new PromptTemplateError(
      template.path,
      `expanded prompt exceeds ${MAX_EXPANDED_BYTES} bytes`,
    );
  }
  return expanded;
}

function sessionCwd(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null || Array.isArray(event)) return undefined;
  const candidate = event as { readonly type?: unknown; readonly payload?: unknown };
  if (candidate.type !== "session.created") return undefined;
  if (
    typeof candidate.payload !== "object" ||
    candidate.payload === null ||
    Array.isArray(candidate.payload)
  ) {
    return undefined;
  }
  const cwd = (candidate.payload as { readonly cwd?: unknown }).cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

function commandSummary(template: PromptTemplate): string {
  return [template.usage, template.description, template.scope].filter(Boolean).join(" · ");
}

export function promptTemplatesExtension(
  options: PromptTemplateDiscoveryOptions,
): TerminalExtension {
  let cwd = resolve(options.cwd);
  return {
    manifest: {
      id: "axl.prompt-templates",
      name: "Prompt templates",
      capabilities: ["terminal.commands", "terminal.events"],
    },
    async activate(api) {
      let templates = await discoverPromptTemplates({ ...options, cwd });
      let byName = new Map(templates.map((template) => [template.name, template]));
      let generation = 0;
      let refresh = Promise.resolve();
      api.registerCommand({
        name: "prompt",
        description: "Expand a reusable prompt template",
        complete: (prefix) => {
          const query = prefix.trimStart();
          if (/\s/u.test(query)) return [];
          return templates
            .filter((template) => template.name.startsWith(query))
            .map((template) => template.name);
        },
        async run(arguments_, context) {
          await refresh;
          const invocation = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/u.exec(
            arguments_.trim(),
          );
          if (!invocation) {
            if (templates.length === 0) {
              context.notify(
                "No prompt templates found in ~/.axl/prompts or .axl/prompts",
                "warning",
              );
              return;
            }
            const name = await context.select(
              "Prompt templates",
              templates.map((template) => ({
                value: template.name,
                label: template.name,
                description: commandSummary(template),
              })),
            );
            if (name !== undefined) context.setEditorText(`/prompt ${name}`);
            return;
          }
          const name = invocation[1] as string;
          const template = byName.get(name);
          if (template === undefined) throw new Error(`Unknown prompt template ${name}`);
          context.setEditorText(expandPromptTemplate(template, invocation[2] ?? ""));
          context.notify(`Expanded ${name}; review it, then press Enter to send`, "accent");
        },
      });
      api.on("session.event", async (input) => {
        if (input.type !== "session.event") return;
        const nextCwd = sessionCwd(input.event);
        if (nextCwd === undefined || resolve(nextCwd) === cwd) return;
        cwd = resolve(nextCwd);
        const current = ++generation;
        templates = [];
        byName = new Map();
        refresh = discoverPromptTemplates({ ...options, cwd }).then((discovered) => {
          if (input.signal.aborted || current !== generation) return;
          templates = discovered;
          byName = new Map(discovered.map((template) => [template.name, template]));
        });
        await refresh;
      });
    },
  };
}
