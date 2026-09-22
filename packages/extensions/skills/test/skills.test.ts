// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  discoverSkills,
  loadSkill,
  SkillCapabilityService,
  SkillValidationError,
} from "../src/index.ts";

async function fixture(name: string, source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "axl-skill-"));
  const directory = join(root, name);
  await mkdir(directory);
  await writeFile(join(directory, "SKILL.md"), source);
  return directory;
}

async function writeSkill(root: string, name: string, description: string, body = "Use it.\n") {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
  );
}

test("loads complete Agent Skills frontmatter only during activation", async (context) => {
  const directory = await fixture(
    "release-check",
    `---
name: release-check
description: >-
  Verify a release before publishing. Use for release checks.
license: Apache-2.0
compatibility: Requires git and Node.js
metadata:
  author: example
  version: "1.0"
allowed-tools: Bash(git:*) Read
---
# Release check

Follow [details](references/details.md).
`,
  );
  context.after(() => rm(join(directory, ".."), { recursive: true, force: true }));
  const skill = await loadSkill(directory);
  assert.equal(skill.name, "release-check");
  assert.equal(skill.metadata.version, "1.0");
  assert.equal(skill.allowedTools, "Bash(git:*) Read");
  assert.match(skill.instructions, /Release check/);
});

test("frontmatter discovery tolerates a UTF-8 character split at the probe boundary", async (context) => {
  const prefix = "---\nname: boundary\ndescription: boundary\n---\n";
  const source = `${prefix}${"a".repeat(65_535 - Buffer.byteLength(prefix))}😀\n`;
  const directory = await fixture("boundary", source);
  context.after(() => rm(join(directory, ".."), { recursive: true, force: true }));
  assert.equal(
    (
      await discoverSkills({
        cwd: join(directory, ".."),
        globalDirectories: [join(directory, "..")],
      })
    )[0]?.record.name,
    "boundary",
  );
});

test("rejects invalid names and directory mismatches", async (context) => {
  const directory = await fixture("wrong-directory", "---\nname: Bad_Name\ndescription: no\n---\n");
  context.after(() => rm(join(directory, ".."), { recursive: true, force: true }));
  await assert.rejects(loadSkill(directory), SkillValidationError);
});

test("discovers both global roots and broad-to-nearest project overrides", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-skills-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const globalAxl = join(root, "home", ".axl", "skills");
  const globalAgents = join(root, "home", ".agents", "skills");
  const repository = join(root, "repo");
  const cwd = join(repository, "packages", "app");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeSkill(globalAxl, "release", "global axl");
  await writeSkill(globalAgents, "review", "global agents");
  await writeSkill(join(repository, ".agents", "skills"), "release", "repository");
  await writeSkill(join(repository, "packages", ".axl", "skills"), "release", "package");
  await writeSkill(join(cwd, ".agents", "skills"), "release", "nearest", "Nearest body.\n");

  const skills = await discoverSkills({ cwd, globalDirectories: [globalAxl, globalAgents] });
  assert.deepEqual(
    skills.map((skill) => [skill.record.identity, skill.record.description, skill.record.scope]),
    [
      ["skill:release", "nearest", "project"],
      ["skill:review", "global agents", "global"],
    ],
  );

  const service = new SkillCapabilityService(skills, {
    grantedAuthorities: new Set(["skills.activate"]),
  });
  assert.equal((await service.search("release", 5)).results[0]?.identity, "skill:release");
  const result = await service.activate(["skill:release"]);
  assert.match(result.activated[0]?.content ?? "", /Nearest body/);
});

test("filters untrusted Skills before search and rechecks authorization on activation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-skills-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  await writeSkill(join(cwd, ".axl", "skills"), "release", "Publish a release");

  const untrusted = await discoverSkills({ cwd, trust: () => "untrusted" });
  const filtered = new SkillCapabilityService(untrusted, {
    grantedAuthorities: new Set(["skills.activate"]),
  });
  assert.deepEqual((await filtered.search("release", 5)).results, []);

  const trusted = await discoverSkills({ cwd });
  let denied = false;
  const service = new SkillCapabilityService(trusted, {
    grantedAuthorities: new Set(["skills.activate"]),
    authorize: () => (denied ? "project policy changed" : undefined),
  });
  denied = true;
  assert.deepEqual(await service.activate(["skill:release"]), {
    activated: [],
    denied: [{ identity: "skill:release", reason: "project policy changed" }],
  });
});

test("rejects Skill and optional-directory symlink escapes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-skills-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const outside = join(root, "outside");
  await mkdir(join(project, ".axl", "skills"), { recursive: true });
  await mkdir(outside);
  await writeSkill(outside, "escape", "escaped");
  await symlink(join(outside, "escape"), join(project, ".axl", "skills", "escape"));
  await assert.rejects(discoverSkills({ cwd: project }), /escapes its discovery root/);

  await rm(join(project, ".axl", "skills", "escape"));
  await writeSkill(join(project, ".axl", "skills"), "safe", "safe");
  await symlink(outside, join(project, ".axl", "skills", "safe", "references"));
  await assert.rejects(discoverSkills({ cwd: project }), /escapes the skill directory/);
});

test("rejects invalid UTF-8 during metadata discovery", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-skills-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const directory = join(project, ".agents", "skills", "invalid");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), Buffer.from([0xff]));
  await assert.rejects(discoverSkills({ cwd: project }), /valid UTF-8/);
});
