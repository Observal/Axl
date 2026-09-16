// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { AdoptionController, type AxlClient } from "@axl/sdk";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function bounded(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_OUTPUT_BYTES) {
    throw new Error("Adoption scan output exceeds the 4 MiB CLI limit; narrow the scan");
  }
  return value;
}

export async function runAdoptionScan(input: {
  readonly client: AxlClient;
  readonly json: boolean;
  readonly write: (value: string) => void;
}): Promise<void> {
  const controller = new AdoptionController(input.client);
  try {
    // A non-interactive CLI has no opened Axl session root, so it scans only
    // daemon-approved global locations. Project scans require an opened session.
    const state = await controller.loadAll({
      scopes: ["global"],
      includeMalformed: true,
    });
    if (state.status !== "ready") {
      throw new Error(state.error?.message ?? "Adoption discovery is unavailable");
    }
    if (input.json) {
      input.write(
        bounded(
          `${JSON.stringify({
            scanGeneration: state.scanGeneration,
            candidates: state.candidates,
            warnings: state.warnings,
          })}\n`,
        ),
      );
      return;
    }
    const lines: string[] = [];
    let group = "";
    for (const candidate of state.candidates) {
      const nextGroup = `${candidate.ecosystem} · ${candidate.scope}`;
      if (nextGroup !== group) {
        if (lines.length > 0) lines.push("");
        lines.push(nextGroup);
        group = nextGroup;
      }
      const resourceCount = candidate.resourceCount ?? 1;
      lines.push(
        `  ${candidate.displayName} · ${candidate.kind} · ${resourceCount} resource${resourceCount === 1 ? "" : "s"}${candidate.executable ? " · executable" : ""}${candidate.malformed ? " · malformed" : ""}${candidate.warningCount > 0 ? ` · ${candidate.warningCount} warning${candidate.warningCount === 1 ? "" : "s"}` : ""}`,
      );
    }
    if (state.candidates.length === 0) lines.push("No supported resources found.");
    if (state.warnings.length > 0) {
      lines.push("", "Scan diagnostics");
      for (const warning of state.warnings) {
        lines.push(
          `  ${warning.severity} · ${warning.code} · ${warning.message}${warning.relativePath === undefined ? "" : ` · ${warning.relativePath}`}`,
        );
      }
    }
    input.write(bounded(`${lines.join("\n")}\n`));
  } finally {
    controller.dispose();
  }
}
