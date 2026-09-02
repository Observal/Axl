// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { THINKING_LEVELS } from "@axl/ai";
import type { ThinkingLevel } from "@axl/protocol";

export interface AxlSettings {
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly theme?: string;
}

export async function readSettings(path: string): Promise<AxlSettings> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read settings ${path}`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Settings file ${path} is not valid JSON`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Settings file ${path} must contain a JSON object`);
  }
  const settings = value as Record<string, unknown>;
  for (const key of Object.keys(settings)) {
    if (!["model", "thinking", "theme"].includes(key)) {
      throw new Error(`Settings file ${path} contains unknown field ${key}`);
    }
  }
  for (const key of ["model", "theme"] as const) {
    if (settings[key] !== undefined && (typeof settings[key] !== "string" || !settings[key])) {
      throw new Error(`Settings field ${key} must be a non-empty string`);
    }
  }
  if (
    settings.thinking !== undefined &&
    !THINKING_LEVELS.includes(settings.thinking as ThinkingLevel)
  ) {
    throw new Error(`Settings field thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  return settings as AxlSettings;
}

export async function writeSettings(path: string, settings: AxlSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
