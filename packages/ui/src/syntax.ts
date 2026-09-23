// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import hljs from "highlight.js/lib/common";

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  cjs: "javascript",
  cts: "typescript",
  htm: "xml",
  html: "xml",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  mts: "typescript",
  sh: "bash",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
};

export function languageForPath(path: string | undefined): string | undefined {
  const name = path?.split(/[\\/]/u).at(-1)?.toLocaleLowerCase() ?? "";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  const language = LANGUAGE_ALIASES[extension] ?? extension;
  return language && hljs.getLanguage(language) !== undefined ? language : undefined;
}

// Highlighting a line is pure in (text, language). Streaming re-renders the
// whole transcript, so without a cache every visible code line is re-highlighted
// on each token. The cache is bounded and cleared wholesale when it grows large.
const HIGHLIGHT_CACHE_LIMIT = 5000;
const highlightCache = new Map<string, string>();

export function highlightLine(text: string, language: string | undefined): string {
  const key = `${language ?? ""}\u0000${text}`;
  const cached = highlightCache.get(key);
  if (cached !== undefined) return cached;
  const value =
    language === undefined
      ? text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      : hljs.highlight(text, { language, ignoreIllegals: true }).value;
  if (highlightCache.size >= HIGHLIGHT_CACHE_LIMIT) highlightCache.clear();
  highlightCache.set(key, value);
  return value;
}
