// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { AdoptionServiceError } from "@axl/daemon";
import { LocalAdoptionService } from "../src/adoption-service.ts";

const requestContext = {
  attachmentId: "test-attachment",
  client: { kind: "test", version: "1", instanceId: "test-client" },
  openedProjectRoots: [] as readonly string[],
};

async function fixture(context: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "axl-adoption-home-"));
  const project = join(home, "project");
  await mkdir(join(project, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(project, ".pi", "extensions", "hello.ts"),
    'export default function extension(pi) { pi.registerTool({ name: "hello" }); }\n',
  );
  context.after(() => rm(home, { recursive: true, force: true }));
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
  context.after(() => rm(home, { recursive: true, force: true }));
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
