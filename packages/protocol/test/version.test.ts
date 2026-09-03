// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { EVENT_FORMAT_VERSION, WIRE_PROTOCOL_VERSION } from "../src/index.ts";

test("keeps event format 1 and uses wire protocol 5 for manual compaction", () => {
  assert.equal(EVENT_FORMAT_VERSION, 1);
  assert.equal(WIRE_PROTOCOL_VERSION, 5);
});
