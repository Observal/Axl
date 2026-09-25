// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

//! Private browser finalization over exact sealed bytes.
//!
//! WebCrypto, not Rust, seals and unseals browser state. Rust still owns everything the witness
//! protocol binds: the clear authenticated header, both AEAD nonces and AADs, the canonical inner
//! payload, the state commitment over the exact sealed inner bytes, the fixed signed witness
//! request, the outer metadata, the canonical committed record, certificate verification, and the
//! output gate. The worker moves bytes between WebCrypto and these functions. It cannot select a
//! counter, commitment, nonce, key ID, request, or result, and the page protocol never reaches this
//! module.
//!
//! The committed record produced here is byte-compatible with the native `CommittedTransition`
//! format, so one format describes every endpoint's durable pending operation.

use openmls_basic_credential::SignatureKeyPair;
use openmls_traits::{OpenMlsProvider as _, random::OpenMlsRand as _};

use super::{
    COMMITTED_TRANSITION_VERSION, CommittedTransitionInfo, Cursor, EndpointTerminalState,
    INNER_AAD_DOMAIN, MAX_COMMITTED_TRANSITION_BYTES, MAX_INNER_PAYLOAD_BYTES,
    MAX_INNER_STATE_BYTES, MAX_RESULT_BYTES, OUTER_AAD_DOMAIN, OuterMetadata,
    PendingWitnessOperation, ReplicaTrustSet, SealedWitnessState, WitnessError, WitnessLineage,
    WitnessRequest, WitnessRequestKind, WitnessRequestSigning, WitnessStateHeader, ZERO_HASH,
    decode_inner_payload, decode_outer, encode_header, encode_inner_payload, encode_outer,
    put_u32_bytes, sha384, state_commitment,
};
use crate::{CoreProvider, Id, pairing::PairingCredential};

pub mod endpoint;

/// AES-256-GCM authentication tag length appended by WebCrypto.
const AEAD_TAG_BYTES: usize = 16;

/// Material for one browser transition. Only the transient Rust endpoint constructs it; the worker
/// never sees a field.
pub struct BrowserTransitionMaterial<'a> {
    pub lineage: WitnessLineage,
    pub counter: u64,
    pub generation: u64,
    pub epoch: u64,
    pub epoch_authenticator: [u8; 48],
    pub predecessor_commitment: [u8; 48],
    pub previous_certificate_hash: [u8; 48],
    pub operation_id: Id,
    pub fingerprint: [u8; 48],
    pub inner_state: &'a [u8],
    pub exact_result: &'a [u8],
    pub credential: &'a PairingCredential,
    /// Owned copy read from the endpoint's OpenMLS store for this one transition.
    pub signer: SignatureKeyPair,
    /// Binds this transition to the endpoint candidate that produced it. The endpoint accepts a
    /// committed transition only when the token matches its one retained candidate.
    pub token: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Stage {
    PayloadUntaken,
    InnerUnsealed,
    OuterUnsealed,
}

/// One prepared browser transition. The stages are fixed: take the inner payload once, return the
/// exact sealed inner bytes, receive the outer metadata, return the exact sealed outer bytes, and
/// receive the canonical committed record. Every step is single use.
pub struct BrowserTransition {
    header: WitnessStateHeader,
    header_bytes: Vec<u8>,
    inner_nonce: [u8; 12],
    outer_nonce: [u8; 12],
    inner_payload: Vec<u8>,
    inner_payload_len: usize,
    predecessor: [u8; 48],
    previous_certificate_hash: [u8; 48],
    fingerprint: [u8; 48],
    operation_id: Id,
    credential: PairingCredential,
    signer: SignatureKeyPair,
    sealed_inner: Vec<u8>,
    commitment: [u8; 48],
    request: Option<WitnessRequest>,
    request_bytes: Vec<u8>,
    request_hash: [u8; 48],
    outer_len: usize,
    stage: Stage,
    token: u64,
}

/// Non-secret result of a completed browser transition. The record is the canonical committed
/// transition; the request is the exact signed bytes the worker persists and later transports.
pub struct BrowserCommittedTransition {
    pub operation_id: Id,
    pub fingerprint: [u8; 48],
    pub counter: u64,
    pub generation: u64,
    pub current_key_id: Id,
    pub predecessor_commitment: [u8; 48],
    pub commitment: [u8; 48],
    pub committed_record: Vec<u8>,
    pub request_bytes: Vec<u8>,
    pub request_hash: [u8; 48],
    pub token: u64,
}

impl BrowserTransition {
    /// Prepare the header, nonces, key ID, and canonical inner payload for WebCrypto sealing.
    pub fn prepare(material: BrowserTransitionMaterial<'_>) -> Result<Self, WitnessError> {
        if material.inner_state.len() > MAX_INNER_STATE_BYTES
            || material.exact_result.len() > MAX_RESULT_BYTES
            || material.counter == 0
            || material.generation == 0
        {
            return Err(WitnessError::BoundExceeded);
        }
        if material.signer.public() != material.credential.verification_key() {
            return Err(WitnessError::CredentialMismatch);
        }
        if (material.counter == 1) != (material.predecessor_commitment == ZERO_HASH) {
            return Err(WitnessError::PredecessorMismatch);
        }
        let provider = CoreProvider::new().map_err(|_| WitnessError::Crypto)?;
        let current_key_id = loop {
            let value: Id = provider
                .rand()
                .random_array()
                .map_err(|_| WitnessError::Crypto)?;
            if value != [0; 16] {
                break value;
            }
        };
        let inner_nonce: [u8; 12] = provider
            .rand()
            .random_array()
            .map_err(|_| WitnessError::Crypto)?;
        let outer_nonce = loop {
            let value: [u8; 12] = provider
                .rand()
                .random_array()
                .map_err(|_| WitnessError::Crypto)?;
            if value != inner_nonce {
                break value;
            }
        };
        let header = WitnessStateHeader {
            lineage: material.lineage,
            counter: material.counter,
            generation: material.generation,
            epoch: material.epoch,
            epoch_authenticator: material.epoch_authenticator,
            current_key_id,
        };
        let header_bytes = encode_header(&header)?;
        let inner_payload = encode_inner_payload(material.inner_state, material.exact_result)?;
        let inner_payload_len = inner_payload.len();
        Ok(Self {
            header,
            header_bytes,
            inner_nonce,
            outer_nonce,
            inner_payload,
            inner_payload_len,
            predecessor: material.predecessor_commitment,
            previous_certificate_hash: material.previous_certificate_hash,
            fingerprint: material.fingerprint,
            operation_id: material.operation_id,
            credential: material.credential.clone(),
            signer: material.signer,
            sealed_inner: Vec::new(),
            commitment: ZERO_HASH,
            request: None,
            request_bytes: Vec::new(),
            request_hash: ZERO_HASH,
            outer_len: 0,
            stage: Stage::PayloadUntaken,
            token: material.token,
        })
    }

    pub fn token(&self) -> u64 {
        self.token
    }

    pub fn operation_id(&self) -> Id {
        self.operation_id
    }
    pub fn fingerprint(&self) -> [u8; 48] {
        self.fingerprint
    }
    pub fn counter(&self) -> u64 {
        self.header.counter
    }
    pub fn generation(&self) -> u64 {
        self.header.generation
    }
    pub fn current_key_id(&self) -> Id {
        self.header.current_key_id
    }
    pub fn predecessor_commitment(&self) -> [u8; 48] {
        self.predecessor
    }
    pub fn inner_nonce(&self) -> [u8; 12] {
        self.inner_nonce
    }
    pub fn outer_nonce(&self) -> [u8; 12] {
        self.outer_nonce
    }
    pub fn inner_aad(&self) -> Vec<u8> {
        let mut aad = INNER_AAD_DOMAIN.to_vec();
        aad.extend_from_slice(&self.header_bytes);
        aad
    }
    pub fn outer_aad(&self) -> Vec<u8> {
        let mut aad = OUTER_AAD_DOMAIN.to_vec();
        aad.extend_from_slice(&self.header_bytes);
        aad
    }

    /// Hand the canonical inner payload to WebCrypto exactly once. The internal copy is erased.
    pub fn take_inner_payload(&mut self) -> Result<Vec<u8>, WitnessError> {
        if self.stage != Stage::PayloadUntaken {
            return Err(WitnessError::OutputBlocked);
        }
        self.stage = Stage::InnerUnsealed;
        Ok(std::mem::take(&mut self.inner_payload))
    }

    /// Bind the exact sealed inner bytes: compute the commitment, sign the fixed witness request,
    /// and return the outer metadata plaintext for WebCrypto to seal.
    pub fn finalize(&mut self, sealed_inner: &[u8]) -> Result<Vec<u8>, WitnessError> {
        if self.stage != Stage::InnerUnsealed {
            return Err(WitnessError::OutputBlocked);
        }
        if sealed_inner.len() != self.inner_payload_len + AEAD_TAG_BYTES {
            return Err(WitnessError::Malformed);
        }
        let commitment = state_commitment(&self.header, sealed_inner, self.predecessor)?;
        let provider = CoreProvider::new().map_err(|_| WitnessError::Crypto)?;
        let nonce = provider
            .rand()
            .random_array::<32>()
            .map_err(|_| WitnessError::Crypto)?;
        let counter = self.header.counter;
        let kind = if counter == 1 {
            WitnessRequestKind::Register
        } else {
            WitnessRequestKind::Advance
        };
        let request = WitnessRequest::new_signed(WitnessRequestSigning {
            kind,
            lineage: self.header.lineage.clone(),
            operation_id: self.operation_id,
            expected: (counter > 1).then_some((counter - 1, self.predecessor)),
            proposed: Some((counter, commitment)),
            previous_certificate_hash: self.previous_certificate_hash,
            credential: &self.credential,
            signer: &self.signer,
            nonce,
        })?;
        let request_bytes = request.encode()?;
        let request_hash = sha384(&request_bytes)?;
        let outer = encode_outer(&OuterMetadata {
            commitment,
            predecessor: self.predecessor,
            request: request_bytes.clone(),
            request_hash,
        })?;
        self.sealed_inner = sealed_inner.to_vec();
        self.commitment = commitment;
        self.request = Some(request);
        self.request_bytes = request_bytes;
        self.request_hash = request_hash;
        self.outer_len = outer.len();
        self.stage = Stage::OuterUnsealed;
        Ok(outer)
    }

    /// Receive the exact sealed outer bytes and produce the canonical committed record.
    pub fn complete(
        mut self,
        sealed_outer: &[u8],
    ) -> Result<BrowserCommittedTransition, WitnessError> {
        if self.stage != Stage::OuterUnsealed {
            return Err(WitnessError::OutputBlocked);
        }
        if sealed_outer.len() != self.outer_len + AEAD_TAG_BYTES {
            return Err(WitnessError::Malformed);
        }
        let sealed = SealedWitnessState {
            header: self.header.clone(),
            inner_nonce: self.inner_nonce,
            outer_nonce: self.outer_nonce,
            sealed_inner: std::mem::take(&mut self.sealed_inner),
            sealed_outer: sealed_outer.to_vec(),
        };
        let committed_record = encode_committed_record(self.operation_id, &sealed)?;
        Ok(BrowserCommittedTransition {
            operation_id: self.operation_id,
            fingerprint: self.fingerprint,
            counter: self.header.counter,
            generation: self.header.generation,
            current_key_id: self.header.current_key_id,
            predecessor_commitment: self.predecessor,
            commitment: self.commitment,
            committed_record,
            request_bytes: std::mem::take(&mut self.request_bytes),
            request_hash: self.request_hash,
            token: self.token,
        })
    }
}

impl std::fmt::Debug for BrowserTransition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrowserTransition")
            .field("operation_id", &self.operation_id)
            .field("counter", &self.header.counter)
            .field("stage", &self.stage)
            .finish_non_exhaustive()
    }
}

impl Drop for BrowserTransition {
    fn drop(&mut self) {
        self.inner_payload.fill(0);
    }
}

fn encode_committed_record(
    operation_id: Id,
    sealed: &SealedWitnessState,
) -> Result<Vec<u8>, WitnessError> {
    let encoded = sealed.encode()?;
    let mut out = Vec::with_capacity(2 + 16 + 4 + encoded.len());
    out.extend_from_slice(&COMMITTED_TRANSITION_VERSION.to_be_bytes());
    out.extend_from_slice(&operation_id);
    put_u32_bytes(&mut out, &encoded)?;
    if out.len() > MAX_COMMITTED_TRANSITION_BYTES {
        return Err(WitnessError::BoundExceeded);
    }
    Ok(out)
}

fn decode_committed_record(record: &[u8]) -> Result<(Id, SealedWitnessState), WitnessError> {
    if record.len() > MAX_COMMITTED_TRANSITION_BYTES {
        return Err(WitnessError::BoundExceeded);
    }
    let mut cursor = Cursor::new(record);
    if cursor.u16()? != COMMITTED_TRANSITION_VERSION {
        return Err(WitnessError::CorruptState);
    }
    let operation_id: Id = cursor.array()?;
    let sealed = SealedWitnessState::decode(cursor.u32_bytes(MAX_INNER_PAYLOAD_BYTES + 2 * 1024)?)?;
    cursor.finish()?;
    Ok((operation_id, sealed))
}

/// Non-secret parts of a committed record that WebCrypto needs to unseal it. No key is involved.
pub struct BrowserSealedEnvelopes {
    pub operation_id: Id,
    pub counter: u64,
    pub generation: u64,
    pub current_key_id: Id,
    pub inner_nonce: [u8; 12],
    pub inner_aad: Vec<u8>,
    pub sealed_inner: Vec<u8>,
    pub outer_nonce: [u8; 12],
    pub outer_aad: Vec<u8>,
    pub sealed_outer: Vec<u8>,
}

pub fn inspect_browser_committed(record: &[u8]) -> Result<BrowserSealedEnvelopes, WitnessError> {
    let (operation_id, sealed) = decode_committed_record(record)?;
    let header_bytes = encode_header(&sealed.header)?;
    let mut inner_aad = INNER_AAD_DOMAIN.to_vec();
    inner_aad.extend_from_slice(&header_bytes);
    let mut outer_aad = OUTER_AAD_DOMAIN.to_vec();
    outer_aad.extend_from_slice(&header_bytes);
    Ok(BrowserSealedEnvelopes {
        operation_id,
        counter: sealed.header.counter,
        generation: sealed.header.generation,
        current_key_id: sealed.header.current_key_id,
        inner_nonce: sealed.inner_nonce,
        inner_aad,
        sealed_inner: sealed.sealed_inner,
        outer_nonce: sealed.outer_nonce,
        outer_aad,
        sealed_outer: sealed.sealed_outer,
    })
}

/// A committed record opened with WebCrypto-decrypted payloads and authenticated by Rust.
pub struct BrowserOpenedTransition {
    pub inner_state: Vec<u8>,
    pub continuation: BrowserContinuation,
}

/// Open a committed record whose two envelopes WebCrypto already decrypted. Rust rechecks every
/// binding the native `open` checks except the AEAD tags themselves: lineage, canonical shapes,
/// the commitment over the exact sealed inner bytes, the request hash, the endpoint signature, and
/// the proposed and expected heads.
pub fn open_browser_committed(
    record: &[u8],
    inner_plaintext: &[u8],
    outer_plaintext: &[u8],
    lineage: &WitnessLineage,
    credential: &PairingCredential,
) -> Result<BrowserOpenedTransition, WitnessError> {
    let (operation_id, sealed) = decode_committed_record(record)?;
    if &sealed.header.lineage != lineage {
        return Err(WitnessError::LineageMismatch);
    }
    if inner_plaintext.len() + AEAD_TAG_BYTES != sealed.sealed_inner.len()
        || outer_plaintext.len() + AEAD_TAG_BYTES != sealed.sealed_outer.len()
    {
        return Err(WitnessError::CorruptState);
    }
    let (inner_state, exact_result) = decode_inner_payload(inner_plaintext)?;
    let metadata = decode_outer(outer_plaintext)?;
    let commitment = state_commitment(&sealed.header, &sealed.sealed_inner, metadata.predecessor)?;
    if commitment != metadata.commitment {
        return Err(WitnessError::CommitmentMismatch);
    }
    if sha384(&metadata.request)? != metadata.request_hash {
        return Err(WitnessError::RequestHashMismatch);
    }
    let request = WitnessRequest::decode(&metadata.request)?;
    request.verify(lineage, credential)?;
    if request.proposed_counter != Some(sealed.header.counter)
        || request.proposed_commitment != Some(commitment)
        || request.expected_commitment.unwrap_or(ZERO_HASH) != metadata.predecessor
    {
        return Err(WitnessError::CommitmentMismatch);
    }
    if request.operation_id != operation_id {
        return Err(WitnessError::OperationMismatch);
    }
    let info = CommittedTransitionInfo {
        operation_id,
        counter: sealed.header.counter,
        generation: sealed.header.generation,
        current_key_id: sealed.header.current_key_id,
    };
    Ok(BrowserOpenedTransition {
        inner_state,
        continuation: BrowserContinuation {
            pending: PendingWitnessOperation {
                request,
                request_bytes: metadata.request,
                request_hash: metadata.request_hash,
                exact_result,
                current_key_active: false,
                quorum_confirmed: false,
                obsolete_key_erased: sealed.header.counter == 1,
                revocation_generation: None,
                certificate_hash: None,
            },
            info,
            commitment,
            predecessor: metadata.predecessor,
            terminal: None,
        },
    })
}

/// The browser output gate for one opened committed record. The worker reports the durable key
/// facts it observed; Rust enforces the order: key active, unanimous certificate, obsolete key
/// erased, then the exact result.
pub struct BrowserContinuation {
    pending: PendingWitnessOperation,
    info: CommittedTransitionInfo,
    commitment: [u8; 48],
    predecessor: [u8; 48],
    terminal: Option<EndpointTerminalState>,
}

impl BrowserContinuation {
    pub fn operation_id(&self) -> Id {
        self.info.operation_id
    }
    pub fn counter(&self) -> u64 {
        self.info.counter
    }
    pub fn generation(&self) -> u64 {
        self.info.generation
    }
    pub fn current_key_id(&self) -> Id {
        self.info.current_key_id
    }
    pub fn commitment(&self) -> [u8; 48] {
        self.commitment
    }
    pub fn predecessor_commitment(&self) -> [u8; 48] {
        self.predecessor
    }
    pub fn has_obsolete_key(&self) -> bool {
        self.info.counter > 1
    }
    pub fn witness_request(&self) -> &[u8] {
        self.pending.witness_request()
    }
    pub fn request_hash(&self) -> [u8; 48] {
        self.pending.request_hash()
    }
    pub fn certificate_hash(&self) -> Option<[u8; 48]> {
        self.pending.certificate_hash
    }
    pub fn terminal(&self) -> Option<EndpointTerminalState> {
        self.terminal
    }

    /// The worker observed the successor key record `active` in committed storage.
    pub fn mark_current_key_active(&mut self) {
        self.pending.current_key_activated();
    }

    /// Verify a certificate against the exact stored request and the pinned trust set. A witness
    /// decision against this lineage or an invalid receipt records the terminal state exactly like
    /// the native continuation so the worker can persist it.
    pub fn confirm_quorum(
        &mut self,
        certificate: &[u8],
        trust: &ReplicaTrustSet,
    ) -> Result<(), WitnessError> {
        if let Some(terminal) = self.terminal {
            return Err(match terminal {
                EndpointTerminalState::Quarantined(_) => WitnessError::Quarantined,
                EndpointTerminalState::Revoked => WitnessError::Revoked,
            });
        }
        if !self.pending.current_key_active {
            return Err(WitnessError::OutputBlocked);
        }
        match self.pending.confirm_quorum(certificate, trust) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.terminal = match error {
                    WitnessError::Revoked => Some(EndpointTerminalState::Revoked),
                    WitnessError::OperationConflict
                    | WitnessError::RegistrationConflict
                    | WitnessError::Forked
                    | WitnessError::StaleExpected
                    | WitnessError::InvalidExpected => Some(EndpointTerminalState::Quarantined(
                        super::EndpointQuarantineReason::CommitmentConflict,
                    )),
                    WitnessError::UnexpectedResult => None,
                    _ => Some(EndpointTerminalState::Quarantined(
                        super::EndpointQuarantineReason::WitnessInconsistent,
                    )),
                };
                Err(error)
            }
        }
    }

    /// The worker deleted the obsolete key record and observed it absent in the same transaction.
    pub fn mark_obsolete_key_erased(&mut self) -> Result<(), WitnessError> {
        self.pending.obsolete_key_erased()
    }

    /// The exact result, released only after every barrier stage completed.
    pub fn exact_result(&self) -> Result<&[u8], WitnessError> {
        if self.terminal.is_some() {
            return Err(WitnessError::OutputBlocked);
        }
        self.pending.committed_result()
    }
}

#[cfg(test)]
mod tests {
    use openmls_traits::{OpenMlsProvider as _, crypto::OpenMlsCrypto as _, types::AeadType};

    use super::*;
    use crate::{
        browser_test_fixtures::{TestBrowserLineage, TestConfirmedHead},
        test_witness::TestWitness,
    };

    /// Stand-in for WebCrypto: AES-256-GCM with the caller-supplied nonce and AAD.
    fn seal(key: &[u8; 32], nonce: &[u8; 12], aad: &[u8], plaintext: &[u8]) -> Vec<u8> {
        CoreProvider::new()
            .unwrap()
            .crypto()
            .aead_encrypt(AeadType::Aes256Gcm, key, plaintext, nonce, aad)
            .unwrap()
    }

    fn unseal(key: &[u8; 32], nonce: &[u8; 12], aad: &[u8], ciphertext: &[u8]) -> Vec<u8> {
        CoreProvider::new()
            .unwrap()
            .crypto()
            .aead_decrypt(AeadType::Aes256Gcm, key, ciphertext, nonce, aad)
            .unwrap()
    }

    struct Committed {
        key: [u8; 32],
        commit: BrowserCommittedTransition,
    }

    fn run_transition(
        lineage: &TestBrowserLineage,
        confirmed: TestConfirmedHead,
        operation_id: Id,
        exact_result: &[u8],
    ) -> Committed {
        let mut transition = lineage
            .transition(
                confirmed,
                operation_id,
                [7; 48],
                b"inner state",
                exact_result,
            )
            .unwrap();
        let key = [0x42; 32];
        assert_eq!(
            transition.finalize(b"too early").unwrap_err(),
            WitnessError::OutputBlocked
        );
        let payload = transition.take_inner_payload().unwrap();
        assert_eq!(
            transition.take_inner_payload().unwrap_err(),
            WitnessError::OutputBlocked
        );
        let sealed_inner = seal(
            &key,
            &transition.inner_nonce(),
            &transition.inner_aad(),
            &payload,
        );
        assert_eq!(
            transition.finalize(&sealed_inner[1..]).unwrap_err(),
            WitnessError::Malformed
        );
        let outer = transition.finalize(&sealed_inner).unwrap();
        let sealed_outer = seal(
            &key,
            &transition.outer_nonce(),
            &transition.outer_aad(),
            &outer,
        );
        let commit = transition.complete(&sealed_outer).unwrap();
        Committed { key, commit }
    }

    fn open(lineage: &TestBrowserLineage, committed: &Committed) -> BrowserOpenedTransition {
        let envelopes = inspect_browser_committed(&committed.commit.committed_record).unwrap();
        let inner = unseal(
            &committed.key,
            &envelopes.inner_nonce,
            &envelopes.inner_aad,
            &envelopes.sealed_inner,
        );
        let outer = unseal(
            &committed.key,
            &envelopes.outer_nonce,
            &envelopes.outer_aad,
            &envelopes.sealed_outer,
        );
        open_browser_committed(
            &committed.commit.committed_record,
            &inner,
            &outer,
            lineage.lineage(),
            lineage.credential(),
        )
        .unwrap()
    }

    #[test]
    fn browser_finalization_binds_sealed_bytes_and_gates_the_exact_result() {
        let lineage = TestBrowserLineage::new(0x31, true).unwrap();
        let witness = TestWitness::new();
        let first = run_transition(
            &lineage,
            TestConfirmedHead {
                counter: 0,
                commitment: ZERO_HASH,
                previous_certificate_hash: ZERO_HASH,
            },
            [1; 16],
            b"first exact result",
        );
        assert_eq!(first.commit.counter, 1);
        let envelopes = inspect_browser_committed(&first.commit.committed_record).unwrap();
        assert_eq!(envelopes.operation_id, [1; 16]);
        assert_eq!(envelopes.current_key_id, first.commit.current_key_id);
        assert_ne!(envelopes.inner_nonce, envelopes.outer_nonce);

        let opened = open(&lineage, &first);
        assert_eq!(opened.inner_state, b"inner state");
        let mut opened = opened.continuation;
        assert_eq!(
            opened.witness_request(),
            first.commit.request_bytes.as_slice()
        );
        assert!(!opened.has_obsolete_key());
        let certificate = witness.respond(opened.witness_request()).unwrap();
        assert_eq!(
            opened
                .confirm_quorum(&certificate, &witness.trust())
                .unwrap_err(),
            WitnessError::OutputBlocked,
            "the successor key must be active before verification"
        );
        opened.mark_current_key_active();
        assert_eq!(
            opened.exact_result().unwrap_err(),
            WitnessError::OutputBlocked
        );
        opened
            .confirm_quorum(&certificate, &witness.trust())
            .unwrap();
        assert_eq!(opened.exact_result().unwrap(), b"first exact result");
        let first_hash = opened.certificate_hash().unwrap();

        let second = run_transition(
            &lineage,
            TestConfirmedHead {
                counter: 1,
                commitment: first.commit.commitment,
                previous_certificate_hash: first_hash,
            },
            [2; 16],
            b"second",
        );
        assert_eq!(
            second.commit.predecessor_commitment,
            first.commit.commitment
        );
        let mut opened = open(&lineage, &second).continuation;
        assert!(opened.has_obsolete_key());
        opened.mark_current_key_active();
        let certificate = witness.respond(opened.witness_request()).unwrap();
        opened
            .confirm_quorum(&certificate, &witness.trust())
            .unwrap();
        assert_eq!(
            opened.exact_result().unwrap_err(),
            WitnessError::OutputBlocked,
            "the obsolete key must be erased before release"
        );
        opened.mark_obsolete_key_erased().unwrap();
        assert_eq!(opened.exact_result().unwrap(), b"second");
    }

    #[test]
    fn browser_open_rejects_every_tampered_binding() {
        let lineage = TestBrowserLineage::new(0x32, false).unwrap();
        let other = TestBrowserLineage::new(0x33, false).unwrap();
        let confirmed = TestConfirmedHead {
            counter: 0,
            commitment: ZERO_HASH,
            previous_certificate_hash: ZERO_HASH,
        };
        let committed = run_transition(&lineage, confirmed, [3; 16], b"result");
        let record = &committed.commit.committed_record;
        let envelopes = inspect_browser_committed(record).unwrap();
        let inner = unseal(
            &committed.key,
            &envelopes.inner_nonce,
            &envelopes.inner_aad,
            &envelopes.sealed_inner,
        );
        let outer = unseal(
            &committed.key,
            &envelopes.outer_nonce,
            &envelopes.outer_aad,
            &envelopes.sealed_outer,
        );
        let open = |record: &[u8], inner: &[u8], outer: &[u8], who: &TestBrowserLineage| {
            open_browser_committed(record, inner, outer, who.lineage(), who.credential())
                .map(|_| ())
                .unwrap_err()
        };
        assert_eq!(
            open(record, &inner, &outer, &other),
            WitnessError::LineageMismatch
        );
        let mut flipped = record.clone();
        let inner_offset = record.len() - envelopes.sealed_outer.len() - 4 - 12;
        flipped[inner_offset] ^= 1;
        assert_eq!(
            open(&flipped, &inner, &outer, &lineage),
            WitnessError::CommitmentMismatch
        );
        let mut outer_tampered = outer.clone();
        let request_start = 2 + 48 + 48 + 2;
        outer_tampered[request_start + 8] ^= 1;
        assert_eq!(
            open(record, &inner, &outer_tampered, &lineage),
            WitnessError::RequestHashMismatch
        );
        assert_eq!(
            open(record, &inner[..inner.len() - 1], &outer, &lineage),
            WitnessError::CorruptState
        );
        let oversized = lineage
            .transition(
                confirmed,
                [4; 16],
                [7; 48],
                b"x",
                &vec![0; MAX_RESULT_BYTES + 1],
            )
            .map(|_| ())
            .unwrap_err();
        assert_eq!(oversized, WitnessError::BoundExceeded);
        let wrong_predecessor = lineage
            .transition(
                TestConfirmedHead {
                    counter: 0,
                    commitment: [9; 48],
                    previous_certificate_hash: ZERO_HASH,
                },
                [5; 16],
                [7; 48],
                b"x",
                b"y",
            )
            .map(|_| ())
            .unwrap_err();
        assert_eq!(wrong_predecessor, WitnessError::PredecessorMismatch);
    }

    #[test]
    fn browser_continuation_records_witness_decisions_as_terminal() {
        let lineage = TestBrowserLineage::new(0x34, true).unwrap();
        let witness = TestWitness::new();
        let committed = run_transition(
            &lineage,
            TestConfirmedHead {
                counter: 0,
                commitment: ZERO_HASH,
                previous_certificate_hash: ZERO_HASH,
            },
            [6; 16],
            b"r",
        );
        let mut opened = open(&lineage, &committed).continuation;
        opened.mark_current_key_active();
        let mut forged = witness.respond(opened.witness_request()).unwrap();
        let last = forged.len() - 1;
        forged[last] ^= 1;
        assert_eq!(
            opened
                .confirm_quorum(&forged, &witness.trust())
                .unwrap_err(),
            WitnessError::InvalidSignature
        );
        assert_eq!(
            opened.terminal(),
            Some(EndpointTerminalState::Quarantined(
                super::super::EndpointQuarantineReason::WitnessInconsistent
            ))
        );
        assert_eq!(
            opened.exact_result().unwrap_err(),
            WitnessError::OutputBlocked
        );
        let genuine = witness.respond(opened.witness_request()).unwrap();
        assert_eq!(
            opened
                .confirm_quorum(&genuine, &witness.trust())
                .unwrap_err(),
            WitnessError::Quarantined,
            "a quarantined continuation stays closed"
        );
    }
}
