// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

//! Windows nested machine-scope then user-scope DPAPI envelope-key storage.

use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    ptr,
    sync::{Mutex, MutexGuard},
};

use openmls_traits::{OpenMlsProvider, crypto::OpenMlsCrypto as _};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN,
        CryptProtectData, CryptUnprotectData,
    },
};

use super::{EnvelopeKeyStore, PersistenceError, windows_fs};
use crate::{CoreProvider, Id, SUITE};

const FORMAT_VERSION: u16 = 1;
const PLATFORM_WINDOWS_DPAPI: u8 = 3;
const RECORD_BYTES: usize = 2 + 1 + 48 + 16 + 16 + 48 + 1 + 32;
const FILE_PREFIX: &str = "axl-e2ee-key-v1-";
const MAX_RECORD_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
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
    identity_hash: [u8; 48],
    session: Id,
    key_id: Id,
    context_hash: [u8; 48],
    lifecycle: Lifecycle,
    data_key: [u8; 32],
}

impl std::fmt::Debug for KeyRecord {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("KeyRecord")
            .field("format_version", &FORMAT_VERSION)
            .field("platform", &"windows-dpapi")
            .field("identity_hash", &"[redacted]")
            .field("session", &"[redacted]")
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
        let mut out = Vec::with_capacity(RECORD_BYTES);
        out.extend_from_slice(&FORMAT_VERSION.to_be_bytes());
        out.push(PLATFORM_WINDOWS_DPAPI);
        out.extend_from_slice(&self.identity_hash);
        out.extend_from_slice(&self.session);
        out.extend_from_slice(&self.key_id);
        out.extend_from_slice(&self.context_hash);
        out.push(self.lifecycle as u8);
        out.extend_from_slice(&self.data_key);
        out
    }

    fn same_protected_value(&self, other: &Self) -> bool {
        self.identity_hash == other.identity_hash
            && self.session == other.session
            && self.key_id == other.key_id
            && self.context_hash == other.context_hash
            && self.data_key == other.data_key
    }

    fn decode(bytes: &[u8]) -> Result<Self, PersistenceError> {
        if bytes.len() != RECORD_BYTES
            || u16::from_be_bytes(
                bytes[0..2]
                    .try_into()
                    .map_err(|_| PersistenceError::Corrupt)?,
            ) != FORMAT_VERSION
            || bytes[2] != PLATFORM_WINDOWS_DPAPI
        {
            return Err(PersistenceError::Corrupt);
        }
        Ok(Self {
            identity_hash: bytes[3..51]
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?,
            session: bytes[51..67]
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?,
            key_id: bytes[67..83]
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?,
            context_hash: bytes[83..131]
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?,
            lifecycle: Lifecycle::decode(bytes[131])?,
            data_key: bytes[132..164]
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?,
        })
    }
}

/// File-backed DPAPI store bound to one explicitly configured non-roaming daemon SID.
///
/// The production factory remains unwired until installer and identity-policy evidence exists.
pub(crate) struct WindowsDpapiEnvelopeKeyStore {
    root: PathBuf,
    identity_hash: [u8; 48],
    operation_lock: Mutex<()>,
}

impl WindowsDpapiEnvelopeKeyStore {
    pub(crate) fn new(root: &Path, expected_daemon_sid: &str) -> Result<Self, PersistenceError> {
        if matches!(expected_daemon_sid, "S-1-5-18" | "S-1-5-19" | "S-1-5-20") {
            return Err(PersistenceError::SecureStoreAccessDenied);
        }
        if windows_fs::current_user_sid_string()? != expected_daemon_sid {
            return Err(PersistenceError::SecureStoreAccessDenied);
        }
        fs::create_dir_all(root).map_err(|_| PersistenceError::Io)?;
        windows_fs::validate_path_handle(root, true)?;
        windows_fs::harden_path(root)?;
        let root = root.canonicalize().map_err(|_| PersistenceError::Io)?;
        Ok(Self {
            root,
            identity_hash: hash(expected_daemon_sid.as_bytes())?,
            operation_lock: Mutex::new(()),
        })
    }

    pub(crate) const fn hardware_backing(&self) -> bool {
        false
    }

    fn lock(&self) -> Result<MutexGuard<'_, ()>, PersistenceError> {
        self.operation_lock
            .lock()
            .map_err(|_| PersistenceError::SecureStoreUnavailable)
    }

    fn path(&self, session: Id, key_id: Id, lifecycle: Lifecycle) -> PathBuf {
        self.root.join(format!(
            "{FILE_PREFIX}{}-{}-{}.dpapi",
            hex(session),
            hex(key_id),
            lifecycle.name()
        ))
    }

    fn read_record(
        &self,
        session: Id,
        key_id: Id,
        lifecycle: Lifecycle,
    ) -> Result<Option<KeyRecord>, PersistenceError> {
        let path = self.path(session, key_id, lifecycle);
        if !path.exists() {
            return Ok(None);
        }
        windows_fs::validate_path_handle(&path, false)?;
        windows_fs::harden_path(&path)?;
        let mut protected = Vec::new();
        OpenOptions::new()
            .read(true)
            .open(&path)
            .map_err(|_| PersistenceError::Io)?
            .take((MAX_RECORD_BYTES + 1) as u64)
            .read_to_end(&mut protected)
            .map_err(|_| PersistenceError::Io)?;
        if protected.len() > MAX_RECORD_BYTES {
            protected.fill(0);
            return Err(PersistenceError::Corrupt);
        }
        let plaintext = unprotect_nested(&protected);
        protected.fill(0);
        let mut plaintext = plaintext?;
        let decoded = KeyRecord::decode(&plaintext);
        plaintext.fill(0);
        let record = decoded?;
        if record.identity_hash != self.identity_hash
            || record.session != session
            || record.key_id != key_id
            || record.lifecycle != lifecycle
        {
            return Err(PersistenceError::Corrupt);
        }
        Ok(Some(record))
    }

    fn records_for_key(
        &self,
        session: Id,
        key_id: Id,
    ) -> Result<Vec<(PathBuf, KeyRecord)>, PersistenceError> {
        let mut records = Vec::new();
        for lifecycle in [Lifecycle::Prepared, Lifecycle::Active] {
            if let Some(record) = self.read_record(session, key_id, lifecycle)? {
                records.push((self.path(session, key_id, lifecycle), record));
            }
        }
        Ok(records)
    }

    fn write_record(&self, record: &KeyRecord) -> Result<(), PersistenceError> {
        let path = self.path(record.session, record.key_id, record.lifecycle);
        let temporary = path.with_extension(format!("dpapi.tmp.{}", std::process::id()));
        if temporary.exists() {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        let mut plaintext = record.encode();
        let protected = protect_nested(&plaintext);
        plaintext.fill(0);
        let mut protected = protected?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_WRITE_THROUGH;
        options.custom_flags(FILE_FLAG_WRITE_THROUGH);
        let mut file = options.open(&temporary).map_err(|_| PersistenceError::Io)?;
        let write_result = file
            .write_all(&protected)
            .and_then(|()| file.sync_all())
            .map_err(|_| PersistenceError::Io);
        protected.fill(0);
        write_result?;
        windows_fs::flush_file(&file)?;
        drop(file);
        windows_fs::harden_path(&temporary)?;
        windows_fs::replace_file(&temporary, &path)?;
        windows_fs::harden_path(&path)?;
        windows_fs::sync_directory(&self.root)
    }

    fn delete_and_verify(&self, path: &Path) -> Result<(), PersistenceError> {
        if path.exists() {
            windows_fs::validate_path_handle(path, false)?;
            fs::remove_file(path).map_err(|_| PersistenceError::Io)?;
            windows_fs::sync_directory(&self.root)?;
        }
        if path.exists() {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        Ok(())
    }

    fn activate_inner(
        &self,
        session: Id,
        key_id: Id,
        context: &[u8],
    ) -> Result<(), PersistenceError> {
        let expected_hash = hash(context)?;
        let records = self.records_for_key(session, key_id)?;
        if records.is_empty() || records.len() > 2 {
            return Err(if records.is_empty() {
                PersistenceError::KeyRecordMissing
            } else {
                PersistenceError::SecureStoreAmbiguous
            });
        }
        for (_, record) in &records {
            if record.context_hash != expected_hash {
                return Err(PersistenceError::Corrupt);
            }
        }
        let prepared = records
            .iter()
            .find(|(_, r)| r.lifecycle == Lifecycle::Prepared);
        let active = records
            .iter()
            .find(|(_, r)| r.lifecycle == Lifecycle::Active);
        if let (Some((_, prepared)), Some((_, active))) = (prepared, active)
            && !prepared.same_protected_value(active)
        {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        if active.is_none() {
            let (_, prepared) = prepared.ok_or(PersistenceError::Corrupt)?;
            let active = KeyRecord {
                lifecycle: Lifecycle::Active,
                ..prepared.clone()
            };
            self.write_record(&active)?;
        }
        if let Some((path, _)) = prepared {
            self.delete_and_verify(path)?;
        }
        Ok(())
    }
}

impl EnvelopeKeyStore for WindowsDpapiEnvelopeKeyStore {
    fn available(&self) -> bool {
        windows_fs::validate_path_handle(&self.root, true).is_ok()
            && windows_fs::current_user_sid_string()
                .and_then(|sid| hash(sid.as_bytes()))
                .is_ok_and(|hash| hash == self.identity_hash)
    }

    fn prepare(
        &self,
        session: Id,
        key_id: Id,
        data_key: &[u8; 32],
        context: &[u8],
    ) -> Result<(), PersistenceError> {
        let _guard = self.lock()?;
        let record = KeyRecord {
            identity_hash: self.identity_hash,
            session,
            key_id,
            context_hash: hash(context)?,
            lifecycle: Lifecycle::Prepared,
            data_key: *data_key,
        };
        match self.records_for_key(session, key_id)?.as_slice() {
            [] => self.write_record(&record),
            [(_, existing)] if existing == &record => Ok(()),
            [..] => Err(PersistenceError::Conflict),
        }
    }

    fn load(&self, session: Id, key_id: Id, context: &[u8]) -> Result<[u8; 32], PersistenceError> {
        let _guard = self.lock()?;
        let records = self.records_for_key(session, key_id)?;
        if records.is_empty() {
            return Err(PersistenceError::KeyRecordMissing);
        }
        if records.len() != 1 {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        let record = &records[0].1;
        if record.lifecycle != Lifecycle::Active || record.context_hash != hash(context)? {
            return Err(PersistenceError::KeyUnavailable);
        }
        Ok(record.data_key)
    }

    fn activate(&self, session: Id, key_id: Id, context: &[u8]) -> Result<(), PersistenceError> {
        let _guard = self.lock()?;
        self.activate_inner(session, key_id, context)
    }

    fn reconcile_prepared(
        &self,
        session: Id,
        committed_current: Option<(Id, Vec<u8>)>,
    ) -> Result<(), PersistenceError> {
        let _guard = self.lock()?;
        if let Some((key_id, context)) = committed_current.as_ref() {
            self.activate_inner(session, *key_id, context)?;
        }
        for entry in fs::read_dir(&self.root).map_err(|_| PersistenceError::Io)? {
            let entry = entry.map_err(|_| PersistenceError::Io)?;
            let Some((record_session, key_id, lifecycle)) = parse_filename(&entry.file_name())
            else {
                continue;
            };
            if record_session == session
                && lifecycle == Lifecycle::Prepared
                && committed_current
                    .as_ref()
                    .is_none_or(|(current, _)| *current != key_id)
            {
                self.read_record(record_session, key_id, lifecycle)?
                    .ok_or(PersistenceError::KeyRecordMissing)?;
                self.delete_and_verify(&entry.path())?;
            }
        }
        Ok(())
    }

    fn erase(&self, session: Id, key_id: Id) -> Result<(), PersistenceError> {
        let _guard = self.lock()?;
        let records = self.records_for_key(session, key_id)?;
        if records.len() > 1 {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        if let Some((path, _)) = records.first() {
            self.delete_and_verify(path)?;
        }
        Ok(())
    }

    fn destroy_session(&self, session: Id) -> Result<(), PersistenceError> {
        let _guard = self.lock()?;
        let mut seen = BTreeSet::new();
        for entry in fs::read_dir(&self.root).map_err(|_| PersistenceError::Io)? {
            let entry = entry.map_err(|_| PersistenceError::Io)?;
            let Some((record_session, key_id, lifecycle)) = parse_filename(&entry.file_name())
            else {
                continue;
            };
            if record_session == session && seen.insert((key_id, lifecycle)) {
                self.read_record(record_session, key_id, lifecycle)?
                    .ok_or(PersistenceError::KeyRecordMissing)?;
                self.delete_and_verify(&entry.path())?;
            }
        }
        Ok(())
    }
}

fn protect_nested(plaintext: &[u8]) -> Result<Vec<u8>, PersistenceError> {
    let machine = protect(
        plaintext,
        CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
    )?;
    let user = protect(&machine, CRYPTPROTECT_UI_FORBIDDEN);
    let mut machine = machine;
    machine.fill(0);
    user
}

fn unprotect_nested(protected: &[u8]) -> Result<Vec<u8>, PersistenceError> {
    let machine = unprotect(protected)?;
    let plaintext = unprotect(&machine);
    let mut machine = machine;
    machine.fill(0);
    plaintext
}

fn protect(input: &[u8], flags: u32) -> Result<Vec<u8>, PersistenceError> {
    let input_len = u32::try_from(input.len()).map_err(|_| PersistenceError::Corrupt)?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_len,
        pbData: input.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: blobs describe valid buffers for the duration of the call; UI is forbidden.
    if unsafe {
        CryptProtectData(
            &input,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            flags,
            &mut output,
        )
    } == 0
    {
        return Err(PersistenceError::SecureStoreUnavailable);
    }
    copy_and_free_blob(output)
}

fn unprotect(input: &[u8]) -> Result<Vec<u8>, PersistenceError> {
    let input_len = u32::try_from(input.len()).map_err(|_| PersistenceError::Corrupt)?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_len,
        pbData: input.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: blobs describe valid buffers for the duration of the call; UI is forbidden.
    if unsafe {
        CryptUnprotectData(
            &input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    } == 0
    {
        return Err(PersistenceError::SecureStoreAccessDenied);
    }
    copy_and_free_blob(output)
}

fn copy_and_free_blob(blob: CRYPT_INTEGER_BLOB) -> Result<Vec<u8>, PersistenceError> {
    if blob.pbData.is_null() || blob.cbData == 0 || blob.cbData as usize > MAX_RECORD_BYTES {
        if !blob.pbData.is_null() {
            // SAFETY: DPAPI allocated this pointer with LocalAlloc.
            unsafe { LocalFree(blob.pbData.cast()) };
        }
        return Err(PersistenceError::Corrupt);
    }
    // SAFETY: DPAPI initialized cbData bytes at pbData.
    let result = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize) }.to_vec();
    // SAFETY: DPAPI allocated a writable cbData-byte buffer with LocalAlloc.
    unsafe {
        ptr::write_bytes(blob.pbData, 0, blob.cbData as usize);
        LocalFree(blob.pbData.cast());
    }
    Ok(result)
}

fn hash(bytes: &[u8]) -> Result<[u8; 48], PersistenceError> {
    CoreProvider::new()
        .map_err(|_| PersistenceError::SecureStoreUnavailable)?
        .crypto()
        .hash(SUITE.hash_algorithm(), bytes)
        .map_err(|_| PersistenceError::SecureStoreUnavailable)?
        .try_into()
        .map_err(|_| PersistenceError::SecureStoreUnavailable)
}

fn parse_filename(value: &std::ffi::OsStr) -> Option<(Id, Id, Lifecycle)> {
    let value = value.to_str()?;
    let value = value.strip_prefix(FILE_PREFIX)?.strip_suffix(".dpapi")?;
    let mut parts = value.split('-');
    let session = decode_hex(parts.next()?).ok()?;
    let key = decode_hex(parts.next()?).ok()?;
    let lifecycle = match parts.next()? {
        "prepared" => Lifecycle::Prepared,
        "active" => Lifecycle::Active,
        _ => return None,
    };
    if parts.next().is_some() {
        return None;
    }
    Some((session, key, lifecycle))
}

fn hex(value: Id) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_hex(value: &str) -> Result<Id, PersistenceError> {
    if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(PersistenceError::Corrupt);
    }
    let mut out = [0_u8; 16];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        out[index] = (nibble(pair[0])? << 4) | nibble(pair[1])?;
    }
    Ok(out)
}

fn nibble(value: u8) -> Result<u8, PersistenceError> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        _ => Err(PersistenceError::Corrupt),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_and_filename_bind_every_identity_field() {
        let record = KeyRecord {
            identity_hash: [1; 48],
            session: [2; 16],
            key_id: [3; 16],
            context_hash: [4; 48],
            lifecycle: Lifecycle::Prepared,
            data_key: [5; 32],
        };
        let encoded = record.encode();
        assert_eq!(encoded.len(), RECORD_BYTES);
        assert_eq!(KeyRecord::decode(&encoded).unwrap(), record);
        let path = format!(
            "{FILE_PREFIX}{}-{}-prepared.dpapi",
            hex(record.session),
            hex(record.key_id)
        );
        assert_eq!(
            parse_filename(std::ffi::OsStr::new(&path)),
            Some((record.session, record.key_id, Lifecycle::Prepared))
        );
        let mut malformed = encoded;
        malformed[2] ^= 1;
        assert_eq!(
            KeyRecord::decode(&malformed),
            Err(PersistenceError::Corrupt)
        );
    }

    #[test]
    fn built_in_service_identities_are_never_accepted_by_policy() {
        for sid in ["S-1-5-18", "S-1-5-19", "S-1-5-20"] {
            assert!(matches!(
                WindowsDpapiEnvelopeKeyStore::new(Path::new(r"C:\\invalid"), sid),
                Err(PersistenceError::SecureStoreAccessDenied)
            ));
        }
    }
}
