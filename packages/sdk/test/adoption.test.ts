// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  AdoptionController,
  type AdoptionDiscoverResult,
  type AdoptionInspectResult,
  type AxlClient,
  parseAdoptionCandidateId,
} from "../src/index.ts";

const candidateId = parseAdoptionCandidateId("123e4567-e89b-812d-a456-426614174000");
const fingerprint = "a".repeat(64);
const candidate = {
  candidateId,
  discoveryFingerprint: fingerprint,
  ecosystem: "pi" as const,
  scope: "project" as const,
  kind: "extension" as const,
  displayName: "hello",
  source: { kind: "local" as const, canonicalPath: "/tmp/project/.pi/extensions/hello.ts" },
  relativeResourcePath: ".pi/extensions/hello.ts",
  primary: true,
  executable: true,
  resourceCount: 1,
  warningCount: 0,
  malformed: false,
};

function client(input: {
  readonly request: (method: string, params: unknown, options?: unknown) => Promise<unknown>;
  readonly capabilities?: readonly string[];
  readonly instance?: string;
}): AxlClient {
  return {
    connection: {
      daemonInstanceId: input.instance ?? "daemon-1",
      grantedCapabilities: input.capabilities ?? ["adoption.discover", "adoption.inspect"],
    },
    request: input.request,
  } as unknown as AxlClient;
}

test("adoption controller pages discovery and inspection into immutable state", async () => {
  const requests: string[] = [];
  const fake = client({
    request: async (method, params) => {
      requests.push(method);
      if (method === "adoption.discover") {
        const cursor = (params as { readonly pageCursor?: string }).pageCursor;
        return {
          scanGeneration: "scan-1",
          candidates:
            cursor === undefined
              ? [candidate]
              : [
                  {
                    ...candidate,
                    candidateId: parseAdoptionCandidateId("123e4567-e89b-812d-a456-426614174001"),
                    displayName: "second",
                  },
                ],
          warnings: [
            {
              code: cursor === undefined ? "first-warning" : "second-warning",
              severity: "warning",
              message: cursor === undefined ? "first" : "second",
            },
          ],
          ...(cursor === undefined ? { nextPageCursor: "next" } : {}),
        } satisfies AdoptionDiscoverResult;
      }
      const cursor = (params as { readonly pageCursor?: string }).pageCursor;
      return {
        candidate,
        adapter: { id: "pi", version: "1", sourceSchemaVersion: "1" },
        license: { expressions: [], notices: [] },
        inventory: { fileCount: 1, totalBytes: 10, executable: true },
        limits: {
          maxTraversalDepth: 32,
          maxEntries: 50_000,
          maxFiles: 20_000,
          maxTotalBytes: 67_108_864,
          maxFileBytes: 1_048_576,
          maxManifestBytes: 262_144,
        },
        surfaceCount: 1,
        diagnosticCount: 1,
        detailOffset: cursor === undefined ? 0 : 1,
        surfaces:
          cursor === undefined
            ? [
                {
                  surfaceId: "b".repeat(64),
                  kind: "extension",
                  name: "hello",
                  relativePath: ".pi/extensions/hello.ts",
                  primary: true,
                  executable: true,
                  requiredCapabilities: [],
                  diagnosticCount: 0,
                  dynamicBehavior: "none",
                },
              ]
            : [],
        diagnostics:
          cursor === undefined ? [] : [{ code: "notice", severity: "info", message: "review" }],
        ...(cursor === undefined ? { nextPageCursor: "inspect-next" } : {}),
      } satisfies AdoptionInspectResult;
    },
  });
  const controller = new AdoptionController(fake);
  await controller.loadAll({ projectRoot: "/tmp/project", scopes: ["global", "project"] });
  assert.equal(controller.state.candidates.length, 2);
  assert.deepEqual(
    controller.state.warnings.map((warning) => warning.code),
    ["first-warning", "second-warning"],
  );
  assert.equal(controller.state.hasMore, false);
  assert.equal(Object.isFrozen(controller.state), true);
  const report = await controller.inspect(candidate);
  assert.equal(report?.surfaces.length, 1);
  assert.equal(report?.diagnostics.length, 1);
  assert.deepEqual(requests, [
    "adoption.discover",
    "adoption.discover",
    "adoption.inspect",
    "adoption.inspect",
  ]);
});

test("adoption controller exposes unavailable state and ignores a stale response", async () => {
  const unavailable = new AdoptionController(
    client({ capabilities: [], request: async () => Promise.reject(new Error("not used")) }),
  );
  assert.equal(unavailable.state.status, "unavailable");

  let resolveFirst!: (value: AdoptionDiscoverResult) => void;
  let instance = "daemon-1";
  const staleClient = {
    get connection() {
      return {
        daemonInstanceId: instance,
        grantedCapabilities: ["adoption.discover", "adoption.inspect"],
      };
    },
    request: () =>
      new Promise<AdoptionDiscoverResult>((resolvePromise) => {
        resolveFirst = resolvePromise;
      }),
  } as unknown as AxlClient;
  const controller = new AdoptionController(staleClient);
  const pending = controller.load();
  instance = "daemon-2";
  resolveFirst({ scanGeneration: "old", candidates: [candidate], warnings: [] });
  await pending;
  assert.equal(controller.state.candidates.length, 0);
  assert.equal(controller.state.status, "loading");
});

test("adoption dismissal is bound to one scan generation and refreshes are fresh", async () => {
  let scan = 0;
  const persisted: Array<string | undefined> = [];
  const controller = new AdoptionController(
    client({
      request: async () => {
        scan += 1;
        return {
          scanGeneration: `scan-${scan}`,
          candidates: [candidate],
          warnings: [],
        } satisfies AdoptionDiscoverResult;
      },
      capabilities: ["adoption.discover", "adoption.inspect"],
    }),
    {
      dismissedScanGeneration: "scan-1",
      onDismissedScanGeneration: (generation) => {
        persisted.push(generation);
      },
    },
  );
  await controller.load();
  assert.equal(controller.state.findingsDismissed, true);
  await controller.refresh();
  assert.equal(controller.state.scanGeneration, "scan-2");
  assert.equal(controller.state.findingsDismissed, false);
  controller.dismissFindings();
  assert.equal(controller.state.dismissedScanGeneration, "scan-2");
  assert.deepEqual(persisted, ["scan-2"]);
});
