// SPDX-FileCopyrightText: 2026 SHAURYA JAIN
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closestMatch } from "../src/closest-match.ts";

test("returns the candidate on an exact match", () => {
  assert.equal(closestMatch("/help", ["/help", "/theme", "/commands"]), "/help");
});

test("returns a near match at distance 1", () => {
  assert.equal(closestMatch("/hel", ["/help", "/theme", "/commands"]), "/help");
});

test("returns a near match at distance 2", () => {
  assert.equal(closestMatch("/ocen", ["/ocean", "/dark", "/light"]), "/ocean");
});

test("returns undefined when the closest candidate is beyond maxDistance", () => {
  assert.equal(closestMatch("/xyz", ["/help", "/theme", "/commands"]), undefined);
});

test("returns undefined for an empty candidate list", () => {
  assert.equal(closestMatch("/help", []), undefined);
});

test("returns the single candidate when it is within maxDistance", () => {
  assert.equal(closestMatch("/hel", ["/help"]), "/help");
});

test("returns undefined for a single candidate beyond maxDistance", () => {
  assert.equal(closestMatch("/xyz", ["/help"]), undefined);
});

test("picks the closer of two near candidates", () => {
  assert.equal(closestMatch("/hepl", ["/theme", "/help"]), "/help");
});

test("respects a custom maxDistance of 1", () => {
  assert.equal(closestMatch("/hel", ["/help"], 1), "/help");
  assert.equal(closestMatch("/hxyz", ["/help"], 1), undefined);
});

test("length difference alone exceeding maxDistance skips the candidate", () => {
  assert.equal(closestMatch("/h", ["/help"]), undefined);
});
