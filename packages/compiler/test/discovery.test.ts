// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  DiscoveryError,
  candidateId,
  decodeUtf8,
  discover,
  expandPatterns,
  inspectCandidate,
  mergeLimits,
  nodeFileSystem,
  parseFrontmatter,
  parseJsonObject,
  parseJsoncObject,
  snapshotTree,
  type BoundedFileSystem,
} from "../src/index.ts";

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
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.scope),
    ["global", "global", "project"],
  );
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
    "custom-dsh/cordis.yml":
      "version: 1\nplugins:\n  group:todo:\n    enabled: true\n  logger:\n    level: info\n",
    "custom-dsh/unsafe/cordis.yaml": "plugins:\n  evil: !javascript/function payload\n",
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
    ["cordis-plugin:group:todo", "cordis-plugin:logger"],
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
