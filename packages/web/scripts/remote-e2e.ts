// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

// Phone remote-control failure evidence against a local copy of the hosted stack. This generates a
// witness for the run, builds the Node and browser bindings pinned to it (the hosted WSL Node
// artifact in production mode, the default, or the deployment-test one with
// AXL_REMOTE_E2E_MODE=deployment-test), stages the phone page, makes a throwaway certificate for
// 127.0.0.1, and runs e2e/remote with Playwright. Existing builds (for example ones pinned to the
// AWS stack) are restored after.
//
// Needs the Rust toolchain the E2EE bindings build with, Elixir for the relay, bubblewrap for the
// sandboxed daemon, and openssl. Set AXL_REMOTE_E2E_SKIP_BUILD=1 to reuse the TypeScript build.
// Extra arguments go to Playwright.

import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const web = resolve(import.meta.dirname, "..");
const root = resolve(web, "../..");
const bindings = join(root, "packages/e2ee/bindings");
const mode = process.env.AXL_REMOTE_E2E_MODE ?? "production";
if (mode !== "production" && mode !== "deployment-test") {
  throw new Error("AXL_REMOTE_E2E_MODE must be production or deployment-test");
}
const scratch = mkdtempSync(join(tmpdir(), "axl-remote-e2e-"));
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });

function identifier() {
  for (;;) {
    const value = randomBytes(16);
    if (value.some((byte) => byte !== 0)) return value.toString("hex");
  }
}

const preserved = [];
function preserve(directory) {
  if (!existsSync(directory)) return;
  const saved = `${directory}.before-remote-e2e`;
  rmSync(saved, { recursive: true, force: true });
  renameSync(directory, saved);
  preserved.push([directory, saved]);
}

try {
  if (process.env.AXL_REMOTE_E2E_SKIP_BUILD !== "1") run("pnpm", ["build"]);

  // A witness for this run only; both bindings pin its public keys.
  const replicas = [0, 1, 2].map(() => ({
    replicaId: identifier(),
    keyId: identifier(),
    privateKey: generateKeyPairSync("ed25519")
      .privateKey.export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  }));
  const keys = JSON.stringify({ replicas });
  writeFileSync(join(scratch, "keys.json"), keys, { mode: 0o600 });
  const witness = await import(
    join(root, "services/aws-control-plane/dist/witness-deployment-test.js")
  );
  const trustFile = join(scratch, "replica-trust.bin");
  writeFileSync(
    trustFile,
    witness.encodeReplicaTrustConfig(
      witness.deploymentTestWitnessTrust(witness.parseDeploymentTestWitnessKeys(keys)),
    ),
  );

  const env = {
    ...process.env,
    AXL_E2EE_DEPLOYMENT_TEST_TRUST_FILE: trustFile,
    AXL_E2EE_HOSTED_TRUST_FILE: trustFile,
  };
  const nodeArtifact = mode === "production" ? "hosted-wsl" : "deployment-test";
  preserve(join(bindings, `node/dist/${nodeArtifact}`));
  preserve(join(bindings, "browser/dist/deployment-test"));
  run(process.execPath, [join(bindings, "node/scripts/build.mjs"), nodeArtifact], { env });
  run(process.execPath, [join(bindings, "browser/scripts/build.mjs"), "deployment-test"], { env });
  run("pnpm", ["--filter", "@axl/web", "build:remote"]);

  const page = join(scratch, "page");
  mkdirSync(page);
  cpSync(join(web, "dist/remote/remote.html"), join(page, "index.html"));
  cpSync(join(web, "dist/remote/assets"), join(page, "assets"), { recursive: true });
  cpSync(join(bindings, "browser/dist/deployment-test"), join(page, "e2ee"), { recursive: true });

  mkdirSync(join(scratch, "tls"), { mode: 0o700 });
  run(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      join(scratch, "tls/key.pem"),
      "-out",
      join(scratch, "tls/cert.pem"),
    ],
    { stdio: "ignore" },
  );

  run(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "-c",
      "e2e/remote/playwright.config.ts",
      ...process.argv.slice(2),
    ],
    {
      cwd: web,
      env: { ...process.env, AXL_REMOTE_E2E_DIRECTORY: scratch, AXL_REMOTE_E2E_MODE: mode },
    },
  );
} finally {
  // Next to Playwright's results, so CI keeps them when a run fails.
  if (existsSync(join(scratch, "logs"))) {
    cpSync(join(scratch, "logs"), join(web, "dist/remote-e2e-results/stack-logs"), {
      recursive: true,
    });
  }
  for (const [directory, saved] of preserved.reverse()) {
    rmSync(directory, { recursive: true, force: true });
    renameSync(saved, directory);
  }
  if (process.env.AXL_REMOTE_E2E_KEEP === "1") console.log(`Kept ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
}
