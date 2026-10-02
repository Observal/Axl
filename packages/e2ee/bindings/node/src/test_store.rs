// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

use axl_e2ee::{
    Id,
    persistence::{EnvelopeKeyStore, PersistenceError},
};
use std::{collections::BTreeMap, sync::Mutex};

struct KeyRecord {
    session: Id,
    key: [u8; 32],
    context: Vec<u8>,
    active: bool,
}

#[derive(Default)]
pub(crate) struct TestKeys {
    records: Mutex<BTreeMap<[u8; 16], KeyRecord>>,
}

impl EnvelopeKeyStore for TestKeys {
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
        let mut records = self.records.lock().map_err(|_| PersistenceError::Storage)?;
        if records
            .insert(
                key_id,
                KeyRecord {
                    session,
                    key: *key,
                    context: context.to_vec(),
                    active: false,
                },
            )
            .is_some()
        {
            return Err(PersistenceError::Conflict);
        }
        Ok(())
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
        if record.session != session || record.context != context {
            return Err(PersistenceError::IdentityMismatch);
        }
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
        let mut records = self.records.lock().map_err(|_| PersistenceError::Storage)?;
        let record = records
            .get_mut(&key_id)
            .ok_or(PersistenceError::KeyUnavailable)?;
        if record.session != session || record.context != context {
            return Err(PersistenceError::IdentityMismatch);
        }
        record.active = true;
        Ok(())
    }
    fn reconcile_prepared(
        &self,
        session: Id,
        committed: Option<([u8; 16], Vec<u8>)>,
    ) -> Result<(), PersistenceError> {
        let mut records = self.records.lock().map_err(|_| PersistenceError::Storage)?;
        if let Some((key_id, context)) = committed {
            let record = records
                .get_mut(&key_id)
                .ok_or(PersistenceError::KeyUnavailable)?;
            if record.session != session || record.context != context {
                return Err(PersistenceError::IdentityMismatch);
            }
            record.active = true;
        }
        records.retain(|_, record| record.session != session || record.active);
        Ok(())
    }
    fn erase(&self, session: Id, key_id: [u8; 16]) -> Result<(), PersistenceError> {
        let mut records = self.records.lock().map_err(|_| PersistenceError::Storage)?;
        if records
            .get(&key_id)
            .is_some_and(|record| record.session != session)
        {
            return Err(PersistenceError::IdentityMismatch);
        }
        records.remove(&key_id);
        Ok(())
    }
    fn destroy_session(&self, session: Id) -> Result<(), PersistenceError> {
        self.records
            .lock()
            .map_err(|_| PersistenceError::Storage)?
            .retain(|_, record| record.session != session);
        Ok(())
    }
}
