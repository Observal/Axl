// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { parseCapabilitySearchToolInput, ProtocolValidationError } from "../src/index.ts";

test("parses bounded capability search and activation variants", () => {
  assert.deepEqual(
    parseCapabilitySearchToolInput({ action: "search", query: "release", limit: 5 }),
    { action: "search", query: "release", limit: 5 },
  );
  assert.deepEqual(
    parseCapabilitySearchToolInput({ action: "activate", identities: ["skill:release"] }),
    { action: "activate", identities: ["skill:release"] },
  );
  assert.throws(
    () => parseCapabilitySearchToolInput({ action: "activate", identities: ["x", "x"] }),
    ProtocolValidationError,
  );
  assert.throws(
    () => parseCapabilitySearchToolInput({ action: "search", query: "x", limit: 11 }),
    ProtocolValidationError,
  );
});
