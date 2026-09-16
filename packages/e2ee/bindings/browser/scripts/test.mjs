// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const mode of ["production", "test"]) {
  execFileSync(process.execPath, [join(root, "scripts/build.mjs"), mode], { stdio: "inherit" });
}
execFileSync(process.execPath, [join(root, "scripts/check-abi.mjs")], { stdio: "inherit" });
execFileSync(
  "pnpm",
  [
    "exec",
    "tsc",
    "--noEmit",
    "--strict",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "test/types.test.ts",
  ],
  { cwd: root, stdio: "inherit" },
);
execFileSync("pnpm", ["exec", "playwright", "test"], { cwd: root, stdio: "inherit" });
