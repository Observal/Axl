// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ToolRegistry } from "@axl/kernel";

import {
  DAEMON_EXTENSION_AUTHORITY,
  DaemonExtensionRegistry,
  loadDaemonExtensions,
} from "../src/index.ts";

async function module(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    'export default (axl) => axl.registerTool({ name: "shared_tool", description: "shared", inputSchema: { type: "object" }, execute: () => ({ content: [] }) });\n',
  );
}

test("resolves global, explicit, and trusted project extensions with deterministic precedence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-extension-registry-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  await module(join(home, "extensions", "shared.js"));
  const explicit = join(root, "explicit", "shared.js");
  await module(explicit);
  await module(join(project, ".axl", "extensions", "shared.js"));
  const registry = new DaemonExtensionRegistry(home);

  await registry.install({ type: "path", path: explicit });
  assert.equal((await registry.list(project)).extensions[0]?.source, "explicit");
  await registry.trustProject(project, true);
  assert.equal((await registry.list(project)).extensions[0]?.source, "project");

  await registry.setEnabled("shared", false);
  assert.deepEqual(await registry.entries(project), []);
  const disabled = (await registry.list(project)).extensions[0];
  assert.equal(disabled?.enabled, false);
  assert.equal((await stat(registry.configPath)).mode & 0o777, 0o600);

  await registry.trustProject(project, false);
  await rm(explicit);
  await registry.setEnabled("shared", true);
  assert.equal((await registry.list(project)).extensions[0]?.source, "global");
  await registry.remove("shared");
  assert.equal((await registry.list(project)).extensions[0]?.source, "global");
});

test("TUI-only packages require trust, remain disabled before import, and resolve inside their root", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-terminal-registry-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  const directory = join(project, ".axl", "extensions", "terminal");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "terminal",
      axl: {
        id: "terminal",
        apiVersion: 1,
        tui: "./view.mjs",
      },
    }),
  );
  await writeFile(
    join(directory, "view.mjs"),
    "throw new Error('should not import during discovery');\n",
  );
  const registry = new DaemonExtensionRegistry(home);
  assert.deepEqual((await registry.list(project)).extensions, []);
  await registry.trustProject(project, true);
  const listed = (await registry.list(project)).extensions[0];
  assert.equal(listed?.tuiPath, join(directory, "view.mjs"));
  assert.deepEqual(await registry.entries(project), []);
  await registry.setEnabled("terminal", false);
  assert.equal((await registry.list(project)).extensions[0]?.enabled, false);
  await registry.setEnabled("terminal", true);
  await registry.trustProject(project, false);
  assert.equal(await registry.install({ type: "path", path: directory }), "terminal");
  assert.equal((await registry.list(project)).extensions[0]?.source, "explicit");
  assert.deepEqual(await registry.entries(project), []);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "terminal",
      axl: {
        id: "terminal",
        apiVersion: 1,
        tui: "../../../outside.mjs",
      },
    }),
  );
  await assert.rejects(registry.list(project), /must be inside the package/);
});

test("trusted projects reject extension symlinks outside the project", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-terminal-trust-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const home = join(root, "home");
  await mkdir(join(project, ".git"), { recursive: true });
  const directory = join(project, ".axl", "extensions");
  await mkdir(directory, { recursive: true });
  await writeFile(join(root, "outside.js"), "throw new Error('escaped');\n");
  await symlink(join(root, "outside.js"), join(directory, "outside.js"));
  const registry = new DaemonExtensionRegistry(home);
  await registry.trustProject(project, true);
  await assert.rejects(registry.list(project), /symlink escapes the trusted directory/);
});

test("installs Git extensions from an explicit commit spec", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-extension-git-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const commit = "a".repeat(40);
  let installedSpec = "";
  const registry = new DaemonExtensionRegistry(home, async (_file, arguments_) => {
    installedSpec = arguments_.at(-1) ?? "";
    const packageRoot = join(home, "extensions", ".packages");
    const packageDirectory = join(packageRoot, "node_modules", "git-extension");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ dependencies: { "git-extension": installedSpec } }),
    );
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({
        name: "git-extension",
        version: "1.0.0",
        axl: { id: "git-extension", apiVersion: 1, daemon: "index.js" },
      }),
    );
    await writeFile(join(packageDirectory, "index.js"), "export default () => {};\n");
  });
  assert.equal(
    await registry.install({ type: "git", url: "https://example.com/extension.git", ref: commit }),
    "git-extension",
  );
  assert.equal(installedSpec, `git+https://example.com/extension.git#${commit}`);
});

test("installs, updates, loads, and removes package extensions", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-extension-package-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const calls: string[][] = [];
  const run = async (_file: string, arguments_: readonly string[]) => {
    calls.push([...arguments_]);
    const packageRoot = join(home, "extensions", ".packages");
    const packageDirectory = join(packageRoot, "node_modules", "@fixture", "extension");
    if (arguments_[0] === "uninstall") {
      await rm(packageDirectory, { recursive: true, force: true });
      return { stdout: "", stderr: "" };
    }
    await mkdir(join(packageDirectory, "node_modules", "extension-dependency"), {
      recursive: true,
    });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ dependencies: { "@fixture/extension": "1.0.0" } }),
    );
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({
        name: "@fixture/extension",
        version: "1.0.0",
        axl: { id: "fixture", apiVersion: 1, daemon: "index.js" },
      }),
    );
    await writeFile(
      join(packageDirectory, "node_modules", "extension-dependency", "package.json"),
      JSON.stringify({
        name: "extension-dependency",
        version: "1.0.0",
        type: "module",
        exports: "./index.js",
      }),
    );
    await writeFile(
      join(packageDirectory, "node_modules", "extension-dependency", "index.js"),
      `export const name = "package_tool";\n`,
    );
    await writeFile(
      join(packageDirectory, "index.js"),
      `import { name } from "extension-dependency"; export default (axl) => axl.registerTool({ name, description: name, inputSchema: { type: "object" }, execute: () => ({ content: [] }) });\n`,
    );
    return { stdout: "", stderr: "" };
  };
  const registry = new DaemonExtensionRegistry(home, run);
  assert.equal(
    await registry.install({ type: "npm", spec: "@fixture/extension@1.0.0" }),
    "fixture",
  );
  const entries = await registry.entries(root);
  assert.equal(entries[0]?.source, "package");
  const loaded = await loadDaemonExtensions({
    directory: registry.globalDirectory,
    extensions: entries,
    cwd: root,
    tools: new ToolRegistry(),
    grantedAuthorities: new Set([DAEMON_EXTENSION_AUTHORITY]),
    onFailure: () => undefined,
  });
  assert.deepEqual(loaded.extensions[0]?.tools, ["package_tool"]);
  await loaded.host.dispose();
  await registry.update("fixture");
  await registry.remove("fixture");
  assert.equal((await registry.list(root)).extensions.length, 0);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["install", "install", "uninstall"],
  );
  assert.match(await readFile(registry.configPath, "utf8"), /"packages": \[\]/u);
});
