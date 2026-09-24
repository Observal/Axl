// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

const safeError = (code) => ({
  name: "AxlE2eeError",
  code,
  message: "The E2EE operation failed safely.",
});

export function assertLifecycleScenario(result) {
  assert.deepEqual(result.info, {
    abiVersion: 1,
    profileId: "axl-e2ee-mls-pq-v1",
    profileRevision: 1,
    productionStorageReady: false,
    workerRequired: true,
  });
  assert.equal(result.invitation.kind, "pairing_invitation");
  assert.equal(result.claim.kind, "pairing_claim");
  assert.deepEqual(result.invitation.cryptoSessionId, result.claim.cryptoSessionId);
  assert.deepEqual(result.endpointErrors, Array.from({ length: 4 }, () => safeError("rollback_anchor_unavailable")));
  assert.equal(result.lifecycle.suite, 0x004e);
  assert(result.lifecycle.keyPackageBytes > 0);
  assert(result.lifecycle.keyPackageBytes <= 16_384);
  assert(result.lifecycle.welcomeBytes > 0);
  assert(result.lifecycle.welcomeBytes <= 16_384);
  for (const name of ["activationBytes", "applicationBytes", "deliveryBytes", "epochReadyBytes"]) {
    assert(result.lifecycle[name] > 0, `${name} must contain an MLS message`);
    assert(result.lifecycle[name] <= 65_497, `${name} must fit the relay envelope`);
  }
  for (const name of ["proposalBytes", "commitBytes"]) {
    assert(result.lifecycle[name] > 0, `${name} must contain an MLS handshake message`);
    assert(result.lifecycle[name] <= 16_384, `${name} must fit the handshake bound`);
  }
  assert.equal(result.lifecycle.updatedEpoch, result.lifecycle.initialEpoch + 1);
}

export function assertNegativeOpenMlsScenario(result) {
  assert.deepEqual(result, {
    mlsReplay: "invalid_ciphertext",
    duplicateCiphertext: "duplicate_ciphertext",
    mutationCorruption: "invalid_ciphertext",
    aadMismatch: "invalid_aad",
    identityMismatch: "invalid_identity",
    profileMismatch: "wrong_profile",
    competingCommit: "competing_commit",
  });
}

export function assertBoundaryScenario(result) {
  assert.deepEqual(result, {
    maximumClaimCode: "profile_mismatch",
    javascriptCode: "bound_exceeded",
    redactedError: safeError("invalid_argument"),
    workerInvitationCode: "bound_exceeded",
    workerClaimCode: "bound_exceeded",
    workerTypeCode: "invalid_argument",
    rustInvitationCode: "bound_exceeded",
    rustClaimCode: "bound_exceeded",
  });
}

export function assertStateScenario(result) {
  assert.deepEqual(result, {
    sharedMemory: false,
    unavailableCode: "secure_random_unavailable",
    malformed: {
      pendingCodes: ["internal_error", "internal_error"],
      useAfterFatalCode: "internal_error",
      workersCreated: 1,
    },
    pendingCode: "endpoint_closed",
    useAfterCloseCode: "endpoint_closed",
    endpointAfterCloseCode: "endpoint_closed",
  });
}

export function assertPersistenceScenario(result) {
  assert.equal(result.creationBeforeEvent, "prepared");
  assert.equal(result.creationAfterBeforeTerminationDuplicate, false);
  assert.equal(result.creationAfterEvent, "committed");
  assert.equal(result.recoveredCreationDuplicate, true);
  assert.equal(result.recoveredCreationGeneration, 1);
  assert.equal(result.recoveredCreationStrict, true);
  assert.equal(result.recoveredCreationPlaintext, "committed browser plaintext");
  assert.equal(result.creationAmbiguous, "ambiguous_commit");
  assert.equal(result.recoveredAmbiguousCreationDuplicate, true);
  assert.equal(result.recoveredAmbiguousCreationGeneration, 1);
  assert.equal(result.created.generation, 1);
  assert.equal(result.created.duplicate, false);
  assert.equal(result.created.strictDurability, true);
  assert.equal(result.created.lockName, `axl-e2ee-v1:${result.created.sessionId}`);
  assert.equal(result.reopened.generation, 2);
  assert.equal(result.reopened.strictDurability, true);
  assert.equal(result.exactRetry, true);
  assert.equal(result.duplicate, true);
  assert.equal(result.conflict, "operation_conflict");
  assert.equal(result.aborted, "transaction_aborted");
  assert.equal(result.abortReleasedBytes, false);
  assert.equal(result.afterAbortDuplicate, false);
  assert.equal(result.quota, "quota_exceeded");
  assert.equal(result.ambiguous, "ambiguous_commit");
  assert.equal(result.ambiguousReleasedBytes, false);
  assert.equal(result.recoveredAmbiguous, true);
  assert.equal(result.contention, "lifecycle_busy");
  assert(result.afterPageTerminationGeneration >= 1);
  assert.equal(result.beforeEvent, "prepared");
  assert.equal(result.afterTerminationBefore, false);
  assert.equal(result.afterEvent, "committed");
  assert.equal(result.afterTerminationAfter, true);
  assert.equal(result.completionEvent, "transaction_complete");
  assert.equal(result.ciphertextReleasedBeforeCompletion, false);
  assert.equal(result.callbackException, "lock_lost");
  assert(result.afterCallbackGeneration >= 1);
  assert.deepEqual(result.inputBounds, {
    oversizedPlaintext: "bound_exceeded",
    oversizedCiphertext: "bound_exceeded",
    invalidByte: "invalid_argument",
    sparseByteArray: "invalid_argument",
    unknownFault: "invalid_argument",
    unknownTamper: "invalid_argument",
  });
  assert.equal(result.forcedClose, "storage_unavailable");
  assert.equal(result.unavailable, "storage_unavailable");
  assert.deepEqual(result.canonicalOrdering, {
    highDuplicate: true,
    highExact: true,
    lowDuplicate: true,
    lowExact: true,
  });
  assert.equal(result.receiveCompletionEvent, "transaction_complete");
  assert.equal(result.plaintextReleasedBeforeCompletion, false);
  assert.equal(result.receivePlaintext, "committed browser plaintext");
  assert.equal(result.receiveDuplicate, true);
  assert.equal(result.receiveExact, true);
  assert.equal(result.secondReceivePlaintext, "second committed browser plaintext");
  assert.equal(result.secondReceiveDuplicate, true);
  assert.equal(result.secondReceiveExact, true);
  assert.deepEqual(result.corruption, {
    manifest: "corrupt_state",
    state: "corrupt_state",
    schema: "unsupported_schema",
    rollback: "rollback_detected",
    malformed: "corrupt_state",
    unexpected: "corrupt_state",
    cyclic: "corrupt_state",
    oversized: "corrupt_state",
    excessive: "corrupt_state",
  });
  assert.equal(result.stateLoss, "state_loss");
  assert.equal(result.rePairRequired, "re_pair_required");
  assert.equal(result.newerDatabase, "unsupported_schema");
  assert.equal(result.generationConflict, "generation_conflict");
  assert.equal(result.generationAfterConflict, 1);
  assert.equal(result.generationRetryDuplicate, false);
  assert.deepEqual(result.upgrade, { blocked: true, failed: true, preservedVersion: 2 });
  assert.equal(result.lifecycleEvidence, "not_exposed_by_browser");
}

export function assertDeviceBarrierScenario(result) {
  assert.deepEqual(result, {
    registerKind: "register",
    registerStatus: "pending_quorum",
    duplicateCreate: "lifecycle_busy",
    contention: "lifecycle_busy",
    mutationWhilePending: "witness_unavailable",
    duplicateWhilePending: true,
    continueWrongOperation: "not_found",
    reconcileWithoutRead: "fresh_witness_required",
    registerResultTag: "key_package",
    keyPackageBytes: result.keyPackageBytes,
    mutationWithoutFreshHead: "fresh_witness_required",
    completedPendingIsNull: true,
    joined: { tag: "joined", epoch: 1 },
    activationDelivered: true,
    sentClass: 1,
    requestDelivered: true,
    received: { tag: "plaintext", plaintext: "daemon delivery" },
    replayRejected: "replay_rejected",
    duplicateStatus: "completed",
    duplicateExactBytes: true,
    headAfterDuplicate: 5,
    restartPendingStatus: "pending_quorum",
    closedCode: "endpoint_closed",
    recoveredExactRequest: true,
    recoveredReconciliation: "resend_pending",
    mutationWhileRecovering: "witness_unavailable",
    recoveredDelivered: true,
    completedAfterRestartPending: true,
    completedAfterRestartDuplicate: "fresh_witness_required",
    olderAfterRestartDuplicate: "fresh_witness_required",
    completedAfterRestartReconciliation: "ready",
    completedAfterRestartExactBytes: true,
    olderAfterRestartExactBytes: true,
    abortedCommit: { code: "storage_unavailable", aborted: 1 },
    afterAbort: "recovery_required",
    abortLeftHead: true,
    abortReopenPending: true,
    abortRetryDelivered: true,
    activationFailure: { code: "storage_unavailable", aborted: 1 },
    keysAfterActivationFailure: ["active", "prepared"],
    afterActivationFailure: "recovery_required",
    activationRecoveredPending: true,
    keysAfterReopen: ["active", "active"],
    activationRecoveredReconciliation: "resend_pending",
    activationRecoveredDelivered: true,
    keysAfterRecoveredCompletion: ["active"],
    unavailableWitness: "witness_unavailable",
    unavailableRead: "witness_unavailable",
    pendingSurvivesUnavailable: true,
    afterLockLoss: "recovery_required",
    afterLockLossMutation: "recovery_required",
    reopenWhileStolen: "lifecycle_busy",
    reopenAfterLockLoss: true,
    applied: {
      tag: "commit_applied",
      epoch: 2,
      removal: false,
      commitIdMatches: true,
      authenticatorMatches: true,
    },
    peerEpochAfterCommit: 2,
    pendingBetweenSplit: true,
    epochReadyWrongCommit: "invalid_argument",
    epochReadyDelivered: true,
    epochReadySecond: "invalid_argument",
    confirmation: { tag: "plaintext", messageClass: 7, plaintext: "confirmed" },
    removed: { tag: "commit_applied", epoch: 3, removal: true },
    headAfterRemoval: 14,
    quarantineWriteFailure: { code: "storage_unavailable", aborted: 1 },
    lifecycleAfterFailedQuarantine: "ready",
    afterFailedQuarantine: "witness_conflict",
    storeAfterFailedQuarantine: "witness_conflict",
    lifecycleBeforeConflict: "ready",
    conflict: "witness_operation_conflict",
    lifecycleAfterConflict: "quarantined",
    mutationAfterConflict: "witness_conflict",
    reconcileAfterConflict: "quarantined",
    reopenAfterConflict: "rollback_detected",
    corruptedRequestOpen: ["corrupt_state", "corrupt_state"],
    intactRequestReopens: true,
    forgedCertificate: "witness_receipt_invalid",
    lifecycleAfterForgery: "quarantined",
    genuineAfterQuarantine: "witness_conflict",
    reopenAfterForgery: "rollback_detected",
    versionOneOpen: "unsupported_schema",
    versionOneCreate: "unsupported_schema",
    versionOnePreserved: 1,
    newerOpen: "unsupported_schema",
    newerCreate: "unsupported_schema",
    missingOpen: "state_loss",
    missingEndpointOpen: "state_loss",
    createAfterFailedOpen: "created",
    schema: {
      version: 2,
      stores: [
        "metadata_v2",
        "wrapping_key_v2",
        "wrapped_state_keys_v2",
        "sealed_transitions_v2",
        "witness_operations_v2",
      ],
    },
  });
  assert(result.keyPackageBytes > 0 && result.keyPackageBytes <= 16 * 1024);
}

export function assertDeviceTerminationScenario(result) {
  assert.equal(result.exactRequest, true, "the resent request must be byte-identical");
  assert.deepEqual(
    { ...result.phaseOne, requestHex: undefined },
    { status: "pending_quorum", kind: "register", lifecycle: "ready", requestHex: undefined },
  );
  assert.deepEqual(
    { ...result.phaseTwo, requestHex: undefined },
    {
      reconciliation: "resend_pending",
      resultTag: "key_package",
      keyPackageBytes: result.phaseTwo.keyPackageBytes,
      head: 1,
      requestHex: undefined,
    },
  );
  assert.match(result.phaseOne.requestHex, /^[0-9a-f]+$/u);
}

export function assertAllScenarios(result) {
  assertLifecycleScenario(result.lifecycle);
  assertNegativeOpenMlsScenario(result.negativeOpenMls);
  assertBoundaryScenario(result.boundaries);
  assertStateScenario(result.state);
  assertDeviceBarrierScenario(result.deviceBarrier);
  assertDeviceTerminationScenario(result.deviceTermination);
  assertPersistenceScenario(result.persistence);
}
