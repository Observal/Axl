// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

export type AcquisitionErrorCode =
  | "archive_entry_unsupported"
  | "archive_invalid"
  | "archive_limit_exceeded"
  | "archive_path_invalid"
  | "credential_unavailable"
  | "git_invalid"
  | "git_unsupported"
  | "integrity_mismatch"
  | "network_unavailable"
  | "npm_metadata_invalid"
  | "source_mutable"
  | "source_unavailable";

export class AcquisitionError extends Error {
  readonly code: AcquisitionErrorCode;

  constructor(code: AcquisitionErrorCode, message: string) {
    super(message);
    this.name = "AcquisitionError";
    this.code = code;
  }
}
