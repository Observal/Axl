// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

//! Windows side of the WSL envelope-key store.
//!
//! An Axl daemon running in WSL keeps its envelope-key records on the Linux file system and asks
//! this process, started through WSL interop as the signed-in Windows user, to wrap and unwrap
//! them with nested machine-scope then user-scope DPAPI. The helper is stateless: it never sees a
//! file, a path, or a record identity, only one bounded value per request, so every lifecycle and
//! crash-ordering decision stays in the store's Rust code on the Linux side.
//!
//! Frames on stdin and stdout, big-endian lengths:
//!
//! ```text
//! request:  op u8 | length u32 | payload
//! response: status u8 | length u32 | payload
//! ```
//!
//! Operations: `0` hello (answers the protocol name), `1` identity (the Windows user SID that
//! DPAPI binds to), `2` protect, `3` unprotect. Statuses: `0` ok, `1` unavailable, `2` access
//! denied, `3` bad request. The helper exits at end of input.

use std::io::{self, Read, Write};

const PROTOCOL: &[u8] = b"axl-dpapi-helper-v1";
const MAX_PAYLOAD: usize = 64 * 1024;

const OP_HELLO: u8 = 0;
const OP_IDENTITY: u8 = 1;
const OP_PROTECT: u8 = 2;
const OP_UNPROTECT: u8 = 3;

const STATUS_OK: u8 = 0;
const STATUS_UNAVAILABLE: u8 = 1;
const STATUS_DENIED: u8 = 2;
const STATUS_BAD_REQUEST: u8 = 3;

#[derive(Debug)]
enum Failure {
    Unavailable,
    #[cfg_attr(not(windows), allow(dead_code))]
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
        let result = handle(header[0], &payload);
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

fn handle(op: u8, payload: &[u8]) -> Option<Result<Vec<u8>, Failure>> {
    match op {
        OP_HELLO if payload.is_empty() => Some(Ok(PROTOCOL.to_vec())),
        OP_IDENTITY if payload.is_empty() => {
            Some(dpapi::current_user_sid().map(String::into_bytes))
        }
        OP_PROTECT if !payload.is_empty() => Some(dpapi::protect_nested(payload)),
        OP_UNPROTECT if !payload.is_empty() => Some(dpapi::unprotect_nested(payload)),
        _ => None,
    }
}

#[cfg(windows)]
mod dpapi {
    use std::ptr;

    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, LocalFree},
        Security::{
            Authorization::ConvertSidToStringSidW,
            Cryptography::{
                CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN,
                CryptProtectData, CryptUnprotectData,
            },
            GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    use super::{Failure, MAX_PAYLOAD};

    /// The same nesting as the native Windows store: machine scope inside user scope, so a blob
    /// opens only for this Windows user on this machine.
    pub(super) fn protect_nested(plaintext: &[u8]) -> Result<Vec<u8>, Failure> {
        let mut machine = protect(
            plaintext,
            CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
        )?;
        let user = protect(&machine, CRYPTPROTECT_UI_FORBIDDEN);
        machine.fill(0);
        user
    }

    pub(super) fn unprotect_nested(protected: &[u8]) -> Result<Vec<u8>, Failure> {
        let mut machine = unprotect(protected)?;
        let plaintext = unprotect(&machine);
        machine.fill(0);
        plaintext
    }

    fn protect(input: &[u8], flags: u32) -> Result<Vec<u8>, Failure> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(input.len()).map_err(|_| Failure::Unavailable)?,
            pbData: input.as_ptr().cast_mut(),
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: blobs describe valid buffers for the duration of the call; UI is forbidden.
        let ok = unsafe {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                flags,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(Failure::Unavailable);
        }
        take(output)
    }

    fn unprotect(input: &[u8]) -> Result<Vec<u8>, Failure> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(input.len()).map_err(|_| Failure::Denied)?,
            pbData: input.as_ptr().cast_mut(),
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: blobs describe valid buffers for the duration of the call; UI is forbidden.
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(Failure::Denied);
        }
        take(output)
    }

    fn take(blob: CRYPT_INTEGER_BLOB) -> Result<Vec<u8>, Failure> {
        if blob.pbData.is_null() {
            return Err(Failure::Unavailable);
        }
        let length = blob.cbData as usize;
        let result = if length == 0 || length > MAX_PAYLOAD {
            Err(Failure::Unavailable)
        } else {
            // SAFETY: DPAPI initialized cbData bytes at pbData.
            Ok(unsafe { std::slice::from_raw_parts(blob.pbData, length) }.to_vec())
        };
        // SAFETY: DPAPI allocated a writable cbData-byte buffer with LocalAlloc.
        unsafe {
            ptr::write_bytes(blob.pbData, 0, length);
            LocalFree(blob.pbData.cast());
        }
        result
    }

    struct Token(HANDLE);

    impl Drop for Token {
        fn drop(&mut self) {
            // SAFETY: the handle came from OpenProcessToken and is closed once.
            unsafe { CloseHandle(self.0) };
        }
    }

    pub(super) fn current_user_sid() -> Result<String, Failure> {
        let mut token = ptr::null_mut();
        // SAFETY: token receives one owned process-token handle.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(Failure::Denied);
        }
        let token = Token(token);
        let mut needed = 0_u32;
        // SAFETY: this sizing call intentionally supplies no output buffer.
        unsafe { GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut needed) };
        if needed == 0 {
            return Err(Failure::Denied);
        }
        let mut buffer = vec![0_u8; needed as usize];
        // SAFETY: buffer has the size requested by GetTokenInformation.
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        } == 0
        {
            return Err(Failure::Denied);
        }
        // SAFETY: buffer holds a TOKEN_USER initialized by GetTokenInformation.
        let user = unsafe { &*(buffer.as_ptr().cast::<TOKEN_USER>()) };
        let mut sid = ptr::null_mut();
        // SAFETY: the SID stays valid while buffer lives; sid receives LocalAlloc data.
        if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut sid) } == 0 || sid.is_null() {
            return Err(Failure::Denied);
        }
        // SAFETY: sid is a NUL-terminated UTF-16 string.
        let length = unsafe {
            let mut length = 0_usize;
            while *sid.add(length) != 0 {
                length += 1;
            }
            length
        };
        // SAFETY: sid has length initialized code units.
        let result = String::from_utf16(unsafe { std::slice::from_raw_parts(sid, length) })
            .map_err(|_| Failure::Denied);
        // SAFETY: sid was allocated by LocalAlloc through ConvertSidToStringSidW.
        unsafe { LocalFree(sid.cast()) };
        result
    }
}

/// Built on another platform, the helper answers every protection request as unavailable, so a
/// misplaced binary fails closed instead of pretending to protect anything.
#[cfg(not(windows))]
mod dpapi {
    use super::Failure;

    pub(super) fn protect_nested(_: &[u8]) -> Result<Vec<u8>, Failure> {
        Err(Failure::Unavailable)
    }

    pub(super) fn unprotect_nested(_: &[u8]) -> Result<Vec<u8>, Failure> {
        Err(Failure::Unavailable)
    }

    pub(super) fn current_user_sid() -> Result<String, Failure> {
        Err(Failure::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_answer_hello_and_refuse_malformed_requests() {
        assert_eq!(handle(OP_HELLO, &[]).unwrap().unwrap(), PROTOCOL);
        assert!(handle(OP_HELLO, &[1]).is_none());
        assert!(handle(OP_IDENTITY, &[1]).is_none());
        assert!(handle(OP_PROTECT, &[]).is_none());
        assert!(handle(OP_UNPROTECT, &[]).is_none());
        assert!(handle(9, &[]).is_none());
        let mut out = Vec::new();
        respond(&mut out, STATUS_OK, b"abc").unwrap();
        assert_eq!(out, [0, 0, 0, 0, 3, b'a', b'b', b'c']);
    }

    #[cfg(windows)]
    #[test]
    fn nested_protection_round_trips_for_this_user() {
        let sealed = dpapi::protect_nested(b"envelope key record").unwrap();
        assert_ne!(sealed.as_slice(), b"envelope key record");
        assert_eq!(
            dpapi::unprotect_nested(&sealed).unwrap(),
            b"envelope key record"
        );
        let mut tampered = sealed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(dpapi::unprotect_nested(&tampered).is_err());
        assert!(dpapi::current_user_sid().unwrap().starts_with("S-1-5-"));
    }
}
