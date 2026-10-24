// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { languageForPath } from "../src/highlight.ts";

test("languageForPath maps exact file names", () => {
  const cases: Array<[string, string | undefined]> = [
    ["Dockerfile", "dockerfile"],
    ["Containerfile", "dockerfile"],
    ["Makefile", "makefile"],
    ["GNUmakefile", "makefile"],
    ["CMakeLists.txt", "cmake"],
    ["Gemfile", "ruby"],
    ["Rakefile", "ruby"],
    ["Vagrantfile", "ruby"],
    [".bashrc", "bash"],
    [".zshrc", "bash"],
    [".bash_profile", "bash"],
    [".profile", "bash"],
  ];
  for (const [path, expected] of cases) {
    assert.equal(languageForPath(path), expected, path);
  }
});

test("languageForPath maps Dockerfile.* and Containerfile.* prefixes", () => {
  assert.equal(languageForPath("Dockerfile.dev"), "dockerfile");
  assert.equal(languageForPath("Dockerfile.prod"), "dockerfile");
  assert.equal(languageForPath("Containerfile.local"), "dockerfile");
});

test("languageForPath maps common extensions", () => {
  assert.equal(languageForPath("src/app.ts"), "typescript");
  assert.equal(languageForPath("main.py"), "python");
  assert.equal(languageForPath("lib.rs"), "rust");
});

test("languageForPath is case-insensitive and accepts Windows paths", () => {
  assert.equal(languageForPath("C:\\repo\\Dockerfile"), "dockerfile");
  assert.equal(languageForPath("C:\\repo\\Containerfile"), "dockerfile");
  assert.equal(languageForPath("packages\\TUI\\App.TS"), "typescript");
});

test("languageForPath returns undefined for unknown names", () => {
  assert.equal(languageForPath("notes"), undefined);
  assert.equal(languageForPath("archive.zzz"), undefined);
});
