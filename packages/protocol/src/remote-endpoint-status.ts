// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

import { ProtocolValidationError } from "./event-envelope.ts";
import type { DeviceId } from "./remote-transport.ts";

/**
 * Witness lifecycle of one remote device endpoint as the daemon reports it. `recovering` means
 * the daemon is retrying witness reconciliation and admits no new work; `ready` means the last
 * barrier completed; `quarantined` and `revoked` are terminal blocked states that never retry.
 */
export const REMOTE_ENDPOINT_WITNESS_STATES = [
  "recovering",
  "ready",
  "quarantined",
  "revoked",
] as const;

export type RemoteEndpointWitnessState = (typeof REMOTE_ENDPOINT_WITNESS_STATES)[number];

/** Non-sensitive quarantine classes reported by the native endpoint's witness reconciliation. */
export const REMOTE_ENDPOINT_QUARANTINE_REASONS = [
  "stale_local_state",
  "pending_without_local_state",
  "witness_lineage_missing",
  "commitment_conflict",
  "local_ahead_more_than_one",
  "witness_behind_more_than_one",
  "witness_inconsistent",
  "immediate_fork",
  "historical_fork",
] as const;

export type RemoteEndpointQuarantineReason = (typeof REMOTE_ENDPOINT_QUARANTINE_REASONS)[number];

export interface RemoteEndpointWitnessStatus {
  readonly deviceId: DeviceId;
  readonly state: RemoteEndpointWitnessState;
  /** Present exactly when `state` is `quarantined`. */
  readonly reason?: RemoteEndpointQuarantineReason;
  /** Time of the last state transition in milliseconds since the Unix epoch. */
  readonly changedAt: number;
}

export const MAX_REMOTE_ENDPOINT_STATUSES = 256;

const deviceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function isRemoteEndpointWitnessState(value: unknown): value is RemoteEndpointWitnessState {
  return (
    typeof value === "string" &&
    (REMOTE_ENDPOINT_WITNESS_STATES as readonly string[]).includes(value)
  );
}

export function isRemoteEndpointQuarantineReason(
  value: unknown,
): value is RemoteEndpointQuarantineReason {
  return (
    typeof value === "string" &&
    (REMOTE_ENDPOINT_QUARANTINE_REASONS as readonly string[]).includes(value)
  );
}

export function parseRemoteEndpointWitnessStatus(
  value: unknown,
  path = "remoteEndpoint",
): RemoteEndpointWitnessStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError(path, "must be an object");
  }
  const status = value as Record<string, unknown>;
  for (const key of Object.keys(status)) {
    if (!["deviceId", "state", "reason", "changedAt"].includes(key)) {
      throw new ProtocolValidationError(`${path}.${key}`, "is not allowed");
    }
  }
  if (typeof status.deviceId !== "string" || !deviceIdPattern.test(status.deviceId)) {
    throw new ProtocolValidationError(`${path}.deviceId`, "must be a lowercase UUID");
  }
  if (!isRemoteEndpointWitnessState(status.state)) {
    throw new ProtocolValidationError(
      `${path}.state`,
      `must be one of ${REMOTE_ENDPOINT_WITNESS_STATES.join(", ")}`,
    );
  }
  if (!Number.isSafeInteger(status.changedAt) || (status.changedAt as number) < 0) {
    throw new ProtocolValidationError(`${path}.changedAt`, "must be a non-negative safe integer");
  }
  if (status.state === "quarantined") {
    if (!isRemoteEndpointQuarantineReason(status.reason)) {
      throw new ProtocolValidationError(`${path}.reason`, "must name a quarantine class");
    }
  } else if (status.reason !== undefined) {
    throw new ProtocolValidationError(`${path}.reason`, "is only allowed when quarantined");
  }
  return {
    deviceId: status.deviceId as DeviceId,
    state: status.state,
    ...(status.state === "quarantined"
      ? { reason: status.reason as RemoteEndpointQuarantineReason }
      : {}),
    changedAt: status.changedAt as number,
  };
}

export function parseRemoteEndpointWitnessStatuses(
  value: unknown,
  path = "remoteEndpoints",
): readonly RemoteEndpointWitnessStatus[] {
  if (!Array.isArray(value) || value.length > MAX_REMOTE_ENDPOINT_STATUSES) {
    throw new ProtocolValidationError(
      path,
      `must contain at most ${MAX_REMOTE_ENDPOINT_STATUSES} endpoint statuses`,
    );
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const status = parseRemoteEndpointWitnessStatus(entry, `${path}[${index}]`);
    if (seen.has(status.deviceId)) {
      throw new ProtocolValidationError(`${path}[${index}].deviceId`, "is duplicated");
    }
    seen.add(status.deviceId);
    return status;
  });
}
