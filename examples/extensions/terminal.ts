// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { TerminalExtension } from "@observal/axl/extension-api";

const terminal: TerminalExtension = {
  manifest: {
    id: "example-terminal",
    name: "Example terminal extension",
    capabilities: [
      "terminal.commands",
      "terminal.shortcuts",
      "terminal.status",
      "terminal.widgets",
      "terminal.ui",
    ],
  },
  activate(ui) {
    ui.registerStatus("ready", { text: "Example extension ready", tone: "success" });
    ui.registerWidget("summary", {
      placement: "aboveEditor",
      render: () => [{ text: "Use /hello to greet the terminal", tone: "accent" }],
    });
    ui.registerCommand({
      name: "hello",
      description: "Greet the current terminal",
      run: async (_arguments, ctx) => {
        const choice = await ctx.select("Who should we greet?", [
          { value: "world", label: "World" },
          { value: "axl", label: "Axl" },
        ]);
        if (choice !== undefined) ctx.notify(`Hello, ${choice}!`, "success");
      },
    });
    ui.registerCommand({
      name: "note",
      description: "Edit a multiline terminal note",
      run: async (_arguments, ctx) => {
        const note = await ctx.editor("Your note");
        if (note !== undefined) ctx.notify(`Saved ${note.length} characters`, "success");
      },
    });
    ui.registerShortcut({
      key: "\u0010",
      description: "Show terminal greeting",
      run: (ctx) => ctx.notify("Hello from the shortcut", "accent"),
    });
  },
};

export default terminal;
