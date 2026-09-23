// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TerminalExtensionHost } from "@axl/extension-api";
import type { ExtensionListResult } from "@axl/protocol";

import { loadTerminalExtensions } from "../src/extension-loader.ts";

const list = (path: string, enabled = true): ExtensionListResult => ({
  configPath: "/local/extensions.json",
  project: { root: "/local", trusted: true },
  commands: [],
  extensions: [{ id: "fixture", path, tuiPath: path, source: "project", enabled }],
});

test("terminal entry loads changed source and rolls registrations back on failure", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-tui-loader-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "view.mjs");
  const marker = join(root, "cleanup");
  const source = (value: string) => `import { appendFileSync } from "node:fs";
export default {
 manifest: { id: "fixture", name: "Fixture", capabilities: ["terminal.commands"] },
 activate(api) {
  api.registerCommand({ name: "hello", description: "hello", run: (arg, ctx) => ctx.notify(${JSON.stringify(value)}) });
  return () => appendFileSync(${JSON.stringify(marker)}, "done\\n");
 }
};\n`;
  await writeFile(path, source("first"));
  const first = new TerminalExtensionHost(await loadTerminalExtensions(list(path)));
  await first.activate();
  assert.equal(first.commands().length, 1);
  await first.dispose();
  assert.equal(await readFile(marker, "utf8"), "done\n");
  await writeFile(path, source("second"));
  const second = new TerminalExtensionHost(await loadTerminalExtensions(list(path)));
  await second.activate();
  const messages: string[] = [];
  await second.commands()[0]?.run("", {
    signal: new AbortController().signal,
    notify: (message) => messages.push(message),
    select: async () => undefined,
    confirm: async () => {
      throw new Error("Unexpected confirmation");
    },
    input: async () => {
      throw new Error("Unexpected input prompt");
    },
    editor: async () => {
      throw new Error("Unexpected editor prompt");
    },
    getEditorText: () => "",
    setEditorText: () => undefined,
  });
  assert.deepEqual(messages, ["second"]);
  await second.dispose();
  assert.equal(await readFile(marker, "utf8"), "done\ndone\n");
});

test("disabled terminal entries never import, and mismatched identities fail visibly", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-tui-loader-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "view.mjs");
  await writeFile(path, "throw new Error('untrusted side effect');\n");
  assert.deepEqual(await loadTerminalExtensions(list(path, false)), []);
  await assert.rejects(loadTerminalExtensions(list(path)), /failed to import/);
  await writeFile(path, "export default { manifest: { id: 'wrong' }, activate() {} };\n");
  await assert.rejects(loadTerminalExtensions(list(path)), /matching manifest id/);
});
