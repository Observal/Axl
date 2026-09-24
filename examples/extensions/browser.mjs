// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

// Install together with browser-daemon.ts using the package manifest in README.md.
export default {
  manifest: { id: "example-browser", name: "Example browser extension", apiVersion: 1 },
  activate(api) {
    api.registerStatus("ready", "Browser extension ready");
    api.registerWidget("greeting", {
      mount(root, signal) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Choose a greeting";
        const choose = () => {
          void api.ui.select("Greet whom?", ["World", "Axl"]).then((choice) => {
            if (choice !== undefined && !signal.aborted) api.ui.notify(`Hello, ${choice}!`);
          }).catch((cause) => { if (!signal.aborted) api.ui.notify(`Greeting failed: ${String(cause)}`); });
        };
        button.addEventListener("click", choose);
        root.append(button);
        return () => button.removeEventListener("click", choose);
      },
    });
    api.registerCommand({
      name: "hello-web",
      description: "Show a cancellable browser greeting dialog",
      run: async () => {
        const name = await api.ui.input("Who should we greet?", "World");
        if (name !== undefined) api.ui.notify(`Hello, ${name}!`);
      },
    });
    api.registerCommand({
      name: "note-web",
      description: "Edit a browser-local multiline note",
      run: async () => {
        const note = await api.ui.editor("Your note");
        if (note !== undefined) api.ui.notify(`Saved ${note.length} characters`);
      },
    });
    api.registerShortcut({
      key: "Ctrl+Shift+Y",
      description: "Show the browser extension greeting",
      run: () => api.ui.notify("Hello from the web shortcut"),
    });
    api.registerToolRenderer("browser_echo", (tool) =>
      `Example tool ${tool.result === undefined ? "running" : "finished"}`,
    );
    api.registerMessageRenderer("sample", (event) => `Example context: ${event.payload.content}`);
    api.registerEntryRenderer("sample", (event) => `Example event: ${JSON.stringify(event.payload.value)}`);
    api.onEvent((event) => {
      if (event.type === "working.start") api.ui.notify("Example extension: response started");
    });
  },
};
