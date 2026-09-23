// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

// Point an axl.web package manifest at this self-contained browser module.
export default {
  manifest: { id: "example-browser", name: "Example browser extension", apiVersion: 1 },
  activate(api) {
    api.registerStatus("ready", "Browser extension ready");
    api.registerWidget("hint", "Use /hello-web to test the browser extension.");
    api.registerCommand({
      name: "hello-web",
      description: "Show a browser notification",
      run: () => api.ui.notify("Hello from the browser extension"),
    });
  },
};
