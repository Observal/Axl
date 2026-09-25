// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

//! Private browser WebAssembly boundary for the Axl endpoint E2EE core.

use axl_e2ee::pairing::{
    PAIRING_CLAIM_MAX_BYTES, PAIRING_INVITATION_MAX_BYTES, PairingClaimV1, PairingError,
    PairingInvitation,
};
use axl_e2ee::{
    CommitMetadata, Error, Identity, PROFILE_ID, PROFILE_REVISION,
    witness::{
        EndpointQuarantineReason, EndpointReconciliation, EndpointTerminalState, ReplicaTrustSet,
        WITNESS_CERTIFICATE_MAX_BYTES, WitnessError, WitnessRequestKind, browser,
        browser::endpoint::{
            BrowserEndpointError, BrowserMutation, BrowserPendingView, BrowserTypedResult,
            RestoredDisposition, RestoredRow,
        },
    },
};
#[cfg(feature = "test-fixtures")]
use axl_e2ee::{
    PairContext,
    browser_test_fixtures::{
        BrowserLifecycleEvidence, BrowserNegativeEvidence, TestPeerDaemon,
        browser_persistence_receive, browser_persistence_seed, browser_persistence_send,
        run_openmls_lifecycle, run_openmls_negative_cases, test_uuid_v7_id,
    },
    test_witness,
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

fn map_endpoint(value: BrowserEndpointError) -> JsValue {
    match value {
        BrowserEndpointError::Witness(error) => map_witness(error),
        BrowserEndpointError::Core(error) => map_core(error),
        BrowserEndpointError::CandidateOutstanding => error("lifecycle_busy"),
        BrowserEndpointError::NotOpened => error("endpoint_closed"),
        BrowserEndpointError::Pairing(error) => map_pairing(error),
    }
}

fn terminal_name(terminal: EndpointTerminalState) -> String {
    match terminal {
        EndpointTerminalState::Quarantined(_) => "quarantined".to_owned(),
        EndpointTerminalState::Revoked => "revoked".to_owned(),
    }
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

/// Pinned replica trust for certificate verification. Only Rust constructs it. The production
/// build-pinned trust set is not wired yet, so no production path can obtain one.
#[wasm_bindgen]
pub struct BrowserReplicaTrust {
    trust: Arc<ReplicaTrustSet>,
}

/// Replica trust for a deployment-test build. The worker passes the trust configuration whose
/// SHA-256 the build pinned in its integrity manifest; production builds do not contain this.
#[cfg(feature = "deployment-test")]
#[wasm_bindgen]
pub fn deployment_test_replica_trust(mut config: Vec<u8>) -> Result<BrowserReplicaTrust, JsValue> {
    let result = ReplicaTrustSet::decode_config(&config)
        .map(|trust| BrowserReplicaTrust {
            trust: Arc::new(trust),
        })
        .map_err(|_| error("invalid_argument"));
    config.fill(0);
    result
}

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
    pub fn token(&self) -> Result<u64, JsValue> {
        Ok(self.get()?.token())
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
    pub fn token(&self) -> u64 {
        self.inner.token
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

/// Immutable view of the one pending operation the worker may transport.
#[wasm_bindgen]
pub struct BrowserPendingWitness {
    inner: BrowserPendingView,
}

#[wasm_bindgen]
impl BrowserPendingWitness {
    pub fn operation_id(&self) -> Vec<u8> {
        self.inner.operation_id.to_vec()
    }
    pub fn witness_request(&self) -> Vec<u8> {
        self.inner.request_bytes.clone()
    }
    pub fn request_hash(&self) -> Vec<u8> {
        self.inner.request_hash.to_vec()
    }
    /// `"register"` or `"advance"`.
    pub fn kind(&self) -> String {
        match self.inner.kind {
            WitnessRequestKind::Register => "register",
            WitnessRequestKind::Advance => "advance",
            WitnessRequestKind::Read => "read",
        }
        .to_owned()
    }
}

/// Exact typed result of one completed operation, released only after the barrier.
#[wasm_bindgen]
pub struct BrowserExactResult {
    inner: BrowserTypedResult,
}

#[wasm_bindgen]
impl BrowserExactResult {
    /// `"key_package"`, `"joined"`, `"envelope"`, `"plaintext"`, or `"commit_applied"`.
    pub fn tag(&self) -> String {
        match self.inner {
            BrowserTypedResult::KeyPackage { .. } => "key_package",
            BrowserTypedResult::Joined { .. } => "joined",
            BrowserTypedResult::Envelope { .. } => "envelope",
            BrowserTypedResult::Plaintext { .. } => "plaintext",
            BrowserTypedResult::CommitApplied { .. } => "commit_applied",
        }
        .to_owned()
    }
    /// KeyPackage bytes, exact ciphertext, or exact plaintext.
    pub fn bytes(&self) -> Option<Vec<u8>> {
        match &self.inner {
            BrowserTypedResult::KeyPackage { bytes } => Some(bytes.clone()),
            BrowserTypedResult::Envelope { ciphertext, .. } => Some(ciphertext.clone()),
            BrowserTypedResult::Plaintext { plaintext, .. } => Some(plaintext.clone()),
            _ => None,
        }
    }
    pub fn logical_message_id(&self) -> Option<Vec<u8>> {
        match &self.inner {
            BrowserTypedResult::Envelope {
                logical_message_id, ..
            }
            | BrowserTypedResult::Plaintext {
                logical_message_id, ..
            } => Some(logical_message_id.to_vec()),
            _ => None,
        }
    }
    pub fn message_class(&self) -> Option<u8> {
        match &self.inner {
            BrowserTypedResult::Envelope { class, .. }
            | BrowserTypedResult::Plaintext { class, .. } => Some(*class as u8),
            _ => None,
        }
    }
    pub fn epoch(&self) -> Option<u64> {
        match &self.inner {
            BrowserTypedResult::Joined { epoch }
            | BrowserTypedResult::Envelope { epoch, .. }
            | BrowserTypedResult::Plaintext { epoch, .. } => Some(*epoch),
            BrowserTypedResult::CommitApplied { target_epoch, .. } => Some(*target_epoch),
            BrowserTypedResult::KeyPackage { .. } => None,
        }
    }
    pub fn hosted_generation(&self) -> Option<u64> {
        match &self.inner {
            BrowserTypedResult::Envelope {
                hosted_generation, ..
            } => Some(*hosted_generation),
            _ => None,
        }
    }
    pub fn commit_id(&self) -> Option<Vec<u8>> {
        match &self.inner {
            BrowserTypedResult::CommitApplied { commit_id, .. } => Some(commit_id.to_vec()),
            _ => None,
        }
    }
    pub fn epoch_authenticator(&self) -> Option<Vec<u8>> {
        match &self.inner {
            BrowserTypedResult::CommitApplied {
                epoch_authenticator,
                ..
            } => Some(epoch_authenticator.to_vec()),
            _ => None,
        }
    }
    pub fn removal(&self) -> Option<bool> {
        match &self.inner {
            BrowserTypedResult::CommitApplied { removal, .. } => Some(*removal),
            _ => None,
        }
    }
}

/// Outcome of one mutation: the exact pending duplicate, the exact released duplicate, or one
/// fresh transition for the worker to seal and commit.
#[wasm_bindgen]
pub struct BrowserMutationOutcome {
    inner: Option<BrowserMutation>,
}

#[wasm_bindgen]
impl BrowserMutationOutcome {
    /// `"pending"`, `"released"`, or `"fresh"`.
    pub fn kind(&self) -> Result<String, JsValue> {
        Ok(
            match self.inner.as_ref().ok_or_else(|| error("consumed"))? {
                BrowserMutation::Pending(_) => "pending",
                BrowserMutation::Released(_) => "released",
                BrowserMutation::Fresh(_) => "fresh",
            }
            .to_owned(),
        )
    }
    pub fn take_pending(&mut self) -> Result<BrowserPendingWitness, JsValue> {
        match self.inner.take() {
            Some(BrowserMutation::Pending(inner)) => Ok(BrowserPendingWitness { inner }),
            other => {
                self.inner = other;
                Err(error("invalid_argument"))
            }
        }
    }
    pub fn take_result(&mut self) -> Result<BrowserExactResult, JsValue> {
        match self.inner.take() {
            Some(BrowserMutation::Released(inner)) => Ok(BrowserExactResult { inner }),
            other => {
                self.inner = other;
                Err(error("invalid_argument"))
            }
        }
    }
    pub fn take_transition(&mut self) -> Result<BrowserTransition, JsValue> {
        match self.inner.take() {
            Some(BrowserMutation::Fresh(transition)) => Ok(BrowserTransition {
                inner: Some(*transition),
            }),
            other => {
                self.inner = other;
                Err(error("invalid_argument"))
            }
        }
    }
}

/// Head facts for the completion transaction after the certificate verified.
#[wasm_bindgen]
pub struct BrowserCompletion {
    counter: u64,
    commitment: [u8; 48],
    certificate_hash: [u8; 48],
}

#[wasm_bindgen]
impl BrowserCompletion {
    pub fn counter(&self) -> u64 {
        self.counter
    }
    pub fn commitment(&self) -> Vec<u8> {
        self.commitment.to_vec()
    }
    pub fn certificate_hash(&self) -> Vec<u8> {
        self.certificate_hash.to_vec()
    }
}

fn reconciliation_json(value: EndpointReconciliation) -> String {
    let (tag, reason) = match value {
        EndpointReconciliation::Ready => ("ready", None),
        EndpointReconciliation::ResendPending => ("resend_pending", None),
        EndpointReconciliation::RecoverAccepted => ("recover_accepted", None),
        EndpointReconciliation::WitnessUnavailable => ("witness_unavailable", None),
        EndpointReconciliation::Revoked => ("revoked", None),
        EndpointReconciliation::Quarantined(reason) => (
            "quarantined",
            Some(match reason {
                EndpointQuarantineReason::StateLoss => "stale_local_state",
                EndpointQuarantineReason::PendingWithoutLocalState => "pending_without_local_state",
                EndpointQuarantineReason::WitnessLineageMissing => "witness_lineage_missing",
                EndpointQuarantineReason::CommitmentConflict => "commitment_conflict",
                EndpointQuarantineReason::LocalAheadMoreThanOne => "local_ahead_more_than_one",
                EndpointQuarantineReason::WitnessBehindMoreThanOne => {
                    "witness_behind_more_than_one"
                }
                EndpointQuarantineReason::WitnessInconsistent => "witness_inconsistent",
                EndpointQuarantineReason::ImmediateFork => "immediate_fork",
                EndpointQuarantineReason::HistoricalFork => "historical_fork",
            }),
        ),
    };
    match reason {
        Some(reason) => format!("{{\"tag\":\"{tag}\",\"reason\":\"{reason}\"}}"),
        None => format!("{{\"tag\":\"{tag}\"}}"),
    }
}

fn now_ms(value: f64) -> Result<u64, JsValue> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > 9_007_199_254_740_991.0
    {
        return Err(error("invalid_argument"));
    }
    Ok(value as u64)
}

fn bounded(value: &[u8], max: usize) -> Result<(), JsValue> {
    if value.is_empty() || value.len() > max {
        return Err(error("bound_exceeded"));
    }
    Ok(())
}

/// The browser device endpoint. It owns the witness state machine, the authenticated committed
/// image, duplicate lookup, the exact-result index, and the output gate. The worker moves bytes
/// between it, WebCrypto, and IndexedDB and reports durable facts back. There is no JavaScript
/// constructor; creation and opening require Rust-owned replica trust.
#[wasm_bindgen]
pub struct BrowserEndpoint {
    inner: browser::endpoint::BrowserEndpoint,
}

/// Create a brand-new device endpoint. Returns the endpoint; the counter-1 register transition
/// is available once through `take_transition`.
#[wasm_bindgen]
pub fn create_device_endpoint(
    account_id: Vec<u8>,
    installation_id: Vec<u8>,
    device_id: Vec<u8>,
    crypto_session_id: Vec<u8>,
    trust: &BrowserReplicaTrust,
    operation_id: Vec<u8>,
    now: f64,
) -> Result<BrowserCreatedEndpoint, JsValue> {
    let identity = Identity::device(
        fixed::<16>(account_id)?,
        fixed::<16>(installation_id)?,
        fixed::<16>(device_id)?,
    )
    .map_err(map_core)?;
    let (endpoint, transition) = browser::endpoint::BrowserEndpoint::create(
        identity,
        fixed::<16>(crypto_session_id)?,
        Arc::clone(&trust.trust),
        fixed::<16>(operation_id)?,
        now_ms(now)?,
    )
    .map_err(map_endpoint)?;
    Ok(BrowserCreatedEndpoint {
        endpoint: Some(BrowserEndpoint { inner: endpoint }),
        transition: Some(BrowserTransition {
            inner: Some(transition),
        }),
    })
}

/// A freshly created endpoint and its one register transition, each takeable once.
#[wasm_bindgen]
pub struct BrowserCreatedEndpoint {
    endpoint: Option<BrowserEndpoint>,
    transition: Option<BrowserTransition>,
}

#[wasm_bindgen]
impl BrowserCreatedEndpoint {
    pub fn take_endpoint(&mut self) -> Result<BrowserEndpoint, JsValue> {
        self.endpoint.take().ok_or_else(|| error("consumed"))
    }
    pub fn take_transition(&mut self) -> Result<BrowserTransition, JsValue> {
        self.transition.take().ok_or_else(|| error("consumed"))
    }
}

/// An endpoint that must be restored from its committed record before use.
#[wasm_bindgen]
pub fn open_device_endpoint(
    crypto_session_id: Vec<u8>,
    trust: &BrowserReplicaTrust,
) -> Result<BrowserEndpoint, JsValue> {
    Ok(BrowserEndpoint {
        inner: browser::endpoint::BrowserEndpoint::open(
            fixed::<16>(crypto_session_id)?,
            Arc::clone(&trust.trust),
        ),
    })
}

#[wasm_bindgen]
impl BrowserEndpoint {
    /// Restore from the committed record whose envelopes WebCrypto decrypted plus the durable row
    /// facts. Returns the pending request descriptor when the row is pending.
    #[allow(clippy::too_many_arguments)]
    pub fn restore(
        &mut self,
        mut record: Vec<u8>,
        mut inner_plaintext: Vec<u8>,
        mut outer_plaintext: Vec<u8>,
        disposition: String,
        generation: u64,
        confirmed_counter: u64,
        confirmed_commitment: Vec<u8>,
        previous_certificate_hash: Vec<u8>,
    ) -> Result<Option<BrowserPendingWitness>, JsValue> {
        let result = (|| {
            let disposition = match disposition.as_str() {
                "pending" => RestoredDisposition::Pending,
                "completed" => RestoredDisposition::Completed,
                _ => return Err(error("invalid_argument")),
            };
            let row = RestoredRow {
                disposition,
                generation,
                confirmed_counter,
                confirmed_commitment: fixed::<48>(confirmed_commitment)?,
                previous_certificate_hash: fixed::<48>(previous_certificate_hash)?,
            };
            self.inner
                .restore(&record, &inner_plaintext, &outer_plaintext, &row)
                .map(|pending| pending.map(|inner| BrowserPendingWitness { inner }))
                .map_err(map_endpoint)
        })();
        record.fill(0);
        inner_plaintext.fill(0);
        outer_plaintext.fill(0);
        result
    }

    pub fn is_restored(&self) -> bool {
        self.inner.is_restored()
    }
    pub fn head_counter(&self) -> u64 {
        self.inner.head().0
    }
    pub fn head_commitment(&self) -> Vec<u8> {
        self.inner.head().1.to_vec()
    }
    pub fn generation(&self) -> u64 {
        self.inner.generation()
    }
    /// `"quarantined"` or `"revoked"` once, when a terminal decision awaits persistence.
    pub fn take_unpersisted_terminal(&mut self) -> Option<String> {
        self.inner.take_unpersisted_terminal().map(terminal_name)
    }
    pub fn terminal(&self) -> Option<String> {
        self.inner.terminal().map(terminal_name)
    }

    pub fn witness_read_request(&mut self) -> Result<Vec<u8>, JsValue> {
        self.inner.witness_read_request().map_err(map_endpoint)
    }
    /// JSON `{"tag": ..., "reason"?: ...}` matching the Node reconciliation shape.
    pub fn reconcile_witness(&mut self, mut certificate: Vec<u8>) -> Result<String, JsValue> {
        let result = bounded(&certificate, WITNESS_CERTIFICATE_MAX_BYTES).and_then(|()| {
            self.inner
                .reconcile_witness(&certificate)
                .map(reconciliation_json)
                .map_err(map_endpoint)
        });
        certificate.fill(0);
        result
    }
    pub fn pending_witness(&self) -> Result<Option<BrowserPendingWitness>, JsValue> {
        self.inner
            .pending_witness()
            .map(|pending| pending.map(|inner| BrowserPendingWitness { inner }))
            .map_err(map_endpoint)
    }
    /// The pending descriptor for the worker's own durable-row comparison, before activation.
    pub fn pending_descriptor(&self) -> Option<BrowserPendingWitness> {
        self.inner
            .pending_descriptor()
            .map(|inner| BrowserPendingWitness { inner })
    }
    pub fn mark_current_key_active(&mut self) -> Result<(), JsValue> {
        self.inner.mark_current_key_active().map_err(map_endpoint)
    }
    pub fn has_obsolete_key(&self) -> Result<bool, JsValue> {
        self.inner.has_obsolete_key().map_err(map_endpoint)
    }
    pub fn confirm_quorum(&mut self, mut certificate: Vec<u8>) -> Result<(), JsValue> {
        let result = bounded(&certificate, WITNESS_CERTIFICATE_MAX_BYTES).and_then(|()| {
            self.inner
                .confirm_quorum(&certificate)
                .map_err(map_endpoint)
        });
        certificate.fill(0);
        result
    }
    pub fn completion_head(&self) -> Result<BrowserCompletion, JsValue> {
        self.inner
            .completion_head()
            .map(|head| BrowserCompletion {
                counter: head.counter,
                commitment: head.commitment,
                certificate_hash: head.certificate_hash,
            })
            .map_err(map_endpoint)
    }
    pub fn mark_obsolete_key_erased(&mut self) -> Result<(), JsValue> {
        self.inner.mark_obsolete_key_erased().map_err(map_endpoint)
    }
    pub fn release(&mut self) -> Result<BrowserExactResult, JsValue> {
        self.inner
            .release()
            .map(|inner| BrowserExactResult { inner })
            .map_err(map_endpoint)
    }
    pub fn local_commit_complete(
        &mut self,
        committed: &BrowserCommittedTransition,
    ) -> Result<(), JsValue> {
        self.inner
            .local_commit_complete(&committed.inner)
            .map_err(map_endpoint)
    }
    pub fn discard_candidate(&mut self) {
        self.inner.discard_candidate();
    }
    pub fn has_candidate(&self) -> bool {
        self.inner.has_candidate()
    }

    /// Canonical device claim for a daemon invitation, signed over this endpoint's own retained
    /// KeyPackage. Read-only; no witness round.
    pub fn pairing_claim(&self, mut invitation: Vec<u8>, now: f64) -> Result<Vec<u8>, JsValue> {
        let result = bounded(&invitation, PAIRING_INVITATION_MAX_BYTES).and_then(|()| {
            self.inner
                .pairing_claim(&invitation, now_ms(now)?)
                .map_err(map_endpoint)
        });
        invitation.fill(0);
        result
    }

    // Mutations.

    pub fn join_published(
        &mut self,
        operation_id: Vec<u8>,
        mut welcome: Vec<u8>,
        now: f64,
    ) -> Result<BrowserMutationOutcome, JsValue> {
        let result = (|| {
            bounded(&welcome, axl_e2ee::HANDSHAKE_MAX_BYTES)?;
            self.inner
                .join_published(fixed::<16>(operation_id)?, &welcome, now_ms(now)?)
                .map_err(map_endpoint)
        })();
        welcome.fill(0);
        outcome(result)
    }

    pub fn prepare_pair_activation(
        &mut self,
        operation_id: Vec<u8>,
        logical_message_id: Vec<u8>,
        claim: Vec<u8>,
        now: f64,
    ) -> Result<BrowserMutationOutcome, JsValue> {
        let result = (|| {
            bounded(&claim, PAIRING_CLAIM_MAX_BYTES)?;
            self.inner
                .prepare_pair_activation(
                    fixed::<16>(operation_id)?,
                    fixed::<16>(logical_message_id)?,
                    &claim,
                    now_ms(now)?,
                )
                .map_err(map_endpoint)
        })();
        outcome(result)
    }

    pub fn join(
        &mut self,
        operation_id: Vec<u8>,
        mut welcome: Vec<u8>,
        group_id: Vec<u8>,
        now: f64,
    ) -> Result<BrowserMutationOutcome, JsValue> {
        let result = (|| {
            bounded(&welcome, axl_e2ee::HANDSHAKE_MAX_BYTES)?;
            self.inner
                .join(
                    fixed::<16>(operation_id)?,
                    &welcome,
                    fixed::<32>(group_id)?,
                    now_ms(now)?,
                )
                .map_err(map_endpoint)
        })();
        welcome.fill(0);
        outcome(result)
    }

    pub fn prepare_activation(
        &mut self,
        operation_id: Vec<u8>,
        logical_message_id: Vec<u8>,
        mut plaintext: Vec<u8>,
        now: f64,
    ) -> Result<BrowserMutationOutcome, JsValue> {
        let result = (|| {
            bounded(&plaintext, axl_e2ee::APPLICATION_MAX_BYTES)?;
            self.inner
                .prepare_activation(
                    fixed::<16>(operation_id)?,
                    fixed::<16>(logical_message_id)?,
                    &plaintext,
                    now_ms(now)?,
                )
                .map_err(map_endpoint)
        })();
        plaintext.fill(0);
        outcome(result)
    }

    pub fn prepare_application(
        &mut self,
        operation_id: Vec<u8>,
        logical_message_id: Vec<u8>,
        hosted_generation: u64,
        mut plaintext: Vec<u8>,
        now: f64,
    ) -> Result<BrowserMutationOutcome, JsValue> {
        let result = (|| {
            bounded(&plaintext, axl_e2ee::APPLICATION_MAX_BYTES)?;
            self.inner
                .prepare_application(
                    fixed::<16>(operation_id)?,
                    fixed::<16>(logical_message_id)?,
                    hosted_generation,
                    &plaintext,
                    now_ms(now)?,
                )
                .map_err(map_endpoint)
        })();
        plaintext.fill(0);
        outcome(result)
    }

    pub fn receive_application(
        &mut self,
        operation_id: Vec<u8>,
        logical_message_id: Vec<u8>,
        hosted_generation: u64,
        mut ciphertext: Vec<u8>,
        now: f64,
    ) -> Result<BrowserMutationOutcome, JsValue> {
        let result = (|| {
            bounded(&ciphertext, axl_e2ee::ENVELOPE_MAX_BYTES)?;
            self.inner
                .receive_application(
                    fixed::<16>(operation_id)?,
                    fixed::<16>(logical_message_id)?,
                    hosted_generation,
                    &ciphertext,
                    now_ms(now)?,
                )
                .map_err(map_endpoint)
        })();
        ciphertext.fill(0);
        outcome(result)
    }

    pub fn prepare_replacement(
        &mut self,
        operation_id: Vec<u8>,
        logical_message_id: Vec<u8>,
        hosted_generation: u64,
        now: f64,
    ) -> Result<BrowserMutationOutcome, JsValue> {
        outcome(
            self.inner
                .prepare_replacement(
                    fixed::<16>(operation_id)?,
                    fixed::<16>(logical_message_id)?,
                    hosted_generation,
                    now_ms(now)?,
                )
                .map_err(map_endpoint),
        )
    }

    pub fn apply_update_commit(
        &mut self,
        operation_id: Vec<u8>,
        logical_message_id: Vec<u8>,
        hosted_generation: u64,
        mut ciphertext: Vec<u8>,
        now: f64,
    ) -> Result<BrowserMutationOutcome, JsValue> {
        let result = (|| {
            bounded(&ciphertext, axl_e2ee::ENVELOPE_MAX_BYTES)?;
            self.inner
                .apply_update_commit(
                    fixed::<16>(operation_id)?,
                    fixed::<16>(logical_message_id)?,
                    hosted_generation,
                    &ciphertext,
                    now_ms(now)?,
                )
                .map_err(map_endpoint)
        })();
        ciphertext.fill(0);
        outcome(result)
    }

    /// Epoch-ready send for the applied commit named by its exact metadata. The endpoint refuses
    /// any commit other than the one it applied and has not yet announced, and derives the
    /// canonical plaintext itself.
    #[allow(clippy::too_many_arguments)]
    pub fn prepare_epoch_ready(
        &mut self,
        operation_id: Vec<u8>,
        logical_message_id: Vec<u8>,
        hosted_generation: u64,
        commit_id: Vec<u8>,
        target_epoch: u64,
        epoch_authenticator: Vec<u8>,
        now: f64,
    ) -> Result<BrowserMutationOutcome, JsValue> {
        let result = (|| {
            let commit = CommitMetadata {
                commit_id: fixed::<48>(commit_id)?,
                target_epoch,
                epoch_authenticator: fixed::<48>(epoch_authenticator)?,
            };
            self.inner
                .prepare_epoch_ready(
                    fixed::<16>(operation_id)?,
                    fixed::<16>(logical_message_id)?,
                    hosted_generation,
                    &commit,
                    now_ms(now)?,
                )
                .map_err(map_endpoint)
        })();
        outcome(result)
    }

    pub fn accept_epoch_ready_confirmation(
        &mut self,
        operation_id: Vec<u8>,
        logical_message_id: Vec<u8>,
        hosted_generation: u64,
        mut ciphertext: Vec<u8>,
        now: f64,
    ) -> Result<BrowserMutationOutcome, JsValue> {
        let result = (|| {
            bounded(&ciphertext, axl_e2ee::ENVELOPE_MAX_BYTES)?;
            self.inner
                .accept_epoch_ready_confirmation(
                    fixed::<16>(operation_id)?,
                    fixed::<16>(logical_message_id)?,
                    hosted_generation,
                    &ciphertext,
                    now_ms(now)?,
                )
                .map_err(map_endpoint)
        })();
        ciphertext.fill(0);
        outcome(result)
    }

    pub fn apply_removal(
        &mut self,
        operation_id: Vec<u8>,
        logical_message_id: Vec<u8>,
        hosted_generation: u64,
        mut ciphertext: Vec<u8>,
        now: f64,
    ) -> Result<BrowserMutationOutcome, JsValue> {
        let result = (|| {
            bounded(&ciphertext, axl_e2ee::ENVELOPE_MAX_BYTES)?;
            self.inner
                .apply_removal(
                    fixed::<16>(operation_id)?,
                    fixed::<16>(logical_message_id)?,
                    hosted_generation,
                    &ciphertext,
                    now_ms(now)?,
                )
                .map_err(map_endpoint)
        })();
        ciphertext.fill(0);
        outcome(result)
    }
}

fn outcome(result: Result<BrowserMutation, JsValue>) -> Result<BrowserMutationOutcome, JsValue> {
    result.map(|inner| BrowserMutationOutcome { inner: Some(inner) })
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

    /// Canonical trust configuration naming this witness's replica keys.
    pub fn trust_config(&self) -> Result<Vec<u8>, JsValue> {
        self.inner
            .trust()
            .encode_config()
            .map_err(|_| error("internal_error"))
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

/// Test-only in-WASM pairing daemon: the peer of a browser device endpoint under test. Test
/// artifact only.
#[cfg(feature = "test-fixtures")]
#[wasm_bindgen]
pub struct TestPeerDaemonFixture {
    inner: TestPeerDaemon,
}

#[cfg(feature = "test-fixtures")]
#[wasm_bindgen]
impl TestPeerDaemonFixture {
    /// Deterministic UUIDv7-shaped pair context derived from one seed.
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u8, now: f64) -> Result<TestPeerDaemonFixture, JsValue> {
        let context = PairContext {
            crypto_session_id: test_uuid_v7_id(seed),
            group_id: [seed.wrapping_add(1); 32],
            account_id: test_uuid_v7_id(seed.wrapping_add(2)),
            installation_id: test_uuid_v7_id(seed.wrapping_add(3)),
            device_id: test_uuid_v7_id(seed.wrapping_add(4)),
        };
        TestPeerDaemon::new(context, test_now(now)?)
            .map(|inner| TestPeerDaemonFixture { inner })
            .map_err(map_core)
    }

    pub fn crypto_session_id(&self) -> Vec<u8> {
        self.inner.context().crypto_session_id.to_vec()
    }
    pub fn group_id(&self) -> Vec<u8> {
        self.inner.context().group_id.to_vec()
    }
    pub fn account_id(&self) -> Vec<u8> {
        self.inner.context().account_id.to_vec()
    }
    pub fn installation_id(&self) -> Vec<u8> {
        self.inner.context().installation_id.to_vec()
    }
    pub fn device_id(&self) -> Vec<u8> {
        self.inner.context().device_id.to_vec()
    }
    pub fn epoch(&self) -> Result<u64, JsValue> {
        self.inner.epoch().map_err(map_core)
    }
    pub fn epoch_authenticator(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.epoch_authenticator().map_err(map_core)
    }
    pub fn consume_key_package(&mut self, key_package: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        self.inner
            .consume_key_package(&key_package)
            .map_err(map_core)
    }
    pub fn receive_activation(
        &mut self,
        ciphertext: Vec<u8>,
        logical_message_id: Vec<u8>,
    ) -> Result<Vec<u8>, JsValue> {
        self.inner
            .receive_activation(&ciphertext, test_operation_id(logical_message_id)?)
            .map_err(map_core)
    }
    pub fn prepare_delivery(
        &mut self,
        logical_message_id: Vec<u8>,
        generation: u64,
        plaintext: Vec<u8>,
    ) -> Result<Vec<u8>, JsValue> {
        self.inner
            .prepare_delivery(
                test_operation_id(logical_message_id)?,
                generation,
                &plaintext,
            )
            .map_err(map_core)
    }
    pub fn receive_application(
        &mut self,
        ciphertext: Vec<u8>,
        logical_message_id: Vec<u8>,
        generation: u64,
    ) -> Result<Vec<u8>, JsValue> {
        self.inner
            .receive_application(
                &ciphertext,
                test_operation_id(logical_message_id)?,
                generation,
            )
            .map_err(map_core)
    }
    pub fn receive_update_proposal(
        &mut self,
        ciphertext: Vec<u8>,
        logical_message_id: Vec<u8>,
        generation: u64,
    ) -> Result<(), JsValue> {
        self.inner
            .receive_update_proposal(
                &ciphertext,
                test_operation_id(logical_message_id)?,
                generation,
            )
            .map_err(map_core)
    }
    /// Returns the commit ciphertext; `last_commit_*` expose its metadata.
    pub fn prepare_commit(
        &mut self,
        logical_message_id: Vec<u8>,
        generation: u64,
    ) -> Result<TestCommitFixture, JsValue> {
        self.inner
            .prepare_commit(test_operation_id(logical_message_id)?, generation)
            .map(|(ciphertext, metadata)| TestCommitFixture {
                ciphertext,
                commit_id: metadata.commit_id,
                target_epoch: metadata.target_epoch,
                epoch_authenticator: metadata.epoch_authenticator,
            })
            .map_err(map_core)
    }
    pub fn receive_epoch_ready(
        &mut self,
        ciphertext: Vec<u8>,
        logical_message_id: Vec<u8>,
        generation: u64,
    ) -> Result<Vec<u8>, JsValue> {
        self.inner
            .receive_epoch_ready(
                &ciphertext,
                test_operation_id(logical_message_id)?,
                generation,
            )
            .map_err(map_core)
    }
    pub fn prepare_resync_control(
        &mut self,
        logical_message_id: Vec<u8>,
        generation: u64,
        plaintext: Vec<u8>,
    ) -> Result<Vec<u8>, JsValue> {
        self.inner
            .prepare_resync_control(
                test_operation_id(logical_message_id)?,
                generation,
                &plaintext,
            )
            .map_err(map_core)
    }
    pub fn prepare_removal(
        &mut self,
        logical_message_id: Vec<u8>,
        generation: u64,
    ) -> Result<Vec<u8>, JsValue> {
        self.inner
            .prepare_removal(test_operation_id(logical_message_id)?, generation)
            .map_err(map_core)
    }
}

/// A daemon commit and its metadata. Test artifact only.
#[cfg(feature = "test-fixtures")]
#[wasm_bindgen]
pub struct TestCommitFixture {
    ciphertext: Vec<u8>,
    commit_id: [u8; 48],
    target_epoch: u64,
    epoch_authenticator: [u8; 48],
}

#[cfg(feature = "test-fixtures")]
#[wasm_bindgen]
impl TestCommitFixture {
    pub fn ciphertext(&self) -> Vec<u8> {
        self.ciphertext.clone()
    }
    pub fn commit_id(&self) -> Vec<u8> {
        self.commit_id.to_vec()
    }
    pub fn target_epoch(&self) -> u64 {
        self.target_epoch
    }
    pub fn epoch_authenticator(&self) -> Vec<u8> {
        self.epoch_authenticator.to_vec()
    }
}
