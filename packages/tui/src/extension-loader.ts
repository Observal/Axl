// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import type { TerminalExtension } from "@axl/extension-api";
import type { ExtensionListResult } from "@axl/protocol";

/** Loads only daemon-approved, enabled terminal entry points on the local client host. */
export async function loadTerminalExtensions(
  inventory: ExtensionListResult,
): Promise<readonly TerminalExtension[]> {
  const loaded: TerminalExtension[] = [];
  for (const entry of inventory.extensions) {
    if (!entry.enabled || entry.tuiPath === undefined) continue;
    const path = await realpath(entry.tuiPath);
    if (path !== entry.tuiPath) {
      throw new Error(
        `Extension ${entry.id} terminal entry changed since discovery: ${entry.tuiPath}`,
      );
    }
    const url = pathToFileURL(path);
    url.searchParams.set(
      "source",
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    );
    let module: unknown;
    try {
      module = await import(url.href);
    } catch (cause) {
      throw new Error(`Extension ${entry.id} terminal entry ${path} failed to import`, { cause });
    }
    const definition = (module as { default?: unknown }).default;
    if (
      typeof definition !== "object" ||
      definition === null ||
      (definition as TerminalExtension).manifest?.id !== entry.id ||
      typeof (definition as TerminalExtension).activate !== "function"
    ) {
      throw new Error(
        `Extension ${entry.id} terminal entry ${path} must export a TerminalExtension with matching manifest id`,
      );
    }
    loaded.push(definition as TerminalExtension);
  }
  return loaded;
}
