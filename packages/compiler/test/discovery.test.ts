// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  type BoundedFileSystem,
  candidateId,
  DiscoveryError,
  decodeUtf8,
  discover,
  expandPatterns,
  inspectCandidate,
  mergeLimits,
  nodeFileSystem,
  parseFrontmatter,
  parseJsoncObject,
  parseJsonObject,
  snapshotTree,
} from "../src/index.ts";
import { cordisSequenceConformance, ecosystemFailureFixtures } from "./fixtures/ecosystem-cases.ts";

async function fixture(files: Readonly<Record<string, string | Uint8Array>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "axl-compiler-test-"));
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

function context(homeDirectory: string, projectDirectory?: string, projectTrusted = false) {
  return {
    homeDirectory,
    ...(projectDirectory === undefined ? {} : { projectDirectory }),
    projectTrusted,
  };
}

test("candidate IDs are deterministic RFC UUIDv8 values", () => {
  const input = {
    ecosystem: "pi" as const,
    scope: "global" as const,
    canonicalSourceRoot: "/tmp/root",
    packageIdentity: "example",
    kind: "skill" as const,
    relativeResourcePath: "skills/example/SKILL.md",
  };
  const first = candidateId(input);
  assert.equal(first, candidateId(input));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.notEqual(first, candidateId({ ...input, relativeResourcePath: "skills/other/SKILL.md" }));
  assert.throws(() => candidateId({ ...input, relativeResourcePath: "../escape" }));
});

test("bounded traversal is deterministic and reads stable regular files", async () => {
  const root = await fixture({ "z.txt": "z", "a/b.txt": "b", "a/a.txt": "a" });
  const snapshot = await snapshotTree(root, nodeFileSystem, mergeLimits(undefined));
  assert.deepEqual(
    snapshot.files.map((file) => file.relativePath),
    ["a/a.txt", "a/b.txt", "z.txt"],
  );
  assert.equal(snapshot.totalBytes, 3);
});

test("traversal rejects symlink escapes and hard links without reading them", async () => {
  const outside = await fixture({ secret: "outside" });
  const root = await fixture({ source: "safe" });
  await symlink(join(outside, "secret"), join(root, "escape"));
  await link(join(root, "source"), join(root, "alias"));
  const snapshot = await snapshotTree(root, nodeFileSystem, mergeLimits(undefined));
  assert.equal(snapshot.files.length, 0);
  assert.deepEqual(snapshot.diagnostics.map((entry) => entry.code).sort(), [
    "hard-link-unsupported",
    "hard-link-unsupported",
    "symlink-escape",
  ]);
});

test("traversal rejects special files where supported", async (t) => {
  if (process.platform === "win32") return t.skip("FIFO is not available on Windows");
  const root = await fixture({ regular: "ok" });
  try {
    execFileSync("mkfifo", [join(root, "pipe")]);
  } catch {
    return t.skip("mkfifo is unavailable");
  }
  const snapshot = await snapshotTree(root, nodeFileSystem, mergeLimits(undefined));
  assert.ok(snapshot.diagnostics.some((entry) => entry.code === "special-file-unsupported"));
});

test("traversal enforces depth, entry, file, path, and total-byte limits", async () => {
  const root = await fixture({ "a/b/c.txt": "1234", "d.txt": "5678" });
  await assert.rejects(
    snapshotTree(root, nodeFileSystem, mergeLimits({ maxDepth: 1 })),
    (error) => error instanceof DiscoveryError && error.code === "adoption_scan_limit_exceeded",
  );
  await assert.rejects(
    snapshotTree(root, nodeFileSystem, mergeLimits({ maxEntries: 1 })),
    (error) => error instanceof DiscoveryError && error.code === "adoption_scan_limit_exceeded",
  );
  await assert.rejects(
    snapshotTree(root, nodeFileSystem, mergeLimits({ maxFiles: 1 })),
    (error) => error instanceof DiscoveryError && error.code === "adoption_scan_limit_exceeded",
  );
  await assert.rejects(
    snapshotTree(root, nodeFileSystem, mergeLimits({ maxFileBytes: 3 })),
    (error) => error instanceof DiscoveryError && error.code === "adoption_scan_limit_exceeded",
  );
  await assert.rejects(
    snapshotTree(root, nodeFileSystem, mergeLimits({ maxTotalBytes: 5 })),
    (error) => error instanceof DiscoveryError && error.code === "adoption_scan_limit_exceeded",
  );
  await assert.rejects(
    snapshotTree(root, nodeFileSystem, mergeLimits({ maxNameBytes: 1 })),
    (error) => error instanceof DiscoveryError && error.code === "adoption_scan_limit_exceeded",
  );
});

test("traversal detects metadata mutation across a read", async () => {
  const root = await fixture({ "file.txt": "value" });
  let calls = 0;
  const mutating: BoundedFileSystem = {
    ...nodeFileSystem,
    async lstat(path) {
      const stat = await nodeFileSystem.lstat(path);
      if (path.endsWith("file.txt")) {
        calls += 1;
        if (calls >= 2) return { ...stat, mtimeMs: stat.mtimeMs + 1 };
      }
      return stat;
    },
  };
  await assert.rejects(
    snapshotTree(root, mutating, mergeLimits(undefined)),
    (error) => error instanceof DiscoveryError && error.code === "adoption_source_changed",
  );
});

test("traversal detects chmod and hard-link metadata races", async () => {
  for (const field of ["mode", "nlink"] as const) {
    const root = await fixture({ "file.txt": "value" });
    let calls = 0;
    const mutating: BoundedFileSystem = {
      ...nodeFileSystem,
      async lstat(path) {
        const stat = await nodeFileSystem.lstat(path);
        if (path.endsWith("file.txt")) {
          calls += 1;
          if (calls >= 2) {
            return field === "mode"
              ? { ...stat, mode: stat.mode ^ 0o100 }
              : { ...stat, nlink: stat.nlink + 1 };
          }
        }
        return stat;
      },
    };
    await assert.rejects(
      snapshotTree(root, mutating, mergeLimits(undefined)),
      (error) => error instanceof DiscoveryError && error.code === "adoption_source_changed",
      field,
    );
  }
});

test("strict text and parsers reject invalid UTF-8, deep JSON, and unsafe globs", async () => {
  const root = await fixture({
    invalid: Uint8Array.from([0xc3, 0x28]),
    json: `${'{"x":'.repeat(34)}null${"}".repeat(34)}`,
  });
  const snapshot = await snapshotTree(root, nodeFileSystem, mergeLimits(undefined));
  assert.throws(
    () => decodeUtf8(snapshot.files[0] as NonNullable<(typeof snapshot.files)[0]>),
    (error) => error instanceof DiscoveryError && error.code === "adoption_manifest_invalid",
  );
  assert.throws(
    () => parseJsonObject(snapshot.files[1] as NonNullable<(typeof snapshot.files)[1]>, 1_000_000),
    (error) => error instanceof DiscoveryError && error.code === "adoption_manifest_invalid",
  );
  assert.throws(() => expandPatterns(["safe.txt"], ["../*"], 10));
  assert.deepEqual(expandPatterns(["a.ts", "nested/b.ts", ".secret.ts"], ["**/*.ts"], 10), [
    "a.ts",
    "nested/b.ts",
  ]);
  assert.deepEqual(expandPatterns(["a.ts", "b.ts", ".secret.ts"], ["*.ts", "!b.ts"], 10), ["a.ts"]);
  assert.deepEqual(
    parseFrontmatter("---\nname: ok\nextra: value\n---\nbody", new Set(["name"])).unknownFields,
    ["extra"],
  );
  const jsoncRoot = await fixture({ jsonc: '{"literal":"x,}", // comment\n"items":[1,],}' });
  const jsoncSnapshot = await snapshotTree(jsoncRoot, nodeFileSystem, mergeLimits(undefined));
  assert.deepEqual(
    parseJsoncObject(jsoncSnapshot.files[0] as NonNullable<(typeof jsoncSnapshot.files)[0]>, 1024),
    { literal: "x,}", items: [1] },
  );
});

test("Pi discovery inventories all supported global resources without executing source", async () => {
  const root = await fixture({
    ".pi/agent/extensions/sentinel.ts":
      "import { writeFileSync } from 'node:fs'; writeFileSync('EXECUTED', 'bad'); pi.registerTool('literal', {}); pi.registerCommand(name, {});",
    ".pi/agent/skills/valid/SKILL.md":
      "---\nname: valid\ndescription: ok\ndisable-model-invocation: true\n---\nBody",
    ".pi/agent/skills/mismatch/SKILL.md": "---\nname: other\nunknown: value\n---\nBody",
    ".pi/agent/skills/flat.md": "flat skill",
    ".pi/agent/prompts/review.md": "---\nname: review\n---\nReview {{target}}",
    ".pi/agent/themes/night.json": '{"colors":{"accent":"#fff"}}',
    ".pi/agent/settings.json": '{"extensions":["+extensions/sentinel.ts"],"apiKey":"literal"}',
    ".pi/agent/models.json": '{"providers":[]}',
    ".pi/agent/keybindings.json": "{}",
    ".pi/agent/AGENTS.md": "context",
    ".pi/agent/SYSTEM.md": "system",
    ".pi/agent/APPEND_SYSTEM.md": "append",
    ".pi/agent/auth.json": '{"token":"excluded"}',
    ".pi/agent/sessions/secret.jsonl": "excluded",
    ".pi/agent/npm/node_modules/example/package.json":
      '{"name":"example","version":"1.0.0","scripts":{"postinstall":"touch bad"},"dependencies":{"a":"1"},"peerDependencies":{"b":"1"},"pi":{"schemaVersion":"99","extensions":["entry.ts"],"resources_discover":"dynamic"},"gallery":{"category":"demo"}}',
    ".pi/agent/npm/node_modules/example/entry.ts": "pi.registerTool('package-tool', {})",
    ".pi/agent/git/example/package.json":
      '{"name":"git-example","version":"1.0.0","pi":{"prompts":["prompt.md"]}}',
    ".pi/agent/git/example/prompt.md": "Git prompt",
    ".pi/agent/local-example/package.json":
      '{"name":"local-example","version":"1.0.0","pi":{"themes":["theme.json"]}}',
    ".pi/agent/local-example/theme.json": '{"colors":{}}',
  });
  const readPaths: string[] = [];
  const observingFileSystem: BoundedFileSystem = {
    ...nodeFileSystem,
    async readStableFile(path, maximumBytes, canonicalRoot) {
      readPaths.push(path);
      return nodeFileSystem.readStableFile(path, maximumBytes, canonicalRoot);
    },
  };
  const result = await discover(context(root), {
    ecosystems: ["pi"],
    fileSystem: observingFileSystem,
  });
  const paths = result.candidates.map((candidate) => candidate.provenance.relativePath);
  assert.ok(paths.includes("extensions/sentinel.ts"));
  assert.ok(paths.includes("skills/valid/SKILL.md"));
  assert.ok(paths.includes("skills/flat.md"));
  assert.ok(paths.includes("prompts/review.md"));
  assert.ok(paths.includes("themes/night.json"));
  assert.ok(paths.includes("models.json"));
  assert.ok(paths.includes("AGENTS.md"));
  assert.ok(!paths.includes("auth.json"));
  assert.ok(!paths.some((path) => path.startsWith("sessions/")));
  assert.ok(!readPaths.some((path) => path.endsWith("auth.json") || path.includes("/sessions/")));
  assert.ok(result.diagnostics.some((entry) => entry.code === "literal-credential"));
  assert.ok(result.diagnostics.some((entry) => entry.code === "keybindings-inventoried"));
  assert.ok(result.diagnostics.some((entry) => entry.code === "source-schema-unsupported"));
  const extension = result.candidates.find(
    (candidate) => candidate.provenance.relativePath === "extensions/sentinel.ts",
  );
  assert.deepEqual(extension?.surfaces[0]?.registrations, ["registerTool:literal"]);
  assert.equal(extension?.surfaces[0]?.dynamicBehavior, true);
  assert.equal(extension?.surfaces[0]?.metadata.staticAnalysisComplete, false);
  assert.equal(extension?.surfaces[0]?.metadata.shellOrProcess, false);
  const packageCandidate = result.candidates.find(
    (candidate) => candidate.packageIdentity === "example",
  );
  assert.deepEqual(packageCandidate?.inventory?.dependencies, ["a"]);
  assert.deepEqual(packageCandidate?.inventory?.peerDependencies, ["b"]);
  assert.deepEqual(packageCandidate?.inventory?.lifecycleScripts, ["postinstall"]);
  assert.equal(packageCandidate?.inventory?.installationKind, "npm");
  assert.equal(
    result.candidates.find((candidate) => candidate.packageIdentity === "git-example")?.inventory
      ?.installationKind,
    "git",
  );
  assert.equal(
    result.candidates.find((candidate) => candidate.packageIdentity === "local-example")?.inventory
      ?.installationKind,
    "local",
  );
  assert.equal(
    packageCandidate?.surfaces.some((surface) => surface.dynamicBehavior),
    true,
  );
  await assert.rejects(readFile(join(root, "EXECUTED")), /ENOENT/u);
  assert.ok(
    result.candidates.every(
      (candidate) => candidate.surfaces.filter((surface) => surface.primary).length === 1,
    ),
  );
  assert.ok(
    result.candidates.every(
      (candidate) =>
        candidate.candidateId.length === 36 && candidate.discoveryFingerprint.length === 64,
    ),
  );
});

test("Pi retains malformed resources and packages without suppressing valid siblings", async () => {
  const invalidUtf8 = Uint8Array.from([0xc3, 0x28]);
  const home = await fixture({
    ".pi/agent/extensions/good.ts": "pi.registerTool('good', {})",
    ".pi/agent/extensions/bad.ts": invalidUtf8,
    ".pi/agent/prompts/good.md": "Good prompt",
    ".pi/agent/prompts/bad.md": "---\nname: bad\nunterminated",
    ".pi/agent/skills/good/SKILL.md": "---\nname: good\ndescription: Good skill\n---\nBody",
    ".pi/agent/skills/bad/SKILL.md": invalidUtf8,
    ".pi/agent/skills/bad/helper.sh": "echo never-run",
    ".pi/agent/npm/node_modules/broken/package.json": "{not-json",
    ".pi/agent/npm/node_modules/healthy/package.json":
      '{"name":"healthy","pi":{"prompts":["prompt.md"]}}',
    ".pi/agent/npm/node_modules/healthy/prompt.md": "Healthy prompt",
  });
  const result = await discover(context(home), { ecosystems: ["pi"] });
  for (const relativePath of ["extensions/good.ts", "prompts/good.md", "skills/good/SKILL.md"]) {
    assert.ok(
      result.candidates.some(
        (candidate) => candidate.provenance.relativePath === relativePath && !candidate.malformed,
      ),
      relativePath,
    );
  }
  for (const relativePath of [
    "extensions/bad.ts",
    "prompts/bad.md",
    "skills/bad/SKILL.md",
    "npm/node_modules/broken/package.json",
  ]) {
    const candidate = result.candidates.find(
      (entry) => entry.provenance.relativePath === relativePath,
    );
    assert.ok(candidate, relativePath);
    assert.equal(candidate.malformed, true, relativePath);
    assert.equal(candidate.scope, "global", relativePath);
    assert.equal(candidate.primary, true, relativePath);
    assert.equal(candidate.surfaces.filter((surface) => surface.primary).length, 1, relativePath);
    assert.ok(candidate.diagnostics.some((diagnostic) => diagnostic.severity === "error"));
  }
  assert.equal(
    result.candidates.find((candidate) => candidate.provenance.relativePath === "extensions/bad.ts")
      ?.executable,
    true,
  );
  assert.equal(
    result.candidates.find((candidate) => candidate.provenance.relativePath === "prompts/bad.md")
      ?.executable,
    false,
  );
  assert.equal(
    result.candidates.find(
      (candidate) => candidate.provenance.relativePath === "skills/bad/SKILL.md",
    )?.executable,
    true,
  );
  assert.ok(result.candidates.some((candidate) => candidate.packageIdentity === "healthy"));
});

test("strict Agent Skill inspection reports standard and Pi-lenient behavior", async () => {
  const home = await fixture({
    ".pi/agent/skills/no-frontmatter/SKILL.md": "Body only",
    ".pi/agent/skills/mismatch/SKILL.md":
      "---\nname: INVALID Name\ndescription: Present\nunknown-field: value\ndisable-model-invocation: true\n---\nBody",
    ".pi/agent/skills/mismatch/helper.py": "print('never run')",
    ".pi/agent/skills/complex/SKILL.md":
      "---\r\nname: complex\r\ndescription: Present\r\nmetadata:\r\n  nested: value\r\n---\r\nBody",
    ".pi/agent/skills/flat.md": "Flat Pi skill",
    ".pi/agent/skills/long/SKILL.md": `---\nname: ${"a".repeat(65)}\ndescription: ${"x".repeat(1_025)}\n---\nBody`,
    ".pi/agent/skills/unicode/SKILL.md": `---\nname: unicode\ndescription: ${"é".repeat(600)}\n---\nBody`,
    ".pi/agent/skills/one/SKILL.md": "---\nname: shared\ndescription: First\n---\nBody",
    ".pi/agent/skills/two/SKILL.md": "---\nname: shared\ndescription: Second\n---\nBody",
  });
  const result = await discover(context(home), { ecosystems: ["pi"] });
  const codes = new Set(
    result.candidates.flatMap((candidate) =>
      candidate.diagnostics.map((diagnostic) => diagnostic.code),
    ),
  );
  for (const code of [
    "skill-frontmatter-required",
    "skill-name-required",
    "skill-description-required",
    "skill-invalid-name",
    "skill-description-too-long",
    "skill-name-mismatch",
    "skill-unknown-field",
    "skill-flat-markdown",
    "skill-collision",
    "skill-pi-disable-model-invocation",
    "skill-executable-helper",
  ]) {
    assert.ok(codes.has(code), code);
  }
  for (const relativePath of ["skills/complex/SKILL.md", "skills/unicode/SKILL.md"]) {
    assert.ok(
      result.candidates.some(
        (candidate) => candidate.provenance.relativePath === relativePath && !candidate.malformed,
      ),
      relativePath,
    );
  }
});

test("Pi project discovery requires trust and honors environment roots and exact filters", async () => {
  const home = await fixture({
    "custom/extensions/keep.ts": "pi.registerTool('keep', {})",
    "custom/extensions/drop.ts": "pi.registerTool('drop', {})",
    "custom/settings.json": '{"extensions":["-extensions/drop.ts"]}',
  });
  const project = await fixture({
    ".pi/extensions/project.ts": "pi.registerTool('project', {})",
    ".agents/skills/shared/SKILL.md": "---\nname: shared\n---\nBody",
    "AGENTS.md": "project context",
    "ignored.txt": "must not be read by context-only scanning",
  });
  const blocked = await discover(
    {
      ...context(home, project, false),
      environment: { PI_CODING_AGENT_DIR: join(home, "custom") },
    },
    { ecosystems: ["pi"] },
  );
  assert.ok(
    blocked.candidates.some(
      (candidate) =>
        candidate.scope === "global" && candidate.provenance.relativePath === "extensions/keep.ts",
    ),
  );
  assert.ok(blocked.candidates.every((candidate) => candidate.scope === "global"));
  assert.ok(blocked.diagnostics.some((entry) => entry.code === "adoption_project_untrusted"));
  const trusted = await discover(
    { ...context(home, project, true), environment: { PI_CODING_AGENT_DIR: join(home, "custom") } },
    { ecosystems: ["pi"] },
  );
  const paths = trusted.candidates.map((candidate) => candidate.provenance.relativePath);
  assert.ok(paths.includes("extensions/keep.ts"));
  assert.ok(!paths.includes("extensions/drop.ts"));
  assert.ok(paths.includes("extensions/project.ts"));
  assert.ok(paths.includes("skills/shared/SKILL.md"));
  assert.ok(paths.includes("AGENTS.md"));
});

test("inspection detects a changed discovery fingerprint", async () => {
  const home = await fixture({ ".pi/agent/prompts/test.md": "first" });
  const result = await discover(context(home), { ecosystems: ["pi"] });
  const candidate = result.candidates.find((entry) => entry.kind === "prompt");
  assert.ok(candidate);
  await writeFile(join(home, ".pi/agent/prompts/test.md"), "second");
  await assert.rejects(
    inspectCandidate(context(home), candidate.candidateId, candidate.discoveryFingerprint, {
      ecosystems: ["pi"],
    }),
    (error) => error instanceof DiscoveryError && error.code === "adoption_source_changed",
  );
});

test("fingerprints bind settings and symlink decisions outside candidate-local source", async () => {
  const outside = await fixture({ value: "outside" });
  const home = await fixture({
    ".pi/agent/extensions/tool.ts": "pi.registerTool('tool', {})",
    ".pi/agent/settings.json": "{}",
  });
  const first = await discover(context(home), { ecosystems: ["pi"] });
  const firstCandidate = first.candidates.find(
    (candidate) => candidate.provenance.relativePath === "extensions/tool.ts",
  );
  assert.ok(firstCandidate);

  await writeFile(join(home, ".pi/agent/settings.json"), '{"theme":"dark"}');
  const second = await discover(context(home), { ecosystems: ["pi"] });
  const secondCandidate = second.candidates.find(
    (candidate) => candidate.candidateId === firstCandidate.candidateId,
  );
  assert.ok(secondCandidate);
  assert.notEqual(secondCandidate.discoveryFingerprint, firstCandidate.discoveryFingerprint);

  await symlink(join(outside, "value"), join(home, ".pi/agent/escape"));
  const third = await discover(context(home), { ecosystems: ["pi"] });
  const thirdCandidate = third.candidates.find(
    (candidate) => candidate.candidateId === firstCandidate.candidateId,
  );
  assert.ok(thirdCandidate);
  assert.ok(third.diagnostics.some((diagnostic) => diagnostic.code === "symlink-escape"));
  assert.notEqual(thirdCandidate.discoveryFingerprint, secondCandidate.discoveryFingerprint);
});

test("OpenCode discovery covers global and trusted project resources", async () => {
  const home = await fixture({
    ".config/opencode/tools/math.ts": "tool({}); registerTool('math', {})",
    ".config/opencode/commands/test.md": "---\nname: test\n---\nPrompt",
    ".config/opencode/opencode.json": '{"schemaVersion":"1"}',
  });
  const project = await fixture({
    ".opencode/agents/reviewer.md": "---\nname: reviewer\n---\nAgent",
  });
  const result = await discover(context(home, project, true), { ecosystems: ["opencode"] });
  assert.equal(result.candidates.filter((candidate) => candidate.scope === "global").length, 3);
  assert.equal(result.candidates.filter((candidate) => candidate.scope === "project").length, 1);
  assert.ok(
    result.candidates.some((candidate) => candidate.kind === "extension" && candidate.executable),
  );
  assert.ok(
    result.candidates.some((candidate) => candidate.kind === "agent" && !candidate.executable),
  );
});

test("untrusted projects do not suppress global declarative discovery and sensitive state is not read", async () => {
  const home = await fixture({
    ".config/opencode/tools/global.ts": "registerTool('global', {})",
    ".config/opencode/auth.json": '{"token":"secret"}',
    ".config/opencode/sessions/private.json": "secret",
    ".dsh/tools/global.ts": "registerTool('global', {})",
    ".dsh/credentials.json": '{"token":"secret"}',
    ".dsh/logs/private.log": "secret",
    ".claude/skills/global/SKILL.md": "---\nname: global\n---\nSkill",
    ".claude/.credentials.json": '{"token":"secret"}',
    ".claude/history.jsonl": "secret",
    ".claude/projects/project/session.jsonl": "secret",
    ".claude/cache/cache.json": "secret",
    ".claude/logs/log.txt": "secret",
    ".claude/telemetry/event.json": "secret",
  });
  const project = await fixture({
    ".opencode/tools/project.ts": "registerTool('project', {})",
    ".dsh/tools/project.ts": "registerTool('project', {})",
    ".claude/skills/project/SKILL.md": "---\nname: project\n---\nSkill",
  });
  const readPaths: string[] = [];
  const observingFileSystem: BoundedFileSystem = {
    ...nodeFileSystem,
    async readStableFile(path, maximumBytes, canonicalRoot) {
      readPaths.push(path);
      return nodeFileSystem.readStableFile(path, maximumBytes, canonicalRoot);
    },
  };
  const result = await discover(context(home, project, false), {
    ecosystems: ["opencode", "dsh", "claude-code"],
    fileSystem: observingFileSystem,
  });
  assert.deepEqual(
    new Set(result.candidates.map((candidate) => candidate.ecosystem)),
    new Set(["opencode", "dsh", "claude-code"]),
  );
  assert.ok(result.candidates.every((candidate) => candidate.scope === "global"));
  assert.equal(
    result.diagnostics.filter((diagnostic) => diagnostic.code === "adoption_project_untrusted")
      .length,
    3,
  );
  assert.ok(
    !readPaths.some((path) =>
      /(?:auth|credential|history|\/projects\/|\/sessions\/|\/cache\/|\/logs\/|\/telemetry\/)/u.test(
        path,
      ),
    ),
  );
});

test("DSH discovery honors DSH_HOME and parses bounded Cordis YAML as data", async () => {
  const home = await fixture({
    ".dsh/tools/ignored.ts": "registerTool('ignored', {})",
    "custom-dsh/tools/todo.ts": "registerTool('todo_write', {})",
    "custom-dsh/cordis.yml": cordisSequenceConformance,
    "custom-dsh/unsafe/cordis.yaml": ecosystemFailureFixtures.dsh.hostile,
  });
  const result = await discover(
    { ...context(home), environment: { DSH_HOME: join(home, "custom-dsh") } },
    { ecosystems: ["dsh"] },
  );
  assert.ok(
    !result.candidates.some((candidate) =>
      candidate.surfaces.some((surface) => surface.registrations.includes("registerTool:ignored")),
    ),
  );
  assert.ok(
    result.candidates.some((candidate) =>
      candidate.surfaces.some((surface) =>
        surface.registrations.includes("registerTool:todo_write"),
      ),
    ),
  );
  const cordis = result.candidates.find(
    (candidate) => candidate.provenance.relativePath === "cordis.yml",
  );
  assert.ok(cordis);
  assert.deepEqual(
    cordis.surfaces.map((surface) => surface.registrations[0]),
    [
      "cordis-plugin:@deepseek-ai/dsh-tool-cordis",
      "cordis-plugin:@example/independent-helper",
      "cordis-plugin:webserver",
    ],
  );
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "cordis-config-invalid"));
});

test("DSH discovery inventories executable and declarative surfaces", async () => {
  const home = await fixture({
    ".dsh/tools/todo.ts": "registerTool('todo_write', {})",
    ".dsh/workflows/review.json": "{}",
    ".dsh/cordis.yaml": "version: 2\nplugins:\n  todo:\n",
    ".dsh/bad/package.json": "{bad",
    ".dsh/package.json": '{"name":"dsh-package","version":"1.0.0","scripts":{"install":"bad"}}',
  });
  const result = await discover(context(home), { ecosystems: ["dsh"] });
  assert.ok(result.candidates.some((candidate) => candidate.packageIdentity === "dsh-package"));
  assert.ok(result.candidates.some((candidate) => candidate.kind === "workflow"));
  assert.ok(
    result.candidates.some((candidate) =>
      candidate.surfaces.some((surface) =>
        surface.registrations.includes("registerTool:todo_write"),
      ),
    ),
  );
  assert.ok(result.diagnostics.some((entry) => entry.code === "source-schema-unsupported"));
  assert.ok(result.diagnostics.some((entry) => entry.code === "manifest-invalid"));
  assert.ok(
    result.candidates.some(
      (candidate) =>
        candidate.provenance.relativePath === "bad/package.json" && candidate.malformed,
    ),
  );
});

test("Claude Code discovery parses plugin skills, hooks, MCP metadata, and malformed manifests", async () => {
  const home = await fixture({
    ".claude/skills/design/SKILL.md": "---\nname: design\n---\nSkill",
    ".claude/hooks/safe.json": "{}",
    ".claude/.mcp.json": '{"mcpServers":{"local":{"command":"server"}}}',
    ".claude/plugins/demo/.claude-plugin/plugin.json": '{"name":"demo","schemaVersion":"99"}',
    ".claude/plugins/bad/package.json": "{not json",
  });
  const result = await discover(context(home), { ecosystems: ["claude-code"] });
  assert.ok(result.candidates.some((candidate) => candidate.kind === "skill"));
  assert.ok(
    result.candidates.some((candidate) => candidate.kind === "hook" && candidate.executable),
  );
  assert.ok(
    result.candidates.some((candidate) => candidate.kind === "mcp-server" && candidate.executable),
  );
  assert.ok(result.diagnostics.some((entry) => entry.code === "source-schema-unsupported"));
  assert.ok(result.diagnostics.some((entry) => entry.code === "manifest-invalid"));
});

test("OpenCode malformed, hostile, and unknown-version fixtures fail closed", async () => {
  const home = await fixture({
    ".config/opencode/tools/sentinel.ts":
      "import { writeFileSync } from 'node:fs'; writeFileSync('EXECUTED', 'bad')",
    ".config/opencode/tools/bad.ts": Uint8Array.from([0xc3, 0x28]),
    ".config/opencode/malformed/opencode.json": ecosystemFailureFixtures.opencode.malformed,
    ".config/opencode/hostile/opencode.json": ecosystemFailureFixtures.opencode.hostile,
    ".config/opencode/unknown/opencode.json": ecosystemFailureFixtures.opencode.unknownVersion,
    ".config/opencode/broken/package.json": "{not-json",
  });
  const result = await discover(context(home), { ecosystems: ["opencode"] });
  assert.ok(
    result.diagnostics.some(
      (entry) => entry.code === "manifest-invalid" && entry.relativePath?.includes("malformed"),
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (entry) => entry.code === "literal-credential" && entry.relativePath?.includes("hostile"),
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (entry) => entry.code === "command-value" && entry.relativePath?.includes("hostile"),
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (entry) =>
        entry.code === "source-schema-unsupported" && entry.relativePath?.includes("unknown"),
    ),
  );
  for (const relativePath of ["tools/bad.ts", "malformed/opencode.json", "broken/package.json"]) {
    assert.ok(
      result.candidates.some(
        (candidate) => candidate.provenance.relativePath === relativePath && candidate.malformed,
      ),
      relativePath,
    );
  }
  assert.ok(
    result.candidates.some(
      (candidate) =>
        candidate.provenance.relativePath === "tools/sentinel.ts" && !candidate.malformed,
    ),
  );
  await assert.rejects(readFile(join(home, "EXECUTED")), /ENOENT/u);
});

test("DSH malformed, hostile, and unknown-version fixtures fail closed", async () => {
  const home = await fixture({
    ".dsh/tools/sentinel.ts":
      "import { writeFileSync } from 'node:fs'; writeFileSync('EXECUTED', 'bad')",
    ".dsh/malformed/cordis.yml": ecosystemFailureFixtures.dsh.malformed,
    ".dsh/hostile/cordis.yml": ecosystemFailureFixtures.dsh.hostile,
    ".dsh/unknown/cordis.yml": ecosystemFailureFixtures.dsh.unknownVersion,
  });
  const result = await discover(context(home), { ecosystems: ["dsh"] });
  assert.ok(
    result.diagnostics.some(
      (entry) =>
        entry.code === "cordis-config-invalid" && entry.relativePath?.includes("malformed"),
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (entry) => entry.code === "cordis-config-invalid" && entry.relativePath?.includes("hostile"),
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (entry) =>
        entry.code === "source-schema-unsupported" && entry.relativePath?.includes("unknown"),
    ),
  );
  assert.ok(
    result.candidates.some(
      (candidate) =>
        candidate.provenance.relativePath === "malformed/cordis.yml" && candidate.malformed,
    ),
  );
  assert.ok(
    result.candidates.some(
      (candidate) =>
        candidate.provenance.relativePath === "tools/sentinel.ts" && !candidate.malformed,
    ),
  );
  await assert.rejects(readFile(join(home, "EXECUTED")), /ENOENT/u);
});

test("Claude Code malformed, hostile, and unknown-version fixtures fail closed", async () => {
  const home = await fixture({
    ".claude/plugins/sentinel/index.ts":
      "import { writeFileSync } from 'node:fs'; writeFileSync('EXECUTED', 'bad')",
    ".claude/plugins/malformed/.claude-plugin/plugin.json":
      ecosystemFailureFixtures.claudeCode.malformed,
    ".claude/hostile/settings.json": ecosystemFailureFixtures.claudeCode.hostile,
    ".claude/plugins/unknown/.claude-plugin/plugin.json":
      ecosystemFailureFixtures.claudeCode.unknownVersion,
  });
  const result = await discover(context(home), { ecosystems: ["claude-code"] });
  assert.ok(
    result.diagnostics.some(
      (entry) => entry.code === "manifest-invalid" && entry.relativePath?.includes("malformed"),
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (entry) => entry.code === "literal-credential" && entry.relativePath?.includes("hostile"),
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (entry) => entry.code === "command-value" && entry.relativePath?.includes("hostile"),
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (entry) =>
        entry.code === "source-schema-unsupported" && entry.relativePath?.includes("unknown"),
    ),
  );
  assert.ok(
    result.candidates.some(
      (candidate) =>
        candidate.provenance.relativePath === "plugins/malformed/.claude-plugin/plugin.json" &&
        candidate.malformed,
    ),
  );
  assert.ok(
    result.candidates.some(
      (candidate) =>
        candidate.provenance.relativePath === "plugins/sentinel/index.ts" && !candidate.malformed,
    ),
  );
  await assert.rejects(readFile(join(home, "EXECUTED")), /ENOENT/u);
});

test("candidate ordering and duplicate handling are deterministic", async () => {
  const home = await fixture({
    ".pi/agent/prompts/z.md": "z",
    ".pi/agent/prompts/a.md": "a",
    ".config/opencode/commands/m.md": "m",
  });
  const first = await discover(context(home), { ecosystems: ["pi", "opencode"] });
  const second = await discover(context(home), { ecosystems: ["pi", "opencode"] });
  assert.deepEqual(first.candidates, second.candidates);
  assert.deepEqual(
    first.candidates.map((candidate) => candidate.ecosystem),
    ["opencode", "pi", "pi"],
  );
  assert.equal(
    new Set(first.candidates.map((candidate) => candidate.candidateId)).size,
    first.candidates.length,
  );
});

test("malicious package names and settings paths are rejected as typed diagnostics", async () => {
  const home = await fixture({
    ".pi/agent/settings.json": '{"extensions":["+../../escape.ts"]}',
    ".pi/agent/npm/node_modules/bad/package.json":
      '{"name":"../../owned","pi":{"extensions":["entry.ts"]}}',
    ".pi/agent/npm/node_modules/bad/entry.ts": "pi.registerTool('safe', {})",
  });
  const result = await discover(context(home), { ecosystems: ["pi"] });
  assert.ok(result.diagnostics.some((entry) => entry.code === "settings-path-invalid"));
  assert.ok(result.diagnostics.some((entry) => entry.code === "package-name-invalid"));
  assert.ok(!result.candidates.some((candidate) => candidate.packageIdentity === "../../owned"));
});

test("manifest parser fuzz corpus fails closed without executing values", async () => {
  const corpus = [
    "",
    "null",
    "[]",
    "{",
    '{"pi":[]}',
    '{"scripts":{"install":1}}',
    '{"pi":{"extensions":"x"}}',
  ];
  for (const [index, value] of corpus.entries()) {
    const home = await fixture({
      [`.pi/agent/npm/node_modules/fuzz-${index}/package.json`]: value,
    });
    const result = await discover(context(home), { ecosystems: ["pi"] });
    assert.ok(
      result.diagnostics.some((entry) => entry.code === "pi-manifest-invalid"),
      `corpus ${index}`,
    );
  }
});

test("unknown config versions and oversized manifests are typed diagnostics", async () => {
  const huge = JSON.stringify({ padding: "x".repeat(300) });
  const home = await fixture({
    ".config/opencode/opencode.json": '{"version":"999"}',
    ".config/opencode/package.json": huge,
  });
  const result = await discover(
    { ...context(home), limits: { maxManifestBytes: 128, maxFileBytes: 1024 } },
    { ecosystems: ["opencode"] },
  );
  assert.ok(result.diagnostics.some((entry) => entry.code === "source-schema-unsupported"));
  assert.ok(result.diagnostics.some((entry) => entry.code === "manifest-invalid"));
});

test("executable fixture permissions do not cause source execution", async () => {
  const root = await fixture({
    ".pi/agent/extensions/executable.js":
      "#!/usr/bin/env node\nrequire('fs').writeFileSync('owned','x')",
  });
  await chmod(join(root, ".pi/agent/extensions/executable.js"), 0o755);
  await discover(context(root), { ecosystems: ["pi"] });
  await assert.rejects(readFile(join(root, "owned")), /ENOENT/u);
});
