// SPDX-FileCopyrightText: 2026 PranavD2905
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

// Reads the dorny/paths-filter `filters` block from the CI workflow. The patterns are matched
// with node:path matchesGlob, which agrees with the picomatch rules that paths-filter uses for
// these literal and `**` patterns.
function readFilters(source: string): Map<string, string[]> {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === "filters: |");
  assert.notEqual(start, -1, "ci.yml has no paths-filter filters block");
  const blockIndent = (lines[start + 1] ?? "").search(/\S/);
  const filters = new Map<string, string[]>();
  let group: string[] | undefined;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    if (line.search(/\S/) < blockIndent) break;
    const header = /^\s*([a-z]+):$/.exec(line);
    if (header?.[1] !== undefined) {
      group = [];
      filters.set(header[1], group);
      continue;
    }
    const pattern = /^\s*- '([^']+)'$/.exec(line);
    assert.ok(pattern?.[1] !== undefined && group !== undefined, `unexpected filter line: ${line}`);
    group.push(pattern[1]);
  }
  return filters;
}

const filters = readFilters(workflow);

function classify(files: string[]): string[] {
  return [...filters]
    .filter(([, patterns]) =>
      files.some((file) => patterns.some((pattern) => matchesGlob(file, pattern))),
    )
    .map(([name]) => name)
    .sort();
}

test("classifies documentation-only changes as docs", () => {
  assert.deepEqual(classify(["README.md"]), ["docs"]);
  assert.deepEqual(classify(["docs/architecture/client-boundaries.md"]), ["docs"]);
  assert.deepEqual(classify([".github/ISSUE_TEMPLATE/bug.yml", "CONTRIBUTING.md"]), ["docs"]);
});

test("classifies code changes as code", () => {
  assert.deepEqual(classify(["packages/kernel/src/index.ts"]), ["code"]);
  assert.deepEqual(classify(["pnpm-lock.yaml"]), ["code"]);
  assert.deepEqual(classify(["packages/sdk/README.md"]), ["code"]);
  assert.deepEqual(classify([".github/workflows/ci.yml"]), ["code", "workflows"]);
});

test("classifies mixed changes as code and docs", () => {
  assert.deepEqual(classify(["docs/setup.md", "scripts/check-dco.ts"]), ["code", "docs"]);
});

test("leaves unrelated changes unclassified", () => {
  assert.deepEqual(classify(["REUSE.toml"]), []);
  assert.deepEqual(classify([".github/CODEOWNERS"]), []);
});
