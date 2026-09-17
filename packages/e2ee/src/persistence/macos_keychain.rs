// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

//! macOS data-protection Keychain envelope-key storage.
//!
//! The production constructor is available only on macOS. Every operation selects the
//! data-protection Keychain, non-synchronizable generic-password items, and non-interactive
//! authentication. The secret value contains the complete authenticated record. Public Keychain
//! attributes contain only its format version, session identifier, key identifier, and lifecycle.

use std::{collections::BTreeSet, fmt, fs, os::unix::fs::MetadataExt, sync::Arc};

use core_foundation::{
    base::{TCFType as _, ToVoid as _},
    boolean::CFBoolean,
    data::CFData,
    dictionary::CFMutableDictionary,
};
use openmls_traits::{OpenMlsProvider, crypto::OpenMlsCrypto as _};
#[allow(deprecated)]
use security_framework::item::add_item;
use security_framework::{
    access_control::{ProtectionMode, SecAccessControl},
    item::{
        CloudSync, ItemAddOptions, ItemAddValue, ItemClass, ItemSearchOptions, Limit, Location,
        SearchResult,
    },
};
use security_framework_sys::item::{kSecAttrAccessControl, kSecAttrSynchronizable};

use super::{EnvelopeKeyStore, PersistenceError};
use crate::{CoreProvider, Id, SUITE};

const RECORD_FORMAT_VERSION: u16 = 1;
const PLATFORM_MACOS: u8 = 1;
const RECORD_BYTES: usize = 2 + 1 + 16 + 16 + 48 + 1 + 32;
const PRODUCTION_SERVICE: &str = "ai.observal.axl.e2ee.envelope-key.v1";
const ACCESSIBLE_WHEN_UNLOCKED_THIS_DEVICE_ONLY: &str = "aku";
const MAX_SERVICE_ITEMS: usize = 4096;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
enum Lifecycle {
    Prepared = 1,
    Active = 2,
}

impl Lifecycle {
    fn name(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::Active => "active",
        }
    }

    fn decode(value: u8) -> Result<Self, PersistenceError> {
        match value {
            1 => Ok(Self::Prepared),
            2 => Ok(Self::Active),
            _ => Err(PersistenceError::Corrupt),
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
struct KeyRecord {
    crypto_session_id: Id,
    key_id: Id,
    context_hash: [u8; 48],
    lifecycle: Lifecycle,
    data_key: [u8; 32],
}

impl fmt::Debug for KeyRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KeyRecord")
            .field("format_version", &RECORD_FORMAT_VERSION)
            .field("platform", &"macos")
            .field("crypto_session_id", &"[redacted]")
            .field("key_id", &"[redacted]")
            .field("context_hash", &"[redacted]")
            .field("lifecycle", &self.lifecycle)
            .field("data_key", &"[redacted]")
            .finish()
    }
}

impl KeyRecord {
    fn encode(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(RECORD_BYTES);
        bytes.extend_from_slice(&RECORD_FORMAT_VERSION.to_be_bytes());
        bytes.push(PLATFORM_MACOS);
        bytes.extend_from_slice(&self.crypto_session_id);
        bytes.extend_from_slice(&self.key_id);
        bytes.extend_from_slice(&self.context_hash);
        bytes.push(self.lifecycle as u8);
        bytes.extend_from_slice(&self.data_key);
        debug_assert_eq!(bytes.len(), RECORD_BYTES);
        bytes
    }

    fn decode(bytes: &[u8]) -> Result<Self, PersistenceError> {
        if bytes.len() != RECORD_BYTES {
            return Err(PersistenceError::Corrupt);
        }
        let format = u16::from_be_bytes(
            bytes[0..2]
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?,
        );
        if format != RECORD_FORMAT_VERSION || bytes[2] != PLATFORM_MACOS {
            return Err(PersistenceError::Corrupt);
        }
        Ok(Self {
            crypto_session_id: bytes[3..19]
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?,
            key_id: bytes[19..35]
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?,
            context_hash: bytes[35..83]
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?,
            lifecycle: Lifecycle::decode(bytes[83])?,
            data_key: bytes[84..116]
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?,
        })
    }

    fn validate_binding(
        &self,
        crypto_session_id: Id,
        key_id: Id,
        context_hash: Option<[u8; 48]>,
        lifecycle: Lifecycle,
    ) -> Result<(), PersistenceError> {
        if self.crypto_session_id != crypto_session_id
            || self.key_id != key_id
            || self.lifecycle != lifecycle
            || context_hash.is_some_and(|expected| self.context_hash != expected)
        {
            return Err(PersistenceError::Corrupt);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PublicIdentity {
    account: String,
    label: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InsertOutcome {
    Inserted,
    Duplicate,
}

trait KeychainAccess: Send + Sync {
    fn identity_available(&self) -> bool;
    fn list_identities(&self, service: &str) -> Result<Vec<PublicIdentity>, PersistenceError>;
    fn read_values(&self, service: &str, account: &str) -> Result<Vec<Vec<u8>>, PersistenceError>;
    fn insert(
        &self,
        service: &str,
        identity: &PublicIdentity,
        value: &[u8],
    ) -> Result<InsertOutcome, PersistenceError>;
    fn delete(&self, service: &str, account: &str) -> Result<(), PersistenceError>;
}

struct SecurityFrameworkKeychain;

impl SecurityFrameworkKeychain {
    fn search(service: &str, account: Option<&str>, data: bool) -> ItemSearchOptions {
        let mut search = ItemSearchOptions::new();
        search
            .class(ItemClass::generic_password())
            .service(service)
            .cloud_sync(CloudSync::MatchSyncNo)
            .ignore_legacy_keychains()
            .skip_authenticated_items(true)
            .limit(Limit::All);
        if let Some(account) = account {
            search.account(account);
        }
        if data {
            search.load_data(true);
        } else {
            search.load_attributes(true);
        }
        search
    }

    fn exact_query(service: &str, account: &str) -> ItemSearchOptions {
        let mut search = ItemSearchOptions::new();
        search
            .class(ItemClass::generic_password())
            .service(service)
            .account(account)
            .cloud_sync(CloudSync::MatchSyncNo)
            .ignore_legacy_keychains()
            .skip_authenticated_items(true);
        search
    }

    fn search_results(search: &ItemSearchOptions) -> Result<Vec<SearchResult>, PersistenceError> {
        match search.search() {
            Ok(results) => Ok(results),
            Err(error) if error.code() == -25300 => Ok(Vec::new()),
            Err(error) => Err(map_security_error(error)),
        }
    }
}

impl KeychainAccess for SecurityFrameworkKeychain {
    fn identity_available(&self) -> bool {
        interactive_user_identity_available()
    }

    fn list_identities(&self, service: &str) -> Result<Vec<PublicIdentity>, PersistenceError> {
        require_interactive_user_identity()?;
        let results = Self::search_results(&Self::search(service, None, false))?;
        if results.len() > MAX_SERVICE_ITEMS {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        results
            .into_iter()
            .map(|result| {
                let attributes = result.simplify_dict().ok_or(PersistenceError::Corrupt)?;
                let account = attributes
                    .get("acct")
                    .cloned()
                    .ok_or(PersistenceError::Corrupt)?;
                let label = attributes
                    .get("labl")
                    .cloned()
                    .ok_or(PersistenceError::Corrupt)?;
                if attributes.get("svce").map(String::as_str) != Some(service)
                    || attributes.get("pdmn").map(String::as_str)
                        != Some(ACCESSIBLE_WHEN_UNLOCKED_THIS_DEVICE_ONLY)
                {
                    return Err(PersistenceError::SecureStoreAccessDenied);
                }
                Ok(PublicIdentity { account, label })
            })
            .collect()
    }

    fn read_values(&self, service: &str, account: &str) -> Result<Vec<Vec<u8>>, PersistenceError> {
        require_interactive_user_identity()?;
        Self::search_results(&Self::search(service, Some(account), true))?
            .into_iter()
            .map(|result| match result {
                SearchResult::Data(value) => Ok(value),
                _ => Err(PersistenceError::Corrupt),
            })
            .collect()
    }

    fn insert(
        &self,
        service: &str,
        identity: &PublicIdentity,
        value: &[u8],
    ) -> Result<InsertOutcome, PersistenceError> {
        require_interactive_user_identity()?;
        let access = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            0,
        )
        .map_err(map_security_error)?;
        let mut options = ItemAddOptions::new(ItemAddValue::Data {
            class: ItemClass::generic_password(),
            data: CFData::from_buffer(value),
        });
        options
            .set_service(service)
            .set_account_name(&identity.account)
            .set_label(&identity.label)
            .set_location(Location::DataProtectionKeychain);
        #[allow(deprecated)]
        let base = options.to_dictionary();
        let mut query = CFMutableDictionary::from(&base);
        unsafe {
            query.add(
                &kSecAttrAccessControl.to_void(),
                &access.as_CFType().to_void(),
            );
            query.add(
                &kSecAttrSynchronizable.to_void(),
                &CFBoolean::false_value().to_void(),
            );
        }
        #[allow(deprecated)]
        match add_item(query.to_immutable()) {
            Ok(()) => Ok(InsertOutcome::Inserted),
            Err(error) if error.code() == -25299 => Ok(InsertOutcome::Duplicate),
            Err(error) => Err(map_security_error(error)),
        }
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), PersistenceError> {
        require_interactive_user_identity()?;
        let search = Self::exact_query(service, account);
        match search.delete() {
            Ok(()) => Ok(()),
            Err(error) if error.code() == -25300 => Ok(()),
            Err(error) => Err(map_security_error(error)),
        }
    }
}

/// Production macOS envelope-key store backed only by the data-protection Keychain.
///
/// Construction rejects root and processes outside the active console user's login session.
/// Keychain operations never permit authentication UI and never fall back to another store.
#[derive(Clone)]
pub(crate) struct MacOsKeychainEnvelopeKeyStore {
    service: String,
    keychain: Arc<dyn KeychainAccess>,
}

impl MacOsKeychainEnvelopeKeyStore {
    /// Construct the fixed production store for the active per-user daemon identity.
    pub(crate) fn new() -> Result<Self, PersistenceError> {
        require_interactive_user_identity()?;
        Ok(Self {
            service: PRODUCTION_SERVICE.to_owned(),
            keychain: Arc::new(SecurityFrameworkKeychain),
        })
    }

    /// Generic-password Keychain records do not establish Secure Enclave backing.
    pub(crate) const fn hardware_backing(&self) -> bool {
        false
    }

    #[cfg(test)]
    fn with_keychain(service: String, keychain: Arc<dyn KeychainAccess>) -> Self {
        Self { service, keychain }
    }

    fn identities_for_session(
        &self,
        crypto_session_id: Id,
    ) -> Result<Vec<(PublicIdentity, Id, Lifecycle)>, PersistenceError> {
        let mut seen = BTreeSet::new();
        let mut matching = Vec::new();
        for identity in self.keychain.list_identities(&self.service)? {
            if identity.account != identity.label {
                return Err(PersistenceError::Corrupt);
            }
            let (session, key_id, lifecycle) = decode_public_identity(&identity.account)?;
            if !seen.insert(identity.account.clone()) {
                return Err(PersistenceError::SecureStoreAmbiguous);
            }
            if session == crypto_session_id {
                matching.push((identity, key_id, lifecycle));
            }
        }
        Ok(matching)
    }

    fn records_for_key(
        &self,
        crypto_session_id: Id,
        key_id: Id,
    ) -> Result<Vec<(PublicIdentity, KeyRecord)>, PersistenceError> {
        let public_items = self.keychain.list_identities(&self.service)?;
        let mut records = Vec::new();
        for lifecycle in [Lifecycle::Prepared, Lifecycle::Active] {
            let identity = public_identity(crypto_session_id, key_id, lifecycle);
            let matching: Vec<_> = public_items
                .iter()
                .filter(|stored| stored.account == identity.account)
                .collect();
            if matching.len() > 1 {
                return Err(PersistenceError::SecureStoreAmbiguous);
            }
            if matching.first().is_some_and(|stored| *stored != &identity) {
                return Err(PersistenceError::Corrupt);
            }
            let values = self
                .keychain
                .read_values(&self.service, &identity.account)?;
            if values.len() != matching.len() {
                return Err(PersistenceError::SecureStoreAmbiguous);
            }
            if let Some(mut bytes) = values.into_iter().next() {
                let decoded = KeyRecord::decode(&bytes);
                bytes.fill(0);
                let record = decoded?;
                record.validate_binding(crypto_session_id, key_id, None, lifecycle)?;
                records.push((identity, record));
            }
        }
        Ok(records)
    }

    fn exact_record(
        &self,
        crypto_session_id: Id,
        key_id: Id,
        lifecycle: Lifecycle,
        context_hash: Option<[u8; 48]>,
    ) -> Result<Option<KeyRecord>, PersistenceError> {
        let identity = public_identity(crypto_session_id, key_id, lifecycle);
        let identities: Vec<_> = self
            .keychain
            .list_identities(&self.service)?
            .into_iter()
            .filter(|stored| stored.account == identity.account)
            .collect();
        if identities.len() > 1 {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        if identities.first().is_some_and(|stored| stored != &identity) {
            return Err(PersistenceError::Corrupt);
        }
        let values = self
            .keychain
            .read_values(&self.service, &identity.account)?;
        if values.len() != identities.len() {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        let Some(mut bytes) = values.into_iter().next() else {
            return Ok(None);
        };
        let decoded = KeyRecord::decode(&bytes);
        bytes.fill(0);
        let record = decoded?;
        record.validate_binding(crypto_session_id, key_id, context_hash, lifecycle)?;
        Ok(Some(record))
    }

    fn delete_and_verify(
        &self,
        crypto_session_id: Id,
        key_id: Id,
        lifecycle: Lifecycle,
    ) -> Result<(), PersistenceError> {
        let identity = public_identity(crypto_session_id, key_id, lifecycle);
        self.keychain.delete(&self.service, &identity.account)?;
        if !self
            .keychain
            .read_values(&self.service, &identity.account)?
            .is_empty()
        {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        Ok(())
    }
}

impl EnvelopeKeyStore for MacOsKeychainEnvelopeKeyStore {
    fn available(&self) -> bool {
        self.keychain.identity_available()
    }

    fn prepare(
        &self,
        crypto_session_id: Id,
        key_id: Id,
        data_key: &[u8; 32],
        authenticated_context: &[u8],
    ) -> Result<(), PersistenceError> {
        let context_hash = context_hash(authenticated_context)?;
        let record = KeyRecord {
            crypto_session_id,
            key_id,
            context_hash,
            lifecycle: Lifecycle::Prepared,
            data_key: *data_key,
        };
        match self.records_for_key(crypto_session_id, key_id)?.as_slice() {
            [] => {}
            [(_, existing)] if existing == &record => return Ok(()),
            [..] => return Err(PersistenceError::Conflict),
        }
        let identity = public_identity(crypto_session_id, key_id, Lifecycle::Prepared);
        let mut value = record.encode();
        let inserted = self.keychain.insert(&self.service, &identity, &value);
        value.fill(0);
        let outcome = inserted?;
        let stored = self
            .exact_record(
                crypto_session_id,
                key_id,
                Lifecycle::Prepared,
                (outcome == InsertOutcome::Inserted).then_some(context_hash),
            )?
            .ok_or(PersistenceError::KeyRecordMissing)?;
        if stored != record {
            return Err(if outcome == InsertOutcome::Duplicate {
                PersistenceError::Conflict
            } else {
                PersistenceError::Corrupt
            });
        }
        Ok(())
    }

    fn load(
        &self,
        crypto_session_id: Id,
        key_id: Id,
        authenticated_context: &[u8],
    ) -> Result<[u8; 32], PersistenceError> {
        let context_hash = context_hash(authenticated_context)?;
        let records = self.records_for_key(crypto_session_id, key_id)?;
        if records.is_empty() {
            return Err(PersistenceError::KeyRecordMissing);
        }
        if records.len() != 1 {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        let (_, record) = records
            .into_iter()
            .next()
            .ok_or(PersistenceError::KeyRecordMissing)?;
        record.validate_binding(
            crypto_session_id,
            key_id,
            Some(context_hash),
            Lifecycle::Active,
        )?;
        Ok(record.data_key)
    }

    fn activate(
        &self,
        crypto_session_id: Id,
        key_id: Id,
        authenticated_context: &[u8],
    ) -> Result<(), PersistenceError> {
        let context_hash = context_hash(authenticated_context)?;
        let records = self.records_for_key(crypto_session_id, key_id)?;
        if records.is_empty() || records.len() > 2 {
            return Err(if records.is_empty() {
                PersistenceError::KeyRecordMissing
            } else {
                PersistenceError::SecureStoreAmbiguous
            });
        }
        let prepared = records
            .iter()
            .find(|(_, record)| record.lifecycle == Lifecycle::Prepared);
        let active = records
            .iter()
            .find(|(_, record)| record.lifecycle == Lifecycle::Active);
        for (_, record) in &records {
            record.validate_binding(
                crypto_session_id,
                key_id,
                Some(context_hash),
                record.lifecycle,
            )?;
        }
        if records.len() == 2
            && !prepared
                .zip(active)
                .is_some_and(|((_, prepared), (_, active))| {
                    prepared.data_key == active.data_key
                        && prepared.context_hash == active.context_hash
                })
        {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        if active.is_none() {
            let (_, prepared_record) = prepared.ok_or(PersistenceError::Corrupt)?;
            let mut active_record = prepared_record.clone();
            active_record.lifecycle = Lifecycle::Active;
            let active_identity = public_identity(crypto_session_id, key_id, Lifecycle::Active);
            let mut value = active_record.encode();
            let inserted = self
                .keychain
                .insert(&self.service, &active_identity, &value);
            value.fill(0);
            let outcome = inserted?;
            let stored = self
                .exact_record(
                    crypto_session_id,
                    key_id,
                    Lifecycle::Active,
                    Some(context_hash),
                )?
                .ok_or(PersistenceError::KeyRecordMissing)?;
            if stored != active_record {
                return Err(if outcome == InsertOutcome::Duplicate {
                    PersistenceError::Conflict
                } else {
                    PersistenceError::Corrupt
                });
            }
        }
        if prepared.is_some() {
            self.delete_and_verify(crypto_session_id, key_id, Lifecycle::Prepared)?;
        }
        let records = self.records_for_key(crypto_session_id, key_id)?;
        if records.len() != 1 || records[0].1.lifecycle != Lifecycle::Active {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        Ok(())
    }

    fn reconcile_prepared(
        &self,
        crypto_session_id: Id,
        committed_current: Option<(Id, Vec<u8>)>,
    ) -> Result<(), PersistenceError> {
        let identities = self.identities_for_session(crypto_session_id)?;
        if let Some((current_key_id, context)) = committed_current.as_ref() {
            let context_hash = context_hash(context)?;
            let records = self.records_for_key(crypto_session_id, *current_key_id)?;
            if records.is_empty() || records.len() > 2 {
                return Err(if records.is_empty() {
                    PersistenceError::KeyRecordMissing
                } else {
                    PersistenceError::SecureStoreAmbiguous
                });
            }
            for (_, record) in &records {
                record.validate_binding(
                    crypto_session_id,
                    *current_key_id,
                    Some(context_hash),
                    record.lifecycle,
                )?;
            }
            if records
                .iter()
                .any(|(_, record)| record.lifecycle == Lifecycle::Prepared)
            {
                self.activate(crypto_session_id, *current_key_id, context)?;
            }
        }
        for (_, key_id, lifecycle) in identities {
            let is_current = committed_current
                .as_ref()
                .is_some_and(|(current, _)| *current == key_id);
            if lifecycle == Lifecycle::Prepared && !is_current {
                self.delete_and_verify(crypto_session_id, key_id, Lifecycle::Prepared)?;
            }
        }
        Ok(())
    }

    fn erase(&self, crypto_session_id: Id, key_id: Id) -> Result<(), PersistenceError> {
        let records = self.records_for_key(crypto_session_id, key_id)?;
        if records.len() > 1 {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        let Some((_, record)) = records.into_iter().next() else {
            return Ok(());
        };
        self.delete_and_verify(crypto_session_id, key_id, record.lifecycle)?;
        if !self.records_for_key(crypto_session_id, key_id)?.is_empty() {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        Ok(())
    }

    fn destroy_session(&self, crypto_session_id: Id) -> Result<(), PersistenceError> {
        let identities = self.identities_for_session(crypto_session_id)?;
        for (_, key_id, lifecycle) in identities {
            self.delete_and_verify(crypto_session_id, key_id, lifecycle)?;
        }
        if !self.identities_for_session(crypto_session_id)?.is_empty() {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        Ok(())
    }
}

fn public_identity(crypto_session_id: Id, key_id: Id, lifecycle: Lifecycle) -> PublicIdentity {
    let value = format!(
        "v{RECORD_FORMAT_VERSION}:{}:{}:{}",
        hex(crypto_session_id),
        hex(key_id),
        lifecycle.name()
    );
    PublicIdentity {
        account: value.clone(),
        label: value,
    }
}

fn decode_public_identity(value: &str) -> Result<(Id, Id, Lifecycle), PersistenceError> {
    let mut parts = value.split(':');
    if parts.next() != Some("v1") {
        return Err(PersistenceError::Corrupt);
    }
    let session = decode_hex_id(parts.next().ok_or(PersistenceError::Corrupt)?)?;
    let key = decode_hex_id(parts.next().ok_or(PersistenceError::Corrupt)?)?;
    let lifecycle = match parts.next() {
        Some("prepared") => Lifecycle::Prepared,
        Some("active") => Lifecycle::Active,
        _ => return Err(PersistenceError::Corrupt),
    };
    if parts.next().is_some() {
        return Err(PersistenceError::Corrupt);
    }
    Ok((session, key, lifecycle))
}

fn context_hash(context: &[u8]) -> Result<[u8; 48], PersistenceError> {
    CoreProvider::new()
        .map_err(|_| PersistenceError::SecureStoreUnavailable)?
        .crypto()
        .hash(SUITE.hash_algorithm(), context)
        .map_err(|_| PersistenceError::SecureStoreUnavailable)?
        .try_into()
        .map_err(|_| PersistenceError::SecureStoreUnavailable)
}

fn hex(value: Id) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(32);
    for byte in value {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn decode_hex_id(value: &str) -> Result<Id, PersistenceError> {
    if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(PersistenceError::Corrupt);
    }
    let mut decoded = [0_u8; 16];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let high = decode_hex_nibble(pair[0])?;
        let low = decode_hex_nibble(pair[1])?;
        decoded[index] = (high << 4) | low;
    }
    Ok(decoded)
}

fn decode_hex_nibble(value: u8) -> Result<u8, PersistenceError> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        _ => Err(PersistenceError::Corrupt),
    }
}

fn interactive_user_identity_available() -> bool {
    effective_user_id() != 0
        && fs::metadata("/dev/console")
            .map(|metadata| metadata.uid() == effective_user_id())
            .unwrap_or(false)
}

fn require_interactive_user_identity() -> Result<(), PersistenceError> {
    if interactive_user_identity_available() {
        Ok(())
    } else {
        Err(PersistenceError::SecureStoreAccessDenied)
    }
}

fn effective_user_id() -> u32 {
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    // SAFETY: geteuid takes no arguments, has no memory-safety preconditions, and is available on
    // every macOS target on which this module is compiled.
    unsafe { geteuid() }
}

fn map_security_error(error: security_framework::base::Error) -> PersistenceError {
    match error.code() {
        -25308 | -128 => PersistenceError::SecureStoreLocked,
        -25293 | -34018 => PersistenceError::SecureStoreAccessDenied,
        -25299 => PersistenceError::SecureStoreAmbiguous,
        -25300 => PersistenceError::KeyRecordMissing,
        -25291 | -50 => PersistenceError::SecureStoreUnavailable,
        _ => PersistenceError::SecureStoreUnavailable,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        path::PathBuf,
        sync::{
            Arc, Barrier, Mutex,
            atomic::{AtomicU64, Ordering},
        },
        thread,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;
    use crate::{
        Identity,
        persistence::{DurablePhone, RollbackAnchor, RollbackState},
    };

    #[derive(Default)]
    struct FakeKeychain {
        items: Mutex<Vec<(String, PublicIdentity, Vec<u8>)>>,
        available: bool,
        failure: Mutex<Option<PersistenceError>>,
        insert_barrier: Mutex<Option<Arc<Barrier>>>,
        retain_after_delete: Mutex<bool>,
    }

    impl FakeKeychain {
        fn available() -> Arc<Self> {
            Arc::new(Self {
                available: true,
                ..Self::default()
            })
        }

        fn fail_once(&self, error: PersistenceError) {
            *self.failure.lock().unwrap() = Some(error);
        }

        fn block_two_inserts(&self) {
            *self.insert_barrier.lock().unwrap() = Some(Arc::new(Barrier::new(2)));
        }

        fn check_failure(&self) -> Result<(), PersistenceError> {
            if let Some(error) = self.failure.lock().unwrap().take() {
                Err(error)
            } else {
                Ok(())
            }
        }

        fn snapshot(&self) -> Vec<(String, PublicIdentity, Vec<u8>)> {
            self.items.lock().unwrap().clone()
        }
    }

    impl KeychainAccess for FakeKeychain {
        fn identity_available(&self) -> bool {
            self.available
        }

        fn list_identities(&self, service: &str) -> Result<Vec<PublicIdentity>, PersistenceError> {
            self.check_failure()?;
            Ok(self
                .items
                .lock()
                .unwrap()
                .iter()
                .filter(|(stored_service, _, _)| stored_service == service)
                .map(|(_, identity, _)| identity.clone())
                .collect())
        }

        fn read_values(
            &self,
            service: &str,
            account: &str,
        ) -> Result<Vec<Vec<u8>>, PersistenceError> {
            self.check_failure()?;
            Ok(self
                .items
                .lock()
                .unwrap()
                .iter()
                .filter(|(stored_service, identity, _)| {
                    stored_service == service && identity.account == account
                })
                .map(|(_, _, value)| value.clone())
                .collect())
        }

        fn insert(
            &self,
            service: &str,
            identity: &PublicIdentity,
            value: &[u8],
        ) -> Result<InsertOutcome, PersistenceError> {
            self.check_failure()?;
            let barrier = self.insert_barrier.lock().unwrap().clone();
            if let Some(barrier) = barrier
                && barrier.wait().is_leader()
            {
                *self.insert_barrier.lock().unwrap() = None;
            }
            let mut items = self.items.lock().unwrap();
            if items.iter().any(|(stored_service, stored, _)| {
                stored_service == service && stored.account == identity.account
            }) {
                Ok(InsertOutcome::Duplicate)
            } else {
                items.push((service.to_owned(), identity.clone(), value.to_vec()));
                Ok(InsertOutcome::Inserted)
            }
        }

        fn delete(&self, service: &str, account: &str) -> Result<(), PersistenceError> {
            self.check_failure()?;
            if !*self.retain_after_delete.lock().unwrap() {
                self.items
                    .lock()
                    .unwrap()
                    .retain(|(stored_service, identity, _)| {
                        stored_service != service || identity.account != account
                    });
            }
            Ok(())
        }
    }

    struct TestAnchor(Mutex<RollbackState>);

    impl TestAnchor {
        fn new() -> Arc<Self> {
            Arc::new(Self(Mutex::new(RollbackState {
                counter: 0,
                epoch: 0,
                epoch_authenticator: Vec::new(),
            })))
        }
    }

    impl RollbackAnchor for TestAnchor {
        fn available(&self) -> bool {
            true
        }

        fn read(&self, _crypto_session_id: Id) -> Result<RollbackState, PersistenceError> {
            Ok(self.0.lock().unwrap().clone())
        }

        fn advance(
            &self,
            _crypto_session_id: Id,
            expected: &RollbackState,
            next: &RollbackState,
            _operation_id: Id,
        ) -> Result<(), PersistenceError> {
            let mut state = self.0.lock().unwrap();
            if &*state != expected || next.counter != expected.counter + 1 {
                return Err(PersistenceError::Quarantined);
            }
            *state = next.clone();
            Ok(())
        }
    }

    fn store(keychain: Arc<FakeKeychain>) -> MacOsKeychainEnvelopeKeyStore {
        MacOsKeychainEnvelopeKeyStore::with_keychain(
            format!("ai.observal.axl.e2ee.test.{}", std::process::id()),
            keychain,
        )
    }

    fn temp_root(label: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "axl-keychain-{label}-{}-{nonce}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn canonical_record_round_trips_and_rejects_malformed_bindings() {
        let record = KeyRecord {
            crypto_session_id: [1; 16],
            key_id: [2; 16],
            context_hash: [3; 48],
            lifecycle: Lifecycle::Prepared,
            data_key: [4; 32],
        };
        let encoded = record.encode();
        assert_eq!(encoded.len(), RECORD_BYTES);
        assert_eq!(KeyRecord::decode(&encoded).unwrap(), record);
        for index in [0, 2, 83] {
            let mut malformed = encoded.clone();
            malformed[index] = 0xff;
            assert_eq!(
                KeyRecord::decode(&malformed),
                Err(PersistenceError::Corrupt)
            );
        }
        assert_eq!(
            KeyRecord::decode(&encoded[..encoded.len() - 1]),
            Err(PersistenceError::Corrupt)
        );
        for (session, key, hash, lifecycle) in [
            (
                [9; 16],
                record.key_id,
                record.context_hash,
                record.lifecycle,
            ),
            (
                record.crypto_session_id,
                [9; 16],
                record.context_hash,
                record.lifecycle,
            ),
            (
                record.crypto_session_id,
                record.key_id,
                [9; 48],
                record.lifecycle,
            ),
            (
                record.crypto_session_id,
                record.key_id,
                record.context_hash,
                Lifecycle::Active,
            ),
        ] {
            assert_eq!(
                record.validate_binding(session, key, Some(hash), lifecycle),
                Err(PersistenceError::Corrupt)
            );
        }
        assert_eq!(record.data_key, [4; 32]);
        assert!(!format!("{record:?}").contains("04040404"));
    }

    #[test]
    fn public_identity_contains_only_allowed_fields() {
        let identity = public_identity([0x11; 16], [0x22; 16], Lifecycle::Prepared);
        assert_eq!(identity.account, identity.label);
        assert_eq!(
            decode_public_identity(&identity.account),
            Ok(([0x11; 16], [0x22; 16], Lifecycle::Prepared))
        );
        assert!(!identity.account.contains("context"));
        assert!(!identity.account.contains("dek"));
        assert_eq!(identity.account.matches(':').count(), 3);
        assert_eq!(
            decode_public_identity("v1:AA:bb:active"),
            Err(PersistenceError::Corrupt)
        );
    }

    #[test]
    fn prepare_load_activate_reconcile_erase_and_destroy_are_fail_closed() {
        let keychain = FakeKeychain::available();
        let store = store(Arc::clone(&keychain));
        let session = [1; 16];
        let other_session = [2; 16];
        let current = [3; 16];
        let orphan = [4; 16];
        let obsolete = [5; 16];
        let context = b"authenticated state context";

        store.prepare(session, current, &[6; 32], context).unwrap();
        store.prepare(session, current, &[6; 32], context).unwrap();
        assert!(matches!(
            store.load(session, current, context),
            Err(PersistenceError::Corrupt)
        ));
        assert_eq!(
            store.prepare(session, current, &[7; 32], context),
            Err(PersistenceError::Conflict)
        );
        store.activate(session, current, context).unwrap();
        store.activate(session, current, context).unwrap();
        assert_eq!(store.load(session, current, context).unwrap(), [6; 32]);
        assert_eq!(
            store.load(session, current, b"wrong"),
            Err(PersistenceError::Corrupt)
        );

        store.prepare(session, orphan, &[8; 32], b"orphan").unwrap();
        store
            .prepare(session, obsolete, &[9; 32], b"obsolete")
            .unwrap();
        store.activate(session, obsolete, b"obsolete").unwrap();
        store
            .prepare(other_session, [10; 16], &[11; 32], b"other")
            .unwrap();
        store
            .reconcile_prepared(session, Some((current, context.to_vec())))
            .unwrap();
        assert_eq!(
            store.load(session, orphan, b"orphan"),
            Err(PersistenceError::KeyRecordMissing)
        );
        assert_eq!(store.load(session, obsolete, b"obsolete").unwrap(), [9; 32]);
        store.erase(session, obsolete).unwrap();
        store.erase(session, obsolete).unwrap();
        assert_eq!(
            store.load(session, obsolete, b"obsolete"),
            Err(PersistenceError::KeyRecordMissing)
        );
        store.destroy_session(session).unwrap();
        assert_eq!(
            store.load(session, current, context),
            Err(PersistenceError::KeyRecordMissing)
        );
        assert_eq!(
            store.load(other_session, [10; 16], b"other"),
            Err(PersistenceError::Corrupt)
        );
    }

    #[test]
    fn interrupted_activation_is_reconciled_without_loading_an_ambiguous_key() {
        let keychain = FakeKeychain::available();
        let store = store(Arc::clone(&keychain));
        let session = [0x61; 16];
        let key = [0x62; 16];
        let context = b"activation restart";
        store.prepare(session, key, &[0x63; 32], context).unwrap();
        let (_, prepared_identity, prepared_bytes) = keychain.snapshot().remove(0);
        let mut active_record = KeyRecord::decode(&prepared_bytes).unwrap();
        active_record.lifecycle = Lifecycle::Active;
        keychain.items.lock().unwrap().push((
            store.service.clone(),
            public_identity(session, key, Lifecycle::Active),
            active_record.encode(),
        ));
        assert_eq!(
            store.load(session, key, context),
            Err(PersistenceError::SecureStoreAmbiguous)
        );
        store.activate(session, key, context).unwrap();
        assert_eq!(store.load(session, key, context).unwrap(), [0x63; 32]);
        assert!(
            keychain
                .snapshot()
                .iter()
                .all(|(_, identity, _)| identity != &prepared_identity)
        );
    }

    #[test]
    fn duplicates_malformed_records_and_failed_deletion_are_rejected() {
        let keychain = FakeKeychain::available();
        let store = store(Arc::clone(&keychain));
        let session = [12; 16];
        let key = [13; 16];
        store.prepare(session, key, &[14; 32], b"context").unwrap();
        let duplicate = keychain.snapshot().into_iter().next().unwrap();
        keychain.items.lock().unwrap().push(duplicate);
        assert_eq!(
            store.load(session, key, b"context"),
            Err(PersistenceError::SecureStoreAmbiguous)
        );
        keychain.items.lock().unwrap().pop();
        keychain.items.lock().unwrap()[0].2[0] ^= 1;
        assert_eq!(
            store.activate(session, key, b"context"),
            Err(PersistenceError::Corrupt)
        );

        keychain.items.lock().unwrap().clear();
        store.prepare(session, key, &[14; 32], b"context").unwrap();
        *keychain.retain_after_delete.lock().unwrap() = true;
        assert_eq!(
            store.erase(session, key),
            Err(PersistenceError::SecureStoreAmbiguous)
        );
    }

    #[test]
    fn missing_committed_key_is_reported_as_state_loss() {
        let root = temp_root("state-loss");
        let keychain = FakeKeychain::available();
        let store = Arc::new(store(Arc::clone(&keychain)));
        let anchor = TestAnchor::new();
        let session = [0x71; 16];
        let identity = Identity::device([0x72; 16], [0x73; 16], [0x74; 16]).unwrap();
        let (phone, _) = DurablePhone::create(
            &root,
            identity,
            session,
            [0x75; 16],
            Arc::clone(&store) as Arc<dyn EnvelopeKeyStore>,
            Arc::clone(&anchor) as Arc<dyn RollbackAnchor>,
        )
        .unwrap();
        phone.store().close().unwrap();
        keychain.items.lock().unwrap().clear();
        assert!(matches!(
            DurablePhone::open(
                &root,
                session,
                store as Arc<dyn EnvelopeKeyStore>,
                anchor as Arc<dyn RollbackAnchor>,
            ),
            Err(PersistenceError::StateLoss)
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn locked_ui_forbidden_unavailable_and_access_denied_errors_remain_typed() {
        let keychain = FakeKeychain::available();
        let store = store(Arc::clone(&keychain));
        for expected in [
            PersistenceError::SecureStoreLocked,
            PersistenceError::SecureStoreUnavailable,
            PersistenceError::SecureStoreAccessDenied,
        ] {
            keychain.fail_once(expected.clone());
            assert_eq!(
                store.prepare([1; 16], [2; 16], &[3; 32], b"context"),
                Err(expected)
            );
        }
        assert!(
            !MacOsKeychainEnvelopeKeyStore::with_keychain(
                "test".to_owned(),
                Arc::new(FakeKeychain::default())
            )
            .available()
        );
        assert!(!store.hardware_backing());
    }

    #[test]
    fn contention_is_idempotent_for_one_session_and_independent_across_sessions() {
        let keychain = FakeKeychain::available();
        let store = Arc::new(store(Arc::clone(&keychain)));
        let mut workers = Vec::new();
        for _ in 0..4 {
            let store = Arc::clone(&store);
            workers.push(thread::spawn(move || {
                store.prepare([21; 16], [22; 16], &[23; 32], b"same")
            }));
        }
        for worker in workers {
            worker.join().unwrap().unwrap();
        }
        let left = {
            let store = Arc::clone(&store);
            thread::spawn(move || store.prepare([31; 16], [32; 16], &[33; 32], b"left"))
        };
        let right = {
            let store = Arc::clone(&store);
            thread::spawn(move || store.prepare([41; 16], [42; 16], &[43; 32], b"right"))
        };
        left.join().unwrap().unwrap();
        right.join().unwrap().unwrap();
        let counts = keychain.snapshot().into_iter().fold(
            BTreeMap::new(),
            |mut counts, (_, identity, _)| {
                *counts.entry(identity.account).or_insert(0_usize) += 1;
                counts
            },
        );
        assert!(counts.values().all(|count| *count == 1));
    }

    #[test]
    fn concurrent_conflicting_prepare_never_overwrites_the_winner() {
        let keychain = FakeKeychain::available();
        keychain.block_two_inserts();
        let store = Arc::new(store(Arc::clone(&keychain)));
        let session = [0x44; 16];
        let key = [0x45; 16];
        let first = {
            let store = Arc::clone(&store);
            thread::spawn(move || store.prepare(session, key, &[0x46; 32], b"first"))
        };
        let second = {
            let store = Arc::clone(&store);
            thread::spawn(move || store.prepare(session, key, &[0x47; 32], b"second"))
        };
        let outcomes = [first.join().unwrap(), second.join().unwrap()];
        assert_eq!(outcomes.iter().filter(|value| value.is_ok()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter(|value| **value == Err(PersistenceError::Conflict))
                .count(),
            1
        );
        let (winning_context, winning_key) = if outcomes[0].is_ok() {
            (b"first".as_slice(), [0x46; 32])
        } else {
            (b"second".as_slice(), [0x47; 32])
        };
        store.activate(session, key, winning_context).unwrap();
        assert_eq!(
            store.load(session, key, winning_context).unwrap(),
            winning_key
        );
    }

    #[test]
    fn local_data_protection_keychain_fails_closed_without_entitlement() {
        if std::env::var_os("AXL_RUN_MACOS_KEYCHAIN_TESTS").is_none() {
            return;
        }
        let store = MacOsKeychainEnvelopeKeyStore::new().unwrap();
        let session = [0x51; 16];
        let key = [0x52; 16];
        let result = store.prepare(session, key, &[0x53; 32], b"runtime evidence");
        eprintln!(
            "macOS Keychain runtime evidence: architecture={}, signed entitlement result={}",
            std::env::consts::ARCH,
            match &result {
                Ok(()) => "data-protection Keychain round trip available",
                Err(PersistenceError::SecureStoreAccessDenied) => "access denied",
                Err(PersistenceError::SecureStoreUnavailable) => "unavailable",
                Err(_) => "unexpected",
            }
        );
        match result {
            Ok(()) => {
                let round_trip = (|| {
                    store.activate(session, key, b"runtime evidence")?;
                    let loaded = store.load(session, key, b"runtime evidence")?;
                    if loaded != [0x53; 32] {
                        return Err(PersistenceError::Corrupt);
                    }
                    Ok(())
                })();
                let cleanup = store.destroy_session(session);
                round_trip.unwrap();
                cleanup.unwrap();
            }
            Err(
                PersistenceError::SecureStoreAccessDenied
                | PersistenceError::SecureStoreUnavailable,
            ) => {
                assert!(matches!(
                    store.load(session, key, b"runtime evidence"),
                    Err(PersistenceError::KeyRecordMissing
                        | PersistenceError::SecureStoreAccessDenied
                        | PersistenceError::SecureStoreUnavailable)
                ));
            }
            Err(error) => {
                let _ = store.destroy_session(session);
                panic!("unexpected bounded Keychain result: {error}");
            }
        }
    }
}
