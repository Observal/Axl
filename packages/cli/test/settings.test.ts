// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadTuiSettings, readSettings, saveTuiSettings, writeSettings } from "../src/index.ts";

test("preserves the upstream model thinking and theme settings API", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-settings-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "settings.json");
  const settings = { model: "gpt-5.6-sol", thinking: "xhigh", theme: "dark" } as const;

  await writeSettings(path, settings);

  assert.deepEqual(await readSettings(path), settings);
  assert.deepEqual(await loadTuiSettings(path), {
    version: 1,
    modelId: "gpt-5.6-sol",
    thinkingLevel: "xhigh",
    theme: "axl-dark",
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("persists and restores session defaults atomically", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-tui-settings-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "tui.json");
  const settings = {
    version: 1 as const,
    modelId: "gpt-5.6",
    thinkingLevel: "high" as const,
    theme: "ocean",
    webFetch: false,
    webSearch: true,
    toolOutputDisplay: "focus" as const,
    thinkingDisplay: "show" as const,
    tuiMode: "fullscreen" as const,
    fullscreenExitOutput: "transcript" as const,
    fullscreenScrollbar: "always" as const,
    fullscreenMouse: "native" as const,
    attention: "bell" as const,
    editorMode: "vim" as const,
    modelFavorites: ["gpt-5.6", "gpt-4.1"],
    refocusRecap: true,
    developerPanel: true,
    diffLayout: "split" as const,
    workspaceReview: true,
    imageDisplay: "metadata" as const,
  };

  await saveTuiSettings(path, settings);
  assert.deepEqual(await loadTuiSettings(path), settings);
  assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
});

test("uses empty defaults only for a missing file and rejects invalid settings", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-tui-settings-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "tui.json");

  assert.deepEqual(await loadTuiSettings(path), { version: 1 });
  await writeFile(path, '{"version":1,"theme":"missing"}\n');
  await assert.rejects(loadTuiSettings(path), /invalid theme/);
  await writeFile(path, '{"version":1,"surprise":true}\n');
  await assert.rejects(loadTuiSettings(path), /unknown setting surprise/);
  await writeFile(path, '{"version":1,"fullscreenMouse":"maybe"}\n');
  await assert.rejects(loadTuiSettings(path), /invalid fullscreenMouse/);
  await writeFile(path, '{"version":1,"attention":"loud"}\n');
  await assert.rejects(loadTuiSettings(path), /invalid attention/);
  await writeFile(path, '{"version":1,"modelFavorites":["gpt-5","gpt-5"]}\n');
  await assert.rejects(loadTuiSettings(path), /unique non-empty strings/);
  await writeFile(path, '{"version":1,"diffLayout":"stacked"}\n');
  await assert.rejects(loadTuiSettings(path), /invalid diffLayout/);
  await writeFile(path, '{"version":1,"imageDisplay":"huge"}\n');
  await assert.rejects(loadTuiSettings(path), /invalid imageDisplay/);
  await writeFile(path, '{"version":1,"webFetch":"yes"}\n');
  await assert.rejects(loadTuiSettings(path), /webFetch must be a boolean/);
});
