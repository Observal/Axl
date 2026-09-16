// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_COMPACTION_SETTINGS,
  parseCompactionPreferences,
  resolveCompactionSettings,
} from "../src/index.ts";

test("compaction preferences resolve exact provider and model overrides", () => {
  const preferences = parseCompactionPreferences({
    enabled: true,
    reserveTokens: 12_000,
    keepRecentTokens: 20_000,
    modelOverrides: {
      "anthropic/claude-sonnet": { reserveTokens: 24_000 },
    },
  });
  assert.deepEqual(resolveCompactionSettings(preferences, "anthropic", "claude-sonnet"), {
    enabled: true,
    reserveTokens: 24_000,
    keepRecentTokens: 20_000,
  });
  assert.deepEqual(
    resolveCompactionSettings(undefined, "openai", "gpt"),
    DEFAULT_COMPACTION_SETTINGS,
  );
});

test("compaction preferences reject invalid limits and ambiguous model keys", () => {
  assert.throws(() => parseCompactionPreferences({ reserveTokens: 0 }), /reserveTokens/);
  assert.throws(
    () => parseCompactionPreferences({ modelOverrides: { model: { enabled: false } } }),
    /provider\/model/,
  );
});
