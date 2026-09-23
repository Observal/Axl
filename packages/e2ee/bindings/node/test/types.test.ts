// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import type {
  AxlE2eeErrorCode,
  BindingInfo,
  DaemonEndpoint,
  DeviceEndpoint,
  NativeOutbox,
  NativePlaintext,
  NativeResult,
  PairState,
  PendingWitness,
  Publication,
  WitnessOutcome,
  WitnessReconciliation,
} from "../index.js";

const codes = [
  "key_record_missing",
  "lifecycle_busy",
  "secure_store_access_denied",
  "secure_store_ambiguous",
  "secure_store_locked",
  "secure_store_unavailable",
  "rollback_anchor_unavailable",
  "endpoint_revoked",
  "fresh_witness_required",
  "initialization_incomplete",
  "witness_operation_conflict",
  "witness_receipt_invalid",
  "witness_unavailable",
] as const satisfies readonly AxlE2eeErrorCode[];
const acceptsBigint = (_value: bigint): void => {};
const inspectTypes = (
  info: BindingInfo,
  daemon: DaemonEndpoint,
  device: DeviceEndpoint,
  outbox: NativeOutbox,
  pending: PendingWitness,
  plaintext: NativePlaintext,
  publication: Publication,
  state: PairState,
  outcome: WitnessOutcome,
  result: NativeResult,
  reconciliation: WitnessReconciliation,
): void => {
  acceptsBigint(outbox.epoch);
  acceptsBigint(plaintext.epoch);
  void device.continueWitness(pending.operationId, new Uint8Array());
  void daemon.reconcileWitness(new Uint8Array());
  if (outcome.tag === "pending") void outcome.pending?.request;
  if (result.tag === "commit") acceptsBigint(result.commit?.targetEpoch ?? 0n);
  if (reconciliation.tag === "quarantined") void reconciliation.reason;
  if ("expiresAtMs" in publication) acceptsBigint(publication.expiresAtMs);
  void [info, daemon, device, publication, state, codes];
};
void inspectTypes;
