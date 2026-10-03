// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

//! macOS side of the sealed-file envelope-key store.
//!
//! The data-protection Keychain answers only a process signed with an application identifier and
//! a `keychain-access-groups` entitlement, which the stock `node` running the daemon lacks. So the
//! daemon keeps its envelope-key records in owner-only files and asks this signed process to seal
//! and open them. The helper keeps one wrapping key, a random 16-byte identifier and a 32-byte
//! AES-256 key, as a single generic-password item in the data-protection Keychain, accessible only
//! while the device is unlocked, never synchronized, and never behind authentication UI. It creates
//! the item on first use and reads it again for every request, so a locked Keychain is noticed.
//!
//! The helper is stateless toward the store: it never sees a file, a path, or a record identity,
//! only one bounded value per request, so every lifecycle and crash-ordering decision stays in the
//! store's Rust code. It speaks the WSL DPAPI helper's frames, big-endian lengths:
//!
//! ```text
//! request:  op u8 | length u32 | payload
//! response: status u8 | length u32 | payload
//! ```
//!
//! Operations: `0` hello (answers the protocol name), `1` identity (the wrapping key's identifier
//! in lowercase hex), `2` protect, `3` unprotect. Statuses: `0` ok, `1` unavailable (for example a
//! locked Keychain), `2` access denied (a missing entitlement, a refused access, a duplicate or
//! malformed item, or a value sealed under another key), `3` bad request. A sealed value is
//! `version u8 | key identifier | nonce | AES-256-GCM ciphertext and tag`. The helper exits at end
//! of input. See `docs/architecture/remote-production-desktop.md`.

use std::io::{self, Read, Write};

const PROTOCOL: &[u8] = b"axl-keychain-helper-v1";
const MAX_PAYLOAD: usize = 64 * 1024;

const OP_HELLO: u8 = 0;
const OP_IDENTITY: u8 = 1;
const OP_PROTECT: u8 = 2;
const OP_UNPROTECT: u8 = 3;

const STATUS_OK: u8 = 0;
const STATUS_UNAVAILABLE: u8 = 1;
const STATUS_DENIED: u8 = 2;
const STATUS_BAD_REQUEST: u8 = 3;

#[derive(Debug, Eq, PartialEq)]
enum Failure {
    Unavailable,
    Denied,
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut input = stdin.lock();
    let mut output = stdout.lock();
    loop {
        let mut header = [0_u8; 5];
        match input.read_exact(&mut header) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return,
            Err(_) => std::process::exit(1),
        }
        let length = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
        if length > MAX_PAYLOAD {
            // The stream can no longer be framed; stop rather than guess.
            let _ = respond(&mut output, STATUS_BAD_REQUEST, &[]);
            std::process::exit(1);
        }
        let mut payload = vec![0_u8; length];
        if input.read_exact(&mut payload).is_err() {
            std::process::exit(1);
        }
        let result = handle(header[0], &payload, keychain::wrapping_key);
        payload.fill(0);
        let written = match result {
            Some(Ok(mut value)) => {
                let written = respond(&mut output, STATUS_OK, &value);
                value.fill(0);
                written
            }
            Some(Err(Failure::Unavailable)) => respond(&mut output, STATUS_UNAVAILABLE, &[]),
            Some(Err(Failure::Denied)) => respond(&mut output, STATUS_DENIED, &[]),
            None => respond(&mut output, STATUS_BAD_REQUEST, &[]),
        };
        if written.is_err() {
            std::process::exit(1);
        }
    }
}

fn respond(output: &mut impl Write, status: u8, payload: &[u8]) -> io::Result<()> {
    let length = u32::try_from(payload.len()).map_err(|_| io::ErrorKind::InvalidInput)?;
    let mut header = [0_u8; 5];
    header[0] = status;
    header[1..].copy_from_slice(&length.to_be_bytes());
    output.write_all(&header)?;
    output.write_all(payload)?;
    output.flush()
}

fn handle(
    op: u8,
    payload: &[u8],
    key: impl FnOnce() -> Result<seal::WrappingKey, Failure>,
) -> Option<Result<Vec<u8>, Failure>> {
    match op {
        OP_HELLO if payload.is_empty() => Some(Ok(PROTOCOL.to_vec())),
        OP_IDENTITY if payload.is_empty() => Some(key().map(|key| key.identity().into_bytes())),
        OP_PROTECT if !payload.is_empty() => {
            Some(key().and_then(|key| seal::protect(&key, payload)))
        }
        OP_UNPROTECT if !payload.is_empty() => {
            Some(key().and_then(|key| seal::unprotect(&key, payload)))
        }
        _ => None,
    }
}

/// AES-256-GCM under the wrapping key, bound to the protocol and the key's identifier.
mod seal {
    use openmls_libcrux_crypto::Provider;
    use openmls_traits::{
        OpenMlsProvider as _, crypto::OpenMlsCrypto as _, random::OpenMlsRand as _, types::AeadType,
    };

    use super::{Failure, MAX_PAYLOAD, PROTOCOL};

    const VERSION: u8 = 1;
    pub(super) const KEY_ID_BYTES: usize = 16;
    pub(super) const KEY_BYTES: usize = 32;
    const NONCE_BYTES: usize = 12;
    const TAG_BYTES: usize = 16;
    const HEADER_BYTES: usize = 1 + KEY_ID_BYTES + NONCE_BYTES;

    /// The Keychain item's value: `identifier | key`.
    pub(super) struct WrappingKey {
        id: [u8; KEY_ID_BYTES],
        key: [u8; KEY_BYTES],
    }

    impl Drop for WrappingKey {
        fn drop(&mut self) {
            self.key.fill(0);
        }
    }

    impl WrappingKey {
        #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
        pub(super) fn generate() -> Result<Vec<u8>, Failure> {
            let provider = Provider::new().map_err(|_| Failure::Unavailable)?;
            provider
                .rand()
                .random_vec(KEY_ID_BYTES + KEY_BYTES)
                .map_err(|_| Failure::Unavailable)
        }

        /// A stored item value; anything but exactly `identifier | key` is refused.
        pub(super) fn decode(value: &[u8]) -> Result<Self, Failure> {
            if value.len() != KEY_ID_BYTES + KEY_BYTES {
                return Err(Failure::Denied);
            }
            let mut key = Self {
                id: [0; KEY_ID_BYTES],
                key: [0; KEY_BYTES],
            };
            key.id.copy_from_slice(&value[..KEY_ID_BYTES]);
            key.key.copy_from_slice(&value[KEY_ID_BYTES..]);
            Ok(key)
        }

        pub(super) fn identity(&self) -> String {
            self.id.iter().map(|byte| format!("{byte:02x}")).collect()
        }

        fn aad(&self) -> Vec<u8> {
            [PROTOCOL, &self.id].concat()
        }
    }

    pub(super) fn protect(key: &WrappingKey, plaintext: &[u8]) -> Result<Vec<u8>, Failure> {
        let provider = Provider::new().map_err(|_| Failure::Unavailable)?;
        let nonce: [u8; NONCE_BYTES] = provider
            .rand()
            .random_array()
            .map_err(|_| Failure::Unavailable)?;
        let ciphertext = provider
            .crypto()
            .aead_encrypt(AeadType::Aes256Gcm, &key.key, plaintext, &nonce, &key.aad())
            .map_err(|_| Failure::Unavailable)?;
        let mut sealed = Vec::with_capacity(HEADER_BYTES + ciphertext.len());
        sealed.push(VERSION);
        sealed.extend_from_slice(&key.id);
        sealed.extend_from_slice(&nonce);
        sealed.extend_from_slice(&ciphertext);
        if sealed.len() > MAX_PAYLOAD {
            return Err(Failure::Unavailable);
        }
        Ok(sealed)
    }

    pub(super) fn unprotect(key: &WrappingKey, sealed: &[u8]) -> Result<Vec<u8>, Failure> {
        if sealed.len() < HEADER_BYTES + TAG_BYTES
            || sealed[0] != VERSION
            || sealed[1..1 + KEY_ID_BYTES] != key.id
        {
            return Err(Failure::Denied);
        }
        let provider = Provider::new().map_err(|_| Failure::Unavailable)?;
        provider
            .crypto()
            .aead_decrypt(
                AeadType::Aes256Gcm,
                &key.key,
                &sealed[HEADER_BYTES..],
                &sealed[1 + KEY_ID_BYTES..HEADER_BYTES],
                &key.aad(),
            )
            .map_err(|_| Failure::Denied)
    }
}

#[cfg(target_os = "macos")]
mod keychain {
    use std::{fs, os::unix::fs::MetadataExt as _};

    use core_foundation::{
        base::{TCFType as _, ToVoid as _},
        boolean::CFBoolean,
        data::CFData,
        dictionary::CFMutableDictionary,
    };
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

    use super::{Failure, seal::WrappingKey};

    const SERVICE: &str = "ai.observal.axl.e2ee.sealing-key.v1";
    const ACCOUNT: &str = "wrapping-key";
    const ACCESSIBLE_WHEN_UNLOCKED_THIS_DEVICE_ONLY: &str = "aku";
    const DUPLICATE_ITEM: i32 = -25299;
    const ITEM_NOT_FOUND: i32 = -25300;

    /// The wrapping key, created on first use. Two helpers creating it at once agree on the one
    /// the Keychain kept.
    pub(super) fn wrapping_key() -> Result<WrappingKey, Failure> {
        require_interactive_user()?;
        if let Some(key) = read()? {
            return Ok(key);
        }
        let mut value = WrappingKey::generate()?;
        let added = insert(&value);
        value.fill(0);
        added?;
        read()?.ok_or(Failure::Unavailable)
    }

    fn search(data: bool) -> ItemSearchOptions {
        let mut search = ItemSearchOptions::new();
        search
            .class(ItemClass::generic_password())
            .service(SERVICE)
            .account(ACCOUNT)
            .cloud_sync(CloudSync::MatchSyncNo)
            .ignore_legacy_keychains()
            .skip_authenticated_items(true)
            .limit(Limit::All);
        if data {
            search.load_data(true);
        } else {
            search.load_attributes(true);
        }
        search
    }

    fn results(search: &ItemSearchOptions) -> Result<Vec<SearchResult>, Failure> {
        match search.search() {
            Ok(results) => Ok(results),
            Err(error) if error.code() == ITEM_NOT_FOUND => Ok(Vec::new()),
            Err(error) => Err(map_error(error.code())),
        }
    }

    fn read() -> Result<Option<WrappingKey>, Failure> {
        // The item's attributes first: exactly one, with the accessibility it was created with.
        let attributes = results(&search(false))?;
        match attributes.as_slice() {
            [] => return Ok(None),
            [item] => {
                let attributes = item.simplify_dict().ok_or(Failure::Denied)?;
                if attributes.get("pdmn").map(String::as_str)
                    != Some(ACCESSIBLE_WHEN_UNLOCKED_THIS_DEVICE_ONLY)
                {
                    return Err(Failure::Denied);
                }
            }
            _ => return Err(Failure::Denied),
        }
        let values = results(&search(true))?;
        let [SearchResult::Data(value)] = values.as_slice() else {
            return Err(if values.is_empty() {
                Failure::Unavailable
            } else {
                Failure::Denied
            });
        };
        WrappingKey::decode(value).map(Some)
    }

    fn insert(value: &[u8]) -> Result<(), Failure> {
        let access = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            0,
        )
        .map_err(|error| map_error(error.code()))?;
        let mut options = ItemAddOptions::new(ItemAddValue::Data {
            class: ItemClass::generic_password(),
            data: CFData::from_buffer(value),
        });
        options
            .set_service(SERVICE)
            .set_account_name(ACCOUNT)
            .set_label("Axl envelope-key sealing key")
            .set_location(Location::DataProtectionKeychain);
        #[allow(deprecated)]
        let base = options.to_dictionary();
        let mut query = CFMutableDictionary::from(&base);
        // SAFETY: the keys are Security framework constants and the values live for the call.
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
            // Another helper created it first; the caller reads whichever the Keychain kept.
            Ok(()) => Ok(()),
            Err(error) if error.code() == DUPLICATE_ITEM => Ok(()),
            Err(error) => Err(map_error(error.code())),
        }
    }

    /// Only the console user's own processes, never root, reach the Keychain.
    fn require_interactive_user() -> Result<(), Failure> {
        unsafe extern "C" {
            fn geteuid() -> u32;
        }
        // SAFETY: geteuid takes no arguments, cannot fail, and has no memory-safety preconditions.
        let uid = unsafe { geteuid() };
        let console = fs::metadata("/dev/console").map(|metadata| metadata.uid());
        if uid == 0 || console.ok() != Some(uid) {
            return Err(Failure::Denied);
        }
        Ok(())
    }

    /// A locked Keychain or forbidden interaction is unavailable; a missing entitlement, a refused
    /// access, or a duplicate is denied.
    pub(super) fn map_error(code: i32) -> Failure {
        match code {
            -25293 | -34018 | DUPLICATE_ITEM => Failure::Denied,
            _ => Failure::Unavailable,
        }
    }
}

/// Built on another platform, the helper answers every request as unavailable, so a misplaced
/// binary fails closed instead of pretending to protect anything.
#[cfg(not(target_os = "macos"))]
mod keychain {
    use super::{Failure, seal::WrappingKey};

    pub(super) fn wrapping_key() -> Result<WrappingKey, Failure> {
        Err(Failure::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(id: u8) -> Result<seal::WrappingKey, Failure> {
        let mut value = [id; seal::KEY_ID_BYTES + seal::KEY_BYTES].to_vec();
        value[seal::KEY_ID_BYTES] = 0x55;
        seal::WrappingKey::decode(&value)
    }

    #[test]
    fn frames_answer_hello_and_refuse_malformed_requests() {
        assert_eq!(handle(OP_HELLO, &[], || key(1)).unwrap().unwrap(), PROTOCOL);
        assert!(handle(OP_HELLO, &[1], || key(1)).is_none());
        assert!(handle(OP_IDENTITY, &[1], || key(1)).is_none());
        assert!(handle(OP_PROTECT, &[], || key(1)).is_none());
        assert!(handle(OP_UNPROTECT, &[], || key(1)).is_none());
        assert!(handle(9, &[], || key(1)).is_none());
        let mut out = Vec::new();
        respond(&mut out, STATUS_OK, b"abc").unwrap();
        assert_eq!(out, [0, 0, 0, 0, 3, b'a', b'b', b'c']);
    }

    #[test]
    fn identity_is_the_key_identifier_in_hex() {
        assert_eq!(
            handle(OP_IDENTITY, &[], || key(0xab)).unwrap().unwrap(),
            "ab".repeat(16).into_bytes()
        );
    }

    #[test]
    fn sealed_values_open_only_under_the_same_key_and_unchanged() {
        let sealed = handle(OP_PROTECT, b"envelope key record", || key(1))
            .unwrap()
            .unwrap();
        assert!(
            !sealed
                .windows(19)
                .any(|window| window == b"envelope key record")
        );
        assert_eq!(
            handle(OP_UNPROTECT, &sealed, || key(1)).unwrap().unwrap(),
            b"envelope key record"
        );
        let again = handle(OP_PROTECT, b"envelope key record", || key(1))
            .unwrap()
            .unwrap();
        assert_ne!(sealed, again, "every seal takes a fresh nonce");
        assert_eq!(
            handle(OP_UNPROTECT, &sealed, || key(2)).unwrap(),
            Err(Failure::Denied),
            "a value sealed under another key"
        );
        for index in [0, 1, 20, sealed.len() - 1] {
            let mut tampered = sealed.clone();
            tampered[index] ^= 1;
            assert_eq!(
                handle(OP_UNPROTECT, &tampered, || key(1)).unwrap(),
                Err(Failure::Denied)
            );
        }
        assert_eq!(
            handle(OP_UNPROTECT, &sealed[..20], || key(1)).unwrap(),
            Err(Failure::Denied)
        );
    }

    #[test]
    fn a_malformed_keychain_value_or_an_unavailable_keychain_fails_closed() {
        assert!(matches!(
            seal::WrappingKey::decode(&[0; 47]),
            Err(Failure::Denied)
        ));
        assert_eq!(
            handle(OP_PROTECT, b"x", || Err(Failure::Unavailable)).unwrap(),
            Err(Failure::Unavailable)
        );
    }

    /// Runs on a macOS runner with `AXL_RUN_MACOS_KEYCHAIN_TESTS=1`. This test binary carries no
    /// Keychain entitlement, so the data-protection Keychain must refuse it, and the helper with it.
    #[cfg(target_os = "macos")]
    #[test]
    fn an_unsigned_helper_is_refused_by_the_keychain() {
        if std::env::var_os("AXL_RUN_MACOS_KEYCHAIN_TESTS").is_none() {
            return;
        }
        let result = keychain::wrapping_key().map(|key| key.identity());
        eprintln!(
            "macOS Keychain helper evidence: architecture={}, unsigned result={result:?}",
            std::env::consts::ARCH
        );
        assert_eq!(result, Err(Failure::Denied));
    }
}
