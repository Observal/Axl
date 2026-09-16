// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { AdoptionCandidate, AdoptionInspectResult } from "@axl/sdk";
import type { PickerItem } from "./picker.ts";
import { sanitizeTerminalText } from "./render.ts";

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function adoptionPickerItems(
  candidates: readonly AdoptionCandidate[],
): readonly PickerItem[] {
  return [
    { value: "__rescan__", label: "↻ Rescan", description: "refresh all approved roots" },
    {
      value: "__dismiss__",
      label: "Dismiss findings",
      description: "keep scan truth and hide the startup notice",
    },
    ...candidates.map((candidate) => ({
      value: candidate.candidateId,
      label: `${candidate.ecosystem} · ${candidate.scope} · ${candidate.displayName}`,
      description: [
        `${candidate.resourceCount ?? 1} ${candidate.kind}`,
        candidate.executable ? "executable" : "declarative",
        candidate.malformed ? "malformed" : undefined,
        candidate.warningCount > 0 ? plural(candidate.warningCount, "warning") : undefined,
      ]
        .filter((value): value is string => value !== undefined)
        .join(" · "),
    })),
  ];
}

export function adoptionInspectionLines(report: AdoptionInspectResult): readonly string[] {
  const candidate = report.candidate;
  return [
    `Adoption inspection · ${sanitizeTerminalText(candidate.displayName)}`,
    `  source      ${candidate.ecosystem} · ${candidate.scope} · ${candidate.kind}`,
    `  adapter     ${report.adapter.id} ${report.adapter.version}`,
    `  inventory   ${plural(report.inventory.fileCount, "file")} · ${report.inventory.totalBytes} bytes`,
    `  execution   ${report.inventory.executable ? "contains executable surfaces" : "declarative only"}`,
    `  status      ${candidate.malformed ? "malformed" : "recognized"} · ${plural(report.diagnosticCount, "diagnostic")}`,
    ...report.surfaces.map(
      (surface) =>
        `  surface     ${surface.kind} · ${sanitizeTerminalText(surface.name)}${surface.executable ? " · executable" : ""}${surface.dynamicBehavior === "unknown" ? " · dynamic behavior unknown" : ""}`,
    ),
    ...report.diagnostics.map(
      (entry) => `  ${entry.severity}     ${entry.code} · ${sanitizeTerminalText(entry.message)}`,
    ),
    "  Inspection only. No source was executed and no installation or activation occurred.",
  ];
}
