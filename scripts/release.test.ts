// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  compareVersions,
  nextVersion,
  npmTagFor,
  parseSeries,
  parseVersion,
  renderReleaseNotes,
} from "./release.ts";

test("parses and orders stable and prerelease versions", () => {
  assert.deepEqual(parseVersion("1.2.3-beta.4"), {
    major: 1,
    minor: 2,
    patch: 3,
    channel: "beta",
    serial: 4,
  });
  assert.equal(compareVersions(parseVersion("1.2.3-rc.1"), parseVersion("1.2.3-beta.9")) > 0, true);
  assert.equal(compareVersions(parseVersion("1.2.3"), parseVersion("1.2.3-rc.9")) > 0, true);
  assert.throws(() => parseVersion("v1.2.3"), /Invalid release version/);
  assert.throws(() => parseSeries("1.2.3"), /Invalid release series/);
});

test("advances release channels without moving backward", () => {
  assert.equal(nextVersion("0.2", "alpha", []), "0.2.0-alpha.1");
  assert.equal(nextVersion("0.2", "alpha", ["v0.2.0-alpha.1"]), "0.2.0-alpha.2");
  assert.equal(nextVersion("0.2", "beta", ["v0.2.0-alpha.2"]), "0.2.0-beta.1");
  assert.equal(nextVersion("0.2", "rc", ["v0.2.0-beta.3"]), "0.2.0-rc.1");
  assert.equal(nextVersion("0.2", "stable", ["v0.2.0-rc.2"]), "0.2.0");
  assert.equal(nextVersion("0.2", "stable", ["v0.2.0"]), "0.2.1");
  assert.equal(nextVersion("0.2", "alpha", ["v0.2.0", "v0.2.1-alpha.1"]), "0.2.1-alpha.2");
  assert.throws(
    () => nextVersion("0.2", "alpha", ["v0.2.0-beta.1"]),
    /Cannot move release.*backward/,
  );
});

test("maps channels to npm tags without downgrading latest", () => {
  assert.equal(npmTagFor("0.3.0-alpha.1", "alpha", []), "alpha");
  assert.equal(npmTagFor("0.3.0-beta.1", "beta", []), "beta");
  assert.equal(npmTagFor("0.3.0-rc.1", "rc", []), "next");
  assert.equal(npmTagFor("0.3.0", "stable", ["v0.2.4"]), "latest");
  assert.equal(npmTagFor("0.2.5", "stable", ["v0.3.0"]), "lts-0.2");
});

test("renders categorized release notes with install and comparison details", () => {
  const notes = renderReleaseNotes({
    repo: "Observal/Axl",
    version: "0.2.0-beta.1",
    channel: "beta",
    previousTag: "v0.2.0-alpha.1",
    cutoff: "0123456789abcdef0123456789abcdef01234567",
    changes: [
      {
        commits: ["abcdef0123456789"],
        title: "feat(cli): add release channels",
        category: "Features",
        pr: 8,
        url: "https://github.com/Observal/Axl/pull/8",
        contributor: "@contributor",
      },
    ],
  });
  assert.match(notes, /## Features/);
  assert.match(notes, /@observal\/axl@0\.2\.0-beta\.1/);
  assert.match(notes, /v0\.2\.0-alpha\.1\.\.\.v0\.2\.0-beta\.1/);
  assert.match(notes, /@contributor/);
});
