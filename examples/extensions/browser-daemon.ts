// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { DaemonExtensionFactory } from "@observal/axl/extension-api";

const extension: DaemonExtensionFactory = (axl) => {
  axl.registerTool({
    name: "browser_echo",
    description: "Return a greeting for the browser renderer",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    execute: (input) => ({ content: [{ type: "text", text: `Hello, ${String(input.name)}!` }] }),
  });
  axl.registerCommand({
    name: "web-example-event",
    description: "Publish sample extension messages for the web renderer",
    execute: async () => {
      await axl.emit("sample", { text: "Visible in the browser" });
      await axl.session.sendExtensionMessage("sample", "Example daemon context");
      return "Example events published";
    },
  });
};

export default extension;
