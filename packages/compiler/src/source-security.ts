// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

const BLOCKED_SOURCE_SEGMENT =
  /^(?:auth\.json|credentials?(?:\.json)?|sessions?|history|trust|\.git|\.npmrc|\.env(?:\..*)?)$/iu;
const POTENTIAL_SECRET_PATH = /(?:secret|token|password|oauth|private[-_]?key|api[-_]?key)/iu;
const POTENTIAL_SECRET_CONTENT =
  /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[^\s"']{8,})/iu;

export type SensitiveSourceReason = "blocked-path" | "potential-secret";

export function isUnsupportedNativeSourcePath(relativePath: string): boolean {
  const name = relativePath.split("/").at(-1)?.toLowerCase();
  return name === "binding.gyp" || name?.endsWith(".node") === true;
}

export function isBlockedSourcePath(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => BLOCKED_SOURCE_SEGMENT.test(segment));
}

export function isPotentialSecretSource(relativePath: string, bytes: Uint8Array): boolean {
  if (POTENTIAL_SECRET_PATH.test(relativePath)) return true;
  try {
    return POTENTIAL_SECRET_CONTENT.test(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return false;
  }
}

/** Classifies complete, already bounded file bytes without returning their contents. */
export function sensitiveSourceReason(
  relativePath: string,
  bytes: Uint8Array,
): SensitiveSourceReason | undefined {
  if (isBlockedSourcePath(relativePath)) return "blocked-path";
  return isPotentialSecretSource(relativePath, bytes) ? "potential-secret" : undefined;
}
