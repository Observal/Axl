// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { ProtocolValidationError } from "./event-envelope.ts";

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = Object.freeze({
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
});

export type CompactionSettings = {
  readonly enabled: boolean;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
};

export type CompactionSettingsOverride = Partial<CompactionSettings>;

export type CompactionPreferences = CompactionSettingsOverride & {
  readonly modelOverrides?: Readonly<Record<string, CompactionSettingsOverride>>;
};

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, path: string, keys: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new ProtocolValidationError(`${path}.${key}`, "unknown field");
  }
}

function tokens(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ProtocolValidationError(path, "must be a positive safe integer");
  }
  return value as number;
}

function parseOverride(value: unknown, path: string): CompactionSettingsOverride {
  const input = object(value, path);
  exact(input, path, ["enabled", "reserveTokens", "keepRecentTokens"]);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new ProtocolValidationError(`${path}.enabled`, "must be a boolean");
  }
  return {
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.reserveTokens === undefined
      ? {}
      : { reserveTokens: tokens(input.reserveTokens, `${path}.reserveTokens`) }),
    ...(input.keepRecentTokens === undefined
      ? {}
      : { keepRecentTokens: tokens(input.keepRecentTokens, `${path}.keepRecentTokens`) }),
  };
}

export function parseCompactionSettings(value: unknown, path = "compaction"): CompactionSettings {
  const parsed = parseOverride(value, path);
  return {
    enabled: parsed.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled,
    reserveTokens: parsed.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    keepRecentTokens: parsed.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
  };
}

export function parseCompactionPreferences(
  value: unknown,
  path = "compaction",
): CompactionPreferences {
  const input = object(value, path);
  exact(input, path, ["enabled", "reserveTokens", "keepRecentTokens", "modelOverrides"]);
  const base = parseOverride(
    Object.fromEntries(Object.entries(input).filter(([key]) => key !== "modelOverrides")),
    path,
  );
  if (input.modelOverrides === undefined) return base;
  const overrides = object(input.modelOverrides, `${path}.modelOverrides`);
  const modelOverrides: Record<string, CompactionSettingsOverride> = {};
  for (const [model, override] of Object.entries(overrides)) {
    if (!model.includes("/") || model.startsWith("/") || model.endsWith("/") || /\s/u.test(model)) {
      throw new ProtocolValidationError(
        `${path}.modelOverrides`,
        "model keys must use provider/model identity",
      );
    }
    modelOverrides[model] = parseOverride(override, `${path}.modelOverrides.${model}`);
  }
  return { ...base, modelOverrides };
}

export function resolveCompactionSettings(
  preferences: CompactionPreferences | undefined,
  providerId: string,
  modelId: string,
): CompactionSettings {
  const model = preferences?.modelOverrides?.[`${providerId}/${modelId}`];
  return {
    enabled: model?.enabled ?? preferences?.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled,
    reserveTokens:
      model?.reserveTokens ??
      preferences?.reserveTokens ??
      DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    keepRecentTokens:
      model?.keepRecentTokens ??
      preferences?.keepRecentTokens ??
      DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
  };
}
