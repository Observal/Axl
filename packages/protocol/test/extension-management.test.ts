// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseExtensionInstallParams,
  parseExtensionListResult,
  parseExtensionTrustParams,
  ProtocolValidationError,
} from "../src/index.ts";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";

test("validates extension install sources and project trust", () => {
  assert.deepEqual(
    parseExtensionInstallParams({
      sessionId,
      source: { type: "git", url: "https://example.com/ext.git", ref: "a".repeat(40) },
    }),
    {
      sessionId,
      source: { type: "git", url: "https://example.com/ext.git", ref: "a".repeat(40) },
    },
  );
  assert.deepEqual(parseExtensionTrustParams({ sessionId, trusted: true }), {
    sessionId,
    trusted: true,
  });
  assert.throws(
    () =>
      parseExtensionInstallParams({ sessionId, source: { type: "npm", spec: "pkg", extra: 1 } }),
    ProtocolValidationError,
  );
});

test("validates extension inventory and mutation results", () => {
  const listed = {
    configPath: "/home/user/.axl/extensions.json",
    project: { root: "/workspace", trusted: true },
    extensions: [
      {
        id: "example",
        path: "/home/user/.axl/extensions/example.js",
        source: "global",
        enabled: true,
      },
    ],
  } as const;
  assert.deepEqual(parseExtensionListResult(listed), listed);
  assert.throws(
    () =>
      parseExtensionListResult({
        ...listed,
        extensions: [{ ...listed.extensions[0], source: "unknown" }],
      }),
    ProtocolValidationError,
  );
});
