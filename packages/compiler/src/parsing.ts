// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { DiscoveryError } from "./errors.ts";
import { decodeUtf8, type SnapshotFile } from "./filesystem.ts";

export type JsonObject = Record<string, unknown>;

function validateDepth(value: unknown, maximumDepth: number, depth = 0): void {
  if (depth > maximumDepth)
    throw new DiscoveryError("adoption_manifest_invalid", "JSON nesting exceeds limit");
  if (Array.isArray(value)) for (const item of value) validateDepth(item, maximumDepth, depth + 1);
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) validateDepth(item, maximumDepth, depth + 1);
  }
}

function parseJsonText(file: SnapshotFile, maximumBytes: number, text: string): JsonObject {
  if (file.bytes.byteLength > maximumBytes) {
    throw new DiscoveryError(
      "adoption_scan_limit_exceeded",
      "manifest exceeds byte limit",
      file.relativePath,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError(
      "adoption_manifest_invalid",
      `invalid JSON: ${String(error)}`,
      file.relativePath,
    );
  }
  validateDepth(value, 32);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new DiscoveryError(
      "adoption_manifest_invalid",
      "manifest root must be an object",
      file.relativePath,
    );
  }
  return value as JsonObject;
}

export function parseJsonObject(file: SnapshotFile, maximumBytes: number): JsonObject {
  return parseJsonText(file, maximumBytes, decodeUtf8(file));
}

export function parseJsoncObject(file: SnapshotFile, maximumBytes: number): JsonObject {
  const input = decodeUtf8(file);
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? "";
    const next = input[index + 1] ?? "";
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/"))
        index += 1;
      if (index >= input.length)
        throw new DiscoveryError(
          "adoption_manifest_invalid",
          "unterminated JSONC comment",
          file.relativePath,
        );
      index += 1;
      output += " ";
      continue;
    }
    output += character;
  }
  if (inString)
    throw new DiscoveryError(
      "adoption_manifest_invalid",
      "unterminated JSONC string",
      file.relativePath,
    );
  let withoutTrailingCommas = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index] ?? "";
    if (inString) {
      withoutTrailingCommas += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      withoutTrailingCommas += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (/\s/u.test(output[next] ?? "")) next += 1;
      if (output[next] === "}" || output[next] === "]") continue;
    }
    withoutTrailingCommas += character;
  }
  return parseJsonText(file, maximumBytes, withoutTrailingCommas);
}

export function stringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new DiscoveryError("adoption_manifest_invalid", `${field} must be an array of strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new DiscoveryError("adoption_manifest_invalid", `${field} contains duplicates`);
  }
  return value as string[];
}

export function stringRecord(value: unknown, field: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new DiscoveryError("adoption_manifest_invalid", `${field} must be an object`);
  }
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new DiscoveryError("adoption_manifest_invalid", `${field} values must be strings`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export interface Frontmatter {
  readonly attributes: Readonly<Record<string, string | boolean>>;
  readonly body: string;
  readonly unknownFields: readonly string[];
}

export function parseFrontmatter(text: string, allowedFields: ReadonlySet<string>): Frontmatter {
  if (!text.startsWith("---\n")) return { attributes: {}, body: text, unknownFields: [] };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) throw new DiscoveryError("adoption_manifest_invalid", "unterminated frontmatter");
  const attributes: Record<string, string | boolean> = {};
  const unknownFields: string[] = [];
  for (const line of text.slice(4, end).split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^\s/u.test(line)) {
      throw new DiscoveryError(
        "adoption_manifest_invalid",
        "nested frontmatter YAML is unsupported",
      );
    }
    const colon = line.indexOf(":");
    if (colon <= 0)
      throw new DiscoveryError("adoption_manifest_invalid", "invalid frontmatter entry");
    const key = line.slice(0, colon).trim();
    if (Object.hasOwn(attributes, key)) {
      throw new DiscoveryError("adoption_manifest_invalid", `duplicate frontmatter field ${key}`);
    }
    let raw: string | boolean = line.slice(colon + 1).trim();
    if (
      typeof raw === "string" &&
      (/^(?:[!&*|>]|<<:|\$\{|\{\{)/u.test(raw) || raw.startsWith("[") || raw.startsWith("{"))
    ) {
      throw new DiscoveryError(
        "adoption_manifest_invalid",
        "complex frontmatter YAML is unsupported",
      );
    }
    if (raw === "true") raw = true;
    else if (raw === "false") raw = false;
    else if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    )
      raw = raw.slice(1, -1);
    attributes[key] = raw;
    if (!allowedFields.has(key)) unknownFields.push(key);
  }
  return { attributes, body: text.slice(end + 5), unknownFields: unknownFields.sort() };
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else source += "[^/]*";
    } else if (character === "?") source += "[^/]";
    else source += character.replace(/[|\\{}()[\]^$+?.-]/g, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}

export function expandPatterns(
  paths: readonly string[],
  patterns: readonly string[],
  maximumMatches: number,
): readonly string[] {
  const included = new Set<string>();
  for (const rawPattern of patterns) {
    const excluded = rawPattern.startsWith("!");
    const pattern = excluded ? rawPattern.slice(1) : rawPattern;
    if (
      pattern === "" ||
      pattern.startsWith("/") ||
      pattern.split("/").some((part) => part === "..")
    ) {
      throw new DiscoveryError("adoption_manifest_invalid", "unsafe resource pattern");
    }
    const matcher = globRegex(pattern);
    for (const path of paths) {
      const dotSegment = path.split("/").some((part) => part.startsWith("."));
      const explicitDot = pattern.split("/").some((part) => part.startsWith("."));
      if (dotSegment && !explicitDot) continue;
      if (!matcher.test(path)) continue;
      if (excluded) included.delete(path);
      else included.add(path);
      if (included.size > maximumMatches) {
        throw new DiscoveryError("adoption_scan_limit_exceeded", "glob match limit exceeded");
      }
    }
  }
  return [...included].sort();
}
