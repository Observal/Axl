// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { highlightLine, languageForPath } from "../src/syntax.ts";

test("highlights known source paths and safely escapes unknown text", () => {
  const language = languageForPath("packages/web/src/app.tsx");
  assert.equal(language, "typescript");
  assert.match(highlightLine('const answer = "yes";', language), /hljs-keyword/);
  assert.equal(highlightLine("<script>&", undefined), "&lt;script&gt;&amp;");
});

test("cached highlighting is stable across repeats and does not mix languages", () => {
  const line = "const answer = 1;";
  const first = highlightLine(line, "typescript");
  assert.equal(highlightLine(line, "typescript"), first);
  // Same text, different language must not return the other language's cache.
  assert.notEqual(highlightLine(line, "bash"), first);
  // Same text with no language escapes rather than highlights.
  assert.equal(highlightLine("a < b & c", undefined), "a &lt; b &amp; c");
  assert.equal(highlightLine("a < b & c", undefined), "a &lt; b &amp; c");
});
