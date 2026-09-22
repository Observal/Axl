// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildReleasePackage,
  publicManifest,
  validateReleaseVersion,
} from "./build-release-package.ts";

const template = {
  name: "@observal/axl",
  version: "0.1.0-beta.2",
  description: "Axl",
  repository: { type: "git", url: "git+https://github.com/Observal/Axl.git" },
  bugs: { url: "https://github.com/Observal/Axl/issues" },
  homepage: "https://github.com/Observal/Axl#readme",
  dependencies: { yaml: "2.8.3" },
};

test("creates a public CLI manifest without workspace dependencies", () => {
  const manifest = publicManifest(template);
  assert.equal(manifest.name, "@observal/axl");
  assert.equal(manifest.version, "0.1.0-beta.2");
  assert.deepEqual(manifest.bin, { axl: "dist/axl.js" });
  assert.deepEqual(manifest.exports, {
    "./extension-api": { types: "./dist/extension-api.d.ts" },
  });
  assert.deepEqual(manifest.dependencies, { yaml: "2.8.3" });
  assert.equal("private" in manifest, false);
});

test("accepts only supported release versions", () => {
  for (const version of ["0.1.0", "1.2.3-alpha.1", "1.2.3-beta.4", "1.2.3-rc.2"]) {
    assert.doesNotThrow(() => validateReleaseVersion(version));
  }
  for (const version of ["v1.2.3", "1.2", "1.2.3-next.1", "1.2.3-beta"]) {
    assert.throws(() => validateReleaseVersion(version), /Invalid Axl release version/);
  }
});

test("the release installer is valid POSIX shell", () => {
  const result = spawnSync("sh", ["-n", "scripts/install.sh"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("the release package contains matching verified web assets", () => {
  const result = buildReleasePackage("0.0.0");
  const listing = spawnSync("tar", ["-tzf", result.packagePath], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /^package\/dist\/extension-api\.d\.ts$/m);
  assert.match(listing.stdout, /^package\/dist\/web\/asset-metadata\.json$/m);
  assert.match(listing.stdout, /^package\/dist\/web\/index\.html$/m);
  assert.match(listing.stdout, /^package\/dist\/web\/assets\/index-[\w-]+\.js$/m);

  const metadata = spawnSync(
    "tar",
    ["-xOf", result.packagePath, "package/dist/web/asset-metadata.json"],
    { encoding: "utf8" },
  );
  assert.equal(metadata.status, 0, metadata.stderr);
  assert.equal(JSON.parse(metadata.stdout).packageVersion, "0.0.0");

  assert.match(
    readFileSync(".release/npm/dist/axl.js", "utf8"),
    /createRequire\(import\.meta\.url\)/,
  );
  assert.match(
    readFileSync(".release/npm/dist/extension-api.d.ts", "utf8"),
    /export interface DaemonExtensionApi/,
  );
});
