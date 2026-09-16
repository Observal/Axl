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
  makeSkillTool,
  SkillValidationError,
  skillCatalogSection,
} from "../src/index.ts";

async function fixture(name: string, source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "axl-skill-"));
  const directory = join(root, name);
  await mkdir(directory);
  await writeFile(join(directory, "SKILL.md"), source);
  return directory;
}

test("loads complete Agent Skills frontmatter", async (context) => {
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

test("manual-only Pi skills are never model visible or model invocable", async (context) => {
  const directory = await fixture(
    "manual-review",
    "---\nname: manual-review\ndescription: User-only review\ndisable-model-invocation: true\n---\nManual instructions.\n",
  );
  context.after(() => rm(join(directory, ".."), { recursive: true, force: true }));
  const skill = await loadSkill(directory);
  assert.equal(skill.manualOnly, true);
  assert.equal(skillCatalogSection([skill]), undefined);
  await assert.rejects(
    makeSkillTool([skill]).execute(
      { action: "load", name: "manual-review" },
      new AbortController().signal,
    ),
    /unknown skill/u,
  );
});

test("loads a validated immutable skill under a content-addressed directory", async (context) => {
  const directory = await fixture(
    "content-addressed-directory",
    "---\nname: review-code\ndescription: Review code\n---\nReview it.\n",
  );
  context.after(() => rm(join(directory, ".."), { recursive: true, force: true }));
  const skill = await loadSkill(directory, { expectedName: "review-code" });
  assert.equal(skill.name, "review-code");
  await assert.rejects(loadSkill(directory), /must match the parent directory name/u);
});

test("rejects invalid names and directory mismatches", async (context) => {
  const directory = await fixture("wrong-directory", "---\nname: Bad_Name\ndescription: no\n---\n");
  context.after(() => rm(join(directory, ".."), { recursive: true, force: true }));
  await assert.rejects(loadSkill(directory), SkillValidationError);
});

test("project skills override global skills and resources cannot escape", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-skills-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const global = join(root, "global");
  const project = join(root, "project");
  for (const [base, description] of [
    [global, "global instructions"],
    [join(project, ".axl", "skills"), "project instructions"],
  ] as const) {
    const directory = join(base, "review");
    await mkdir(join(directory, "references"), { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      `---\nname: review\ndescription: ${description}\n---\nDo the review.\n`,
    );
    await writeFile(join(directory, "references", "guide.md"), "guide");
  }
  const outside = join(root, "outside.txt");
  await writeFile(outside, "outside");
  await symlink(outside, join(project, ".axl", "skills", "review", "references", "escape.md"));

  const skills = await discoverSkills({ cwd: project, globalDirectory: global });
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.description, "project instructions");
  const tool = makeSkillTool(skills);
  const loaded = await tool.execute(
    { action: "load", name: "review" },
    new AbortController().signal,
  );
  assert.match(loaded.content[0]?.type === "text" ? loaded.content[0].text : "", /Do the review/);
  const resource = await tool.execute(
    { action: "read", name: "review", path: "references/guide.md" },
    new AbortController().signal,
  );
  assert.equal(resource.content[0]?.type === "text" && resource.content[0].text, "guide");
  await assert.rejects(
    tool.execute(
      { action: "read", name: "review", path: "references/escape.md" },
      new AbortController().signal,
    ),
    /escapes the skill directory/,
  );
});

test("discovery rejects skill-directory symlink escapes and invalid UTF-8", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-skills-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const outside = join(root, "escape");
  await mkdir(join(project, ".axl", "skills"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "SKILL.md"), "---\nname: escape\ndescription: escaped\n---\n");
  await symlink(outside, join(project, ".axl", "skills", "escape"));
  await assert.rejects(discoverSkills({ cwd: project }), /escapes its discovery root/);

  const invalid = join(root, "invalid");
  await mkdir(invalid);
  await writeFile(join(invalid, "SKILL.md"), Buffer.from([0xff]));
  await assert.rejects(loadSkill(invalid), /valid UTF-8/);
});
