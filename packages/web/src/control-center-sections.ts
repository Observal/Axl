// SPDX-FileCopyrightText: 2026 PranavD2905
// SPDX-License-Identifier: Apache-2.0

export type ControlCenterTab = "settings" | "providers" | "mcp";

export interface ControlCenterSection {
  readonly tab: ControlCenterTab;
  readonly label: string;
  readonly selected: boolean;
}

const SECTIONS: readonly { readonly tab: ControlCenterTab; readonly label: string }[] = [
  { tab: "settings", label: "Settings" },
  { tab: "providers", label: "Providers" },
  { tab: "mcp", label: "MCP" },
];

/** Section buttons in display order. Exactly one is selected, matching the open tab. */
export function controlCenterSections(tab: ControlCenterTab): readonly ControlCenterSection[] {
  return SECTIONS.map((section) => ({ ...section, selected: section.tab === tab }));
}
