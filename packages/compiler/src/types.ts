// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { InspectionLimits } from "./limits.ts";

export type Ecosystem = "opencode" | "dsh" | "claude-code" | "pi";
export type Scope = "global" | "project";
export type ResourceKind =
  | "package"
  | "extension"
  | "skill"
  | "hook"
  | "prompt"
  | "theme"
  | "mcp-server"
  | "agent"
  | "instructions"
  | "provider"
  | "workflow";
export type DiagnosticSeverity = "info" | "warning" | "error";

export interface DiscoveryDiagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly relativePath?: string;
}

export interface Provenance {
  readonly canonicalRoot: string;
  readonly relativePath: string;
  readonly sourceFileSha256?: string;
  readonly sourcePrecedence?: number;
}

export interface ResourceSurface {
  readonly kind: ResourceKind;
  readonly name: string;
  readonly relativePath: string;
  readonly primary: boolean;
  readonly executable: boolean;
  readonly registrations: readonly string[];
  readonly dynamicBehavior: boolean;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export interface PackageInventory {
  readonly packageName?: string;
  readonly version?: string;
  readonly dependencies: readonly string[];
  readonly peerDependencies: readonly string[];
  readonly lifecycleScripts: readonly string[];
  readonly gallery: Readonly<Record<string, string>>;
}

export interface DiscoveryCandidate {
  readonly candidateId: string;
  readonly discoveryFingerprint: string;
  readonly ecosystem: Ecosystem;
  readonly scope: Scope;
  readonly kind: ResourceKind;
  readonly displayName: string;
  readonly packageIdentity?: string;
  readonly provenance: Provenance;
  readonly primary: boolean;
  readonly executable: boolean;
  readonly malformed: boolean;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly sourceSchemaVersion: string;
  readonly surfaces: readonly ResourceSurface[];
  readonly inventory?: PackageInventory;
  readonly diagnostics: readonly DiscoveryDiagnostic[];
}

export interface DiscoveryResult {
  readonly candidates: readonly DiscoveryCandidate[];
  readonly diagnostics: readonly DiscoveryDiagnostic[];
  readonly appliedLimits: InspectionLimits;
}

export interface DiscoveryContext {
  readonly homeDirectory: string;
  readonly projectDirectory?: string;
  readonly projectTrusted: boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly limits?: Partial<InspectionLimits>;
}
