// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { type AdoptionDiscoverResult, type AxlClient, parseAdoptionCandidateId } from "@axl/sdk";
import { runAdoptionScan } from "../src/adoption-cli.ts";

const result: AdoptionDiscoverResult = {
  scanGeneration: "scan-1",
  candidates: [
    {
      candidateId: parseAdoptionCandidateId("123e4567-e89b-812d-a456-426614174000"),
      discoveryFingerprint: "a".repeat(64),
      ecosystem: "opencode",
      scope: "project",
      kind: "extension",
      displayName: "math",
      source: { kind: "local", canonicalPath: "/workspace/.opencode/tools/math.ts" },
      relativeResourcePath: ".opencode/tools/math.ts",
      primary: true,
      executable: true,
      resourceCount: 2,
      warningCount: 1,
      malformed: false,
    },
  ],
  warnings: [{ code: "review", severity: "warning", message: "Review executable source" }],
};

function fakeClient(requests: unknown[] = []): AxlClient {
  return {
    connection: {
      daemonInstanceId: "daemon-1",
      grantedCapabilities: ["adoption.discover"],
    },
    request: async (_method: string, params: unknown) => {
      requests.push(params);
      return result;
    },
  } as unknown as AxlClient;
}

test("CLI adoption scan renders human and JSON output through the SDK", async () => {
  let human = "";
  const requests: unknown[] = [];
  await runAdoptionScan({
    client: fakeClient(requests),
    json: false,
    write: (value) => {
      human += value;
    },
  });
  assert.match(human, /opencode · project/u);
  assert.match(human, /math · extension · 2 resources · executable · 1 warning/u);
  assert.match(human, /review · Review executable source/u);
  assert.deepEqual(requests, [{ scopes: ["global"], includeMalformed: true, pageSize: 100 }]);

  let json = "";
  await runAdoptionScan({
    client: fakeClient(),
    json: true,
    write: (value) => {
      json += value;
    },
  });
  const parsed = JSON.parse(json) as { scanGeneration: string; candidates: readonly unknown[] };
  assert.equal(parsed.scanGeneration, "scan-1");
  assert.equal(parsed.candidates.length, 1);
});
