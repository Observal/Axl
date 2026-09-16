// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { BoundedFileSystem } from "./filesystem.ts";
import type {
  DiscoveryCandidate,
  DiscoveryContext,
  DiscoveryDiagnostic,
  Ecosystem,
} from "./types.ts";

export interface AdapterResult {
  readonly candidates: readonly DiscoveryCandidate[];
  readonly diagnostics: readonly DiscoveryDiagnostic[];
}

export interface SourceAdapter {
  readonly ecosystem: Ecosystem;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly sourceSchemaVersions: readonly string[];
  discover(context: DiscoveryContext, fileSystem: BoundedFileSystem): Promise<AdapterResult>;
}

export function assertPrimarySurface(candidate: DiscoveryCandidate): void {
  const primaries = candidate.surfaces.filter((surface) => surface.primary);
  if (primaries.length !== 1) {
    throw new Error(`candidate ${candidate.candidateId} must have exactly one primary surface`);
  }
}
