// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type {
  McpConfigListResult,
  McpConfigMutationResult,
  McpConfigRemoveParams,
  McpConfigUpsertParams,
} from "@axl/protocol";

export interface McpConfigurationService {
  list(): Promise<McpConfigListResult>;
  upsert(params: McpConfigUpsertParams): Promise<McpConfigMutationResult>;
  remove(params: McpConfigRemoveParams): Promise<McpConfigMutationResult>;
}
