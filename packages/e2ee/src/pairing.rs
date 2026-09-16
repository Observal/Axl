// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

//! Canonical revision 1 pairing transcripts and transport-independent attempt accounting.
//!
//! The in-memory accountant operates only after a pending invitation has been found. Unknown
//! invitation lookup and its non-counting result belong to the durable Session 50.2 owner.

use std::{collections::BTreeMap, fmt, sync::Arc};

use openmls_basic_credential::SignatureKeyPair;
use openmls_traits::{
    OpenMlsProvider, crypto::OpenMlsCrypto as _, random::OpenMlsRand as _, signatures::Signer as _,
};
use tls_codec::Deserialize as _;

use crate::{Clock, CoreProvider, Id, Identity, PROFILE_ID, PROFILE_REVISION, Role, SUITE};

pub const PAIRING_INVITATION_MAX_BYTES: usize = 2_048;
pub const PAIRING_CLAIM_MAX_BYTES: usize =
    2 + (1 + 255) + 2 + (16 * 3) + 48 + (2 + 512) + (2 + 16_384) + 64;
pub const PAIRING_CREDENTIAL_MAX_BYTES: usize = 512;
pub const PAIRING_KEY_PACKAGE_MAX_BYTES: usize = 16_384;
pub const PAIRING_INVITATION_LIFETIME_MS: u64 = 10 * 60 * 1_000;
pub const PAIRING_MAX_FAILED_CLAIMS: usize = 5;

const INVITATION_SIGNATURE_LABEL: &[u8] = b"Axl pairing invitation v1";
const CLAIM_SIGNATURE_LABEL: &[u8] = b"Axl pairing claim v1";
const COMPARISON_LABEL: &[u8] = b"Axl pairing compare v1";
const ZERO_ID: Id = [0; 16];

/// Canonical Axl basic credential bytes used by the pairing transcript.
///
/// Debug output intentionally omits the credential and verification-key bytes.
#[derive(Clone, Eq, PartialEq)]
pub struct PairingCredential {
    bytes: Box<[u8]>,
    identity: Identity,
    verification_key: [u8; 32],
}

impl fmt::Debug for PairingCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairingCredential")
            .field("identity", &self.identity)
            .field("bytes", &"[redacted]")
            .field("verification_key", &"[redacted]")
            .finish()
    }
}

impl PairingCredential {
    pub fn new(identity: Identity, signer: &SignatureKeyPair) -> Result<Self, PairingError> {
        let bytes = identity
            .credential_bytes(signer.public())
            .map_err(|_| PairingError::InvalidCredential)?;
        Self::decode(&bytes)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, PairingError> {
        if bytes.is_empty() || bytes.len() > PAIRING_CREDENTIAL_MAX_BYTES {
            return Err(PairingError::BoundExceeded);
        }
        let mut cursor = PairingCursor::new(bytes);
        if cursor.u16()? != 1 {
            return Err(PairingError::WrongVersion);
        }
        let role = match cursor.u8()? {
            1 => Role::Daemon,
            2 => Role::Device,
            _ => return Err(PairingError::InvalidCredential),
        };
        let identity = Identity {
            role,
            account_id: cursor.array()?,
            installation_id: cursor.array()?,
            device_id: cursor.array()?,
        };
        let profile = cursor.u8_vector(255)?;
        if profile != PROFILE_ID.as_bytes() {
            return Err(PairingError::WrongProfile);
        }
        if cursor.u16()? != PROFILE_REVISION {
            return Err(PairingError::WrongProfileRevision);
        }
        let verification_key = cursor.array()?;
        cursor.finish()?;
        identity
            .validate()
            .map_err(|_| PairingError::InvalidCredential)?;
        let value = Self {
            bytes: bytes.to_vec().into_boxed_slice(),
            identity,
            verification_key,
        };
        if value.canonical_bytes()? != bytes {
            return Err(PairingError::NonCanonical);
        }
        Ok(value)
    }

    fn canonical_bytes(&self) -> Result<Vec<u8>, PairingError> {
        self.identity
            .credential_bytes(&self.verification_key)
            .map_err(|_| PairingError::InvalidCredential)
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn identity(&self) -> &Identity {
        &self.identity
    }

    pub fn verification_key(&self) -> &[u8; 32] {
        &self.verification_key
    }
}

/// Canonical revision 1 QR invitation.
#[derive(Clone, Eq, PartialEq)]
pub struct PairingInvitation {
    version: u16,
    profile_id: Box<str>,
    profile_revision: u16,
    account_id: Id,
    installation_id: Id,
    crypto_session_id: Id,
    daemon_credential: PairingCredential,
    issued_at_ms: u64,
    expires_at_ms: u64,
    invitation_nonce: [u8; 32],
    daemon_signature: [u8; 64],
}

impl fmt::Debug for PairingInvitation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairingInvitation")
            .field("version", &self.version)
            .field("profile_id", &self.profile_id)
            .field("profile_revision", &self.profile_revision)
            .field("account_id", &self.account_id)
            .field("installation_id", &self.installation_id)
            .field("crypto_session_id", &self.crypto_session_id)
            .field("daemon_credential", &self.daemon_credential)
            .field("issued_at_ms", &self.issued_at_ms)
            .field("expires_at_ms", &self.expires_at_ms)
            .field("invitation_nonce", &"[redacted]")
            .field("daemon_signature", &"[redacted]")
            .finish()
    }
}

impl PairingInvitation {
    pub fn create(
        account_id: Id,
        installation_id: Id,
        crypto_session_id: Id,
        daemon_credential: PairingCredential,
        daemon_signer: &SignatureKeyPair,
    ) -> Result<Self, PairingError> {
        Self::create_with_clock(
            account_id,
            installation_id,
            crypto_session_id,
            daemon_credential,
            daemon_signer,
            &crate::SystemClock,
        )
    }

    pub(crate) fn create_with_clock(
        account_id: Id,
        installation_id: Id,
        crypto_session_id: Id,
        daemon_credential: PairingCredential,
        daemon_signer: &SignatureKeyPair,
        clock: &dyn Clock,
    ) -> Result<Self, PairingError> {
        let issued_at_ms = clock.now_ms().map_err(|_| PairingError::ClockRollback)?;
        let expires_at_ms = issued_at_ms
            .checked_add(PAIRING_INVITATION_LIFETIME_MS)
            .ok_or(PairingError::InvalidTime)?;
        let provider = provider()?;
        let invitation_nonce = provider
            .rand()
            .random_array::<32>()
            .map_err(|_| PairingError::CryptographicFailure)?;
        if daemon_signer.public() != daemon_credential.verification_key() {
            return Err(PairingError::IdentityMismatch);
        }
        let mut invitation = Self {
            version: 1,
            profile_id: PROFILE_ID.into(),
            profile_revision: PROFILE_REVISION,
            account_id,
            installation_id,
            crypto_session_id,
            daemon_credential,
            issued_at_ms,
            expires_at_ms,
            invitation_nonce,
            daemon_signature: [0; 64],
        };
        invitation.validate_bindings()?;
        let signature = daemon_signer
            .sign(&invitation.signature_input()?)
            .map_err(|_| PairingError::CryptographicFailure)?;
        invitation.daemon_signature = signature
            .try_into()
            .map_err(|_| PairingError::CryptographicFailure)?;
        Ok(invitation)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, PairingError> {
        if bytes.len() > PAIRING_INVITATION_MAX_BYTES {
            return Err(PairingError::BoundExceeded);
        }
        let mut cursor = PairingCursor::new(bytes);
        let value = Self {
            version: cursor.u16()?,
            profile_id: str::from_utf8(cursor.u8_vector(255)?)
                .map_err(|_| PairingError::NonCanonical)?
                .into(),
            profile_revision: cursor.u16()?,
            account_id: cursor.array()?,
            installation_id: cursor.array()?,
            crypto_session_id: cursor.array()?,
            daemon_credential: PairingCredential::decode(
                cursor.u16_vector(PAIRING_CREDENTIAL_MAX_BYTES)?,
            )?,
            issued_at_ms: cursor.u64()?,
            expires_at_ms: cursor.u64()?,
            invitation_nonce: cursor.array()?,
            daemon_signature: cursor.array()?,
        };
        cursor.finish()?;
        value.validate_bindings()?;
        if value.encode()? != bytes {
            return Err(PairingError::NonCanonical);
        }
        Ok(value)
    }

    pub fn version(&self) -> u16 {
        self.version
    }

    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }

    pub fn profile_revision(&self) -> u16 {
        self.profile_revision
    }

    pub fn account_id(&self) -> Id {
        self.account_id
    }

    pub fn installation_id(&self) -> Id {
        self.installation_id
    }

    pub fn crypto_session_id(&self) -> Id {
        self.crypto_session_id
    }

    pub fn daemon_credential(&self) -> &PairingCredential {
        &self.daemon_credential
    }

    pub fn issued_at_ms(&self) -> u64 {
        self.issued_at_ms
    }

    pub fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }

    pub fn encode(&self) -> Result<Vec<u8>, PairingError> {
        self.validate_bindings()?;
        let mut out = self.fields_before_signature()?;
        out.extend_from_slice(&self.daemon_signature);
        if out.len() > PAIRING_INVITATION_MAX_BYTES {
            return Err(PairingError::BoundExceeded);
        }
        Ok(out)
    }

    pub fn verify(&self) -> Result<(), PairingError> {
        self.verify_with_clock(&crate::SystemClock)
    }

    pub fn verify_signature(&self) -> Result<(), PairingError> {
        self.validate_bindings()?;
        provider()?
            .crypto()
            .verify_signature(
                SUITE.signature_algorithm(),
                &self.signature_input()?,
                self.daemon_credential.verification_key(),
                &self.daemon_signature,
            )
            .map_err(|_| PairingError::InvalidSignature)
    }

    pub(crate) fn verify_with_clock(&self, clock: &dyn Clock) -> Result<(), PairingError> {
        let now_ms = clock.now_ms().map_err(|_| PairingError::ClockRollback)?;
        self.verify_at(now_ms)
    }

    pub(crate) fn verify_at(&self, now_ms: u64) -> Result<(), PairingError> {
        self.validate_time(now_ms)?;
        self.verify_signature()
    }

    pub fn invitation_hash(&self) -> Result<[u8; 48], PairingError> {
        sha384(&self.encode()?)
    }

    pub fn nonce_hash(&self) -> Result<[u8; 48], PairingError> {
        sha384(&self.invitation_nonce)
    }

    pub(crate) fn invitation_nonce(&self) -> [u8; 32] {
        self.invitation_nonce
    }

    fn fields_before_signature(&self) -> Result<Vec<u8>, PairingError> {
        let mut out = Vec::new();
        put_u16(&mut out, self.version);
        put_u8_vector(&mut out, self.profile_id.as_bytes(), 255)?;
        put_u16(&mut out, self.profile_revision);
        out.extend_from_slice(&self.account_id);
        out.extend_from_slice(&self.installation_id);
        out.extend_from_slice(&self.crypto_session_id);
        put_u16_vector(
            &mut out,
            self.daemon_credential.bytes(),
            PAIRING_CREDENTIAL_MAX_BYTES,
        )?;
        out.extend_from_slice(&self.issued_at_ms.to_be_bytes());
        out.extend_from_slice(&self.expires_at_ms.to_be_bytes());
        out.extend_from_slice(&self.invitation_nonce);
        Ok(out)
    }

    fn signature_input(&self) -> Result<Vec<u8>, PairingError> {
        let mut input = Vec::from(INVITATION_SIGNATURE_LABEL);
        input.extend_from_slice(&self.fields_before_signature()?);
        Ok(input)
    }

    fn validate_bindings(&self) -> Result<(), PairingError> {
        if self.version != 1 {
            return Err(PairingError::WrongVersion);
        }
        if self.profile_id.as_ref() != PROFILE_ID {
            return Err(PairingError::WrongProfile);
        }
        if self.profile_revision != PROFILE_REVISION {
            return Err(PairingError::WrongProfileRevision);
        }
        validate_uuid_v7(self.installation_id)?;
        validate_uuid_v7(self.crypto_session_id)?;
        let identity = self.daemon_credential.identity();
        if identity.role != Role::Daemon
            || identity.account_id != self.account_id
            || identity.installation_id != self.installation_id
            || identity.device_id != ZERO_ID
        {
            return Err(PairingError::IdentityMismatch);
        }
        self.validate_time_shape()
    }

    fn validate_time_shape(&self) -> Result<(), PairingError> {
        if self.expires_at_ms < self.issued_at_ms
            || self.expires_at_ms - self.issued_at_ms != PAIRING_INVITATION_LIFETIME_MS
        {
            return Err(PairingError::InvalidTime);
        }
        Ok(())
    }

    fn validate_time(&self, now_ms: u64) -> Result<(), PairingError> {
        self.validate_time_shape()?;
        if now_ms < self.issued_at_ms {
            return Err(PairingError::ClockRollback);
        }
        if now_ms >= self.expires_at_ms {
            return Err(PairingError::Expired);
        }
        Ok(())
    }
}

/// Canonical revision 1 device claim.
#[derive(Clone, Eq, PartialEq)]
pub struct PairingClaimV1 {
    version: u16,
    profile_id: Box<str>,
    profile_revision: u16,
    account_id: Id,
    installation_id: Id,
    crypto_session_id: Id,
    invitation_nonce_hash: [u8; 48],
    device_credential: PairingCredential,
    key_package: Box<[u8]>,
    device_signature: [u8; 64],
}

impl fmt::Debug for PairingClaimV1 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairingClaimV1")
            .field("version", &self.version)
            .field("profile_id", &self.profile_id)
            .field("profile_revision", &self.profile_revision)
            .field("account_id", &self.account_id)
            .field("installation_id", &self.installation_id)
            .field("crypto_session_id", &self.crypto_session_id)
            .field("invitation_nonce_hash", &"[redacted]")
            .field("device_credential", &self.device_credential)
            .field("key_package", &"[redacted]")
            .field("device_signature", &"[redacted]")
            .finish()
    }
}

impl PairingClaimV1 {
    pub fn create(
        invitation: &PairingInvitation,
        device_credential: PairingCredential,
        key_package: &[u8],
        device_signer: &SignatureKeyPair,
    ) -> Result<Self, PairingError> {
        invitation.verify()?;
        Self::create_after_verification(invitation, device_credential, key_package, device_signer)
    }

    pub(crate) fn create_at(
        invitation: &PairingInvitation,
        device_credential: PairingCredential,
        key_package: &[u8],
        device_signer: &SignatureKeyPair,
        now_ms: u64,
    ) -> Result<Self, PairingError> {
        invitation.verify_at(now_ms)?;
        Self::create_after_verification(invitation, device_credential, key_package, device_signer)
    }

    fn create_after_verification(
        invitation: &PairingInvitation,
        device_credential: PairingCredential,
        key_package: &[u8],
        device_signer: &SignatureKeyPair,
    ) -> Result<Self, PairingError> {
        if key_package.is_empty() || key_package.len() > PAIRING_KEY_PACKAGE_MAX_BYTES {
            return Err(PairingError::BoundExceeded);
        }
        if device_signer.public() != device_credential.verification_key() {
            return Err(PairingError::IdentityMismatch);
        }
        let mut claim = Self {
            version: invitation.version,
            profile_id: invitation.profile_id.clone(),
            profile_revision: invitation.profile_revision,
            account_id: invitation.account_id,
            installation_id: invitation.installation_id,
            crypto_session_id: invitation.crypto_session_id,
            invitation_nonce_hash: invitation.nonce_hash()?,
            device_credential,
            key_package: key_package.to_vec().into_boxed_slice(),
            device_signature: [0; 64],
        };
        claim.validate_bindings(invitation)?;
        let signature = device_signer
            .sign(&claim.signature_input(invitation)?)
            .map_err(|_| PairingError::CryptographicFailure)?;
        claim.device_signature = signature
            .try_into()
            .map_err(|_| PairingError::CryptographicFailure)?;
        Ok(claim)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, PairingError> {
        if bytes.len() > PAIRING_CLAIM_MAX_BYTES {
            return Err(PairingError::BoundExceeded);
        }
        let mut cursor = PairingCursor::new(bytes);
        let value = Self {
            version: cursor.u16()?,
            profile_id: str::from_utf8(cursor.u8_vector(255)?)
                .map_err(|_| PairingError::NonCanonical)?
                .into(),
            profile_revision: cursor.u16()?,
            account_id: cursor.array()?,
            installation_id: cursor.array()?,
            crypto_session_id: cursor.array()?,
            invitation_nonce_hash: cursor.array()?,
            device_credential: PairingCredential::decode(
                cursor.u16_vector(PAIRING_CREDENTIAL_MAX_BYTES)?,
            )?,
            key_package: cursor
                .u16_vector(PAIRING_KEY_PACKAGE_MAX_BYTES)?
                .to_vec()
                .into_boxed_slice(),
            device_signature: cursor.array()?,
        };
        cursor.finish()?;
        value.validate_self()?;
        if value.encode()? != bytes {
            return Err(PairingError::NonCanonical);
        }
        Ok(value)
    }

    pub fn version(&self) -> u16 {
        self.version
    }

    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }

    pub fn profile_revision(&self) -> u16 {
        self.profile_revision
    }

    pub fn account_id(&self) -> Id {
        self.account_id
    }

    pub fn installation_id(&self) -> Id {
        self.installation_id
    }

    pub fn crypto_session_id(&self) -> Id {
        self.crypto_session_id
    }

    pub fn invitation_nonce_hash(&self) -> &[u8; 48] {
        &self.invitation_nonce_hash
    }

    pub fn device_credential(&self) -> &PairingCredential {
        &self.device_credential
    }

    pub fn encode(&self) -> Result<Vec<u8>, PairingError> {
        self.validate_self()?;
        let mut out = Vec::new();
        put_u16(&mut out, self.version);
        put_u8_vector(&mut out, self.profile_id.as_bytes(), 255)?;
        put_u16(&mut out, self.profile_revision);
        out.extend_from_slice(&self.account_id);
        out.extend_from_slice(&self.installation_id);
        out.extend_from_slice(&self.crypto_session_id);
        out.extend_from_slice(&self.invitation_nonce_hash);
        put_u16_vector(
            &mut out,
            self.device_credential.bytes(),
            PAIRING_CREDENTIAL_MAX_BYTES,
        )?;
        put_u16_vector(&mut out, &self.key_package, PAIRING_KEY_PACKAGE_MAX_BYTES)?;
        out.extend_from_slice(&self.device_signature);
        if out.len() > PAIRING_CLAIM_MAX_BYTES {
            return Err(PairingError::BoundExceeded);
        }
        Ok(out)
    }

    pub fn verify(&self, invitation: &PairingInvitation) -> Result<(), PairingError> {
        self.verify_with_clock(invitation, &crate::SystemClock)
    }

    pub fn verify_signature_and_bindings(
        &self,
        invitation: &PairingInvitation,
    ) -> Result<(), PairingError> {
        invitation.verify_signature()?;
        self.validate_bindings(invitation)?;
        provider()?
            .crypto()
            .verify_signature(
                SUITE.signature_algorithm(),
                &self.signature_input(invitation)?,
                self.device_credential.verification_key(),
                &self.device_signature,
            )
            .map_err(|_| PairingError::InvalidSignature)?;
        self.validate_key_package_credential()
    }

    pub(crate) fn verify_with_clock(
        &self,
        invitation: &PairingInvitation,
        clock: &dyn Clock,
    ) -> Result<(), PairingError> {
        let now_ms = clock.now_ms().map_err(|_| PairingError::ClockRollback)?;
        invitation.validate_time(now_ms)?;
        self.verify_signature_and_bindings(invitation)
    }

    pub fn claim_hash(&self) -> Result<[u8; 48], PairingError> {
        sha384(&self.encode()?)
    }

    pub fn key_package(&self) -> &[u8] {
        &self.key_package
    }

    fn signature_input(&self, invitation: &PairingInvitation) -> Result<Vec<u8>, PairingError> {
        let mut input = Vec::from(CLAIM_SIGNATURE_LABEL);
        input.extend_from_slice(&invitation.invitation_hash()?);
        input.extend_from_slice(&sha384(&self.key_package)?);
        input.extend_from_slice(&sha384(self.device_credential.bytes())?);
        Ok(input)
    }

    fn validate_key_package_credential(&self) -> Result<(), PairingError> {
        let package = openmls::prelude::KeyPackageIn::tls_deserialize_exact(&self.key_package)
            .map_err(|_| PairingError::CryptographicFailure)?;
        let credential = package.unverified_credential();
        if credential.credential.serialized_content() != self.device_credential.bytes()
            || credential.signature_key.as_slice() != self.device_credential.verification_key()
        {
            return Err(PairingError::IdentityMismatch);
        }
        Ok(())
    }

    fn validate_self(&self) -> Result<(), PairingError> {
        if self.version != 1 {
            return Err(PairingError::WrongVersion);
        }
        if self.profile_id.as_ref() != PROFILE_ID {
            return Err(PairingError::WrongProfile);
        }
        if self.profile_revision != PROFILE_REVISION {
            return Err(PairingError::WrongProfileRevision);
        }
        validate_uuid_v7(self.installation_id)?;
        validate_uuid_v7(self.crypto_session_id)?;
        let identity = self.device_credential.identity();
        if identity.role != Role::Device
            || identity.account_id != self.account_id
            || identity.installation_id != self.installation_id
            || validate_uuid_v7(identity.device_id).is_err()
        {
            return Err(PairingError::IdentityMismatch);
        }
        if self.key_package.is_empty() || self.key_package.len() > PAIRING_KEY_PACKAGE_MAX_BYTES {
            return Err(PairingError::BoundExceeded);
        }
        Ok(())
    }

    fn validate_bindings(&self, invitation: &PairingInvitation) -> Result<(), PairingError> {
        self.validate_self()?;
        if self.version != invitation.version {
            return Err(PairingError::WrongVersion);
        }
        if self.profile_id != invitation.profile_id {
            return Err(PairingError::WrongProfile);
        }
        if self.profile_revision != invitation.profile_revision {
            return Err(PairingError::WrongProfileRevision);
        }
        if self.account_id != invitation.account_id
            || self.installation_id != invitation.installation_id
            || self.crypto_session_id != invitation.crypto_session_id
        {
            return Err(PairingError::IdentityMismatch);
        }
        if self.invitation_nonce_hash != invitation.nonce_hash()? {
            return Err(PairingError::NonceMismatch);
        }
        Ok(())
    }
}

pub fn comparison_value(
    invitation: &PairingInvitation,
    claim: &PairingClaimV1,
) -> Result<String, PairingError> {
    let mut transcript = Vec::from(COMPARISON_LABEL);
    transcript.extend_from_slice(&invitation.encode()?);
    transcript.extend_from_slice(&claim.encode()?);
    let digest = sha384(&transcript)?;
    let value = (u64::from(digest[0]) << 31)
        | (u64::from(digest[1]) << 23)
        | (u64::from(digest[2]) << 15)
        | (u64::from(digest[3]) << 7)
        | (u64::from(digest[4]) >> 1);
    let digits = format!("{value:012}");
    Ok(format!(
        "{} {} {} {}",
        &digits[0..3],
        &digits[3..6],
        &digits[6..9],
        &digits[9..12]
    ))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PairingError {
    BoundExceeded,
    ClockRollback,
    CryptographicFailure,
    Expired,
    IdentityMismatch,
    InvalidCredential,
    InvalidSignature,
    InvalidTime,
    NonCanonical,
    NonCounting,
    NonceMismatch,
    WrongProfile,
    WrongProfileRevision,
    WrongVersion,
}

impl fmt::Display for PairingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "pairing request failed: {self:?}")
    }
}
impl std::error::Error for PairingError {}

/// Crate-private classification consumed by the durable pairing owner.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FailedClaimReason {
    Credential,
    KeyPackage,
    Signature,
}

pub(crate) enum ClassifiedClaim {
    NonCounting,
    EligibleFailure {
        claim_hash: [u8; 48],
        reason: FailedClaimReason,
    },
    Eligible {
        claim_hash: [u8; 48],
        claim: Box<PairingClaimV1>,
    },
}

fn classify_claim(
    invitation: &PairingInvitation,
    claim_bytes: &[u8],
    now_ms: u64,
) -> ClassifiedClaim {
    if claim_bytes.len() > PAIRING_CLAIM_MAX_BYTES {
        return ClassifiedClaim::NonCounting;
    }
    let Ok(claim) = PairingClaimV1::decode(claim_bytes) else {
        return ClassifiedClaim::NonCounting;
    };
    if claim.validate_bindings(invitation).is_err() {
        return ClassifiedClaim::NonCounting;
    }
    let Ok(claim_hash) = sha384(claim_bytes) else {
        return ClassifiedClaim::NonCounting;
    };
    match claim.verify_signature_and_bindings(invitation) {
        Ok(()) => {
            let Ok(provider) = provider() else {
                return ClassifiedClaim::EligibleFailure {
                    claim_hash,
                    reason: FailedClaimReason::KeyPackage,
                };
            };
            if crate::validate_phone_key_package(
                &provider,
                claim.key_package(),
                claim.device_credential().identity(),
                now_ms,
            )
            .is_err()
            {
                ClassifiedClaim::EligibleFailure {
                    claim_hash,
                    reason: FailedClaimReason::KeyPackage,
                }
            } else {
                ClassifiedClaim::Eligible {
                    claim_hash,
                    claim: Box::new(claim),
                }
            }
        }
        Err(PairingError::InvalidSignature) => ClassifiedClaim::EligibleFailure {
            claim_hash,
            reason: FailedClaimReason::Signature,
        },
        Err(PairingError::IdentityMismatch | PairingError::CryptographicFailure) => {
            ClassifiedClaim::EligibleFailure {
                claim_hash,
                reason: FailedClaimReason::KeyPackage,
            }
        }
        Err(_) => ClassifiedClaim::EligibleFailure {
            claim_hash,
            reason: FailedClaimReason::Credential,
        },
    }
}

/// Exact accepted result. Debug output never prints its bytes.
#[allow(dead_code)]
#[derive(Clone, Eq, PartialEq)]
pub(crate) struct AcceptedPairingResult(Box<[u8]>);

#[allow(dead_code)]
impl AcceptedPairingResult {
    pub(crate) fn new(bytes: &[u8]) -> Result<Self, PairingError> {
        if bytes.len() > PAIRING_KEY_PACKAGE_MAX_BYTES {
            return Err(PairingError::BoundExceeded);
        }
        Ok(Self(bytes.to_vec().into_boxed_slice()))
    }
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.0
    }
}
impl fmt::Debug for AcceptedPairingResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AcceptedPairingResult([redacted])")
    }
}

#[allow(dead_code)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ClaimDecision {
    Accepted(AcceptedPairingResult),
    Failed(FailedClaimReason),
}

#[allow(dead_code)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum PublicClaimResult {
    Accepted(AcceptedPairingResult),
    Cancelled,
    Conflict,
    Rejected,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InvitationState {
    Issued,
    Confirmed,
    Consumed,
    Cancelled,
}

/// Pure in-memory revision 1 failure accounting. Durable ownership belongs to Session 50.2.
#[allow(dead_code)]
pub(crate) struct PairingClaimAccountant {
    invitation: PairingInvitation,
    nonce_hash: [u8; 48],
    state: InvitationState,
    failed: BTreeMap<[u8; 48], PublicClaimResult>,
    accepted: Option<([u8; 48], AcceptedPairingResult)>,
    clock: Arc<dyn Clock>,
    last_now_ms: u64,
}

impl fmt::Debug for PairingClaimAccountant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairingClaimAccountant")
            .field("invitation", &"[redacted]")
            .field("state", &self.state)
            .field("failed_claim_count", &self.failed.len())
            .field("accepted", &self.accepted.as_ref().map(|_| "[redacted]"))
            .field("clock", &"[redacted]")
            .finish()
    }
}

#[allow(dead_code)]
impl PairingClaimAccountant {
    pub(crate) fn classify(
        invitation: &PairingInvitation,
        claim_bytes: &[u8],
        now_ms: u64,
    ) -> ClassifiedClaim {
        classify_claim(invitation, claim_bytes, now_ms)
    }

    pub(crate) fn new_with_clock(
        invitation: PairingInvitation,
        clock: Arc<dyn Clock>,
    ) -> Result<Self, PairingError> {
        let last_now_ms = clock.now_ms().map_err(|_| PairingError::ClockRollback)?;
        invitation.validate_time(last_now_ms)?;
        invitation.verify_signature()?;
        Ok(Self {
            nonce_hash: invitation.nonce_hash()?,
            invitation,
            state: InvitationState::Issued,
            failed: BTreeMap::new(),
            accepted: None,
            clock,
            last_now_ms,
        })
    }

    pub(crate) fn submit(
        &mut self,
        claim_bytes: &[u8],
        decision: ClaimDecision,
    ) -> PublicClaimResult {
        let now_ms = match self.clock.now_ms() {
            Ok(now) if now >= self.last_now_ms => now,
            _ => return PublicClaimResult::Rejected,
        };
        self.last_now_ms = now_ms;
        if self.invitation.validate_time(now_ms).is_err() {
            return PublicClaimResult::Rejected;
        }
        if claim_bytes.len() > PAIRING_CLAIM_MAX_BYTES {
            return PublicClaimResult::Rejected;
        }
        let claim = match PairingClaimV1::decode(claim_bytes) {
            Ok(claim) => claim,
            Err(_) => return PublicClaimResult::Rejected,
        };
        if claim.validate_bindings(&self.invitation).is_err()
            || claim.invitation_nonce_hash != self.nonce_hash
        {
            return PublicClaimResult::Rejected;
        }
        let claim_hash = match sha384(claim_bytes) {
            Ok(hash) => hash,
            Err(_) => return PublicClaimResult::Rejected,
        };
        if let Some((accepted_hash, result)) = &self.accepted {
            return if *accepted_hash == claim_hash {
                PublicClaimResult::Accepted(result.clone())
            } else {
                PublicClaimResult::Conflict
            };
        }
        if let Some(result) = self.failed.get(&claim_hash) {
            return result.clone();
        }
        if matches!(self.state, InvitationState::Cancelled) {
            return PublicClaimResult::Cancelled;
        }
        let decision = match decision {
            ClaimDecision::Accepted(result)
                if claim
                    .verify_signature_and_bindings(&self.invitation)
                    .is_ok() =>
            {
                ClaimDecision::Accepted(result)
            }
            ClaimDecision::Accepted(_) => ClaimDecision::Failed(FailedClaimReason::Signature),
            failed => failed,
        };
        match decision {
            ClaimDecision::Accepted(result) => {
                self.state = InvitationState::Confirmed;
                self.accepted = Some((claim_hash, result.clone()));
                PublicClaimResult::Accepted(result)
            }
            ClaimDecision::Failed(_) => {
                let result = if self.failed.len() + 1 == PAIRING_MAX_FAILED_CLAIMS {
                    self.state = InvitationState::Cancelled;
                    PublicClaimResult::Cancelled
                } else {
                    PublicClaimResult::Rejected
                };
                self.failed.insert(claim_hash, result.clone());
                result
            }
        }
    }

    pub(crate) fn mark_consumed(&mut self) -> Result<(), PairingError> {
        if self.state != InvitationState::Confirmed || self.accepted.is_none() {
            return Err(PairingError::NonCounting);
        }
        self.state = InvitationState::Consumed;
        Ok(())
    }

    pub(crate) fn cancel(&mut self) {
        if self.state == InvitationState::Issued {
            self.state = InvitationState::Cancelled;
        }
    }

    pub(crate) fn failed_claim_count(&self) -> usize {
        self.failed.len()
    }
}

fn provider() -> Result<CoreProvider, PairingError> {
    CoreProvider::new().map_err(|_| PairingError::CryptographicFailure)
}

pub(crate) fn sha384(bytes: &[u8]) -> Result<[u8; 48], PairingError> {
    provider()?
        .crypto()
        .hash(SUITE.hash_algorithm(), bytes)
        .map_err(|_| PairingError::CryptographicFailure)?
        .try_into()
        .map_err(|_| PairingError::CryptographicFailure)
}

fn validate_uuid_v7(id: Id) -> Result<(), PairingError> {
    if id == ZERO_ID || id[6] >> 4 != 0x07 || id[8] >> 6 != 0b10 {
        Err(PairingError::IdentityMismatch)
    } else {
        Ok(())
    }
}

fn put_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_be_bytes());
}
fn put_u8_vector(out: &mut Vec<u8>, bytes: &[u8], max: usize) -> Result<(), PairingError> {
    if bytes.is_empty() || bytes.len() > max {
        return Err(PairingError::BoundExceeded);
    }
    let len = u8::try_from(bytes.len()).map_err(|_| PairingError::BoundExceeded)?;
    out.push(len);
    out.extend_from_slice(bytes);
    Ok(())
}
fn put_u16_vector(out: &mut Vec<u8>, bytes: &[u8], max: usize) -> Result<(), PairingError> {
    if bytes.is_empty() || bytes.len() > max {
        return Err(PairingError::BoundExceeded);
    }
    let len = u16::try_from(bytes.len()).map_err(|_| PairingError::BoundExceeded)?;
    put_u16(out, len);
    out.extend_from_slice(bytes);
    Ok(())
}

struct PairingCursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl<'a> PairingCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }
    fn take(&mut self, len: usize) -> Result<&'a [u8], PairingError> {
        let end = self
            .offset
            .checked_add(len)
            .ok_or(PairingError::NonCanonical)?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or(PairingError::NonCanonical)?;
        self.offset = end;
        Ok(value)
    }
    fn u8(&mut self) -> Result<u8, PairingError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, PairingError> {
        Ok(u16::from_be_bytes(self.array()?))
    }
    fn u64(&mut self) -> Result<u64, PairingError> {
        Ok(u64::from_be_bytes(self.array()?))
    }
    fn array<const N: usize>(&mut self) -> Result<[u8; N], PairingError> {
        self.take(N)?
            .try_into()
            .map_err(|_| PairingError::NonCanonical)
    }
    fn u8_vector(&mut self, max: usize) -> Result<&'a [u8], PairingError> {
        let len = usize::from(self.u8()?);
        if len == 0 || len > max {
            return Err(PairingError::NonCanonical);
        }
        self.take(len)
    }
    fn u16_vector(&mut self, max: usize) -> Result<&'a [u8], PairingError> {
        let len = usize::from(self.u16()?);
        if len == 0 || len > max {
            return Err(PairingError::BoundExceeded);
        }
        self.take(len)
    }
    fn finish(self) -> Result<(), PairingError> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err(PairingError::NonCanonical)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{BTreeMap, BTreeSet, VecDeque},
        sync::{
            Arc, Mutex,
            atomic::{AtomicU64, AtomicUsize, Ordering},
        },
    };

    use openmls::prelude::{KeyPackage, Lifetime};
    use openmls_basic_credential::SignatureKeyPair;
    use tls_codec::Serialize as _;

    use super::*;
    use crate::Error;

    struct ManualClock(AtomicU64);
    impl ManualClock {
        fn new(now: u64) -> Arc<Self> {
            Arc::new(Self(AtomicU64::new(now)))
        }
        fn set(&self, now: u64) {
            self.0.store(now, Ordering::SeqCst);
        }
    }
    impl Clock for ManualClock {
        fn now_ms(&self) -> Result<u64, Error> {
            Ok(self.0.load(Ordering::SeqCst))
        }
    }

    struct ScriptedClock {
        samples: Mutex<VecDeque<u64>>,
        calls: AtomicUsize,
    }
    impl ScriptedClock {
        fn new(samples: impl IntoIterator<Item = u64>) -> Arc<Self> {
            Arc::new(Self {
                samples: Mutex::new(samples.into_iter().collect()),
                calls: AtomicUsize::new(0),
            })
        }
    }
    impl Clock for ScriptedClock {
        fn now_ms(&self) -> Result<u64, Error> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self
                .samples
                .lock()
                .expect("scripted clock lock poisoned")
                .pop_front()
                .expect("scripted clock exhausted"))
        }
    }

    fn uuid_v7(seed: u8) -> Id {
        let mut id = [seed; 16];
        id[6] = 0x70 | (seed & 0x0f);
        id[8] = 0x80 | (seed & 0x3f);
        id
    }

    struct Transcript {
        invitation: PairingInvitation,
        claim: PairingClaimV1,
        clock: Arc<ManualClock>,
        device_signer: SignatureKeyPair,
    }

    fn transcript(seed: u8) -> Transcript {
        let clock = ManualClock::new(1_000_000);
        let account = [seed; 16];
        let installation = uuid_v7(seed.wrapping_add(1));
        let session = uuid_v7(seed.wrapping_add(2));
        let device = uuid_v7(seed.wrapping_add(3));
        let daemon_signer = SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap();
        let daemon_credential =
            PairingCredential::new(Identity::daemon(account, installation), &daemon_signer)
                .unwrap();
        let invitation = PairingInvitation::create_with_clock(
            account,
            installation,
            session,
            daemon_credential,
            &daemon_signer,
            clock.as_ref(),
        )
        .unwrap();
        let device_identity = Identity::device(account, installation, device).unwrap();
        let provider = CoreProvider::new().unwrap();
        let (mls_credential, device_signer) =
            crate::make_credential(&provider, &device_identity).unwrap();
        let package = KeyPackage::builder()
            .key_package_lifetime(Lifetime::new(crate::KEY_PACKAGE_LIFETIME_SECONDS))
            .build(SUITE, &provider, &device_signer, mls_credential)
            .unwrap()
            .key_package()
            .tls_serialize_detached()
            .unwrap();
        let device_credential = PairingCredential::new(device_identity, &device_signer).unwrap();
        let claim = PairingClaimV1::create_after_verification(
            &invitation,
            device_credential,
            &package,
            &device_signer,
        )
        .unwrap();
        Transcript {
            invitation,
            claim,
            clock,
            device_signer,
        }
    }

    #[test]
    fn invitation_and_claim_round_trip_and_verify_exact_bindings() {
        let fixture = transcript(1);
        let invitation_bytes = fixture.invitation.encode().unwrap();
        assert!(invitation_bytes.len() <= PAIRING_INVITATION_MAX_BYTES);
        let invitation = PairingInvitation::decode(&invitation_bytes).unwrap();
        invitation
            .verify_with_clock(fixture.clock.as_ref())
            .unwrap();
        assert_eq!(invitation, fixture.invitation);

        let claim_bytes = fixture.claim.encode().unwrap();
        assert!(claim_bytes.len() <= PAIRING_CLAIM_MAX_BYTES);
        let claim = PairingClaimV1::decode(&claim_bytes).unwrap();
        claim
            .verify_with_clock(&invitation, fixture.clock.as_ref())
            .unwrap();
        assert_eq!(claim, fixture.claim);
        assert_ne!(
            invitation.invitation_hash().unwrap(),
            claim.claim_hash().unwrap()
        );
    }

    #[test]
    fn rejects_truncation_trailing_bytes_and_invalid_vectors_before_allocation() {
        let fixture = transcript(2);
        let invitation = fixture.invitation.encode().unwrap();
        assert_eq!(
            PairingInvitation::decode(&invitation[..invitation.len() - 1]),
            Err(PairingError::NonCanonical)
        );
        let mut trailing = invitation.clone();
        trailing.push(0);
        assert_eq!(
            PairingInvitation::decode(&trailing),
            Err(PairingError::NonCanonical)
        );
        let mut zero_profile = invitation;
        zero_profile[2] = 0;
        assert_eq!(
            PairingInvitation::decode(&zero_profile),
            Err(PairingError::NonCanonical)
        );

        let claim = fixture.claim.encode().unwrap();
        assert_eq!(
            PairingClaimV1::decode(&claim[..claim.len() - 1]),
            Err(PairingError::NonCanonical)
        );
        let mut trailing = claim.clone();
        trailing.push(0);
        assert_eq!(
            PairingClaimV1::decode(&trailing),
            Err(PairingError::NonCanonical)
        );
        assert_eq!(
            PairingInvitation::decode(&vec![0; PAIRING_INVITATION_MAX_BYTES + 1]),
            Err(PairingError::BoundExceeded)
        );
        assert_eq!(
            PairingClaimV1::decode(&vec![0; PAIRING_CLAIM_MAX_BYTES + 1]),
            Err(PairingError::BoundExceeded)
        );
    }

    #[test]
    fn schema_maximum_is_exact_and_component_bounds_are_enforced() {
        assert_eq!(PAIRING_CLAIM_MAX_BYTES, 17_320);
        assert_eq!(
            PAIRING_CLAIM_MAX_BYTES,
            2 + (1 + u8::MAX as usize)
                + 2
                + 48
                + 48
                + (2 + PAIRING_CREDENTIAL_MAX_BYTES)
                + (2 + PAIRING_KEY_PACKAGE_MAX_BYTES)
                + 64
        );
        let fixture = transcript(3);
        assert_eq!(
            PairingClaimV1::create_after_verification(
                &fixture.invitation,
                fixture.claim.device_credential.clone(),
                &vec![0; PAIRING_KEY_PACKAGE_MAX_BYTES + 1],
                &fixture.device_signer,
            ),
            Err(PairingError::BoundExceeded)
        );
        assert_eq!(
            PairingCredential::decode(&vec![0; PAIRING_CREDENTIAL_MAX_BYTES + 1]),
            Err(PairingError::BoundExceeded)
        );
    }

    #[test]
    fn signatures_bind_invitation_key_package_and_credential() {
        let fixture = transcript(4);
        let mut invitation = fixture.invitation.clone();
        invitation.daemon_signature[0] ^= 1;
        assert_eq!(
            invitation.verify_with_clock(fixture.clock.as_ref()),
            Err(PairingError::InvalidSignature)
        );

        let mut claim = fixture.claim.clone();
        claim.device_signature[0] ^= 1;
        assert_eq!(
            claim.verify_with_clock(&fixture.invitation, fixture.clock.as_ref()),
            Err(PairingError::InvalidSignature)
        );

        let mut substituted_package = fixture.claim.clone();
        substituted_package.key_package[0] ^= 1;
        assert_eq!(
            substituted_package.verify_with_clock(&fixture.invitation, fixture.clock.as_ref()),
            Err(PairingError::InvalidSignature)
        );

        let other = transcript(5);
        let mut substituted_credential = fixture.claim.clone();
        substituted_credential.device_credential = other.claim.device_credential;
        assert_eq!(
            substituted_credential.verify_with_clock(&fixture.invitation, fixture.clock.as_ref()),
            Err(PairingError::IdentityMismatch)
        );

        let replacement_signer = SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap();
        let mut substituted_key = fixture.claim.clone();
        substituted_key.device_credential = PairingCredential::new(
            substituted_key.device_credential.identity().clone(),
            &replacement_signer,
        )
        .unwrap();
        substituted_key.device_signature = replacement_signer
            .sign(
                &substituted_key
                    .signature_input(&fixture.invitation)
                    .unwrap(),
            )
            .unwrap()
            .try_into()
            .unwrap();
        assert_eq!(
            substituted_key.verify_with_clock(&fixture.invitation, fixture.clock.as_ref()),
            Err(PairingError::IdentityMismatch)
        );
    }

    #[test]
    fn wrong_versions_profiles_identifiers_roles_and_nonce_are_rejected() {
        let fixture = transcript(6);
        let mut cases = Vec::new();
        let mut wrong = fixture.claim.clone();
        wrong.version = 2;
        cases.push((wrong, PairingError::WrongVersion));
        let mut wrong = fixture.claim.clone();
        wrong.profile_id = "other".into();
        cases.push((wrong, PairingError::WrongProfile));
        let mut wrong = fixture.claim.clone();
        wrong.profile_revision = 2;
        cases.push((wrong, PairingError::WrongProfileRevision));
        let mut wrong = fixture.claim.clone();
        wrong.account_id[0] ^= 1;
        cases.push((wrong, PairingError::IdentityMismatch));
        let mut wrong = fixture.claim.clone();
        wrong.installation_id[0] ^= 1;
        cases.push((wrong, PairingError::IdentityMismatch));
        let mut wrong = fixture.claim.clone();
        wrong.crypto_session_id[0] ^= 1;
        cases.push((wrong, PairingError::IdentityMismatch));
        let mut wrong = fixture.claim.clone();
        wrong.invitation_nonce_hash[0] ^= 1;
        cases.push((wrong, PairingError::NonceMismatch));
        for (claim, expected) in cases {
            assert_eq!(claim.validate_bindings(&fixture.invitation), Err(expected));
        }

        let device_signer = SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap();
        let device_as_daemon = PairingCredential::new(
            Identity::device(
                fixture.invitation.account_id,
                fixture.invitation.installation_id,
                uuid_v7(99),
            )
            .unwrap(),
            &device_signer,
        )
        .unwrap();
        let mut wrong_daemon_role = fixture.invitation.clone();
        wrong_daemon_role.daemon_credential = device_as_daemon;
        assert_eq!(
            wrong_daemon_role.validate_bindings(),
            Err(PairingError::IdentityMismatch)
        );

        let daemon_signer = SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap();
        let daemon_as_device = PairingCredential::new(
            Identity::daemon(
                fixture.invitation.account_id,
                fixture.invitation.installation_id,
            ),
            &daemon_signer,
        )
        .unwrap();
        let mut wrong_role = fixture.claim.clone();
        wrong_role.device_credential = daemon_as_device;
        assert_eq!(
            wrong_role.validate_bindings(&fixture.invitation),
            Err(PairingError::IdentityMismatch)
        );
        assert_eq!(
            Identity::device([1; 16], [2; 16], [0; 16]),
            Err(crate::Error::InvalidIdentity("device id must not be zero"))
        );

        let invitation_id_offset = 2 + 1 + PROFILE_ID.len() + 2 + 16;
        let mut invalid_installation_version = fixture.invitation.encode().unwrap();
        invalid_installation_version[invitation_id_offset + 6] = 0x60;
        assert_eq!(
            PairingInvitation::decode(&invalid_installation_version),
            Err(PairingError::IdentityMismatch)
        );
        let mut invalid_session_variant = fixture.invitation.encode().unwrap();
        invalid_session_variant[invitation_id_offset + 16 + 8] = 0x40;
        assert_eq!(
            PairingInvitation::decode(&invalid_session_variant),
            Err(PairingError::IdentityMismatch)
        );
        let invalid_device = Identity::device(
            fixture.invitation.account_id,
            fixture.invitation.installation_id,
            [0x11; 16],
        )
        .unwrap();
        let invalid_device_signer = SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap();
        let mut invalid_device_claim = fixture.claim.clone();
        invalid_device_claim.device_credential =
            PairingCredential::new(invalid_device, &invalid_device_signer).unwrap();
        assert_eq!(
            invalid_device_claim.validate_self(),
            Err(PairingError::IdentityMismatch)
        );
        let mut invalid_device_variant = fixture.claim.encode().unwrap();
        let credential_offset = 2 + 1 + PROFILE_ID.len() + 2 + (16 * 3) + 48 + 2;
        let credential_device_offset = 2 + 1 + 16 + 16;
        invalid_device_variant[credential_offset + credential_device_offset + 8] = 0x40;
        assert_eq!(
            PairingClaimV1::decode(&invalid_device_variant),
            Err(PairingError::IdentityMismatch)
        );

        let mut invalid_version = uuid_v7(100);
        invalid_version[6] = 0x60;
        assert_eq!(
            validate_uuid_v7(invalid_version),
            Err(PairingError::IdentityMismatch)
        );
        let mut invalid_variant = uuid_v7(101);
        invalid_variant[8] = 0x40;
        assert_eq!(
            validate_uuid_v7(invalid_variant),
            Err(PairingError::IdentityMismatch)
        );
    }

    #[test]
    fn exact_lifetime_expiry_extension_and_clock_rollback_fail_closed() {
        let fixture = transcript(7);
        fixture.clock.set(fixture.invitation.expires_at_ms - 1);
        fixture
            .invitation
            .verify_with_clock(fixture.clock.as_ref())
            .unwrap();
        fixture.clock.set(fixture.invitation.expires_at_ms);
        assert_eq!(
            fixture.invitation.verify_with_clock(fixture.clock.as_ref()),
            Err(PairingError::Expired)
        );

        let mut invalid = fixture.invitation.clone();
        invalid.expires_at_ms = invalid.issued_at_ms - 1;
        assert_eq!(
            invalid.validate_time_shape(),
            Err(PairingError::InvalidTime)
        );
        let mut extended = fixture.invitation.clone();
        extended.expires_at_ms += 1;
        assert_eq!(
            extended.validate_time_shape(),
            Err(PairingError::InvalidTime)
        );
        fixture.clock.set(fixture.invitation.issued_at_ms - 1);
        assert_eq!(
            fixture.invitation.verify_with_clock(fixture.clock.as_ref()),
            Err(PairingError::ClockRollback)
        );
    }

    #[test]
    fn comparison_is_first_39_bits_and_has_exact_grouping_with_leading_zeroes() {
        let mut fixture = transcript(8);
        let value = comparison_value(&fixture.invitation, &fixture.claim).unwrap();
        assert_eq!(value.len(), 15);
        assert_eq!(value.as_bytes()[3], b' ');
        assert_eq!(value.as_bytes()[7], b' ');
        assert_eq!(value.as_bytes()[11], b' ');
        assert!(value.bytes().filter(u8::is_ascii_digit).count() == 12);

        for byte in 0..=u8::MAX {
            fixture.claim.key_package[0] = byte;
            fixture.claim.device_signature = fixture
                .device_signer
                .sign(&fixture.claim.signature_input(&fixture.invitation).unwrap())
                .unwrap()
                .try_into()
                .unwrap();
            let candidate = comparison_value(&fixture.invitation, &fixture.claim).unwrap();
            if candidate.starts_with('0') {
                assert_eq!(candidate.len(), 15);
                return;
            }
        }
        panic!("expected a leading-zero comparison fixture");
    }

    #[test]
    fn failure_accounting_is_idempotent_and_cancels_on_five_distinct_eligible_claims() {
        let fixture = transcript(9);
        let mut accountant = PairingClaimAccountant::new_with_clock(
            fixture.invitation.clone(),
            fixture.clock.clone(),
        )
        .unwrap();
        let bytes = fixture.claim.encode().unwrap();
        assert_eq!(
            accountant.submit(&bytes, ClaimDecision::Failed(FailedClaimReason::Signature)),
            PublicClaimResult::Rejected
        );
        assert_eq!(
            accountant.submit(&bytes, ClaimDecision::Failed(FailedClaimReason::Signature)),
            PublicClaimResult::Rejected
        );
        assert_eq!(accountant.failed_claim_count(), 1);

        let mut malformed = bytes.clone();
        malformed.push(0);
        assert_eq!(
            accountant.submit(
                &malformed,
                ClaimDecision::Failed(FailedClaimReason::Signature)
            ),
            PublicClaimResult::Rejected
        );
        let mut wrong = bytes.clone();
        let account_offset = 2 + 1 + PROFILE_ID.len() + 2;
        wrong[account_offset] ^= 1;
        assert_eq!(
            accountant.submit(&wrong, ClaimDecision::Failed(FailedClaimReason::Signature)),
            PublicClaimResult::Rejected
        );
        assert_eq!(accountant.failed_claim_count(), 1);

        for index in 1..5 {
            let mut distinct = fixture.claim.clone();
            distinct.device_signature[index] ^= 1;
            let reason = match index {
                1 => FailedClaimReason::Credential,
                2 => FailedClaimReason::KeyPackage,
                _ => FailedClaimReason::Signature,
            };
            let result =
                accountant.submit(&distinct.encode().unwrap(), ClaimDecision::Failed(reason));
            assert_eq!(
                result,
                if index == 4 {
                    PublicClaimResult::Cancelled
                } else {
                    PublicClaimResult::Rejected
                }
            );
        }
        assert_eq!(accountant.failed_claim_count(), 5);
        assert_eq!(
            accountant.submit(&bytes, ClaimDecision::Failed(FailedClaimReason::Signature)),
            PublicClaimResult::Rejected
        );
        let mut sixth = fixture.claim.clone();
        sixth.device_signature[6] ^= 1;
        assert_eq!(
            accountant.submit(
                &sixth.encode().unwrap(),
                ClaimDecision::Failed(FailedClaimReason::Signature)
            ),
            PublicClaimResult::Cancelled
        );
        assert_eq!(accountant.failed_claim_count(), 5);
    }

    #[test]
    fn expired_cancelled_and_clock_rollback_requests_do_not_consume_attempts() {
        let expired = transcript(12);
        let bytes = expired.claim.encode().unwrap();
        let mut expired_accountant = PairingClaimAccountant::new_with_clock(
            expired.invitation.clone(),
            expired.clock.clone(),
        )
        .unwrap();
        expired.clock.set(expired.invitation.expires_at_ms + 1);
        assert_eq!(
            expired_accountant.submit(&bytes, ClaimDecision::Failed(FailedClaimReason::Signature)),
            PublicClaimResult::Rejected
        );
        assert_eq!(expired_accountant.failed_claim_count(), 0);

        let cancelled = transcript(13);
        let bytes = cancelled.claim.encode().unwrap();
        let mut cancelled_accountant =
            PairingClaimAccountant::new_with_clock(cancelled.invitation, cancelled.clock).unwrap();
        cancelled_accountant.cancel();
        assert_eq!(
            cancelled_accountant
                .submit(&bytes, ClaimDecision::Failed(FailedClaimReason::Signature)),
            PublicClaimResult::Cancelled
        );
        assert_eq!(cancelled_accountant.failed_claim_count(), 0);

        let rollback = transcript(14);
        let bytes = rollback.claim.encode().unwrap();
        let mut rollback_accountant =
            PairingClaimAccountant::new_with_clock(rollback.invitation, rollback.clock.clone())
                .unwrap();
        rollback.clock.set(999_999);
        assert_eq!(
            rollback_accountant.submit(&bytes, ClaimDecision::Failed(FailedClaimReason::Signature)),
            PublicClaimResult::Rejected
        );
        assert_eq!(rollback_accountant.failed_claim_count(), 0);
    }

    #[test]
    fn accountant_constructor_uses_one_clock_sample_for_validation_and_baseline() {
        let fixture = transcript(15);
        let clock = ScriptedClock::new([1_500_000, 1_400_000]);
        let accountant =
            PairingClaimAccountant::new_with_clock(fixture.invitation, clock.clone()).unwrap();

        assert_eq!(clock.calls.load(Ordering::SeqCst), 1);
        assert_eq!(accountant.last_now_ms, 1_500_000);
    }

    #[test]
    fn accepted_duplicate_recovers_exact_result_and_conflict_cannot_replace_it() {
        let fixture = transcript(10);
        let mut accountant = PairingClaimAccountant::new_with_clock(
            fixture.invitation.clone(),
            fixture.clock.clone(),
        )
        .unwrap();
        let bytes = fixture.claim.encode().unwrap();
        let accepted = AcceptedPairingResult::new(b"test-only exact accepted result").unwrap();
        assert_eq!(accepted.bytes(), b"test-only exact accepted result");
        assert_eq!(
            accountant.submit(&bytes, ClaimDecision::Accepted(accepted.clone())),
            PublicClaimResult::Accepted(accepted.clone())
        );
        accountant.mark_consumed().unwrap();
        assert_eq!(
            accountant.submit(&bytes, ClaimDecision::Failed(FailedClaimReason::Signature)),
            PublicClaimResult::Accepted(accepted.clone())
        );
        let mut conflicting = fixture.claim.clone();
        conflicting.device_signature[0] ^= 1;
        assert_eq!(
            accountant.submit(
                &conflicting.encode().unwrap(),
                ClaimDecision::Accepted(AcceptedPairingResult::new(b"replacement").unwrap())
            ),
            PublicClaimResult::Conflict
        );
        fixture.clock.set(fixture.invitation.expires_at_ms);
        assert_eq!(
            accountant.submit(&bytes, ClaimDecision::Accepted(accepted)),
            PublicClaimResult::Rejected
        );
    }

    fn maximum_claim_fixture() -> Vec<u8> {
        let mut bytes = Vec::with_capacity(PAIRING_CLAIM_MAX_BYTES);
        put_u16(&mut bytes, 1);
        put_u8_vector(&mut bytes, &[b'x'; 255], 255).unwrap();
        put_u16(&mut bytes, 1);
        bytes.extend_from_slice(&[1; 16 * 3]);
        bytes.extend_from_slice(&[2; 48]);
        put_u16_vector(
            &mut bytes,
            &[3; PAIRING_CREDENTIAL_MAX_BYTES],
            PAIRING_CREDENTIAL_MAX_BYTES,
        )
        .unwrap();
        put_u16_vector(
            &mut bytes,
            &[4; PAIRING_KEY_PACKAGE_MAX_BYTES],
            PAIRING_KEY_PACKAGE_MAX_BYTES,
        )
        .unwrap();
        bytes.extend_from_slice(&[5; 64]);
        assert_eq!(bytes.len(), PAIRING_CLAIM_MAX_BYTES);
        bytes
    }

    fn hex(bytes: &[u8]) -> String {
        const DIGITS: &[u8; 16] = b"0123456789abcdef";
        let mut value = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            value.push(DIGITS[(byte >> 4) as usize] as char);
            value.push(DIGITS[(byte & 0x0f) as usize] as char);
        }
        value
    }

    fn parse_hex<const N: usize>(value: &str) -> Result<[u8; N], &'static str> {
        if value.len() != N * 2 {
            return Err("wrong hex length");
        }
        let mut bytes = [0; N];
        for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
            let text = std::str::from_utf8(pair).map_err(|_| "non-UTF-8 hex")?;
            bytes[index] = u8::from_str_radix(text, 16).map_err(|_| "invalid hex")?;
        }
        Ok(bytes)
    }

    fn parse_fixture_manifest(text: &str) -> Result<BTreeMap<String, String>, &'static str> {
        const KEYS: [&str; 13] = [
            "profile_id",
            "profile_revision",
            "account_id",
            "installation_id",
            "crypto_session_id",
            "issued_at_ms",
            "expires_at_ms",
            "daemon_credential_sha384",
            "device_credential_sha384",
            "invitation_sha384",
            "claim_sha384",
            "comparison",
            "maximum_claim_bytes",
        ];
        let allowed = KEYS.into_iter().collect::<BTreeSet<_>>();
        let mut values = BTreeMap::new();
        for line in text.lines() {
            if line.starts_with('#') {
                continue;
            }
            let (key, value) = line.split_once('=').ok_or("malformed entry")?;
            if key.is_empty() || value.is_empty() || value.contains('=') {
                return Err("malformed entry");
            }
            if !allowed.contains(key) {
                return Err("unknown entry");
            }
            if values.insert(key.to_owned(), value.to_owned()).is_some() {
                return Err("duplicate entry");
            }
        }
        if values.len() != allowed.len() || allowed.iter().any(|key| !values.contains_key(*key)) {
            return Err("missing entry");
        }
        values["profile_revision"]
            .parse::<u16>()
            .map_err(|_| "invalid profile revision")?;
        parse_hex::<16>(&values["account_id"])?;
        parse_hex::<16>(&values["installation_id"])?;
        parse_hex::<16>(&values["crypto_session_id"])?;
        values["issued_at_ms"]
            .parse::<u64>()
            .map_err(|_| "invalid issue time")?;
        values["expires_at_ms"]
            .parse::<u64>()
            .map_err(|_| "invalid expiry time")?;
        parse_hex::<48>(&values["daemon_credential_sha384"])?;
        parse_hex::<48>(&values["device_credential_sha384"])?;
        parse_hex::<48>(&values["invitation_sha384"])?;
        parse_hex::<48>(&values["claim_sha384"])?;
        let groups = values["comparison"].split(' ').collect::<Vec<_>>();
        if groups.len() != 4
            || groups
                .iter()
                .any(|group| group.len() != 3 || !group.bytes().all(|byte| byte.is_ascii_digit()))
        {
            return Err("invalid comparison");
        }
        values["maximum_claim_bytes"]
            .parse::<usize>()
            .map_err(|_| "invalid maximum")?;
        Ok(values)
    }

    #[test]
    fn fixture_manifest_is_strict() {
        let valid = include_str!("../fixtures/v1/expected.txt");
        assert!(parse_fixture_manifest(valid).is_ok());
        assert_eq!(
            parse_fixture_manifest(&format!("{valid}profile_id={PROFILE_ID}\n")),
            Err("duplicate entry")
        );
        assert_eq!(
            parse_fixture_manifest(&format!("{valid}unknown=value\n")),
            Err("unknown entry")
        );
        assert_eq!(
            parse_fixture_manifest(&valid.replace(&format!("profile_id={PROFILE_ID}\n"), "")),
            Err("missing entry")
        );
        assert_eq!(
            parse_fixture_manifest(&valid.replace("profile_revision=1", "profile_revision=no")),
            Err("invalid profile revision")
        );
        assert_eq!(
            parse_fixture_manifest(&format!("{valid}malformed\n")),
            Err("malformed entry")
        );
    }

    #[test]
    fn checked_in_native_fixtures_match_the_canonical_transcript() {
        let invitation_bytes = include_bytes!("../fixtures/v1/pairing-invitation.tls");
        let claim_bytes = include_bytes!("../fixtures/v1/pairing-claim-v1.tls");
        let maximum_claim = include_bytes!("../fixtures/v1/pairing-claim-v1-maximum.tls");
        let expected = parse_fixture_manifest(include_str!("../fixtures/v1/expected.txt")).unwrap();
        let invitation = PairingInvitation::decode(invitation_bytes).unwrap();
        let claim = PairingClaimV1::decode(claim_bytes).unwrap();
        claim.verify_signature_and_bindings(&invitation).unwrap();

        assert_eq!(expected["profile_id"], invitation.profile_id());
        assert_eq!(
            expected["profile_revision"].parse::<u16>().unwrap(),
            invitation.profile_revision()
        );
        assert_eq!(
            parse_hex::<16>(&expected["account_id"]).unwrap(),
            invitation.account_id()
        );
        assert_eq!(
            parse_hex::<16>(&expected["installation_id"]).unwrap(),
            invitation.installation_id()
        );
        assert_eq!(
            parse_hex::<16>(&expected["crypto_session_id"]).unwrap(),
            invitation.crypto_session_id()
        );
        assert_eq!(
            expected["issued_at_ms"].parse::<u64>().unwrap(),
            invitation.issued_at_ms()
        );
        assert_eq!(
            expected["expires_at_ms"].parse::<u64>().unwrap(),
            invitation.expires_at_ms()
        );
        assert_eq!(
            parse_hex::<48>(&expected["daemon_credential_sha384"]).unwrap(),
            sha384(invitation.daemon_credential().bytes()).unwrap()
        );
        assert_eq!(
            parse_hex::<48>(&expected["device_credential_sha384"]).unwrap(),
            sha384(claim.device_credential().bytes()).unwrap()
        );
        assert_eq!(
            parse_hex::<48>(&expected["invitation_sha384"]).unwrap(),
            invitation.invitation_hash().unwrap()
        );
        assert_eq!(
            parse_hex::<48>(&expected["claim_sha384"]).unwrap(),
            claim.claim_hash().unwrap()
        );
        assert_eq!(
            expected["comparison"],
            comparison_value(&invitation, &claim).unwrap()
        );
        assert_eq!(
            expected["maximum_claim_bytes"].parse::<usize>().unwrap(),
            PAIRING_CLAIM_MAX_BYTES
        );
        assert_eq!(maximum_claim.len(), PAIRING_CLAIM_MAX_BYTES);
        assert_eq!(maximum_claim.as_slice(), maximum_claim_fixture());
    }

    #[test]
    fn generate_checked_in_native_fixtures() {
        if std::env::var_os("AXL_REGENERATE_PAIRING_FIXTURES").as_deref()
            != Some(std::ffi::OsStr::new("1"))
        {
            assert!(!include_bytes!("../fixtures/v1/pairing-invitation.tls").is_empty());
            assert!(!include_bytes!("../fixtures/v1/pairing-claim-v1.tls").is_empty());
            return;
        }
        let fixture = transcript(42);
        let invitation = fixture.invitation.encode().unwrap();
        let claim = fixture.claim.encode().unwrap();
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/v1");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("pairing-invitation.tls"), &invitation).unwrap();
        std::fs::write(directory.join("pairing-claim-v1.tls"), &claim).unwrap();
        std::fs::write(
            directory.join("pairing-claim-v1-maximum.tls"),
            maximum_claim_fixture(),
        )
        .unwrap();
        let metadata = format!(
            "# SPDX-FileCopyrightText: 2026 VishnuM449\n# SPDX-License-Identifier: Apache-2.0\n# Test-only native Rust pairing fixtures. No private signing key or standalone nonce is included.\nprofile_id={}\nprofile_revision={}\naccount_id={}\ninstallation_id={}\ncrypto_session_id={}\nissued_at_ms={}\nexpires_at_ms={}\ndaemon_credential_sha384={}\ndevice_credential_sha384={}\ninvitation_sha384={}\nclaim_sha384={}\ncomparison={}\nmaximum_claim_bytes={}\n",
            PROFILE_ID,
            PROFILE_REVISION,
            hex(&fixture.invitation.account_id),
            hex(&fixture.invitation.installation_id),
            hex(&fixture.invitation.crypto_session_id),
            fixture.invitation.issued_at_ms,
            fixture.invitation.expires_at_ms,
            hex(&sha384(fixture.invitation.daemon_credential.bytes()).unwrap()),
            hex(&sha384(fixture.claim.device_credential.bytes()).unwrap()),
            hex(&fixture.invitation.invitation_hash().unwrap()),
            hex(&fixture.claim.claim_hash().unwrap()),
            comparison_value(&fixture.invitation, &fixture.claim).unwrap(),
            PAIRING_CLAIM_MAX_BYTES,
        );
        std::fs::write(directory.join("expected.txt"), metadata).unwrap();
    }

    #[test]
    fn debug_and_public_errors_do_not_disclose_secret_material() {
        let fixture = transcript(11);
        let invitation_debug = format!("{:?}", fixture.invitation);
        let claim_debug = format!("{:?}", fixture.claim);
        assert!(invitation_debug.contains("[redacted]"));
        assert!(claim_debug.contains("[redacted]"));
        assert!(!invitation_debug.contains(&hex(&fixture.invitation.invitation_nonce)));
        assert!(!claim_debug.contains(&hex(fixture.claim.device_credential.bytes())));
        assert!(!claim_debug.contains(&hex(fixture.claim.key_package())));
        let error = PairingError::InvalidSignature.to_string();
        assert!(!error.contains("credential"));
        assert!(!error.contains("signature bytes"));
    }
}
