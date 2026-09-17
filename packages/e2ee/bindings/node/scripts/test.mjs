// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../../../..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
for (const workspace of ["@axl/protocol", "@axl/kernel", "@axl/sdk", "@axl/daemon"]) {
  execFileSync(pnpm, ["--filter", workspace, "build"], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
}
execFileSync(process.execPath, [join(packageRoot, "scripts/build.mjs"), "production"], { stdio: "inherit" });
execFileSync(process.execPath, [join(packageRoot, "scripts/build.mjs"), "test"], { stdio: "inherit" });
const target =
  process.platform === "darwin"
    ? `darwin-${process.arch}`
    : process.platform === "win32"
      ? `win32-${process.arch}-msvc`
      : `linux-${process.arch}-gnu`;
const result = spawnSync(process.execPath, ["--test", "test/*.test.mjs", "test/*.test.ts"], {
  cwd: packageRoot,
  env: {
    ...process.env,
    AXL_E2EE_NODE_TEST_ARTIFACT: join(
      packageRoot,
      "dist/test-artifact/native",
      `axl-e2ee-node.${target}.node`,
    ),
  },
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
});
if (/contained test panic|panicked at|bindings\/node\/src\/lib\.rs:\d+/u.test(result.stderr)) {
  throw new Error("caught native panic leaked payload or source location to stderr");
}
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Node binding tests exited with status ${result.status}`);
