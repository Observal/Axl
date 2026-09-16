// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { AdoptionCandidate } from "@axl/sdk";

export function adoptionCandidateDescription(candidate: AdoptionCandidate): string {
  const resources = candidate.resourceCount ?? 1;
  return [
    `${candidate.kind} · ${resources} resource${resources === 1 ? "" : "s"}`,
    candidate.executable ? "executable" : "declarative",
    candidate.malformed ? "malformed" : undefined,
    candidate.warningCount > 0
      ? `${candidate.warningCount} warning${candidate.warningCount === 1 ? "" : "s"}`
      : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
}

export function groupAdoptionCandidates(
  candidates: readonly AdoptionCandidate[],
): ReadonlyMap<string, readonly AdoptionCandidate[]> {
  const groups = new Map<string, AdoptionCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.ecosystem} · ${candidate.scope}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  return groups;
}
