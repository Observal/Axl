// SPDX-FileCopyrightText: 2026 PranavD2905
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { type ControlCenterTab, controlCenterSections } from "../src/control-center-sections.ts";

test("exactly one control center section is selected for each tab", () => {
  const tabs: readonly ControlCenterTab[] = ["settings", "providers", "mcp"];
  for (const tab of tabs) {
    const sections = controlCenterSections(tab);
    assert.deepEqual(
      sections.map((section) => section.label),
      ["Settings", "Providers", "MCP"],
    );
    assert.deepEqual(
      sections.filter((section) => section.selected).map((section) => section.tab),
      [tab],
    );
  }
});
