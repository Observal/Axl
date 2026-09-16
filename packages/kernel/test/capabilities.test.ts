// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { CapabilityRecord } from "@axl/protocol";

import { CapabilityIndex, ToolCapabilityService } from "../src/index.ts";

function capability(
  identity: string,
  name: string,
  description: string,
  options: Partial<CapabilityRecord> = {},
): CapabilityRecord {
  return {
    identity,
    kind: "skill",
    name,
    description,
    aliases: [],
    path: `/skills/${name}/SKILL.md`,
    scope: "global",
    provenance: "fixture",
    enabled: true,
    trust: "trusted",
    available: true,
    requiredAuthority: ["skills.activate"],
    ...options,
  };
}

const authority = new Set(["skills.activate"]);

test("ranks exact names, aliases, BM25 terms, scope, and identity deterministically", () => {
  const index = new CapabilityIndex(
    [
      capability("skill:publish", "publish", "Publish packages"),
      capability(
        "skill:release-global",
        "release-global",
        "Publish release notes and npm packages",
        {
          aliases: ["ship"],
        },
      ),
      capability(
        "skill:release-project",
        "release-project",
        "Publish release notes and npm packages",
        {
          aliases: ["ship"],
          scope: "project",
        },
      ),
    ],
    authority,
  );

  assert.equal(index.search("publish", 5)[0]?.identity, "skill:publish");
  assert.deepEqual(
    index.search("ship", 5).map((result) => result.identity),
    ["skill:release-project", "skill:release-global"],
  );
  assert.deepEqual(
    index.search("npm notes", 1).map((result) => result.identity),
    ["skill:release-project"],
  );
  assert.deepEqual(index.search("unrelated", 5), []);
});

test("activates authorized built-in tool capabilities and denies missing authority", async () => {
  const record = capability("tool:compact-context", "compact context", "Compact context", {
    kind: "tool",
    path: "builtin:compact_context",
    requiredAuthority: ["session.compact"],
  });
  const allowed = new ToolCapabilityService([record], new Set(["session.compact"]));
  assert.equal(
    (await allowed.activate([record.identity])).activated[0]?.capability.identity,
    record.identity,
  );

  const denied = new ToolCapabilityService([record], new Set());
  assert.match((await denied.activate([record.identity])).denied[0]?.reason ?? "", /authority/);
});

test("excludes disabled, unavailable, untrusted, and unauthorized records", () => {
  const index = new CapabilityIndex(
    [
      capability("skill:disabled", "disabled", "release", { enabled: false }),
      capability("skill:missing", "missing", "release", { available: false }),
      capability("skill:untrusted", "untrusted", "release", { trust: "untrusted" }),
      capability("skill:denied", "denied", "release", {
        requiredAuthority: ["skills.admin"],
      }),
    ],
    authority,
  );
  assert.deepEqual(index.search("release", 10), []);
});
