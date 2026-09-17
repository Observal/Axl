// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { ModelChoice, ThinkingLevel } from "@axl/sdk";

export function isModelPickerShortcut(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}): boolean {
  return (event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "l";
}

export function filterModelChoices(
  choices: readonly ModelChoice[],
  query: string,
): ReadonlyMap<string, readonly ModelChoice[]> {
  const normalized = query.trim().toLocaleLowerCase();
  const groups = new Map<string, ModelChoice[]>();
  for (const choice of choices) {
    if (
      normalized &&
      !`${choice.providerDisplayName} ${choice.providerId} ${choice.displayName} ${choice.modelId}`
        .toLocaleLowerCase()
        .includes(normalized)
    ) {
      continue;
    }
    const group = groups.get(choice.providerId) ?? [];
    group.push(choice);
    groups.set(choice.providerId, group);
  }
  return groups;
}

export function nextThinkingLevel(
  choices: readonly ModelChoice[],
  provider: string | undefined,
  model: string | undefined,
  current: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  const levels = choices.find(
    (choice) => choice.providerId === provider && choice.modelId === model,
  )?.thinkingLevels;
  if (!levels?.length) return undefined;
  const index = current === undefined ? -1 : levels.indexOf(current);
  return levels[(index + 1) % levels.length];
}
