// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { Dirent } from "node:fs";
import { type FSWatcher, watch } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { THEME_DEFINITIONS, THEMES, type ThemeDefinition } from "./themes.ts";
import type { Palette } from "./transcript.ts";

const THEME_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_THEME_BYTES = 64_000;
const MAX_THEMES_PER_DIRECTORY = 128;
const APPEARANCES = new Set(["dark", "light", "system", "accessible", "plain"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const FOREGROUND_ROLES = new Set([
  "dim",
  "accent",
  "error",
  "border",
  "success",
  "warning",
  "text",
  "diffAdded",
  "diffRemoved",
  "diffContext",
  "mdHeading",
  "mdCode",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdListBullet",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "keyword",
  "literal",
]);
const BACKGROUND_ROLES = new Set([
  "userMessage",
  "searchMatch",
  "toolBackground",
  "toolPendingBackground",
  "toolSuccessBackground",
  "toolErrorBackground",
  "toolDeniedBackground",
  "diffAddedBackground",
  "diffRemovedBackground",
]);
const PAIR_ROLES = new Set(["userMessage", "selection", "searchCurrent"]);
const BUILTIN_IDS = new Set(THEME_DEFINITIONS.map((theme) => theme.id));

export interface ThemeCatalog {
  readonly definitions: readonly ThemeDefinition[];
  readonly palettes: Readonly<Record<string, Palette>>;
}

export interface ThemeDiscoveryOptions {
  readonly cwd: string;
  readonly globalDirectory?: string;
}

export class ThemeValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ThemeValidationError";
    this.path = path;
  }
}

type ColorValue = string | number;
type Style = (text: string) => string;

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ThemeValidationError(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string, maximum = 128): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ThemeValidationError(path, "must be a non-empty string");
  }
  const normalized = value.trim();
  if ([...normalized].length > maximum) {
    throw new ThemeValidationError(path, `must contain at most ${maximum} characters`);
  }
  return normalized;
}

function color(value: unknown, path: string): ColorValue {
  if (value === "default") return value;
  if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/u.test(value)) {
    return value.toLowerCase();
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255) {
    return value;
  }
  throw new ThemeValidationError(path, 'must be "default", a #RRGGBB color, or an integer 0-255');
}

function colorCode(value: ColorValue, layer: 38 | 48): string | undefined {
  if (value === "default") return undefined;
  if (typeof value === "number") return `${layer};5;${value}`;
  const parsed = Number.parseInt(value.slice(1), 16);
  return `${layer};2;${(parsed >> 16) & 255};${(parsed >> 8) & 255};${parsed & 255}`;
}

function style(foreground: ColorValue | undefined, background: ColorValue | undefined): Style {
  const open = [
    ...(foreground === undefined ? [] : [colorCode(foreground, 38)]),
    ...(background === undefined ? [] : [colorCode(background, 48)]),
  ].filter((value): value is string => value !== undefined);
  if (open.length === 0) return (text) => text;
  const close = [
    foreground === undefined ? undefined : "39",
    background === undefined ? undefined : "49",
  ]
    .filter((value): value is string => value !== undefined)
    .join(";");
  return (text) => `\x1b[${open.join(";")}m${text}\x1b[${close}m`;
}

function colorMap(
  value: unknown,
  path: string,
  allowed: ReadonlySet<string>,
): Readonly<Record<string, ColorValue>> {
  if (value === undefined) return {};
  const input = object(value, path);
  const output: Record<string, ColorValue> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (!allowed.has(key)) throw new ThemeValidationError(`${path}.${key}`, "is not a color role");
    output[key] = color(entry, `${path}.${key}`);
  }
  return output;
}

function pairMap(
  value: unknown,
  path: string,
): Readonly<Record<string, { readonly foreground: ColorValue; readonly background: ColorValue }>> {
  if (value === undefined) return {};
  const input = object(value, path);
  const output: Record<string, { foreground: ColorValue; background: ColorValue }> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (!PAIR_ROLES.has(key))
      throw new ThemeValidationError(`${path}.${key}`, "is not a pair role");
    const pair = object(entry, `${path}.${key}`);
    const unknown = Object.keys(pair).find(
      (field) => field !== "foreground" && field !== "background",
    );
    if (unknown !== undefined) {
      throw new ThemeValidationError(`${path}.${key}.${unknown}`, "is not supported");
    }
    if (pair.foreground === undefined || pair.background === undefined) {
      throw new ThemeValidationError(`${path}.${key}`, "requires foreground and background");
    }
    output[key] = {
      foreground: color(pair.foreground, `${path}.${key}.foreground`),
      background: color(pair.background, `${path}.${key}.background`),
    };
  }
  return output;
}

function compilePalette(input: Record<string, unknown>, path: string, base: Palette): Palette {
  const foregrounds = colorMap(input.foregrounds, `${path}.foregrounds`, FOREGROUND_ROLES);
  const backgrounds = colorMap(input.backgrounds, `${path}.backgrounds`, BACKGROUND_ROLES);
  const pairs = pairMap(input.pairs, `${path}.pairs`);
  const thinking = colorMap(input.thinking, `${path}.thinking`, THINKING_LEVELS);
  if (
    Object.keys(foregrounds).length +
      Object.keys(backgrounds).length +
      Object.keys(pairs).length +
      Object.keys(thinking).length ===
    0
  ) {
    throw new ThemeValidationError(path, "must override at least one color");
  }
  if (pairs.userMessage !== undefined && backgrounds.userMessage !== undefined) {
    throw new ThemeValidationError(
      `${path}.userMessage`,
      "cannot appear in both backgrounds and pairs",
    );
  }
  const overrides: Record<string, Style> = {};
  for (const [key, value] of Object.entries(foregrounds)) overrides[key] = style(value, undefined);
  for (const [key, value] of Object.entries(backgrounds)) overrides[key] = style(undefined, value);
  for (const [key, value] of Object.entries(pairs)) {
    overrides[key] = style(value.foreground, value.background);
  }
  return {
    ...base,
    ...overrides,
    ...(Object.keys(thinking).length === 0
      ? {}
      : {
          thinking: (level: string, text: string) => {
            const value = thinking[level];
            return value === undefined
              ? (base.thinking?.(level, text) ?? text)
              : style(value, undefined)(text);
          },
        }),
  } as Palette;
}

function decode(bytes: Uint8Array, path: string): string {
  if (bytes.includes(0)) throw new ThemeValidationError(path, "must be a text file");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new ThemeValidationError(path, `must be valid UTF-8: ${String(cause)}`);
  }
}

async function loadTheme(
  path: string,
  fileName: string,
  origin: "global" | "project",
): Promise<ThemeDefinition> {
  const id = basename(fileName, extname(fileName));
  if (!THEME_ID.test(id)) {
    throw new ThemeValidationError(
      path,
      "filename must start with a lowercase letter and contain lowercase letters, digits, or single hyphens",
    );
  }
  if (BUILTIN_IDS.has(id))
    throw new ThemeValidationError(path, `cannot replace built-in theme ${id}`);
  const file = await stat(path);
  if (!file.isFile()) throw new ThemeValidationError(path, "must be a regular file");
  if (file.size > MAX_THEME_BYTES)
    throw new ThemeValidationError(path, `exceeds ${MAX_THEME_BYTES} bytes`);
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_THEME_BYTES) {
    throw new ThemeValidationError(path, `exceeds ${MAX_THEME_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decode(bytes, path));
  } catch (cause) {
    if (cause instanceof ThemeValidationError) throw cause;
    throw new ThemeValidationError(path, `contains invalid JSON: ${String(cause)}`);
  }
  const input = object(parsed, path);
  const allowed = new Set([
    "version",
    "id",
    "label",
    "appearance",
    "inherits",
    "foregrounds",
    "backgrounds",
    "pairs",
    "thinking",
  ]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown !== undefined)
    throw new ThemeValidationError(`${path}.${unknown}`, "is not supported");
  if (input.version !== 1) throw new ThemeValidationError(`${path}.version`, "must be 1");
  if (string(input.id, `${path}.id`) !== id) {
    throw new ThemeValidationError(`${path}.id`, "must match the filename");
  }
  const appearance = string(input.appearance, `${path}.appearance`);
  if (!APPEARANCES.has(appearance)) {
    throw new ThemeValidationError(`${path}.appearance`, "is not supported");
  }
  const inherited = string(input.inherits, `${path}.inherits`);
  const base = THEMES[inherited];
  if (base === undefined) {
    throw new ThemeValidationError(`${path}.inherits`, "must name a built-in theme");
  }
  return {
    version: 1,
    id,
    label: string(input.label, `${path}.label`),
    appearance: appearance as ThemeDefinition["appearance"],
    palette: compilePalette(input, path, base),
    origin,
  };
}

async function themesIn(
  directory: string,
  origin: "global" | "project",
): Promise<readonly ThemeDefinition[]> {
  let root: string;
  let entries: Dirent[];
  try {
    root = await realpath(directory);
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files = entries
    .filter((entry) => extname(entry.name) === ".json")
    .sort((left, right) => left.name.localeCompare(right.name));
  if (files.length > MAX_THEMES_PER_DIRECTORY) {
    throw new ThemeValidationError(
      directory,
      `contains more than ${MAX_THEMES_PER_DIRECTORY} themes`,
    );
  }
  const themes: ThemeDefinition[] = [];
  for (const entry of files) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const candidatePath = join(root, entry.name);
    const candidate = await realpath(candidatePath).catch((cause: unknown) => {
      throw new ThemeValidationError(candidatePath, `cannot resolve theme: ${String(cause)}`);
    });
    const fromRoot = relative(root, candidate);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new ThemeValidationError(candidatePath, "theme escapes its discovery root");
    }
    themes.push(await loadTheme(candidate, entry.name, origin));
  }
  return themes;
}

function directories(options: ThemeDiscoveryOptions): readonly string[] {
  return [
    ...(options.globalDirectory === undefined ? [] : [options.globalDirectory]),
    join(resolve(options.cwd), ".axl", "themes"),
  ];
}

export async function loadThemeCatalog(options: ThemeDiscoveryOptions): Promise<ThemeCatalog> {
  const custom = new Map<string, ThemeDefinition>();
  if (options.globalDirectory !== undefined) {
    for (const theme of await themesIn(options.globalDirectory, "global")) {
      custom.set(theme.id, theme);
    }
  }
  const projectDirectory = join(resolve(options.cwd), ".axl", "themes");
  for (const theme of await themesIn(projectDirectory, "project")) custom.set(theme.id, theme);
  const definitions = [
    ...THEME_DEFINITIONS,
    ...[...custom.values()].sort((left, right) => left.id.localeCompare(right.id)),
  ];
  return {
    definitions,
    palettes: Object.fromEntries(definitions.map((theme) => [theme.id, theme.palette])),
  };
}

export async function watchThemeDirectories(
  options: ThemeDiscoveryOptions,
  onChange: (error?: Error) => void,
): Promise<() => void> {
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const queue = (): void => {
    if (closed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) onChange();
    }, 50);
    timer.unref?.();
  };
  for (const directory of directories(options)) {
    let root: string;
    try {
      root = await realpath(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const watcher = watch(root, { persistent: false }, (_event, fileName) => {
      if (fileName === null || extname(String(fileName)) === ".json") queue();
    });
    watcher.on("error", (error) => {
      if (!closed) onChange(error);
    });
    watchers.push(watcher);
  }
  return () => {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
