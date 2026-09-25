// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

// Real-browser pairing evidence for the deployment-test artifact: build the Node test artifact
// (the native daemon and the in-process witness), pin a witness trust into a deployment-test
// build, verify the artifacts, and pair a real browser with the native daemon. Extra arguments are
// passed to Playwright, for example `--project=firefox`.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = resolve(root, "../node");
const nodeArtifact = join(node, "dist/test-artifact/native/axl-e2ee-node.linux-x64-gnu.node");
const scratch = mkdtempSync(join(tmpdir(), "axl-deployment-trust-"));
const trustFile = join(scratch, "replica-trust.bin");
const env = {
  ...process.env,
  AXL_E2EE_NODE_TEST_ARTIFACT: process.env.AXL_E2EE_NODE_TEST_ARTIFACT ?? nodeArtifact,
  AXL_E2EE_DEPLOYMENT_TEST_TRUST_FILE: trustFile,
};
try {
  execFileSync(process.execPath, [join(node, "scripts/build.mjs"), "test"], { stdio: "inherit" });
  // Any well-formed trust builds the artifact; the test server re-pins its own witness.
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { writeFileSync } from "node:fs";
       const fixture = await import(${JSON.stringify(join(node, "test/fixture-loader.mjs"))});
       writeFileSync(${JSON.stringify(trustFile)}, fixture.testWitness().trustConfig);`,
    ],
    { env, stdio: "inherit" },
  );
  for (const mode of ["production", "deployment-test"]) {
    execFileSync(process.execPath, [join(root, "scripts/build.mjs"), mode], { env, stdio: "inherit" });
  }
  execFileSync(process.execPath, [join(root, "scripts/check-abi.mjs")], { stdio: "inherit" });
  execFileSync(
    "pnpm",
    ["exec", "playwright", "test", "-c", "playwright.deployment.config.mjs", ...process.argv.slice(2)],
    { cwd: root, env, stdio: "inherit" },
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
