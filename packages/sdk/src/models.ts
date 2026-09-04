// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { ThinkingLevel } from "@axl/protocol";

export interface ClientModelCost {
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  readonly cacheReadUsdPerMTok?: number;
  readonly cacheWriteUsdPerMTok?: number;
}

/** Provider-neutral model metadata used by presentation clients. */
export interface ClientModelInfo {
  readonly modelId: string;
  readonly displayName: string;
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: Readonly<Partial<Record<ThinkingLevel, string | null>>>;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly cost?: ClientModelCost;
}
