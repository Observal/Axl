// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

for (const workflow of ["ci.yml", "codeql.yml", "gitleaks.yml"]) {
  test(`${workflow} checks every RC push`, () => {
    const source = readFileSync(
      new URL(`../.github/workflows/${workflow}`, import.meta.url),
      "utf8",
    );
    const branches = source.match(/^ {2}push:\r?\n {4}branches: \[([^\]]+)\]/m)?.[1];
    assert.ok(branches, `${workflow} must declare push branches`);
    assert.ok(
      branches.split(",").some((branch) => branch.trim().replace(/^['"]|['"]$/g, "") === "RC"),
      `${workflow} must run on RC pushes`,
    );
  });
}
