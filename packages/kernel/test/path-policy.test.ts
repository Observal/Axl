// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  assertReadAllowed,
  assertWriteAllowed,
  canonicalizeForPolicy,
  makeEditTool,
  makeReadTool,
  SandboxViolationError,
  type WorkspacePolicy,
} from "../src/index.ts";

async function makeLayout(context: TestContext): Promise<{
  root: string;
  workspace: string;
  outside: string;
  axlHome: string;
  policy: WorkspacePolicy;
}> {
  const root = await mkdtemp(join(tmpdir(), "axl-policy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const axlHome = join(root, "axl-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(axlHome, { recursive: true });
  await writeFile(join(outside, "victim.txt"), "outside data\n");
  await writeFile(join(axlHome, "credentials.json"), '{"secret":true}\n');
  await writeFile(join(workspace, "inside.txt"), "inside\n");
  return {
    root,
    workspace,
    outside,
    axlHome,
    policy: { workspace, readableRoots: [workspace], protectedPaths: [axlHome] },
  };
}

test("canonicalization resolves symlinks and survives missing tails", async (context) => {
  const { workspace, outside } = await makeLayout(context);
  await symlink(outside, join(workspace, "escape"));

  const throughLink = await canonicalizeForPolicy(join(workspace, "escape", "victim.txt"));
  assert.equal(throughLink, join(outside, "victim.txt"));

  const missingTail = await canonicalizeForPolicy(join(workspace, "not", "yet", "there.txt"));
  assert.equal(missingTail.endsWith(join("workspace", "not", "yet", "there.txt")), true);
});

test("writes outside the workspace and symlink escapes are rejected", async (context) => {
  const { workspace, outside, policy } = await makeLayout(context);
  await symlink(join(outside, "victim.txt"), join(workspace, "sneaky.txt"));

  await assert.rejects(
    assertWriteAllowed(policy, join(outside, "victim.txt")),
    (error) => error instanceof SandboxViolationError && error.capability === "filesystem.write",
  );
  // The symlink lives inside the workspace but its target does not.
  await assert.rejects(
    assertWriteAllowed(policy, join(workspace, "sneaky.txt")),
    SandboxViolationError,
  );
  assert.equal(
    await assertWriteAllowed(policy, join(workspace, "inside.txt")),
    join(workspace, "inside.txt"),
  );
});

test("reads require an explicit root and protected paths still win", async (context) => {
  const { workspace, axlHome, outside, policy } = await makeLayout(context);
  await assert.rejects(
    assertReadAllowed(policy, join(axlHome, "credentials.json")),
    (error) => error instanceof SandboxViolationError && error.capability === "filesystem.read",
  );
  await assert.rejects(
    assertReadAllowed(policy, join(outside, "victim.txt")),
    (error) => error instanceof SandboxViolationError && error.capability === "filesystem.read",
  );
  assert.equal(
    await assertReadAllowed(policy, join(workspace, "inside.txt")),
    join(workspace, "inside.txt"),
  );
});

test("an explicitly readable root remains read-only", async (context) => {
  const { workspace, outside, axlHome } = await makeLayout(context);
  const policy: WorkspacePolicy = {
    workspace,
    readableRoots: [workspace, outside],
    protectedPaths: [axlHome],
  };
  assert.equal(
    await assertReadAllowed(policy, join(outside, "victim.txt")),
    join(outside, "victim.txt"),
  );
  await assert.rejects(
    assertWriteAllowed(policy, join(outside, "victim.txt")),
    (error) => error instanceof SandboxViolationError && error.capability === "filesystem.write",
  );
});

test("read and edit tools enforce the policy before touching the filesystem", async (context) => {
  const { workspace, outside, axlHome, policy } = await makeLayout(context);
  const read = makeReadTool({ cwd: workspace, policy });
  const edit = makeEditTool({ cwd: workspace, policy });
  const signal = new AbortController().signal;

  await assert.rejects(
    read.execute({ path: join(axlHome, "credentials.json") }, signal),
    SandboxViolationError,
  );
  await assert.rejects(
    read.execute({ path: join(outside, "victim.txt") }, signal),
    SandboxViolationError,
  );
  await assert.rejects(
    edit.execute(
      { path: join(outside, "victim.txt"), oldText: "outside", newText: "changed" },
      signal,
    ),
    SandboxViolationError,
  );
  // The victim file is untouched and in-workspace work still flows.
  const okRead = await read.execute({ path: "inside.txt" }, signal);
  assert.equal(okRead.isError, false);
  const okEdit = await edit.execute(
    { path: "inside.txt", oldText: "inside", newText: "edited" },
    signal,
  );
  assert.equal(okEdit.isError, false);
});
