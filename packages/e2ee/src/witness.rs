// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

//! Canonical rollback-witness protocol and endpoint output barrier.
//!
//! This module owns binary protocol validation and the transport-independent state machine. It
//! owns no HTTP client, hosted replica, account authorization, or production key-store adapter.
//!
//! The sealed-transition constructors stay crate-private until a reviewed storage adapter wires
//! them to an atomic commit. Keeping them unreachable is part of the production fail-closed gate.

#![allow(dead_code)]

use std::{collections::BTreeMap, error::Error as StdError, fmt};

use openmls_basic_credential::SignatureKeyPair;
use openmls_traits::{
    OpenMlsProvider, crypto::OpenMlsCrypto as _, random::OpenMlsRand as _, signatures::Signer as _,
    types::AeadType,
};

use crate::{
    CoreProvider, Id, Identity, PROFILE_ID, PROFILE_REVISION, Role, SUITE,
    pairing::PairingCredential,
};

pub const WITNESS_PROTOCOL_VERSION: u16 = 1;
pub const WITNESS_REQUEST_MAX_BYTES: usize = 1024;
pub const WITNESS_RECEIPT_MAX_BYTES: usize = 1024;
pub const WITNESS_CERTIFICATE_MAX_BYTES: usize = 3 * 1024;
pub const WITNESS_REPLICA_COUNT: usize = 3;
pub const WITNESS_MAX_KEYS_PER_REPLICA: usize = 4;
pub const WITNESS_CREDENTIAL_MAX_BYTES: usize = 512;

const REQUEST_SIGNATURE_DOMAIN: &[u8] = b"Axl rollback witness request v1";
const RECEIPT_SIGNATURE_DOMAIN: &[u8] = b"Axl rollback witness receipt v1";
const LINEAGE_HASH_DOMAIN: &[u8] = b"Axl rollback witness lineage v1";
const STATE_COMMITMENT_DOMAIN: &[u8] = b"Axl rollback state commitment v1";
const INNER_AAD_DOMAIN: &[u8] = b"Axl rollback sealed inner v1";
const OUTER_AAD_DOMAIN: &[u8] = b"Axl rollback sealed outer v1";
const SEALED_STATE_VERSION: u16 = 1;
const COMMITTED_TRANSITION_VERSION: u16 = 1;
const INNER_PAYLOAD_VERSION: u16 = 1;
pub(crate) const MAX_INNER_STATE_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const MAX_RESULT_BYTES: usize = 65_497;
const MAX_INNER_PAYLOAD_BYTES: usize = MAX_INNER_STATE_BYTES + MAX_RESULT_BYTES + 16;
pub(crate) const MAX_COMMITTED_TRANSITION_BYTES: usize = MAX_INNER_PAYLOAD_BYTES + 4 * 1024;
const ZERO_HASH: [u8; 48] = [0; 48];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum WitnessRequestKind {
    Register = 1,
    Read = 2,
    Advance = 3,
}

impl TryFrom<u8> for WitnessRequestKind {
    type Error = WitnessError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Register),
            2 => Ok(Self::Read),
            3 => Ok(Self::Advance),
            _ => Err(WitnessError::Malformed),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum WitnessResult {
    Registered = 1,
    Head = 2,
    Advanced = 3,
    RegistrationConflict = 4,
    OperationConflict = 5,
    Revoked = 6,
    Forked = 7,
    StaleExpected = 8,
    ConflictingSuccessor = 9,
    HistoricalFork = 10,
    InvalidExpected = 11,
}

impl TryFrom<u8> for WitnessResult {
    type Error = WitnessError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Registered),
            2 => Ok(Self::Head),
            3 => Ok(Self::Advanced),
            4 => Ok(Self::RegistrationConflict),
            5 => Ok(Self::OperationConflict),
            6 => Ok(Self::Revoked),
            7 => Ok(Self::Forked),
            8 => Ok(Self::StaleExpected),
            9 => Ok(Self::ConflictingSuccessor),
            10 => Ok(Self::HistoricalFork),
            11 => Ok(Self::InvalidExpected),
            _ => Err(WitnessError::Malformed),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WitnessError {
    BoundExceeded,
    Malformed,
    NonCanonical,
    ProfileMismatch,
    LineageMismatch,
    RoleMismatch,
    GenerationMismatch,
    CounterMismatch,
    CommitmentMismatch,
    PredecessorMismatch,
    OperationMismatch,
    RequestHashMismatch,
    RevocationMismatch,
    CredentialMismatch,
    InvalidSignature,
    InvalidQuorum,
    DuplicateReplica,
    InvalidTrustSet,
    UnpinnedKey,
    MixedReceipts,
    UnexpectedResult,
    OperationConflict,
    RegistrationConflict,
    Revoked,
    Forked,
    StaleExpected,
    InvalidExpected,
    PendingOperation,
    NoPendingOperation,
    FreshWitnessRequired,
    Quarantined,
    OutputBlocked,
    CorruptState,
    Crypto,
}

impl fmt::Display for WitnessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl StdError for WitnessError {}

/// Immutable identity of one rollback-witness lineage.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WitnessLineage {
    account_id: Id,
    installation_id: Id,
    device_id: Id,
    crypto_session_id: Id,
    role: Role,
}

impl WitnessLineage {
    pub fn from_identity(identity: &Identity, crypto_session_id: Id) -> Result<Self, WitnessError> {
        identity
            .validate()
            .map_err(|_| WitnessError::LineageMismatch)?;
        validate_uuid_v7(identity.installation_id)?;
        validate_uuid_v7(crypto_session_id)?;
        if identity.role == Role::Device {
            validate_uuid_v7(identity.device_id)?;
        }
        Ok(Self {
            account_id: identity.account_id,
            installation_id: identity.installation_id,
            device_id: identity.device_id,
            crypto_session_id,
            role: identity.role,
        })
    }

    pub fn account_id(&self) -> Id {
        self.account_id
    }
    pub fn installation_id(&self) -> Id {
        self.installation_id
    }
    pub fn device_id(&self) -> Id {
        self.device_id
    }
    pub fn crypto_session_id(&self) -> Id {
        self.crypto_session_id
    }
    pub fn role(&self) -> Role {
        self.role
    }

    fn encode_into(&self, out: &mut Vec<u8>) {
        put_u8_bytes(out, PROFILE_ID.as_bytes());
        out.extend_from_slice(&PROFILE_REVISION.to_be_bytes());
        out.push(self.role as u8);
        out.extend_from_slice(&self.account_id);
        out.extend_from_slice(&self.installation_id);
        out.extend_from_slice(&self.device_id);
        out.extend_from_slice(&self.crypto_session_id);
    }

    fn decode(cursor: &mut Cursor<'_>) -> Result<Self, WitnessError> {
        let profile = cursor.u8_bytes(255)?;
        if profile != PROFILE_ID.as_bytes() || cursor.u16()? != PROFILE_REVISION {
            return Err(WitnessError::ProfileMismatch);
        }
        let role = match cursor.u8()? {
            1 => Role::Daemon,
            2 => Role::Device,
            _ => return Err(WitnessError::RoleMismatch),
        };
        let value = Self {
            account_id: cursor.array()?,
            installation_id: cursor.array()?,
            device_id: cursor.array()?,
            crypto_session_id: cursor.array()?,
            role,
        };
        let identity = Identity {
            role: value.role,
            account_id: value.account_id,
            installation_id: value.installation_id,
            device_id: value.device_id,
        };
        identity
            .validate()
            .map_err(|_| WitnessError::RoleMismatch)?;
        validate_uuid_v7(value.installation_id)?;
        validate_uuid_v7(value.crypto_session_id)?;
        if value.role == Role::Device {
            validate_uuid_v7(value.device_id)?;
        }
        Ok(value)
    }

    pub fn hash(&self) -> Result<[u8; 48], WitnessError> {
        let mut bytes = LINEAGE_HASH_DOMAIN.to_vec();
        self.encode_into(&mut bytes);
        sha384(&bytes)
    }
}

/// Canonical signed endpoint request. Construction remains inside the E2EE core.
#[derive(Clone, Eq, PartialEq)]
pub struct WitnessRequest {
    kind: WitnessRequestKind,
    lineage: WitnessLineage,
    operation_id: Id,
    nonce: [u8; 32],
    expected_counter: Option<u64>,
    expected_commitment: Option<[u8; 48]>,
    proposed_counter: Option<u64>,
    proposed_commitment: Option<[u8; 48]>,
    previous_certificate_hash: [u8; 48],
    credential_fingerprint: [u8; 48],
    credential: Option<Vec<u8>>,
    signature: [u8; 64],
}

impl fmt::Debug for WitnessRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WitnessRequest")
            .field("kind", &self.kind)
            .field("lineage", &self.lineage)
            .field("operation_id", &self.operation_id)
            .field("nonce", &"[redacted]")
            .field("expected_counter", &self.expected_counter)
            .field("proposed_counter", &self.proposed_counter)
            .field("signature", &"[redacted]")
            .finish()
    }
}

struct WitnessRequestSigning<'a> {
    kind: WitnessRequestKind,
    lineage: WitnessLineage,
    operation_id: Id,
    expected: Option<(u64, [u8; 48])>,
    proposed: Option<(u64, [u8; 48])>,
    previous_certificate_hash: [u8; 48],
    credential: &'a PairingCredential,
    signer: &'a SignatureKeyPair,
    nonce: [u8; 32],
}

impl WitnessRequest {
    pub fn decode(bytes: &[u8]) -> Result<Self, WitnessError> {
        if bytes.is_empty() || bytes.len() > WITNESS_REQUEST_MAX_BYTES {
            return Err(WitnessError::BoundExceeded);
        }
        let mut cursor = Cursor::new(bytes);
        if cursor.u16()? != WITNESS_PROTOCOL_VERSION {
            return Err(WitnessError::Malformed);
        }
        let value = Self {
            kind: cursor.u8()?.try_into()?,
            lineage: WitnessLineage::decode(&mut cursor)?,
            operation_id: cursor.array()?,
            nonce: cursor.array()?,
            expected_counter: cursor.optional_u64()?,
            expected_commitment: cursor.optional_array()?,
            proposed_counter: cursor.optional_u64()?,
            proposed_commitment: cursor.optional_array()?,
            previous_certificate_hash: cursor.array()?,
            credential_fingerprint: cursor.array()?,
            credential: cursor.optional_u16_bytes(WITNESS_CREDENTIAL_MAX_BYTES)?,
            signature: cursor.array()?,
        };
        cursor.finish()?;
        value.validate_shape()?;
        if value.encode()? != bytes {
            return Err(WitnessError::NonCanonical);
        }
        Ok(value)
    }

    pub fn encode(&self) -> Result<Vec<u8>, WitnessError> {
        self.validate_shape()?;
        let mut bytes = self.fields_before_signature()?;
        bytes.extend_from_slice(&self.signature);
        if bytes.len() > WITNESS_REQUEST_MAX_BYTES {
            return Err(WitnessError::BoundExceeded);
        }
        Ok(bytes)
    }

    pub fn kind(&self) -> WitnessRequestKind {
        self.kind
    }
    pub fn lineage(&self) -> &WitnessLineage {
        &self.lineage
    }
    pub fn operation_id(&self) -> Id {
        self.operation_id
    }
    pub fn expected_counter(&self) -> Option<u64> {
        self.expected_counter
    }
    pub fn expected_commitment(&self) -> Option<[u8; 48]> {
        self.expected_commitment
    }
    pub fn proposed_counter(&self) -> Option<u64> {
        self.proposed_counter
    }
    pub fn proposed_commitment(&self) -> Option<[u8; 48]> {
        self.proposed_commitment
    }
    pub fn previous_certificate_hash(&self) -> [u8; 48] {
        self.previous_certificate_hash
    }
    pub fn credential_fingerprint(&self) -> [u8; 48] {
        self.credential_fingerprint
    }
    pub fn credential(&self) -> Option<&[u8]> {
        self.credential.as_deref()
    }
    pub fn signature(&self) -> &[u8; 64] {
        &self.signature
    }

    pub fn request_hash(&self) -> Result<[u8; 48], WitnessError> {
        sha384(&self.encode()?)
    }

    pub fn verify(
        &self,
        expected_lineage: &WitnessLineage,
        expected_credential: &PairingCredential,
    ) -> Result<(), WitnessError> {
        if &self.lineage != expected_lineage {
            return Err(if self.lineage.role != expected_lineage.role {
                WitnessError::RoleMismatch
            } else {
                WitnessError::LineageMismatch
            });
        }
        if expected_credential.identity().role != expected_lineage.role
            || expected_credential.identity().account_id != expected_lineage.account_id
            || expected_credential.identity().installation_id != expected_lineage.installation_id
            || expected_credential.identity().device_id != expected_lineage.device_id
        {
            return Err(WitnessError::CredentialMismatch);
        }
        let fingerprint = sha384(expected_credential.bytes())?;
        if self.credential_fingerprint != fingerprint {
            return Err(WitnessError::CredentialMismatch);
        }
        match self.kind {
            WitnessRequestKind::Register => {
                if self.credential.as_deref() != Some(expected_credential.bytes()) {
                    return Err(WitnessError::CredentialMismatch);
                }
            }
            WitnessRequestKind::Read | WitnessRequestKind::Advance if self.credential.is_some() => {
                return Err(WitnessError::Malformed);
            }
            _ => {}
        }
        CoreProvider::new()
            .map_err(|_| WitnessError::Crypto)?
            .crypto()
            .verify_signature(
                SUITE.signature_algorithm(),
                &self.signature_input()?,
                expected_credential.verification_key(),
                &self.signature,
            )
            .map_err(|_| WitnessError::InvalidSignature)
    }

    pub(crate) fn new_read(
        lineage: WitnessLineage,
        operation_id: Id,
        previous_certificate_hash: [u8; 48],
        credential: &PairingCredential,
        signer: &SignatureKeyPair,
        nonce: [u8; 32],
    ) -> Result<Self, WitnessError> {
        Self::new_signed(WitnessRequestSigning {
            kind: WitnessRequestKind::Read,
            lineage,
            operation_id,
            expected: None,
            proposed: None,
            previous_certificate_hash,
            credential,
            signer,
            nonce,
        })
    }

    fn new_signed(material: WitnessRequestSigning<'_>) -> Result<Self, WitnessError> {
        let WitnessRequestSigning {
            kind,
            lineage,
            operation_id,
            expected,
            proposed,
            previous_certificate_hash,
            credential,
            signer,
            nonce,
        } = material;
        if signer.public() != credential.verification_key() {
            return Err(WitnessError::CredentialMismatch);
        }
        let mut value = Self {
            kind,
            lineage,
            operation_id,
            nonce,
            expected_counter: expected.map(|value| value.0),
            expected_commitment: expected.map(|value| value.1),
            proposed_counter: proposed.map(|value| value.0),
            proposed_commitment: proposed.map(|value| value.1),
            previous_certificate_hash,
            credential_fingerprint: sha384(credential.bytes())?,
            credential: (kind == WitnessRequestKind::Register).then(|| credential.bytes().to_vec()),
            signature: [0; 64],
        };
        value.validate_shape()?;
        value.signature = signer
            .sign(&value.signature_input()?)
            .map_err(|_| WitnessError::Crypto)?
            .try_into()
            .map_err(|_| WitnessError::Crypto)?;
        Ok(value)
    }

    fn validate_shape(&self) -> Result<(), WitnessError> {
        if self.operation_id == [0; 16] || self.nonce == [0; 32] {
            return Err(WitnessError::Malformed);
        }
        let valid = match self.kind {
            WitnessRequestKind::Register => {
                self.expected_counter.is_none()
                    && self.expected_commitment.is_none()
                    && self.proposed_counter == Some(1)
                    && self.proposed_commitment.is_some()
                    && self.previous_certificate_hash == ZERO_HASH
                    && self
                        .credential
                        .as_ref()
                        .is_some_and(|value| !value.is_empty())
            }
            WitnessRequestKind::Read => {
                self.expected_counter.is_none()
                    && self.expected_commitment.is_none()
                    && self.proposed_counter.is_none()
                    && self.proposed_commitment.is_none()
                    && self.credential.is_none()
            }
            WitnessRequestKind::Advance => {
                self.expected_counter
                    .zip(self.proposed_counter)
                    .is_some_and(|(expected, proposed)| expected.checked_add(1) == Some(proposed))
                    && self.expected_commitment.is_some()
                    && self.proposed_commitment.is_some()
                    && self.credential.is_none()
            }
        };
        if !valid {
            return Err(WitnessError::Malformed);
        }
        Ok(())
    }

    fn fields_before_signature(&self) -> Result<Vec<u8>, WitnessError> {
        let mut out = Vec::new();
        out.extend_from_slice(&WITNESS_PROTOCOL_VERSION.to_be_bytes());
        out.push(self.kind as u8);
        self.lineage.encode_into(&mut out);
        out.extend_from_slice(&self.operation_id);
        out.extend_from_slice(&self.nonce);
        put_optional_u64(&mut out, self.expected_counter);
        put_optional_array(&mut out, self.expected_commitment);
        put_optional_u64(&mut out, self.proposed_counter);
        put_optional_array(&mut out, self.proposed_commitment);
        out.extend_from_slice(&self.previous_certificate_hash);
        out.extend_from_slice(&self.credential_fingerprint);
        put_optional_u16_bytes(&mut out, self.credential.as_deref())?;
        Ok(out)
    }

    fn signature_input(&self) -> Result<Vec<u8>, WitnessError> {
        let mut out = REQUEST_SIGNATURE_DOMAIN.to_vec();
        out.extend_from_slice(&self.fields_before_signature()?);
        Ok(out)
    }
}

/// One independently signed witness-replica receipt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplicaReceipt {
    result: WitnessResult,
    replica_id: Id,
    witness_key_id: Id,
    lineage_hash: [u8; 48],
    counter: u64,
    commitment: [u8; 48],
    predecessor_commitment: [u8; 48],
    operation_id: Id,
    request_hash: [u8; 48],
    ledger_sequence: u64,
    issued_at_ms: u64,
    revocation_generation: u64,
    signature: [u8; 64],
}

impl ReplicaReceipt {
    pub fn decode(bytes: &[u8]) -> Result<Self, WitnessError> {
        if bytes.is_empty() || bytes.len() > WITNESS_RECEIPT_MAX_BYTES {
            return Err(WitnessError::BoundExceeded);
        }
        let mut cursor = Cursor::new(bytes);
        if cursor.u16()? != WITNESS_PROTOCOL_VERSION {
            return Err(WitnessError::Malformed);
        }
        let value = Self {
            result: cursor.u8()?.try_into()?,
            replica_id: cursor.array()?,
            witness_key_id: cursor.array()?,
            lineage_hash: cursor.array()?,
            counter: cursor.u64()?,
            commitment: cursor.array()?,
            predecessor_commitment: cursor.array()?,
            operation_id: cursor.array()?,
            request_hash: cursor.array()?,
            ledger_sequence: cursor.u64()?,
            issued_at_ms: cursor.u64()?,
            revocation_generation: cursor.u64()?,
            signature: cursor.array()?,
        };
        cursor.finish()?;
        if value.replica_id == [0; 16] || value.witness_key_id == [0; 16] {
            return Err(WitnessError::Malformed);
        }
        if value.encode()? != bytes {
            return Err(WitnessError::NonCanonical);
        }
        Ok(value)
    }

    pub fn encode(&self) -> Result<Vec<u8>, WitnessError> {
        let mut out = self.fields_before_signature();
        out.extend_from_slice(&self.signature);
        if out.len() > WITNESS_RECEIPT_MAX_BYTES {
            return Err(WitnessError::BoundExceeded);
        }
        Ok(out)
    }

    pub fn result(&self) -> WitnessResult {
        self.result
    }
    pub fn replica_id(&self) -> Id {
        self.replica_id
    }
    pub fn witness_key_id(&self) -> Id {
        self.witness_key_id
    }
    pub fn counter(&self) -> u64 {
        self.counter
    }
    pub fn commitment(&self) -> [u8; 48] {
        self.commitment
    }
    pub fn predecessor_commitment(&self) -> [u8; 48] {
        self.predecessor_commitment
    }
    pub fn operation_id(&self) -> Id {
        self.operation_id
    }
    pub fn request_hash(&self) -> [u8; 48] {
        self.request_hash
    }
    pub fn revocation_generation(&self) -> u64 {
        self.revocation_generation
    }

    fn fields_before_signature(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&WITNESS_PROTOCOL_VERSION.to_be_bytes());
        out.push(self.result as u8);
        out.extend_from_slice(&self.replica_id);
        out.extend_from_slice(&self.witness_key_id);
        out.extend_from_slice(&self.lineage_hash);
        out.extend_from_slice(&self.counter.to_be_bytes());
        out.extend_from_slice(&self.commitment);
        out.extend_from_slice(&self.predecessor_commitment);
        out.extend_from_slice(&self.operation_id);
        out.extend_from_slice(&self.request_hash);
        out.extend_from_slice(&self.ledger_sequence.to_be_bytes());
        out.extend_from_slice(&self.issued_at_ms.to_be_bytes());
        out.extend_from_slice(&self.revocation_generation.to_be_bytes());
        out
    }

    fn signature_input(&self) -> Vec<u8> {
        let mut out = RECEIPT_SIGNATURE_DOMAIN.to_vec();
        out.extend_from_slice(&self.fields_before_signature());
        out
    }
}

/// One versioned verification key pinned to exactly one replica identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplicaKey {
    key_id: Id,
    verification_key: [u8; 32],
}

impl ReplicaKey {
    pub fn new(key_id: Id, verification_key: [u8; 32]) -> Result<Self, WitnessError> {
        if key_id == [0; 16] || verification_key == [0; 32] {
            return Err(WitnessError::InvalidTrustSet);
        }
        Ok(Self {
            key_id,
            verification_key,
        })
    }

    pub fn key_id(&self) -> Id {
        self.key_id
    }

    pub fn verification_key(&self) -> [u8; 32] {
        self.verification_key
    }
}

/// Bounded overlap keyset for one pinned replica identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplicaTrust {
    replica_id: Id,
    keys: Vec<ReplicaKey>,
}

impl ReplicaTrust {
    pub fn new(replica_id: Id, mut keys: Vec<ReplicaKey>) -> Result<Self, WitnessError> {
        if replica_id == [0; 16] || keys.is_empty() || keys.len() > WITNESS_MAX_KEYS_PER_REPLICA {
            return Err(WitnessError::InvalidTrustSet);
        }
        keys.sort_by_key(ReplicaKey::key_id);
        for (index, key) in keys.iter().enumerate() {
            if keys[..index].iter().any(|prior| {
                prior.key_id == key.key_id || prior.verification_key == key.verification_key
            }) {
                return Err(WitnessError::InvalidTrustSet);
            }
        }
        Ok(Self { replica_id, keys })
    }

    pub fn replica_id(&self) -> Id {
        self.replica_id
    }

    pub fn keys(&self) -> &[ReplicaKey] {
        &self.keys
    }

    fn key(&self, key_id: Id) -> Option<&ReplicaKey> {
        self.keys.iter().find(|key| key.key_id == key_id)
    }
}

/// Canonically ordered trust for exactly three distinct replica identities.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplicaTrustSet {
    replicas: [ReplicaTrust; WITNESS_REPLICA_COUNT],
}

impl ReplicaTrustSet {
    pub fn new(mut replicas: Vec<ReplicaTrust>) -> Result<Self, WitnessError> {
        if replicas.len() != WITNESS_REPLICA_COUNT {
            return Err(WitnessError::InvalidTrustSet);
        }
        replicas.sort_by_key(ReplicaTrust::replica_id);
        for (index, replica) in replicas.iter().enumerate() {
            if replicas[..index]
                .iter()
                .any(|prior| prior.replica_id == replica.replica_id)
            {
                return Err(WitnessError::InvalidTrustSet);
            }
            for key in &replica.keys {
                if replicas[..index]
                    .iter()
                    .flat_map(|prior| &prior.keys)
                    .any(|prior| {
                        prior.key_id == key.key_id || prior.verification_key == key.verification_key
                    })
                {
                    return Err(WitnessError::InvalidTrustSet);
                }
            }
        }
        let replicas = replicas
            .try_into()
            .map_err(|_| WitnessError::InvalidTrustSet)?;
        Ok(Self { replicas })
    }

    pub fn replicas(&self) -> &[ReplicaTrust; WITNESS_REPLICA_COUNT] {
        &self.replicas
    }

    fn replica(&self, replica_id: Id) -> Option<&ReplicaTrust> {
        self.replicas
            .iter()
            .find(|replica| replica.replica_id == replica_id)
    }
}

/// Canonical unanimous certificate containing exactly three receipts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QuorumCertificate {
    receipts: [ReplicaReceipt; WITNESS_REPLICA_COUNT],
}

impl QuorumCertificate {
    pub fn decode(bytes: &[u8]) -> Result<Self, WitnessError> {
        if bytes.is_empty() || bytes.len() > WITNESS_CERTIFICATE_MAX_BYTES {
            return Err(WitnessError::BoundExceeded);
        }
        let mut cursor = Cursor::new(bytes);
        if cursor.u16()? != WITNESS_PROTOCOL_VERSION
            || cursor.u8()? as usize != WITNESS_REPLICA_COUNT
        {
            return Err(WitnessError::InvalidQuorum);
        }
        let mut values = Vec::with_capacity(WITNESS_REPLICA_COUNT);
        for _ in 0..WITNESS_REPLICA_COUNT {
            values.push(ReplicaReceipt::decode(
                cursor.u16_bytes(WITNESS_RECEIPT_MAX_BYTES)?,
            )?);
        }
        cursor.finish()?;
        let receipts: [ReplicaReceipt; WITNESS_REPLICA_COUNT] =
            values.try_into().map_err(|_| WitnessError::InvalidQuorum)?;
        let value = Self { receipts };
        value.validate_canonical_order()?;
        if value.encode()? != bytes {
            return Err(WitnessError::NonCanonical);
        }
        Ok(value)
    }

    pub fn encode(&self) -> Result<Vec<u8>, WitnessError> {
        self.validate_canonical_order()?;
        let mut out = Vec::new();
        out.extend_from_slice(&WITNESS_PROTOCOL_VERSION.to_be_bytes());
        out.push(WITNESS_REPLICA_COUNT as u8);
        for receipt in &self.receipts {
            let bytes = receipt.encode()?;
            let length = u16::try_from(bytes.len()).map_err(|_| WitnessError::BoundExceeded)?;
            out.extend_from_slice(&length.to_be_bytes());
            out.extend_from_slice(&bytes);
        }
        if out.len() > WITNESS_CERTIFICATE_MAX_BYTES {
            return Err(WitnessError::BoundExceeded);
        }
        Ok(out)
    }

    pub fn receipts(&self) -> &[ReplicaReceipt; WITNESS_REPLICA_COUNT] {
        &self.receipts
    }

    pub fn verify(
        &self,
        request: &WitnessRequest,
        trust: &ReplicaTrustSet,
    ) -> Result<WitnessResult, WitnessError> {
        self.validate_canonical_order()?;
        let request_hash = request.request_hash()?;
        let lineage_hash = request.lineage.hash()?;
        let first = &self.receipts[0];
        let expected_counter = match request.kind {
            WitnessRequestKind::Register | WitnessRequestKind::Advance => request.proposed_counter,
            WitnessRequestKind::Read => Some(first.counter),
        }
        .ok_or(WitnessError::CounterMismatch)?;
        let expected_commitment = match request.kind {
            WitnessRequestKind::Register | WitnessRequestKind::Advance => {
                request.proposed_commitment
            }
            WitnessRequestKind::Read => Some(first.commitment),
        }
        .ok_or(WitnessError::CommitmentMismatch)?;
        let expected_predecessor = if request.kind == WitnessRequestKind::Read {
            first.predecessor_commitment
        } else {
            request.expected_commitment.unwrap_or(ZERO_HASH)
        };
        let crypto = CoreProvider::new().map_err(|_| WitnessError::Crypto)?;
        for receipt in &self.receipts {
            let replica = trust
                .replica(receipt.replica_id)
                .ok_or(WitnessError::InvalidQuorum)?;
            let pinned = replica
                .key(receipt.witness_key_id)
                .ok_or(WitnessError::UnpinnedKey)?;
            crypto
                .crypto()
                .verify_signature(
                    SUITE.signature_algorithm(),
                    &receipt.signature_input(),
                    &pinned.verification_key,
                    &receipt.signature,
                )
                .map_err(|_| WitnessError::InvalidSignature)?;
            if receipt.lineage_hash != lineage_hash {
                return Err(WitnessError::LineageMismatch);
            }
            if receipt.counter != expected_counter {
                return Err(WitnessError::CounterMismatch);
            }
            if receipt.commitment != expected_commitment {
                return Err(WitnessError::CommitmentMismatch);
            }
            if receipt.predecessor_commitment != expected_predecessor {
                return Err(WitnessError::PredecessorMismatch);
            }
            if receipt.operation_id != request.operation_id {
                return Err(WitnessError::OperationMismatch);
            }
            if receipt.request_hash != request_hash {
                return Err(WitnessError::RequestHashMismatch);
            }
            if receipt.result != first.result {
                return Err(WitnessError::MixedReceipts);
            }
            if receipt.revocation_generation != first.revocation_generation {
                return Err(WitnessError::RevocationMismatch);
            }
        }
        Ok(first.result)
    }

    fn validate_canonical_order(&self) -> Result<(), WitnessError> {
        if self.receipts[0].replica_id >= self.receipts[1].replica_id
            || self.receipts[1].replica_id >= self.receipts[2].replica_id
        {
            return Err(
                if self.receipts.iter().enumerate().any(|(index, receipt)| {
                    self.receipts[..index]
                        .iter()
                        .any(|prior| prior.replica_id == receipt.replica_id)
                }) {
                    WitnessError::DuplicateReplica
                } else {
                    WitnessError::NonCanonical
                },
            );
        }
        Ok(())
    }
}

/// Clear authenticated state header. Callers cannot select its fields through the public API.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WitnessStateHeader {
    pub lineage: WitnessLineage,
    pub counter: u64,
    pub generation: u64,
    pub epoch: u64,
    pub epoch_authenticator: [u8; 48],
    pub current_key_id: Id,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SealedWitnessState {
    header: WitnessStateHeader,
    inner_nonce: [u8; 12],
    outer_nonce: [u8; 12],
    sealed_inner: Vec<u8>,
    sealed_outer: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OuterMetadata {
    commitment: [u8; 48],
    predecessor: [u8; 48],
    request: Vec<u8>,
    request_hash: [u8; 48],
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RecoveredWitnessState {
    pub inner_state: Vec<u8>,
    pub exact_result: Vec<u8>,
    pub commitment: [u8; 48],
    pub predecessor: [u8; 48],
    pub request: WitnessRequest,
    pub request_bytes: Vec<u8>,
    pub request_hash: [u8; 48],
}

impl SealedWitnessState {
    pub(crate) fn encode(&self) -> Result<Vec<u8>, WitnessError> {
        let mut out = self.header_bytes()?;
        out.extend_from_slice(&self.inner_nonce);
        out.extend_from_slice(&self.outer_nonce);
        put_u32_bytes(&mut out, &self.sealed_inner)?;
        put_u32_bytes(&mut out, &self.sealed_outer)?;
        Ok(out)
    }

    pub(crate) fn decode(bytes: &[u8]) -> Result<Self, WitnessError> {
        let mut cursor = Cursor::new(bytes);
        if cursor.u16()? != SEALED_STATE_VERSION {
            return Err(WitnessError::Malformed);
        }
        let header = WitnessStateHeader {
            lineage: WitnessLineage::decode(&mut cursor)?,
            counter: cursor.u64()?,
            generation: cursor.u64()?,
            epoch: cursor.u64()?,
            epoch_authenticator: cursor.array()?,
            current_key_id: cursor.array()?,
        };
        let value = Self {
            header,
            inner_nonce: cursor.array()?,
            outer_nonce: cursor.array()?,
            sealed_inner: cursor.u32_bytes(MAX_INNER_PAYLOAD_BYTES + 16)?.to_vec(),
            sealed_outer: cursor.u32_bytes(WITNESS_REQUEST_MAX_BYTES + 256)?.to_vec(),
        };
        cursor.finish()?;
        if value.inner_nonce == value.outer_nonce {
            return Err(WitnessError::CorruptState);
        }
        if value.encode()? != bytes {
            return Err(WitnessError::NonCanonical);
        }
        Ok(value)
    }

    pub(crate) fn open(
        &self,
        data_key: &[u8; 32],
        expected_lineage: &WitnessLineage,
        credential: &PairingCredential,
    ) -> Result<RecoveredWitnessState, WitnessError> {
        if &self.header.lineage != expected_lineage {
            return Err(WitnessError::LineageMismatch);
        }
        let provider = CoreProvider::new().map_err(|_| WitnessError::Crypto)?;
        let header = self.header_bytes()?;
        let mut inner_aad = INNER_AAD_DOMAIN.to_vec();
        inner_aad.extend_from_slice(&header);
        let inner_payload = provider
            .crypto()
            .aead_decrypt(
                AeadType::Aes256Gcm,
                data_key,
                &self.sealed_inner,
                &self.inner_nonce,
                &inner_aad,
            )
            .map_err(|_| WitnessError::CorruptState)?;
        let (inner_state, exact_result) = decode_inner_payload(&inner_payload)?;
        let mut outer_aad = OUTER_AAD_DOMAIN.to_vec();
        outer_aad.extend_from_slice(&header);
        let outer = provider
            .crypto()
            .aead_decrypt(
                AeadType::Aes256Gcm,
                data_key,
                &self.sealed_outer,
                &self.outer_nonce,
                &outer_aad,
            )
            .map_err(|_| WitnessError::CorruptState)?;
        let metadata = decode_outer(&outer)?;
        let commitment = state_commitment(&self.header, &self.sealed_inner, metadata.predecessor)?;
        if commitment != metadata.commitment {
            return Err(WitnessError::CommitmentMismatch);
        }
        if sha384(&metadata.request)? != metadata.request_hash {
            return Err(WitnessError::RequestHashMismatch);
        }
        let request = WitnessRequest::decode(&metadata.request)?;
        request.verify(expected_lineage, credential)?;
        if request.proposed_counter != Some(self.header.counter)
            || request.proposed_commitment != Some(commitment)
            || request.expected_commitment.unwrap_or(ZERO_HASH) != metadata.predecessor
        {
            return Err(WitnessError::CommitmentMismatch);
        }
        Ok(RecoveredWitnessState {
            inner_state,
            exact_result,
            commitment,
            predecessor: metadata.predecessor,
            request,
            request_bytes: metadata.request,
            request_hash: metadata.request_hash,
        })
    }

    fn header_bytes(&self) -> Result<Vec<u8>, WitnessError> {
        encode_header(&self.header)
    }
}

/// Internal prepared state. It deliberately offers no witness-request accessor before commit.
pub(crate) struct PreparedWitnessTransition {
    sealed: SealedWitnessState,
    exact_result: Vec<u8>,
    request: WitnessRequest,
    request_bytes: Vec<u8>,
    request_hash: [u8; 48],
    has_obsolete_key: bool,
}

impl PreparedWitnessTransition {
    /// One canonical record containing the sealed successor and exact operation result. A storage
    /// adapter writes this value in its state transaction. There is no separately writable request.
    pub(crate) fn committed_record(&self) -> Result<Vec<u8>, WitnessError> {
        let sealed = self.sealed.encode()?;
        let mut out = Vec::with_capacity(2 + 16 + 4 + sealed.len());
        out.extend_from_slice(&COMMITTED_TRANSITION_VERSION.to_be_bytes());
        out.extend_from_slice(&self.request.operation_id);
        put_u32_bytes(&mut out, &sealed)?;
        if out.len() > MAX_COMMITTED_TRANSITION_BYTES {
            return Err(WitnessError::BoundExceeded);
        }
        Ok(out)
    }

    fn into_pending(self) -> PendingWitnessOperation {
        PendingWitnessOperation {
            request: self.request,
            request_bytes: self.request_bytes,
            request_hash: self.request_hash,
            exact_result: self.exact_result,
            current_key_active: false,
            quorum_confirmed: false,
            obsolete_key_erased: !self.has_obsolete_key,
            revocation_generation: None,
            certificate_hash: None,
        }
    }

    #[cfg(test)]
    fn local_commit_complete_for_test(self) -> PendingWitnessOperation {
        self.into_pending()
    }
}

/// Prepared transition carrying the one-shot authorization consumed by `prepare`.
pub(crate) struct AuthorizedWitnessTransition {
    prepared: PreparedWitnessTransition,
    authorization: MutationAuthorization,
}

/// The only public continuation for a locally committed state transition.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PendingWitnessStatus {
    AwaitingQuorum,
    Ready,
}

#[derive(Clone)]
pub struct PendingWitnessOperation {
    request: WitnessRequest,
    request_bytes: Vec<u8>,
    request_hash: [u8; 48],
    exact_result: Vec<u8>,
    current_key_active: bool,
    quorum_confirmed: bool,
    obsolete_key_erased: bool,
    revocation_generation: Option<u64>,
    certificate_hash: Option<[u8; 48]>,
}

impl PendingWitnessOperation {
    pub fn operation_id(&self) -> Id {
        self.request.operation_id
    }
    pub fn witness_request(&self) -> &[u8] {
        &self.request_bytes
    }
    pub fn request_hash(&self) -> [u8; 48] {
        self.request_hash
    }

    pub fn status(&self) -> PendingWitnessStatus {
        if self.current_key_active && self.quorum_confirmed && self.obsolete_key_erased {
            PendingWitnessStatus::Ready
        } else {
            PendingWitnessStatus::AwaitingQuorum
        }
    }

    pub fn confirm_quorum(
        &mut self,
        certificate_bytes: &[u8],
        trust: &ReplicaTrustSet,
    ) -> Result<(), WitnessError> {
        let certificate = QuorumCertificate::decode(certificate_bytes)?;
        let result = certificate.verify(&self.request, trust)?;
        let expected = match self.request.kind {
            WitnessRequestKind::Register => WitnessResult::Registered,
            WitnessRequestKind::Advance => WitnessResult::Advanced,
            WitnessRequestKind::Read => WitnessResult::Head,
        };
        if result != expected {
            return Err(match result {
                WitnessResult::OperationConflict => WitnessError::OperationConflict,
                WitnessResult::RegistrationConflict => WitnessError::RegistrationConflict,
                WitnessResult::Revoked => WitnessError::Revoked,
                WitnessResult::Forked
                | WitnessResult::ConflictingSuccessor
                | WitnessResult::HistoricalFork => WitnessError::Forked,
                WitnessResult::StaleExpected => WitnessError::StaleExpected,
                WitnessResult::InvalidExpected => WitnessError::InvalidExpected,
                _ => WitnessError::UnexpectedResult,
            });
        }
        self.quorum_confirmed = true;
        self.revocation_generation = Some(certificate.receipts[0].revocation_generation);
        self.certificate_hash = Some(sha384(certificate_bytes)?);
        Ok(())
    }

    pub fn committed_result(&self) -> Result<&[u8], WitnessError> {
        if self.current_key_active && self.quorum_confirmed && self.obsolete_key_erased {
            Ok(&self.exact_result)
        } else {
            Err(WitnessError::OutputBlocked)
        }
    }

    pub(crate) fn current_key_activated(&mut self) {
        self.current_key_active = true;
    }

    pub(crate) fn obsolete_key_erased(&mut self) -> Result<(), WitnessError> {
        if !self.current_key_active || !self.quorum_confirmed {
            return Err(WitnessError::OutputBlocked);
        }
        self.obsolete_key_erased = true;
        Ok(())
    }
}

#[cfg(feature = "node-test-fixtures")]
#[doc(hidden)]
pub fn test_pending_witness_operation(
    request_bytes: &[u8],
    exact_result: &[u8],
) -> Result<PendingWitnessOperation, WitnessError> {
    if exact_result.len() > MAX_RESULT_BYTES {
        return Err(WitnessError::BoundExceeded);
    }
    let request = WitnessRequest::decode(request_bytes)?;
    Ok(PendingWitnessOperation {
        request_hash: request.request_hash()?,
        request,
        request_bytes: request_bytes.to_vec(),
        exact_result: exact_result.to_vec(),
        current_key_active: true,
        quorum_confirmed: false,
        obsolete_key_erased: true,
        revocation_generation: None,
        certificate_hash: None,
    })
}

/// Serializes state-advancing work for one endpoint. A locally committed operation remains the
/// sole operation until its exact result passes the witness and key-erasure barriers.
pub(crate) struct EndpointWitnessState {
    head_counter: u64,
    head_commitment: [u8; 48],
    previous_certificate_hash: [u8; 48],
    pending: Option<PendingWitnessOperation>,
    terminal: Option<EndpointTerminalState>,
    mutation_authorization: Option<MutationAuthorization>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum MutationAuthorization {
    Register,
    Advance(WitnessHead),
}

impl EndpointWitnessState {
    pub(crate) fn new() -> Self {
        Self {
            head_counter: 0,
            head_commitment: ZERO_HASH,
            previous_certificate_hash: ZERO_HASH,
            pending: None,
            terminal: None,
            mutation_authorization: None,
        }
    }

    pub(crate) fn prepare(
        &mut self,
        mut material: TransitionMaterial<'_>,
    ) -> Result<AuthorizedWitnessTransition, WitnessError> {
        if let Some(terminal) = self.terminal {
            return Err(match terminal {
                EndpointTerminalState::Quarantined(_) => WitnessError::Quarantined,
                EndpointTerminalState::Revoked => WitnessError::Revoked,
            });
        }
        if self.pending.is_some() {
            return Err(WitnessError::PendingOperation);
        }
        let authorization = self
            .mutation_authorization
            .take()
            .ok_or(WitnessError::FreshWitnessRequired)?;
        let confirmed = WitnessHead {
            counter: self.head_counter,
            commitment: self.head_commitment,
        };
        match &authorization {
            MutationAuthorization::Register
                if confirmed.counter == 0
                    && confirmed.commitment == ZERO_HASH
                    && material.counter == 1 => {}
            MutationAuthorization::Advance(expected)
                if expected == &confirmed
                    && material.counter == confirmed.counter.saturating_add(1) => {}
            _ => return Err(WitnessError::GenerationMismatch),
        }
        material.predecessor_commitment = self.head_commitment;
        material.previous_certificate_hash = self.previous_certificate_hash;
        Ok(AuthorizedWitnessTransition {
            prepared: prepare_transition(material)?,
            authorization,
        })
    }

    pub(crate) fn local_commit_complete(
        &mut self,
        prepared: AuthorizedWitnessTransition,
    ) -> Result<(), WitnessError> {
        if self.pending.is_some() {
            return Err(WitnessError::PendingOperation);
        }
        let confirmed = WitnessHead {
            counter: self.head_counter,
            commitment: self.head_commitment,
        };
        if !matches!(
            &prepared.authorization,
            MutationAuthorization::Register if confirmed.counter == 0 && confirmed.commitment == ZERO_HASH
        ) && !matches!(
            &prepared.authorization,
            MutationAuthorization::Advance(expected) if expected == &confirmed
        ) {
            return Err(WitnessError::FreshWitnessRequired);
        }
        self.pending = Some(prepared.prepared.into_pending());
        Ok(())
    }

    pub(crate) fn recover_pending(
        &mut self,
        pending: PendingWitnessOperation,
    ) -> Result<(), WitnessError> {
        if self.pending.is_some()
            || pending.request.expected_counter.unwrap_or(0) != self.head_counter
            || pending.request.expected_commitment.unwrap_or(ZERO_HASH) != self.head_commitment
        {
            return Err(WitnessError::PendingOperation);
        }
        self.mutation_authorization = None;
        self.pending = Some(pending);
        Ok(())
    }

    pub(crate) fn pending(&self) -> Result<&PendingWitnessOperation, WitnessError> {
        self.pending
            .as_ref()
            .ok_or(WitnessError::NoPendingOperation)
    }

    pub(crate) fn pending_mut(&mut self) -> Result<&mut PendingWitnessOperation, WitnessError> {
        self.pending
            .as_mut()
            .ok_or(WitnessError::NoPendingOperation)
    }

    pub(crate) fn release_and_advance(&mut self) -> Result<Vec<u8>, WitnessError> {
        if let Some(terminal) = self.terminal {
            return Err(match terminal {
                EndpointTerminalState::Quarantined(_) => WitnessError::Quarantined,
                EndpointTerminalState::Revoked => WitnessError::Revoked,
            });
        }
        let pending = self
            .pending
            .as_ref()
            .ok_or(WitnessError::NoPendingOperation)?;
        let result = pending.committed_result()?.to_vec();
        self.head_counter = pending
            .request
            .proposed_counter
            .ok_or(WitnessError::CounterMismatch)?;
        self.head_commitment = pending
            .request
            .proposed_commitment
            .ok_or(WitnessError::CommitmentMismatch)?;
        self.previous_certificate_hash = pending
            .certificate_hash
            .ok_or(WitnessError::InvalidQuorum)?;
        self.pending = None;
        Ok(result)
    }

    pub(crate) fn reconcile(
        &mut self,
        local_state_present: bool,
        lineage_was_registered: bool,
        quorum: FreshQuorumState,
    ) -> EndpointReconciliation {
        self.mutation_authorization = None;
        if let Some(terminal) = self.terminal {
            return terminal.into();
        }
        if !local_state_present && self.pending.is_some() {
            let reason = EndpointQuarantineReason::PendingWithoutLocalState;
            self.terminal = Some(EndpointTerminalState::Quarantined(reason));
            return EndpointReconciliation::Quarantined(reason);
        }
        let outcome = reconcile_endpoint_state(
            local_state_present,
            lineage_was_registered,
            WitnessHead {
                counter: self.head_counter,
                commitment: self.head_commitment,
            },
            self.pending.as_ref(),
            quorum,
        );
        match outcome {
            EndpointReconciliation::Quarantined(reason) => {
                self.terminal = Some(EndpointTerminalState::Quarantined(reason));
            }
            EndpointReconciliation::Revoked => {
                self.terminal = Some(EndpointTerminalState::Revoked);
            }
            EndpointReconciliation::Ready => {
                self.mutation_authorization = Some(if local_state_present {
                    MutationAuthorization::Advance(WitnessHead {
                        counter: self.head_counter,
                        commitment: self.head_commitment,
                    })
                } else {
                    MutationAuthorization::Register
                });
            }
            EndpointReconciliation::ResendPending
            | EndpointReconciliation::RecoverAccepted
            | EndpointReconciliation::WitnessUnavailable => {}
        }
        outcome
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EndpointQuarantineReason {
    StateLoss,
    PendingWithoutLocalState,
    WitnessLineageMissing,
    CommitmentConflict,
    LocalAheadMoreThanOne,
    WitnessBehindMoreThanOne,
    WitnessInconsistent,
    ImmediateFork,
    HistoricalFork,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EndpointTerminalState {
    Quarantined(EndpointQuarantineReason),
    Revoked,
}

impl From<EndpointTerminalState> for EndpointReconciliation {
    fn from(value: EndpointTerminalState) -> Self {
        match value {
            EndpointTerminalState::Quarantined(reason) => Self::Quarantined(reason),
            EndpointTerminalState::Revoked => Self::Revoked,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EndpointReconciliation {
    Ready,
    ResendPending,
    RecoverAccepted,
    WitnessUnavailable,
    Quarantined(EndpointQuarantineReason),
    Revoked,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AcceptedRecoveryEvidence {
    operation_id: Id,
    request_hash: [u8; 48],
    accepted_at: WitnessLedgerPosition,
}

impl AcceptedRecoveryEvidence {
    fn accepted_before_revocation(&self, revocation: WitnessRevocationEvent) -> bool {
        self.accepted_at.sequence < revocation.position.sequence
            && self.accepted_at.revocation_generation < revocation.position.revocation_generation
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FreshQuorumHead {
    head: WitnessHead,
    revocation: Option<WitnessRevocationEvent>,
    fork: Option<WitnessResult>,
    accepted_operation: Option<AcceptedRecoveryEvidence>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum FreshQuorumState {
    Absent,
    Head(FreshQuorumHead),
    Mixed,
    Inconsistent,
    Unavailable,
}

fn quarantine(reason: EndpointQuarantineReason) -> EndpointReconciliation {
    EndpointReconciliation::Quarantined(reason)
}

fn reconcile_endpoint_state(
    local_state_present: bool,
    lineage_was_registered: bool,
    confirmed: WitnessHead,
    pending: Option<&PendingWitnessOperation>,
    quorum: FreshQuorumState,
) -> EndpointReconciliation {
    if !local_state_present && pending.is_some() {
        return quarantine(EndpointQuarantineReason::PendingWithoutLocalState);
    }
    match quorum {
        FreshQuorumState::Unavailable => EndpointReconciliation::WitnessUnavailable,
        FreshQuorumState::Mixed | FreshQuorumState::Inconsistent => {
            quarantine(EndpointQuarantineReason::WitnessInconsistent)
        }
        FreshQuorumState::Absent => {
            if !local_state_present && !lineage_was_registered {
                return EndpointReconciliation::Ready;
            }
            if pending.is_some_and(|value| value.request.kind == WitnessRequestKind::Register) {
                return EndpointReconciliation::ResendPending;
            }
            quarantine(EndpointQuarantineReason::WitnessLineageMissing)
        }
        FreshQuorumState::Head(quorum) => {
            if !local_state_present {
                return quarantine(EndpointQuarantineReason::StateLoss);
            }
            if quorum.head.counter == 0 || quorum.head.commitment == ZERO_HASH {
                return quarantine(EndpointQuarantineReason::WitnessInconsistent);
            }
            if let Some(fork) = quorum.fork {
                return quarantine(match fork {
                    WitnessResult::ConflictingSuccessor => EndpointQuarantineReason::ImmediateFork,
                    WitnessResult::HistoricalFork | WitnessResult::Forked => {
                        EndpointQuarantineReason::HistoricalFork
                    }
                    _ => EndpointQuarantineReason::WitnessInconsistent,
                });
            }
            if let Some(revocation) = quorum.revocation {
                if revocation.position.sequence == 0
                    || revocation.position.revocation_generation == 0
                {
                    return quarantine(EndpointQuarantineReason::WitnessInconsistent);
                }
                let recoverable =
                    pending
                        .zip(quorum.accepted_operation)
                        .is_some_and(|(pending, accepted)| {
                            let proposed = WitnessHead {
                                counter: pending.request.proposed_counter.unwrap_or(0),
                                commitment: pending
                                    .request
                                    .proposed_commitment
                                    .unwrap_or(ZERO_HASH),
                            };
                            quorum.head == proposed
                                && accepted.operation_id == pending.operation_id()
                                && accepted.request_hash == pending.request_hash()
                                && accepted.accepted_before_revocation(revocation)
                        });
                return if recoverable {
                    EndpointReconciliation::RecoverAccepted
                } else {
                    EndpointReconciliation::Revoked
                };
            }
            let Some(pending) = pending else {
                if quorum.head == confirmed {
                    return EndpointReconciliation::Ready;
                }
                if quorum.head.counter == confirmed.counter
                    && quorum.head.commitment != confirmed.commitment
                {
                    return quarantine(EndpointQuarantineReason::CommitmentConflict);
                }
                if quorum.head.counter > confirmed.counter {
                    return quarantine(EndpointQuarantineReason::StateLoss);
                }
                return if confirmed.counter.saturating_sub(quorum.head.counter) > 1 {
                    quarantine(EndpointQuarantineReason::WitnessBehindMoreThanOne)
                } else {
                    quarantine(EndpointQuarantineReason::WitnessInconsistent)
                };
            };
            let expected = WitnessHead {
                counter: pending.request.expected_counter.unwrap_or(0),
                commitment: pending.request.expected_commitment.unwrap_or(ZERO_HASH),
            };
            let proposed = WitnessHead {
                counter: pending.request.proposed_counter.unwrap_or(0),
                commitment: pending.request.proposed_commitment.unwrap_or(ZERO_HASH),
            };
            if expected != confirmed || proposed.counter != confirmed.counter.saturating_add(1) {
                return quarantine(EndpointQuarantineReason::LocalAheadMoreThanOne);
            }
            if quorum.head == confirmed {
                return EndpointReconciliation::ResendPending;
            }
            if quorum.head == proposed {
                return EndpointReconciliation::RecoverAccepted;
            }
            if quorum.head.counter == proposed.counter
                && quorum.head.commitment != proposed.commitment
            {
                return quarantine(EndpointQuarantineReason::CommitmentConflict);
            }
            if quorum.head.counter > proposed.counter {
                return quarantine(EndpointQuarantineReason::StateLoss);
            }
            if proposed.counter.saturating_sub(quorum.head.counter) > 1 {
                return quarantine(EndpointQuarantineReason::LocalAheadMoreThanOne);
            }
            quarantine(EndpointQuarantineReason::WitnessInconsistent)
        }
    }
}

pub(crate) struct TransitionMaterial<'a> {
    pub lineage: WitnessLineage,
    pub counter: u64,
    pub generation: u64,
    pub epoch: u64,
    pub epoch_authenticator: [u8; 48],
    pub current_key_id: Id,
    pub predecessor_commitment: [u8; 48],
    pub previous_certificate_hash: [u8; 48],
    pub operation_id: Id,
    pub inner_state: &'a [u8],
    pub exact_result: &'a [u8],
    pub data_key: &'a [u8; 32],
    pub credential: &'a PairingCredential,
    pub signer: &'a SignatureKeyPair,
}

pub(crate) fn prepare_transition(
    material: TransitionMaterial<'_>,
) -> Result<PreparedWitnessTransition, WitnessError> {
    if material.inner_state.len() > MAX_INNER_STATE_BYTES
        || material.exact_result.len() > MAX_RESULT_BYTES
        || material.counter == 0
        || material.generation == 0
    {
        return Err(WitnessError::BoundExceeded);
    }
    let header = WitnessStateHeader {
        lineage: material.lineage.clone(),
        counter: material.counter,
        generation: material.generation,
        epoch: material.epoch,
        epoch_authenticator: material.epoch_authenticator,
        current_key_id: material.current_key_id,
    };
    let provider = CoreProvider::new().map_err(|_| WitnessError::Crypto)?;
    let inner_nonce = provider
        .rand()
        .random_array::<12>()
        .map_err(|_| WitnessError::Crypto)?;
    let outer_nonce = loop {
        let value = provider
            .rand()
            .random_array::<12>()
            .map_err(|_| WitnessError::Crypto)?;
        if value != inner_nonce {
            break value;
        }
    };
    let header_bytes = encode_header(&header)?;
    let inner_payload = encode_inner_payload(material.inner_state, material.exact_result)?;
    let mut inner_aad = INNER_AAD_DOMAIN.to_vec();
    inner_aad.extend_from_slice(&header_bytes);
    let sealed_inner = provider
        .crypto()
        .aead_encrypt(
            AeadType::Aes256Gcm,
            material.data_key,
            &inner_payload,
            &inner_nonce,
            &inner_aad,
        )
        .map_err(|_| WitnessError::Crypto)?;
    let commitment = state_commitment(&header, &sealed_inner, material.predecessor_commitment)?;
    let nonce = provider
        .rand()
        .random_array::<32>()
        .map_err(|_| WitnessError::Crypto)?;
    let kind = if material.counter == 1 {
        WitnessRequestKind::Register
    } else {
        WitnessRequestKind::Advance
    };
    let expected =
        (material.counter > 1).then_some((material.counter - 1, material.predecessor_commitment));
    let request = WitnessRequest::new_signed(WitnessRequestSigning {
        kind,
        lineage: material.lineage,
        operation_id: material.operation_id,
        expected,
        proposed: Some((material.counter, commitment)),
        previous_certificate_hash: material.previous_certificate_hash,
        credential: material.credential,
        signer: material.signer,
        nonce,
    })?;
    let request_bytes = request.encode()?;
    let request_hash = sha384(&request_bytes)?;
    let outer = encode_outer(&OuterMetadata {
        commitment,
        predecessor: material.predecessor_commitment,
        request: request_bytes.clone(),
        request_hash,
    })?;
    let mut outer_aad = OUTER_AAD_DOMAIN.to_vec();
    outer_aad.extend_from_slice(&header_bytes);
    let sealed_outer = provider
        .crypto()
        .aead_encrypt(
            AeadType::Aes256Gcm,
            material.data_key,
            &outer,
            &outer_nonce,
            &outer_aad,
        )
        .map_err(|_| WitnessError::Crypto)?;
    Ok(PreparedWitnessTransition {
        sealed: SealedWitnessState {
            header,
            inner_nonce,
            outer_nonce,
            sealed_inner,
            sealed_outer,
        },
        exact_result: material.exact_result.to_vec(),
        request,
        request_bytes,
        request_hash,
        has_obsolete_key: material.counter > 1,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct CommittedTransitionInfo {
    pub operation_id: Id,
    pub counter: u64,
    pub generation: u64,
    pub current_key_id: Id,
}

pub(crate) fn inspect_committed_transition(
    committed_record: &[u8],
) -> Result<CommittedTransitionInfo, WitnessError> {
    if committed_record.len() > MAX_COMMITTED_TRANSITION_BYTES {
        return Err(WitnessError::BoundExceeded);
    }
    let mut cursor = Cursor::new(committed_record);
    if cursor.u16()? != COMMITTED_TRANSITION_VERSION {
        return Err(WitnessError::CorruptState);
    }
    let operation_id = cursor.array()?;
    let sealed = SealedWitnessState::decode(cursor.u32_bytes(MAX_INNER_PAYLOAD_BYTES + 2 * 1024)?)?;
    cursor.finish()?;
    Ok(CommittedTransitionInfo {
        operation_id,
        counter: sealed.header.counter,
        generation: sealed.header.generation,
        current_key_id: sealed.header.current_key_id,
    })
}

pub(crate) fn open_committed_transition(
    committed_record: &[u8],
    data_key: &[u8; 32],
    lineage: &WitnessLineage,
    credential: &PairingCredential,
) -> Result<(CommittedTransitionInfo, RecoveredWitnessState), WitnessError> {
    let info = inspect_committed_transition(committed_record)?;
    let mut cursor = Cursor::new(committed_record);
    cursor.u16()?;
    let operation_id: Id = cursor.array()?;
    let sealed = SealedWitnessState::decode(cursor.u32_bytes(MAX_INNER_PAYLOAD_BYTES + 2 * 1024)?)?;
    cursor.finish()?;
    let recovered = sealed.open(data_key, lineage, credential)?;
    if recovered.request.operation_id != operation_id {
        return Err(WitnessError::OperationMismatch);
    }
    Ok((info, recovered))
}

pub(crate) fn recover_committed_transition(
    committed_record: &[u8],
    data_key: &[u8; 32],
    lineage: &WitnessLineage,
    credential: &PairingCredential,
    current_key_active: bool,
    obsolete_key_erased: bool,
) -> Result<PendingWitnessOperation, WitnessError> {
    let (_, recovered) =
        open_committed_transition(committed_record, data_key, lineage, credential)?;
    Ok(PendingWitnessOperation {
        request: recovered.request,
        request_bytes: recovered.request_bytes,
        request_hash: recovered.request_hash,
        exact_result: recovered.exact_result,
        current_key_active,
        quorum_confirmed: false,
        obsolete_key_erased,
        revocation_generation: None,
        certificate_hash: None,
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WitnessHead {
    pub counter: u64,
    pub commitment: [u8; 48],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct WitnessLedgerPosition {
    pub sequence: u64,
    pub revocation_generation: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StoredWitnessOperation {
    pub request_hash: [u8; 48],
    pub result: WitnessResult,
    pub successor: Option<WitnessHead>,
    pub exact_receipt: Vec<u8>,
    pub accepted_at: Option<WitnessLedgerPosition>,
}

impl StoredWitnessOperation {
    fn validate(&self, operation_id: Id) -> Result<(), WitnessError> {
        let accepted_result = matches!(
            self.result,
            WitnessResult::Registered | WitnessResult::Advanced
        );
        let receipt =
            ReplicaReceipt::decode(&self.exact_receipt).map_err(|_| WitnessError::CorruptState)?;
        let receipt_successor = WitnessHead {
            counter: receipt.counter,
            commitment: receipt.commitment,
        };
        if self.request_hash == ZERO_HASH
            || receipt.operation_id != operation_id
            || receipt.request_hash != self.request_hash
            || receipt.result != self.result
            || accepted_result != self.accepted_at.is_some()
            || accepted_result != self.successor.is_some()
            || self
                .successor
                .as_ref()
                .is_some_and(|successor| successor != &receipt_successor)
            || self
                .accepted_at
                .is_some_and(|position| position.sequence == 0)
        {
            return Err(WitnessError::CorruptState);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct WitnessRevocationEvent {
    pub position: WitnessLedgerPosition,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WitnessHistory {
    pub head: WitnessHead,
    pub successors: BTreeMap<(u64, [u8; 48]), WitnessHead>,
    pub operations: BTreeMap<Id, StoredWitnessOperation>,
    pub revocation: Option<WitnessRevocationEvent>,
    pub forked: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WitnessDecision {
    pub result: WitnessResult,
    pub exact_receipt: Option<Vec<u8>>,
}

impl WitnessDecision {
    fn fresh(result: WitnessResult) -> Self {
        Self {
            result,
            exact_receipt: None,
        }
    }

    fn recovered(operation: &StoredWitnessOperation) -> Self {
        Self {
            result: operation.result,
            exact_receipt: Some(operation.exact_receipt.clone()),
        }
    }
}

/// Pure decision logic used by later replica storage implementations. It performs no I/O or signing.
pub(crate) fn evaluate_witness_request(
    history: &WitnessHistory,
    request: &WitnessRequest,
) -> Result<WitnessDecision, WitnessError> {
    if let Some(existing) = history.operations.get(&request.operation_id) {
        existing.validate(request.operation_id)?;
        if existing.request_hash != request.request_hash()? {
            return Ok(WitnessDecision::fresh(WitnessResult::OperationConflict));
        }
        if history.forked {
            return Ok(WitnessDecision::fresh(WitnessResult::Forked));
        }
        if let Some(revocation) = history.revocation {
            if revocation.position.sequence == 0 || revocation.position.revocation_generation == 0 {
                return Err(WitnessError::CorruptState);
            }
            let accepted_before_revocation = existing.accepted_at.is_some_and(|accepted| {
                accepted.sequence < revocation.position.sequence
                    && accepted.revocation_generation < revocation.position.revocation_generation
            });
            return Ok(
                if accepted_before_revocation
                    && matches!(
                        existing.result,
                        WitnessResult::Registered | WitnessResult::Advanced
                    )
                {
                    WitnessDecision::recovered(existing)
                } else {
                    WitnessDecision::fresh(WitnessResult::Revoked)
                },
            );
        }
        return Ok(WitnessDecision::recovered(existing));
    }
    if history.forked {
        return Ok(WitnessDecision::fresh(WitnessResult::Forked));
    }
    if history.revocation.is_some() {
        return Ok(WitnessDecision::fresh(WitnessResult::Revoked));
    }
    match request.kind {
        WitnessRequestKind::Register => {
            return Ok(WitnessDecision::fresh(if history.head.counter == 0 {
                WitnessResult::Registered
            } else {
                WitnessResult::RegistrationConflict
            }));
        }
        WitnessRequestKind::Read => return Ok(WitnessDecision::fresh(WitnessResult::Head)),
        WitnessRequestKind::Advance => {}
    }
    let expected = WitnessHead {
        counter: request
            .expected_counter
            .ok_or(WitnessError::InvalidExpected)?,
        commitment: request
            .expected_commitment
            .ok_or(WitnessError::InvalidExpected)?,
    };
    let proposed = WitnessHead {
        counter: request
            .proposed_counter
            .ok_or(WitnessError::InvalidExpected)?,
        commitment: request
            .proposed_commitment
            .ok_or(WitnessError::InvalidExpected)?,
    };
    if proposed.counter
        != expected
            .counter
            .checked_add(1)
            .ok_or(WitnessError::InvalidExpected)?
    {
        return Ok(WitnessDecision::fresh(WitnessResult::InvalidExpected));
    }
    if expected == history.head {
        return Ok(WitnessDecision::fresh(WitnessResult::Advanced));
    }
    if expected.counter < history.head.counter {
        if let Some(actual) = history
            .successors
            .get(&(expected.counter, expected.commitment))
        {
            return Ok(WitnessDecision::fresh(if actual == &proposed {
                WitnessResult::StaleExpected
            } else if expected.counter + 1 == history.head.counter {
                WitnessResult::ConflictingSuccessor
            } else {
                WitnessResult::HistoricalFork
            }));
        }
        return Ok(WitnessDecision::fresh(WitnessResult::StaleExpected));
    }
    Ok(WitnessDecision::fresh(WitnessResult::InvalidExpected))
}

fn encode_header(header: &WitnessStateHeader) -> Result<Vec<u8>, WitnessError> {
    if header.counter == 0 || header.generation == 0 || header.current_key_id == [0; 16] {
        return Err(WitnessError::CorruptState);
    }
    let mut out = Vec::new();
    out.extend_from_slice(&SEALED_STATE_VERSION.to_be_bytes());
    header.lineage.encode_into(&mut out);
    out.extend_from_slice(&header.counter.to_be_bytes());
    out.extend_from_slice(&header.generation.to_be_bytes());
    out.extend_from_slice(&header.epoch.to_be_bytes());
    out.extend_from_slice(&header.epoch_authenticator);
    out.extend_from_slice(&header.current_key_id);
    Ok(out)
}

fn state_commitment(
    header: &WitnessStateHeader,
    sealed_inner: &[u8],
    predecessor: [u8; 48],
) -> Result<[u8; 48], WitnessError> {
    let sealed_hash = sha384(sealed_inner)?;
    let mut input = STATE_COMMITMENT_DOMAIN.to_vec();
    header.lineage.encode_into(&mut input);
    input.extend_from_slice(&header.counter.to_be_bytes());
    input.extend_from_slice(&header.generation.to_be_bytes());
    input.extend_from_slice(&header.epoch.to_be_bytes());
    input.extend_from_slice(&header.epoch_authenticator);
    input.extend_from_slice(&header.current_key_id);
    input.extend_from_slice(&sealed_hash);
    input.extend_from_slice(&predecessor);
    sha384(&input)
}

fn encode_inner_payload(inner_state: &[u8], exact_result: &[u8]) -> Result<Vec<u8>, WitnessError> {
    if inner_state.len() > MAX_INNER_STATE_BYTES || exact_result.len() > MAX_RESULT_BYTES {
        return Err(WitnessError::BoundExceeded);
    }
    let mut out = Vec::with_capacity(2 + 4 + inner_state.len() + 4 + exact_result.len());
    out.extend_from_slice(&INNER_PAYLOAD_VERSION.to_be_bytes());
    put_u32_bytes(&mut out, inner_state)?;
    put_u32_bytes(&mut out, exact_result)?;
    Ok(out)
}

fn decode_inner_payload(bytes: &[u8]) -> Result<(Vec<u8>, Vec<u8>), WitnessError> {
    if bytes.len() > MAX_INNER_PAYLOAD_BYTES {
        return Err(WitnessError::BoundExceeded);
    }
    let mut cursor = Cursor::new(bytes);
    if cursor.u16()? != INNER_PAYLOAD_VERSION {
        return Err(WitnessError::CorruptState);
    }
    let inner_state = cursor.u32_bytes(MAX_INNER_STATE_BYTES)?.to_vec();
    let exact_result = cursor.u32_bytes_allow_empty(MAX_RESULT_BYTES)?.to_vec();
    cursor.finish()?;
    Ok((inner_state, exact_result))
}

fn encode_outer(value: &OuterMetadata) -> Result<Vec<u8>, WitnessError> {
    let mut out = Vec::new();
    out.extend_from_slice(&SEALED_STATE_VERSION.to_be_bytes());
    out.extend_from_slice(&value.commitment);
    out.extend_from_slice(&value.predecessor);
    put_u16_bytes(&mut out, &value.request)?;
    out.extend_from_slice(&value.request_hash);
    Ok(out)
}

fn decode_outer(bytes: &[u8]) -> Result<OuterMetadata, WitnessError> {
    let mut cursor = Cursor::new(bytes);
    if cursor.u16()? != SEALED_STATE_VERSION {
        return Err(WitnessError::CorruptState);
    }
    let value = OuterMetadata {
        commitment: cursor.array()?,
        predecessor: cursor.array()?,
        request: cursor.u16_bytes(WITNESS_REQUEST_MAX_BYTES)?.to_vec(),
        request_hash: cursor.array()?,
    };
    cursor.finish()?;
    if encode_outer(&value)? != bytes {
        return Err(WitnessError::NonCanonical);
    }
    Ok(value)
}

fn validate_uuid_v7(value: Id) -> Result<(), WitnessError> {
    if value == [0; 16] || value[6] >> 4 != 7 || value[8] >> 6 != 2 {
        return Err(WitnessError::LineageMismatch);
    }
    Ok(())
}

fn sha384(bytes: &[u8]) -> Result<[u8; 48], WitnessError> {
    CoreProvider::new()
        .map_err(|_| WitnessError::Crypto)?
        .crypto()
        .hash(SUITE.hash_algorithm(), bytes)
        .map_err(|_| WitnessError::Crypto)?
        .try_into()
        .map_err(|_| WitnessError::Crypto)
}

fn put_u8_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    out.push(bytes.len() as u8);
    out.extend_from_slice(bytes);
}
fn put_u16_bytes(out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), WitnessError> {
    let length = u16::try_from(bytes.len()).map_err(|_| WitnessError::BoundExceeded)?;
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}
fn put_u32_bytes(out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), WitnessError> {
    let length = u32::try_from(bytes.len()).map_err(|_| WitnessError::BoundExceeded)?;
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}
fn put_optional_u64(out: &mut Vec<u8>, value: Option<u64>) {
    match value {
        Some(value) => {
            out.push(1);
            out.extend_from_slice(&value.to_be_bytes());
        }
        None => out.push(0),
    }
}
fn put_optional_array<const N: usize>(out: &mut Vec<u8>, value: Option<[u8; N]>) {
    match value {
        Some(value) => {
            out.push(1);
            out.extend_from_slice(&value);
        }
        None => out.push(0),
    }
}
fn put_optional_u16_bytes(out: &mut Vec<u8>, value: Option<&[u8]>) -> Result<(), WitnessError> {
    match value {
        Some(value) => {
            out.push(1);
            put_u16_bytes(out, value)?;
        }
        None => out.push(0),
    }
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
    fn take(&mut self, length: usize) -> Result<&'a [u8], WitnessError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(WitnessError::Malformed)?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or(WitnessError::Malformed)?;
        self.offset = end;
        Ok(value)
    }
    fn u8(&mut self) -> Result<u8, WitnessError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, WitnessError> {
        Ok(u16::from_be_bytes(self.array()?))
    }
    fn u32(&mut self) -> Result<u32, WitnessError> {
        Ok(u32::from_be_bytes(self.array()?))
    }
    fn u64(&mut self) -> Result<u64, WitnessError> {
        Ok(u64::from_be_bytes(self.array()?))
    }
    fn array<const N: usize>(&mut self) -> Result<[u8; N], WitnessError> {
        self.take(N)?
            .try_into()
            .map_err(|_| WitnessError::Malformed)
    }
    fn u8_bytes(&mut self, max: usize) -> Result<&'a [u8], WitnessError> {
        let length = self.u8()? as usize;
        if length == 0 || length > max {
            return Err(WitnessError::Malformed);
        }
        self.take(length)
    }
    fn u16_bytes(&mut self, max: usize) -> Result<&'a [u8], WitnessError> {
        let length = self.u16()? as usize;
        if length == 0 || length > max {
            return Err(WitnessError::BoundExceeded);
        }
        self.take(length)
    }
    fn u32_bytes(&mut self, max: usize) -> Result<&'a [u8], WitnessError> {
        let value = self.u32_bytes_allow_empty(max)?;
        if value.is_empty() {
            return Err(WitnessError::Malformed);
        }
        Ok(value)
    }
    fn u32_bytes_allow_empty(&mut self, max: usize) -> Result<&'a [u8], WitnessError> {
        let length = self.u32()? as usize;
        if length > max {
            return Err(WitnessError::BoundExceeded);
        }
        self.take(length)
    }
    fn optional_u64(&mut self) -> Result<Option<u64>, WitnessError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(self.u64()?)),
            _ => Err(WitnessError::Malformed),
        }
    }
    fn optional_array<const N: usize>(&mut self) -> Result<Option<[u8; N]>, WitnessError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(self.array()?)),
            _ => Err(WitnessError::Malformed),
        }
    }
    fn optional_u16_bytes(&mut self, max: usize) -> Result<Option<Vec<u8>>, WitnessError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(self.u16_bytes(max)?.to_vec())),
            _ => Err(WitnessError::Malformed),
        }
    }
    fn finish(self) -> Result<(), WitnessError> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err(WitnessError::Malformed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use redb::{Database, Durability, ReadableDatabase, TableDefinition};
    use std::{
        fs,
        path::Path,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    struct Fixture {
        lineage: WitnessLineage,
        credential: PairingCredential,
        endpoint_signer: SignatureKeyPair,
        replica_signers: [SignatureKeyPair; 3],
        trust: ReplicaTrustSet,
        request: WitnessRequest,
    }

    fn id(value: u8) -> Id {
        [value; 16]
    }

    fn uuid(value: u8) -> Id {
        let mut result = id(value);
        result[6] = 0x70 | (value & 0x0f);
        result[8] = 0x80 | (value & 0x3f);
        result
    }

    fn decode_committed_record(bytes: &[u8]) -> (Id, SealedWitnessState) {
        let mut cursor = Cursor::new(bytes);
        assert_eq!(cursor.u16().unwrap(), COMMITTED_TRANSITION_VERSION);
        let operation_id = cursor.array().unwrap();
        let sealed = SealedWitnessState::decode(
            cursor
                .u32_bytes(MAX_INNER_PAYLOAD_BYTES + 2 * 1024)
                .unwrap(),
        )
        .unwrap();
        cursor.finish().unwrap();
        (operation_id, sealed)
    }

    fn encode_committed_record(operation_id: Id, sealed: &SealedWitnessState) -> Vec<u8> {
        let sealed = sealed.encode().unwrap();
        let mut out = COMMITTED_TRANSITION_VERSION.to_be_bytes().to_vec();
        out.extend_from_slice(&operation_id);
        put_u32_bytes(&mut out, &sealed).unwrap();
        out
    }

    fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
        !needle.is_empty()
            && haystack
                .windows(needle.len())
                .any(|window| window == needle)
    }

    fn fixture(counter: u64) -> Fixture {
        let endpoint_signer = SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap();
        let identity = Identity::device(id(1), uuid(2), uuid(3)).unwrap();
        let lineage = WitnessLineage::from_identity(&identity, uuid(4)).unwrap();
        let credential = PairingCredential::new(identity, &endpoint_signer).unwrap();
        let request = WitnessRequest::new_signed(WitnessRequestSigning {
            kind: if counter == 1 {
                WitnessRequestKind::Register
            } else {
                WitnessRequestKind::Advance
            },
            lineage: lineage.clone(),
            operation_id: id(5),
            expected: (counter > 1).then_some((counter - 1, [6; 48])),
            proposed: Some((counter, [7; 48])),
            previous_certificate_hash: if counter > 1 { [8; 48] } else { ZERO_HASH },
            credential: &credential,
            signer: &endpoint_signer,
            nonce: [9; 32],
        })
        .unwrap();
        let replica_signers =
            std::array::from_fn(|_| SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap());
        let trust = ReplicaTrustSet::new(
            (0..WITNESS_REPLICA_COUNT)
                .map(|index| {
                    ReplicaTrust::new(
                        id(20 + index as u8),
                        vec![
                            ReplicaKey::new(
                                id(30 + index as u8),
                                replica_signers[index].public().try_into().unwrap(),
                            )
                            .unwrap(),
                        ],
                    )
                    .unwrap()
                })
                .collect(),
        )
        .unwrap();
        Fixture {
            lineage,
            credential,
            endpoint_signer,
            replica_signers,
            trust,
            request,
        }
    }

    fn receipt(fixture: &Fixture, index: usize, result: WitnessResult) -> ReplicaReceipt {
        let mut value = ReplicaReceipt {
            result,
            replica_id: fixture.trust.replicas[index].replica_id,
            witness_key_id: fixture.trust.replicas[index].keys[0].key_id,
            lineage_hash: fixture.lineage.hash().unwrap(),
            counter: fixture.request.proposed_counter.unwrap_or(2),
            commitment: fixture.request.proposed_commitment.unwrap_or([7; 48]),
            predecessor_commitment: fixture.request.expected_commitment.unwrap_or(ZERO_HASH),
            operation_id: fixture.request.operation_id,
            request_hash: fixture.request.request_hash().unwrap(),
            ledger_sequence: 100 + index as u64,
            issued_at_ms: 1_000 + index as u64,
            revocation_generation: 4,
            signature: [0; 64],
        };
        value.signature = fixture.replica_signers[index]
            .sign(&value.signature_input())
            .unwrap()
            .try_into()
            .unwrap();
        value
    }

    fn certificate(fixture: &Fixture, result: WitnessResult) -> QuorumCertificate {
        QuorumCertificate {
            receipts: std::array::from_fn(|index| receipt(fixture, index, result)),
        }
    }

    fn pending_endpoint(fixture: &Fixture) -> EndpointWitnessState {
        let mut state = EndpointWitnessState::new();
        state.head_counter = 1;
        state.head_commitment = [6; 48];
        state.previous_certificate_hash = [8; 48];
        assert_eq!(
            state.reconcile(true, true, quorum_head(1, [6; 48])),
            EndpointReconciliation::Ready
        );
        let prepared = state
            .prepare(TransitionMaterial {
                lineage: fixture.lineage.clone(),
                counter: 2,
                generation: 2,
                epoch: 7,
                epoch_authenticator: [11; 48],
                current_key_id: id(12),
                predecessor_commitment: [0; 48],
                previous_certificate_hash: [0; 48],
                operation_id: id(15),
                inner_state: b"state",
                exact_result: b"result",
                data_key: &[16; 32],
                credential: &fixture.credential,
                signer: &fixture.endpoint_signer,
            })
            .unwrap();
        state.local_commit_complete(prepared).unwrap();
        state
    }

    fn quorum_head(counter: u64, commitment: [u8; 48]) -> FreshQuorumState {
        FreshQuorumState::Head(FreshQuorumHead {
            head: WitnessHead {
                counter,
                commitment,
            },
            revocation: None,
            fork: None,
            accepted_operation: None,
        })
    }

    #[test]
    fn canonical_requests_round_trip_and_reject_malformed_or_oversized_input() {
        let register_fixture = fixture(1);
        let fixture = fixture(2);
        let read = WitnessRequest::new_read(
            fixture.lineage.clone(),
            id(41),
            [42; 48],
            &fixture.credential,
            &fixture.endpoint_signer,
            [43; 32],
        )
        .unwrap();
        for (request, credential) in [
            (&register_fixture.request, &register_fixture.credential),
            (&read, &fixture.credential),
            (&fixture.request, &fixture.credential),
        ] {
            let encoded = request.encode().unwrap();
            assert!(encoded.len() <= WITNESS_REQUEST_MAX_BYTES);
            assert_eq!(WitnessRequest::decode(&encoded).unwrap(), *request);
            request.verify(request.lineage(), credential).unwrap();
        }
        let bytes = fixture.request.encode().unwrap();
        assert_eq!(
            WitnessRequest::decode(&bytes[..bytes.len() - 1]),
            Err(WitnessError::Malformed)
        );
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert_eq!(
            WitnessRequest::decode(&trailing),
            Err(WitnessError::Malformed)
        );
        assert_eq!(
            WitnessRequest::decode(&vec![0; WITNESS_REQUEST_MAX_BYTES + 1]),
            Err(WitnessError::BoundExceeded)
        );
        let mut invalid = bytes;
        invalid[0] ^= 1;
        assert_eq!(
            WitnessRequest::decode(&invalid),
            Err(WitnessError::Malformed)
        );
    }

    #[test]
    fn receipts_and_certificates_enforce_bounds_unanimity_and_distinct_signers() {
        let mut read_fixture = fixture(2);
        let fixture = fixture(2);
        let advance_certificate = certificate(&fixture, WitnessResult::Advanced);
        let bytes = advance_certificate.encode().unwrap();
        assert!(
            advance_certificate
                .receipts()
                .iter()
                .all(|value| value.encode().unwrap().len() <= WITNESS_RECEIPT_MAX_BYTES)
        );
        let receipt_bytes = advance_certificate.receipts()[0].encode().unwrap();
        assert_eq!(
            ReplicaReceipt::decode(&receipt_bytes[..receipt_bytes.len() - 1]),
            Err(WitnessError::Malformed)
        );
        let mut trailing_receipt = receipt_bytes;
        trailing_receipt.push(0);
        assert_eq!(
            ReplicaReceipt::decode(&trailing_receipt),
            Err(WitnessError::Malformed)
        );
        assert_eq!(
            ReplicaReceipt::decode(&vec![0; WITNESS_RECEIPT_MAX_BYTES + 1]),
            Err(WitnessError::BoundExceeded)
        );
        assert!(bytes.len() <= WITNESS_CERTIFICATE_MAX_BYTES);
        assert_eq!(
            QuorumCertificate::decode(&bytes)
                .unwrap()
                .verify(&fixture.request, &fixture.trust),
            Ok(WitnessResult::Advanced)
        );
        read_fixture.request = WitnessRequest::new_read(
            read_fixture.lineage.clone(),
            id(44),
            [45; 48],
            &read_fixture.credential,
            &read_fixture.endpoint_signer,
            [46; 32],
        )
        .unwrap();
        assert_eq!(
            certificate(&read_fixture, WitnessResult::Head)
                .verify(&read_fixture.request, &read_fixture.trust),
            Ok(WitnessResult::Head)
        );
        let mut two = bytes.clone();
        two[2] = 2;
        two.truncate(3 + 2 * (2 + advance_certificate.receipts[0].encode().unwrap().len()));
        assert_eq!(
            QuorumCertificate::decode(&two),
            Err(WitnessError::InvalidQuorum)
        );
        let duplicate = QuorumCertificate {
            receipts: [
                receipt(&fixture, 0, WitnessResult::Advanced),
                receipt(&fixture, 0, WitnessResult::Advanced),
                receipt(&fixture, 2, WitnessResult::Advanced),
            ],
        };
        assert_eq!(duplicate.encode(), Err(WitnessError::DuplicateReplica));
        assert_eq!(
            QuorumCertificate::decode(&vec![0; WITNESS_CERTIFICATE_MAX_BYTES + 1]),
            Err(WitnessError::BoundExceeded)
        );
    }

    #[test]
    fn pinned_keysets_support_bounded_rotation_and_reject_ambiguous_keys() {
        let fixture = fixture(2);
        let rotation_signer = SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap();
        let mut replicas = fixture.trust.replicas().to_vec();
        replicas[0] = ReplicaTrust::new(
            replicas[0].replica_id(),
            vec![
                replicas[0].keys()[0].clone(),
                ReplicaKey::new(id(99), rotation_signer.public().try_into().unwrap()).unwrap(),
            ],
        )
        .unwrap();
        let rotating_trust = ReplicaTrustSet::new(replicas).unwrap();
        let mut rotating = certificate(&fixture, WitnessResult::Advanced);
        rotating.receipts[0].witness_key_id = id(99);
        rotating.receipts[0].signature = rotation_signer
            .sign(&rotating.receipts[0].signature_input())
            .unwrap()
            .try_into()
            .unwrap();
        assert_eq!(
            rotating.verify(&fixture.request, &rotating_trust),
            Ok(WitnessResult::Advanced)
        );

        let mut assigned_elsewhere = certificate(&fixture, WitnessResult::Advanced);
        assigned_elsewhere.receipts[0].witness_key_id =
            fixture.trust.replicas()[1].keys()[0].key_id();
        assigned_elsewhere.receipts[0].signature = fixture.replica_signers[1]
            .sign(&assigned_elsewhere.receipts[0].signature_input())
            .unwrap()
            .try_into()
            .unwrap();
        assert_eq!(
            assigned_elsewhere.verify(&fixture.request, &fixture.trust),
            Err(WitnessError::UnpinnedKey)
        );
        let mut unpinned = certificate(&fixture, WitnessResult::Advanced);
        unpinned.receipts[0].witness_key_id = id(98);
        assert_eq!(
            unpinned.verify(&fixture.request, &fixture.trust),
            Err(WitnessError::UnpinnedKey)
        );

        let first = fixture.trust.replicas()[0].clone();
        assert_eq!(
            ReplicaTrustSet::new(vec![
                first.clone(),
                first,
                fixture.trust.replicas()[2].clone(),
            ]),
            Err(WitnessError::InvalidTrustSet)
        );
        assert_eq!(
            ReplicaTrustSet::new(fixture.trust.replicas()[..2].to_vec()),
            Err(WitnessError::InvalidTrustSet)
        );
        let duplicate_key_id = fixture.trust.replicas()[0].keys()[0].key_id();
        let ambiguous = ReplicaTrust::new(
            id(77),
            vec![
                ReplicaKey::new(
                    duplicate_key_id,
                    fixture.replica_signers[2].public().try_into().unwrap(),
                )
                .unwrap(),
            ],
        )
        .unwrap();
        assert_eq!(
            ReplicaTrustSet::new(vec![
                fixture.trust.replicas()[0].clone(),
                fixture.trust.replicas()[1].clone(),
                ambiguous,
            ]),
            Err(WitnessError::InvalidTrustSet)
        );
        let ambiguous_public_key = ReplicaTrust::new(
            id(78),
            vec![
                ReplicaKey::new(
                    id(120),
                    fixture.trust.replicas()[0].keys()[0].verification_key(),
                )
                .unwrap(),
            ],
        )
        .unwrap();
        assert_eq!(
            ReplicaTrustSet::new(vec![
                fixture.trust.replicas()[0].clone(),
                fixture.trust.replicas()[1].clone(),
                ambiguous_public_key,
            ]),
            Err(WitnessError::InvalidTrustSet)
        );
        let too_many = (0..=WITNESS_MAX_KEYS_PER_REPLICA)
            .map(|index| ReplicaKey::new(id(100 + index as u8), [index as u8 + 1; 32]).unwrap())
            .collect();
        assert_eq!(
            ReplicaTrust::new(id(88), too_many),
            Err(WitnessError::InvalidTrustSet)
        );
    }

    #[test]
    fn quorum_rejects_invalid_signatures_and_every_mixed_tuple_field() {
        let fixture = fixture(2);
        let base = certificate(&fixture, WitnessResult::Advanced);
        let mut cases: Vec<(QuorumCertificate, WitnessError)> = Vec::new();
        let mut value = base.clone();
        value.receipts[1].signature[0] ^= 1;
        cases.push((value, WitnessError::InvalidSignature));
        macro_rules! signed_case {
            ($field:ident, $value:expr, $error:expr) => {{
                let mut value = base.clone();
                value.receipts[1].$field = $value;
                value.receipts[1].signature = fixture.replica_signers[1]
                    .sign(&value.receipts[1].signature_input())
                    .unwrap()
                    .try_into()
                    .unwrap();
                cases.push((value, $error));
            }};
        }
        signed_case!(lineage_hash, [1; 48], WitnessError::LineageMismatch);
        signed_case!(counter, 99, WitnessError::CounterMismatch);
        signed_case!(commitment, [2; 48], WitnessError::CommitmentMismatch);
        signed_case!(
            predecessor_commitment,
            [3; 48],
            WitnessError::PredecessorMismatch
        );
        signed_case!(operation_id, id(99), WitnessError::OperationMismatch);
        signed_case!(request_hash, [4; 48], WitnessError::RequestHashMismatch);
        signed_case!(revocation_generation, 99, WitnessError::RevocationMismatch);
        signed_case!(result, WitnessResult::Revoked, WitnessError::MixedReceipts);
        for (certificate, expected) in cases {
            assert_eq!(
                certificate.verify(&fixture.request, &fixture.trust),
                Err(expected)
            );
        }
    }

    #[test]
    fn request_verification_rejects_profile_lineage_role_counter_commitment_and_signature_changes()
    {
        let fixture = fixture(2);
        let mut wrong = fixture.request.clone();
        wrong.lineage.account_id[0] ^= 1;
        assert_eq!(
            wrong.verify(&fixture.lineage, &fixture.credential),
            Err(WitnessError::LineageMismatch)
        );
        let mut wrong = fixture.request.clone();
        wrong.lineage.role = Role::Daemon;
        assert_eq!(
            wrong.verify(&fixture.lineage, &fixture.credential),
            Err(WitnessError::RoleMismatch)
        );
        let mut wrong = fixture.request.clone();
        wrong.signature[0] ^= 1;
        assert_eq!(
            wrong.verify(&fixture.lineage, &fixture.credential),
            Err(WitnessError::InvalidSignature)
        );
        let mut bytes = fixture.request.encode().unwrap();
        bytes[4] ^= 1;
        assert_eq!(
            WitnessRequest::decode(&bytes),
            Err(WitnessError::ProfileMismatch)
        );
        let mut wrong = fixture.request.clone();
        wrong.proposed_counter = Some(9);
        assert_eq!(
            wrong.verify(&fixture.lineage, &fixture.credential),
            Err(WitnessError::InvalidSignature)
        );
        let mut wrong = fixture.request.clone();
        wrong.proposed_commitment = Some([9; 48]);
        assert_eq!(
            wrong.verify(&fixture.lineage, &fixture.credential),
            Err(WitnessError::InvalidSignature)
        );
    }

    #[test]
    fn sealed_state_authenticates_exact_result_and_rejects_envelope_corruption_after_restart() {
        let fixture = fixture(2);
        let prepared = prepare_transition(TransitionMaterial {
            lineage: fixture.lineage.clone(),
            counter: 2,
            generation: 2,
            epoch: 7,
            epoch_authenticator: [11; 48],
            current_key_id: id(12),
            predecessor_commitment: [13; 48],
            previous_certificate_hash: [14; 48],
            operation_id: id(15),
            inner_state: b"exact inner state",
            exact_result: b"exact ciphertext",
            data_key: &[16; 32],
            credential: &fixture.credential,
            signer: &fixture.endpoint_signer,
        })
        .unwrap();
        assert!(!prepared.request_bytes.is_empty());
        let committed_record = prepared.committed_record().unwrap();
        assert!(!contains_bytes(&committed_record, b"exact inner state"));
        assert!(!contains_bytes(&committed_record, b"exact ciphertext"));
        let exact_request = prepared.request_bytes.clone();
        let mut pending = prepared.local_commit_complete_for_test();
        assert_eq!(pending.witness_request(), exact_request);
        assert_eq!(pending.committed_result(), Err(WitnessError::OutputBlocked));
        let mut recovered = recover_committed_transition(
            &committed_record,
            &[16; 32],
            &fixture.lineage,
            &fixture.credential,
            true,
            false,
        )
        .unwrap();
        assert_eq!(recovered.witness_request(), exact_request);
        let (operation_id, mut result_corruption) = decode_committed_record(&committed_record);
        let result_offset = 2 + 4 + b"exact inner state".len() + 4;
        assert!(result_offset < result_corruption.sealed_inner.len() - 16);
        result_corruption.sealed_inner[result_offset] ^= 1;
        let result_corruption = encode_committed_record(operation_id, &result_corruption);
        assert!(matches!(
            recover_committed_transition(
                &result_corruption,
                &[16; 32],
                &fixture.lineage,
                &fixture.credential,
                true,
                false,
            ),
            Err(WitnessError::CorruptState)
        ));
        let recovered_request = WitnessRequest::decode(recovered.witness_request()).unwrap();
        let recovered_fixture = Fixture {
            request: recovered_request,
            ..fixture
        };
        let certificate = certificate(&recovered_fixture, WitnessResult::Advanced)
            .encode()
            .unwrap();
        recovered
            .confirm_quorum(&certificate, &recovered_fixture.trust)
            .unwrap();
        assert_eq!(
            recovered.committed_result(),
            Err(WitnessError::OutputBlocked)
        );
        recovered.obsolete_key_erased().unwrap();
        assert_eq!(recovered.committed_result().unwrap(), b"exact ciphertext");
        let mut recovered_after_erasure = recover_committed_transition(
            &committed_record,
            &[16; 32],
            &recovered_fixture.lineage,
            &recovered_fixture.credential,
            true,
            true,
        )
        .unwrap();
        assert_eq!(
            recovered_after_erasure.committed_result(),
            Err(WitnessError::OutputBlocked)
        );
        recovered_after_erasure
            .confirm_quorum(&certificate, &recovered_fixture.trust)
            .unwrap();
        assert_eq!(
            recovered_after_erasure.committed_result().unwrap(),
            b"exact ciphertext"
        );
        let mut wrong_operation = committed_record.clone();
        wrong_operation[2] ^= 1;
        assert!(matches!(
            recover_committed_transition(
                &wrong_operation,
                &[16; 32],
                &recovered_fixture.lineage,
                &recovered_fixture.credential,
                true,
                false,
            ),
            Err(WitnessError::OperationMismatch)
        ));
        let mut record_cursor = Cursor::new(&committed_record);
        assert_eq!(record_cursor.u16().unwrap(), COMMITTED_TRANSITION_VERSION);
        let _: Id = record_cursor.array().unwrap();
        let mut corrupt_inner = SealedWitnessState::decode(
            record_cursor
                .u32_bytes(MAX_INNER_PAYLOAD_BYTES + 2 * 1024)
                .unwrap(),
        )
        .unwrap();
        corrupt_inner.sealed_inner[0] ^= 1;
        assert_eq!(
            corrupt_inner.open(
                &[16; 32],
                &recovered_fixture.lineage,
                &recovered_fixture.credential
            ),
            Err(WitnessError::CorruptState)
        );
        let mut record_cursor = Cursor::new(&committed_record);
        record_cursor.u16().unwrap();
        let _: Id = record_cursor.array().unwrap();
        let mut corrupt_outer = SealedWitnessState::decode(
            record_cursor
                .u32_bytes(MAX_INNER_PAYLOAD_BYTES + 2 * 1024)
                .unwrap(),
        )
        .unwrap();
        corrupt_outer.sealed_outer[0] ^= 1;
        assert_eq!(
            corrupt_outer.open(
                &[16; 32],
                &recovered_fixture.lineage,
                &recovered_fixture.credential
            ),
            Err(WitnessError::CorruptState)
        );
        let mut record_cursor = Cursor::new(&committed_record);
        record_cursor.u16().unwrap();
        let _: Id = record_cursor.array().unwrap();
        let mut swapped = SealedWitnessState::decode(
            record_cursor
                .u32_bytes(MAX_INNER_PAYLOAD_BYTES + 2 * 1024)
                .unwrap(),
        )
        .unwrap();
        std::mem::swap(&mut swapped.sealed_inner, &mut swapped.sealed_outer);
        assert_eq!(
            swapped.open(
                &[16; 32],
                &recovered_fixture.lineage,
                &recovered_fixture.credential
            ),
            Err(WitnessError::CorruptState)
        );
        pending.current_key_activated();
        assert_eq!(pending.committed_result(), Err(WitnessError::OutputBlocked));
    }

    #[test]
    fn committed_transition_is_atomic_in_redb_and_recovers_after_reopen() {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        const TRANSITIONS: TableDefinition<u8, &[u8]> =
            TableDefinition::new("witness_transitions_v1");
        let fixture = fixture(2);
        let prepared = prepare_transition(TransitionMaterial {
            lineage: fixture.lineage.clone(),
            counter: 2,
            generation: 2,
            epoch: 7,
            epoch_authenticator: [11; 48],
            current_key_id: id(12),
            predecessor_commitment: [6; 48],
            previous_certificate_hash: [8; 48],
            operation_id: id(15),
            inner_state: b"durable state",
            exact_result: b"durable result",
            data_key: &[16; 32],
            credential: &fixture.credential,
            signer: &fixture.endpoint_signer,
        })
        .unwrap();
        let exact_request = prepared.request_bytes.clone();
        let record = prepared.committed_record().unwrap();
        assert!(!contains_bytes(&record, b"durable state"));
        assert!(!contains_bytes(&record, b"durable result"));
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "axl-witness-{}-{nonce}-{}.redb",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let database = Database::create(&path).unwrap();
        let mut schema = database.begin_write().unwrap();
        schema.set_durability(Durability::Immediate).unwrap();
        schema.set_two_phase_commit(true);
        schema.open_table(TRANSITIONS).unwrap();
        schema.commit().unwrap();
        let mut aborted = database.begin_write().unwrap();
        aborted.set_durability(Durability::Immediate).unwrap();
        aborted.set_two_phase_commit(true);
        aborted
            .open_table(TRANSITIONS)
            .unwrap()
            .insert(1, record.as_slice())
            .unwrap();
        aborted.abort().unwrap();
        let read = database.begin_read().unwrap();
        assert!(
            read.open_table(TRANSITIONS)
                .unwrap()
                .get(1)
                .unwrap()
                .is_none()
        );
        drop(read);
        let mut write = database.begin_write().unwrap();
        write.set_durability(Durability::Immediate).unwrap();
        write.set_two_phase_commit(true);
        write
            .open_table(TRANSITIONS)
            .unwrap()
            .insert(1, record.as_slice())
            .unwrap();
        write.commit().unwrap();
        drop(database);

        let reopened = Database::open(&path).unwrap();
        let read = reopened.begin_read().unwrap();
        let table = read.open_table(TRANSITIONS).unwrap();
        let durable = table.get(1).unwrap().unwrap().value().to_vec();
        drop(table);
        drop(read);
        drop(reopened);
        let recovered = recover_committed_transition(
            &durable,
            &[16; 32],
            &fixture.lineage,
            &fixture.credential,
            true,
            false,
        )
        .unwrap();
        assert_eq!(recovered.witness_request(), exact_request);
        assert_eq!(recovered.exact_result, b"durable result");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn output_requires_quorum_key_activation_and_obsolete_key_erasure() {
        let fixture = fixture(2);
        let prepared = prepare_transition(TransitionMaterial {
            lineage: fixture.lineage.clone(),
            counter: 2,
            generation: 2,
            epoch: 7,
            epoch_authenticator: [11; 48],
            current_key_id: id(12),
            predecessor_commitment: [6; 48],
            previous_certificate_hash: [8; 48],
            operation_id: fixture.request.operation_id,
            inner_state: b"state",
            exact_result: b"exact output",
            data_key: &[16; 32],
            credential: &fixture.credential,
            signer: &fixture.endpoint_signer,
        })
        .unwrap();
        let request = WitnessRequest::decode(&prepared.request_bytes).unwrap();
        let generated_fixture = Fixture { request, ..fixture };
        let certificate = certificate(&generated_fixture, WitnessResult::Advanced)
            .encode()
            .unwrap();
        let mut pending = prepared.local_commit_complete_for_test();
        assert_eq!(pending.committed_result(), Err(WitnessError::OutputBlocked));
        pending
            .confirm_quorum(&certificate, &generated_fixture.trust)
            .unwrap();
        assert_eq!(pending.committed_result(), Err(WitnessError::OutputBlocked));
        pending.current_key_activated();
        assert_eq!(pending.committed_result(), Err(WitnessError::OutputBlocked));
        pending.obsolete_key_erased().unwrap();
        assert_eq!(pending.committed_result().unwrap(), b"exact output");
    }

    #[test]
    fn fresh_reconciliation_authorizes_exactly_one_mutation() {
        let fixture = fixture(2);
        let mut state = EndpointWitnessState::new();
        state.head_counter = 1;
        state.head_commitment = [6; 48];
        state.previous_certificate_hash = [8; 48];
        let material = |operation_id| TransitionMaterial {
            lineage: fixture.lineage.clone(),
            counter: 2,
            generation: 2,
            epoch: 7,
            epoch_authenticator: [11; 48],
            current_key_id: id(12),
            predecessor_commitment: [99; 48],
            previous_certificate_hash: [99; 48],
            operation_id,
            inner_state: b"state",
            exact_result: b"result",
            data_key: &[16; 32],
            credential: &fixture.credential,
            signer: &fixture.endpoint_signer,
        };
        assert!(matches!(
            state.prepare(material(id(15))),
            Err(WitnessError::FreshWitnessRequired)
        ));
        assert_eq!(
            state.reconcile(true, true, FreshQuorumState::Unavailable),
            EndpointReconciliation::WitnessUnavailable
        );
        assert!(matches!(
            state.prepare(material(id(15))),
            Err(WitnessError::FreshWitnessRequired)
        ));
        assert_eq!(
            state.reconcile(true, true, quorum_head(1, [6; 48])),
            EndpointReconciliation::Ready
        );
        let prepared = state.prepare(material(id(15))).unwrap();
        assert!(matches!(
            state.prepare(material(id(16))),
            Err(WitnessError::FreshWitnessRequired)
        ));
        state.local_commit_complete(prepared).unwrap();
        assert!(matches!(
            state.prepare(material(id(16))),
            Err(WitnessError::PendingOperation)
        ));
        assert_eq!(
            state.pending().unwrap().committed_result(),
            Err(WitnessError::OutputBlocked)
        );
        let request = state.pending().unwrap().request.clone();
        let certificate_fixture = Fixture { request, ..fixture };
        let certificate = certificate(&certificate_fixture, WitnessResult::Advanced)
            .encode()
            .unwrap();
        let pending = state.pending_mut().unwrap();
        pending.current_key_activated();
        pending
            .confirm_quorum(&certificate, &certificate_fixture.trust)
            .unwrap();
        pending.obsolete_key_erased().unwrap();
        assert_eq!(state.release_and_advance().unwrap(), b"result");
        assert_eq!(state.head_counter, 2);
        assert!(state.pending().is_err());
        assert!(matches!(
            state.prepare(TransitionMaterial {
                lineage: certificate_fixture.lineage.clone(),
                counter: 3,
                generation: 3,
                epoch: 7,
                epoch_authenticator: [11; 48],
                current_key_id: id(13),
                predecessor_commitment: [0; 48],
                previous_certificate_hash: [0; 48],
                operation_id: id(17),
                inner_state: b"next",
                exact_result: b"next",
                data_key: &[17; 32],
                credential: &certificate_fixture.credential,
                signer: &certificate_fixture.endpoint_signer,
            }),
            Err(WitnessError::FreshWitnessRequired)
        ));
    }

    #[test]
    fn initial_registration_requires_fresh_absence_and_missing_local_pending_quarantines() {
        let fixture = fixture(1);
        let material = || TransitionMaterial {
            lineage: fixture.lineage.clone(),
            counter: 1,
            generation: 1,
            epoch: 0,
            epoch_authenticator: [0; 48],
            current_key_id: id(12),
            predecessor_commitment: [99; 48],
            previous_certificate_hash: [99; 48],
            operation_id: id(15),
            inner_state: b"initial state",
            exact_result: b"initial result",
            data_key: &[16; 32],
            credential: &fixture.credential,
            signer: &fixture.endpoint_signer,
        };
        let mut state = EndpointWitnessState::new();
        assert!(matches!(
            state.prepare(material()),
            Err(WitnessError::FreshWitnessRequired)
        ));
        assert_eq!(
            state.reconcile(false, false, FreshQuorumState::Unavailable),
            EndpointReconciliation::WitnessUnavailable
        );
        assert!(matches!(
            state.prepare(material()),
            Err(WitnessError::FreshWitnessRequired)
        ));
        assert_eq!(
            state.reconcile(false, false, FreshQuorumState::Absent),
            EndpointReconciliation::Ready
        );
        let prepared = state.prepare(material()).unwrap();
        assert_eq!(
            prepared.prepared.request.kind(),
            WitnessRequestKind::Register
        );
        assert!(matches!(
            state.prepare(material()),
            Err(WitnessError::FreshWitnessRequired)
        ));
        state.local_commit_complete(prepared).unwrap();
        assert_eq!(
            state.reconcile(false, false, FreshQuorumState::Absent),
            EndpointReconciliation::Quarantined(EndpointQuarantineReason::PendingWithoutLocalState)
        );
        assert_eq!(state.release_and_advance(), Err(WitnessError::Quarantined));
        assert_eq!(
            state.reconcile(true, true, quorum_head(1, [7; 48])),
            EndpointReconciliation::Quarantined(EndpointQuarantineReason::PendingWithoutLocalState)
        );
    }

    #[test]
    fn endpoint_reconciliation_covers_clean_pending_and_acknowledgement_loss_states() {
        let fixture = fixture(2);
        let mut ready = EndpointWitnessState::new();
        ready.head_counter = 1;
        ready.head_commitment = [6; 48];
        assert_eq!(
            ready.reconcile(true, true, quorum_head(1, [6; 48])),
            EndpointReconciliation::Ready
        );

        let mut pending = pending_endpoint(&fixture);
        assert_eq!(
            pending.reconcile(true, true, quorum_head(1, [6; 48])),
            EndpointReconciliation::ResendPending
        );
        assert!(matches!(
            pending.prepare(TransitionMaterial {
                lineage: fixture.lineage.clone(),
                counter: 2,
                generation: 2,
                epoch: 7,
                epoch_authenticator: [11; 48],
                current_key_id: id(12),
                predecessor_commitment: [0; 48],
                previous_certificate_hash: [0; 48],
                operation_id: id(16),
                inner_state: b"later",
                exact_result: b"later",
                data_key: &[16; 32],
                credential: &fixture.credential,
                signer: &fixture.endpoint_signer,
            }),
            Err(WitnessError::PendingOperation)
        ));
        assert_eq!(
            pending.pending().unwrap().committed_result(),
            Err(WitnessError::OutputBlocked)
        );
        let proposed = pending
            .pending()
            .unwrap()
            .request
            .proposed_commitment
            .unwrap();
        assert_eq!(
            pending.reconcile(true, true, quorum_head(2, proposed)),
            EndpointReconciliation::RecoverAccepted
        );
        assert!(matches!(
            pending.prepare(TransitionMaterial {
                lineage: fixture.lineage.clone(),
                counter: 3,
                generation: 3,
                epoch: 7,
                epoch_authenticator: [11; 48],
                current_key_id: id(13),
                predecessor_commitment: [0; 48],
                previous_certificate_hash: [0; 48],
                operation_id: id(17),
                inner_state: b"later",
                exact_result: b"later",
                data_key: &[17; 32],
                credential: &fixture.credential,
                signer: &fixture.endpoint_signer,
            }),
            Err(WitnessError::PendingOperation)
        ));
    }

    #[test]
    fn endpoint_reconciliation_quarantines_every_stale_or_inconsistent_head() {
        let mut cases = vec![
            (
                true,
                true,
                EndpointWitnessState {
                    head_counter: 1,
                    head_commitment: [6; 48],
                    previous_certificate_hash: [8; 48],
                    pending: None,
                    terminal: None,
                    mutation_authorization: None,
                },
                quorum_head(2, [7; 48]),
                EndpointQuarantineReason::StateLoss,
            ),
            (
                false,
                true,
                EndpointWitnessState {
                    head_counter: 1,
                    head_commitment: [6; 48],
                    previous_certificate_hash: [8; 48],
                    pending: None,
                    terminal: None,
                    mutation_authorization: None,
                },
                quorum_head(2, [7; 48]),
                EndpointQuarantineReason::StateLoss,
            ),
            (
                true,
                true,
                EndpointWitnessState {
                    head_counter: 2,
                    head_commitment: [6; 48],
                    previous_certificate_hash: [8; 48],
                    pending: None,
                    terminal: None,
                    mutation_authorization: None,
                },
                quorum_head(2, [7; 48]),
                EndpointQuarantineReason::CommitmentConflict,
            ),
            (
                true,
                true,
                EndpointWitnessState {
                    head_counter: 4,
                    head_commitment: [6; 48],
                    previous_certificate_hash: [8; 48],
                    pending: None,
                    terminal: None,
                    mutation_authorization: None,
                },
                quorum_head(1, [7; 48]),
                EndpointQuarantineReason::WitnessBehindMoreThanOne,
            ),
            (
                true,
                true,
                EndpointWitnessState {
                    head_counter: 1,
                    head_commitment: [6; 48],
                    previous_certificate_hash: [8; 48],
                    pending: None,
                    terminal: None,
                    mutation_authorization: None,
                },
                FreshQuorumState::Absent,
                EndpointQuarantineReason::WitnessLineageMissing,
            ),
            (
                true,
                true,
                EndpointWitnessState::new(),
                FreshQuorumState::Mixed,
                EndpointQuarantineReason::WitnessInconsistent,
            ),
            (
                true,
                true,
                EndpointWitnessState::new(),
                FreshQuorumState::Inconsistent,
                EndpointQuarantineReason::WitnessInconsistent,
            ),
        ];
        for (present, registered, mut state, quorum, reason) in cases.drain(..) {
            let original_head = (state.head_counter, state.head_commitment);
            assert_eq!(
                state.reconcile(present, registered, quorum),
                EndpointReconciliation::Quarantined(reason)
            );
            assert_eq!(
                (state.head_counter, state.head_commitment),
                original_head,
                "reconciliation must never fast-forward private local state"
            );
            assert_eq!(state.release_and_advance(), Err(WitnessError::Quarantined));
            assert!(matches!(
                state.reconcile(present, registered, FreshQuorumState::Unavailable),
                EndpointReconciliation::Quarantined(current) if current == reason
            ));
        }

        let fixture = fixture(2);
        let mut local_ahead = pending_endpoint(&fixture);
        local_ahead
            .pending
            .as_mut()
            .unwrap()
            .request
            .proposed_counter = Some(4);
        assert_eq!(
            local_ahead.reconcile(true, true, quorum_head(1, [6; 48])),
            EndpointReconciliation::Quarantined(EndpointQuarantineReason::LocalAheadMoreThanOne)
        );
        assert_eq!(
            local_ahead.pending().unwrap().committed_result(),
            Err(WitnessError::OutputBlocked)
        );
    }

    #[test]
    fn endpoint_reconciliation_handles_revocation_forks_absence_and_unavailability() {
        let fixture = fixture(2);
        let mut pending = pending_endpoint(&fixture);
        let operation_id = pending.pending().unwrap().operation_id();
        let request_hash = pending.pending().unwrap().request_hash();
        let proposed = pending
            .pending()
            .unwrap()
            .request
            .proposed_commitment
            .unwrap();
        let revocation = WitnessRevocationEvent {
            position: WitnessLedgerPosition {
                sequence: 11,
                revocation_generation: 2,
            },
        };
        assert_eq!(
            pending.reconcile(
                true,
                true,
                FreshQuorumState::Head(FreshQuorumHead {
                    head: WitnessHead {
                        counter: 2,
                        commitment: proposed,
                    },
                    revocation: Some(revocation),
                    fork: None,
                    accepted_operation: Some(AcceptedRecoveryEvidence {
                        operation_id,
                        request_hash,
                        accepted_at: WitnessLedgerPosition {
                            sequence: 10,
                            revocation_generation: 1,
                        },
                    }),
                }),
            ),
            EndpointReconciliation::RecoverAccepted
        );

        let mut accepted_after_revocation = pending_endpoint(&fixture);
        assert_eq!(
            accepted_after_revocation.reconcile(
                true,
                true,
                FreshQuorumState::Head(FreshQuorumHead {
                    head: WitnessHead {
                        counter: 2,
                        commitment: proposed,
                    },
                    revocation: Some(revocation),
                    fork: None,
                    accepted_operation: Some(AcceptedRecoveryEvidence {
                        operation_id,
                        request_hash,
                        accepted_at: WitnessLedgerPosition {
                            sequence: 11,
                            revocation_generation: 2,
                        },
                    }),
                }),
            ),
            EndpointReconciliation::Revoked
        );
        assert_eq!(
            accepted_after_revocation.release_and_advance(),
            Err(WitnessError::Revoked)
        );

        let mut revoked = pending_endpoint(&fixture);
        assert_eq!(
            revoked.reconcile(
                true,
                true,
                FreshQuorumState::Head(FreshQuorumHead {
                    head: WitnessHead {
                        counter: 1,
                        commitment: [6; 48],
                    },
                    revocation: Some(revocation),
                    fork: None,
                    accepted_operation: None,
                }),
            ),
            EndpointReconciliation::Revoked
        );
        assert_eq!(revoked.release_and_advance(), Err(WitnessError::Revoked));

        for (fork, reason) in [
            (
                WitnessResult::ConflictingSuccessor,
                EndpointQuarantineReason::ImmediateFork,
            ),
            (
                WitnessResult::HistoricalFork,
                EndpointQuarantineReason::HistoricalFork,
            ),
        ] {
            let mut state = pending_endpoint(&fixture);
            assert_eq!(
                state.reconcile(
                    true,
                    true,
                    FreshQuorumState::Head(FreshQuorumHead {
                        head: WitnessHead {
                            counter: 2,
                            commitment: proposed,
                        },
                        revocation: None,
                        fork: Some(fork),
                        accepted_operation: None,
                    }),
                ),
                EndpointReconciliation::Quarantined(reason)
            );
            assert_eq!(state.release_and_advance(), Err(WitnessError::Quarantined));
        }

        let mut absent_local = EndpointWitnessState::new();
        assert_eq!(
            absent_local.reconcile(false, false, quorum_head(1, [6; 48])),
            EndpointReconciliation::Quarantined(EndpointQuarantineReason::StateLoss)
        );
        let mut fresh = EndpointWitnessState::new();
        assert_eq!(
            fresh.reconcile(false, false, FreshQuorumState::Absent),
            EndpointReconciliation::Ready
        );
        let mut unavailable = pending_endpoint(&fixture);
        assert_eq!(
            unavailable.reconcile(true, true, FreshQuorumState::Unavailable),
            EndpointReconciliation::WitnessUnavailable
        );
        assert_eq!(
            unavailable.pending().unwrap().committed_result(),
            Err(WitnessError::OutputBlocked)
        );
    }

    #[test]
    fn decision_table_handles_stale_heads_immediate_and_historical_forks() {
        let fixture = fixture(3);
        let head2 = WitnessHead {
            counter: 2,
            commitment: [10; 48],
        };
        let mut history = WitnessHistory {
            head: head2.clone(),
            successors: BTreeMap::from([((1, [6; 48]), head2.clone())]),
            operations: BTreeMap::new(),
            revocation: None,
            forked: false,
        };
        let mut matching = fixture.request.clone();
        matching.expected_counter = Some(1);
        matching.expected_commitment = Some([6; 48]);
        matching.proposed_counter = Some(2);
        matching.proposed_commitment = Some([10; 48]);
        assert_eq!(
            evaluate_witness_request(&history, &matching)
                .unwrap()
                .result,
            WitnessResult::StaleExpected
        );
        matching.proposed_commitment = Some([11; 48]);
        assert_eq!(
            evaluate_witness_request(&history, &matching)
                .unwrap()
                .result,
            WitnessResult::ConflictingSuccessor
        );
        history.head = WitnessHead {
            counter: 4,
            commitment: [12; 48],
        };
        assert_eq!(
            evaluate_witness_request(&history, &matching)
                .unwrap()
                .result,
            WitnessResult::HistoricalFork
        );
        let mut invalid = fixture.request.clone();
        invalid.expected_counter = Some(8);
        invalid.proposed_counter = Some(9);
        assert_eq!(
            evaluate_witness_request(&history, &invalid).unwrap().result,
            WitnessResult::InvalidExpected
        );
    }

    #[test]
    fn accepted_operation_recovery_enforces_append_only_revocation_ordering() {
        let fixture = fixture(3);
        let request_hash = fixture.request.request_hash().unwrap();
        let exact_receipt = receipt(&fixture, 0, WitnessResult::Advanced)
            .encode()
            .unwrap();
        let stored = StoredWitnessOperation {
            request_hash,
            result: WitnessResult::Advanced,
            successor: Some(WitnessHead {
                counter: 3,
                commitment: [7; 48],
            }),
            exact_receipt: exact_receipt.clone(),
            accepted_at: Some(WitnessLedgerPosition {
                sequence: 10,
                revocation_generation: 1,
            }),
        };
        let mut history = WitnessHistory {
            head: stored.successor.clone().unwrap(),
            successors: BTreeMap::new(),
            operations: BTreeMap::from([(fixture.request.operation_id, stored.clone())]),
            revocation: Some(WitnessRevocationEvent {
                position: WitnessLedgerPosition {
                    sequence: 11,
                    revocation_generation: 2,
                },
            }),
            forked: false,
        };
        assert_eq!(
            evaluate_witness_request(&history, &fixture.request).unwrap(),
            WitnessDecision {
                result: WitnessResult::Advanced,
                exact_receipt: Some(exact_receipt),
            }
        );

        history
            .operations
            .get_mut(&fixture.request.operation_id)
            .unwrap()
            .accepted_at = Some(WitnessLedgerPosition {
            sequence: 11,
            revocation_generation: 1,
        });
        assert_eq!(
            evaluate_witness_request(&history, &fixture.request).unwrap(),
            WitnessDecision::fresh(WitnessResult::Revoked)
        );
        history
            .operations
            .get_mut(&fixture.request.operation_id)
            .unwrap()
            .accepted_at = Some(WitnessLedgerPosition {
            sequence: 10,
            revocation_generation: 2,
        });
        assert_eq!(
            evaluate_witness_request(&history, &fixture.request)
                .unwrap()
                .result,
            WitnessResult::Revoked
        );
        let operation = history
            .operations
            .get_mut(&fixture.request.operation_id)
            .unwrap();
        operation.result = WitnessResult::StaleExpected;
        operation.successor = None;
        operation.exact_receipt = receipt(&fixture, 0, WitnessResult::StaleExpected)
            .encode()
            .unwrap();
        operation.accepted_at = None;
        assert_eq!(
            evaluate_witness_request(&history, &fixture.request)
                .unwrap()
                .result,
            WitnessResult::Revoked
        );

        let mut conflict = fixture.request.clone();
        conflict.signature[0] ^= 1;
        assert_eq!(
            evaluate_witness_request(&history, &conflict)
                .unwrap()
                .result,
            WitnessResult::OperationConflict
        );
        history
            .operations
            .insert(fixture.request.operation_id, stored);
        history.forked = true;
        assert_eq!(
            evaluate_witness_request(&history, &fixture.request)
                .unwrap()
                .result,
            WitnessResult::Forked
        );
        assert_eq!(
            evaluate_witness_request(&history, &conflict)
                .unwrap()
                .result,
            WitnessResult::OperationConflict
        );
    }

    #[test]
    fn checked_in_witness_fixtures_are_canonical_and_self_consistent() {
        let register_bytes = include_bytes!("../fixtures/v1/witness-register-v1.bin");
        let read_bytes = include_bytes!("../fixtures/v1/witness-read-v1.bin");
        let request_bytes = include_bytes!("../fixtures/v1/witness-advance-v1.bin");
        let certificate_bytes = include_bytes!("../fixtures/v1/witness-quorum-v1.bin");
        let expected = parse_metadata(include_str!("../fixtures/v1/witness-expected.txt"));
        for (name, bytes) in [
            ("register", register_bytes.as_slice()),
            ("read", read_bytes.as_slice()),
            ("request", request_bytes.as_slice()),
            ("certificate", certificate_bytes.as_slice()),
        ] {
            assert_eq!(bytes.len().to_string(), expected[&format!("{name}_bytes")]);
            assert_eq!(
                hex(&sha384(bytes).unwrap()),
                expected[&format!("{name}_sha384")]
            );
        }
        let register = WitnessRequest::decode(register_bytes).unwrap();
        let credential = PairingCredential::decode(register.credential().unwrap()).unwrap();
        register.verify(register.lineage(), &credential).unwrap();
        let read = WitnessRequest::decode(read_bytes).unwrap();
        read.verify(read.lineage(), &credential).unwrap();
        let request = WitnessRequest::decode(request_bytes).unwrap();
        request.verify(request.lineage(), &credential).unwrap();
        let trust = ReplicaTrustSet::new(
            (0..WITNESS_REPLICA_COUNT)
                .map(|index| {
                    let ordinal = index + 1;
                    ReplicaTrust::new(
                        decode_hex(&expected[&format!("replica_{ordinal}_id")])
                            .try_into()
                            .unwrap(),
                        vec![
                            ReplicaKey::new(
                                decode_hex(&expected[&format!("replica_{ordinal}_key_id")])
                                    .try_into()
                                    .unwrap(),
                                decode_hex(&expected[&format!("replica_{ordinal}_public_key")])
                                    .try_into()
                                    .unwrap(),
                            )
                            .unwrap(),
                        ],
                    )
                    .unwrap()
                })
                .collect(),
        )
        .unwrap();
        assert_eq!(
            QuorumCertificate::decode(certificate_bytes)
                .unwrap()
                .verify(&request, &trust),
            Ok(WitnessResult::Advanced)
        );
    }

    #[test]
    fn generate_checked_in_witness_fixtures() {
        if std::env::var_os("AXL_REGENERATE_WITNESS_FIXTURES").as_deref()
            != Some(std::ffi::OsStr::new("1"))
        {
            assert!(!include_bytes!("../fixtures/v1/witness-advance-v1.bin").is_empty());
            return;
        }
        let fixture = fixture(2);
        let register = WitnessRequest::new_signed(WitnessRequestSigning {
            kind: WitnessRequestKind::Register,
            lineage: fixture.lineage.clone(),
            operation_id: id(40),
            expected: None,
            proposed: Some((1, [17; 48])),
            previous_certificate_hash: ZERO_HASH,
            credential: &fixture.credential,
            signer: &fixture.endpoint_signer,
            nonce: [18; 32],
        })
        .unwrap()
        .encode()
        .unwrap();
        let read = WitnessRequest::new_read(
            fixture.lineage.clone(),
            id(41),
            [42; 48],
            &fixture.credential,
            &fixture.endpoint_signer,
            [43; 32],
        )
        .unwrap()
        .encode()
        .unwrap();
        let request = fixture.request.encode().unwrap();
        let receipt_bytes: Vec<Vec<u8>> = (0..3)
            .map(|index| {
                receipt(&fixture, index, WitnessResult::Advanced)
                    .encode()
                    .unwrap()
            })
            .collect();
        let certificate = certificate(&fixture, WitnessResult::Advanced)
            .encode()
            .unwrap();
        let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/v1");
        fs::write(directory.join("witness-register-v1.bin"), &register).unwrap();
        fs::write(directory.join("witness-read-v1.bin"), &read).unwrap();
        fs::write(directory.join("witness-advance-v1.bin"), &request).unwrap();
        for (index, bytes) in receipt_bytes.iter().enumerate() {
            fs::write(
                directory.join(format!("witness-receipt-{}.bin", index + 1)),
                bytes,
            )
            .unwrap();
        }
        fs::write(directory.join("witness-quorum-v1.bin"), &certificate).unwrap();
        let mut metadata = String::from(
            "# SPDX-FileCopyrightText: 2026 VishnuM449\n# SPDX-License-Identifier: Apache-2.0\n# Rust-produced witness fixture metadata. No private key is included.\n",
        );
        metadata.push_str(&format!(
            "register_sha384={}\nregister_bytes={}\nread_sha384={}\nread_bytes={}\nrequest_sha384={}\nrequest_bytes={}\nendpoint_public_key={}\ncertificate_sha384={}\ncertificate_bytes={}\n",
            hex(&sha384(&register).unwrap()),
            register.len(),
            hex(&sha384(&read).unwrap()),
            read.len(),
            hex(&sha384(&request).unwrap()),
            request.len(),
            hex(fixture.credential.verification_key()),
            hex(&sha384(&certificate).unwrap()),
            certificate.len()
        ));
        for (index, replica) in fixture.trust.replicas().iter().enumerate() {
            let key = &replica.keys()[0];
            metadata.push_str(&format!(
                "replica_{}_id={}\nreplica_{}_key_id={}\nreplica_{}_public_key={}\n",
                index + 1,
                hex(&replica.replica_id()),
                index + 1,
                hex(&key.key_id()),
                index + 1,
                hex(&key.verification_key())
            ));
        }
        fs::write(directory.join("witness-expected.txt"), metadata).unwrap();
    }

    fn parse_metadata(text: &str) -> BTreeMap<String, String> {
        text.lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(|line| {
                let (key, value) = line.split_once('=').unwrap();
                (key.to_owned(), value.to_owned())
            })
            .collect()
    }

    fn decode_hex(value: &str) -> Vec<u8> {
        assert_eq!(value.len() % 2, 0);
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let high = (pair[0] as char).to_digit(16).unwrap();
                let low = (pair[1] as char).to_digit(16).unwrap();
                ((high << 4) | low) as u8
            })
            .collect()
    }

    fn hex(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut out = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 15) as usize] as char);
        }
        out
    }
}
