// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  buildSeccompFilter,
  ensureSeccompFilterFile,
  SECCOMP_POLICY_VERSION,
} from "../src/index.ts";

test("builds a deterministic versioned seccomp filter", () => {
  const first = buildSeccompFilter("x64");
  const second = buildSeccompFilter("x64");
  assert.equal(first.equals(second), true);
  assert.equal(first.byteLength > 8, true);
  assert.equal(first.byteLength % 8, 0);
  assert.equal(SECCOMP_POLICY_VERSION, "axl-linux-deny-v1");
  assert.throws(() => buildSeccompFilter("ia32"), /No .* seccomp policy/);
});

test("writes the filter to a private deterministic path", async () => {
  const path = ensureSeccompFilterFile("x64");
  const metadata = await stat(path);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal((await readFile(path)).equals(buildSeccompFilter("x64")), true);
});

test("atomically replaces a profile symlink without touching its target", async (context: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "axl-seccomp-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "private");
  await mkdir(directory, { mode: 0o700 });
  const victim = join(root, "victim");
  await writeFile(victim, "unchanged");
  const profile = join(directory, `${SECCOMP_POLICY_VERSION}-x64.bpf`);
  await symlink(victim, profile);
  assert.equal(ensureSeccompFilterFile("x64", directory), profile);
  assert.equal((await readFile(profile)).equals(buildSeccompFilter("x64")), true);
  assert.equal(await readFile(victim, "utf8"), "unchanged");
});
