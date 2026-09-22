// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { ExtensionInstallSource, ExtensionListResult, ExtensionRecord } from "@axl/protocol";

export interface ExtensionManagementService {
  list(cwd: string): Promise<ExtensionListResult>;
  setEnabled(extensionId: string, enabled: boolean): Promise<void>;
  install(source: ExtensionInstallSource, signal?: AbortSignal): Promise<string>;
  update(extensionId: string, signal?: AbortSignal): Promise<void>;
  remove(extensionId: string, signal?: AbortSignal): Promise<void>;
  trustProject(path: string, trusted: boolean): Promise<void>;
}

export function findExtension(
  result: ExtensionListResult,
  extensionId: string,
): ExtensionRecord | undefined {
  return result.extensions.find((extension) => extension.id === extensionId);
}
