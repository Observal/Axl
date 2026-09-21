// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

//! Version-2 native witness persistence codecs.
//!
//! These codecs are intentionally not wired to endpoint mutators yet. They define and validate the
//! exact durable records that the later transaction runner will write atomically.

#![allow(dead_code)]

use openmls_traits::{OpenMlsProvider, crypto::OpenMlsCrypto as _};

use redb::{ReadableTable, TableDefinition, WriteTransaction};

use super::PersistenceError;
use crate::{CoreProvider, Id, SUITE, witness};

pub(super) const RECORD_VERSION: u16 = 2;
pub(super) const OPERATION_FINGERPRINT_DOMAIN: &[u8] = b"Axl endpoint operation fingerprint v2";
const PENDING_RECORD_MAX_BYTES: usize =
    witness::MAX_COMMITTED_TRANSITION_BYTES + witness::WITNESS_REQUEST_MAX_BYTES + 512;
const PENDING_WITNESS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("pending_witness_v2");
const CURRENT_PENDING_KEY: &[u8] = b"current";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub(super) enum WitnessRegistrationState {
    Unregistered = 0,
    Registered = 1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub(super) enum WitnessOperationDisposition {
    Pending = 1,
    Completed = 2,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub(super) enum ExactResultKind {
    EmptySuccess = 1,
    EnvelopeReference = 2,
    Receive = 3,
    PairingPublication = 4,
    PairingDecision = 5,
    ProtectedAcceptance = 6,
    Lifecycle = 7,
    AcknowledgementReference = 8,
}

impl TryFrom<u8> for ExactResultKind {
    type Error = PersistenceError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::EmptySuccess),
            2 => Ok(Self::EnvelopeReference),
            3 => Ok(Self::Receive),
            4 => Ok(Self::PairingPublication),
            5 => Ok(Self::PairingDecision),
            6 => Ok(Self::ProtectedAcceptance),
            7 => Ok(Self::Lifecycle),
            8 => Ok(Self::AcknowledgementReference),
            _ => Err(PersistenceError::Corrupt),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum ExactResult {
    EmptySuccess,
    EnvelopeReference(Id),
    Receive {
        operation_id: Id,
        plaintext: Vec<u8>,
    },
    PairingPublication(Vec<u8>),
    PairingDecision(Vec<u8>),
    ProtectedAcceptance(Vec<u8>),
    Lifecycle(Vec<u8>),
    AcknowledgementReference(Id),
}

impl ExactResult {
    pub(super) fn kind(&self) -> ExactResultKind {
        match self {
            Self::EmptySuccess => ExactResultKind::EmptySuccess,
            Self::EnvelopeReference(_) => ExactResultKind::EnvelopeReference,
            Self::Receive { .. } => ExactResultKind::Receive,
            Self::PairingPublication(_) => ExactResultKind::PairingPublication,
            Self::PairingDecision(_) => ExactResultKind::PairingDecision,
            Self::ProtectedAcceptance(_) => ExactResultKind::ProtectedAcceptance,
            Self::Lifecycle(_) => ExactResultKind::Lifecycle,
            Self::AcknowledgementReference(_) => ExactResultKind::AcknowledgementReference,
        }
    }

    pub(super) fn encode(&self) -> Result<Vec<u8>, PersistenceError> {
        let mut out = RECORD_VERSION.to_be_bytes().to_vec();
        out.push(self.kind() as u8);
        match self {
            Self::EmptySuccess => {}
            Self::EnvelopeReference(operation_id)
            | Self::AcknowledgementReference(operation_id) => out.extend_from_slice(operation_id),
            Self::Receive {
                operation_id,
                plaintext,
            } => {
                out.extend_from_slice(operation_id);
                put_bytes(&mut out, plaintext)?;
            }
            Self::PairingPublication(value)
            | Self::PairingDecision(value)
            | Self::ProtectedAcceptance(value)
            | Self::Lifecycle(value) => put_bytes(&mut out, value)?,
        }
        if out.len() > witness::MAX_RESULT_BYTES {
            return Err(PersistenceError::Corrupt);
        }
        Ok(out)
    }

    pub(super) fn decode(bytes: &[u8]) -> Result<Self, PersistenceError> {
        if bytes.len() > witness::MAX_RESULT_BYTES {
            return Err(PersistenceError::Corrupt);
        }
        let mut cursor = Cursor::new(bytes);
        require_version(&mut cursor)?;
        let kind = ExactResultKind::try_from(cursor.u8()?)?;
        let value = match kind {
            ExactResultKind::EmptySuccess => Self::EmptySuccess,
            ExactResultKind::EnvelopeReference => Self::EnvelopeReference(cursor.array()?),
            ExactResultKind::Receive => Self::Receive {
                operation_id: cursor.array()?,
                plaintext: cursor.bytes(witness::MAX_RESULT_BYTES)?.to_vec(),
            },
            ExactResultKind::PairingPublication => {
                Self::PairingPublication(cursor.nonempty_bytes(witness::MAX_RESULT_BYTES)?.to_vec())
            }
            ExactResultKind::PairingDecision => {
                Self::PairingDecision(cursor.nonempty_bytes(witness::MAX_RESULT_BYTES)?.to_vec())
            }
            ExactResultKind::ProtectedAcceptance => Self::ProtectedAcceptance(
                cursor.nonempty_bytes(witness::MAX_RESULT_BYTES)?.to_vec(),
            ),
            ExactResultKind::Lifecycle => {
                Self::Lifecycle(cursor.nonempty_bytes(witness::MAX_RESULT_BYTES)?.to_vec())
            }
            ExactResultKind::AcknowledgementReference => {
                Self::AcknowledgementReference(cursor.array()?)
            }
        };
        cursor.finish()?;
        if value.encode()? != bytes {
            return Err(PersistenceError::Corrupt);
        }
        Ok(value)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ConfirmedWitnessHead {
    pub counter: u64,
    pub commitment: [u8; 48],
    pub previous_certificate_hash: [u8; 48],
    pub registration: WitnessRegistrationState,
}

impl ConfirmedWitnessHead {
    pub(super) fn validate(&self) -> Result<(), PersistenceError> {
        let empty = self.counter == 0
            && self.commitment == [0; 48]
            && self.previous_certificate_hash == [0; 48]
            && self.registration == WitnessRegistrationState::Unregistered;
        let registered = self.counter > 0
            && self.commitment != [0; 48]
            && self.registration == WitnessRegistrationState::Registered;
        if empty || registered {
            Ok(())
        } else {
            Err(PersistenceError::Corrupt)
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct WitnessOperationIndex {
    pub operation_kind: u16,
    pub fingerprint: [u8; 48],
    pub generation: u64,
    pub disposition: WitnessOperationDisposition,
    pub exact_result_kind: ExactResultKind,
}

impl WitnessOperationIndex {
    pub(super) fn encode(&self) -> Result<Vec<u8>, PersistenceError> {
        if !(1..=32).contains(&self.operation_kind) || self.generation == 0 {
            return Err(PersistenceError::Corrupt);
        }
        let mut out = RECORD_VERSION.to_be_bytes().to_vec();
        out.extend_from_slice(&self.operation_kind.to_be_bytes());
        out.extend_from_slice(&self.fingerprint);
        out.extend_from_slice(&self.generation.to_be_bytes());
        out.push(self.disposition as u8);
        out.push(self.exact_result_kind as u8);
        Ok(out)
    }

    pub(super) fn decode(bytes: &[u8]) -> Result<Self, PersistenceError> {
        let (value, consumed) = Self::decode_prefix(bytes)?;
        if consumed != bytes.len() || value.encode()? != bytes {
            return Err(PersistenceError::Corrupt);
        }
        Ok(value)
    }

    pub(super) fn decode_prefix(bytes: &[u8]) -> Result<(Self, usize), PersistenceError> {
        let mut cursor = Cursor::new(bytes);
        require_version(&mut cursor)?;
        let value = Self {
            operation_kind: cursor.u16()?,
            fingerprint: cursor.array()?,
            generation: cursor.u64()?,
            disposition: match cursor.u8()? {
                1 => WitnessOperationDisposition::Pending,
                2 => WitnessOperationDisposition::Completed,
                _ => return Err(PersistenceError::Corrupt),
            },
            exact_result_kind: cursor.u8()?.try_into()?,
        };
        if !(1..=32).contains(&value.operation_kind) || value.generation == 0 {
            return Err(PersistenceError::Corrupt);
        }
        Ok((value, cursor.offset))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct DurableWitnessOperation {
    pub operation_id: Id,
    pub operation_kind: u16,
    pub fingerprint: [u8; 48],
    pub witness_request: Vec<u8>,
    pub request_hash: [u8; 48],
    pub committed_transition: Vec<u8>,
    pub confirmed_head: ConfirmedWitnessHead,
    pub successor_key_id: Id,
    pub obsolete_key_id: Option<Id>,
    pub disposition: WitnessOperationDisposition,
    pub exact_result_kind: ExactResultKind,
}

impl DurableWitnessOperation {
    pub(super) fn encode(&self) -> Result<Vec<u8>, PersistenceError> {
        self.validate()?;
        let mut out = RECORD_VERSION.to_be_bytes().to_vec();
        out.extend_from_slice(&self.operation_id);
        out.extend_from_slice(&self.operation_kind.to_be_bytes());
        out.extend_from_slice(&self.fingerprint);
        put_bytes(&mut out, &self.witness_request)?;
        out.extend_from_slice(&self.request_hash);
        put_bytes(&mut out, &self.committed_transition)?;
        out.extend_from_slice(&self.confirmed_head.counter.to_be_bytes());
        out.extend_from_slice(&self.confirmed_head.commitment);
        out.extend_from_slice(&self.confirmed_head.previous_certificate_hash);
        out.push(self.confirmed_head.registration as u8);
        out.extend_from_slice(&self.successor_key_id);
        put_optional_id(&mut out, self.obsolete_key_id);
        out.push(self.disposition as u8);
        out.push(self.exact_result_kind as u8);
        if out.len() > PENDING_RECORD_MAX_BYTES {
            return Err(PersistenceError::Corrupt);
        }
        Ok(out)
    }

    pub(super) fn decode(bytes: &[u8]) -> Result<Self, PersistenceError> {
        if bytes.len() > PENDING_RECORD_MAX_BYTES {
            return Err(PersistenceError::Corrupt);
        }
        let mut cursor = Cursor::new(bytes);
        require_version(&mut cursor)?;
        let operation_id = cursor.array()?;
        let operation_kind = cursor.u16()?;
        let fingerprint = cursor.array()?;
        let witness_request = cursor
            .nonempty_bytes(witness::WITNESS_REQUEST_MAX_BYTES)?
            .to_vec();
        let request_hash = cursor.array()?;
        let committed_transition = cursor
            .nonempty_bytes(witness::MAX_COMMITTED_TRANSITION_BYTES)?
            .to_vec();
        let confirmed_head = ConfirmedWitnessHead {
            counter: cursor.u64()?,
            commitment: cursor.array()?,
            previous_certificate_hash: cursor.array()?,
            registration: match cursor.u8()? {
                0 => WitnessRegistrationState::Unregistered,
                1 => WitnessRegistrationState::Registered,
                _ => return Err(PersistenceError::Corrupt),
            },
        };
        let successor_key_id = cursor.array()?;
        let obsolete_key_id = cursor.optional_id()?;
        let disposition = match cursor.u8()? {
            1 => WitnessOperationDisposition::Pending,
            2 => WitnessOperationDisposition::Completed,
            _ => return Err(PersistenceError::Corrupt),
        };
        let exact_result_kind = cursor.u8()?.try_into()?;
        cursor.finish()?;
        let value = Self {
            operation_id,
            operation_kind,
            fingerprint,
            witness_request,
            request_hash,
            committed_transition,
            confirmed_head,
            successor_key_id,
            obsolete_key_id,
            disposition,
            exact_result_kind,
        };
        value.validate()?;
        if value.encode()? != bytes {
            return Err(PersistenceError::Corrupt);
        }
        Ok(value)
    }

    pub(super) fn open_and_validate(
        &self,
        data_key: &[u8; 32],
        lineage: &witness::WitnessLineage,
        credential: &crate::pairing::PairingCredential,
        expected_generation: u64,
        expected_inner_state: &[u8],
        operation_index: &WitnessOperationIndex,
    ) -> Result<(), PersistenceError> {
        self.validate()?;
        let (transition, recovered) = witness::open_committed_transition(
            &self.committed_transition,
            data_key,
            lineage,
            credential,
        )
        .map_err(|_| PersistenceError::Corrupt)?;
        let exact_result = ExactResult::decode(&recovered.exact_result)?;
        if transition.operation_id != self.operation_id
            || transition.counter != recovered.request.proposed_counter().unwrap_or(0)
            || transition.generation != expected_generation
            || transition.generation != operation_index.generation
            || transition.current_key_id != self.successor_key_id
            || recovered.inner_state != expected_inner_state
            || recovered.request_bytes != self.witness_request
            || recovered.request_hash != self.request_hash
            || recovered.predecessor != self.confirmed_head.commitment
            || operation_index.operation_kind != self.operation_kind
            || operation_index.fingerprint != self.fingerprint
            || operation_index.disposition != self.disposition
            || operation_index.exact_result_kind != self.exact_result_kind
            || exact_result.kind() != self.exact_result_kind
        {
            return Err(PersistenceError::Corrupt);
        }
        Ok(())
    }

    fn validate(&self) -> Result<(), PersistenceError> {
        if self.operation_id == [0; 16]
            || !(1..=32).contains(&self.operation_kind)
            || self.successor_key_id == [0; 16]
            || self.obsolete_key_id == Some(self.successor_key_id)
            || self.witness_request.is_empty()
            || self.witness_request.len() > witness::WITNESS_REQUEST_MAX_BYTES
            || self.committed_transition.is_empty()
            || self.committed_transition.len() > witness::MAX_COMMITTED_TRANSITION_BYTES
        {
            return Err(PersistenceError::Corrupt);
        }
        self.confirmed_head.validate()?;
        let request = witness::WitnessRequest::decode(&self.witness_request)
            .map_err(|_| PersistenceError::Corrupt)?;
        if request.operation_id() != self.operation_id
            || request
                .request_hash()
                .map_err(|_| PersistenceError::Corrupt)?
                != self.request_hash
            || request.previous_certificate_hash() != self.confirmed_head.previous_certificate_hash
        {
            return Err(PersistenceError::Corrupt);
        }
        let transition = witness::inspect_committed_transition(&self.committed_transition)
            .map_err(|_| PersistenceError::Corrupt)?;
        if transition.operation_id != self.operation_id
            || transition.current_key_id != self.successor_key_id
        {
            return Err(PersistenceError::Corrupt);
        }
        let request_shape_matches = match request.kind() {
            witness::WitnessRequestKind::Register => {
                self.confirmed_head.registration == WitnessRegistrationState::Unregistered
                    && self.confirmed_head.counter == 0
                    && request.expected_counter().is_none()
                    && request.expected_commitment().is_none()
                    && request.proposed_counter() == Some(1)
                    && self.obsolete_key_id.is_none()
            }
            witness::WitnessRequestKind::Advance => {
                self.confirmed_head.registration == WitnessRegistrationState::Registered
                    && request.expected_counter() == Some(self.confirmed_head.counter)
                    && request.expected_commitment() == Some(self.confirmed_head.commitment)
                    && request.proposed_counter() == self.confirmed_head.counter.checked_add(1)
                    && self.obsolete_key_id.is_some()
            }
            witness::WitnessRequestKind::Read => false,
        };
        if !request_shape_matches || request.proposed_counter() != Some(transition.counter) {
            return Err(PersistenceError::Corrupt);
        }
        Ok(())
    }
}

pub(super) fn write_pending_operation(
    write: &WriteTransaction,
    operation: &DurableWitnessOperation,
) -> Result<(), PersistenceError> {
    let encoded = operation.encode()?;
    let mut table = write
        .open_table(PENDING_WITNESS)
        .map_err(|_| PersistenceError::Corrupt)?;
    if let Some(existing) = table
        .get(CURRENT_PENDING_KEY)
        .map_err(|_| PersistenceError::Storage)?
    {
        let existing = DurableWitnessOperation::decode(existing.value())?;
        if existing.operation_id != operation.operation_id
            || existing.fingerprint != operation.fingerprint
        {
            return Err(PersistenceError::Conflict);
        }
        let mut completed = existing.clone();
        completed.disposition = WitnessOperationDisposition::Completed;
        if existing != *operation && completed != *operation {
            return Err(PersistenceError::Corrupt);
        }
    }
    table
        .insert(CURRENT_PENDING_KEY, encoded.as_slice())
        .map_err(|_| PersistenceError::Storage)?;
    Ok(())
}

pub(super) fn read_pending_operation(
    database: &impl redb::ReadableDatabase,
) -> Result<Option<DurableWitnessOperation>, PersistenceError> {
    let read = database
        .begin_read()
        .map_err(|_| PersistenceError::Storage)?;
    let table = read
        .open_table(PENDING_WITNESS)
        .map_err(|_| PersistenceError::Corrupt)?;
    read_pending_operation_from_table(&table)
}

pub(super) fn read_pending_operation_from_table(
    table: &impl ReadableTable<&'static [u8], &'static [u8]>,
) -> Result<Option<DurableWitnessOperation>, PersistenceError> {
    let mut entries = table.iter().map_err(|_| PersistenceError::Storage)?;
    let Some(entry) = entries.next() else {
        return Ok(None);
    };
    let (key, value) = entry.map_err(|_| PersistenceError::Storage)?;
    if key.value() != CURRENT_PENDING_KEY || entries.next().is_some() {
        return Err(PersistenceError::Corrupt);
    }
    DurableWitnessOperation::decode(value.value()).map(Some)
}

pub(super) fn operation_fingerprint(
    operation_kind: u16,
    fields: &[&[u8]],
) -> Result<[u8; 48], PersistenceError> {
    if !(1..=32).contains(&operation_kind) {
        return Err(PersistenceError::Corrupt);
    }
    let mut input = OPERATION_FINGERPRINT_DOMAIN.to_vec();
    input.extend_from_slice(&operation_kind.to_be_bytes());
    for field in fields {
        let length = u32::try_from(field.len()).map_err(|_| PersistenceError::Corrupt)?;
        input.extend_from_slice(&length.to_be_bytes());
        input.extend_from_slice(field);
    }
    CoreProvider::new()
        .map_err(|_| PersistenceError::Storage)?
        .crypto()
        .hash(SUITE.hash_algorithm(), &input)
        .map_err(|_| PersistenceError::Storage)?
        .try_into()
        .map_err(|_| PersistenceError::Storage)
}

fn require_version(cursor: &mut Cursor<'_>) -> Result<(), PersistenceError> {
    if cursor.u16()? == RECORD_VERSION {
        Ok(())
    } else {
        Err(PersistenceError::UnsupportedSchema)
    }
}

fn put_bytes(out: &mut Vec<u8>, value: &[u8]) -> Result<(), PersistenceError> {
    let length = u32::try_from(value.len()).map_err(|_| PersistenceError::Corrupt)?;
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(value);
    Ok(())
}

fn put_optional_id(out: &mut Vec<u8>, value: Option<Id>) {
    match value {
        Some(value) => {
            out.push(1);
            out.extend_from_slice(&value);
        }
        None => out.push(0),
    }
}

struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], PersistenceError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(PersistenceError::Corrupt)?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or(PersistenceError::Corrupt)?;
        self.offset = end;
        Ok(value)
    }

    fn u8(&mut self) -> Result<u8, PersistenceError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, PersistenceError> {
        Ok(u16::from_be_bytes(self.array()?))
    }

    fn u32(&mut self) -> Result<u32, PersistenceError> {
        Ok(u32::from_be_bytes(self.array()?))
    }

    fn u64(&mut self) -> Result<u64, PersistenceError> {
        Ok(u64::from_be_bytes(self.array()?))
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], PersistenceError> {
        self.take(N)?
            .try_into()
            .map_err(|_| PersistenceError::Corrupt)
    }

    fn bytes(&mut self, maximum: usize) -> Result<&'a [u8], PersistenceError> {
        let length = self.u32()? as usize;
        if length > maximum {
            return Err(PersistenceError::Corrupt);
        }
        self.take(length)
    }

    fn nonempty_bytes(&mut self, maximum: usize) -> Result<&'a [u8], PersistenceError> {
        let value = self.bytes(maximum)?;
        if value.is_empty() {
            return Err(PersistenceError::Corrupt);
        }
        Ok(value)
    }

    fn optional_id(&mut self) -> Result<Option<Id>, PersistenceError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(self.array()?)),
            _ => Err(PersistenceError::Corrupt),
        }
    }

    fn finish(self) -> Result<(), PersistenceError> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err(PersistenceError::Corrupt)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use redb::{Database, Durability};
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };

    fn id(value: u8) -> Id {
        [value; 16]
    }

    fn uuid(value: u8) -> Id {
        let mut result = id(value);
        result[6] = 0x70 | (value & 0x0f);
        result[8] = 0x80 | (value & 0x3f);
        result
    }

    fn deterministic_transition(
        operation_id: Id,
        counter: u64,
        generation: u64,
        key_id: Id,
    ) -> Vec<u8> {
        let mut sealed = 1_u16.to_be_bytes().to_vec();
        sealed.push(crate::PROFILE_ID.len() as u8);
        sealed.extend_from_slice(crate::PROFILE_ID.as_bytes());
        sealed.extend_from_slice(&crate::PROFILE_REVISION.to_be_bytes());
        sealed.push(crate::Role::Device as u8);
        sealed.extend_from_slice(&id(1));
        sealed.extend_from_slice(&uuid(2));
        sealed.extend_from_slice(&uuid(3));
        sealed.extend_from_slice(&uuid(4));
        sealed.extend_from_slice(&counter.to_be_bytes());
        sealed.extend_from_slice(&generation.to_be_bytes());
        sealed.extend_from_slice(&7_u64.to_be_bytes());
        sealed.extend_from_slice(&[8; 48]);
        sealed.extend_from_slice(&key_id);
        sealed.extend_from_slice(&[9; 12]);
        sealed.extend_from_slice(&[10; 12]);
        put_bytes(&mut sealed, &[11]).unwrap();
        put_bytes(&mut sealed, &[12]).unwrap();

        let mut committed = 1_u16.to_be_bytes().to_vec();
        committed.extend_from_slice(&operation_id);
        put_bytes(&mut committed, &sealed).unwrap();
        committed
    }

    fn fixture() -> DurableWitnessOperation {
        let request_bytes = include_bytes!("../../fixtures/v1/witness-advance-v1.bin").to_vec();
        let request = witness::WitnessRequest::decode(&request_bytes).unwrap();
        let confirmed_head = ConfirmedWitnessHead {
            counter: request.expected_counter().unwrap(),
            commitment: request.expected_commitment().unwrap(),
            previous_certificate_hash: request.previous_certificate_hash(),
            registration: WitnessRegistrationState::Registered,
        };
        DurableWitnessOperation {
            operation_id: request.operation_id(),
            operation_kind: 12,
            fingerprint: operation_fingerprint(12, &[b"logical", &7_u64.to_be_bytes(), b"input"])
                .unwrap(),
            request_hash: request.request_hash().unwrap(),
            committed_transition: deterministic_transition(
                request.operation_id(),
                request.proposed_counter().unwrap(),
                9,
                id(44),
            ),
            witness_request: request_bytes,
            confirmed_head,
            successor_key_id: id(44),
            obsolete_key_id: Some(id(43)),
            disposition: WitnessOperationDisposition::Pending,
            exact_result_kind: ExactResultKind::EnvelopeReference,
        }
    }

    #[test]
    fn exact_result_tags_round_trip_canonically_and_enforce_bounds() {
        let values = [
            ExactResult::EmptySuccess,
            ExactResult::EnvelopeReference(id(1)),
            ExactResult::Receive {
                operation_id: id(2),
                plaintext: Vec::new(),
            },
            ExactResult::Receive {
                operation_id: id(3),
                plaintext: b"plain".to_vec(),
            },
            ExactResult::PairingPublication(b"publication".to_vec()),
            ExactResult::PairingDecision(b"decision".to_vec()),
            ExactResult::ProtectedAcceptance(b"acceptance".to_vec()),
            ExactResult::Lifecycle(b"lifecycle".to_vec()),
            ExactResult::AcknowledgementReference(id(4)),
        ];
        for value in values {
            let encoded = value.encode().unwrap();
            assert_eq!(ExactResult::decode(&encoded).unwrap(), value);
        }
        for invalid in [
            vec![],
            vec![0, 2],
            vec![0, 2, 99],
            vec![0, 2, ExactResultKind::EnvelopeReference as u8],
            vec![0, 2, ExactResultKind::EmptySuccess as u8, 0],
        ] {
            assert!(ExactResult::decode(&invalid).is_err());
        }
        let maximum = ExactResult::PairingPublication(vec![1; witness::MAX_RESULT_BYTES - 7])
            .encode()
            .unwrap();
        assert_eq!(maximum.len(), witness::MAX_RESULT_BYTES);
        assert_eq!(
            ExactResult::PairingPublication(vec![1; witness::MAX_RESULT_BYTES - 6])
                .encode()
                .unwrap_err(),
            PersistenceError::Corrupt
        );
        assert_eq!(
            ExactResult::decode(&vec![0; witness::MAX_RESULT_BYTES + 1]).unwrap_err(),
            PersistenceError::Corrupt
        );
    }

    #[test]
    fn pending_record_round_trips_and_binds_every_semantic_component() {
        let value = fixture();
        let encoded = value.encode().unwrap();
        assert_eq!(DurableWitnessOperation::decode(&encoded).unwrap(), value);

        let mut cases = Vec::new();
        let mut changed = value.clone();
        changed.operation_id[0] ^= 1;
        cases.push(changed);
        let mut changed = value.clone();
        changed.request_hash[0] ^= 1;
        cases.push(changed);
        let mut changed = value.clone();
        changed.confirmed_head.counter += 1;
        cases.push(changed);
        let mut changed = value.clone();
        changed.confirmed_head.commitment[0] ^= 1;
        cases.push(changed);
        let mut changed = value.clone();
        changed.confirmed_head.previous_certificate_hash[0] ^= 1;
        cases.push(changed);
        let mut changed = value.clone();
        changed.successor_key_id[0] ^= 1;
        cases.push(changed);
        let mut changed = value.clone();
        changed.obsolete_key_id = Some(changed.successor_key_id);
        cases.push(changed);
        let mut changed = value.clone();
        changed.witness_request[10] ^= 1;
        cases.push(changed);
        let mut changed = value.clone();
        changed.committed_transition[2] ^= 1;
        cases.push(changed);
        for changed in cases {
            assert!(changed.encode().is_err());
        }

        for end in 0..encoded.len() {
            assert!(DurableWitnessOperation::decode(&encoded[..end]).is_err());
        }
        let mut trailing = encoded;
        trailing.push(0);
        assert_eq!(
            DurableWitnessOperation::decode(&trailing).unwrap_err(),
            PersistenceError::Corrupt
        );
    }

    #[test]
    fn pending_and_completed_dispositions_and_fingerprint_fields_are_canonical() {
        let mut pending = fixture();
        let pending_bytes = pending.encode().unwrap();
        pending.disposition = WitnessOperationDisposition::Completed;
        let completed_bytes = pending.encode().unwrap();
        assert_ne!(pending_bytes, completed_bytes);
        assert_eq!(
            DurableWitnessOperation::decode(&completed_bytes)
                .unwrap()
                .disposition,
            WitnessOperationDisposition::Completed
        );

        let one = operation_fingerprint(12, &[b"a", b"bc"]).unwrap();
        let two = operation_fingerprint(12, &[b"ab", b"c"]).unwrap();
        let different_kind = operation_fingerprint(13, &[b"a", b"bc"]).unwrap();
        assert_ne!(one, two);
        assert_ne!(one, different_kind);
        assert_eq!(one, operation_fingerprint(12, &[b"a", b"bc"]).unwrap());
        assert!(operation_fingerprint(0, &[]).is_err());
        assert!(operation_fingerprint(33, &[]).is_err());

        for disposition in [
            WitnessOperationDisposition::Pending,
            WitnessOperationDisposition::Completed,
        ] {
            let index = WitnessOperationIndex {
                operation_kind: 12,
                fingerprint: one,
                generation: 9,
                disposition,
                exact_result_kind: ExactResultKind::Lifecycle,
            };
            let encoded = index.encode().unwrap();
            assert_eq!(WitnessOperationIndex::decode(&encoded).unwrap(), index);
            assert!(WitnessOperationIndex::decode(&encoded[..encoded.len() - 1]).is_err());
        }
    }

    #[test]
    fn native_state_v2_codecs_reject_old_new_duplicate_truncated_and_oversized_values() {
        use super::super::{
            MAX_STATE_BYTES, STATE_FORMAT_VERSION, SealedState, decode_storage_image,
            encode_storage_image,
        };
        use std::collections::BTreeMap;

        assert_eq!(STATE_FORMAT_VERSION, 2);
        let values = BTreeMap::from([
            (b"a".to_vec(), b"one".to_vec()),
            (b"b".to_vec(), b"two".to_vec()),
        ]);
        let encoded = encode_storage_image(&values).unwrap();
        assert_eq!(decode_storage_image(&encoded).unwrap(), values);
        for version in [1_u16, 3_u16] {
            let mut changed = encoded.clone();
            changed[..2].copy_from_slice(&version.to_be_bytes());
            assert_eq!(
                decode_storage_image(&changed).unwrap_err(),
                PersistenceError::UnsupportedSchema
            );
        }
        for end in 0..encoded.len() {
            assert!(decode_storage_image(&encoded[..end]).is_err());
        }
        let mut duplicate = RECORD_VERSION.to_be_bytes().to_vec();
        duplicate.extend_from_slice(&2_u32.to_be_bytes());
        for _ in 0..2 {
            put_bytes(&mut duplicate, b"same").unwrap();
            put_bytes(&mut duplicate, b"value").unwrap();
        }
        assert_eq!(
            decode_storage_image(&duplicate).unwrap_err(),
            PersistenceError::Corrupt
        );
        assert_eq!(
            decode_storage_image(&vec![0; MAX_STATE_BYTES + 1]).unwrap_err(),
            PersistenceError::Corrupt
        );

        let sealed = SealedState {
            key_id: id(9),
            nonce: [8; 12],
            ciphertext: vec![7; 16],
        };
        let sealed_bytes = sealed.encode().unwrap();
        assert_eq!(SealedState::decode(&sealed_bytes).unwrap().key_id, id(9));
        for version in [1_u16, 3_u16] {
            let mut changed = sealed_bytes.clone();
            changed[..2].copy_from_slice(&version.to_be_bytes());
            assert_eq!(
                SealedState::decode(&changed).unwrap_err(),
                PersistenceError::UnsupportedSchema
            );
        }
    }

    #[test]
    fn opening_committed_transition_authenticates_locator_and_distinct_counter_generation() {
        use openmls_basic_credential::SignatureKeyPair;

        let signer = SignatureKeyPair::new(crate::SUITE.signature_algorithm()).unwrap();
        let identity = crate::Identity::device(id(1), uuid(2), uuid(3)).unwrap();
        let lineage = witness::WitnessLineage::from_identity(&identity, uuid(4)).unwrap();
        let credential = crate::pairing::PairingCredential::new(identity, &signer).unwrap();
        let operation_id = id(15);
        let exact_result = ExactResult::Receive {
            operation_id,
            plaintext: Vec::new(),
        }
        .encode()
        .unwrap();
        let inner_state = b"authenticated inner state";
        let data_key = [16; 32];
        let prepared = witness::prepare_transition(witness::TransitionMaterial {
            lineage: lineage.clone(),
            counter: 2,
            generation: 9,
            epoch: 7,
            epoch_authenticator: [11; 48],
            current_key_id: id(44),
            predecessor_commitment: [13; 48],
            previous_certificate_hash: [14; 48],
            operation_id,
            inner_state,
            exact_result: &exact_result,
            data_key: &data_key,
            credential: &credential,
            signer: &signer,
        })
        .unwrap();
        let committed_transition = prepared.committed_record().unwrap();
        let (transition, recovered) = witness::open_committed_transition(
            &committed_transition,
            &data_key,
            &lineage,
            &credential,
        )
        .unwrap();
        assert_eq!(transition.counter, 2);
        assert_eq!(transition.generation, 9);
        let fingerprint = operation_fingerprint(12, &[b"input"]).unwrap();
        let locator = DurableWitnessOperation {
            operation_id,
            operation_kind: 12,
            fingerprint,
            witness_request: recovered.request_bytes,
            request_hash: recovered.request_hash,
            committed_transition,
            confirmed_head: ConfirmedWitnessHead {
                counter: 1,
                commitment: [13; 48],
                previous_certificate_hash: [14; 48],
                registration: WitnessRegistrationState::Registered,
            },
            successor_key_id: id(44),
            obsolete_key_id: Some(id(43)),
            disposition: WitnessOperationDisposition::Pending,
            exact_result_kind: ExactResultKind::Receive,
        };
        let index = WitnessOperationIndex {
            operation_kind: 12,
            fingerprint,
            generation: 9,
            disposition: WitnessOperationDisposition::Pending,
            exact_result_kind: ExactResultKind::Receive,
        };
        locator
            .open_and_validate(&data_key, &lineage, &credential, 9, inner_state, &index)
            .unwrap();

        let mut wrong = locator.clone();
        wrong.request_hash[0] ^= 1;
        assert!(
            wrong
                .open_and_validate(&data_key, &lineage, &credential, 9, inner_state, &index)
                .is_err()
        );
        let mut wrong = locator.clone();
        let last = wrong.committed_transition.len() - 1;
        wrong.committed_transition[last] ^= 1;
        assert!(
            wrong
                .open_and_validate(&data_key, &lineage, &credential, 9, inner_state, &index)
                .is_err()
        );
        let mut wrong_index = index.clone();
        wrong_index.fingerprint[0] ^= 1;
        assert!(
            locator
                .open_and_validate(
                    &data_key,
                    &lineage,
                    &credential,
                    9,
                    inner_state,
                    &wrong_index,
                )
                .is_err()
        );
        assert!(
            locator
                .open_and_validate(&data_key, &lineage, &credential, 10, inner_state, &index,)
                .is_err()
        );
        assert!(
            locator
                .open_and_validate(&data_key, &lineage, &credential, 9, b"other state", &index,)
                .is_err()
        );
    }

    #[test]
    fn clear_witness_header_fields_are_bound_into_state_aad() {
        use super::super::{
            META, META_CONFIRMED_WITNESS_COMMITMENT, META_CONFIRMED_WITNESS_COUNTER,
            META_CURRENT_KEY_ID, META_EPOCH, META_EPOCH_AUTHENTICATOR, META_GENERATION,
            META_OBSOLETE_KEY_ID, META_PREVIOUS_CERTIFICATE_HASH, META_PROFILE,
            META_PROFILE_REVISION, META_ROLLBACK_COUNTER, META_SESSION, META_WITNESS_REGISTRATION,
            state_aad,
        };

        let path = std::env::temp_dir().join(format!(
            "axl-native-witness-aad-v2-{}.redb",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        let database = Database::create(&path).unwrap();
        let write = database.begin_write().unwrap();
        let mut meta = write.open_table(META).unwrap();
        for (key, value) in [
            (META_SESSION, uuid(4).to_vec()),
            (META_PROFILE, crate::PROFILE_ID.as_bytes().to_vec()),
            (
                META_PROFILE_REVISION,
                crate::PROFILE_REVISION.to_be_bytes().to_vec(),
            ),
            (META_GENERATION, 9_u64.to_be_bytes().to_vec()),
            (META_ROLLBACK_COUNTER, 4_u64.to_be_bytes().to_vec()),
            (META_EPOCH, 7_u64.to_be_bytes().to_vec()),
            (META_EPOCH_AUTHENTICATOR, vec![8; 48]),
            (META_CONFIRMED_WITNESS_COUNTER, 3_u64.to_be_bytes().to_vec()),
            (META_CONFIRMED_WITNESS_COMMITMENT, vec![9; 48]),
            (META_PREVIOUS_CERTIFICATE_HASH, vec![10; 48]),
            (META_WITNESS_REGISTRATION, vec![1]),
            (META_CURRENT_KEY_ID, id(11).to_vec()),
            (META_OBSOLETE_KEY_ID, id(12).to_vec()),
        ] {
            meta.insert(key, value.as_slice()).unwrap();
        }
        let expected = state_aad(&meta).unwrap();
        drop(meta);
        write.commit().unwrap();

        for (key, replacement) in [
            (META_CONFIRMED_WITNESS_COUNTER, 4_u64.to_be_bytes().to_vec()),
            (META_CONFIRMED_WITNESS_COMMITMENT, vec![19; 48]),
            (META_PREVIOUS_CERTIFICATE_HASH, vec![20; 48]),
            (META_WITNESS_REGISTRATION, vec![0]),
            (META_CURRENT_KEY_ID, id(21).to_vec()),
            (META_OBSOLETE_KEY_ID, id(22).to_vec()),
        ] {
            let write = database.begin_write().unwrap();
            let mut meta = write.open_table(META).unwrap();
            let original = meta.get(key).unwrap().unwrap().value().to_vec();
            meta.insert(key, replacement.as_slice()).unwrap();
            assert_ne!(state_aad(&meta).unwrap(), expected);
            meta.insert(key, original.as_slice()).unwrap();
            drop(meta);
            write.abort().unwrap();
        }
        drop(database);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn pending_reader_rejects_non_current_and_duplicate_entries() {
        let path = std::env::temp_dir().join(format!(
            "axl-native-witness-cardinality-v2-{}.redb",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        let database = Database::create(&path).unwrap();
        let schema = database.begin_write().unwrap();
        schema.open_table(PENDING_WITNESS).unwrap();
        schema.commit().unwrap();
        let encoded = fixture().encode().unwrap();

        let write = database.begin_write().unwrap();
        write
            .open_table(PENDING_WITNESS)
            .unwrap()
            .insert(b"other".as_slice(), encoded.as_slice())
            .unwrap();
        write.commit().unwrap();
        assert_eq!(
            read_pending_operation(&database).unwrap_err(),
            PersistenceError::Corrupt
        );

        let write = database.begin_write().unwrap();
        let mut table = write.open_table(PENDING_WITNESS).unwrap();
        table.remove(b"other".as_slice()).unwrap();
        table
            .insert(CURRENT_PENDING_KEY, encoded.as_slice())
            .unwrap();
        table
            .insert(b"second".as_slice(), encoded.as_slice())
            .unwrap();
        drop(table);
        write.commit().unwrap();
        assert_eq!(
            read_pending_operation(&database).unwrap_err(),
            PersistenceError::Corrupt
        );
        drop(database);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn exact_transition_survives_abort_uncertain_commit_and_restart_byte_identically() {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "axl-native-witness-v2-{}-{}.redb",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let operation = fixture();
        let expected_transition = operation.committed_transition.clone();
        let database = Database::create(&path).unwrap();
        let mut schema = database.begin_write().unwrap();
        schema.set_durability(Durability::Immediate).unwrap();
        schema.set_two_phase_commit(true);
        schema.open_table(PENDING_WITNESS).unwrap();
        schema.commit().unwrap();

        let mut aborted = database.begin_write().unwrap();
        aborted.set_durability(Durability::Immediate).unwrap();
        aborted.set_two_phase_commit(true);
        write_pending_operation(&aborted, &operation).unwrap();
        aborted.abort().unwrap();
        assert!(read_pending_operation(&database).unwrap().is_none());

        let mut uncertain = database.begin_write().unwrap();
        uncertain.set_durability(Durability::Immediate).unwrap();
        uncertain.set_two_phase_commit(true);
        write_pending_operation(&uncertain, &operation).unwrap();
        uncertain.commit().unwrap();
        drop(database);

        let reopened = Database::open(&path).unwrap();
        let recovered = read_pending_operation(&reopened).unwrap().unwrap();
        assert_eq!(recovered, operation);
        assert_eq!(recovered.committed_transition, expected_transition);

        let mut completed = recovered.clone();
        completed.disposition = WitnessOperationDisposition::Completed;
        let write = reopened.begin_write().unwrap();
        write_pending_operation(&write, &completed).unwrap();
        write.commit().unwrap();
        assert_eq!(
            read_pending_operation(&reopened)
                .unwrap()
                .unwrap()
                .disposition,
            WitnessOperationDisposition::Completed
        );

        let mut conflict = completed.clone();
        conflict.fingerprint[0] ^= 1;
        let write = reopened.begin_write().unwrap();
        assert_eq!(
            write_pending_operation(&write, &conflict).unwrap_err(),
            PersistenceError::Conflict
        );
        write.abort().unwrap();
        let write = reopened.begin_write().unwrap();
        assert_eq!(
            write_pending_operation(&write, &operation).unwrap_err(),
            PersistenceError::Corrupt
        );
        write.abort().unwrap();
        drop(reopened);
        fs::remove_file(path).unwrap();
    }
}
