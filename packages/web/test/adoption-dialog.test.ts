// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { parseAdoptionCandidateId } from "@axl/sdk";
import {
  adoptionCandidateDescription,
  groupAdoptionCandidates,
} from "../src/adoption-presentation.ts";

const candidate = {
  candidateId: parseAdoptionCandidateId("123e4567-e89b-812d-a456-426614174000"),
  discoveryFingerprint: "a".repeat(64),
  ecosystem: "pi" as const,
  scope: "project" as const,
  kind: "extension" as const,
  displayName: "hello",
  source: { kind: "local" as const, canonicalPath: "/workspace/.pi/extensions/hello.ts" },
  relativeResourcePath: ".pi/extensions/hello.ts",
  primary: true,
  executable: true,
  resourceCount: 1,
  warningCount: 1,
  malformed: true,
};

test("web adoption presentation groups and labels executable malformed resources", () => {
  assert.deepEqual([...groupAdoptionCandidates([candidate]).keys()], ["pi · project"]);
  assert.equal(
    adoptionCandidateDescription(candidate),
    "extension · 1 resource · executable · malformed · 1 warning",
  );
});
