// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { mcpServerPresets } from "../src/mcp.ts";

test("MCP presets cover remote and workspace-scoped stdio servers", () => {
  const presets = mcpServerPresets("/workspace");
  assert.equal(
    presets.context7 && "url" in presets.context7 ? presets.context7.url : undefined,
    "https://mcp.context7.com/mcp",
  );
  assert.deepEqual(
    presets.filesystem && "command" in presets.filesystem ? presets.filesystem.roots : undefined,
    ["/workspace"],
  );
});
