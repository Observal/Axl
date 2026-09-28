// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

//! Envelope keys for a daemon running in WSL, wrapped by Windows DPAPI.
//!
//! WSL is a headless Linux host, which the production storage RFC leaves without a v1 store. This
//! store keeps the same record model as the native Windows store: one record file per key and
//! lifecycle state, written to a temporary file, synced, and renamed into place. Each record is
//! sealed with nested machine-scope then user-scope DPAPI by `axl-dpapi-helper.exe`, a stateless
//! Windows process started through WSL interop as the signed-in Windows user. The helper sees one
//! bounded value per request and never a file, path, or record identity, so every lifecycle and
//! crash-ordering decision stays here. See `docs/architecture/remote-production-wsl.md`.
//!
//! Records bind the Windows user SID the helper reports and the Linux user that owns the store.
//! A copy of the WSL disk opens only for that Windows user on that machine. Processes running as
//! the same Linux user can ask the helper to unwrap, the same explicit non-claim the RFC makes for
//! Secret Service against malicious same-user processes.

use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Mutex, MutexGuard},
};

use openmls_traits::{OpenMlsProvider, crypto::OpenMlsCrypto as _};

use super::{EnvelopeKeyStore, PersistenceError};
use crate::{CoreProvider, Id, SUITE};

const FORMAT_VERSION: u16 = 1;
const PLATFORM_WSL_DPAPI: u8 = 4;
const RECORD_BYTES: usize = 2 + 1 + 48 + 16 + 16 + 48 + 1 + 32;
const FILE_PREFIX: &str = "axl-e2ee-key-v1-";
const FILE_SUFFIX: &str = ".wsldpapi";
const MAX_RECORD_BYTES: usize = 64 * 1024;
const HELPER_PROTOCOL: &[u8] = b"axl-dpapi-helper-v1";

const OP_HELLO: u8 = 0;
const OP_IDENTITY: u8 = 1;
const OP_PROTECT: u8 = 2;
const OP_UNPROTECT: u8 = 3;
const STATUS_OK: u8 = 0;
const STATUS_UNAVAILABLE: u8 = 1;
const STATUS_DENIED: u8 = 2;

/// The Windows side: who DPAPI binds to, and nested protection of one value.
pub(crate) trait DpapiWrapper: Send + Sync {
    fn identity(&self) -> Result<String, PersistenceError>;
    fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>, PersistenceError>;
    fn unprotect(&self, protected: &[u8]) -> Result<Vec<u8>, PersistenceError>;
}

/// One exchange with the helper over any framed byte stream.
fn exchange(
    input: &mut impl Write,
    output: &mut impl Read,
    op: u8,
    payload: &[u8],
) -> Result<Vec<u8>, PersistenceError> {
    let length = u32::try_from(payload.len()).map_err(|_| PersistenceError::Corrupt)?;
    if payload.len() > MAX_RECORD_BYTES {
        return Err(PersistenceError::Corrupt);
    }
    let mut header = [0_u8; 5];
    header[0] = op;
    header[1..].copy_from_slice(&length.to_be_bytes());
    input
        .write_all(&header)
        .and_then(|()| input.write_all(payload))
        .and_then(|()| input.flush())
        .map_err(|_| PersistenceError::SecureStoreUnavailable)?;
    let mut answer = [0_u8; 5];
    output
        .read_exact(&mut answer)
        .map_err(|_| PersistenceError::SecureStoreUnavailable)?;
    let length = u32::from_be_bytes([answer[1], answer[2], answer[3], answer[4]]) as usize;
    if length > MAX_RECORD_BYTES {
        return Err(PersistenceError::SecureStoreUnavailable);
    }
    let mut value = vec![0_u8; length];
    output
        .read_exact(&mut value)
        .map_err(|_| PersistenceError::SecureStoreUnavailable)?;
    match answer[0] {
        STATUS_OK => Ok(value),
        STATUS_DENIED => Err(PersistenceError::SecureStoreAccessDenied),
        STATUS_UNAVAILABLE => Err(PersistenceError::SecureStoreUnavailable),
        _ => Err(PersistenceError::SecureStoreUnavailable),
    }
}

struct Running {
    child: Child,
    input: ChildStdin,
    output: ChildStdout,
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// `axl-dpapi-helper.exe`, started through WSL interop on first use and kept running. A helper
/// that stopped answering is replaced once per request.
pub(crate) struct HelperProcess {
    path: PathBuf,
    running: Mutex<Option<Running>>,
}

impl HelperProcess {
    pub(crate) fn new(path: &Path) -> Result<Self, PersistenceError> {
        if !path.is_absolute() {
            return Err(PersistenceError::SecureStoreUnavailable);
        }
        let metadata = fs::metadata(path).map_err(|_| PersistenceError::SecureStoreUnavailable)?;
        if !metadata.is_file() {
            return Err(PersistenceError::SecureStoreUnavailable);
        }
        Ok(Self {
            path: path.to_path_buf(),
            running: Mutex::new(None),
        })
    }

    fn start(&self) -> Result<Running, PersistenceError> {
        let mut child = Command::new(&self.path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| PersistenceError::SecureStoreUnavailable)?;
        let (Some(input), Some(output)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            return Err(PersistenceError::SecureStoreUnavailable);
        };
        let mut running = Running {
            child,
            input,
            output,
        };
        let hello = exchange(&mut running.input, &mut running.output, OP_HELLO, &[])?;
        if hello != HELPER_PROTOCOL {
            return Err(PersistenceError::SecureStoreUnavailable);
        }
        Ok(running)
    }

    fn call(&self, op: u8, payload: &[u8]) -> Result<Vec<u8>, PersistenceError> {
        let mut guard = self
            .running
            .lock()
            .map_err(|_| PersistenceError::SecureStoreUnavailable)?;
        for attempt in 0..2 {
            if guard.is_none() {
                *guard = Some(self.start()?);
            }
            let running = guard
                .as_mut()
                .ok_or(PersistenceError::SecureStoreUnavailable)?;
            match exchange(&mut running.input, &mut running.output, op, payload) {
                // Only a broken stream is worth a new helper; DPAPI's own answers are final.
                Err(PersistenceError::SecureStoreUnavailable) if attempt == 0 => *guard = None,
                result => return result,
            }
        }
        Err(PersistenceError::SecureStoreUnavailable)
    }
}

impl DpapiWrapper for HelperProcess {
    fn identity(&self) -> Result<String, PersistenceError> {
        let sid = self.call(OP_IDENTITY, &[])?;
        let sid = String::from_utf8(sid).map_err(|_| PersistenceError::SecureStoreUnavailable)?;
        if !sid.starts_with("S-1-") || sid.len() > 184 {
            return Err(PersistenceError::SecureStoreUnavailable);
        }
        Ok(sid)
    }

    fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>, PersistenceError> {
        self.call(OP_PROTECT, plaintext)
    }

    fn unprotect(&self, protected: &[u8]) -> Result<Vec<u8>, PersistenceError> {
        self.call(OP_UNPROTECT, protected)
    }
}

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
            .field("platform", &"wsl-dpapi")
            .field("lifecycle", &self.lifecycle)
            .field("data_key", &"[redacted]")
            .finish_non_exhaustive()
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
        out.push(PLATFORM_WSL_DPAPI);
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
            || u16::from_be_bytes([bytes[0], bytes[1]]) != FORMAT_VERSION
            || bytes[2] != PLATFORM_WSL_DPAPI
        {
            return Err(PersistenceError::Corrupt);
        }
        let field =
            |range: std::ops::Range<usize>| bytes.get(range).ok_or(PersistenceError::Corrupt);
        Ok(Self {
            identity_hash: field(3..51)?
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?,
            session: field(51..67)?
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?,
            key_id: field(67..83)?
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?,
            context_hash: field(83..131)?
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?,
            lifecycle: Lifecycle::decode(bytes[131])?,
            data_key: field(132..164)?
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?,
        })
    }
}

/// The effective user of this process, as the owner of its `/proc/self` directory.
fn current_uid() -> Result<u32, PersistenceError> {
    fs::metadata("/proc/self")
        .map(|metadata| metadata.uid())
        .map_err(|_| PersistenceError::SecureStoreUnavailable)
}

/// A store directory must belong to this user and admit nobody else.
fn validate_directory(root: &Path, uid: u32) -> Result<(), PersistenceError> {
    let metadata = fs::symlink_metadata(root).map_err(|_| PersistenceError::Io)?;
    if !metadata.is_dir() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
        return Err(PersistenceError::SecureStoreAccessDenied);
    }
    Ok(())
}

fn validate_file(path: &Path, uid: u32) -> Result<(), PersistenceError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| PersistenceError::Io)?;
    if !metadata.is_file() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
        return Err(PersistenceError::SecureStoreAccessDenied);
    }
    Ok(())
}

fn sync_directory(root: &Path) -> Result<(), PersistenceError> {
    File::open(root)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| PersistenceError::Io)
}

pub(crate) struct WslDpapiEnvelopeKeyStore<W: DpapiWrapper> {
    root: PathBuf,
    uid: u32,
    wrapper: W,
    identity_hash: [u8; 48],
    operation_lock: Mutex<()>,
}

impl<W: DpapiWrapper> WslDpapiEnvelopeKeyStore<W> {
    pub(crate) fn new(root: &Path, wrapper: W) -> Result<Self, PersistenceError> {
        let uid = current_uid()?;
        if uid == 0 {
            return Err(PersistenceError::SecureStoreAccessDenied);
        }
        if !root.exists() {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(root)
                .map_err(|_| PersistenceError::Io)?;
        }
        validate_directory(root, uid)?;
        let root = root.canonicalize().map_err(|_| PersistenceError::Io)?;
        let identity_hash = Self::identity_hash(&wrapper, uid)?;
        Ok(Self {
            root,
            uid,
            wrapper,
            identity_hash,
            operation_lock: Mutex::new(()),
        })
    }

    fn identity_hash(wrapper: &W, uid: u32) -> Result<[u8; 48], PersistenceError> {
        let sid = wrapper.identity()?;
        hash(format!("axl-wsl-dpapi-v1\0{sid}\0{uid}").as_bytes())
    }

    fn lock(&self) -> Result<MutexGuard<'_, ()>, PersistenceError> {
        self.operation_lock
            .lock()
            .map_err(|_| PersistenceError::SecureStoreUnavailable)
    }

    fn path(&self, session: Id, key_id: Id, lifecycle: Lifecycle) -> PathBuf {
        self.root.join(format!(
            "{FILE_PREFIX}{}-{}-{}{FILE_SUFFIX}",
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
        if fs::symlink_metadata(&path).is_err() {
            return Ok(None);
        }
        validate_file(&path, self.uid)?;
        let mut protected = Vec::new();
        File::open(&path)
            .map_err(|_| PersistenceError::Io)?
            .take((MAX_RECORD_BYTES + 1) as u64)
            .read_to_end(&mut protected)
            .map_err(|_| PersistenceError::Io)?;
        if protected.len() > MAX_RECORD_BYTES {
            protected.fill(0);
            return Err(PersistenceError::Corrupt);
        }
        let plaintext = self.wrapper.unprotect(&protected);
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
        let temporary = path.with_extension(format!("tmp.{}", std::process::id()));
        if fs::symlink_metadata(&temporary).is_ok() {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        let mut plaintext = record.encode();
        let protected = self.wrapper.protect(&plaintext);
        plaintext.fill(0);
        let mut protected = protected?;
        let written = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(0o400_000) // O_NOFOLLOW
            .open(&temporary)
            .and_then(|mut file| {
                file.write_all(&protected)?;
                file.sync_all()
            })
            .map_err(|_| PersistenceError::Io);
        protected.fill(0);
        if let Err(error) = written {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .and_then(|()| fs::rename(&temporary, &path))
            .map_err(|_| PersistenceError::Io)?;
        sync_directory(&self.root)
    }

    fn delete_and_verify(&self, path: &Path) -> Result<(), PersistenceError> {
        if fs::symlink_metadata(path).is_ok() {
            validate_file(path, self.uid)?;
            fs::remove_file(path).map_err(|_| PersistenceError::Io)?;
            sync_directory(&self.root)?;
        }
        if fs::symlink_metadata(path).is_ok() {
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
        if records.is_empty() {
            return Err(PersistenceError::KeyRecordMissing);
        }
        if records.len() > 2 {
            return Err(PersistenceError::SecureStoreAmbiguous);
        }
        if records
            .iter()
            .any(|(_, record)| record.context_hash != expected_hash)
        {
            return Err(PersistenceError::Corrupt);
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
            self.write_record(&KeyRecord {
                lifecycle: Lifecycle::Active,
                ..prepared.clone()
            })?;
        }
        if let Some((path, _)) = prepared {
            self.delete_and_verify(path)?;
        }
        Ok(())
    }

    fn entries(&self) -> Result<Vec<(PathBuf, Id, Id, Lifecycle)>, PersistenceError> {
        let mut entries = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(|_| PersistenceError::Io)? {
            let entry = entry.map_err(|_| PersistenceError::Io)?;
            if let Some((session, key_id, lifecycle)) = parse_filename(&entry.file_name()) {
                entries.push((entry.path(), session, key_id, lifecycle));
            }
        }
        Ok(entries)
    }
}

impl<W: DpapiWrapper> EnvelopeKeyStore for WslDpapiEnvelopeKeyStore<W> {
    fn available(&self) -> bool {
        validate_directory(&self.root, self.uid).is_ok()
            && Self::identity_hash(&self.wrapper, self.uid)
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
        let [(_, record)] = records.as_slice() else {
            return Err(if records.is_empty() {
                PersistenceError::KeyRecordMissing
            } else {
                PersistenceError::SecureStoreAmbiguous
            });
        };
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
        for (path, record_session, key_id, lifecycle) in self.entries()? {
            if record_session == session
                && lifecycle == Lifecycle::Prepared
                && committed_current
                    .as_ref()
                    .is_none_or(|(current, _)| *current != key_id)
            {
                self.read_record(record_session, key_id, lifecycle)?
                    .ok_or(PersistenceError::KeyRecordMissing)?;
                self.delete_and_verify(&path)?;
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
        for (path, record_session, key_id, lifecycle) in self.entries()? {
            if record_session == session && seen.insert((key_id, lifecycle)) {
                self.read_record(record_session, key_id, lifecycle)?
                    .ok_or(PersistenceError::KeyRecordMissing)?;
                self.delete_and_verify(&path)?;
            }
        }
        Ok(())
    }
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
    let value = value.strip_prefix(FILE_PREFIX)?.strip_suffix(FILE_SUFFIX)?;
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
    if value.len() != 32 {
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
    use std::{
        io::Cursor,
        sync::atomic::{AtomicBool, Ordering},
    };

    use super::*;

    /// Stands in for DPAPI: seals with a per-user key and a tag, so a record sealed for one user
    /// or changed on disk does not open.
    struct FakeDpapi {
        sid: &'static str,
        down: AtomicBool,
    }

    impl FakeDpapi {
        fn new(sid: &'static str) -> Self {
            Self {
                sid,
                down: AtomicBool::new(false),
            }
        }

        fn stream(&self, value: &[u8]) -> Vec<u8> {
            let key = hash(self.sid.as_bytes()).unwrap();
            value
                .iter()
                .enumerate()
                .map(|(index, byte)| byte ^ key[index % key.len()])
                .collect()
        }
    }

    impl DpapiWrapper for FakeDpapi {
        fn identity(&self) -> Result<String, PersistenceError> {
            if self.down.load(Ordering::SeqCst) {
                return Err(PersistenceError::SecureStoreUnavailable);
            }
            Ok(self.sid.to_owned())
        }

        fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>, PersistenceError> {
            if self.down.load(Ordering::SeqCst) {
                return Err(PersistenceError::SecureStoreUnavailable);
            }
            let mut sealed = self.stream(plaintext);
            sealed.extend_from_slice(&hash(&[self.sid.as_bytes(), plaintext].concat())?);
            Ok(sealed)
        }

        fn unprotect(&self, protected: &[u8]) -> Result<Vec<u8>, PersistenceError> {
            if self.down.load(Ordering::SeqCst) {
                return Err(PersistenceError::SecureStoreUnavailable);
            }
            let split = protected
                .len()
                .checked_sub(48)
                .ok_or(PersistenceError::SecureStoreAccessDenied)?;
            let plaintext = self.stream(&protected[..split]);
            if hash(&[self.sid.as_bytes(), &plaintext].concat())?.as_slice() != &protected[split..]
            {
                return Err(PersistenceError::SecureStoreAccessDenied);
            }
            Ok(plaintext)
        }
    }

    fn root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "axl-wsl-dpapi-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        root
    }

    const SESSION: Id = [2; 16];
    const KEY: Id = [3; 16];
    const DATA: [u8; 32] = [7; 32];

    #[test]
    fn prepared_keys_load_only_once_activated_and_survive_reopening() {
        let root = root("lifecycle");
        let store = WslDpapiEnvelopeKeyStore::new(&root, FakeDpapi::new("S-1-5-21-1")).unwrap();
        assert!(store.available());
        assert_eq!(
            fs::metadata(&root).unwrap().mode() & 0o777,
            0o700,
            "the store directory admits only its owner"
        );
        store.prepare(SESSION, KEY, &DATA, b"context").unwrap();
        store.prepare(SESSION, KEY, &DATA, b"context").unwrap();
        assert_eq!(
            store.prepare(SESSION, KEY, &[8; 32], b"context"),
            Err(PersistenceError::Conflict)
        );
        assert_eq!(
            store.load(SESSION, KEY, b"context"),
            Err(PersistenceError::KeyUnavailable)
        );
        store.activate(SESSION, KEY, b"context").unwrap();
        store.activate(SESSION, KEY, b"context").unwrap();
        assert_eq!(store.load(SESSION, KEY, b"context").unwrap(), DATA);
        assert_eq!(
            store.load(SESSION, KEY, b"other context"),
            Err(PersistenceError::KeyUnavailable)
        );
        for entry in fs::read_dir(&root).unwrap() {
            let entry = entry.unwrap();
            assert_eq!(entry.metadata().unwrap().mode() & 0o777, 0o600);
            let bytes = fs::read(entry.path()).unwrap();
            assert!(
                !bytes.windows(32).any(|window| window == DATA),
                "no key at rest"
            );
        }
        drop(store);
        let reopened = WslDpapiEnvelopeKeyStore::new(&root, FakeDpapi::new("S-1-5-21-1")).unwrap();
        assert_eq!(reopened.load(SESSION, KEY, b"context").unwrap(), DATA);
        reopened.erase(SESSION, KEY).unwrap();
        assert_eq!(
            reopened.load(SESSION, KEY, b"context"),
            Err(PersistenceError::KeyRecordMissing)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn another_windows_user_or_a_changed_record_cannot_open_keys() {
        let root = root("identity");
        let store = WslDpapiEnvelopeKeyStore::new(&root, FakeDpapi::new("S-1-5-21-1")).unwrap();
        store.prepare(SESSION, KEY, &DATA, b"context").unwrap();
        store.activate(SESSION, KEY, b"context").unwrap();
        let other = WslDpapiEnvelopeKeyStore::new(&root, FakeDpapi::new("S-1-5-21-2")).unwrap();
        assert_eq!(
            other.load(SESSION, KEY, b"context"),
            Err(PersistenceError::SecureStoreAccessDenied)
        );
        let path = store.path(SESSION, KEY, Lifecycle::Active);
        let mut bytes = fs::read(&path).unwrap();
        bytes[0] ^= 1;
        fs::write(&path, bytes).unwrap();
        assert!(store.load(SESSION, KEY, b"context").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_record_renamed_to_another_key_is_refused() {
        let root = root("rename");
        let store = WslDpapiEnvelopeKeyStore::new(&root, FakeDpapi::new("S-1-5-21-1")).unwrap();
        store.prepare(SESSION, KEY, &DATA, b"context").unwrap();
        store.activate(SESSION, KEY, b"context").unwrap();
        fs::rename(
            store.path(SESSION, KEY, Lifecycle::Active),
            store.path(SESSION, [9; 16], Lifecycle::Active),
        )
        .unwrap();
        assert_eq!(
            store.load(SESSION, [9; 16], b"context"),
            Err(PersistenceError::Corrupt)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reconciliation_keeps_the_committed_key_and_drops_abandoned_ones() {
        let root = root("reconcile");
        let store = WslDpapiEnvelopeKeyStore::new(&root, FakeDpapi::new("S-1-5-21-1")).unwrap();
        store.prepare(SESSION, KEY, &DATA, b"current").unwrap();
        store
            .prepare(SESSION, [4; 16], &[5; 32], b"abandoned")
            .unwrap();
        store
            .prepare([6; 16], [4; 16], &[5; 32], b"other session")
            .unwrap();
        store
            .reconcile_prepared(SESSION, Some((KEY, b"current".to_vec())))
            .unwrap();
        assert_eq!(store.load(SESSION, KEY, b"current").unwrap(), DATA);
        assert_eq!(
            store.load(SESSION, [4; 16], b"abandoned"),
            Err(PersistenceError::KeyRecordMissing)
        );
        assert_eq!(
            store.load([6; 16], [4; 16], b"other session"),
            Err(PersistenceError::KeyUnavailable),
            "another session's prepared key is left alone"
        );
        store.destroy_session(SESSION).unwrap();
        assert_eq!(
            store.load(SESSION, KEY, b"current"),
            Err(PersistenceError::KeyRecordMissing)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_crash_between_activation_steps_resolves_to_one_active_record() {
        let root = root("crash");
        let store = WslDpapiEnvelopeKeyStore::new(&root, FakeDpapi::new("S-1-5-21-1")).unwrap();
        store.prepare(SESSION, KEY, &DATA, b"context").unwrap();
        // The active copy was written but the process died before removing the prepared one.
        let prepared = store
            .read_record(SESSION, KEY, Lifecycle::Prepared)
            .unwrap()
            .unwrap();
        store
            .write_record(&KeyRecord {
                lifecycle: Lifecycle::Active,
                ..prepared.clone()
            })
            .unwrap();
        assert_eq!(
            store.load(SESSION, KEY, b"context"),
            Err(PersistenceError::SecureStoreAmbiguous)
        );
        store.activate(SESSION, KEY, b"context").unwrap();
        assert_eq!(store.load(SESSION, KEY, b"context").unwrap(), DATA);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_unavailable_helper_or_an_open_directory_fails_closed() {
        let root = root("closed");
        let wrapper = FakeDpapi::new("S-1-5-21-1");
        let store = WslDpapiEnvelopeKeyStore::new(&root, wrapper).unwrap();
        store.wrapper.down.store(true, Ordering::SeqCst);
        assert!(!store.available());
        assert_eq!(
            store.prepare(SESSION, KEY, &DATA, b"context"),
            Err(PersistenceError::SecureStoreUnavailable)
        );
        store.wrapper.down.store(false, Ordering::SeqCst);
        fs::set_permissions(&root, fs::Permissions::from_mode(0o750)).unwrap();
        assert!(!store.available());
        assert!(matches!(
            WslDpapiEnvelopeKeyStore::new(&root, FakeDpapi::new("S-1-5-21-1")),
            Err(PersistenceError::SecureStoreAccessDenied)
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn helper_frames_carry_status_and_bounded_values() {
        let mut sent = Vec::new();
        let mut answer = Cursor::new(vec![0, 0, 0, 0, 2, b'o', b'k']);
        assert_eq!(
            exchange(&mut sent, &mut answer, OP_PROTECT, b"xyz").unwrap(),
            b"ok"
        );
        assert_eq!(sent, [2, 0, 0, 0, 3, b'x', b'y', b'z']);
        let mut denied = Cursor::new(vec![STATUS_DENIED, 0, 0, 0, 0]);
        assert_eq!(
            exchange(&mut Vec::new(), &mut denied, OP_UNPROTECT, b"x"),
            Err(PersistenceError::SecureStoreAccessDenied)
        );
        let mut oversized = Cursor::new(vec![0, 0xff, 0xff, 0xff, 0xff]);
        assert_eq!(
            exchange(&mut Vec::new(), &mut oversized, OP_UNPROTECT, b"x"),
            Err(PersistenceError::SecureStoreUnavailable)
        );
        let mut truncated = Cursor::new(vec![0, 0, 0, 0, 9, 1]);
        assert_eq!(
            exchange(&mut Vec::new(), &mut truncated, OP_UNPROTECT, b"x"),
            Err(PersistenceError::SecureStoreUnavailable)
        );
    }

    /// Runs against the real helper through WSL interop:
    /// `AXL_WSL_DPAPI_HELPER=/mnt/c/.../axl-dpapi-helper.exe cargo test wsl_dpapi -- --ignored`.
    #[test]
    #[ignore = "needs WSL interop and a built axl-dpapi-helper.exe"]
    fn real_helper_round_trips_records_for_this_windows_user() {
        let helper = std::env::var("AXL_WSL_DPAPI_HELPER").expect("AXL_WSL_DPAPI_HELPER");
        let root = root("real");
        let store =
            WslDpapiEnvelopeKeyStore::new(&root, HelperProcess::new(Path::new(&helper)).unwrap())
                .unwrap();
        assert!(store.available());
        store.prepare(SESSION, KEY, &DATA, b"context").unwrap();
        store.activate(SESSION, KEY, b"context").unwrap();
        assert_eq!(store.load(SESSION, KEY, b"context").unwrap(), DATA);
        let reopened =
            WslDpapiEnvelopeKeyStore::new(&root, HelperProcess::new(Path::new(&helper)).unwrap())
                .unwrap();
        assert_eq!(reopened.load(SESSION, KEY, b"context").unwrap(), DATA);
        fs::remove_dir_all(root).unwrap();
    }
}
