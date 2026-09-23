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
        BrowserLifecycleEvidence, BrowserNegativeEvidence, TestBrowserLineage, TestConfirmedHead,
        browser_persistence_receive, browser_persistence_seed, browser_persistence_send,
        run_openmls_lifecycle, run_openmls_negative_cases,
    },
    test_witness,
};
use axl_e2ee::{
    PROFILE_ID, PROFILE_REVISION,
    pairing::PairingCredential,
    witness::{
        EndpointTerminalState, ReplicaTrustSet, WITNESS_CERTIFICATE_MAX_BYTES, WitnessError,
        WitnessLineage, browser,
    },
};
use wasm_bindgen::prelude::*;

use std::sync::Arc;

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
        Revoked => "endpoint_revoked",
        Forked | Quarantined => "witness_conflict",
        FreshWitnessRequired => "fresh_witness_required",
        PendingOperation | NoPendingOperation | OutputBlocked => "witness_unavailable",
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

/// Endpoint lineage and credential for one opened endpoint. Only Rust constructs it: the production
/// endpoint loader will derive it from authenticated inner state, and the test fixture derives it
/// from a deterministic identity. There is no JavaScript constructor.
#[wasm_bindgen]
pub struct BrowserLineage {
    lineage: WitnessLineage,
    credential: PairingCredential,
}

/// Pinned replica trust for certificate verification. Only Rust constructs it. The production
/// build-pinned trust set is not wired yet, so no production path can obtain one.
#[wasm_bindgen]
pub struct BrowserReplicaTrust {
    trust: Arc<ReplicaTrustSet>,
}

#[cfg(feature = "test-fixtures")]
fn fixed<const N: usize>(mut value: Vec<u8>) -> Result<[u8; N], JsValue> {
    let result = <[u8; N]>::try_from(value.as_slice()).map_err(|_| error("invalid_argument"));
    value.fill(0);
    result
}

/// One prepared browser transition. The worker seals the payload with WebCrypto and returns the
/// exact sealed bytes; Rust binds them into the commitment, the signed request, and the canonical
/// committed record. Every stage is single use and there is no JavaScript constructor.
#[wasm_bindgen]
pub struct BrowserTransition {
    inner: Option<browser::BrowserTransition>,
}

impl BrowserTransition {
    fn get(&self) -> Result<&browser::BrowserTransition, JsValue> {
        self.inner.as_ref().ok_or_else(|| error("consumed"))
    }

    fn get_mut(&mut self) -> Result<&mut browser::BrowserTransition, JsValue> {
        self.inner.as_mut().ok_or_else(|| error("consumed"))
    }
}

#[wasm_bindgen]
impl BrowserTransition {
    pub fn operation_id(&self) -> Result<Vec<u8>, JsValue> {
        Ok(self.get()?.operation_id().to_vec())
    }
    pub fn fingerprint(&self) -> Result<Vec<u8>, JsValue> {
        Ok(self.get()?.fingerprint().to_vec())
    }
    pub fn counter(&self) -> Result<u64, JsValue> {
        Ok(self.get()?.counter())
    }
    pub fn generation(&self) -> Result<u64, JsValue> {
        Ok(self.get()?.generation())
    }
    pub fn current_key_id(&self) -> Result<Vec<u8>, JsValue> {
        Ok(self.get()?.current_key_id().to_vec())
    }
    pub fn predecessor_commitment(&self) -> Result<Vec<u8>, JsValue> {
        Ok(self.get()?.predecessor_commitment().to_vec())
    }
    pub fn inner_nonce(&self) -> Result<Vec<u8>, JsValue> {
        Ok(self.get()?.inner_nonce().to_vec())
    }
    pub fn inner_aad(&self) -> Result<Vec<u8>, JsValue> {
        Ok(self.get()?.inner_aad())
    }
    pub fn outer_nonce(&self) -> Result<Vec<u8>, JsValue> {
        Ok(self.get()?.outer_nonce().to_vec())
    }
    pub fn outer_aad(&self) -> Result<Vec<u8>, JsValue> {
        Ok(self.get()?.outer_aad())
    }

    /// The canonical inner payload for WebCrypto to seal. Available exactly once.
    pub fn take_inner_payload(&mut self) -> Result<Vec<u8>, JsValue> {
        self.get_mut()?.take_inner_payload().map_err(map_witness)
    }

    /// Bind the exact sealed inner bytes and return the outer metadata plaintext to seal.
    pub fn finalize(&mut self, mut sealed_inner: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        let result = self.get_mut()?.finalize(&sealed_inner).map_err(map_witness);
        sealed_inner.fill(0);
        result
    }

    /// Receive the exact sealed outer bytes and produce the committed record. Consumes the
    /// transition.
    pub fn complete(
        &mut self,
        mut sealed_outer: Vec<u8>,
    ) -> Result<BrowserCommittedTransition, JsValue> {
        let transition = self.inner.take().ok_or_else(|| error("consumed"))?;
        let result = transition
            .complete(&sealed_outer)
            .map(|inner| BrowserCommittedTransition { inner })
            .map_err(map_witness);
        sealed_outer.fill(0);
        result
    }
}

/// Non-secret result of a completed transition: the canonical committed record, the exact signed
/// request, and the heads the storage adapter compares.
#[wasm_bindgen]
pub struct BrowserCommittedTransition {
    inner: browser::BrowserCommittedTransition,
}

#[wasm_bindgen]
impl BrowserCommittedTransition {
    pub fn operation_id(&self) -> Vec<u8> {
        self.inner.operation_id.to_vec()
    }
    pub fn fingerprint(&self) -> Vec<u8> {
        self.inner.fingerprint.to_vec()
    }
    pub fn counter(&self) -> u64 {
        self.inner.counter
    }
    pub fn generation(&self) -> u64 {
        self.inner.generation
    }
    pub fn current_key_id(&self) -> Vec<u8> {
        self.inner.current_key_id.to_vec()
    }
    pub fn predecessor_commitment(&self) -> Vec<u8> {
        self.inner.predecessor_commitment.to_vec()
    }
    pub fn commitment(&self) -> Vec<u8> {
        self.inner.commitment.to_vec()
    }
    pub fn committed_record(&self) -> Vec<u8> {
        self.inner.committed_record.clone()
    }
    pub fn witness_request(&self) -> Vec<u8> {
        self.inner.request_bytes.clone()
    }
    pub fn request_hash(&self) -> Vec<u8> {
        self.inner.request_hash.to_vec()
    }
}

/// Non-secret envelope parts of a committed record for WebCrypto decryption. No key is involved.
#[wasm_bindgen]
pub struct BrowserSealedEnvelopes {
    inner: browser::BrowserSealedEnvelopes,
}

#[wasm_bindgen]
impl BrowserSealedEnvelopes {
    pub fn operation_id(&self) -> Vec<u8> {
        self.inner.operation_id.to_vec()
    }
    pub fn counter(&self) -> u64 {
        self.inner.counter
    }
    pub fn generation(&self) -> u64 {
        self.inner.generation
    }
    pub fn current_key_id(&self) -> Vec<u8> {
        self.inner.current_key_id.to_vec()
    }
    pub fn inner_nonce(&self) -> Vec<u8> {
        self.inner.inner_nonce.to_vec()
    }
    pub fn inner_aad(&self) -> Vec<u8> {
        self.inner.inner_aad.clone()
    }
    pub fn sealed_inner(&self) -> Vec<u8> {
        self.inner.sealed_inner.clone()
    }
    pub fn outer_nonce(&self) -> Vec<u8> {
        self.inner.outer_nonce.to_vec()
    }
    pub fn outer_aad(&self) -> Vec<u8> {
        self.inner.outer_aad.clone()
    }
    pub fn sealed_outer(&self) -> Vec<u8> {
        self.inner.sealed_outer.clone()
    }
}

#[wasm_bindgen]
pub fn inspect_committed_transition(
    mut record: Vec<u8>,
) -> Result<BrowserSealedEnvelopes, JsValue> {
    let result = browser::inspect_browser_committed(&record)
        .map(|inner| BrowserSealedEnvelopes { inner })
        .map_err(map_witness);
    record.fill(0);
    result
}

/// The output gate for one opened committed record. The worker reports the durable key facts it
/// observed; Rust enforces the order: successor key active, unanimous certificate, obsolete key
/// erased, then the exact result.
#[wasm_bindgen]
pub struct BrowserContinuation {
    inner: browser::BrowserContinuation,
}

#[wasm_bindgen]
pub fn open_committed_transition(
    mut record: Vec<u8>,
    mut inner_plaintext: Vec<u8>,
    mut outer_plaintext: Vec<u8>,
    lineage: &BrowserLineage,
) -> Result<BrowserContinuation, JsValue> {
    let result = browser::open_browser_committed(
        &record,
        &inner_plaintext,
        &outer_plaintext,
        &lineage.lineage,
        &lineage.credential,
    )
    .map(|mut opened| {
        opened.inner_state.fill(0);
        BrowserContinuation {
            inner: opened.continuation,
        }
    })
    .map_err(map_witness);
    record.fill(0);
    inner_plaintext.fill(0);
    outer_plaintext.fill(0);
    result
}

#[wasm_bindgen]
impl BrowserContinuation {
    pub fn operation_id(&self) -> Vec<u8> {
        self.inner.operation_id().to_vec()
    }
    pub fn counter(&self) -> u64 {
        self.inner.counter()
    }
    pub fn generation(&self) -> u64 {
        self.inner.generation()
    }
    pub fn current_key_id(&self) -> Vec<u8> {
        self.inner.current_key_id().to_vec()
    }
    pub fn commitment(&self) -> Vec<u8> {
        self.inner.commitment().to_vec()
    }
    pub fn predecessor_commitment(&self) -> Vec<u8> {
        self.inner.predecessor_commitment().to_vec()
    }
    pub fn has_obsolete_key(&self) -> bool {
        self.inner.has_obsolete_key()
    }
    pub fn witness_request(&self) -> Vec<u8> {
        self.inner.witness_request().to_vec()
    }
    pub fn request_hash(&self) -> Vec<u8> {
        self.inner.request_hash().to_vec()
    }
    pub fn certificate_hash(&self) -> Option<Vec<u8>> {
        self.inner.certificate_hash().map(|hash| hash.to_vec())
    }
    /// `"quarantined"`, `"revoked"`, or `undefined` after a witness decision against this lineage.
    pub fn terminal(&self) -> Option<String> {
        self.inner.terminal().map(|terminal| match terminal {
            EndpointTerminalState::Quarantined(_) => "quarantined".to_owned(),
            EndpointTerminalState::Revoked => "revoked".to_owned(),
        })
    }
    pub fn mark_current_key_active(&mut self) {
        self.inner.mark_current_key_active();
    }
    pub fn confirm_quorum(
        &mut self,
        mut certificate: Vec<u8>,
        trust: &BrowserReplicaTrust,
    ) -> Result<(), JsValue> {
        let result = if certificate.is_empty() || certificate.len() > WITNESS_CERTIFICATE_MAX_BYTES
        {
            Err(error("bound_exceeded"))
        } else {
            self.inner
                .confirm_quorum(&certificate, &trust.trust)
                .map_err(map_witness)
        };
        certificate.fill(0);
        result
    }
    pub fn mark_obsolete_key_erased(&mut self) -> Result<(), JsValue> {
        self.inner.mark_obsolete_key_erased().map_err(map_witness)
    }
    pub fn exact_result(&self) -> Result<Vec<u8>, JsValue> {
        self.inner
            .exact_result()
            .map(|bytes| bytes.to_vec())
            .map_err(map_witness)
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

/// Deterministic in-process three-replica witness. Test artifact only.
#[cfg(feature = "test-fixtures")]
#[wasm_bindgen]
pub struct TestWitness {
    inner: Arc<test_witness::TestWitness>,
}

#[cfg(feature = "test-fixtures")]
#[wasm_bindgen]
impl TestWitness {
    #[wasm_bindgen(constructor)]
    pub fn new() -> TestWitness {
        TestWitness {
            inner: test_witness::TestWitness::new(),
        }
    }

    pub fn trust(&self) -> BrowserReplicaTrust {
        BrowserReplicaTrust {
            trust: self.inner.trust(),
        }
    }

    /// Answer one exact request with a unanimous certificate, or fail as an unavailable quorum.
    pub fn respond(&self, mut request: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        let result =
            if request.is_empty() || request.len() > axl_e2ee::witness::WITNESS_REQUEST_MAX_BYTES {
                Err(error("bound_exceeded"))
            } else {
                axl_e2ee::witness::WitnessRequest::decode(&request)
                    .map_err(map_witness)
                    .and_then(|_| {
                        self.inner
                            .respond(&request)
                            .map_err(|_| error("witness_unavailable"))
                    })
            };
        request.fill(0);
        result
    }

    pub fn set_unavailable(&self, value: bool) {
        self.inner.set_unavailable(value);
    }

    pub fn set_forge_signature(&self, value: bool) {
        self.inner.set_forge_signature(value);
    }

    pub fn roll_back_all(&self, request: Vec<u8>) {
        self.inner.roll_back_all(&request);
    }

    pub fn advance_foreign(&self, request: Vec<u8>) {
        self.inner.advance_foreign(&request);
    }

    pub fn revoke(&self, request: Vec<u8>) {
        self.inner.revoke(&request);
    }

    pub fn responses(&self) -> u64 {
        self.inner.responses()
    }
}

#[cfg(feature = "test-fixtures")]
impl Default for TestWitness {
    fn default() -> Self {
        Self::new()
    }
}

/// Deterministic test lineage that produces finalizable transitions. Test artifact only.
#[cfg(feature = "test-fixtures")]
#[wasm_bindgen]
pub struct TestBrowserLineageFixture {
    inner: TestBrowserLineage,
}

#[cfg(feature = "test-fixtures")]
#[wasm_bindgen]
impl TestBrowserLineageFixture {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u8, device: bool) -> Result<TestBrowserLineageFixture, JsValue> {
        TestBrowserLineage::new(seed, device)
            .map(|inner| TestBrowserLineageFixture { inner })
            .map_err(map_witness)
    }

    pub fn lineage(&self) -> BrowserLineage {
        BrowserLineage {
            lineage: self.inner.lineage().clone(),
            credential: self.inner.credential().clone(),
        }
    }

    /// Prepare the next transition after the given confirmed head.
    #[allow(clippy::too_many_arguments)]
    pub fn transition(
        &self,
        confirmed_counter: u64,
        confirmed_commitment: Vec<u8>,
        previous_certificate_hash: Vec<u8>,
        operation_id: Vec<u8>,
        fingerprint: Vec<u8>,
        mut inner_state: Vec<u8>,
        mut exact_result: Vec<u8>,
    ) -> Result<BrowserTransition, JsValue> {
        let result = (|| {
            let confirmed = TestConfirmedHead {
                counter: confirmed_counter,
                commitment: fixed::<48>(confirmed_commitment)?,
                previous_certificate_hash: fixed::<48>(previous_certificate_hash)?,
            };
            self.inner
                .transition(
                    confirmed,
                    fixed::<16>(operation_id)?,
                    fixed::<48>(fingerprint)?,
                    &inner_state,
                    &exact_result,
                )
                .map(|inner| BrowserTransition { inner: Some(inner) })
                .map_err(map_witness)
        })();
        inner_state.fill(0);
        exact_result.fill(0);
        result
    }
}
