// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { TerminalExtension } from "@axl/extension-api";

export const mcpTerminalExtension: TerminalExtension = {
  manifest: {
    id: "axl.mcp",
    name: "Model Context Protocol",
    capabilities: ["terminal.tool-renderers"],
  },
  activate(api) {
    api.registerToolRenderer("mcp", ({ arguments: input }) => {
      const server = typeof input.server === "string" ? input.server : undefined;
      const action = typeof input.action === "string" ? input.action : undefined;
      const name = typeof input.name === "string" ? input.name : undefined;
      return {
        label: "MCP",
        target: [server, name ?? action].filter(Boolean).join(" · "),
        hideWhenSuccessfulInFocus: true,
      };
    });
  },
};

export * from "./config.ts";
export * from "./manager.ts";
export * from "./task-store.ts";
export * from "./types.ts";
