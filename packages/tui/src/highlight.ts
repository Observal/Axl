// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { sanitizeTerminalText } from "./render.ts";
import type { Palette } from "./transcript.ts";

// The package declaration references the DOM. Loading through Node keeps the TUI type surface Node-only.
interface HighlightEngine {
  getLanguage(name: string): unknown;
  highlight(
    code: string,
    options: { language: string; ignoreIllegals: boolean },
  ): {
    readonly value: string;
  };
}

const highlightEngine = createRequire(import.meta.url)("highlight.js") as HighlightEngine;

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  cc: "cpp",
  cjs: "javascript",
  clj: "clojure",
  cs: "csharp",
  cts: "typescript",
  cxx: "cpp",
  erl: "erlang",
  ex: "elixir",
  exs: "elixir",
  h: "c",
  hpp: "cpp",
  hs: "haskell",
  htm: "xml",
  html: "xml",
  js: "javascript",
  jsx: "javascript",
  kt: "kotlin",
  md: "markdown",
  mjs: "javascript",
  ml: "ocaml",
  mts: "typescript",
  proto: "protobuf",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  tf: "hcl",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
};

const FILE_LANGUAGES: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  cmakelists: "cmake",
  "cmakelists.txt": "cmake",
  gemfile: "ruby",
  rakefile: "ruby",
};

function languageName(language: string | undefined): string | undefined {
  if (language === undefined) return undefined;
  const normalized = language.trim().toLowerCase();
  if (!normalized || ["text", "plaintext", "txt"].includes(normalized)) return undefined;
  const resolved = LANGUAGE_ALIASES[normalized] ?? normalized;
  return highlightEngine.getLanguage(resolved) === undefined ? undefined : resolved;
}

/** Resolves a highlight.js language from a file path without content guessing. */
export function languageForPath(path: string): string | undefined {
  const name = path.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
  const named = FILE_LANGUAGES[name];
  if (named !== undefined) return named;
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return languageName(extension);
}

function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#x27|#39);/gu, (entity) => {
    if (entity === "&amp;") return "&";
    if (entity === "&lt;") return "<";
    if (entity === "&gt;") return ">";
    if (entity === "&quot;") return '"';
    return "'";
  });
}

type Color = (text: string) => string;

function tokenColor(classes: readonly string[], palette: Palette): Color | undefined {
  if (classes.some((name) => name === "comment" || name === "doctag")) {
    return palette.syntaxComment ?? palette.dim;
  }
  if (
    classes.some(
      (name) =>
        name === "keyword" ||
        name === "name" ||
        name === "selector-tag" ||
        name === "selector-id" ||
        name === "selector-class" ||
        name === "selector-pseudo",
    )
  ) {
    return palette.syntaxKeyword ?? palette.keyword ?? palette.accent;
  }
  if (classes.some((name) => name === "title" || name === "function" || name === "section")) {
    return palette.syntaxFunction ?? palette.accent;
  }
  if (
    classes.some(
      (name) =>
        name === "variable" ||
        name === "params" ||
        name === "attr" ||
        name === "attribute" ||
        name === "property",
    )
  ) {
    return palette.syntaxVariable ?? palette.text ?? palette.accent;
  }
  if (
    classes.some(
      (name) =>
        name === "string" ||
        name === "regexp" ||
        name === "template-tag" ||
        name === "template-variable" ||
        name === "symbol" ||
        name === "bullet" ||
        name === "link",
    )
  ) {
    return palette.syntaxString ?? palette.literal ?? palette.success ?? palette.accent;
  }
  if (classes.some((name) => name === "number" || name === "literal")) {
    return palette.syntaxNumber ?? palette.literal ?? palette.warning ?? palette.accent;
  }
  if (classes.some((name) => name === "built_in" || name === "type" || name === "class")) {
    return palette.syntaxType ?? palette.warning ?? palette.accent;
  }
  if (classes.includes("operator")) return palette.syntaxOperator ?? palette.accent;
  if (classes.some((name) => name === "punctuation" || name === "tag")) {
    return palette.syntaxPunctuation ?? palette.dim;
  }
  if (classes.includes("meta")) return palette.dim;
  return undefined;
}

function ansiLines(html: string, palette: Palette): string[] {
  const lines = [""];
  const colors: Array<Color | undefined> = [];
  const tokens = /<span class="([^"]+)">|<\/span>|([^<]+)/gu;
  let offset = 0;
  for (const match of html.matchAll(tokens)) {
    if (match.index !== offset) throw new Error("Unexpected syntax highlighter output");
    offset += match[0].length;
    if (match[1] !== undefined) {
      const classes = match[1].split(/\s+/u).map((name) => name.replace(/^hljs-/u, ""));
      colors.push(tokenColor(classes, palette) ?? colors.at(-1));
      continue;
    }
    if (match[0] === "</span>") {
      if (colors.length === 0) throw new Error("Unexpected syntax highlighter span");
      colors.pop();
      continue;
    }
    const parts = decodeHtml(match[2] ?? "").split("\n");
    for (const [index, part] of parts.entries()) {
      if (index > 0) lines.push("");
      if (part) lines[lines.length - 1] += (colors.at(-1) ?? ((text) => text))(part);
    }
  }
  if (offset !== html.length || colors.length !== 0) {
    throw new Error("Incomplete syntax highlighter output");
  }
  return lines;
}

/** Highlights a complete code block while preserving multiline grammar state. */
export function highlightCode(
  code: string,
  language: string | undefined,
  palette: Palette,
): string[] {
  const clean = sanitizeTerminalText(code);
  const resolved = languageName(language);
  if (resolved === undefined) return clean.split("\n");
  return ansiLines(
    highlightEngine.highlight(clean, { language: resolved, ignoreIllegals: true }).value,
    palette,
  );
}

/** Highlights one standalone line of code. */
export function highlightLine(
  line: string,
  language: string | undefined,
  palette: Palette,
): string {
  return highlightCode(line, language, palette)[0] ?? "";
}
