// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { AdoptionServiceError, AdoptionStore } from "@axl/daemon";
import { AdoptionAcquisitionCoordinator } from "../src/adoption-acquisition.ts";
import { LocalAdoptionService } from "../src/adoption-service.ts";

const requestContext = {
  attachmentId: "test-attachment",
  client: { kind: "test", version: "1", instanceId: "test-client" },
  openedProjectRoots: [] as readonly string[],
};

async function removeFixture(path: string): Promise<void> {
  const makeWritable = async (entryPath: string): Promise<void> => {
    let value: Awaited<ReturnType<typeof lstat>>;
    try {
      value = await lstat(entryPath);
    } catch {
      return;
    }
    if (value.isDirectory()) {
      await chmod(entryPath, 0o700);
      for (const entry of await readdir(entryPath)) await makeWritable(join(entryPath, entry));
    } else if (value.isFile()) await chmod(entryPath, 0o600);
  };
  await makeWritable(path);
  await rm(path, { recursive: true, force: true });
}

async function fixture(context: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "axl-adoption-home-"));
  const project = join(home, "project");
  await mkdir(join(project, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(project, ".pi", "extensions", "hello.ts"),
    'export default function extension(pi) { pi.registerTool({ name: "hello" }); }\n',
  );
  context.after(() => removeFixture(home));
  return { home, project };
}

test("local adoption service discovers, pages, and revalidates inspection", async (context) => {
  const { home, project } = await fixture(context);
  const service = new LocalAdoptionService({
    homeDirectory: home,
    environment: {},
    cacheLifetimeMs: 60_000,
  });
  const discovered = await service.discover(
    {
      ecosystems: ["pi"],
      scopes: ["project"],
      projectRoot: project,
      includeMalformed: true,
      pageSize: 1,
    },
    { ...requestContext, openedProjectRoots: [project] },
  );
  assert.equal(discovered.candidates.length, 1);
  const candidate = discovered.candidates[0];
  assert.ok(candidate);
  assert.equal(candidate.ecosystem, "pi");
  assert.deepEqual(candidate.source, { kind: "local", canonicalPath: join(project, ".pi") });
  assert.equal(candidate.executable, true);
  const inspected = await service.inspect(
    {
      candidateId: candidate.candidateId,
      expectedDiscoveryFingerprint: candidate.discoveryFingerprint,
      pageSize: 100,
    },
    { ...requestContext, openedProjectRoots: [project] },
  );
  assert.equal(inspected.inventory.fileCount > 0, true);
  assert.equal(inspected.inventory.totalBytes > 0, true);
  const hello = inspected.surfaces.find((surface) => surface.name === "hello");
  assert.ok(hello);
  const expectedSurfaceId = createHash("sha256")
    .update(
      `{"candidateId":${JSON.stringify(candidate.candidateId)},"kind":${JSON.stringify(hello.kind)},"name":${JSON.stringify(hello.name.normalize("NFC"))},"relativePath":${JSON.stringify(hello.relativePath?.normalize("NFC") ?? "")}}`,
    )
    .digest("hex");
  assert.equal(hello.surfaceId, expectedSurfaceId);
  assert.deepEqual(hello.requiredCapabilities, []);
  await writeFile(
    join(project, ".pi", "extensions", "hello.ts"),
    'export default function extension(pi) { pi.registerTool({ name: "changed" }); }\n',
  );
  const refreshed = await service.discover(
    {
      ecosystems: ["pi"],
      scopes: ["project"],
      projectRoot: project,
      includeMalformed: true,
      pageSize: 1,
    },
    { ...requestContext, openedProjectRoots: [project] },
  );
  assert.notEqual(
    refreshed.candidates[0]?.discoveryFingerprint,
    candidate.discoveryFingerprint,
    "a refresh must bypass disposable cached discovery results",
  );
  await service.dispose();
});

test("default discovery snapshots remain inspectable during human review", async (context) => {
  const { home, project } = await fixture(context);
  const service = new LocalAdoptionService({ homeDirectory: home, environment: {} });
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const discovered = await service.discover(
      {
        ecosystems: ["pi"],
        scopes: ["project"],
        projectRoot: project,
        includeMalformed: true,
        pageSize: 10,
      },
      { ...requestContext, openedProjectRoots: [project] },
    );
    const candidate = discovered.candidates[0];
    assert.ok(candidate);
    now += 31_000;
    const inspected = await service.inspect(
      {
        candidateId: candidate.candidateId,
        expectedDiscoveryFingerprint: candidate.discoveryFingerprint,
        pageSize: 10,
      },
      { ...requestContext, openedProjectRoots: [project] },
    );
    assert.equal(inspected.candidate.candidateId, candidate.candidateId);
  } finally {
    Date.now = originalNow;
    await service.dispose();
  }
});

test("local adoption service pages every safe diagnostic without disclosing source", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "axl-adoption-diagnostics-"));
  const themes = join(home, ".pi", "agent", "themes");
  await mkdir(themes, { recursive: true });
  const sentinel = "secret-value-that-must-not-cross-the-daemon-boundary";
  for (let index = 0; index < 70; index += 1) {
    await writeFile(
      join(themes, `broken-${String(index).padStart(2, "0")}.json`),
      `{"token":"${sentinel}"`,
    );
  }
  context.after(() => removeFixture(home));
  const service = new LocalAdoptionService({ homeDirectory: home, environment: {} });
  const warnings: Array<{
    readonly code: string;
    readonly message: string;
    readonly relativePath?: string;
  }> = [];
  let pageCursor: string | undefined;
  do {
    const page = await service.discover(
      {
        ecosystems: ["pi"],
        scopes: ["global"],
        includeMalformed: true,
        pageSize: 1,
        ...(pageCursor === undefined ? {} : { pageCursor }),
      },
      requestContext,
    );
    warnings.push(...page.warnings);
    pageCursor = page.nextPageCursor;
  } while (pageCursor !== undefined);
  assert.equal(warnings.filter((warning) => warning.code === "theme-invalid").length, 70);
  assert.equal(new Set(warnings.map((warning) => warning.relativePath)).size, 70);
  assert.equal(JSON.stringify(warnings).includes(sentinel), false);
  assert.equal(
    warnings.every((warning) => warning.message === `Source inspection reported ${warning.code}`),
    true,
  );
  await service.dispose();
});

test("local adoption service rejects roots without an opened Axl session", async (context) => {
  const { home, project } = await fixture(context);
  const service = new LocalAdoptionService({ homeDirectory: home, environment: {} });
  await assert.rejects(
    service.discover({ scopes: ["project"], projectRoot: project, pageSize: 10 }, requestContext),
    (error: unknown) =>
      error instanceof AdoptionServiceError && error.code === "adoption_project_untrusted",
  );
});

test("local adoption service observes cancellation without executing source", async (context) => {
  const { home, project } = await fixture(context);
  const service = new LocalAdoptionService({ homeDirectory: home, environment: {} });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    service.discover(
      { scopes: ["project"], projectRoot: project, pageSize: 10 },
      { ...requestContext, openedProjectRoots: [project] },
      controller.signal,
    ),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});

test("native Agent Skill adoption binds review and activates an immutable registry pointer", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "axl-native-skill-"));
  const project = join(home, "project");
  const skillDirectory = join(project, ".pi", "skills", "review-code");
  await mkdir(join(skillDirectory, "references"), { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: review-code\ndescription: Review code safely\nmetadata:\n  owner: test\n---\nRead [guide](references/guide.md).\n",
  );
  await writeFile(join(skillDirectory, "references", "guide.md"), "immutable guide\n");
  await writeFile(join(skillDirectory, "LICENSE"), "Apache-2.0\n");
  await writeFile(join(project, ".pi", "skills", "unrelated.txt"), "must not be copied\n");
  context.after(() => removeFixture(home));

  let store = new AdoptionStore(join(home, "adopted"));
  await store.initialize();
  let service = new LocalAdoptionService({
    homeDirectory: home,
    environment: {},
    acquisition: new AdoptionAcquisitionCoordinator(store),
  });
  const caller = { ...requestContext, openedProjectRoots: [project] };
  const discovered = await service.discover(
    {
      ecosystems: ["pi"],
      scopes: ["project"],
      projectRoot: project,
      includeMalformed: true,
      pageSize: 100,
    },
    caller,
  );
  const candidate = discovered.candidates.find((item) => item.kind === "skill");
  assert.ok(candidate);
  const inspected = await service.inspect(
    {
      candidateId: candidate.candidateId,
      expectedDiscoveryFingerprint: candidate.discoveryFingerprint,
      pageSize: 100,
    },
    caller,
  );
  assert.ok(inspected.trustReview);
  assert.equal(inspected.trustReview.targetScope, "project");
  assert.equal(inspected.trustReview.licenseFiles.length, 1);
  assert.deepEqual(inspected.trustReview.executableFiles, []);
  assert.deepEqual(
    inspected.trustReview.declarativeFiles.map((file) => file.relativePath),
    ["LICENSE", "SKILL.md", "references/guide.md"],
  );
  assert.deepEqual(inspected.trustReview.conflicts, []);

  const planned = await service.plan(
    {
      candidateId: candidate.candidateId,
      expectedDiscoveryFingerprint: candidate.discoveryFingerprint,
      targetScope: "project",
    },
    caller,
  );
  await service.dispose();
  store = new AdoptionStore(join(home, "adopted"));
  await store.initialize();
  service = new LocalAdoptionService({
    homeDirectory: home,
    environment: {},
    acquisition: new AdoptionAcquisitionCoordinator(store),
  });
  const staged = await service.start({ operationId: planned.operationId }, caller);
  assert.ok(staged.revisionId);
  await service.dispose();
  store = new AdoptionStore(join(home, "adopted"));
  await store.initialize();
  const activationCoordinator = new AdoptionAcquisitionCoordinator(store);
  service = new LocalAdoptionService({
    homeDirectory: home,
    environment: {},
    acquisition: activationCoordinator,
  });
  await writeFile(join(skillDirectory, "references", "guide.md"), "mutated original\n");
  await assert.rejects(
    service.approveActivation(
      {
        operationId: planned.operationId,
        revisionId: staged.revisionId,
        reviewBindingSha256: "0".repeat(64),
        policyGeneration: inspected.trustReview.policyGeneration,
      },
      caller,
    ),
    (error: unknown) =>
      error instanceof AdoptionServiceError && error.code === "adoption_approval_stale",
  );
  assert.equal((await store.readRegistry()).generation, 0);
  const originalWriteOperation =
    activationCoordinator.writeNativeOperation.bind(activationCoordinator);
  let failActiveJournal = true;
  activationCoordinator.writeNativeOperation = async (record) => {
    if (record.state === "active" && failActiveJournal) {
      failActiveJournal = false;
      throw new Error("injected active operation journal failure");
    }
    return originalWriteOperation(record);
  };
  let reloads = 0;
  service.setActivationListener(() => {
    reloads += 1;
  });
  const approval = {
    operationId: planned.operationId,
    revisionId: staged.revisionId,
    reviewBindingSha256: inspected.trustReview.bindingSha256,
    policyGeneration: inspected.trustReview.policyGeneration,
  };
  await assert.rejects(
    service.approveActivation(approval, caller),
    /injected active operation journal failure/u,
  );
  assert.equal((await store.readRegistry()).generation, 1);
  assert.equal(reloads, 1);
  const approved = await service.approveActivation(approval, caller);
  await service.dispose();
  store = new AdoptionStore(join(home, "adopted"));
  await store.initialize();
  service = new LocalAdoptionService({
    homeDirectory: home,
    environment: {},
    acquisition: new AdoptionAcquisitionCoordinator(store),
  });
  const resumed = await service.approveActivation(
    {
      operationId: planned.operationId,
      revisionId: staged.revisionId,
      reviewBindingSha256: inspected.trustReview.bindingSha256,
      policyGeneration: inspected.trustReview.policyGeneration,
    },
    caller,
  );
  assert.equal(resumed.approvalId, approved.approvalId);
  const registry = await store.readRegistry();
  assert.equal(registry.entries[0]?.reviewBindingSha256, inspected.trustReview.bindingSha256);
  assert.equal(registry.entries[0]?.policyGeneration, inspected.trustReview.policyGeneration);
  assert.ok(registry.entries[0]?.approvalId);
  const active = await store.activeSkills();
  assert.equal(active.generation, 1);
  assert.equal(active.skills[0]?.name, "review-code");
  const revision = await store.readRevision(
    "pi",
    candidate.packageId ?? "skill:review-code",
    staged.revisionId,
  );
  assert.deepEqual(
    revision.manifest.sourceFiles.map((file) => file.path),
    ["LICENSE", "SKILL.md", "references/guide.md"],
  );
  assert.equal(
    await readFile(join(active.skills[0]?.directory ?? "", "references", "guide.md"), "utf8"),
    "immutable guide\n",
  );
  await service.dispose();
});

test("native Agent Skill review blocks executable helpers and manual-only Pi skills", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "axl-native-skill-blocked-"));
  const project = join(home, "project");
  const executableSkill = join(project, ".pi", "skills", "unsafe-skill");
  await mkdir(executableSkill, { recursive: true });
  await writeFile(
    join(executableSkill, "SKILL.md"),
    "---\nname: unsafe-skill\ndescription: Unsafe helper\n---\nRun `python helper` when needed.\n",
  );
  const helper = join(executableSkill, "run");
  await writeFile(helper, "#!/bin/sh\necho unsafe\n");
  await chmod(helper, 0o755);
  await writeFile(join(executableSkill, "helper"), "print('unsafe')\n");
  await writeFile(
    join(executableSkill, "helper.bin"),
    Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x00]),
  );
  const manualSkill = join(project, ".pi", "skills", "manual-skill");
  await mkdir(manualSkill, { recursive: true });
  await writeFile(
    join(manualSkill, "SKILL.md"),
    "---\nname: manual-skill\ndescription: Manual only\ndisable-model-invocation: true\n---\nManual.\n",
  );
  context.after(() => removeFixture(home));
  const store = new AdoptionStore(join(home, "adopted"));
  await store.initialize();
  const service = new LocalAdoptionService({
    homeDirectory: home,
    environment: {},
    acquisition: new AdoptionAcquisitionCoordinator(store),
  });
  const caller = { ...requestContext, openedProjectRoots: [project] };
  const discovered = await service.discover(
    {
      ecosystems: ["pi"],
      scopes: ["project"],
      projectRoot: project,
      includeMalformed: true,
      pageSize: 100,
    },
    caller,
  );
  for (const name of ["unsafe-skill", "manual-skill"]) {
    const candidate = discovered.candidates.find((item) => item.displayName === name);
    assert.ok(candidate);
    const inspected = await service.inspect(
      {
        candidateId: candidate.candidateId,
        expectedDiscoveryFingerprint: candidate.discoveryFingerprint,
        pageSize: 100,
      },
      caller,
    );
    if (name === "unsafe-skill") {
      assert.deepEqual(
        inspected.trustReview?.executableFiles.map((file) => file.relativePath),
        ["helper", "helper.bin", "run"],
      );
    }
    const planned = await service.plan(
      {
        candidateId: candidate.candidateId,
        expectedDiscoveryFingerprint: candidate.discoveryFingerprint,
        targetScope: "project",
      },
      caller,
    );
    await assert.rejects(
      service.start({ operationId: planned.operationId }, caller),
      (error: unknown) =>
        error instanceof AdoptionServiceError &&
        (error.code === "adoption_policy_denied" || error.code === "adoption_primary_unsupported"),
    );
  }
  assert.equal((await store.readRegistry()).generation, 0);
  await service.dispose();
});

test("native Agent Skill review reports local collisions before installation", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "axl-native-skill-collision-"));
  const project = join(home, "project");
  for (const directory of [
    join(project, ".pi", "skills", "same-name"),
    join(project, ".axl", "skills", "same-name"),
  ]) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      "---\nname: same-name\ndescription: Collision\n---\nReview.\n",
    );
  }
  context.after(() => removeFixture(home));
  const store = new AdoptionStore(join(home, "adopted"));
  await store.initialize();
  const service = new LocalAdoptionService({
    homeDirectory: home,
    environment: {},
    acquisition: new AdoptionAcquisitionCoordinator(store),
  });
  const caller = { ...requestContext, openedProjectRoots: [project] };
  const discovered = await service.discover(
    {
      ecosystems: ["pi"],
      scopes: ["project"],
      projectRoot: project,
      includeMalformed: true,
      pageSize: 100,
    },
    caller,
  );
  const candidate = discovered.candidates.find((item) => item.displayName === "same-name");
  assert.ok(candidate);
  const inspected = await service.inspect(
    {
      candidateId: candidate.candidateId,
      expectedDiscoveryFingerprint: candidate.discoveryFingerprint,
      pageSize: 100,
    },
    caller,
  );
  assert.match(inspected.trustReview?.conflicts[0] ?? "", /Local project skill/u);
  const planned = await service.plan(
    {
      candidateId: candidate.candidateId,
      expectedDiscoveryFingerprint: candidate.discoveryFingerprint,
      targetScope: "project",
    },
    caller,
  );
  await assert.rejects(
    service.start({ operationId: planned.operationId }, caller),
    (error: unknown) =>
      error instanceof AdoptionServiceError && error.code === "adoption_collision",
  );
  await service.dispose();
});

test("native Agent Skill installation invalidates a review when source bytes change", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "axl-native-skill-stale-"));
  const project = join(home, "project");
  const skillDirectory = join(project, ".pi", "skills", "moving-skill");
  await mkdir(skillDirectory, { recursive: true });
  const skillPath = join(skillDirectory, "SKILL.md");
  await writeFile(
    skillPath,
    "---\nname: moving-skill\ndescription: Initial\n---\nInitial instructions.\n",
  );
  context.after(() => removeFixture(home));
  const store = new AdoptionStore(join(home, "adopted"));
  await store.initialize();
  const service = new LocalAdoptionService({
    homeDirectory: home,
    environment: {},
    acquisition: new AdoptionAcquisitionCoordinator(store),
  });
  const caller = { ...requestContext, openedProjectRoots: [project] };
  const discovered = await service.discover(
    {
      ecosystems: ["pi"],
      scopes: ["project"],
      projectRoot: project,
      includeMalformed: true,
      pageSize: 100,
    },
    caller,
  );
  const candidate = discovered.candidates.find((item) => item.displayName === "moving-skill");
  assert.ok(candidate);
  const planned = await service.plan(
    {
      candidateId: candidate.candidateId,
      expectedDiscoveryFingerprint: candidate.discoveryFingerprint,
      targetScope: "project",
    },
    caller,
  );
  await writeFile(
    skillPath,
    "---\nname: moving-skill\ndescription: Changed\n---\nChanged instructions.\n",
  );
  await assert.rejects(
    service.start({ operationId: planned.operationId }, caller),
    (error: unknown) =>
      error instanceof AdoptionServiceError && error.code === "adoption_source_changed",
  );
  assert.equal((await store.readRegistry()).generation, 0);
  await service.dispose();
});
