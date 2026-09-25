// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

//! Browser device endpoint runner.
//!
//! One `BrowserEndpoint` lives inside the WASM instance of the dedicated worker. It owns the
//! witness state machine, the authenticated committed image, duplicate lookup, the exact-result
//! index, and the output gate for every mutation the browser device supports. Each mutation runs
//! zero or one OpenMLS transition on a transient `Phone` decoded from the committed image and hands
//! the worker one `BrowserTransition`; the worker seals and commits it with WebCrypto and IndexedDB
//! and reports the durable facts back. Nothing candidate-derived leaves this module before the
//! worker reports a durable commit, and no exact result leaves before the barrier completes.
//!
//! The mutations here are the `Endpoint` operations compiled for `wasm32`: KeyPackage creation,
//! Welcome join, activation send, application send and receive, self-Update proposal send, received
//! commit apply, epoch-ready send, epoch-ready confirmation receive, and received removal. The
//! native-only pairing lifecycle (claims, reservations, acknowledgements, outbox, reset) has no
//! browser implementation yet and is not represented here.

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::Arc,
};

use openmls::prelude::{GroupId, MlsGroup};
use openmls_basic_credential::SignatureKeyPair;
use openmls_traits::{OpenMlsProvider as _, crypto::OpenMlsCrypto as _, random::OpenMlsRand as _};

use super::{
    BrowserCommittedTransition, BrowserOpenedTransition, BrowserTransition,
    BrowserTransitionMaterial, open_browser_committed,
};
use crate::{
    Clock, CommitMetadata, CoreProvider, ENVELOPE_MAX_BYTES, Endpoint, Error, HANDSHAKE_MAX_BYTES,
    Id, Identity, MAX_PAST_EPOCHS, MessageClass, PairContext, PairWelcome, Phone, PreparedEnvelope,
    PreparedPlaintext, Role, SUITE,
    pairing::{
        PairingClaimV1, PairingCredential, PairingError, PairingInvitation, pair_activation_payload,
    },
    witness::{
        EndpointQuarantineReason, EndpointReconciliation, EndpointTerminalState,
        EndpointWitnessState, FreshQuorumState, MAX_INNER_STATE_BYTES, MAX_RESULT_BYTES,
        MutationAuthorization, PendingWitnessOperation, QuorumCertificate, ReplicaTrustSet,
        WITNESS_CERTIFICATE_MAX_BYTES, WitnessError, WitnessLineage, WitnessRequest,
        WitnessRequestKind, ZERO_HASH, decode_inner_payload, sha384,
    },
};

/// Version of the browser committed image inside the sealed inner payload.
const IMAGE_VERSION: u16 = 1;
/// Version prefix of every browser exact result.
const EXACT_RESULT_VERSION: u16 = 2;
const FINGERPRINT_DOMAIN: &[u8] = b"Axl endpoint operation fingerprint v2";
/// Completed operations whose exact results stay recoverable inside the image: the shared
/// idempotency horizon, so a browser retry window is exactly the native one.
const MAX_RETAINED_OPERATIONS: usize = crate::IDEMPOTENCY_RETENTION_GENERATIONS as usize;
const MAX_IMAGE_ENTRIES: usize = 8192;
const MAX_ACCEPTED_IDS: usize = 65_536;
const MAX_PENDING_READS: usize = 8;

/// Version-2 operation kinds the browser device runs. The numbers are the shared version-2
/// namespace defined by the atomic witness integration specification.
pub mod op_kind {
    pub const WELCOME_JOIN: u16 = 8;
    pub const ACTIVATION_SEND: u16 = 9;
    pub const APPLICATION_SEND: u16 = 12;
    pub const APPLICATION_RECEIVE: u16 = 13;
    pub const PROPOSAL_SEND: u16 = 14;
    pub const COMMIT_APPLY: u16 = 17;
    pub const EPOCH_READY_SEND: u16 = 18;
    pub const EPOCH_READY_CONFIRM_RECEIVE: u16 = 21;
    pub const REMOVAL_APPLY: u16 = 24;
    pub const LEGACY_CREATE: u16 = 32;
}

/// Failure from the browser endpoint runner.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BrowserEndpointError {
    /// Witness, image, or barrier failure.
    Witness(WitnessError),
    /// The one OpenMLS transition rejected its input; no state changed.
    Core(Error),
    /// A prepared candidate has not been committed or discarded yet.
    CandidateOutstanding,
    /// The endpoint has no committed image; create or open it first.
    NotOpened,
    /// A pairing invitation or claim was invalid for this endpoint.
    Pairing(PairingError),
}

impl From<PairingError> for BrowserEndpointError {
    fn from(value: PairingError) -> Self {
        Self::Pairing(value)
    }
}

impl From<WitnessError> for BrowserEndpointError {
    fn from(value: WitnessError) -> Self {
        Self::Witness(value)
    }
}

impl From<Error> for BrowserEndpointError {
    fn from(value: Error) -> Self {
        Self::Core(value)
    }
}

type Result<T> = std::result::Result<T, BrowserEndpointError>;

struct FixedClock(u64);

impl Clock for FixedClock {
    fn now_ms(&self) -> std::result::Result<u64, Error> {
        Ok(self.0)
    }
}

/// Exact typed result of one completed browser operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BrowserTypedResult {
    KeyPackage {
        bytes: Vec<u8>,
    },
    Joined {
        epoch: u64,
    },
    Envelope {
        logical_message_id: Id,
        class: MessageClass,
        epoch: u64,
        hosted_generation: u64,
        ciphertext: Vec<u8>,
    },
    Plaintext {
        logical_message_id: Id,
        class: MessageClass,
        epoch: u64,
        plaintext: Vec<u8>,
    },
    CommitApplied {
        commit_id: [u8; 48],
        target_epoch: u64,
        epoch_authenticator: [u8; 48],
        removal: bool,
    },
}

impl BrowserTypedResult {
    fn kind(&self) -> u8 {
        match self {
            Self::KeyPackage { .. } => 1,
            Self::Joined { .. } => 2,
            Self::Envelope { .. } => 3,
            Self::Plaintext { .. } => 4,
            Self::CommitApplied { .. } => 5,
        }
    }

    fn from_envelope(envelope: &PreparedEnvelope) -> Self {
        Self::Envelope {
            logical_message_id: envelope.logical_message_id(),
            class: envelope.class(),
            epoch: envelope.epoch(),
            hosted_generation: envelope.hosted_generation(),
            ciphertext: envelope.ciphertext().to_vec(),
        }
    }

    fn from_plaintext(plaintext: &PreparedPlaintext, class: MessageClass) -> Self {
        Self::Plaintext {
            logical_message_id: plaintext.logical_message_id,
            class,
            epoch: plaintext.epoch,
            plaintext: plaintext.plaintext().to_vec(),
        }
    }

    fn from_commit(metadata: &CommitMetadata, removal: bool) -> Self {
        Self::CommitApplied {
            commit_id: metadata.commit_id,
            target_epoch: metadata.target_epoch,
            epoch_authenticator: metadata.epoch_authenticator,
            removal,
        }
    }

    pub(crate) fn encode(&self) -> std::result::Result<Vec<u8>, WitnessError> {
        let mut out = EXACT_RESULT_VERSION.to_be_bytes().to_vec();
        out.push(self.kind());
        match self {
            Self::KeyPackage { bytes } => put_u32_bytes(&mut out, bytes)?,
            Self::Joined { epoch } => out.extend_from_slice(&epoch.to_be_bytes()),
            Self::Envelope {
                logical_message_id,
                class,
                epoch,
                hosted_generation,
                ciphertext,
            } => {
                out.extend_from_slice(logical_message_id);
                out.push(*class as u8);
                out.extend_from_slice(&epoch.to_be_bytes());
                out.extend_from_slice(&hosted_generation.to_be_bytes());
                put_u32_bytes(&mut out, ciphertext)?;
            }
            Self::Plaintext {
                logical_message_id,
                class,
                epoch,
                plaintext,
            } => {
                out.extend_from_slice(logical_message_id);
                out.push(*class as u8);
                out.extend_from_slice(&epoch.to_be_bytes());
                put_u32_bytes(&mut out, plaintext)?;
            }
            Self::CommitApplied {
                commit_id,
                target_epoch,
                epoch_authenticator,
                removal,
            } => {
                out.extend_from_slice(commit_id);
                out.extend_from_slice(&target_epoch.to_be_bytes());
                out.extend_from_slice(epoch_authenticator);
                out.push(u8::from(*removal));
            }
        }
        if out.len() > MAX_RESULT_BYTES {
            return Err(WitnessError::BoundExceeded);
        }
        Ok(out)
    }

    pub(crate) fn decode(bytes: &[u8]) -> std::result::Result<Self, WitnessError> {
        if bytes.len() > MAX_RESULT_BYTES {
            return Err(WitnessError::BoundExceeded);
        }
        let mut cursor = Cursor::new(bytes);
        if cursor.u16()? != EXACT_RESULT_VERSION {
            return Err(WitnessError::CorruptState);
        }
        let value = match cursor.u8()? {
            1 => Self::KeyPackage {
                bytes: cursor.u32_bytes(HANDSHAKE_MAX_BYTES)?.to_vec(),
            },
            2 => Self::Joined {
                epoch: cursor.u64()?,
            },
            3 => Self::Envelope {
                logical_message_id: cursor.array()?,
                class: MessageClass::try_from(cursor.u8()?)
                    .map_err(|_| WitnessError::CorruptState)?,
                epoch: cursor.u64()?,
                hosted_generation: cursor.u64()?,
                ciphertext: cursor.u32_bytes(ENVELOPE_MAX_BYTES)?.to_vec(),
            },
            4 => Self::Plaintext {
                logical_message_id: cursor.array()?,
                class: MessageClass::try_from(cursor.u8()?)
                    .map_err(|_| WitnessError::CorruptState)?,
                epoch: cursor.u64()?,
                plaintext: cursor.u32_bytes_allow_empty(ENVELOPE_MAX_BYTES)?.to_vec(),
            },
            5 => Self::CommitApplied {
                commit_id: cursor.array()?,
                target_epoch: cursor.u64()?,
                epoch_authenticator: cursor.array()?,
                removal: match cursor.u8()? {
                    0 => false,
                    1 => true,
                    _ => return Err(WitnessError::CorruptState),
                },
            },
            _ => return Err(WitnessError::CorruptState),
        };
        cursor.finish()?;
        Ok(value)
    }
}

/// Which typed result each operation kind must decode to.
fn expected_result_kind(operation_kind: u16) -> std::result::Result<u8, WitnessError> {
    Ok(match operation_kind {
        op_kind::LEGACY_CREATE => 1,
        op_kind::WELCOME_JOIN => 2,
        op_kind::ACTIVATION_SEND
        | op_kind::APPLICATION_SEND
        | op_kind::PROPOSAL_SEND
        | op_kind::EPOCH_READY_SEND => 3,
        op_kind::APPLICATION_RECEIVE | op_kind::EPOCH_READY_CONFIRM_RECEIVE => 4,
        op_kind::COMMIT_APPLY | op_kind::REMOVAL_APPLY => 5,
        _ => return Err(WitnessError::CorruptState),
    })
}

/// One completed or pending operation retained inside the committed image.
#[derive(Clone, Debug, Eq, PartialEq)]
struct RetainedOperation {
    operation_id: Id,
    operation_kind: u16,
    fingerprint: [u8; 48],
    exact_result: Vec<u8>,
}

#[derive(Clone, Debug)]
struct JoinedState {
    peer: Identity,
    context: PairContext,
    accepted: BTreeSet<Id>,
    previous_epoch_deadlines: BTreeMap<u64, u64>,
    last_wall_time_ms: u64,
}

/// The authenticated committed device image: identity, signer, optional joined group metadata, the
/// complete OpenMLS provider storage, and the retained operation index with exact results.
#[derive(Clone, Debug)]
pub(crate) struct BrowserImage {
    identity: Identity,
    signer_public: [u8; 32],
    joined: Option<JoinedState>,
    values: BTreeMap<Vec<u8>, Vec<u8>>,
    operations: VecDeque<RetainedOperation>,
    /// The applied daemon commit whose epoch-ready message has not been created yet. Kind 17 sets
    /// it, kind 18 consumes it, and a removal clears it, mirroring the native device record.
    pending_commit: Option<CommitMetadata>,
}

impl BrowserImage {
    fn from_phone(
        phone: &Phone,
        operations: VecDeque<RetainedOperation>,
        pending_commit: Option<CommitMetadata>,
    ) -> Result<Self> {
        let (values, signer_public, joined) = match &phone.endpoint {
            Some(endpoint) => (
                endpoint.provider.storage_values(),
                endpoint.signer.public(),
                Some(JoinedState {
                    peer: endpoint.peer.clone(),
                    context: endpoint.context.clone(),
                    accepted: endpoint.accepted.clone(),
                    previous_epoch_deadlines: endpoint.previous_epoch_deadlines.clone(),
                    last_wall_time_ms: endpoint.last_wall_time_ms,
                }),
            ),
            None => (phone.provider.storage_values(), phone.signer.public(), None),
        };
        let signer_public: [u8; 32] = signer_public
            .try_into()
            .map_err(|_| WitnessError::CorruptState)?;
        Ok(Self {
            identity: phone.identity.clone(),
            signer_public,
            joined,
            values,
            operations,
            pending_commit,
        })
    }

    /// Rebuild a transient phone for exactly one transition at the worker's wall clock.
    fn phone(&self, now_ms: u64) -> Result<Phone> {
        let provider = CoreProvider::from_storage_values(self.values.clone())
            .map_err(|_| WitnessError::Crypto)?;
        let signer = SignatureKeyPair::read(
            provider.storage(),
            &self.signer_public,
            SUITE.signature_algorithm(),
        )
        .ok_or(WitnessError::CorruptState)?;
        let Some(joined) = &self.joined else {
            return Ok(Phone {
                endpoint: None,
                provider,
                signer,
                identity: self.identity.clone(),
            });
        };
        let group = MlsGroup::load(
            provider.storage(),
            &GroupId::from_slice(&joined.context.group_id),
        )
        .map_err(|_| WitnessError::CorruptState)?
        .ok_or(WitnessError::CorruptState)?;
        // The joined phone's own provider and signer are placeholders; the endpoint owns both.
        let placeholder_provider = CoreProvider::new().map_err(|_| WitnessError::Crypto)?;
        Ok(Phone {
            endpoint: Some(Endpoint {
                provider,
                signer,
                group: Some(group),
                identity: self.identity.clone(),
                peer: joined.peer.clone(),
                context: joined.context.clone(),
                accepted: joined.accepted.clone(),
                previous_epoch_deadlines: joined.previous_epoch_deadlines.clone(),
                last_wall_time_ms: joined.last_wall_time_ms,
                clock: Arc::new(FixedClock(now_ms)),
                transaction_pending: false,
            }),
            signer: crate::generate_signer(&placeholder_provider)?,
            provider: placeholder_provider,
            identity: self.identity.clone(),
        })
    }

    fn signer(&self) -> Result<SignatureKeyPair> {
        let provider = CoreProvider::from_storage_values(self.values.clone())
            .map_err(|_| WitnessError::Crypto)?;
        Ok(SignatureKeyPair::read(
            provider.storage(),
            &self.signer_public,
            SUITE.signature_algorithm(),
        )
        .ok_or(WitnessError::CorruptState)?)
    }

    fn operation(&self, operation_id: Id) -> Option<&RetainedOperation> {
        self.operations
            .iter()
            .find(|entry| entry.operation_id == operation_id)
    }

    fn retain(&mut self, operation: RetainedOperation) -> Result<()> {
        if self.operation(operation.operation_id).is_some() {
            return Err(WitnessError::OperationConflict.into());
        }
        self.operations.push_back(operation);
        while self.operations.len() > MAX_RETAINED_OPERATIONS {
            self.operations.pop_front();
        }
        Ok(())
    }

    pub(crate) fn encode(&self) -> std::result::Result<Vec<u8>, WitnessError> {
        let mut out = IMAGE_VERSION.to_be_bytes().to_vec();
        encode_identity(&mut out, &self.identity);
        out.extend_from_slice(&self.signer_public);
        match &self.joined {
            None => out.push(0),
            Some(joined) => {
                out.push(1);
                encode_identity(&mut out, &joined.peer);
                out.extend_from_slice(&joined.context.crypto_session_id);
                out.extend_from_slice(&joined.context.group_id);
                out.extend_from_slice(&joined.context.account_id);
                out.extend_from_slice(&joined.context.installation_id);
                out.extend_from_slice(&joined.context.device_id);
                put_count(&mut out, joined.accepted.len(), MAX_ACCEPTED_IDS)?;
                for accepted in &joined.accepted {
                    out.extend_from_slice(accepted);
                }
                put_count(
                    &mut out,
                    joined.previous_epoch_deadlines.len(),
                    MAX_PAST_EPOCHS as usize + 1,
                )?;
                for (epoch, deadline) in &joined.previous_epoch_deadlines {
                    out.extend_from_slice(&epoch.to_be_bytes());
                    out.extend_from_slice(&deadline.to_be_bytes());
                }
                out.extend_from_slice(&joined.last_wall_time_ms.to_be_bytes());
            }
        }
        put_count(&mut out, self.values.len(), MAX_IMAGE_ENTRIES)?;
        for (key, value) in &self.values {
            put_u32_bytes(&mut out, key)?;
            put_u32_bytes(&mut out, value)?;
        }
        put_count(&mut out, self.operations.len(), MAX_RETAINED_OPERATIONS)?;
        for operation in &self.operations {
            out.extend_from_slice(&operation.operation_id);
            out.extend_from_slice(&operation.operation_kind.to_be_bytes());
            out.extend_from_slice(&operation.fingerprint);
            put_u32_bytes(&mut out, &operation.exact_result)?;
        }
        match &self.pending_commit {
            None => out.push(0),
            Some(commit) => {
                out.push(1);
                out.extend_from_slice(&commit.encode());
            }
        }
        if out.len() > MAX_INNER_STATE_BYTES {
            return Err(WitnessError::BoundExceeded);
        }
        Ok(out)
    }

    pub(crate) fn decode(bytes: &[u8]) -> std::result::Result<Self, WitnessError> {
        if bytes.len() > MAX_INNER_STATE_BYTES {
            return Err(WitnessError::BoundExceeded);
        }
        let mut cursor = Cursor::new(bytes);
        if cursor.u16()? != IMAGE_VERSION {
            return Err(WitnessError::CorruptState);
        }
        let identity = decode_identity(&mut cursor)?;
        if identity.role != Role::Device {
            return Err(WitnessError::RoleMismatch);
        }
        let signer_public = cursor.array()?;
        let joined = match cursor.u8()? {
            0 => None,
            1 => {
                let peer = decode_identity(&mut cursor)?;
                let context = PairContext {
                    crypto_session_id: cursor.array()?,
                    group_id: cursor.array()?,
                    account_id: cursor.array()?,
                    installation_id: cursor.array()?,
                    device_id: cursor.array()?,
                };
                if peer.role != Role::Daemon
                    || context.crypto_session_id == [0; 16]
                    || context.account_id != identity.account_id
                    || context.installation_id != identity.installation_id
                    || context.device_id != identity.device_id
                    || peer.account_id != identity.account_id
                    || peer.installation_id != identity.installation_id
                {
                    return Err(WitnessError::LineageMismatch);
                }
                let accepted_count = cursor.count(MAX_ACCEPTED_IDS)?;
                let mut accepted = BTreeSet::new();
                for _ in 0..accepted_count {
                    if !accepted.insert(cursor.array()?) {
                        return Err(WitnessError::CorruptState);
                    }
                }
                let deadline_count = cursor.count(MAX_PAST_EPOCHS as usize + 1)?;
                let mut previous_epoch_deadlines = BTreeMap::new();
                for _ in 0..deadline_count {
                    let epoch = cursor.u64()?;
                    let deadline = cursor.u64()?;
                    if previous_epoch_deadlines.insert(epoch, deadline).is_some() {
                        return Err(WitnessError::CorruptState);
                    }
                }
                Some(JoinedState {
                    peer,
                    context,
                    accepted,
                    previous_epoch_deadlines,
                    last_wall_time_ms: cursor.u64()?,
                })
            }
            _ => return Err(WitnessError::CorruptState),
        };
        let value_count = cursor.count(MAX_IMAGE_ENTRIES)?;
        let mut values = BTreeMap::new();
        for _ in 0..value_count {
            let key = cursor.u32_bytes(MAX_INNER_STATE_BYTES)?.to_vec();
            let value = cursor
                .u32_bytes_allow_empty(MAX_INNER_STATE_BYTES)?
                .to_vec();
            if values.insert(key, value).is_some() {
                return Err(WitnessError::CorruptState);
            }
        }
        let operation_count = cursor.count(MAX_RETAINED_OPERATIONS)?;
        let mut operations = VecDeque::with_capacity(operation_count);
        for _ in 0..operation_count {
            let operation = RetainedOperation {
                operation_id: cursor.array()?,
                operation_kind: cursor.u16()?,
                fingerprint: cursor.array()?,
                exact_result: cursor.u32_bytes(MAX_RESULT_BYTES)?.to_vec(),
            };
            if operation.operation_id == [0; 16]
                || operations
                    .iter()
                    .any(|entry: &RetainedOperation| entry.operation_id == operation.operation_id)
            {
                return Err(WitnessError::CorruptState);
            }
            operations.push_back(operation);
        }
        let pending_commit = match cursor.u8()? {
            0 => None,
            1 => Some(CommitMetadata {
                commit_id: cursor.array()?,
                target_epoch: cursor.u64()?,
                epoch_authenticator: cursor.array()?,
            }),
            _ => return Err(WitnessError::CorruptState),
        };
        if pending_commit.is_some() && joined.is_none() {
            return Err(WitnessError::CorruptState);
        }
        cursor.finish()?;
        Ok(Self {
            identity,
            signer_public,
            joined,
            values,
            operations,
            pending_commit,
        })
    }
}

/// Immutable view of the one pending operation the worker may transport.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserPendingView {
    pub operation_id: Id,
    pub request_bytes: Vec<u8>,
    pub request_hash: [u8; 48],
    pub kind: WitnessRequestKind,
}

/// Outcome of one mutation call.
#[derive(Debug)]
pub enum BrowserMutation {
    /// The same operation is locally committed and awaits the barrier.
    Pending(BrowserPendingView),
    /// The same operation already completed; this is its exact result.
    Released(BrowserTypedResult),
    /// A fresh transition for the worker to seal and commit.
    Fresh(Box<BrowserTransition>),
}

/// Durable row facts the worker reports when restoring an endpoint.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RestoredDisposition {
    Pending,
    Completed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RestoredRow {
    pub disposition: RestoredDisposition,
    pub generation: u64,
    pub confirmed_counter: u64,
    pub confirmed_commitment: [u8; 48],
    pub previous_certificate_hash: [u8; 48],
}

struct Candidate {
    token: u64,
    operation_id: Id,
    counter: u64,
    generation: u64,
    image: BrowserImage,
    exact_result: Vec<u8>,
    authorization: MutationAuthorization,
}

/// Facts the worker needs for the completion transaction after the certificate verified.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserCompletionHead {
    pub counter: u64,
    pub commitment: [u8; 48],
    pub certificate_hash: [u8; 48],
}

/// The browser device endpoint.
pub struct BrowserEndpoint {
    crypto_session_id: Id,
    trust: Arc<ReplicaTrustSet>,
    state: EndpointWitnessState,
    pending_reads: VecDeque<([u8; 48], WitnessRequest)>,
    image: Option<BrowserImage>,
    generation: u64,
    /// Whether the replicas confirmed the confirmed head in this lifetime. A restored image is a
    /// cache, not witness authority: no retained exact result leaves the endpoint until a fresh
    /// unanimous head equals the confirmed head or a verified certificate advances it.
    head_validated: bool,
    candidate: Option<Candidate>,
    unpersisted_terminal: Option<EndpointTerminalState>,
}

impl BrowserEndpoint {
    /// Create a brand-new device endpoint: one KeyPackage transition under the counter-1 register
    /// authorization. Returns the endpoint and the transition the worker must commit.
    pub fn create(
        identity: Identity,
        crypto_session_id: Id,
        trust: Arc<ReplicaTrustSet>,
        operation_id: Id,
        now_ms: u64,
    ) -> Result<(Self, BrowserTransition)> {
        if identity.role != Role::Device {
            return Err(WitnessError::RoleMismatch.into());
        }
        let lineage = WitnessLineage::from_identity(&identity, crypto_session_id)?;
        let mut endpoint = Self::empty(crypto_session_id, trust);
        endpoint.state.authorize_initial_registration()?;
        let mut identity_bytes = Vec::with_capacity(49);
        encode_identity(&mut identity_bytes, &identity);
        let fingerprint = operation_fingerprint(
            op_kind::LEGACY_CREATE,
            &[&[identity.role as u8], &identity_bytes, &crypto_session_id],
        )?;
        if operation_id == [0; 16] {
            return Err(WitnessError::Malformed.into());
        }
        let (phone, package) = Phone::create_at(identity, now_ms)?;
        let exact = BrowserTypedResult::KeyPackage {
            bytes: package.bytes().to_vec(),
        }
        .encode()?;
        let image = BrowserImage::from_phone(&phone, VecDeque::new(), None)?;
        let transition = endpoint.prepare_candidate(
            &lineage,
            image,
            operation_id,
            op_kind::LEGACY_CREATE,
            fingerprint,
            exact,
            0,
            ZERO_HASH,
        )?;
        Ok((endpoint, transition))
    }

    /// An endpoint that must be restored from a committed record before use.
    pub fn open(crypto_session_id: Id, trust: Arc<ReplicaTrustSet>) -> Self {
        Self::empty(crypto_session_id, trust)
    }

    fn empty(crypto_session_id: Id, trust: Arc<ReplicaTrustSet>) -> Self {
        Self {
            crypto_session_id,
            trust,
            state: EndpointWitnessState::new(),
            pending_reads: VecDeque::new(),
            image: None,
            generation: 0,
            head_validated: true,
            candidate: None,
            unpersisted_terminal: None,
        }
    }

    /// Restore from the one committed record whose envelopes WebCrypto decrypted. Rust rechecks
    /// every binding: lineage, canonical shapes, commitment over the exact sealed inner bytes,
    /// request hash, endpoint signature, heads, generation, and the retained operation index.
    pub fn restore(
        &mut self,
        record: &[u8],
        inner_plaintext: &[u8],
        outer_plaintext: &[u8],
        row: &RestoredRow,
    ) -> Result<Option<BrowserPendingView>> {
        if self.image.is_some() || self.candidate.is_some() {
            return Err(BrowserEndpointError::CandidateOutstanding);
        }
        // The image names the identity whose credential authenticates the record, so it is decoded
        // first; `open_browser_committed` then rechecks every binding the native `open` checks.
        let (inner_state, exact_result) = decode_inner_payload(inner_plaintext)?;
        let image = BrowserImage::decode(&inner_state)?;
        let lineage = WitnessLineage::from_identity(&image.identity, self.crypto_session_id)?;
        let signer = image.signer()?;
        let credential = PairingCredential::new(image.identity.clone(), &signer)
            .map_err(|_| WitnessError::CredentialMismatch)?;
        let opened = open_browser_committed(
            record,
            inner_plaintext,
            outer_plaintext,
            &lineage,
            &credential,
        )?;
        let BrowserOpenedTransition {
            inner_state: opened_state,
            continuation,
        } = opened;
        if opened_state != inner_state || continuation.generation() != row.generation {
            return Err(WitnessError::CorruptState.into());
        }
        let operation_id = continuation.operation_id();
        let counter = continuation.counter();
        let commitment = continuation.commitment();
        let predecessor = continuation.predecessor_commitment();
        let pending_operation = continuation.pending;
        if pending_operation.exact_result != exact_result {
            return Err(WitnessError::CorruptState.into());
        }
        let retained = image.operations.back().ok_or(WitnessError::CorruptState)?;
        if retained.operation_id != operation_id || retained.exact_result != exact_result {
            return Err(WitnessError::CorruptState.into());
        }
        let pending = match row.disposition {
            RestoredDisposition::Pending => {
                let expected_counter = pending_operation.request.expected_counter.unwrap_or(0);
                if expected_counter != row.confirmed_counter
                    || predecessor != row.confirmed_commitment
                {
                    return Err(WitnessError::PredecessorMismatch.into());
                }
                self.state = EndpointWitnessState::from_confirmed(
                    row.confirmed_counter,
                    row.confirmed_commitment,
                    row.previous_certificate_hash,
                );
                let view = pending_view(&pending_operation);
                self.state.recover_pending(pending_operation)?;
                Some(view)
            }
            RestoredDisposition::Completed => {
                if row.confirmed_counter != counter || row.confirmed_commitment != commitment {
                    return Err(WitnessError::PredecessorMismatch.into());
                }
                self.state = EndpointWitnessState::from_confirmed(
                    row.confirmed_counter,
                    row.confirmed_commitment,
                    row.previous_certificate_hash,
                );
                None
            }
        };
        self.image = Some(image);
        self.generation = row.generation;
        self.head_validated = false;
        Ok(pending)
    }

    pub fn is_restored(&self) -> bool {
        self.image.is_some()
    }

    /// Confirmed head: counter and commitment.
    pub fn head(&self) -> (u64, [u8; 48]) {
        let head = self.state.head();
        (head.counter, head.commitment)
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// `"quarantined"` or `"revoked"` when a terminal decision has not been persisted yet. The
    /// worker persists it; the endpoint itself already refuses every further mutation.
    pub fn take_unpersisted_terminal(&mut self) -> Option<EndpointTerminalState> {
        self.unpersisted_terminal.take()
    }

    pub fn terminal(&self) -> Option<EndpointTerminalState> {
        self.state.terminal()
    }

    fn set_terminal(&mut self, terminal: EndpointTerminalState) {
        self.state.set_terminal(terminal);
        self.unpersisted_terminal = Some(terminal);
        self.candidate = None;
    }

    fn terminal_error(&self) -> Option<WitnessError> {
        self.state.terminal().map(|terminal| match terminal {
            EndpointTerminalState::Quarantined(_) => WitnessError::Quarantined,
            EndpointTerminalState::Revoked => WitnessError::Revoked,
        })
    }

    fn lineage(&self) -> Result<(WitnessLineage, PairingCredential, SignatureKeyPair)> {
        let image = self.image.as_ref().ok_or(BrowserEndpointError::NotOpened)?;
        let lineage = WitnessLineage::from_identity(&image.identity, self.crypto_session_id)?;
        let signer = image.signer()?;
        let credential = PairingCredential::new(image.identity.clone(), &signer)
            .map_err(|_| WitnessError::CredentialMismatch)?;
        Ok((lineage, credential, signer))
    }

    /// Construct a fresh signed `read`. The next `reconcile_witness` must present a certificate
    /// for exactly these bytes.
    pub fn witness_read_request(&mut self) -> Result<Vec<u8>> {
        if let Some(error) = self.terminal_error() {
            return Err(error.into());
        }
        let (lineage, credential, signer) = self.lineage()?;
        let provider = CoreProvider::new().map_err(|_| WitnessError::Crypto)?;
        let operation_id = loop {
            let value: Id = provider
                .rand()
                .random_array()
                .map_err(|_| WitnessError::Crypto)?;
            if value != [0; 16] {
                break value;
            }
        };
        let nonce = loop {
            let value: [u8; 32] = provider
                .rand()
                .random_array()
                .map_err(|_| WitnessError::Crypto)?;
            if value != [0; 32] {
                break value;
            }
        };
        let request = WitnessRequest::new_read(
            lineage,
            operation_id,
            self.state.previous_certificate_hash(),
            &credential,
            &signer,
            nonce,
        )?;
        let bytes = request.encode()?;
        let hash = request.request_hash()?;
        if self.pending_reads.len() >= MAX_PENDING_READS {
            self.pending_reads.pop_front();
        }
        self.pending_reads.push_back((hash, request));
        Ok(bytes)
    }

    /// Verify a fresh unanimous `read` certificate and reconcile local state against it. A `Ready`
    /// outcome grants exactly one mutation authorization.
    pub fn reconcile_witness(&mut self, certificate: &[u8]) -> Result<EndpointReconciliation> {
        if certificate.is_empty() || certificate.len() > WITNESS_CERTIFICATE_MAX_BYTES {
            return Err(WitnessError::BoundExceeded.into());
        }
        if let Some(terminal) = self.state.terminal() {
            return Ok(terminal.into());
        }
        if self.pending_reads.is_empty() {
            return Err(WitnessError::FreshWitnessRequired.into());
        }
        let certificate = match QuorumCertificate::decode(certificate) {
            Ok(certificate) => certificate,
            Err(error) => {
                self.quarantine_after_receipt_failure();
                return Err(error.into());
            }
        };
        let request_hash = certificate.receipts()[0].request_hash();
        let Some(position) = self
            .pending_reads
            .iter()
            .position(|(hash, _)| *hash == request_hash)
        else {
            self.quarantine_after_receipt_failure();
            return Err(WitnessError::RequestHashMismatch.into());
        };
        let (_, request) = self
            .pending_reads
            .remove(position)
            .ok_or(WitnessError::Crypto)?;
        let result = match certificate.verify(&request, &self.trust) {
            Ok(result) => result,
            Err(error) => {
                self.quarantine_after_receipt_failure();
                return Err(error.into());
            }
        };
        let quorum = FreshQuorumState::from_verified_read(&certificate, result);
        let local_state_present = self.image.is_some() && self.generation > 0;
        let lineage_was_registered = self.state.head().counter > 0
            || self
                .state
                .pending()
                .is_ok_and(|pending| pending.request.kind == WitnessRequestKind::Register);
        let outcome = self
            .state
            .reconcile(local_state_present, lineage_was_registered, quorum);
        if let Some(terminal) = self.state.terminal() {
            self.unpersisted_terminal = Some(terminal);
            self.candidate = None;
        }
        if outcome == EndpointReconciliation::Ready {
            // The fresh head equals the confirmed head, so every retained exact result in the
            // restored image is confirmed by the replicas for this lifetime.
            self.head_validated = true;
        }
        Ok(outcome)
    }

    fn quarantine_after_receipt_failure(&mut self) {
        self.set_terminal(EndpointTerminalState::Quarantined(
            EndpointQuarantineReason::WitnessInconsistent,
        ));
    }

    /// The one pending request, exposed only after the worker reported the successor key active.
    pub fn pending_witness(&self) -> Result<Option<BrowserPendingView>> {
        if let Some(error) = self.terminal_error() {
            return Err(error.into());
        }
        match self.state.pending() {
            Ok(pending) if pending.current_key_active => Ok(Some(pending_view(pending))),
            Ok(_) => Err(WitnessError::OutputBlocked.into()),
            Err(WitnessError::NoPendingOperation) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// The pending request regardless of key activation, for the worker's own row comparison. It
    /// is never transported before `pending_witness` succeeds.
    pub fn pending_descriptor(&self) -> Option<BrowserPendingView> {
        self.state.pending().ok().map(pending_view)
    }

    /// The worker observed the successor key record `active` in committed storage.
    pub fn mark_current_key_active(&mut self) -> Result<()> {
        self.state.pending_mut()?.current_key_activated();
        Ok(())
    }

    pub fn has_obsolete_key(&self) -> Result<bool> {
        Ok(self.state.pending()?.request.proposed_counter.unwrap_or(0) > 1)
    }

    /// Verify a certificate against the exact pending request and the pinned trust set. A witness
    /// decision against this lineage or an invalid receipt records the terminal state.
    pub fn confirm_quorum(&mut self, certificate: &[u8]) -> Result<()> {
        if certificate.is_empty() || certificate.len() > WITNESS_CERTIFICATE_MAX_BYTES {
            return Err(WitnessError::BoundExceeded.into());
        }
        if let Some(error) = self.terminal_error() {
            return Err(error.into());
        }
        let trust = Arc::clone(&self.trust);
        let pending = self.state.pending_mut()?;
        if !pending.current_key_active {
            return Err(WitnessError::OutputBlocked.into());
        }
        match pending.confirm_quorum(certificate, &trust) {
            Ok(()) => Ok(()),
            Err(error) => {
                let terminal = match error {
                    WitnessError::Revoked => Some(EndpointTerminalState::Revoked),
                    WitnessError::OperationConflict
                    | WitnessError::RegistrationConflict
                    | WitnessError::Forked
                    | WitnessError::StaleExpected
                    | WitnessError::InvalidExpected => Some(EndpointTerminalState::Quarantined(
                        EndpointQuarantineReason::CommitmentConflict,
                    )),
                    WitnessError::UnexpectedResult => None,
                    _ => Some(EndpointTerminalState::Quarantined(
                        EndpointQuarantineReason::WitnessInconsistent,
                    )),
                };
                if let Some(terminal) = terminal {
                    self.set_terminal(terminal);
                }
                Err(error.into())
            }
        }
    }

    /// Head facts for the completion transaction, available after the certificate verified.
    pub fn completion_head(&self) -> Result<BrowserCompletionHead> {
        let pending = self.state.pending()?;
        if !pending.quorum_confirmed {
            return Err(WitnessError::OutputBlocked.into());
        }
        Ok(BrowserCompletionHead {
            counter: pending
                .request
                .proposed_counter
                .ok_or(WitnessError::CounterMismatch)?,
            commitment: pending
                .request
                .proposed_commitment
                .ok_or(WitnessError::CommitmentMismatch)?,
            certificate_hash: pending
                .certificate_hash
                .ok_or(WitnessError::InvalidQuorum)?,
        })
    }

    /// The worker deleted the obsolete key record and observed it absent in the completion
    /// transaction, or the operation is the counter-1 register with no obsolete key.
    pub fn mark_obsolete_key_erased(&mut self) -> Result<()> {
        Ok(self.state.pending_mut()?.obsolete_key_erased()?)
    }

    /// Release the exact result and advance the confirmed head. Only after every barrier stage.
    pub fn release(&mut self) -> Result<BrowserTypedResult> {
        let operation_id = self.state.pending()?.operation_id();
        let exact = self.state.release_and_advance()?;
        let retained = self
            .image
            .as_ref()
            .and_then(|image| image.operation(operation_id))
            .ok_or(WitnessError::CorruptState)?;
        if retained.exact_result != exact {
            return Err(WitnessError::CorruptState.into());
        }
        let typed = BrowserTypedResult::decode(&exact)?;
        if typed.kind() != expected_result_kind(retained.operation_kind)? {
            return Err(WitnessError::CorruptState.into());
        }
        // A verified certificate advanced the confirmed head; the image it covers is authority.
        self.head_validated = true;
        Ok(typed)
    }

    /// Lookup before any transition: exact duplicate pending, exact duplicate completed, conflicting
    /// duplicate, blocked by another pending operation, or fresh with authorization.
    fn lookup(
        &mut self,
        operation_id: Id,
        operation_kind: u16,
        fingerprint: [u8; 48],
    ) -> Result<Option<BrowserMutation>> {
        if operation_id == [0; 16] {
            return Err(WitnessError::Malformed.into());
        }
        if self.candidate.is_some() {
            return Err(BrowserEndpointError::CandidateOutstanding);
        }
        if let Some(error) = self.terminal_error() {
            return Err(error.into());
        }
        let image = self.image.as_ref().ok_or(BrowserEndpointError::NotOpened)?;
        if let Ok(pending) = self.state.pending() {
            if pending.operation_id() != operation_id {
                return Err(WitnessError::PendingOperation.into());
            }
            let retained = image
                .operation(operation_id)
                .ok_or(WitnessError::CorruptState)?;
            if retained.fingerprint != fingerprint || retained.operation_kind != operation_kind {
                self.set_terminal(EndpointTerminalState::Quarantined(
                    EndpointQuarantineReason::CommitmentConflict,
                ));
                return Err(WitnessError::OperationConflict.into());
            }
            return Ok(Some(BrowserMutation::Pending(pending_view(pending))));
        }
        if let Some(retained) = image.operation(operation_id) {
            if retained.fingerprint != fingerprint || retained.operation_kind != operation_kind {
                self.set_terminal(EndpointTerminalState::Quarantined(
                    EndpointQuarantineReason::CommitmentConflict,
                ));
                return Err(WitnessError::OperationConflict.into());
            }
            if !self.head_validated {
                // A restored image is not witness authority until a fresh head confirms it in this
                // lifetime; no retained exact result, however old, leaves before that.
                return Err(WitnessError::FreshWitnessRequired.into());
            }
            let typed = BrowserTypedResult::decode(&retained.exact_result)?;
            if typed.kind() != expected_result_kind(operation_kind)? {
                return Err(WitnessError::CorruptState.into());
            }
            return Ok(Some(BrowserMutation::Released(typed)));
        }
        if !self.state.has_mutation_authorization() {
            return Err(WitnessError::FreshWitnessRequired.into());
        }
        Ok(None)
    }

    /// Run exactly one transition on a transient phone decoded from the committed image and turn
    /// the successor image and exact result into one candidate transition.
    fn run<F>(
        &mut self,
        operation_id: Id,
        operation_kind: u16,
        fingerprint: [u8; 48],
        now_ms: u64,
        transition: F,
    ) -> Result<BrowserMutation>
    where
        F: FnOnce(&BrowserImage, &mut Phone) -> std::result::Result<BrowserTypedResult, Error>,
    {
        if let Some(resolved) = self.lookup(operation_id, operation_kind, fingerprint)? {
            return Ok(resolved);
        }
        let image = self.image.as_ref().ok_or(BrowserEndpointError::NotOpened)?;
        let lineage = WitnessLineage::from_identity(&image.identity, self.crypto_session_id)?;
        let mut phone = image.phone(now_ms)?;
        let typed = transition(image, &mut phone)?;
        if typed.kind() != expected_result_kind(operation_kind)? {
            return Err(WitnessError::CorruptState.into());
        }
        let pending_commit = match (operation_kind, &typed) {
            (
                op_kind::COMMIT_APPLY,
                BrowserTypedResult::CommitApplied {
                    commit_id,
                    target_epoch,
                    epoch_authenticator,
                    removal: false,
                },
            ) => Some(CommitMetadata {
                commit_id: *commit_id,
                target_epoch: *target_epoch,
                epoch_authenticator: *epoch_authenticator,
            }),
            (op_kind::EPOCH_READY_SEND | op_kind::REMOVAL_APPLY, _) => None,
            _ => image.pending_commit.clone(),
        };
        let exact = typed.encode()?;
        let (epoch, epoch_authenticator) = match &mut phone.endpoint {
            Some(endpoint) => {
                // The image commit is the platform transaction; the transient phone is discarded.
                endpoint.transaction_pending = false;
                let epoch = endpoint.epoch()?;
                let authenticator: [u8; 48] = endpoint
                    .epoch_authenticator()?
                    .as_slice()
                    .try_into()
                    .map_err(|_| WitnessError::Crypto)?;
                (epoch, authenticator)
            }
            None => (0, ZERO_HASH),
        };
        let successor = BrowserImage::from_phone(&phone, image.operations.clone(), pending_commit)?;
        self.prepare_candidate(
            &lineage,
            successor,
            operation_id,
            operation_kind,
            fingerprint,
            exact,
            epoch,
            epoch_authenticator,
        )
        .map(|transition| BrowserMutation::Fresh(Box::new(transition)))
    }

    #[allow(clippy::too_many_arguments)]
    fn prepare_candidate(
        &mut self,
        lineage: &WitnessLineage,
        mut image: BrowserImage,
        operation_id: Id,
        operation_kind: u16,
        fingerprint: [u8; 48],
        exact_result: Vec<u8>,
        epoch: u64,
        epoch_authenticator: [u8; 48],
    ) -> Result<BrowserTransition> {
        image.retain(RetainedOperation {
            operation_id,
            operation_kind,
            fingerprint,
            exact_result: exact_result.clone(),
        })?;
        let inner_state = image.encode()?;
        let signer = image.signer()?;
        let credential = PairingCredential::new(image.identity.clone(), &signer)
            .map_err(|_| WitnessError::CredentialMismatch)?;
        if self.state.pending.is_some() {
            return Err(WitnessError::PendingOperation.into());
        }
        let confirmed = self.state.head();
        let counter = confirmed
            .counter
            .checked_add(1)
            .ok_or(WitnessError::BoundExceeded)?;
        let generation = self
            .generation
            .checked_add(1)
            .ok_or(WitnessError::BoundExceeded)?;
        let authorization = self
            .state
            .mutation_authorization
            .take()
            .ok_or(WitnessError::FreshWitnessRequired)?;
        match &authorization {
            MutationAuthorization::Register
                if confirmed.counter == 0 && confirmed.commitment == ZERO_HASH => {}
            MutationAuthorization::Advance(expected) if expected == &confirmed => {}
            _ => return Err(WitnessError::GenerationMismatch.into()),
        }
        let token = loop {
            let value = u64::from_be_bytes(
                CoreProvider::new()
                    .map_err(|_| WitnessError::Crypto)?
                    .rand()
                    .random_array()
                    .map_err(|_| WitnessError::Crypto)?,
            );
            if value != 0 {
                break value;
            }
        };
        let transition = BrowserTransition::prepare(BrowserTransitionMaterial {
            lineage: lineage.clone(),
            counter,
            generation,
            epoch,
            epoch_authenticator,
            predecessor_commitment: confirmed.commitment,
            previous_certificate_hash: self.state.previous_certificate_hash(),
            operation_id,
            fingerprint,
            inner_state: &inner_state,
            exact_result: &exact_result,
            credential: &credential,
            signer,
            token,
        })?;
        self.candidate = Some(Candidate {
            token,
            operation_id,
            counter,
            generation,
            image,
            exact_result,
            authorization,
        });
        Ok(transition)
    }

    /// The worker committed the candidate durably and activated its key. Adopt the successor image
    /// and hold the exact result behind the barrier.
    pub fn local_commit_complete(&mut self, committed: &BrowserCommittedTransition) -> Result<()> {
        let candidate = self
            .candidate
            .take()
            .ok_or(WitnessError::NoPendingOperation)?;
        if committed.token != candidate.token
            || committed.operation_id != candidate.operation_id
            || committed.counter != candidate.counter
            || committed.generation != candidate.generation
        {
            return Err(WitnessError::OperationMismatch.into());
        }
        let lineage =
            WitnessLineage::from_identity(&candidate.image.identity, self.crypto_session_id)?;
        let signer = candidate.image.signer()?;
        let credential = PairingCredential::new(candidate.image.identity.clone(), &signer)
            .map_err(|_| WitnessError::CredentialMismatch)?;
        if sha384(&committed.request_bytes)? != committed.request_hash {
            return Err(WitnessError::RequestHashMismatch.into());
        }
        let request = WitnessRequest::decode(&committed.request_bytes)?;
        request.verify(&lineage, &credential)?;
        let confirmed = self.state.head();
        if request.operation_id != candidate.operation_id
            || request.proposed_counter != Some(candidate.counter)
            || request.proposed_commitment != Some(committed.commitment)
            || request.expected_commitment.unwrap_or(ZERO_HASH) != confirmed.commitment
            || request.expected_counter.unwrap_or(0) != confirmed.counter
        {
            return Err(WitnessError::CommitmentMismatch.into());
        }
        if self.state.pending.is_some() {
            return Err(WitnessError::PendingOperation.into());
        }
        match &candidate.authorization {
            MutationAuthorization::Register
                if confirmed.counter == 0 && confirmed.commitment == ZERO_HASH => {}
            MutationAuthorization::Advance(expected) if expected == &confirmed => {}
            _ => return Err(WitnessError::FreshWitnessRequired.into()),
        }
        self.state.pending = Some(PendingWitnessOperation {
            request,
            request_bytes: committed.request_bytes.clone(),
            request_hash: committed.request_hash,
            exact_result: candidate.exact_result,
            current_key_active: false,
            quorum_confirmed: false,
            obsolete_key_erased: candidate.counter == 1,
            revocation_generation: None,
            certificate_hash: None,
        });
        self.image = Some(candidate.image);
        self.generation = candidate.generation;
        Ok(())
    }

    /// The worker could not commit the candidate. Nothing in this endpoint changed; the consumed
    /// authorization is not restored, so the next mutation needs a fresh head.
    pub fn discard_candidate(&mut self) {
        self.candidate = None;
    }

    pub fn has_candidate(&self) -> bool {
        self.candidate.is_some()
    }

    // Mutations. Every one performs zero or one OpenMLS transition.

    /// Welcome join (kind 8). `daemon_identity` is the pairing daemon; the context binds this
    /// session, the group, and this device.
    pub fn join(
        &mut self,
        operation_id: Id,
        welcome: &[u8],
        group_id: [u8; 32],
        now_ms: u64,
    ) -> Result<BrowserMutation> {
        if welcome.is_empty() || welcome.len() > HANDSHAKE_MAX_BYTES {
            return Err(WitnessError::BoundExceeded.into());
        }
        let fingerprint = operation_fingerprint(
            op_kind::WELCOME_JOIN,
            &[
                welcome,
                &optional_field(Some(&group_id)),
                &optional_field(None),
                &optional_field(None),
            ],
        )?;
        let crypto_session_id = self.crypto_session_id;
        self.run(
            operation_id,
            op_kind::WELCOME_JOIN,
            fingerprint,
            now_ms,
            |_, phone| {
                let identity = phone.identity.clone();
                let context = PairContext {
                    crypto_session_id,
                    group_id,
                    account_id: identity.account_id,
                    installation_id: identity.installation_id,
                    device_id: identity.device_id,
                };
                let pair_welcome = PairWelcome {
                    bytes: welcome.to_vec().into_boxed_slice(),
                    context: context.clone(),
                    daemon_identity: Identity::daemon(
                        identity.account_id,
                        identity.installation_id,
                    ),
                    device_identity: identity,
                };
                phone.join_with_clock(pair_welcome, &context, Arc::new(FixedClock(now_ms)))?;
                let endpoint = phone.endpoint.as_ref().ok_or(Error::WrongGroup)?;
                Ok(BrowserTypedResult::Joined {
                    epoch: endpoint.epoch()?,
                })
            },
        )
    }

    /// The canonical device claim for a daemon's pairing invitation. Read-only: it signs, with this
    /// endpoint's own credential, over the KeyPackage the endpoint retained from its creation, so
    /// page code can neither substitute a KeyPackage nor claim for another identity. Only an
    /// unjoined endpoint whose confirmed head is witness authority in this lifetime can claim.
    pub fn pairing_claim(&self, invitation: &[u8], now_ms: u64) -> Result<Vec<u8>> {
        if self.candidate.is_some() {
            return Err(BrowserEndpointError::CandidateOutstanding);
        }
        if let Some(error) = self.terminal_error() {
            return Err(error.into());
        }
        let image = self.image.as_ref().ok_or(BrowserEndpointError::NotOpened)?;
        if !self.head_validated || self.state.pending().is_ok() {
            return Err(WitnessError::FreshWitnessRequired.into());
        }
        if image.joined.is_some() {
            return Err(Error::TransactionPending.into());
        }
        let invitation = PairingInvitation::decode(invitation)?;
        if invitation.account_id() != image.identity.account_id
            || invitation.installation_id() != image.identity.installation_id
            || invitation.crypto_session_id() != self.crypto_session_id
        {
            return Err(PairingError::IdentityMismatch.into());
        }
        let key_package = image
            .operations
            .iter()
            .find(|entry| entry.operation_kind == op_kind::LEGACY_CREATE)
            .map(|entry| BrowserTypedResult::decode(&entry.exact_result))
            .transpose()?
            .and_then(|typed| match typed {
                BrowserTypedResult::KeyPackage { bytes } => Some(bytes),
                _ => None,
            })
            .ok_or(WitnessError::CorruptState)?;
        let signer = image.signer()?;
        let credential = PairingCredential::new(image.identity.clone(), &signer)?;
        Ok(
            PairingClaimV1::create_at(&invitation, credential, &key_package, &signer, now_ms)?
                .encode()?,
        )
    }

    /// Published-Welcome join (kind 8). The group and its context come from the Welcome itself,
    /// which must name this installation's daemon and this device as its only members.
    pub fn join_published(
        &mut self,
        operation_id: Id,
        welcome: &[u8],
        now_ms: u64,
    ) -> Result<BrowserMutation> {
        if welcome.is_empty() || welcome.len() > HANDSHAKE_MAX_BYTES {
            return Err(WitnessError::BoundExceeded.into());
        }
        let fingerprint = operation_fingerprint(
            op_kind::WELCOME_JOIN,
            &[
                welcome,
                &optional_field(None),
                &optional_field(None),
                &optional_field(None),
            ],
        )?;
        let crypto_session_id = self.crypto_session_id;
        self.run(
            operation_id,
            op_kind::WELCOME_JOIN,
            fingerprint,
            now_ms,
            |_, phone| {
                let daemon =
                    Identity::daemon(phone.identity.account_id, phone.identity.installation_id);
                phone.join_published_welcome(
                    welcome,
                    crypto_session_id,
                    daemon,
                    Arc::new(FixedClock(now_ms)),
                )?;
                let endpoint = phone.endpoint.as_ref().ok_or(Error::WrongGroup)?;
                Ok(BrowserTypedResult::Joined {
                    epoch: endpoint.epoch()?,
                })
            },
        )
    }

    /// Pair activation send (kind 9) for this endpoint's own claim. The payload is derived here from
    /// the joined group and the claim hash, exactly as the native device derives it, so the daemon
    /// accepts it only for the claim it reserved and the group it created.
    pub fn prepare_pair_activation(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        claim: &[u8],
        now_ms: u64,
    ) -> Result<BrowserMutation> {
        let image = self.image.as_ref().ok_or(BrowserEndpointError::NotOpened)?;
        let joined = image.joined.as_ref().ok_or(Error::WrongGroup)?;
        let claim_value = PairingClaimV1::decode(claim)?;
        let credential = PairingCredential::new(image.identity.clone(), &image.signer()?)?;
        if claim_value.crypto_session_id() != self.crypto_session_id
            || claim_value.device_credential() != &credential
        {
            return Err(PairingError::IdentityMismatch.into());
        }
        let claim_hash = sha384(claim)?;
        let payload =
            pair_activation_payload(self.crypto_session_id, claim_hash, joined.context.group_id);
        self.prepare_activation(operation_id, logical_message_id, &payload, now_ms)
    }

    /// Activation send (kind 9). The native device derives this payload from its validated claim
    /// record; the browser has no claim lifecycle yet and takes the payload as input, so the exact
    /// plaintext is part of the browser fingerprint and a differing payload under the same
    /// operation ID is a conflict, never a replay of the earlier result.
    pub fn prepare_activation(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        plaintext: &[u8],
        now_ms: u64,
    ) -> Result<BrowserMutation> {
        if plaintext.is_empty() || plaintext.len() > HANDSHAKE_MAX_BYTES {
            return Err(WitnessError::BoundExceeded.into());
        }
        let fingerprint =
            operation_fingerprint(op_kind::ACTIVATION_SEND, &[&logical_message_id, plaintext])?;
        self.run(
            operation_id,
            op_kind::ACTIVATION_SEND,
            fingerprint,
            now_ms,
            |_, phone| {
                phone
                    .prepare_pair_activation(logical_message_id, plaintext)
                    .map(|envelope| BrowserTypedResult::from_envelope(&envelope))
            },
        )
    }

    /// Application send (kind 12).
    pub fn prepare_application(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        plaintext: &[u8],
        now_ms: u64,
    ) -> Result<BrowserMutation> {
        let fingerprint = operation_fingerprint(
            op_kind::APPLICATION_SEND,
            &[
                &logical_message_id,
                &hosted_generation.to_be_bytes(),
                plaintext,
            ],
        )?;
        self.run(
            operation_id,
            op_kind::APPLICATION_SEND,
            fingerprint,
            now_ms,
            |_, phone| {
                phone
                    .prepare_application(logical_message_id, hosted_generation, plaintext)
                    .map(|envelope| BrowserTypedResult::from_envelope(&envelope))
            },
        )
    }

    /// Application receive (kind 13).
    pub fn receive_application(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        ciphertext: &[u8],
        now_ms: u64,
    ) -> Result<BrowserMutation> {
        bounded_envelope(ciphertext)?;
        let fingerprint = operation_fingerprint(
            op_kind::APPLICATION_RECEIVE,
            &[
                &logical_message_id,
                &hosted_generation.to_be_bytes(),
                ciphertext,
            ],
        )?;
        self.run(
            operation_id,
            op_kind::APPLICATION_RECEIVE,
            fingerprint,
            now_ms,
            |_, phone| {
                phone
                    .receive_application(ciphertext, logical_message_id, hosted_generation)
                    .map(|plaintext| {
                        BrowserTypedResult::from_plaintext(
                            &plaintext,
                            MessageClass::ApplicationDelivery,
                        )
                    })
            },
        )
    }

    /// Self-Update proposal send (kind 14).
    pub fn prepare_replacement(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        now_ms: u64,
    ) -> Result<BrowserMutation> {
        let fingerprint = operation_fingerprint(
            op_kind::PROPOSAL_SEND,
            &[&logical_message_id, &hosted_generation.to_be_bytes()],
        )?;
        self.run(
            operation_id,
            op_kind::PROPOSAL_SEND,
            fingerprint,
            now_ms,
            |_, phone| {
                phone
                    .prepare_self_update(logical_message_id, hosted_generation)
                    .map(|envelope| BrowserTypedResult::from_envelope(&envelope))
            },
        )
    }

    /// Received commit apply (kind 17): exactly one commit transition and no epoch-ready send.
    pub fn apply_update_commit(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        ciphertext: &[u8],
        now_ms: u64,
    ) -> Result<BrowserMutation> {
        bounded_envelope(ciphertext)?;
        let fingerprint = operation_fingerprint(
            op_kind::COMMIT_APPLY,
            &[
                &logical_message_id,
                &hosted_generation.to_be_bytes(),
                ciphertext,
                &optional_field(None),
            ],
        )?;
        self.run(
            operation_id,
            op_kind::COMMIT_APPLY,
            fingerprint,
            now_ms,
            |_, phone| {
                phone
                    .apply_commit(ciphertext, logical_message_id, hosted_generation)
                    .map(|metadata| BrowserTypedResult::from_commit(&metadata, false))
            },
        )
    }

    /// Epoch-ready send (kind 18) as its own operation after the commit apply completed. The
    /// caller names the applied commit; the endpoint refuses any commit other than the one it
    /// applied and has not yet announced, and derives the canonical epoch-ready plaintext itself.
    pub fn prepare_epoch_ready(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        commit: &CommitMetadata,
        now_ms: u64,
    ) -> Result<BrowserMutation> {
        let fingerprint = operation_fingerprint(
            op_kind::EPOCH_READY_SEND,
            &[
                &logical_message_id,
                &hosted_generation.to_be_bytes(),
                &commit.encode(),
            ],
        )?;
        self.run(
            operation_id,
            op_kind::EPOCH_READY_SEND,
            fingerprint,
            now_ms,
            |image, phone| {
                if image.pending_commit.as_ref() != Some(commit) {
                    return Err(Error::UnexpectedMessage);
                }
                let context = &phone.endpoint.as_ref().ok_or(Error::WrongGroup)?.context;
                let payload =
                    crate::epoch_ready_payload(context.crypto_session_id, context.group_id, commit);
                phone
                    .prepare_epoch_ready(logical_message_id, hosted_generation, &payload)
                    .map(|envelope| BrowserTypedResult::from_envelope(&envelope))
            },
        )
    }

    /// Protected epoch-ready confirmation receive (kind 21).
    pub fn accept_epoch_ready_confirmation(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        ciphertext: &[u8],
        now_ms: u64,
    ) -> Result<BrowserMutation> {
        bounded_envelope(ciphertext)?;
        let fingerprint = operation_fingerprint(
            op_kind::EPOCH_READY_CONFIRM_RECEIVE,
            &[
                &logical_message_id,
                &hosted_generation.to_be_bytes(),
                ciphertext,
            ],
        )?;
        self.run(
            operation_id,
            op_kind::EPOCH_READY_CONFIRM_RECEIVE,
            fingerprint,
            now_ms,
            |_, phone| {
                phone
                    .receive_resync_control(ciphertext, logical_message_id, hosted_generation)
                    .map(|plaintext| {
                        BrowserTypedResult::from_plaintext(&plaintext, MessageClass::ResyncControl)
                    })
            },
        )
    }

    /// Received removal (kind 24): one commit transition that leaves this device alone in an
    /// inactive group.
    pub fn apply_removal(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        ciphertext: &[u8],
        now_ms: u64,
    ) -> Result<BrowserMutation> {
        bounded_envelope(ciphertext)?;
        let fingerprint = operation_fingerprint(
            op_kind::REMOVAL_APPLY,
            &[
                &logical_message_id,
                &hosted_generation.to_be_bytes(),
                ciphertext,
                &optional_field(None),
            ],
        )?;
        self.run(
            operation_id,
            op_kind::REMOVAL_APPLY,
            fingerprint,
            now_ms,
            |_, phone| {
                phone
                    .apply_removal(ciphertext, logical_message_id, hosted_generation)
                    .map(|metadata| BrowserTypedResult::from_commit(&metadata, true))
            },
        )
    }
}

fn pending_view(pending: &PendingWitnessOperation) -> BrowserPendingView {
    BrowserPendingView {
        operation_id: pending.operation_id(),
        request_bytes: pending.witness_request().to_vec(),
        request_hash: pending.request_hash(),
        kind: pending.request.kind,
    }
}

fn bounded_envelope(ciphertext: &[u8]) -> Result<()> {
    if ciphertext.is_empty() || ciphertext.len() > ENVELOPE_MAX_BYTES {
        return Err(WitnessError::BoundExceeded.into());
    }
    Ok(())
}

/// The version-2 operation fingerprint shared with the native schema.
pub(crate) fn operation_fingerprint(
    operation_kind: u16,
    fields: &[&[u8]],
) -> std::result::Result<[u8; 48], WitnessError> {
    if !(1..=32).contains(&operation_kind) {
        return Err(WitnessError::Malformed);
    }
    let mut input = FINGERPRINT_DOMAIN.to_vec();
    input.extend_from_slice(&operation_kind.to_be_bytes());
    for field in fields {
        let length = u32::try_from(field.len()).map_err(|_| WitnessError::BoundExceeded)?;
        input.extend_from_slice(&length.to_be_bytes());
        input.extend_from_slice(field);
    }
    CoreProvider::new()
        .map_err(|_| WitnessError::Crypto)?
        .crypto()
        .hash(SUITE.hash_algorithm(), &input)
        .map_err(|_| WitnessError::Crypto)?
        .try_into()
        .map_err(|_| WitnessError::Crypto)
}

fn optional_field(value: Option<&[u8]>) -> Vec<u8> {
    match value {
        Some(bytes) => {
            let mut out = vec![1];
            out.extend_from_slice(bytes);
            out
        }
        None => vec![0],
    }
}

fn encode_identity(out: &mut Vec<u8>, identity: &Identity) {
    out.push(identity.role as u8);
    out.extend_from_slice(&identity.account_id);
    out.extend_from_slice(&identity.installation_id);
    out.extend_from_slice(&identity.device_id);
}

fn decode_identity(cursor: &mut Cursor<'_>) -> std::result::Result<Identity, WitnessError> {
    let role = match cursor.u8()? {
        1 => Role::Daemon,
        2 => Role::Device,
        _ => return Err(WitnessError::CorruptState),
    };
    let identity = Identity {
        role,
        account_id: cursor.array()?,
        installation_id: cursor.array()?,
        device_id: cursor.array()?,
    };
    identity
        .validate()
        .map_err(|_| WitnessError::CorruptState)?;
    Ok(identity)
}

fn put_count(out: &mut Vec<u8>, count: usize, max: usize) -> std::result::Result<(), WitnessError> {
    if count > max {
        return Err(WitnessError::BoundExceeded);
    }
    out.extend_from_slice(&(count as u32).to_be_bytes());
    Ok(())
}

fn put_u32_bytes(out: &mut Vec<u8>, bytes: &[u8]) -> std::result::Result<(), WitnessError> {
    let length = u32::try_from(bytes.len()).map_err(|_| WitnessError::BoundExceeded)?;
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}

struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }
    fn take(&mut self, length: usize) -> std::result::Result<&'a [u8], WitnessError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(WitnessError::CorruptState)?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or(WitnessError::CorruptState)?;
        self.offset = end;
        Ok(value)
    }
    fn u8(&mut self) -> std::result::Result<u8, WitnessError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> std::result::Result<u16, WitnessError> {
        Ok(u16::from_be_bytes(self.array()?))
    }
    fn u64(&mut self) -> std::result::Result<u64, WitnessError> {
        Ok(u64::from_be_bytes(self.array()?))
    }
    fn count(&mut self, max: usize) -> std::result::Result<usize, WitnessError> {
        let value = u32::from_be_bytes(self.array()?) as usize;
        if value > max {
            return Err(WitnessError::BoundExceeded);
        }
        Ok(value)
    }
    fn array<const N: usize>(&mut self) -> std::result::Result<[u8; N], WitnessError> {
        self.take(N)?
            .try_into()
            .map_err(|_| WitnessError::CorruptState)
    }
    fn u32_bytes(&mut self, max: usize) -> std::result::Result<&'a [u8], WitnessError> {
        let value = self.u32_bytes_allow_empty(max)?;
        if value.is_empty() {
            return Err(WitnessError::CorruptState);
        }
        Ok(value)
    }
    fn u32_bytes_allow_empty(&mut self, max: usize) -> std::result::Result<&'a [u8], WitnessError> {
        let length = u32::from_be_bytes(self.array()?) as usize;
        if length > max {
            return Err(WitnessError::BoundExceeded);
        }
        self.take(length)
    }
    fn finish(self) -> std::result::Result<(), WitnessError> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err(WitnessError::CorruptState)
        }
    }
}

#[cfg(test)]
mod tests {
    use openmls_traits::types::AeadType;

    use super::*;
    use crate::{
        browser_test_fixtures::{TestPeerDaemon, test_uuid_v7_id},
        test_witness::TestWitness,
        witness::browser::inspect_browser_committed,
    };

    /// OpenMLS validates KeyPackage lifetimes against the real clock, so the harness uses it.
    fn now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    fn aead(key: &[u8; 32], nonce: &[u8; 12], aad: &[u8], data: &[u8], seal: bool) -> Vec<u8> {
        let crypto = CoreProvider::new().unwrap();
        if seal {
            crypto
                .crypto()
                .aead_encrypt(AeadType::Aes256Gcm, key, data, nonce, aad)
                .unwrap()
        } else {
            crypto
                .crypto()
                .aead_decrypt(AeadType::Aes256Gcm, key, data, nonce, aad)
                .unwrap()
        }
    }

    /// Stand-in for the worker store: WebCrypto sealing, the one committed record, and the
    /// metadata row the store would keep.
    struct Harness {
        witness: Arc<TestWitness>,
        endpoint: BrowserEndpoint,
        keys: BTreeMap<Id, [u8; 32]>,
        record: Option<Vec<u8>>,
        row: Option<RestoredRow>,
        current_key: Option<Id>,
        now: u64,
    }

    fn context(seed: u8) -> PairContext {
        PairContext {
            crypto_session_id: test_uuid_v7_id(seed),
            group_id: [seed.wrapping_add(1); 32],
            account_id: test_uuid_v7_id(seed.wrapping_add(2)),
            installation_id: test_uuid_v7_id(seed.wrapping_add(3)),
            device_id: test_uuid_v7_id(seed.wrapping_add(4)),
        }
    }

    fn id(value: u8) -> Id {
        [value; 16]
    }

    impl Harness {
        fn create(context: &PairContext) -> Self {
            let witness = TestWitness::new();
            let identity = Identity::device(
                context.account_id,
                context.installation_id,
                context.device_id,
            )
            .unwrap();
            let (endpoint, transition) = BrowserEndpoint::create(
                identity,
                context.crypto_session_id,
                witness.trust(),
                id(0x10),
                now(),
            )
            .unwrap();
            let mut harness = Self {
                witness,
                endpoint,
                keys: BTreeMap::new(),
                record: None,
                row: None,
                current_key: None,
                now: now(),
            };
            harness.commit(*Box::new(transition));
            harness
        }

        fn commit(&mut self, mut transition: BrowserTransition) -> BrowserPendingView {
            let key = CoreProvider::new()
                .unwrap()
                .rand()
                .random_array::<32>()
                .unwrap();
            let payload = transition.take_inner_payload().unwrap();
            let sealed_inner = aead(
                &key,
                &transition.inner_nonce(),
                &transition.inner_aad(),
                &payload,
                true,
            );
            let outer = transition.finalize(&sealed_inner).unwrap();
            let sealed_outer = aead(
                &key,
                &transition.outer_nonce(),
                &transition.outer_aad(),
                &outer,
                true,
            );
            let committed = transition.complete(&sealed_outer).unwrap();
            // Durable commit: record, key prepared, metadata pending.
            self.keys.insert(committed.current_key_id, key);
            self.record = Some(committed.committed_record.clone());
            let (confirmed_counter, confirmed_commitment) = self.endpoint.head();
            self.row = Some(RestoredRow {
                disposition: RestoredDisposition::Pending,
                generation: committed.generation,
                confirmed_counter,
                confirmed_commitment,
                previous_certificate_hash: self.endpoint.state.previous_certificate_hash(),
            });
            self.current_key = Some(committed.current_key_id);
            self.endpoint.local_commit_complete(&committed).unwrap();
            // Activation after durable commit.
            self.endpoint.mark_current_key_active().unwrap();
            self.endpoint.pending_witness().unwrap().unwrap()
        }

        fn finish(&mut self, view: &BrowserPendingView) -> BrowserTypedResult {
            let certificate = self.witness.respond(&view.request_bytes).unwrap();
            self.endpoint.confirm_quorum(&certificate).unwrap();
            let head = self.endpoint.completion_head().unwrap();
            // Completion transaction: obsolete key erased, row completed, head advanced.
            let obsolete: Vec<Id> = self
                .keys
                .keys()
                .copied()
                .filter(|key| Some(*key) != self.current_key)
                .collect();
            for key in obsolete {
                self.keys.remove(&key);
            }
            let row = self.row.as_mut().unwrap();
            row.disposition = RestoredDisposition::Completed;
            row.confirmed_counter = head.counter;
            row.confirmed_commitment = head.commitment;
            row.previous_certificate_hash = head.certificate_hash;
            self.endpoint.mark_obsolete_key_erased().unwrap();
            self.endpoint.release().unwrap()
        }

        fn fresh_head(&mut self) -> EndpointReconciliation {
            let read = self.endpoint.witness_read_request().unwrap();
            let certificate = self.witness.respond(&read).unwrap();
            self.endpoint.reconcile_witness(&certificate).unwrap()
        }

        fn mutate<F>(&mut self, f: F) -> BrowserTypedResult
        where
            F: FnOnce(&mut BrowserEndpoint, u64) -> Result<BrowserMutation>,
        {
            assert_eq!(self.fresh_head(), EndpointReconciliation::Ready);
            self.now += 1;
            match f(&mut self.endpoint, self.now).unwrap() {
                BrowserMutation::Fresh(transition) => {
                    let view = self.commit(*transition);
                    self.finish(&view)
                }
                BrowserMutation::Released(result) => result,
                BrowserMutation::Pending(_) => panic!("unexpected pending"),
            }
        }

        fn restart(&mut self) {
            let record = self.record.clone().unwrap();
            let envelopes = inspect_browser_committed(&record).unwrap();
            let key = self.keys[&envelopes.current_key_id];
            let inner = aead(
                &key,
                &envelopes.inner_nonce,
                &envelopes.inner_aad,
                &envelopes.sealed_inner,
                false,
            );
            let outer = aead(
                &key,
                &envelopes.outer_nonce,
                &envelopes.outer_aad,
                &envelopes.sealed_outer,
                false,
            );
            let trust = self.witness.trust();
            let mut endpoint = BrowserEndpoint::open(self.endpoint.crypto_session_id, trust);
            let pending = endpoint
                .restore(&record, &inner, &outer, self.row.as_ref().unwrap())
                .unwrap();
            if pending.is_some() {
                endpoint.mark_current_key_active().unwrap();
            }
            self.endpoint = endpoint;
        }
    }

    fn envelope(result: &BrowserTypedResult) -> Vec<u8> {
        match result {
            BrowserTypedResult::Envelope { ciphertext, .. } => ciphertext.clone(),
            other => panic!("expected envelope, got {other:?}"),
        }
    }

    /// The browser device pairs with the real durable daemon lifecycle: the daemon validates the
    /// browser's claim against its invitation, reserves it, creates the group, and accepts the
    /// activation only because the browser derived the exact payload for that claim and group.
    #[test]
    fn browser_device_pairs_with_the_native_daemon_lifecycle() {
        use crate::persistence::{
            ActivationOutcome, ClaimSubmission, ReservationOutcome, WelcomeOutcome,
        };
        use crate::persistence_tests::{pending_fixture, sequence_id};

        let mut daemon = pending_fixture(0x71);
        let context = PairContext {
            crypto_session_id: daemon.ids.session,
            group_id: [0; 32],
            account_id: daemon.ids.account,
            installation_id: daemon.ids.installation,
            device_id: daemon.ids.device,
        };
        let mut browser = Harness::create(&context);
        let invitation = daemon.publication.bytes().to_vec();

        // No claim before the KeyPackage registration completes.
        assert_eq!(
            browser
                .endpoint
                .pairing_claim(&invitation, now())
                .unwrap_err(),
            BrowserEndpointError::Witness(WitnessError::FreshWitnessRequired)
        );
        let pending = browser.endpoint.pending_witness().unwrap().unwrap();
        let BrowserTypedResult::KeyPackage { bytes: key_package } = browser.finish(&pending) else {
            panic!("expected key package");
        };
        let claim = browser.endpoint.pairing_claim(&invitation, now()).unwrap();
        // The daemon's manual clock was fixed before the browser's KeyPackage lifetime began; a
        // daemon behind the device's clock rejects the KeyPackage as not yet valid.
        daemon.clock.advance(2_000);
        // Deterministic signing over the retained KeyPackage: the same claim every time.
        assert_eq!(
            browser.endpoint.pairing_claim(&invitation, now()).unwrap(),
            claim
        );
        assert_eq!(
            PairingClaimV1::decode(&claim).unwrap().key_package(),
            key_package
        );

        // An invitation for another installation is refused before signing.
        let foreign = pending_fixture(0x72);
        assert_eq!(
            browser
                .endpoint
                .pairing_claim(foreign.publication.bytes(), now())
                .unwrap_err(),
            BrowserEndpointError::Pairing(PairingError::IdentityMismatch)
        );

        let claim_hash = match daemon
            .run(|endpoint| endpoint.submit_claim(sequence_id(130, 1), &claim))
            .unwrap()
        {
            ClaimSubmission::Pending { claim_hash, .. } => claim_hash,
            other => panic!("unexpected claim result: {other:?}"),
        };
        let reservation_id = sequence_id(131, 1);
        assert!(matches!(
            daemon
                .run(|endpoint| endpoint.confirm_claim(
                    sequence_id(132, 1),
                    claim_hash,
                    reservation_id
                ))
                .unwrap(),
            ReservationOutcome::Reserved(_)
        ));
        let welcome = match daemon
            .run(|endpoint| endpoint.create_welcome(sequence_id(133, 1), reservation_id))
            .unwrap()
        {
            WelcomeOutcome::Committed(welcome) => welcome,
            other => panic!("unexpected Welcome result: {other:?}"),
        };

        // Activation needs a joined group.
        assert_eq!(
            browser
                .endpoint
                .prepare_pair_activation(id(0x22), id(0x50), &claim, now())
                .unwrap_err(),
            BrowserEndpointError::Core(Error::WrongGroup)
        );
        let joined =
            browser.mutate(|endpoint, now| endpoint.join_published(id(0x21), welcome.bytes(), now));
        assert_eq!(joined, BrowserTypedResult::Joined { epoch: 1 });
        // A joined endpoint no longer claims.
        assert_eq!(
            browser
                .endpoint
                .pairing_claim(&invitation, now())
                .unwrap_err(),
            BrowserEndpointError::Core(Error::TransactionPending)
        );
        // Only this endpoint's own claim derives an activation.
        let other_claim = {
            let other = Harness::create(&PairContext {
                device_id: test_uuid_v7_id(0x7e),
                ..context.clone()
            });
            let mut other = other;
            let pending = other.endpoint.pending_witness().unwrap().unwrap();
            other.finish(&pending);
            other.endpoint.pairing_claim(&invitation, now()).unwrap()
        };
        assert_eq!(
            browser
                .endpoint
                .prepare_pair_activation(id(0x22), id(0x50), &other_claim, now())
                .unwrap_err(),
            BrowserEndpointError::Pairing(PairingError::IdentityMismatch)
        );

        let activation = browser.mutate(|endpoint, now| {
            endpoint.prepare_pair_activation(id(0x22), id(0x50), &claim, now)
        });
        let acceptance = match daemon
            .run(|endpoint| {
                endpoint.accept_activation(sequence_id(134, 1), id(0x50), &envelope(&activation))
            })
            .unwrap()
        {
            ActivationOutcome::Activated(acceptance) => acceptance,
            other => panic!("unexpected activation result: {other:?}"),
        };
        assert_eq!(acceptance.claim_hash(), claim_hash);
        assert_eq!(acceptance.group_id(), welcome.group_id());

        // Application traffic in both directions through the paired group.
        let sent = browser.mutate(|endpoint, now| {
            endpoint.prepare_application(id(0x23), id(0x51), 1, b"device request", now)
        });
        let received = daemon
            .run(|endpoint| {
                endpoint.receive_application(sequence_id(135, 1), &envelope(&sent), id(0x51), 1)
            })
            .unwrap();
        assert_eq!(received.plaintext(), b"device request");
        let reply = daemon
            .run(|endpoint| {
                endpoint.prepare_application(sequence_id(136, 1), id(0x52), 1, b"daemon reply")
            })
            .unwrap();
        let delivered = browser.mutate(|endpoint, now| {
            endpoint.receive_application(id(0x24), id(0x52), 1, &reply.ciphertext, now)
        });
        assert!(matches!(
            delivered,
            BrowserTypedResult::Plaintext { ref plaintext, .. } if plaintext == b"daemon reply"
        ));
    }

    #[test]
    fn browser_device_runs_every_supported_mutation_through_the_barrier() {
        let context = context(0x61);
        let mut harness = Harness::create(&context);
        let mut peer = TestPeerDaemon::new(context.clone(), now()).unwrap();

        // Register: the KeyPackage is withheld until the counter-1 certificate.
        assert_eq!(
            harness.endpoint.reconcile_witness(&[1]).unwrap_err(),
            BrowserEndpointError::Witness(WitnessError::FreshWitnessRequired)
        );
        let pending = harness.endpoint.pending_witness().unwrap().unwrap();
        assert_eq!(pending.kind, WitnessRequestKind::Register);
        let BrowserTypedResult::KeyPackage { bytes: key_package } = harness.finish(&pending) else {
            panic!("expected key package");
        };
        assert_eq!(harness.endpoint.head().0, 1);

        // Join.
        let welcome = peer.consume_key_package(&key_package).unwrap();
        let group_id = context.group_id;
        let joined =
            harness.mutate(|endpoint, now| endpoint.join(id(0x11), &welcome, group_id, now));
        assert_eq!(joined, BrowserTypedResult::Joined { epoch: 1 });

        // Activation send.
        let activation = harness.mutate(|endpoint, now| {
            endpoint.prepare_activation(id(0x12), id(0x40), b"activation payload", now)
        });
        assert_eq!(
            peer.receive_activation(&envelope(&activation), id(0x40))
                .unwrap(),
            b"activation payload"
        );

        // Application send and receive.
        let sent = harness.mutate(|endpoint, now| {
            endpoint.prepare_application(id(0x13), id(0x41), 7, b"device request", now)
        });
        assert_eq!(
            peer.receive_application(&envelope(&sent), id(0x41), 7)
                .unwrap(),
            b"device request"
        );
        let delivery = peer
            .prepare_delivery(id(0x45), 7, b"daemon delivery")
            .unwrap();
        let received = harness.mutate(|endpoint, now| {
            endpoint.receive_application(id(0x14), id(0x45), 7, &delivery, now)
        });
        assert!(matches!(
            received,
            BrowserTypedResult::Plaintext { ref plaintext, .. } if plaintext == b"daemon delivery"
        ));

        // Self-Update proposal, daemon commit, device apply (one transition), epoch-ready send
        // (a separate operation), confirmation receive.
        let proposal = harness
            .mutate(|endpoint, now| endpoint.prepare_replacement(id(0x15), id(0x42), 7, now));
        peer.receive_update_proposal(&envelope(&proposal), id(0x42), 7)
            .unwrap();
        let (commit, metadata) = peer.prepare_commit(id(0x43), 7).unwrap();
        let applied = harness.mutate(|endpoint, now| {
            endpoint.apply_update_commit(id(0x16), id(0x43), 7, &commit, now)
        });
        assert_eq!(
            applied,
            BrowserTypedResult::CommitApplied {
                commit_id: metadata.commit_id,
                target_epoch: metadata.target_epoch,
                epoch_authenticator: metadata.epoch_authenticator,
                removal: false,
            }
        );
        assert_eq!(metadata.target_epoch, 2);
        // Epoch-ready names the applied commit; any other commit is refused without a transition
        // and the endpoint derives the canonical plaintext the daemon validates.
        let mut other = metadata.clone();
        other.commit_id[0] ^= 1;
        assert_eq!(harness.fresh_head(), EndpointReconciliation::Ready);
        assert_eq!(
            harness
                .endpoint
                .prepare_epoch_ready(id(0x17), id(0x44), 0, &other, now())
                .unwrap_err(),
            BrowserEndpointError::Core(Error::UnexpectedMessage)
        );
        let ready = harness.mutate(|endpoint, now| {
            endpoint.prepare_epoch_ready(id(0x17), id(0x44), 0, &metadata, now)
        });
        assert_eq!(
            peer.receive_epoch_ready(&envelope(&ready), id(0x44), 0)
                .unwrap(),
            crate::epoch_ready_payload(context.crypto_session_id, context.group_id, &metadata)
        );
        // The applied commit is announced once; a second epoch-ready under another operation ID
        // has no pending commit to name.
        assert_eq!(harness.fresh_head(), EndpointReconciliation::Ready);
        assert_eq!(
            harness
                .endpoint
                .prepare_epoch_ready(id(0x27), id(0x48), 0, &metadata, now())
                .unwrap_err(),
            BrowserEndpointError::Core(Error::UnexpectedMessage)
        );
        let confirmation = peer
            .prepare_resync_control(id(0x46), 0, b"epoch ready confirmation")
            .unwrap();
        let confirmed = harness.mutate(|endpoint, now| {
            endpoint.accept_epoch_ready_confirmation(id(0x18), id(0x46), 0, &confirmation, now)
        });
        assert!(matches!(
            confirmed,
            BrowserTypedResult::Plaintext { ref plaintext, class: MessageClass::ResyncControl, .. }
                if plaintext == b"epoch ready confirmation"
        ));

        // Exact duplicates after completion return byte-identical results without a transition.
        let again = harness.mutate(|endpoint, now| {
            endpoint.prepare_application(id(0x13), id(0x41), 7, b"device request", now)
        });
        assert_eq!(again, sent);
        let again = harness.mutate(|endpoint, now| {
            endpoint.prepare_epoch_ready(id(0x17), id(0x44), 0, &metadata, now)
        });
        assert_eq!(again, ready);
        let again = harness.mutate(|endpoint, now| {
            endpoint.accept_epoch_ready_confirmation(id(0x18), id(0x46), 0, &confirmation, now)
        });
        assert_eq!(again, confirmed);

        // Removal.
        let removal = peer.prepare_removal(id(0x47), 0).unwrap();
        let removed = harness
            .mutate(|endpoint, now| endpoint.apply_removal(id(0x19), id(0x47), 0, &removal, now));
        assert!(matches!(
            removed,
            BrowserTypedResult::CommitApplied {
                removal: true,
                target_epoch: 3,
                ..
            }
        ));
        assert_eq!(
            harness.endpoint.head().0,
            10,
            "ten witnessed operations; duplicates advance nothing"
        );
    }

    #[test]
    fn browser_device_restores_pending_and_completed_operations_after_restart() {
        let context = context(0x71);
        let mut harness = Harness::create(&context);
        let mut peer = TestPeerDaemon::new(context.clone(), now()).unwrap();

        // Restart while the register is pending: the exact request is exposed only after the
        // worker reports the key active, and a duplicate create is the same pending request.
        let before = harness.endpoint.pending_witness().unwrap().unwrap();
        harness.restart();
        let after = harness.endpoint.pending_witness().unwrap().unwrap();
        assert_eq!(before, after);
        let read = harness.endpoint.witness_read_request().unwrap();
        let certificate = harness.witness.respond(&read).unwrap();
        assert_eq!(
            harness.endpoint.reconcile_witness(&certificate).unwrap(),
            EndpointReconciliation::ResendPending
        );
        let BrowserTypedResult::KeyPackage { bytes: key_package } = harness.finish(&after) else {
            panic!("expected key package");
        };

        // Restart with the latest operation completed: its cached result needs a fresh head.
        harness.restart();
        assert!(harness.endpoint.pending_witness().unwrap().is_none());
        let identity = Identity::device(
            context.account_id,
            context.installation_id,
            context.device_id,
        )
        .unwrap();
        // The create fingerprint is deterministic; a duplicate through a later lookup is exercised
        // through join below because create is a constructor.
        let _ = identity;
        let welcome = peer.consume_key_package(&key_package).unwrap();
        let group_id = context.group_id;
        assert_eq!(
            harness
                .endpoint
                .join(id(0x11), &welcome, group_id, now() + 1)
                .err(),
            Some(BrowserEndpointError::Witness(
                WitnessError::FreshWitnessRequired
            ))
        );
        assert_eq!(harness.fresh_head(), EndpointReconciliation::Ready);
        let BrowserMutation::Fresh(transition) = harness
            .endpoint
            .join(id(0x11), &welcome, group_id, now() + 1)
            .unwrap()
        else {
            panic!("expected fresh join");
        };
        let pending = harness.commit(*transition);

        // Restart mid-pending: a fresh head equal to the proposed head means recover accepted.
        let certificate = harness.witness.respond(&pending.request_bytes).unwrap();
        harness.restart();
        assert_eq!(
            harness.endpoint.pending_witness().unwrap().unwrap(),
            pending
        );
        assert_eq!(
            harness.fresh_head(),
            EndpointReconciliation::RecoverAccepted
        );
        // The exact stored request is resent; the replicas answer with the recovered receipts.
        let recovered = harness.witness.respond(&pending.request_bytes).unwrap();
        assert_eq!(recovered, certificate);
        harness.endpoint.confirm_quorum(&recovered).unwrap();
        let head = harness.endpoint.completion_head().unwrap();
        assert_eq!(head.counter, 2);
        assert_eq!(
            harness.endpoint.release().unwrap_err(),
            BrowserEndpointError::Witness(WitnessError::OutputBlocked),
            "the obsolete key must be erased before release"
        );
        harness.endpoint.mark_obsolete_key_erased().unwrap();
        assert_eq!(
            harness.endpoint.release().unwrap(),
            BrowserTypedResult::Joined { epoch: 1 }
        );

        // Duplicate of the completed join after restart: fresh head first, then the exact result.
        let row = harness.row.as_mut().unwrap();
        row.disposition = RestoredDisposition::Completed;
        row.confirmed_counter = head.counter;
        row.confirmed_commitment = head.commitment;
        row.previous_certificate_hash = head.certificate_hash;
        harness.restart();
        assert_eq!(
            harness
                .endpoint
                .join(id(0x11), &welcome, group_id, now() + 2)
                .err(),
            Some(BrowserEndpointError::Witness(
                WitnessError::FreshWitnessRequired
            ))
        );
        assert_eq!(harness.fresh_head(), EndpointReconciliation::Ready);
        assert!(matches!(
            harness
                .endpoint
                .join(id(0x11), &welcome, group_id, now() + 2)
                .unwrap(),
            BrowserMutation::Released(BrowserTypedResult::Joined { epoch: 1 })
        ));

        // An older retained result is gated the same way: after a restart the whole restored
        // image is a cache until a fresh head confirms it, not only its latest operation.
        let sent = harness.mutate(|endpoint, now| {
            endpoint.prepare_application(id(0x12), id(0x41), 7, b"first", now)
        });
        let _ = harness.mutate(|endpoint, now| {
            endpoint.prepare_application(id(0x13), id(0x42), 7, b"second", now)
        });
        harness.restart();
        assert_eq!(
            harness
                .endpoint
                .prepare_application(id(0x12), id(0x41), 7, b"first", now() + 3)
                .err(),
            Some(BrowserEndpointError::Witness(
                WitnessError::FreshWitnessRequired
            )),
            "an older cached result must not escape before reconciliation"
        );
        assert_eq!(harness.fresh_head(), EndpointReconciliation::Ready);
        assert!(matches!(
            harness
                .endpoint
                .prepare_application(id(0x12), id(0x41), 7, b"first", now() + 3)
                .unwrap(),
            BrowserMutation::Released(ref result) if *result == sent
        ));
    }

    #[test]
    fn browser_device_retains_exact_results_for_the_shared_idempotency_horizon() {
        let context = context(0x91);
        let mut harness = Harness::create(&context);
        let mut peer = TestPeerDaemon::new(context.clone(), now()).unwrap();
        let pending = harness.endpoint.pending_witness().unwrap().unwrap();
        let BrowserTypedResult::KeyPackage { bytes } = harness.finish(&pending) else {
            panic!("expected key package");
        };
        let welcome = peer.consume_key_package(&bytes).unwrap();
        harness.mutate(|endpoint, now| endpoint.join(id(0x11), &welcome, context.group_id, now));

        let op = |index: u64| -> Id {
            let mut id = [0xA0; 16];
            id[..8].copy_from_slice(&index.to_be_bytes());
            id
        };
        let horizon = crate::IDEMPOTENCY_RETENTION_GENERATIONS;
        let first = harness
            .mutate(|endpoint, now| endpoint.prepare_application(op(0), op(0), 1, b"first", now));
        for index in 1..horizon {
            harness.mutate(|endpoint, now| {
                endpoint.prepare_application(op(index), op(index), 1, b"later", now)
            });
        }
        // Exactly `horizon - 1` successors: the first result is still exact and byte identical.
        let again = harness
            .mutate(|endpoint, now| endpoint.prepare_application(op(0), op(0), 1, b"first", now));
        assert_eq!(again, first);
        harness.mutate(|endpoint, now| {
            endpoint.prepare_application(op(horizon), op(horizon), 1, b"later", now)
        });
        assert_eq!(
            harness.endpoint.image.as_ref().unwrap().operations.len(),
            horizon as usize
        );
        // The first operation is now outside the local horizon: the endpoint no longer recognizes
        // its ID and prepares a fresh transition. The witness lineage index never forgets an
        // operation ID, so the reused ID is refused there and the endpoint is quarantined rather
        // than releasing a second result under the old ID.
        assert_eq!(harness.fresh_head(), EndpointReconciliation::Ready);
        let BrowserMutation::Fresh(transition) = harness
            .endpoint
            .prepare_application(op(0), op(0), 1, b"first", now())
            .unwrap()
        else {
            panic!("expected a fresh transition outside the horizon");
        };
        let view = harness.commit(*transition);
        let certificate = harness.witness.respond(&view.request_bytes).unwrap();
        assert_eq!(
            harness.endpoint.confirm_quorum(&certificate).unwrap_err(),
            BrowserEndpointError::Witness(WitnessError::OperationConflict)
        );
        assert_eq!(
            harness.endpoint.take_unpersisted_terminal(),
            Some(EndpointTerminalState::Quarantined(
                EndpointQuarantineReason::CommitmentConflict
            ))
        );
        assert_eq!(
            harness.endpoint.release().unwrap_err(),
            BrowserEndpointError::Witness(WitnessError::Quarantined)
        );
    }

    #[test]
    fn browser_device_quarantines_conflicting_duplicates_and_blocks_later_operations() {
        let context = context(0x81);
        let mut harness = Harness::create(&context);
        let pending = harness.endpoint.pending_witness().unwrap().unwrap();
        // Another operation while one is pending.
        assert_eq!(
            harness
                .endpoint
                .prepare_activation(id(0x12), id(0x40), b"x", now())
                .err(),
            Some(BrowserEndpointError::Witness(
                WitnessError::PendingOperation
            ))
        );
        let BrowserTypedResult::KeyPackage { .. } = harness.finish(&pending) else {
            panic!("expected key package");
        };
        assert_eq!(harness.fresh_head(), EndpointReconciliation::Ready);
        // A rejected OpenMLS input does not consume the authorization or change state.
        assert!(matches!(
            harness
                .endpoint
                .join(id(0x11), b"not a welcome", context.group_id, now())
                .unwrap_err(),
            BrowserEndpointError::Core(_)
        ));
        assert!(harness.endpoint.state.has_mutation_authorization());
        // A candidate must be resolved before the next mutation.
        let mut peer = TestPeerDaemon::new(context.clone(), now()).unwrap();
        let BrowserTypedResult::KeyPackage { bytes } = harness
            .endpoint
            .image
            .as_ref()
            .and_then(|image| image.operation(id(0x10)))
            .map(|entry| BrowserTypedResult::decode(&entry.exact_result).unwrap())
            .unwrap()
        else {
            panic!("expected key package");
        };
        let welcome = peer.consume_key_package(&bytes).unwrap();
        let BrowserMutation::Fresh(_transition) = harness
            .endpoint
            .join(id(0x11), &welcome, context.group_id, now())
            .unwrap()
        else {
            panic!("expected fresh join");
        };
        assert_eq!(
            harness
                .endpoint
                .join(id(0x11), &welcome, context.group_id, now())
                .err(),
            Some(BrowserEndpointError::CandidateOutstanding)
        );
        harness.endpoint.discard_candidate();
        // The consumed authorization is not restored by a discard.
        assert_eq!(
            harness
                .endpoint
                .join(id(0x11), &welcome, context.group_id, now())
                .err(),
            Some(BrowserEndpointError::Witness(
                WitnessError::FreshWitnessRequired
            ))
        );
        // Activation with differing plaintext under the same operation and logical IDs is a
        // conflicting input, not a replay: the browser fingerprint covers the exact payload.
        assert_eq!(harness.fresh_head(), EndpointReconciliation::Ready);
        let BrowserMutation::Fresh(transition) = harness
            .endpoint
            .join(id(0x11), &welcome, context.group_id, now())
            .unwrap()
        else {
            panic!("expected fresh join");
        };
        let view = harness.commit(*transition);
        harness.finish(&view);
        let activation = harness.mutate(|endpoint, now| {
            endpoint.prepare_activation(id(0x12), id(0x40), b"payload one", now)
        });
        assert!(matches!(activation, BrowserTypedResult::Envelope { .. }));
        assert_eq!(harness.fresh_head(), EndpointReconciliation::Ready);
        assert_eq!(
            harness
                .endpoint
                .prepare_activation(id(0x12), id(0x40), b"payload two", now())
                .err(),
            Some(BrowserEndpointError::Witness(
                WitnessError::OperationConflict
            ))
        );
        assert_eq!(
            harness.endpoint.take_unpersisted_terminal(),
            Some(EndpointTerminalState::Quarantined(
                EndpointQuarantineReason::CommitmentConflict
            ))
        );
        assert_eq!(
            harness.endpoint.reconcile_witness(&[1]).unwrap(),
            EndpointReconciliation::Quarantined(EndpointQuarantineReason::CommitmentConflict)
        );
    }

    #[test]
    fn browser_device_quarantines_reused_operation_ids_with_other_kinds() {
        let context = context(0x85);
        let mut harness = Harness::create(&context);
        let pending = harness.endpoint.pending_witness().unwrap().unwrap();
        harness.finish(&pending);
        // Same operation ID with another fingerprint quarantines and blocks everything after.
        assert_eq!(harness.fresh_head(), EndpointReconciliation::Ready);
        assert_eq!(
            harness
                .endpoint
                .prepare_activation(id(0x10), id(0x40), b"x", now())
                .err(),
            Some(BrowserEndpointError::Witness(
                WitnessError::OperationConflict
            ))
        );
        let mut peer = TestPeerDaemon::new(context.clone(), now()).unwrap();
        let BrowserTypedResult::KeyPackage { bytes } = BrowserTypedResult::decode(
            &harness
                .endpoint
                .image
                .as_ref()
                .unwrap()
                .operation(id(0x10))
                .unwrap()
                .exact_result,
        )
        .unwrap() else {
            panic!("expected key package");
        };
        let welcome = peer.consume_key_package(&bytes).unwrap();
        assert_eq!(
            harness.endpoint.take_unpersisted_terminal(),
            Some(EndpointTerminalState::Quarantined(
                EndpointQuarantineReason::CommitmentConflict
            ))
        );
        assert_eq!(
            harness
                .endpoint
                .join(id(0x11), &welcome, context.group_id, now())
                .err(),
            Some(BrowserEndpointError::Witness(WitnessError::Quarantined))
        );
        assert_eq!(
            harness.endpoint.reconcile_witness(&[1]).unwrap(),
            EndpointReconciliation::Quarantined(EndpointQuarantineReason::CommitmentConflict)
        );
    }
}
