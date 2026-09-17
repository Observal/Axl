// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

//! Linux desktop Secret Service envelope-key storage.
//!
//! This adapter is restricted to an unlocked graphical login session, the same user's session
//! D-Bus, and an explicitly selected Secret Service implementation. It always negotiates the
//! encrypted Secret Service session and treats every prompt as a locked store. Headless Linux,
//! unknown services, plain sessions, and fallback stores are intentionally unsupported.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fmt, fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use openmls_traits::{OpenMlsProvider, crypto::OpenMlsCrypto as _};
use secret_service::{EncryptionType, PromptOutcome, blocking::SecretService};
use zbus::{
    blocking::{Connection, fdo::DBusProxy},
    names::BusName,
    zvariant::OwnedObjectPath,
};

use super::{EnvelopeKeyStore, PersistenceError};
use crate::{CoreProvider, Id, SUITE};

const RECORD_FORMAT_VERSION: u16 = 1;
const PLATFORM_LINUX_SECRET_SERVICE: u8 = 2;
const RECORD_BYTES: usize = 2 + 1 + 16 + 16 + 48 + 1 + 32;
const SERVICE_NAME: &str = "ai.observal.axl.e2ee.envelope-key.v1";
const CONTENT_TYPE: &str = "application/octet-stream";
const SECRET_SERVICE_BUS_NAME: &str = "org.freedesktop.secrets";
const MAX_SERVICE_ITEMS: usize = 4096;

const ATTR_SERVICE: &str = "application";
const ATTR_FORMAT: &str = "axl-format";
const ATTR_SESSION: &str = "axl-session";
const ATTR_KEY: &str = "axl-key";
const ATTR_LIFECYCLE: &str = "axl-lifecycle";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SecretServiceImplementation {
    GnomeKeyring,
    KWallet6,
}

impl SecretServiceImplementation {
    fn accepts_executable(self, executable: &Path) -> bool {
        let accepted: &[&str] = match self {
            Self::GnomeKeyring => &[
                "/usr/bin/gnome-keyring-daemon",
                "/usr/libexec/gnome-keyring-daemon",
            ],
            Self::KWallet6 => &["/usr/bin/kwalletd6", "/usr/libexec/kwalletd6"],
        };
        accepted
            .iter()
            .any(|candidate| executable == Path::new(candidate))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
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
            .field("platform", &"linux-secret-service")
            .field("crypto_session_id", &"[redacted]")
            .field("key_id", &"[redacted]")
            .field("context_hash", &"[redacted]")
            .field("lifecycle", &self.lifecycle)
            .field("data_key", &"[redacted]")
            .finish()
    }
}

impl Drop for KeyRecord {
    fn drop(&mut self) {
        self.data_key.fill(0);
    }
}

impl KeyRecord {
    fn encode(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(RECORD_BYTES);
        bytes.extend_from_slice(&RECORD_FORMAT_VERSION.to_be_bytes());
        bytes.push(PLATFORM_LINUX_SECRET_SERVICE);
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
        if u16::from_be_bytes(
            bytes[0..2]
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?,
        ) != RECORD_FORMAT_VERSION
            || bytes[2] != PLATFORM_LINUX_SECRET_SERVICE
        {
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
        expected_context_hash: Option<[u8; 48]>,
        lifecycle: Lifecycle,
    ) -> Result<(), PersistenceError> {
        if self.crypto_session_id != crypto_session_id
            || self.key_id != key_id
            || self.lifecycle != lifecycle
            || expected_context_hash.is_some_and(|hash| hash != self.context_hash)
        {
            return Err(PersistenceError::Corrupt);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PublicIdentity {
    label: String,
    attributes: BTreeMap<String, String>,
}

#[derive(Clone)]
pub(crate) struct StoredItem {
    object_path: String,
    identity: PublicIdentity,
    secret: Vec<u8>,
}

pub(crate) enum CreateOutcome {
    Created(StoredItem),
    PromptRequired,
}

pub(crate) enum DeleteOutcome {
    Deleted,
    PromptRequired,
}

pub(crate) trait ServiceConnection {
    fn verify_owner(&self) -> Result<(), PersistenceError>;
    fn search(
        &self,
        attributes: &BTreeMap<String, String>,
    ) -> Result<Vec<StoredItem>, PersistenceError>;
    fn create(
        &self,
        identity: &PublicIdentity,
        secret: &[u8],
    ) -> Result<CreateOutcome, PersistenceError>;
    fn delete(&self, object_path: &str) -> Result<DeleteOutcome, PersistenceError>;
}

pub(crate) trait SecretServiceBackend: Send + Sync {
    type Connection<'a>: ServiceConnection
    where
        Self: 'a;

    fn available(&self) -> bool;
    fn connect(&self) -> Result<Self::Connection<'_>, PersistenceError>;
}

pub(crate) struct SystemBackend {
    implementation: SecretServiceImplementation,
}

pub(crate) struct SystemConnection {
    connection: Connection,
    owner: String,
    implementation: SecretServiceImplementation,
}

impl SystemBackend {
    fn new(implementation: SecretServiceImplementation) -> Self {
        Self { implementation }
    }
}

impl SecretServiceBackend for SystemBackend {
    type Connection<'a> = SystemConnection;

    fn available(&self) -> bool {
        self.connect().is_ok()
    }

    fn connect(&self) -> Result<Self::Connection<'_>, PersistenceError> {
        validate_desktop_session()?;
        let connection = Connection::session().map_err(map_zbus_error)?;
        let proxy = DBusProxy::new(&connection).map_err(map_zbus_error)?;
        let own_name = connection
            .unique_name()
            .ok_or(PersistenceError::SecureStoreUnavailable)?;
        let own_user = proxy
            .get_connection_unix_user(BusName::from(own_name.clone()))
            .map_err(map_fdo_error)?;
        if own_user != effective_user_id() {
            return Err(PersistenceError::SecureStoreAccessDenied);
        }
        let owner = proxy
            .get_name_owner(
                BusName::try_from(SECRET_SERVICE_BUS_NAME)
                    .map_err(|_| PersistenceError::SecureStoreUnavailable)?,
            )
            .map_err(map_fdo_error)?;
        validate_service_process(&proxy, &owner, self.implementation)?;
        let result = SystemConnection {
            connection,
            owner: owner.to_string(),
            implementation: self.implementation,
        };
        result.verify_owner()?;
        {
            let service = result.service()?;
            result.collection(&service)?;
        }
        Ok(result)
    }
}

impl SystemConnection {
    fn service(&self) -> Result<SecretService<'_>, PersistenceError> {
        self.verify_owner()?;
        let service =
            SecretService::connect_with_existing(EncryptionType::Dh, self.connection.clone())
                .map_err(map_secret_service_error)?;
        self.verify_owner()?;
        Ok(service)
    }

    fn collection<'a>(
        &self,
        service: &'a SecretService<'a>,
    ) -> Result<secret_service::blocking::Collection<'a>, PersistenceError> {
        let collection = service
            .get_default_collection()
            .map_err(|error| match error {
                secret_service::Error::NoResult => PersistenceError::SecureStoreUnavailable,
                error => map_secret_service_error(error),
            })?;
        collection
            .ensure_unlocked()
            .map_err(map_secret_service_error)?;
        Ok(collection)
    }

    fn item_to_stored(
        &self,
        item: &secret_service::blocking::Item<'_>,
    ) -> Result<StoredItem, PersistenceError> {
        item.ensure_unlocked().map_err(map_secret_service_error)?;
        let identity = PublicIdentity {
            label: item.get_label().map_err(map_secret_service_error)?,
            attributes: item
                .get_attributes()
                .map_err(map_secret_service_error)?
                .into_iter()
                .collect(),
        };
        Ok(StoredItem {
            object_path: item.item_path.to_string(),
            identity,
            secret: item.get_secret().map_err(map_secret_service_error)?,
        })
    }
}

impl ServiceConnection for SystemConnection {
    fn verify_owner(&self) -> Result<(), PersistenceError> {
        let proxy = DBusProxy::new(&self.connection).map_err(map_zbus_error)?;
        let owner = proxy
            .get_name_owner(
                BusName::try_from(SECRET_SERVICE_BUS_NAME)
                    .map_err(|_| PersistenceError::SecureStoreUnavailable)?,
            )
            .map_err(map_fdo_error)?;
        if owner.as_str() != self.owner {
            return Err(PersistenceError::SecureStoreAccessDenied);
        }
        validate_service_process(&proxy, &owner, self.implementation)
    }

    fn search(
        &self,
        attributes: &BTreeMap<String, String>,
    ) -> Result<Vec<StoredItem>, PersistenceError> {
        let service = self.service()?;
        let collection = self.collection(&service)?;
        let borrowed: HashMap<&str, &str> = attributes
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        let items = collection
            .search_items(borrowed)
            .map_err(map_secret_service_error)?;
        if items.len() > MAX_SERVICE_ITEMS {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        let result = items.iter().map(|item| self.item_to_stored(item)).collect();
        self.verify_owner()?;
        result
    }

    fn create(
        &self,
        identity: &PublicIdentity,
        secret: &[u8],
    ) -> Result<CreateOutcome, PersistenceError> {
        let service = self.service()?;
        let collection = self.collection(&service)?;
        let borrowed: HashMap<&str, &str> = identity
            .attributes
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        let result = match collection
            .create_item_no_prompt(&identity.label, borrowed, secret, false, CONTENT_TYPE)
            .map_err(map_secret_service_error)?
        {
            PromptOutcome::Completed(item) => CreateOutcome::Created(self.item_to_stored(&item)?),
            PromptOutcome::PromptRequired(_) => CreateOutcome::PromptRequired,
        };
        self.verify_owner()?;
        Ok(result)
    }

    fn delete(&self, object_path: &str) -> Result<DeleteOutcome, PersistenceError> {
        let service = self.service()?;
        let item = service
            .get_item_by_path(
                OwnedObjectPath::try_from(object_path).map_err(|_| PersistenceError::Corrupt)?,
            )
            .map_err(map_secret_service_error)?;
        item.ensure_unlocked().map_err(map_secret_service_error)?;
        let result = match item.delete_no_prompt().map_err(map_secret_service_error)? {
            PromptOutcome::Completed(()) => DeleteOutcome::Deleted,
            PromptOutcome::PromptRequired(_) => DeleteOutcome::PromptRequired,
        };
        self.verify_owner()?;
        Ok(result)
    }
}

/// Secret Service-backed store for an interactive Linux desktop daemon.
///
/// This concrete type remains crate-private and is not wired into a production endpoint factory.
/// Selecting an implementation here does not establish a supported platform row.
pub(crate) struct LinuxSecretServiceEnvelopeKeyStore<B = SystemBackend> {
    backend: B,
    operation_lock: Mutex<()>,
}

impl LinuxSecretServiceEnvelopeKeyStore<SystemBackend> {
    pub(crate) fn new(
        implementation: SecretServiceImplementation,
    ) -> Result<Self, PersistenceError> {
        let store = Self {
            backend: SystemBackend::new(implementation),
            operation_lock: Mutex::new(()),
        };
        store.backend.connect()?;
        Ok(store)
    }

    /// Secret Service exposes no portable hardware-backing evidence.
    pub(crate) const fn hardware_backing(&self) -> bool {
        false
    }
}

impl<B: SecretServiceBackend> LinuxSecretServiceEnvelopeKeyStore<B> {
    #[cfg(test)]
    fn with_backend(backend: B) -> Self {
        Self {
            backend,
            operation_lock: Mutex::new(()),
        }
    }

    fn lock_operations(&self) -> Result<MutexGuard<'_, ()>, PersistenceError> {
        self.operation_lock
            .lock()
            .map_err(|_| PersistenceError::SecureStoreUnavailable)
    }

    fn records_for_filter(
        &self,
        connection: &B::Connection<'_>,
        filter: BTreeMap<String, String>,
    ) -> Result<Vec<(StoredItem, KeyRecord)>, PersistenceError> {
        connection.verify_owner()?;
        let items = connection.search(&filter)?;
        connection.verify_owner()?;
        if items.len() > MAX_SERVICE_ITEMS {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        let mut seen_paths = BTreeSet::new();
        items
            .into_iter()
            .map(|mut item| {
                if !seen_paths.insert(item.object_path.clone()) {
                    item.secret.fill(0);
                    return Err(PersistenceError::SecureStoreAmbiguous);
                }
                let (session, key_id, lifecycle) = decode_public_identity(&item.identity)?;
                let decoded = KeyRecord::decode(&item.secret);
                item.secret.fill(0);
                let record = decoded?;
                record.validate_binding(session, key_id, None, lifecycle)?;
                Ok((item, record))
            })
            .collect()
    }

    fn records_for_key(
        &self,
        connection: &B::Connection<'_>,
        crypto_session_id: Id,
        key_id: Id,
    ) -> Result<Vec<(StoredItem, KeyRecord)>, PersistenceError> {
        self.records_for_filter(connection, key_filter(crypto_session_id, key_id))
    }

    fn identities_for_session(
        &self,
        connection: &B::Connection<'_>,
        crypto_session_id: Id,
    ) -> Result<Vec<(StoredItem, KeyRecord)>, PersistenceError> {
        self.records_for_filter(connection, session_filter(crypto_session_id))
    }

    fn delete_and_verify(
        &self,
        connection: &B::Connection<'_>,
        item: &StoredItem,
    ) -> Result<(), PersistenceError> {
        match connection.delete(&item.object_path)? {
            DeleteOutcome::Deleted => {}
            DeleteOutcome::PromptRequired => return Err(PersistenceError::SecureStoreLocked),
        }
        connection.verify_owner()?;
        if !connection.search(&item.identity.attributes)?.is_empty() {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        connection.verify_owner()
    }

    fn activate_inner(
        &self,
        connection: &B::Connection<'_>,
        crypto_session_id: Id,
        key_id: Id,
        authenticated_context: &[u8],
    ) -> Result<(), PersistenceError> {
        let expected_hash = context_hash(authenticated_context)?;
        let records = self.records_for_key(connection, crypto_session_id, key_id)?;
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
                Some(expected_hash),
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
            let identity = public_identity(crypto_session_id, key_id, Lifecycle::Active);
            let mut value = active_record.encode();
            let outcome = connection.create(&identity, &value);
            value.fill(0);
            let mut created = match outcome? {
                CreateOutcome::Created(created) => created,
                CreateOutcome::PromptRequired => return Err(PersistenceError::SecureStoreLocked),
            };
            let identity_matches = created.identity == identity;
            created.secret.fill(0);
            if !identity_matches {
                return Err(PersistenceError::Corrupt);
            }
            let after = self.records_for_key(connection, crypto_session_id, key_id)?;
            if after
                .iter()
                .filter(|(_, record)| record.lifecycle == Lifecycle::Active)
                .count()
                != 1
            {
                return Err(PersistenceError::SecureStoreAmbiguous);
            }
        }
        if let Some((prepared_item, _)) = prepared {
            self.delete_and_verify(connection, prepared_item)?;
        }
        let records = self.records_for_key(connection, crypto_session_id, key_id)?;
        if records.len() != 1 || records[0].1.lifecycle != Lifecycle::Active {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        Ok(())
    }
}

impl<B: SecretServiceBackend> EnvelopeKeyStore for LinuxSecretServiceEnvelopeKeyStore<B> {
    fn available(&self) -> bool {
        self.backend.available()
    }

    fn prepare(
        &self,
        crypto_session_id: Id,
        key_id: Id,
        data_key: &[u8; 32],
        authenticated_context: &[u8],
    ) -> Result<(), PersistenceError> {
        let _operation = self.lock_operations()?;
        let connection = self.backend.connect()?;
        let record = KeyRecord {
            crypto_session_id,
            key_id,
            context_hash: context_hash(authenticated_context)?,
            lifecycle: Lifecycle::Prepared,
            data_key: *data_key,
        };
        match self
            .records_for_key(&connection, crypto_session_id, key_id)?
            .as_slice()
        {
            [] => {}
            [(_, existing)] if existing == &record => return Ok(()),
            [..] => return Err(PersistenceError::Conflict),
        }
        let identity = public_identity(crypto_session_id, key_id, Lifecycle::Prepared);
        let mut value = record.encode();
        let outcome = connection.create(&identity, &value);
        value.fill(0);
        let mut created = match outcome? {
            CreateOutcome::Created(created) => created,
            CreateOutcome::PromptRequired => return Err(PersistenceError::SecureStoreLocked),
        };
        let identity_matches = created.identity == identity;
        created.secret.fill(0);
        if !identity_matches {
            return Err(PersistenceError::Corrupt);
        }
        let records = self.records_for_key(&connection, crypto_session_id, key_id)?;
        if records.len() != 1 || records[0].1 != record {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        Ok(())
    }

    fn load(
        &self,
        crypto_session_id: Id,
        key_id: Id,
        authenticated_context: &[u8],
    ) -> Result<[u8; 32], PersistenceError> {
        let _operation = self.lock_operations()?;
        let connection = self.backend.connect()?;
        let records = self.records_for_key(&connection, crypto_session_id, key_id)?;
        if records.is_empty() {
            return Err(PersistenceError::KeyRecordMissing);
        }
        if records.len() != 1 {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        let record = &records[0].1;
        record.validate_binding(
            crypto_session_id,
            key_id,
            Some(context_hash(authenticated_context)?),
            record.lifecycle,
        )?;
        if record.lifecycle != Lifecycle::Active {
            return Err(PersistenceError::KeyUnavailable);
        }
        Ok(record.data_key)
    }

    fn activate(
        &self,
        crypto_session_id: Id,
        key_id: Id,
        authenticated_context: &[u8],
    ) -> Result<(), PersistenceError> {
        let _operation = self.lock_operations()?;
        let connection = self.backend.connect()?;
        self.activate_inner(
            &connection,
            crypto_session_id,
            key_id,
            authenticated_context,
        )
    }

    fn reconcile_prepared(
        &self,
        crypto_session_id: Id,
        committed_current: Option<(Id, Vec<u8>)>,
    ) -> Result<(), PersistenceError> {
        let _operation = self.lock_operations()?;
        let connection = self.backend.connect()?;
        let identities = self.identities_for_session(&connection, crypto_session_id)?;
        if let Some((current_key_id, context)) = committed_current.as_ref() {
            let records = self.records_for_key(&connection, crypto_session_id, *current_key_id)?;
            if records.is_empty() || records.len() > 2 {
                return Err(if records.is_empty() {
                    PersistenceError::KeyRecordMissing
                } else {
                    PersistenceError::SecureStoreAmbiguous
                });
            }
            let expected_hash = context_hash(context)?;
            for (_, record) in &records {
                record.validate_binding(
                    crypto_session_id,
                    *current_key_id,
                    Some(expected_hash),
                    record.lifecycle,
                )?;
            }
            if records
                .iter()
                .any(|(_, record)| record.lifecycle == Lifecycle::Prepared)
            {
                self.activate_inner(&connection, crypto_session_id, *current_key_id, context)?;
            }
        }
        for (item, record) in identities {
            let is_current = committed_current
                .as_ref()
                .is_some_and(|(current, _)| *current == record.key_id);
            if record.lifecycle == Lifecycle::Prepared && !is_current {
                self.delete_and_verify(&connection, &item)?;
            }
        }
        Ok(())
    }

    fn erase(&self, crypto_session_id: Id, key_id: Id) -> Result<(), PersistenceError> {
        let _operation = self.lock_operations()?;
        let connection = self.backend.connect()?;
        let records = self.records_for_key(&connection, crypto_session_id, key_id)?;
        if records.len() > 1 {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        let Some((item, _)) = records.first() else {
            return Ok(());
        };
        self.delete_and_verify(&connection, item)
    }

    fn destroy_session(&self, crypto_session_id: Id) -> Result<(), PersistenceError> {
        let _operation = self.lock_operations()?;
        let connection = self.backend.connect()?;
        let records = self.identities_for_session(&connection, crypto_session_id)?;
        for (item, _) in records {
            self.delete_and_verify(&connection, &item)?;
        }
        if !self
            .identities_for_session(&connection, crypto_session_id)?
            .is_empty()
        {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        Ok(())
    }
}

fn public_identity(crypto_session_id: Id, key_id: Id, lifecycle: Lifecycle) -> PublicIdentity {
    let session = hex(crypto_session_id);
    let key = hex(key_id);
    let lifecycle_name = lifecycle.name();
    PublicIdentity {
        label: format!("{SERVICE_NAME}:v{RECORD_FORMAT_VERSION}:{session}:{key}:{lifecycle_name}"),
        attributes: BTreeMap::from([
            (ATTR_SERVICE.to_owned(), SERVICE_NAME.to_owned()),
            (ATTR_FORMAT.to_owned(), RECORD_FORMAT_VERSION.to_string()),
            (ATTR_SESSION.to_owned(), session),
            (ATTR_KEY.to_owned(), key),
            (ATTR_LIFECYCLE.to_owned(), lifecycle_name.to_owned()),
        ]),
    }
}

fn decode_public_identity(
    identity: &PublicIdentity,
) -> Result<(Id, Id, Lifecycle), PersistenceError> {
    if identity.attributes.len() != 5
        || identity.attributes.get(ATTR_SERVICE).map(String::as_str) != Some(SERVICE_NAME)
        || identity.attributes.get(ATTR_FORMAT).map(String::as_str) != Some("1")
    {
        return Err(PersistenceError::Corrupt);
    }
    let session = decode_hex_id(
        identity
            .attributes
            .get(ATTR_SESSION)
            .ok_or(PersistenceError::Corrupt)?,
    )?;
    let key = decode_hex_id(
        identity
            .attributes
            .get(ATTR_KEY)
            .ok_or(PersistenceError::Corrupt)?,
    )?;
    let lifecycle = match identity.attributes.get(ATTR_LIFECYCLE).map(String::as_str) {
        Some("prepared") => Lifecycle::Prepared,
        Some("active") => Lifecycle::Active,
        _ => return Err(PersistenceError::Corrupt),
    };
    if identity != &public_identity(session, key, lifecycle) {
        return Err(PersistenceError::Corrupt);
    }
    Ok((session, key, lifecycle))
}

fn base_filter() -> BTreeMap<String, String> {
    BTreeMap::from([
        (ATTR_SERVICE.to_owned(), SERVICE_NAME.to_owned()),
        (ATTR_FORMAT.to_owned(), RECORD_FORMAT_VERSION.to_string()),
    ])
}

fn session_filter(crypto_session_id: Id) -> BTreeMap<String, String> {
    let mut filter = base_filter();
    filter.insert(ATTR_SESSION.to_owned(), hex(crypto_session_id));
    filter
}

fn key_filter(crypto_session_id: Id, key_id: Id) -> BTreeMap<String, String> {
    let mut filter = session_filter(crypto_session_id);
    filter.insert(ATTR_KEY.to_owned(), hex(key_id));
    filter
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

fn validate_desktop_session() -> Result<(), PersistenceError> {
    let uid = effective_user_id();
    let configured_runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .ok_or(PersistenceError::SecureStoreUnavailable)?;
    let runtime = configured_runtime
        .canonicalize()
        .map_err(|_| PersistenceError::SecureStoreUnavailable)?;
    let metadata = fs::metadata(&runtime).map_err(|_| PersistenceError::SecureStoreUnavailable)?;
    let bus_address = std::env::var("DBUS_SESSION_BUS_ADDRESS")
        .map_err(|_| PersistenceError::SecureStoreUnavailable)?;
    validate_desktop_session_evidence(
        uid,
        &runtime,
        metadata.uid(),
        metadata.mode(),
        &bus_address,
        std::env::var_os("XDG_CURRENT_DESKTOP").is_some(),
        std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some(),
    )
}

fn validate_desktop_session_evidence(
    uid: u32,
    runtime: &Path,
    runtime_uid: u32,
    runtime_mode: u32,
    bus_address: &str,
    has_desktop: bool,
    has_display: bool,
) -> Result<(), PersistenceError> {
    if uid == 0 {
        return Err(PersistenceError::SecureStoreAccessDenied);
    }
    let expected_runtime = PathBuf::from(format!("/run/user/{uid}"));
    if runtime != expected_runtime || runtime_uid != uid || runtime_mode & 0o077 != 0 {
        return Err(PersistenceError::SecureStoreAccessDenied);
    }
    let expected_bus = format!("unix:path={}/bus", runtime.display());
    if bus_address
        .split(',')
        .next()
        .is_none_or(|address| address != expected_bus)
    {
        return Err(PersistenceError::SecureStoreAccessDenied);
    }
    if !has_desktop || !has_display {
        return Err(PersistenceError::SecureStoreUnavailable);
    }
    Ok(())
}

fn validate_service_process(
    proxy: &DBusProxy<'_>,
    owner: &zbus::names::OwnedUniqueName,
    implementation: SecretServiceImplementation,
) -> Result<(), PersistenceError> {
    let owner_name = BusName::from(owner.clone());
    let owner_user = proxy
        .get_connection_unix_user(owner_name.clone())
        .map_err(map_fdo_error)?;
    if owner_user != effective_user_id() {
        return Err(PersistenceError::SecureStoreAccessDenied);
    }
    let pid = proxy
        .get_connection_unix_process_id(owner_name)
        .map_err(map_fdo_error)?;
    let executable = fs::read_link(format!("/proc/{pid}/exe"))
        .map_err(|_| PersistenceError::SecureStoreAccessDenied)?;
    if !implementation.accepts_executable(&executable) {
        return Err(PersistenceError::SecureStoreAccessDenied);
    }
    Ok(())
}

fn map_secret_service_error(error: secret_service::Error) -> PersistenceError {
    match error {
        secret_service::Error::Locked
        | secret_service::Error::Prompt
        | secret_service::Error::PromptDisconnected => PersistenceError::SecureStoreLocked,
        secret_service::Error::NoResult => PersistenceError::KeyRecordMissing,
        secret_service::Error::Crypto(_) | secret_service::Error::Zvariant(_) => {
            PersistenceError::Corrupt
        }
        secret_service::Error::Unavailable => PersistenceError::SecureStoreUnavailable,
        secret_service::Error::Zbus(error) => map_zbus_error(error),
        secret_service::Error::ZbusFdo(error) => map_fdo_error(error),
        _ => PersistenceError::SecureStoreUnavailable,
    }
}

fn map_zbus_error(error: zbus::Error) -> PersistenceError {
    let message = error.to_string();
    if message.contains("AccessDenied") || message.contains("AuthFailed") {
        PersistenceError::SecureStoreAccessDenied
    } else {
        PersistenceError::SecureStoreUnavailable
    }
}

fn map_fdo_error(error: zbus::fdo::Error) -> PersistenceError {
    let message = error.to_string();
    if message.contains("AccessDenied") {
        PersistenceError::SecureStoreAccessDenied
    } else {
        PersistenceError::SecureStoreUnavailable
    }
}

fn effective_user_id() -> u32 {
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    // SAFETY: geteuid has no arguments or memory-safety preconditions on supported Linux targets.
    unsafe { geteuid() }
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
        decoded[index] = (decode_hex_nibble(pair[0])? << 4) | decode_hex_nibble(pair[1])?;
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

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    };

    use super::*;

    #[derive(Default)]
    struct FakeBackend {
        items: Arc<Mutex<Vec<StoredItem>>>,
        available: AtomicBool,
        owner_valid: Arc<AtomicBool>,
        prompt_create: Arc<AtomicBool>,
        prompt_delete: Arc<AtomicBool>,
        retain_after_delete: Arc<AtomicBool>,
        invalidate_owner_after_create: Arc<AtomicBool>,
        next_path: Arc<AtomicU64>,
    }

    impl FakeBackend {
        fn available() -> Self {
            Self {
                available: AtomicBool::new(true),
                owner_valid: Arc::new(AtomicBool::new(true)),
                prompt_create: Arc::new(AtomicBool::new(false)),
                prompt_delete: Arc::new(AtomicBool::new(false)),
                retain_after_delete: Arc::new(AtomicBool::new(false)),
                invalidate_owner_after_create: Arc::new(AtomicBool::new(false)),
                next_path: Arc::new(AtomicU64::new(1)),
                items: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    struct FakeConnection {
        items: Arc<Mutex<Vec<StoredItem>>>,
        owner_valid: Arc<AtomicBool>,
        prompt_create: Arc<AtomicBool>,
        prompt_delete: Arc<AtomicBool>,
        retain_after_delete: Arc<AtomicBool>,
        invalidate_owner_after_create: Arc<AtomicBool>,
        next_path: Arc<AtomicU64>,
    }

    impl SecretServiceBackend for FakeBackend {
        type Connection<'a> = FakeConnection;

        fn available(&self) -> bool {
            self.available.load(Ordering::SeqCst)
        }

        fn connect(&self) -> Result<Self::Connection<'_>, PersistenceError> {
            if !self.available() {
                return Err(PersistenceError::SecureStoreUnavailable);
            }
            Ok(FakeConnection {
                items: Arc::clone(&self.items),
                owner_valid: Arc::clone(&self.owner_valid),
                prompt_create: Arc::clone(&self.prompt_create),
                prompt_delete: Arc::clone(&self.prompt_delete),
                retain_after_delete: Arc::clone(&self.retain_after_delete),
                invalidate_owner_after_create: Arc::clone(&self.invalidate_owner_after_create),
                next_path: Arc::clone(&self.next_path),
            })
        }
    }

    impl ServiceConnection for FakeConnection {
        fn verify_owner(&self) -> Result<(), PersistenceError> {
            if self.owner_valid.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(PersistenceError::SecureStoreAccessDenied)
            }
        }

        fn search(
            &self,
            attributes: &BTreeMap<String, String>,
        ) -> Result<Vec<StoredItem>, PersistenceError> {
            self.verify_owner()?;
            Ok(self
                .items
                .lock()
                .unwrap()
                .iter()
                .filter(|item| {
                    attributes
                        .iter()
                        .all(|(key, value)| item.identity.attributes.get(key) == Some(value))
                })
                .cloned()
                .collect())
        }

        fn create(
            &self,
            identity: &PublicIdentity,
            secret: &[u8],
        ) -> Result<CreateOutcome, PersistenceError> {
            self.verify_owner()?;
            if self.prompt_create.load(Ordering::SeqCst) {
                return Ok(CreateOutcome::PromptRequired);
            }
            let item = StoredItem {
                object_path: format!(
                    "/org/freedesktop/secrets/item/{}",
                    self.next_path.fetch_add(1, Ordering::SeqCst)
                ),
                identity: identity.clone(),
                secret: secret.to_vec(),
            };
            self.items.lock().unwrap().push(item.clone());
            if self.invalidate_owner_after_create.load(Ordering::SeqCst) {
                self.owner_valid.store(false, Ordering::SeqCst);
            }
            Ok(CreateOutcome::Created(item))
        }

        fn delete(&self, object_path: &str) -> Result<DeleteOutcome, PersistenceError> {
            self.verify_owner()?;
            if self.prompt_delete.load(Ordering::SeqCst) {
                return Ok(DeleteOutcome::PromptRequired);
            }
            if !self.retain_after_delete.load(Ordering::SeqCst) {
                self.items
                    .lock()
                    .unwrap()
                    .retain(|item| item.object_path != object_path);
            }
            Ok(DeleteOutcome::Deleted)
        }
    }

    fn fake_store() -> LinuxSecretServiceEnvelopeKeyStore<FakeBackend> {
        LinuxSecretServiceEnvelopeKeyStore::with_backend(FakeBackend::available())
    }

    #[test]
    fn record_and_public_identity_are_canonical_and_bound() {
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
        let identity = public_identity([1; 16], [2; 16], Lifecycle::Prepared);
        assert_eq!(
            decode_public_identity(&identity).unwrap(),
            ([1; 16], [2; 16], Lifecycle::Prepared)
        );
        assert_eq!(identity.attributes.len(), 5);
        assert!(!identity.label.contains(&hex([4; 16])));

        let mut malformed = encoded;
        malformed[2] = 0xff;
        assert_eq!(
            KeyRecord::decode(&malformed),
            Err(PersistenceError::Corrupt)
        );
        let mut malformed_identity = identity;
        malformed_identity
            .attributes
            .insert("unexpected".to_owned(), "value".to_owned());
        assert_eq!(
            decode_public_identity(&malformed_identity),
            Err(PersistenceError::Corrupt)
        );
    }

    #[test]
    fn prepared_active_reconciliation_and_deletion_are_idempotent() {
        let store = fake_store();
        let session = [10; 16];
        let current = [11; 16];
        let orphan = [12; 16];
        store
            .prepare(session, current, &[13; 32], b"current")
            .unwrap();
        store
            .prepare(session, current, &[13; 32], b"current")
            .unwrap();
        assert_eq!(
            store.load(session, current, b"current"),
            Err(PersistenceError::KeyUnavailable)
        );
        store
            .prepare(session, orphan, &[14; 32], b"orphan")
            .unwrap();
        store
            .reconcile_prepared(session, Some((current, b"current".to_vec())))
            .unwrap();
        assert_eq!(store.load(session, current, b"current").unwrap(), [13; 32]);
        assert_eq!(
            store.load(session, orphan, b"orphan"),
            Err(PersistenceError::KeyRecordMissing)
        );
        store.activate(session, current, b"current").unwrap();
        store.erase(session, current).unwrap();
        store.erase(session, current).unwrap();
        store.destroy_session(session).unwrap();
    }

    #[test]
    fn prompts_owner_changes_duplicates_and_failed_deletion_fail_closed() {
        let store = fake_store();
        store.backend.prompt_create.store(true, Ordering::SeqCst);
        assert_eq!(
            store.prepare([20; 16], [21; 16], &[22; 32], b"prompt"),
            Err(PersistenceError::SecureStoreLocked)
        );
        store.backend.prompt_create.store(false, Ordering::SeqCst);
        store
            .prepare([20; 16], [21; 16], &[22; 32], b"prompt")
            .unwrap();
        store.activate([20; 16], [21; 16], b"prompt").unwrap();
        store.backend.prompt_delete.store(true, Ordering::SeqCst);
        assert_eq!(
            store.erase([20; 16], [21; 16]),
            Err(PersistenceError::SecureStoreLocked)
        );
        store.backend.prompt_delete.store(false, Ordering::SeqCst);
        store
            .backend
            .retain_after_delete
            .store(true, Ordering::SeqCst);
        assert_eq!(
            store.erase([20; 16], [21; 16]),
            Err(PersistenceError::SecureStoreAmbiguous)
        );
        store
            .backend
            .retain_after_delete
            .store(false, Ordering::SeqCst);
        store.backend.owner_valid.store(false, Ordering::SeqCst);
        assert_eq!(
            store.load([20; 16], [21; 16], b"prompt"),
            Err(PersistenceError::SecureStoreAccessDenied)
        );

        let changed_owner = fake_store();
        changed_owner
            .backend
            .invalidate_owner_after_create
            .store(true, Ordering::SeqCst);
        assert_eq!(
            changed_owner.prepare([23; 16], [24; 16], &[25; 32], b"owner-change"),
            Err(PersistenceError::SecureStoreAccessDenied)
        );
    }

    #[test]
    fn conflicting_and_duplicate_records_never_select_a_key() {
        let store = fake_store();
        let session = [30; 16];
        let key = [31; 16];
        store.prepare(session, key, &[32; 32], b"one").unwrap();
        assert_eq!(
            store.prepare(session, key, &[33; 32], b"two"),
            Err(PersistenceError::Conflict)
        );
        let duplicate = store.backend.items.lock().unwrap()[0].clone();
        store.backend.items.lock().unwrap().push(duplicate);
        assert_eq!(
            store.activate(session, key, b"one"),
            Err(PersistenceError::SecureStoreAmbiguous)
        );
    }

    #[test]
    fn desktop_session_implementation_and_hardware_policy_fail_closed() {
        assert_eq!(
            validate_desktop_session_evidence(
                0,
                Path::new("/run/user/0"),
                0,
                0o40700,
                "unix:path=/run/user/0/bus",
                true,
                true,
            ),
            Err(PersistenceError::SecureStoreAccessDenied)
        );
        assert_eq!(
            validate_desktop_session_evidence(
                1000,
                Path::new("/run/user/1000"),
                1000,
                0o40700,
                "unix:path=/run/user/1000/bus",
                false,
                false,
            ),
            Err(PersistenceError::SecureStoreUnavailable)
        );
        assert_eq!(
            validate_desktop_session_evidence(
                1000,
                Path::new("/run/user/1000"),
                1000,
                0o40700,
                "unix:path=/run/user/1001/bus",
                true,
                true,
            ),
            Err(PersistenceError::SecureStoreAccessDenied)
        );
        assert!(
            validate_desktop_session_evidence(
                1000,
                Path::new("/run/user/1000"),
                1000,
                0o40700,
                "unix:path=/run/user/1000/bus,guid=0123456789abcdef",
                true,
                true,
            )
            .is_ok()
        );
        assert!(
            SecretServiceImplementation::GnomeKeyring
                .accepts_executable(Path::new("/usr/bin/gnome-keyring-daemon"))
        );
        assert!(
            SecretServiceImplementation::KWallet6
                .accepts_executable(Path::new("/usr/bin/kwalletd6"))
        );
        assert!(
            !SecretServiceImplementation::GnomeKeyring
                .accepts_executable(Path::new("/tmp/gnome-keyring-daemon"))
        );
        let fake = fake_store();
        assert!(fake.available());
        assert!(
            !LinuxSecretServiceEnvelopeKeyStore {
                backend: SystemBackend::new(SecretServiceImplementation::KWallet6),
                operation_lock: Mutex::new(()),
            }
            .hardware_backing()
        );
    }
}
