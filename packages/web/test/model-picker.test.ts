// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { ModelChoice } from "@axl/sdk";
import {
  filterModelChoices,
  isModelPickerShortcut,
  nextThinkingLevel,
} from "../src/model-picker-state.ts";

test("recognizes the Pi-equivalent model shortcut", () => {
  assert.equal(isModelPickerShortcut({ key: "l", ctrlKey: true, metaKey: false }), true);
  assert.equal(isModelPickerShortcut({ key: "L", ctrlKey: false, metaKey: true }), true);
  assert.equal(isModelPickerShortcut({ key: "l", ctrlKey: false, metaKey: false }), false);
});

const choices: readonly ModelChoice[] = [
  {
    providerId: "anthropic",
    providerDisplayName: "Anthropic",
    modelId: "claude-sonnet",
    displayName: "Claude Sonnet",
    thinkingLevels: ["off", "low", "high"],
    availability: { status: "available" },
  },
  {
    providerId: "openai",
    providerDisplayName: "OpenAI",
    modelId: "gpt",
    displayName: "GPT",
    thinkingLevels: ["low", "medium"],
    availability: { status: "unavailable", reason: "Sign in required" },
  },
];

test("filters models across provider identity and groups by provider", () => {
  assert.deepEqual([...filterModelChoices(choices, "anthropic").keys()], ["anthropic"]);
  assert.deepEqual([...filterModelChoices(choices, "GPT").keys()], ["openai"]);
  assert.equal(filterModelChoices(choices, "missing").size, 0);
});

test("cycles only the selected model's supported thinking levels", () => {
  assert.equal(nextThinkingLevel(choices, "anthropic", "claude-sonnet", "low"), "high");
  assert.equal(nextThinkingLevel(choices, "anthropic", "claude-sonnet", "high"), "off");
  assert.equal(nextThinkingLevel(choices, "missing", "model", "low"), undefined);
});
