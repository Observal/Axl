// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

//! Handle-based Windows path, ACL, and durability helpers for native E2EE storage.

use std::{ffi::OsStr, fs::File, mem, os::windows::ffi::OsStrExt, path::Path, ptr};

use windows_sys::Win32::{
    Foundation::{CloseHandle, GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE, LocalFree},
    Security::{
        Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
        },
        DACL_SECURITY_INFORMATION, GetFileSecurityW, GetTokenInformation,
        OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        TOKEN_QUERY, TOKEN_USER, TokenUser,
    },
    Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_NAME_NORMALIZED,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FileAttributeTagInfo,
        FlushFileBuffers, GetFileInformationByHandleEx, GetFinalPathNameByHandleW,
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW, OPEN_EXISTING,
        VOLUME_NAME_DOS,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

use super::PersistenceError;

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if self.0 != INVALID_HANDLE_VALUE && !self.0.is_null() {
            // SAFETY: the handle is owned by this value and is closed exactly once.
            unsafe { CloseHandle(self.0) };
        }
    }
}

pub(crate) fn validate_path_handle(path: &Path, directory: bool) -> Result<(), PersistenceError> {
    reject_unsafe_path_form(path)?;
    let wide = wide(path.as_os_str());
    let flags = FILE_FLAG_OPEN_REPARSE_POINT
        | if directory {
            FILE_FLAG_BACKUP_SEMANTICS
        } else {
            FILE_ATTRIBUTE_NORMAL
        };
    // SAFETY: the path is NUL-terminated, output ownership is represented by OwnedHandle, and all
    // pointer arguments are either valid or null as required by CreateFileW.
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ptr::null(),
            OPEN_EXISTING,
            flags,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(PersistenceError::Io);
    }
    let handle = OwnedHandle(handle);
    let mut tag = FILE_ATTRIBUTE_TAG_INFO::default();
    // SAFETY: tag points to writable storage of the exact requested structure size.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle.0,
            FileAttributeTagInfo,
            (&mut tag as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(PersistenceError::Io);
    }
    if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(PersistenceError::IdentityMismatch);
    }
    let required = unsafe {
        GetFinalPathNameByHandleW(
            handle.0,
            ptr::null_mut(),
            0,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if required == 0 {
        return Err(PersistenceError::Io);
    }
    let mut final_path = vec![0_u16; required as usize + 1];
    let written = unsafe {
        GetFinalPathNameByHandleW(
            handle.0,
            final_path.as_mut_ptr(),
            final_path.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if written == 0 || written as usize >= final_path.len() {
        return Err(PersistenceError::Io);
    }
    final_path.truncate(written as usize);
    let final_path = String::from_utf16(&final_path).map_err(|_| PersistenceError::Io)?;
    if final_path.starts_with(r"\\?\UNC\") {
        return Err(PersistenceError::IdentityMismatch);
    }
    let canonical = path.canonicalize().map_err(|_| PersistenceError::Io)?;
    let canonical = canonical.to_string_lossy();
    let expected = if canonical.starts_with(r"\\?\") {
        canonical.into_owned()
    } else {
        format!(r"\\?\{canonical}")
    };
    if final_path != expected {
        return Err(PersistenceError::IdentityMismatch);
    }
    Ok(())
}

pub(crate) fn sync_directory(path: &Path) -> Result<(), PersistenceError> {
    validate_path_handle(path, true)?;
    let wide = wide(path.as_os_str());
    // SAFETY: path is NUL-terminated and the returned handle is owned locally.
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(PersistenceError::Io);
    }
    let handle = OwnedHandle(handle);
    // SAFETY: handle is a valid open directory handle retained for the call.
    if unsafe { FlushFileBuffers(handle.0) } == 0 {
        return Err(PersistenceError::Io);
    }
    Ok(())
}

pub(crate) fn harden_path(path: &Path) -> Result<(), PersistenceError> {
    let sid = current_user_sid_string()?;
    let sddl = format!("O:{sid}D:P(A;;FA;;;{sid})");
    let wide_path = wide(path.as_os_str());
    let wide_sddl = wide(OsStr::new(&sddl));
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: input is NUL-terminated and descriptor receives LocalAlloc-owned memory.
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide_sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    };
    if converted == 0 || descriptor.is_null() {
        return Err(PersistenceError::Io);
    }
    // SAFETY: descriptor is valid for the duration of the call and released below.
    let applied = unsafe {
        windows_sys::Win32::Security::SetFileSecurityW(
            wide_path.as_ptr(),
            OWNER_SECURITY_INFORMATION
                | DACL_SECURITY_INFORMATION
                | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor,
        )
    };
    // SAFETY: descriptor was allocated by LocalAlloc through the conversion API.
    unsafe { LocalFree(descriptor) };
    if applied == 0 {
        return Err(PersistenceError::Io);
    }
    verify_acl(path, &sddl)
}

pub(crate) fn replace_file(source: &Path, destination: &Path) -> Result<(), PersistenceError> {
    reject_unsafe_path_form(source)?;
    reject_unsafe_path_form(destination)?;
    let source = wide(source.as_os_str());
    let destination = wide(destination.as_os_str());
    // SAFETY: both paths are NUL-terminated and remain alive for the call.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(PersistenceError::Io);
    }
    Ok(())
}

pub(crate) fn flush_file(file: &File) -> Result<(), PersistenceError> {
    use std::os::windows::io::AsRawHandle;
    // SAFETY: the borrowed raw handle remains valid for the duration of the call.
    if unsafe { FlushFileBuffers(file.as_raw_handle()) } == 0 {
        return Err(PersistenceError::Io);
    }
    Ok(())
}

fn verify_acl(path: &Path, expected_sddl: &str) -> Result<(), PersistenceError> {
    let wide_path = wide(path.as_os_str());
    let requested = OWNER_SECURITY_INFORMATION
        | DACL_SECURITY_INFORMATION
        | PROTECTED_DACL_SECURITY_INFORMATION;
    let mut needed = 0_u32;
    // SAFETY: this sizing call intentionally supplies no output buffer.
    unsafe {
        GetFileSecurityW(
            wide_path.as_ptr(),
            requested,
            ptr::null_mut(),
            0,
            &mut needed,
        );
    }
    if needed == 0 {
        return Err(PersistenceError::Io);
    }
    let mut descriptor = vec![0_u8; needed as usize];
    // SAFETY: descriptor has the exact size requested by the preceding API call.
    if unsafe {
        GetFileSecurityW(
            wide_path.as_ptr(),
            requested,
            descriptor.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(PersistenceError::Io);
    }
    let mut rendered = ptr::null_mut();
    let mut rendered_len = 0_u32;
    // SAFETY: descriptor is initialized by GetFileSecurityW and rendered receives LocalAlloc data.
    if unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor.as_mut_ptr().cast(),
            SDDL_REVISION_1,
            requested,
            &mut rendered,
            &mut rendered_len,
        )
    } == 0
        || rendered.is_null()
    {
        return Err(PersistenceError::Io);
    }
    // SAFETY: rendered is a valid UTF-16 buffer of rendered_len code units.
    let actual =
        String::from_utf16(unsafe { std::slice::from_raw_parts(rendered, rendered_len as usize) })
            .map_err(|_| PersistenceError::Io)?;
    // SAFETY: rendered was allocated by LocalAlloc through the conversion API.
    unsafe { LocalFree(rendered.cast()) };
    if actual != expected_sddl {
        return Err(PersistenceError::SecureStoreAccessDenied);
    }
    Ok(())
}

pub(crate) fn current_user_sid_string() -> Result<String, PersistenceError> {
    let mut token = ptr::null_mut();
    // SAFETY: token receives one owned process-token handle.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(PersistenceError::SecureStoreAccessDenied);
    }
    let token = OwnedHandle(token);
    let mut needed = 0_u32;
    // SAFETY: this sizing call intentionally supplies no output buffer.
    unsafe { GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut needed) };
    if needed == 0 {
        return Err(PersistenceError::SecureStoreAccessDenied);
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
        return Err(PersistenceError::SecureStoreAccessDenied);
    }
    // SAFETY: buffer contains TOKEN_USER initialized by GetTokenInformation.
    let user = unsafe { &*(buffer.as_ptr().cast::<TOKEN_USER>()) };
    let mut sid = ptr::null_mut();
    // SAFETY: the SID pointer is valid while buffer remains alive and sid receives LocalAlloc data.
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut sid) } == 0 || sid.is_null() {
        return Err(PersistenceError::SecureStoreAccessDenied);
    }
    let len = unsafe {
        let mut len = 0_usize;
        while *sid.add(len) != 0 {
            len += 1;
        }
        len
    };
    // SAFETY: sid points to a NUL-terminated UTF-16 string with len initialized code units.
    let result = String::from_utf16(unsafe { std::slice::from_raw_parts(sid, len) })
        .map_err(|_| PersistenceError::SecureStoreAccessDenied)?;
    // SAFETY: sid was allocated by LocalAlloc through ConvertSidToStringSidW.
    unsafe { LocalFree(sid.cast()) };
    Ok(result)
}

fn reject_unsafe_path_form(path: &Path) -> Result<(), PersistenceError> {
    use std::path::{Component, Prefix};
    for component in path.components() {
        if let Component::Prefix(prefix) = component {
            match prefix.kind() {
                Prefix::Disk(_) | Prefix::VerbatimDisk(_) => {}
                Prefix::UNC(..)
                | Prefix::VerbatimUNC(..)
                | Prefix::DeviceNS(_)
                | Prefix::Verbatim(_) => return Err(PersistenceError::IdentityMismatch),
            }
        }
    }
    Ok(())
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}
