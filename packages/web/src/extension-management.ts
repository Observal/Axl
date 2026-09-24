// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { WebExtension } from "@axl/extension-api";
import type { AxlClient, SessionId } from "@axl/sdk";

/** First-party browser feature registered through the same public host as installed modules. */
export function extensionManagement(client: AxlClient, sessionId: SessionId): WebExtension {
  return {
    manifest: { id: "axl-web-management", name: "Browser extension management", apiVersion: 1 },
    activate(api) {
      api.registerCommand({
        name: "browser-extensions",
        description: "Inspect and manage extensions in this session",
        run: async () => {
          const inventory = await client.listExtensions({ sessionId });
          if (inventory.extensions.length === 0) {
            api.ui.notify("No extensions installed");
            return;
          }
          const labels = inventory.extensions.map(
            (entry) =>
              `${entry.id} · ${entry.enabled ? "enabled" : "disabled"} · ${entry.source}${entry.error ? ` · ${entry.error}` : ""}`,
          );
          const selected = await api.ui.select("Extensions", labels);
          const entry = inventory.extensions[labels.indexOf(selected ?? "")];
          if (entry === undefined) return;
          const action = await api.ui.select(entry.id, [
            entry.enabled ? "Disable" : "Enable",
            "Reload",
            "Details",
          ]);
          if (action === "Details") {
            api.ui.notify(
              `${entry.id}: ${entry.path} (${entry.source})${entry.error ? ` · ${entry.error}` : ""}`.slice(
                0,
                512,
              ),
            );
          } else if (action === "Reload") {
            await client.reloadExtension({ sessionId, extensionId: entry.id });
            api.ui.notify(`${entry.id} reloaded`);
          } else if (action === "Enable") {
            await client.enableExtension({ sessionId, extensionId: entry.id });
            api.ui.notify(`${entry.id} enabled`);
          } else if (action === "Disable") {
            await client.disableExtension({ sessionId, extensionId: entry.id });
            api.ui.notify(`${entry.id} disabled`);
          }
        },
      });
    },
  };
}
