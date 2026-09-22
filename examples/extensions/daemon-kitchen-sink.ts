// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { DaemonExtensionFactory } from "@observal/axl/extension-api";

const extension: DaemonExtensionFactory = (axl) => {
  axl.on("resources_discover", () => [
    { name: "example-guidance", content: "Prefer concise, verified answers." },
  ]);
  axl.on("tool.call", (event) => {
    if (event.name === "bash" && event.input.command === "rm -rf /") {
      return { block: true, reason: "destructive command" };
    }
    return undefined;
  });
  axl.on("tool.result", (event) => ({ isError: event.isError }));
  axl.on("before_agent_start", () => [
    { source: "example", content: "This turn is using the example extension." },
  ]);
  axl.on("before_provider_headers", (event) => event.headers);
  axl.on("before_provider_request", (event) => event.payload);
  axl.on("after_provider_response", () => undefined);
  axl.on("session_compact", () => undefined);
  axl.on("session_compact_failed", () => undefined);

  axl.registerTool({
    name: "example_counter",
    description: "Increment the session-local example counter",
    inputSchema: { type: "object", additionalProperties: false },
    async execute(_input, _signal, context) {
      const count = Number(axl.state.get("count") ?? 0) + 1;
      await axl.state.set("count", count);
      context.reportProgress({ count });
      return { content: [{ type: "text", text: String(count) }] };
    },
  });

  axl.registerCommand({
    name: "extension-info",
    description: "Show the current daemon extension session state",
    execute: async () => JSON.stringify(await axl.session.info()),
  });
};

export default extension;
