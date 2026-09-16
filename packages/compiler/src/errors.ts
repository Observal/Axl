// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

export type DiscoveryErrorCode =
  | "adoption_manifest_invalid"
  | "adoption_project_untrusted"
  | "adoption_scan_limit_exceeded"
  | "adoption_source_changed"
  | "adoption_source_schema_unsupported"
  | "adoption_source_unavailable";

export class DiscoveryError extends Error {
  readonly code: DiscoveryErrorCode;
  readonly relativePath?: string;

  constructor(code: DiscoveryErrorCode, message: string, relativePath?: string) {
    super(message);
    this.name = "DiscoveryError";
    this.code = code;
    if (relativePath !== undefined) this.relativePath = relativePath;
  }
}
