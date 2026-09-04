// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadThemeCatalog, watchThemeDirectories } from "../src/custom-themes.ts";

function source(id: string, accent: string, label = id): string {
  return `${JSON.stringify(
    {
      version: 1,
      id,
      label,
      appearance: "dark",
      inherits: "axl-dark",
      foregrounds: { accent, syntaxKeyword: 201 },
      backgrounds: { toolBackground: "#101820" },
      pairs: { selection: { foreground: "#ffffff", background: "#663399" } },
      thinking: { high: "#ff00aa" },
    },
    null,
    2,
  )}\n`;
}

async function put(directory: string, id: string, contents: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.json`), contents);
}

async function until(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

test("loads bounded user themes with project overrides and inherited roles", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-themes-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const globalDirectory = join(root, "global");
  const cwd = join(root, "workspace");
  await put(globalDirectory, "violet", source("violet", "#112233", "Global Violet"));
  await put(join(cwd, ".axl", "themes"), "violet", source("violet", "#abcdef", "Project Violet"));

  const catalog = await loadThemeCatalog({ cwd, globalDirectory });
  const definition = catalog.definitions.find((theme) => theme.id === "violet");
  const palette = catalog.palettes.violet;
  assert.equal(definition?.label, "Project Violet");
  assert.equal(definition?.origin, "project");
  assert.ok(palette);
  assert.match(palette.accent("x"), /38;2;171;205;239m/);
  assert.match(palette.syntaxKeyword?.("x") ?? "", /38;5;201m/);
  assert.match(palette.toolBackground?.("x") ?? "", /48;2;16;24;32m/);
  assert.match(palette.selection?.("x") ?? "", /38;2;255;255;255;48;2;102;51;153m/);
  assert.match(palette.thinking?.("high", "x") ?? "", /38;2;255;0;170m/);
  assert.equal(typeof palette.error("x"), "string");
});

test("rejects invalid roles, built-in replacement, and symlink escapes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-themes-invalid-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  const themes = join(cwd, ".axl", "themes");
  await put(
    themes,
    "invalid",
    JSON.stringify({
      version: 1,
      id: "invalid",
      label: "Invalid",
      appearance: "dark",
      inherits: "axl-dark",
      foregrounds: { surprise: "#ffffff" },
    }),
  );
  await assert.rejects(loadThemeCatalog({ cwd }), /is not a color role/);

  await rm(join(themes, "invalid.json"));
  await put(themes, "axl-dark", source("axl-dark", "#ffffff"));
  await assert.rejects(loadThemeCatalog({ cwd }), /cannot replace built-in theme/);

  await rm(join(themes, "axl-dark.json"));
  const outside = join(root, "outside.json");
  await writeFile(outside, source("escape", "#ffffff"));
  await symlink(outside, join(themes, "escape.json"));
  await assert.rejects(loadThemeCatalog({ cwd }), /escapes its discovery root/);
});

test("watches existing user theme directories", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-themes-watch-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const globalDirectory = join(root, "themes");
  await put(globalDirectory, "violet", source("violet", "#112233"));
  let changes = 0;
  const stop = await watchThemeDirectories({ cwd: root, globalDirectory }, (error) => {
    assert.equal(error, undefined);
    changes += 1;
  });
  context.after(stop);

  await writeFile(join(globalDirectory, "violet.json"), source("violet", "#abcdef"));
  await until(() => changes > 0, "theme watcher");
  const catalog = await loadThemeCatalog({ cwd: root, globalDirectory });
  assert.match(catalog.palettes.violet?.accent("x") ?? "", /38;2;171;205;239m/);
});
