// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

//! Deployment-test envelope keys persisted in one owner-only file.
//!
//! This is not a secure key store: data keys rest unwrapped on disk, protected only by file
//! permissions. It exists so a daemon can hold a paired session across restarts against the
//! hosted deployment-test stack on hosts without a supported platform store (for example WSL).
//! Production artifacts never contain it.

use axl_e2ee::{
    Id,
    persistence::{EnvelopeKeyStore, PersistenceError},
};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

const FILE_NAME: &str = "deployment-test-keys";
const FORMAT: &str = "axl-deployment-test-keys-v1";
const MAX_RECORDS: usize = 4_096;
const MAX_CONTEXT_BYTES: usize = 4_096;

#[derive(Clone)]
struct KeyRecord {
    session: Id,
    key: [u8; 32],
    context: Vec<u8>,
    active: bool,
}

pub(crate) struct DeploymentTestFileKeys {
    path: PathBuf,
    records: Mutex<BTreeMap<[u8; 16], KeyRecord>>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Result<Vec<u8>, PersistenceError> {
    if !text.len().is_multiple_of(2) {
        return Err(PersistenceError::Corrupt);
    }
    (0..text.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(
                text.get(index..index + 2)
                    .ok_or(PersistenceError::Corrupt)?,
                16,
            )
            .map_err(|_| PersistenceError::Corrupt)
        })
        .collect()
}

fn fixed<const N: usize>(text: &str) -> Result<[u8; N], PersistenceError> {
    unhex(text)?
        .try_into()
        .map_err(|_| PersistenceError::Corrupt)
}

fn decode(text: &str) -> Result<BTreeMap<[u8; 16], KeyRecord>, PersistenceError> {
    let mut lines = text.lines();
    if lines.next() != Some(FORMAT) {
        return Err(PersistenceError::Corrupt);
    }
    let mut records = BTreeMap::new();
    for line in lines {
        let fields: Vec<&str> = line.split(' ').collect();
        let [session, key_id, key, active, context] = fields.as_slice() else {
            return Err(PersistenceError::Corrupt);
        };
        let context = unhex(context)?;
        if context.len() > MAX_CONTEXT_BYTES || records.len() >= MAX_RECORDS {
            return Err(PersistenceError::Corrupt);
        }
        let record = KeyRecord {
            session: fixed(session)?,
            key: fixed(key)?,
            context,
            active: match *active {
                "0" => false,
                "1" => true,
                _ => return Err(PersistenceError::Corrupt),
            },
        };
        if records.insert(fixed(key_id)?, record).is_some() {
            return Err(PersistenceError::Corrupt);
        }
    }
    Ok(records)
}

fn encode(records: &BTreeMap<[u8; 16], KeyRecord>) -> String {
    let mut out = String::from(FORMAT);
    for (key_id, record) in records {
        out.push('\n');
        out.push_str(&format!(
            "{} {} {} {} {}",
            hex(&record.session),
            hex(key_id),
            hex(&record.key),
            if record.active { "1" } else { "0" },
            hex(&record.context)
        ));
    }
    out.push('\n');
    out
}

fn owner_only(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(not(unix))]
    let _ = options;
}

impl DeploymentTestFileKeys {
    pub(crate) fn open(root: &Path) -> Result<Self, PersistenceError> {
        fs::create_dir_all(root).map_err(|_| PersistenceError::Storage)?;
        let path = root.join(FILE_NAME);
        let records = match fs::read_to_string(&path) {
            Ok(text) => decode(&text)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(_) => return Err(PersistenceError::Storage),
        };
        Ok(Self {
            path,
            records: Mutex::new(records),
        })
    }

    /// Apply one change and make it durable before it is visible: write a sibling, sync it, and
    /// rename it over the file. A failed write leaves the previous durable state in memory too.
    fn update<T>(
        &self,
        change: impl FnOnce(&mut BTreeMap<[u8; 16], KeyRecord>) -> Result<T, PersistenceError>,
    ) -> Result<T, PersistenceError> {
        let mut records = self.records.lock().map_err(|_| PersistenceError::Storage)?;
        let mut next = records.clone();
        let value = change(&mut next)?;
        if next.len() > MAX_RECORDS {
            return Err(PersistenceError::Storage);
        }
        let staging = self.path.with_extension("next");
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        owner_only(&mut options);
        let mut file = options
            .open(&staging)
            .map_err(|_| PersistenceError::Storage)?;
        file.write_all(encode(&next).as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|_| PersistenceError::Storage)?;
        drop(file);
        fs::rename(&staging, &self.path).map_err(|_| PersistenceError::Storage)?;
        if let Some(parent) = self.path.parent() {
            #[cfg(unix)]
            File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| PersistenceError::Storage)?;
            #[cfg(not(unix))]
            let _ = parent;
        }
        *records = next;
        Ok(value)
    }
}

fn matching(record: &KeyRecord, session: Id, context: &[u8]) -> Result<(), PersistenceError> {
    if record.session != session || record.context != context {
        return Err(PersistenceError::IdentityMismatch);
    }
    Ok(())
}

impl EnvelopeKeyStore for DeploymentTestFileKeys {
    fn available(&self) -> bool {
        true
    }
    fn prepare(
        &self,
        session: Id,
        key_id: [u8; 16],
        key: &[u8; 32],
        context: &[u8],
    ) -> Result<(), PersistenceError> {
        if context.len() > MAX_CONTEXT_BYTES {
            return Err(PersistenceError::Storage);
        }
        self.update(|records| {
            if records.contains_key(&key_id) {
                return Err(PersistenceError::Conflict);
            }
            records.insert(
                key_id,
                KeyRecord {
                    session,
                    key: *key,
                    context: context.to_vec(),
                    active: false,
                },
            );
            Ok(())
        })
    }
    fn load(
        &self,
        session: Id,
        key_id: [u8; 16],
        context: &[u8],
    ) -> Result<[u8; 32], PersistenceError> {
        let records = self.records.lock().map_err(|_| PersistenceError::Storage)?;
        let record = records
            .get(&key_id)
            .ok_or(PersistenceError::KeyUnavailable)?;
        matching(record, session, context)?;
        if !record.active {
            return Err(PersistenceError::KeyUnavailable);
        }
        Ok(record.key)
    }
    fn activate(
        &self,
        session: Id,
        key_id: [u8; 16],
        context: &[u8],
    ) -> Result<(), PersistenceError> {
        self.update(|records| {
            let record = records
                .get_mut(&key_id)
                .ok_or(PersistenceError::KeyUnavailable)?;
            matching(record, session, context)?;
            record.active = true;
            Ok(())
        })
    }
    fn reconcile_prepared(
        &self,
        session: Id,
        committed: Option<([u8; 16], Vec<u8>)>,
    ) -> Result<(), PersistenceError> {
        self.update(|records| {
            if let Some((key_id, context)) = committed {
                let record = records
                    .get_mut(&key_id)
                    .ok_or(PersistenceError::KeyUnavailable)?;
                matching(record, session, &context)?;
                record.active = true;
            }
            records.retain(|_, record| record.session != session || record.active);
            Ok(())
        })
    }
    fn erase(&self, session: Id, key_id: [u8; 16]) -> Result<(), PersistenceError> {
        self.update(|records| {
            if records
                .get(&key_id)
                .is_some_and(|record| record.session != session)
            {
                return Err(PersistenceError::IdentityMismatch);
            }
            records.remove(&key_id);
            Ok(())
        })
    }
    fn destroy_session(&self, session: Id) -> Result<(), PersistenceError> {
        self.update(|records| {
            records.retain(|_, record| record.session != session);
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("axl-deployment-keys-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn keys_survive_reopening_and_follow_the_store_contract() {
        let root = root("contract");
        let session = [7; 16];
        {
            let keys = DeploymentTestFileKeys::open(&root).unwrap();
            keys.prepare(session, [1; 16], &[9; 32], b"ctx").unwrap();
            assert_eq!(
                keys.prepare(session, [1; 16], &[9; 32], b"ctx"),
                Err(PersistenceError::Conflict)
            );
            assert_eq!(
                keys.load(session, [1; 16], b"ctx"),
                Err(PersistenceError::KeyUnavailable)
            );
            keys.activate(session, [1; 16], b"ctx").unwrap();
            keys.prepare(session, [2; 16], &[8; 32], b"next").unwrap();
        }
        let keys = DeploymentTestFileKeys::open(&root).unwrap();
        assert_eq!(keys.load(session, [1; 16], b"ctx"), Ok([9; 32]));
        assert_eq!(
            keys.load(session, [1; 16], b"other"),
            Err(PersistenceError::IdentityMismatch)
        );
        // An unconfirmed prepared key does not survive reconciliation.
        keys.reconcile_prepared(session, None).unwrap();
        assert_eq!(
            keys.load(session, [2; 16], b"next"),
            Err(PersistenceError::KeyUnavailable)
        );
        keys.destroy_session(session).unwrap();
        assert_eq!(
            DeploymentTestFileKeys::open(&root)
                .unwrap()
                .load(session, [1; 16], b"ctx"),
            Err(PersistenceError::KeyUnavailable)
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(root.join(FILE_NAME))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o077, 0);
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_damaged_file_fails_closed() {
        let root = root("corrupt");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(FILE_NAME), "not the format\n").unwrap();
        assert!(matches!(
            DeploymentTestFileKeys::open(&root),
            Err(PersistenceError::Corrupt)
        ));
        fs::remove_dir_all(&root).unwrap();
    }
}
