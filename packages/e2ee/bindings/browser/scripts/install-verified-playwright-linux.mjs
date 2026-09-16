// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const artifacts = Object.freeze({
  firefox: {
    revision: "1543",
    archive: "firefox-ubuntu-24.04.zip",
    sha256: "b0905e84427cc162b9a6e4392be14e5e54e0ade911c83639962c8078b273565e",
  },
  webkit: {
    revision: "2359",
    archive: "webkit-ubuntu-24.04.zip",
    sha256: "8c129d989a1c48d826ca11b45acbba919039de811623dc3819ccbd95b69eeb62",
  },
});

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("Verified Playwright artifacts are pinned only for Linux x64");
}
const name = process.argv[2];
const artifact = artifacts[name];
if (!artifact) throw new Error("Usage: install-verified-playwright-linux.mjs <firefox|webkit>");
const cache = process.env.PLAYWRIGHT_BROWSERS_PATH;
if (!cache) throw new Error("PLAYWRIGHT_BROWSERS_PATH must be set explicitly");

const temporary = mkdtempSync(join(tmpdir(), "axl-playwright-"));
const archivePath = join(temporary, artifact.archive);
const url = `https://cdn.playwright.dev/dbazure/download/playwright/builds/${name}/${artifact.revision}/${artifact.archive}`;
const destination = resolve(cache, `${name}-${artifact.revision}`);
try {
  execFileSync("curl", ["--fail", "--location", "--silent", "--show-error", "--output", archivePath, url], {
    stdio: "inherit",
  });
  const actual = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (actual !== artifact.sha256) {
    throw new Error(`${name} archive SHA-256 mismatch: expected ${artifact.sha256}, received ${actual}`);
  }
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  execFileSync("unzip", ["-q", archivePath, "-d", destination], { stdio: "inherit" });
  writeFileSync(join(destination, "INSTALLATION_COMPLETE"), "");
  console.log(`Installed verified Playwright ${name} revision ${artifact.revision}: ${actual}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
