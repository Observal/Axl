// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { McpServerDefinition } from "@axl/protocol";

export function mcpServerPresets(cwd: string): Readonly<Record<string, McpServerDefinition>> {
  return {
    deepwiki: { url: "https://mcp.deepwiki.com/mcp" },
    context7: { url: "https://mcp.context7.com/mcp" },
    microsoftLearn: { url: "https://learn.microsoft.com/api/mcp" },
    filesystem: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31", cwd],
      roots: [cwd],
    },
    memory: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory@2026.8.31"],
    },
  };
}
