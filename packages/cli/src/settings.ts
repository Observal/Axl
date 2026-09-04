// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { THINKING_LEVELS } from "@axl/ai/models";
import type { ThinkingLevel } from "@axl/protocol";

type ImageDisplay = "auto" | "inline" | "metadata";
type ThinkingDisplay = "show" | "compact" | "hide";
type ToolOutputDisplay = "compact" | "full" | "focus";

const TUI_THEME_NAMES = [
  "axl-dark",
  "axl-light",
  "system",
  "high-contrast",
  "axl",
  "ember",
  "ocean",
  "grove",
  "plain",
] as const;

export interface AxlSettings {
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly theme?: string;
}

export interface TuiSettings {
  readonly version: 1;
  readonly modelId?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly theme?: string;
  readonly webFetch?: boolean;
  readonly webSearch?: boolean;
  readonly toolOutputDisplay?: ToolOutputDisplay;
  readonly thinkingDisplay?: ThinkingDisplay;
  readonly tuiMode?: "regular" | "fullscreen";
  readonly fullscreenExitOutput?: "transcript" | "resume-hint";
  readonly fullscreenScrollbar?: "auto" | "always" | "hidden";
  readonly fullscreenMouse?: "capture" | "native";
  readonly attention?: "off" | "bell";
  readonly editorMode?: "standard" | "vim";
  readonly modelFavorites?: readonly string[];
  readonly refocusRecap?: boolean;
  readonly developerPanel?: boolean;
  readonly diffLayout?: "unified" | "split";
  readonly workspaceReview?: boolean;
  readonly imageDisplay?: ImageDisplay;
}

const EMPTY_SETTINGS: TuiSettings = { version: 1 };

function parseLegacySettings(value: unknown, path: string): AxlSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Settings file ${path} must contain a JSON object`);
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!["model", "thinking", "theme"].includes(key)) {
      throw new Error(`Settings file ${path} contains unknown field ${key}`);
    }
  }
  for (const key of ["model", "theme"] as const) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key])) {
      throw new Error(`Settings field ${key} must be a non-empty string`);
    }
  }
  if (input.thinking !== undefined && !THINKING_LEVELS.includes(input.thinking as ThinkingLevel)) {
    throw new Error(`Settings field thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  return input as AxlSettings;
}

function parseSettings(value: unknown, path: string): TuiSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  const input = value as Record<string, unknown>;
  if (input.version === undefined) {
    const legacy = parseLegacySettings(value, path);
    return {
      version: 1,
      ...(legacy.model === undefined ? {} : { modelId: legacy.model }),
      ...(legacy.thinking === undefined ? {} : { thinkingLevel: legacy.thinking }),
      ...(legacy.theme === undefined
        ? {}
        : { theme: legacy.theme === "dark" ? "axl-dark" : legacy.theme }),
    };
  }
  const allowed = new Set([
    "version",
    "modelId",
    "thinkingLevel",
    "theme",
    "webFetch",
    "webSearch",
    "toolOutputDisplay",
    "thinkingDisplay",
    "tuiMode",
    "fullscreenExitOutput",
    "fullscreenScrollbar",
    "fullscreenMouse",
    "attention",
    "editorMode",
    "modelFavorites",
    "refocusRecap",
    "developerPanel",
    "diffLayout",
    "workspaceReview",
    "imageDisplay",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`${path}: unknown setting ${key}`);
  }
  if (input.version !== 1) throw new Error(`${path}: version must be 1`);
  if (input.modelId !== undefined && (typeof input.modelId !== "string" || !input.modelId)) {
    throw new Error(`${path}: modelId must be a non-empty string`);
  }
  if (
    input.thinkingLevel !== undefined &&
    !THINKING_LEVELS.includes(input.thinkingLevel as ThinkingLevel)
  ) {
    throw new Error(`${path}: invalid thinkingLevel`);
  }
  if (
    input.theme !== undefined &&
    !TUI_THEME_NAMES.includes(input.theme as (typeof TUI_THEME_NAMES)[number])
  ) {
    throw new Error(`${path}: invalid theme`);
  }
  for (const field of ["webFetch", "webSearch"] as const) {
    if (input[field] !== undefined && typeof input[field] !== "boolean") {
      throw new Error(`${path}: ${field} must be a boolean`);
    }
  }
  if (
    input.toolOutputDisplay !== undefined &&
    input.toolOutputDisplay !== "compact" &&
    input.toolOutputDisplay !== "full" &&
    input.toolOutputDisplay !== "focus"
  ) {
    throw new Error(`${path}: invalid toolOutputDisplay`);
  }
  if (
    input.thinkingDisplay !== undefined &&
    input.thinkingDisplay !== "show" &&
    input.thinkingDisplay !== "compact" &&
    input.thinkingDisplay !== "hide"
  ) {
    throw new Error(`${path}: invalid thinkingDisplay`);
  }
  if (
    input.tuiMode !== undefined &&
    input.tuiMode !== "regular" &&
    input.tuiMode !== "fullscreen"
  ) {
    throw new Error(`${path}: invalid tuiMode`);
  }
  if (
    input.fullscreenExitOutput !== undefined &&
    input.fullscreenExitOutput !== "transcript" &&
    input.fullscreenExitOutput !== "resume-hint"
  ) {
    throw new Error(`${path}: invalid fullscreenExitOutput`);
  }
  if (
    input.fullscreenScrollbar !== undefined &&
    input.fullscreenScrollbar !== "auto" &&
    input.fullscreenScrollbar !== "always" &&
    input.fullscreenScrollbar !== "hidden"
  ) {
    throw new Error(`${path}: invalid fullscreenScrollbar`);
  }
  if (
    input.fullscreenMouse !== undefined &&
    input.fullscreenMouse !== "capture" &&
    input.fullscreenMouse !== "native"
  ) {
    throw new Error(`${path}: invalid fullscreenMouse`);
  }
  if (input.attention !== undefined && input.attention !== "off" && input.attention !== "bell") {
    throw new Error(`${path}: invalid attention`);
  }
  if (
    input.editorMode !== undefined &&
    input.editorMode !== "standard" &&
    input.editorMode !== "vim"
  ) {
    throw new Error(`${path}: invalid editorMode`);
  }
  if (
    input.modelFavorites !== undefined &&
    (!Array.isArray(input.modelFavorites) ||
      input.modelFavorites.some((model) => typeof model !== "string" || model.length === 0) ||
      new Set(input.modelFavorites).size !== input.modelFavorites.length)
  ) {
    throw new Error(`${path}: modelFavorites must contain unique non-empty strings`);
  }
  if (input.refocusRecap !== undefined && typeof input.refocusRecap !== "boolean") {
    throw new Error(`${path}: refocusRecap must be a boolean`);
  }
  if (input.developerPanel !== undefined && typeof input.developerPanel !== "boolean") {
    throw new Error(`${path}: developerPanel must be a boolean`);
  }
  if (input.workspaceReview !== undefined && typeof input.workspaceReview !== "boolean") {
    throw new Error(`${path}: workspaceReview must be a boolean`);
  }
  if (
    input.imageDisplay !== undefined &&
    input.imageDisplay !== "auto" &&
    input.imageDisplay !== "inline" &&
    input.imageDisplay !== "metadata"
  ) {
    throw new Error(`${path}: invalid imageDisplay`);
  }
  if (
    input.diffLayout !== undefined &&
    input.diffLayout !== "unified" &&
    input.diffLayout !== "split"
  ) {
    throw new Error(`${path}: invalid diffLayout`);
  }
  return input as unknown as TuiSettings;
}

export async function loadTuiSettings(path: string): Promise<TuiSettings> {
  try {
    return parseSettings(JSON.parse(await readFile(path, "utf8")), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_SETTINGS;
    throw error;
  }
}

async function writeSettingsFile(path: string, value: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function saveTuiSettings(path: string, settings: TuiSettings): Promise<void> {
  await writeSettingsFile(path, parseSettings(settings, path));
}

export async function readSettings(path: string): Promise<AxlSettings> {
  try {
    return parseLegacySettings(JSON.parse(await readFile(path, "utf8")), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function writeSettings(path: string, settings: AxlSettings): Promise<void> {
  await writeSettingsFile(path, parseLegacySettings(settings, path));
}
