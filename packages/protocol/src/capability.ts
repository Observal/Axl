// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { JsonObject } from "./event-envelope.ts";
import { ProtocolValidationError } from "./event-envelope.ts";

export const CAPABILITY_LIMITS = Object.freeze({
  queryBytes: 2_048,
  searchResults: 10,
  activations: 10,
  identityBytes: 256,
  nameBytes: 256,
  descriptionBytes: 4_096,
  pathBytes: 4_096,
  provenanceBytes: 4_096,
});

export type CapabilityKind = "skill" | "tool";
export type CapabilityScope = "global" | "project";
export type CapabilityTrust = "trusted" | "untrusted";

export interface CapabilityRecord {
  readonly identity: string;
  readonly kind: CapabilityKind;
  readonly name: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly path: string;
  readonly scope: CapabilityScope;
  readonly provenance: string;
  readonly enabled: boolean;
  readonly trust: CapabilityTrust;
  readonly available: boolean;
  readonly requiredAuthority: readonly string[];
}

export type CapabilitySummary = Pick<
  CapabilityRecord,
  "identity" | "kind" | "name" | "description" | "path" | "scope" | "provenance"
>;

export type CapabilitySearchInput = {
  readonly action: "search";
  readonly query: string;
  readonly limit?: number;
};

export type CapabilityActivateInput = {
  readonly action: "activate";
  readonly identities: readonly string[];
};

export type CapabilityReadInput = {
  readonly action: "read";
  readonly identity: string;
  readonly path: string;
};

export type CapabilitySearchToolInput =
  | CapabilitySearchInput
  | CapabilityActivateInput
  | CapabilityReadInput;

export interface CapabilitySearchResult {
  readonly results: readonly CapabilitySummary[];
}

export interface CapabilityActivation {
  readonly capability: CapabilitySummary;
  readonly content: string;
}

export interface CapabilityDenial {
  readonly identity: string;
  readonly reason: string;
}

export interface CapabilityActivationResult {
  readonly activated: readonly CapabilityActivation[];
  readonly denied: readonly CapabilityDenial[];
}

function object(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError(path, "must be an object");
  }
  return value as JsonObject;
}

function exact(value: JsonObject, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new ProtocolValidationError(`${path}.${key}`, "is not allowed");
  }
}

function boundedString(value: unknown, path: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProtocolValidationError(path, "must be a non-empty string");
  }
  if (new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new ProtocolValidationError(path, `must not exceed ${maximumBytes} UTF-8 bytes`);
  }
  return value;
}

export function parseCapabilitySearchToolInput(
  value: unknown,
  path = "capability_search",
): CapabilitySearchToolInput {
  const input = object(value, path);
  const action = input.action;
  if (action === "search") {
    exact(input, path, ["action", "query", "limit"]);
    const query = boundedString(input.query, `${path}.query`, CAPABILITY_LIMITS.queryBytes);
    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) ||
        (input.limit as number) < 1 ||
        (input.limit as number) > CAPABILITY_LIMITS.searchResults)
    ) {
      throw new ProtocolValidationError(
        `${path}.limit`,
        `must be an integer from 1 through ${CAPABILITY_LIMITS.searchResults}`,
      );
    }
    return {
      action,
      query,
      ...(input.limit === undefined ? {} : { limit: input.limit as number }),
    };
  }
  if (action === "activate") {
    exact(input, path, ["action", "identities"]);
    if (
      !Array.isArray(input.identities) ||
      input.identities.length < 1 ||
      input.identities.length > CAPABILITY_LIMITS.activations
    ) {
      throw new ProtocolValidationError(
        `${path}.identities`,
        `must contain 1 through ${CAPABILITY_LIMITS.activations} identities`,
      );
    }
    const identities = input.identities.map((identity, index) =>
      boundedString(identity, `${path}.identities[${index}]`, CAPABILITY_LIMITS.identityBytes),
    );
    if (new Set(identities).size !== identities.length) {
      throw new ProtocolValidationError(`${path}.identities`, "must not contain duplicates");
    }
    return { action, identities };
  }
  if (action === "read") {
    exact(input, path, ["action", "identity", "path"]);
    return {
      action,
      identity: boundedString(input.identity, `${path}.identity`, CAPABILITY_LIMITS.identityBytes),
      path: boundedString(input.path, `${path}.path`, CAPABILITY_LIMITS.pathBytes),
    };
  }
  throw new ProtocolValidationError(`${path}.action`, "must be search, activate, or read");
}
