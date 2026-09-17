// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { previewFixture } from "../src/preview.fixture.ts";

test("tracked browser fixture projects one configurable Code session", () => {
  assert.equal(previewFixture.sessions.length, 1);
  assert.equal(previewFixture.opened.profile, "standard");
  assert.equal(previewFixture.conversation.profile, "standard");
  assert.equal(previewFixture.modelCatalog?.[0]?.providerId, "anthropic");
  assert.equal(previewFixture.conversation.webSearch, true);
  assert.equal(previewFixture.conversation.webFetch, true);
});
