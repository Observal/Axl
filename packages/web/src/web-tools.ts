// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { SessionConfiguration, SessionProfile } from "@axl/sdk";

export type WebToolField = "webSearch" | "webFetch";
export type StagedWebToolValue = "default" | "on" | "off";

export function webToolConfiguration(field: WebToolField, enabled: boolean): SessionConfiguration {
  return field === "webSearch" ? { webSearch: enabled } : { webFetch: enabled };
}

export function profileSupportsWebTools(profile: SessionProfile | undefined): boolean {
  return profile === "standard";
}

export function stagedWebToolValue(value: boolean | undefined): StagedWebToolValue {
  return value === undefined ? "default" : value ? "on" : "off";
}

export function parseStagedWebToolValue(value: StagedWebToolValue): boolean | undefined {
  return value === "default" ? undefined : value === "on";
}
