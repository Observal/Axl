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

export function assertAllScenarios(result) {
  assertLifecycleScenario(result.lifecycle);
  assertNegativeOpenMlsScenario(result.negativeOpenMls);
  assertBoundaryScenario(result.boundaries);
  assertStateScenario(result.state);
}
