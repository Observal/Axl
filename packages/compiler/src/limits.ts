// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

export interface InspectionLimits {
  readonly maxRoots: number;
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
  readonly maxManifestBytes: number;
  readonly maxPathBytes: number;
  readonly maxNameBytes: number;
  readonly maxCandidates: number;
  readonly maxSurfacesPerCandidate: number;
  readonly maxDiagnostics: number;
  readonly maxGlobMatches: number;
}

export const DEFAULT_INSPECTION_LIMITS: InspectionLimits = Object.freeze({
  maxRoots: 32,
  maxDepth: 32,
  maxEntries: 50_000,
  maxFiles: 20_000,
  maxTotalBytes: 67_108_864,
  maxFileBytes: 1_048_576,
  maxManifestBytes: 262_144,
  maxPathBytes: 4_096,
  maxNameBytes: 256,
  maxCandidates: 10_000,
  maxSurfacesPerCandidate: 10_000,
  maxDiagnostics: 10_000,
  maxGlobMatches: 10_000,
});
