// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { DaemonExtensionFactory } from "@axl/extension-api";

/** First-party extension diagnostics implemented through the public daemon extension API. */
export const extensionDiagnosticsExtension: DaemonExtensionFactory = (axl) => {
  axl.registerCommand({
    name: "extensions",
    description: "list daemon extensions and lifecycle diagnostics",
    async execute() {
      const { extensions } = await axl.session.extensions();
      return extensions.length === 0
        ? "No daemon extensions discovered."
        : extensions
            .map(
              (extension) =>
                `${extension.enabled ? "enabled" : "disabled"} ${extension.id} (${extension.source})${extension.error === undefined ? "" : `: ${extension.error}`}`,
            )
            .join("\n");
    },
  });
};
