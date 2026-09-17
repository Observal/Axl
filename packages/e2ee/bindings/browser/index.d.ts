// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

/** Every returned byte array is a fresh JavaScript-owned copy. */
export type OwnedBytes = Uint8Array;
export type AxlE2eeErrorCode =
  | "already_exists"
  | "artifact_integrity_failed"
  | "bound_exceeded"
  | "clock_rollback"
  | "conflict"
  | "corrupt_state"
  | "endpoint_closed"
  | "expired"
  | "identity_mismatch"
  | "internal_error"
  | "invalid_argument"
  | "key_record_missing"
  | "lifecycle_busy"
  | "not_found"
  | "profile_mismatch"
  | "rollback_anchor_unavailable"
  | "secure_random_unavailable"
  | "state_loss"
  | "storage_unavailable"
  | "strict_durability_unavailable"
  | "witness_auth_failed"
  | "witness_conflict"
  | "witness_invalid_expected"
  | "witness_operation_conflict"
  | "witness_receipt_invalid"
  | "witness_registration_conflict"
  | "witness_unavailable";

export declare class AxlE2eeError extends Error {
  readonly code: AxlE2eeErrorCode;
  constructor(code: AxlE2eeErrorCode);
}

export interface BindingInfo {
  readonly abiVersion: 1;
  readonly profileId: "axl-e2ee-mls-pq-v1";
  readonly profileRevision: 1;
  readonly productionStorageReady: false;
  readonly workerRequired: true;
}

export interface PairingInspection {
  readonly kind: "pairing_invitation" | "pairing_claim";
  readonly profileId: "axl-e2ee-mls-pq-v1";
  readonly profileRevision: 1;
  readonly cryptoSessionId: OwnedBytes;
}

export declare const ERROR_CODES: readonly AxlE2eeErrorCode[];
export declare function getBindingInfo(): Promise<BindingInfo>;
export declare function inspectPairingInvitation(bytes: Uint8Array): Promise<PairingInspection>;
export declare function inspectPairingClaim(bytes: Uint8Array): Promise<PairingInspection>;
export declare function createDaemonEndpoint(): Promise<never>;
export declare function openDaemonEndpoint(): Promise<never>;
export declare function createDeviceEndpoint(): Promise<never>;
export declare function openDeviceEndpoint(): Promise<never>;
/** Permanently closes this module instance. Repeated close calls are harmless. */
export declare function closeBrowserBinding(): void;
