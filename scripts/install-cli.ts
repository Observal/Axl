// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(repoRoot, "packages", "cli", "dist", "main.js");
const binDirectory = join(homedir(), ".local", "bin");
const link = join(binDirectory, "axl");

chmodSync(target, 0o755);
mkdirSync(binDirectory, { recursive: true });
try {
  const existing = lstatSync(link);
  if (!existing.isSymbolicLink()) throw new Error(`Refusing to replace non-symlink ${link}`);
  unlinkSync(link);
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
symlinkSync(target, link);
console.log(`Installed: ${link} -> ${target}`);

if (!(process.env.PATH ?? "").split(delimiter).includes(binDirectory)) {
  console.log(`Note: add ${binDirectory} to your PATH to run \`axl\` directly.`);
}
