// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseStagedWebToolValue,
  profileSupportsWebTools,
  stagedWebToolValue,
  webToolConfiguration,
} from "../src/web-tools.ts";

test("web tool controls are available only to the standard Code profile", () => {
  assert.equal(profileSupportsWebTools("standard"), true);
  assert.equal(profileSupportsWebTools("chat"), false);
  assert.equal(profileSupportsWebTools("minimal"), false);
  assert.equal(profileSupportsWebTools("exec"), false);
  assert.equal(profileSupportsWebTools(undefined), false);
});

test("web tool mutations map to one typed configuration field", () => {
  assert.deepEqual(webToolConfiguration("webSearch", true), { webSearch: true });
  assert.deepEqual(webToolConfiguration("webFetch", false), { webFetch: false });
});

test("staged web tool controls preserve daemon defaults and explicit choices", () => {
  assert.equal(stagedWebToolValue(undefined), "default");
  assert.equal(stagedWebToolValue(true), "on");
  assert.equal(stagedWebToolValue(false), "off");
  assert.equal(parseStagedWebToolValue("default"), undefined);
  assert.equal(parseStagedWebToolValue("on"), true);
  assert.equal(parseStagedWebToolValue("off"), false);
});
