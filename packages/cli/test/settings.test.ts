// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readSettings, writeSettings } from "../src/index.ts";

test("settings persist global model, thinking, and theme choices", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-settings-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, ".axl", "settings.json");
  const settings = { model: "gpt-5.6-sol", thinking: "xhigh", theme: "dark" } as const;

  await writeSettings(path, settings);

  assert.deepEqual(await readSettings(path), settings);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("settings reject malformed and unknown values", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-settings-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "settings.json");

  assert.deepEqual(await readSettings(path), {});
  await writeFile(path, '{"thinking":"extreme"}\n');
  await assert.rejects(readSettings(path), /thinking must be one of/);
  await writeFile(path, '{"surprise":true}\n');
  await assert.rejects(readSettings(path), /unknown field surprise/);
});
