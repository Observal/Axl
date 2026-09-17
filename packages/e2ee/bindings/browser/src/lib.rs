// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

//! Private browser WebAssembly boundary for the Axl endpoint E2EE core.

use axl_e2ee::pairing::{
    PAIRING_CLAIM_MAX_BYTES, PAIRING_INVITATION_MAX_BYTES, PairingClaimV1, PairingError,
    PairingInvitation,
};
#[cfg(feature = "test-fixtures")]
use axl_e2ee::{
    Error,
    browser_test_fixtures::{
        BrowserLifecycleEvidence, BrowserNegativeEvidence, browser_persistence_receive,
        browser_persistence_seed, browser_persistence_send, run_openmls_lifecycle,
        run_openmls_negative_cases,
    },
};
use axl_e2ee::{
    PROFILE_ID, PROFILE_REVISION,
    witness::{
        QuorumCertificate, ReplicaKey, ReplicaTrust, ReplicaTrustSet, WitnessError, WitnessRequest,
        WitnessRequestKind, WitnessResult,
    },
};
use wasm_bindgen::prelude::*;

const ERROR_PREFIX: &str = "AXL_E2EE:";

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = crypto, js_name = getRandomValues, catch)]
    fn crypto_get_random_values(bytes: &mut [u8]) -> Result<(), JsValue>;
}

fn error(code: &'static str) -> JsValue {
    JsValue::from_str(&format!("{ERROR_PREFIX}{code}"))
}

#[cfg(feature = "test-fixtures")]
fn map_core(value: Error) -> JsValue {
    use Error::*;
    error(match value {
        BoundExceeded(_) => "bound_exceeded",
        ClockRollback => "clock_rollback",
        FutureEpoch => "future_epoch",
        StaleEpoch => "stale_epoch",
        DuplicateCiphertext => "replay_rejected",
        WrongProfile => "profile_mismatch",
        WrongGroup | InvalidIdentity(_) => "identity_mismatch",
        InvalidCiphertext => "invalid_ciphertext",
        TransactionPending => "lifecycle_busy",
        CompetingCommit => "conflict",
        Crypto(_) => "internal_error",
        _ => "invalid_argument",
    })
}

fn map_witness(value: WitnessError) -> JsValue {
    use WitnessError::*;
    error(match value {
        BoundExceeded => "bound_exceeded",
        CredentialMismatch => "witness_auth_failed",
        OperationConflict | OperationMismatch => "witness_operation_conflict",
        RegistrationConflict => "witness_registration_conflict",
        InvalidExpected | StaleExpected => "witness_invalid_expected",
        Revoked | Forked | Quarantined => "witness_conflict",
        FreshWitnessRequired | PendingOperation | NoPendingOperation | OutputBlocked => {
            "witness_unavailable"
        }
        Malformed | NonCanonical | ProfileMismatch | LineageMismatch | RoleMismatch
        | GenerationMismatch | CounterMismatch | CommitmentMismatch | PredecessorMismatch
        | RequestHashMismatch | RevocationMismatch | InvalidSignature | InvalidQuorum
        | DuplicateReplica | InvalidTrustSet | UnpinnedKey | MixedReceipts | UnexpectedResult
        | CorruptState | Crypto => "witness_receipt_invalid",
    })
}

fn map_pairing(value: PairingError) -> JsValue {
    use PairingError::*;
    error(match value {
        BoundExceeded => "bound_exceeded",
        ClockRollback => "clock_rollback",
        Expired => "expired",
        IdentityMismatch | NonceMismatch => "identity_mismatch",
        WrongProfile | WrongProfileRevision | WrongVersion => "profile_mismatch",
        InvalidSignature | InvalidCredential | InvalidTime | NonCanonical
        | CryptographicFailure | NonCounting => "invalid_argument",
    })
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

fn inspection(kind: &str, crypto_session_id: &[u8; 16]) -> String {
    format!(
        "{{\"kind\":\"{kind}\",\"profileId\":\"{PROFILE_ID}\",\"profileRevision\":{PROFILE_REVISION},\"cryptoSessionIdHex\":\"{}\"}}",
        hex(crypto_session_id)
    )
}

#[wasm_bindgen]
pub fn get_binding_info_json() -> String {
    format!(
        "{{\"abiVersion\":1,\"profileId\":\"{PROFILE_ID}\",\"profileRevision\":{PROFILE_REVISION},\"productionStorageReady\":false,\"workerRequired\":true}}"
    )
}

/// Worker-private verifier configured from exactly three build-pinned replica keys. It has no
/// loader or page-protocol constructor.
#[wasm_bindgen]
pub struct BrowserWitnessVerifier {
    trust: ReplicaTrustSet,
}

#[wasm_bindgen]
impl BrowserWitnessVerifier {
    #[wasm_bindgen(constructor)]
    pub fn new(
        mut replica_ids: Vec<u8>,
        mut key_ids: Vec<u8>,
        mut public_keys: Vec<u8>,
    ) -> Result<BrowserWitnessVerifier, JsValue> {
        let result = (|| {
            if replica_ids.len() != 3 * 16 || key_ids.len() != 3 * 16 || public_keys.len() != 3 * 32
            {
                return Err(error("invalid_argument"));
            }
            let mut replicas = Vec::with_capacity(3);
            for index in 0..3 {
                let replica_id = replica_ids[index * 16..(index + 1) * 16]
                    .try_into()
                    .map_err(|_| error("invalid_argument"))?;
                let key_id = key_ids[index * 16..(index + 1) * 16]
                    .try_into()
                    .map_err(|_| error("invalid_argument"))?;
                let public_key = public_keys[index * 32..(index + 1) * 32]
                    .try_into()
                    .map_err(|_| error("invalid_argument"))?;
                let key = ReplicaKey::new(key_id, public_key).map_err(map_witness)?;
                replicas.push(ReplicaTrust::new(replica_id, vec![key]).map_err(map_witness)?);
            }
            Ok(BrowserWitnessVerifier {
                trust: ReplicaTrustSet::new(replicas).map_err(map_witness)?,
            })
        })();
        replica_ids.fill(0);
        key_ids.fill(0);
        public_keys.fill(0);
        result
    }

    pub fn verify(
        &self,
        mut request_bytes: Vec<u8>,
        mut certificate_bytes: Vec<u8>,
    ) -> Result<(), JsValue> {
        let result = (|| {
            let request = WitnessRequest::decode(&request_bytes).map_err(map_witness)?;
            let certificate = QuorumCertificate::decode(&certificate_bytes).map_err(map_witness)?;
            let actual = certificate
                .verify(&request, &self.trust)
                .map_err(map_witness)?;
            let expected = match request.kind() {
                WitnessRequestKind::Register => WitnessResult::Registered,
                WitnessRequestKind::Advance => WitnessResult::Advanced,
                WitnessRequestKind::Read => WitnessResult::Head,
            };
            if actual != expected {
                return Err(map_witness(match actual {
                    WitnessResult::OperationConflict => WitnessError::OperationConflict,
                    WitnessResult::RegistrationConflict => WitnessError::RegistrationConflict,
                    WitnessResult::Revoked => WitnessError::Revoked,
                    WitnessResult::Forked
                    | WitnessResult::ConflictingSuccessor
                    | WitnessResult::HistoricalFork => WitnessError::Forked,
                    WitnessResult::StaleExpected => WitnessError::StaleExpected,
                    WitnessResult::InvalidExpected => WitnessError::InvalidExpected,
                    _ => WitnessError::UnexpectedResult,
                }));
            }
            Ok(())
        })();
        request_bytes.fill(0);
        certificate_bytes.fill(0);
        result
    }
}

#[wasm_bindgen]
pub fn secure_random_check() -> Result<(), JsValue> {
    #[cfg(target_arch = "wasm32")]
    {
        let mut bytes = [0_u8; 32];
        let result =
            crypto_get_random_values(&mut bytes).map_err(|_| error("secure_random_unavailable"));
        bytes.fill(0);
        result
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        Err(error("secure_random_unavailable"))
    }
}

#[wasm_bindgen]
pub fn inspect_pairing_invitation(mut bytes: Vec<u8>) -> Result<String, JsValue> {
    let result = (|| {
        if bytes.len() > PAIRING_INVITATION_MAX_BYTES {
            return Err(error("bound_exceeded"));
        }
        let value = PairingInvitation::decode(&bytes).map_err(map_pairing)?;
        value.verify_signature().map_err(map_pairing)?;
        Ok(inspection("pairing_invitation", &value.crypto_session_id()))
    })();
    bytes.fill(0);
    result
}

#[wasm_bindgen]
pub fn inspect_pairing_claim(mut bytes: Vec<u8>) -> Result<String, JsValue> {
    let result = (|| {
        if bytes.len() > PAIRING_CLAIM_MAX_BYTES {
            return Err(error("bound_exceeded"));
        }
        let value = PairingClaimV1::decode(&bytes).map_err(map_pairing)?;
        Ok(inspection("pairing_claim", &value.crypto_session_id()))
    })();
    bytes.fill(0);
    result
}

#[cfg(feature = "test-fixtures")]
fn lifecycle_json(value: &BrowserLifecycleEvidence) -> String {
    format!(
        "{{\"suite\":{},\"keyPackageBytes\":{},\"welcomeBytes\":{},\"activationBytes\":{},\"applicationBytes\":{},\"deliveryBytes\":{},\"proposalBytes\":{},\"commitBytes\":{},\"epochReadyBytes\":{},\"initialEpoch\":{},\"updatedEpoch\":{}}}",
        value.suite,
        value.key_package_bytes,
        value.welcome_bytes,
        value.activation_bytes,
        value.application_bytes,
        value.delivery_bytes,
        value.proposal_bytes,
        value.commit_bytes,
        value.epoch_ready_bytes,
        value.initial_epoch,
        value.updated_epoch,
    )
}

#[cfg(feature = "test-fixtures")]
#[wasm_bindgen]
pub fn test_openmls_lifecycle_json(now_ms: f64) -> Result<String, JsValue> {
    if !now_ms.is_finite()
        || now_ms < 0.0
        || now_ms.fract() != 0.0
        || now_ms > 9_007_199_254_740_991.0
    {
        return Err(error("invalid_argument"));
    }
    run_openmls_lifecycle(now_ms as u64)
        .map(|value| lifecycle_json(&value))
        .map_err(map_core)
}

#[cfg(feature = "test-fixtures")]
fn negative_json(value: &BrowserNegativeEvidence) -> String {
    format!(
        "{{\"mlsReplay\":\"{}\",\"duplicateCiphertext\":\"{}\",\"mutationCorruption\":\"{}\",\"aadMismatch\":\"{}\",\"identityMismatch\":\"{}\",\"profileMismatch\":\"{}\",\"competingCommit\":\"{}\"}}",
        value.mls_replay,
        value.duplicate_ciphertext,
        value.mutation_corruption,
        value.aad_mismatch,
        value.identity_mismatch,
        value.profile_mismatch,
        value.competing_commit,
    )
}

#[cfg(feature = "test-fixtures")]
#[wasm_bindgen]
pub fn test_openmls_negative_cases_json(now_ms: f64) -> Result<String, JsValue> {
    if !now_ms.is_finite()
        || now_ms < 0.0
        || now_ms.fract() != 0.0
        || now_ms > 9_007_199_254_740_991.0
    {
        return Err(error("invalid_argument"));
    }
    run_openmls_negative_cases(now_ms as u64)
        .map(|value| negative_json(&value))
        .map_err(map_core)
}

#[cfg(feature = "test-fixtures")]
fn test_now(value: f64) -> Result<u64, JsValue> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > 9_007_199_254_740_991.0
    {
        return Err(error("invalid_argument"));
    }
    Ok(value as u64)
}

#[cfg(feature = "test-fixtures")]
fn test_operation_id(value: Vec<u8>) -> Result<[u8; 16], JsValue> {
    value.try_into().map_err(|_| error("invalid_argument"))
}

#[cfg(feature = "test-fixtures")]
#[wasm_bindgen]
pub fn test_browser_persistence_seed(now_ms: f64, receive: bool) -> Result<Vec<u8>, JsValue> {
    browser_persistence_seed(test_now(now_ms)?, receive).map_err(map_core)
}

#[cfg(feature = "test-fixtures")]
#[wasm_bindgen]
pub fn test_browser_persistence_send(
    mut snapshot: Vec<u8>,
    operation_id: Vec<u8>,
    mut plaintext: Vec<u8>,
    now_ms: f64,
) -> Result<Vec<u8>, JsValue> {
    let result = browser_persistence_send(
        &snapshot,
        test_operation_id(operation_id)?,
        &plaintext,
        test_now(now_ms)?,
    )
    .map_err(map_core);
    snapshot.fill(0);
    plaintext.fill(0);
    result
}

#[cfg(feature = "test-fixtures")]
#[wasm_bindgen]
pub fn test_browser_persistence_receive(
    mut snapshot: Vec<u8>,
    operation_id: Vec<u8>,
    mut ciphertext: Vec<u8>,
    now_ms: f64,
) -> Result<Vec<u8>, JsValue> {
    let result = browser_persistence_receive(
        &snapshot,
        test_operation_id(operation_id)?,
        &ciphertext,
        test_now(now_ms)?,
    )
    .map_err(map_core);
    snapshot.fill(0);
    ciphertext.fill(0);
    result
}

#[cfg(feature = "test-fixtures")]
#[wasm_bindgen]
pub fn test_secure_random_probe() -> Result<(), JsValue> {
    secure_random_check()
}
