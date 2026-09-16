// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { parseAdoptionCandidateId, type AdoptionInspectResult } from "@axl/sdk";
import { adoptionInspectionLines, adoptionPickerItems } from "../src/adoption-presentation.ts";

const candidate = {
  candidateId: parseAdoptionCandidateId("123e4567-e89b-812d-a456-426614174000"),
  discoveryFingerprint: "a".repeat(64),
  ecosystem: "pi" as const,
  scope: "project" as const,
  kind: "extension" as const,
  displayName: "hello",
  source: { kind: "local" as const, canonicalPath: "/workspace/.pi/extensions" },
  relativeResourcePath: ".pi/extensions/hello.ts",
  primary: true,
  executable: true,
  resourceCount: 1,
  warningCount: 1,
  malformed: true,
};

test("TUI adoption presentation exposes rescan and inspection-only warnings", () => {
  const items = adoptionPickerItems([candidate]);
  assert.deepEqual(
    items.map((item) => item.value),
    ["__rescan__", "__dismiss__", candidate.candidateId],
  );
  assert.match(items[2]?.description ?? "", /executable · malformed · 1 warning/u);

  const report: AdoptionInspectResult = {
    candidate,
    adapter: { id: "pi", version: "1", sourceSchemaVersion: "1" },
    license: { expressions: [], notices: [] },
    inventory: { fileCount: 1, totalBytes: 42, executable: true },
    limits: {
      maxTraversalDepth: 32,
      maxEntries: 50_000,
      maxFiles: 20_000,
      maxTotalBytes: 67_108_864,
      maxFileBytes: 1_048_576,
      maxManifestBytes: 262_144,
    },
    surfaceCount: 0,
    diagnosticCount: 1,
    detailOffset: 0,
    surfaces: [],
    diagnostics: [{ code: "malformed", severity: "error", message: "Invalid source" }],
  };
  const text = adoptionInspectionLines(report).join("\n");
  assert.match(text, /contains executable surfaces/u);
  assert.match(text, /No source was executed/u);
  assert.doesNotMatch(text, /Install|Activate/u);
});
