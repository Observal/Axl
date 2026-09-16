// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

use std::{
    cell::Cell,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc, Once,
        atomic::{AtomicBool, Ordering},
    },
};

use napi::{
    Env, Error, Result, Status, Task,
    bindgen_prelude::{ToNapiValue, TypeName},
};

pub(crate) const ERROR_PREFIX: &str = "AXL_E2EE:";

thread_local! {
    static REDACT_PANIC: Cell<bool> = const { Cell::new(false) };
}

static INSTALL_PANIC_HOOK: Once = Once::new();

/// Installs a process panic hook that suppresses details only while this binding is running
/// native endpoint work. Panics from other Rust code continue through the preceding hook.
pub(crate) fn install_panic_redaction() {
    INSTALL_PANIC_HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |information| {
            let redact = REDACT_PANIC.try_with(Cell::get).unwrap_or(false);
            if !redact {
                previous(information);
            }
        }));
    });
}

struct PanicRedactionGuard {
    previous: bool,
}

impl PanicRedactionGuard {
    fn enter() -> Self {
        let previous = REDACT_PANIC.replace(true);
        Self { previous }
    }
}

impl Drop for PanicRedactionGuard {
    fn drop(&mut self) {
        REDACT_PANIC.set(self.previous);
    }
}

pub(crate) fn error(code: &'static str) -> Error {
    Error::new(Status::GenericFailure, format!("{ERROR_PREFIX}{code}"))
}

pub(crate) struct HandleGate {
    busy: AtomicBool,
    closed: AtomicBool,
}

impl HandleGate {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            busy: AtomicBool::new(false),
            closed: AtomicBool::new(false),
        })
    }

    pub(crate) fn acquire(self: &Arc<Self>, allow_closed: bool) -> Result<BusyLease> {
        if !allow_closed && self.closed.load(Ordering::Acquire) {
            return Err(error("endpoint_closed"));
        }
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| error("lifecycle_busy"))?;
        if !allow_closed && self.closed.load(Ordering::Acquire) {
            self.busy.store(false, Ordering::Release);
            return Err(error("endpoint_closed"));
        }
        Ok(BusyLease {
            gate: Arc::clone(self),
        })
    }

    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::Release);
    }
    pub(crate) fn reopen(&self) {
        self.closed.store(false, Ordering::Release);
    }
}

impl Drop for HandleGate {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
        self.busy.store(false, Ordering::Release);
    }
}

pub(crate) struct BusyLease {
    gate: Arc<HandleGate>,
}
impl Drop for BusyLease {
    fn drop(&mut self) {
        self.gate.busy.store(false, Ordering::Release);
    }
}

#[doc(hidden)]
pub struct Work<T: Send + 'static + ToNapiValue + TypeName> {
    work: Option<Box<dyn FnOnce() -> Result<T> + Send>>,
    _lease: BusyLease,
}

impl<T: Send + 'static + ToNapiValue + TypeName> Work<T> {
    pub(crate) fn new(lease: BusyLease, work: impl FnOnce() -> Result<T> + Send + 'static) -> Self {
        Self {
            work: Some(Box::new(work)),
            _lease: lease,
        }
    }
}

impl<T: Send + 'static + ToNapiValue + TypeName> Task for Work<T> {
    type Output = T;
    type JsValue = T;

    fn compute(&mut self) -> Result<Self::Output> {
        let work = self.work.take().ok_or_else(|| error("internal_error"))?;
        let _redaction = PanicRedactionGuard::enter();
        catch_unwind(AssertUnwindSafe(work)).map_err(|_| error("internal_error"))?
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }

    fn reject(&mut self, _env: Env, err: Error) -> Result<Self::JsValue> {
        Err(err)
    }
}

pub(crate) fn copy_bounded(bytes: &[u8], maximum: usize, label: &'static str) -> Result<Vec<u8>> {
    if bytes.len() > maximum {
        return Err(error(label));
    }
    Ok(bytes.to_vec())
}

pub(crate) fn id(bytes: &[u8]) -> Result<[u8; 16]> {
    if bytes.len() != 16 {
        return Err(error("invalid_id"));
    }
    bytes.try_into().map_err(|_| error("invalid_id"))
}

pub(crate) fn u64_from_bigint(value: &napi::bindgen_prelude::BigInt) -> Result<u64> {
    let (negative, value, lossless) = value.get_u64();
    if negative || !lossless {
        Err(error("invalid_u64"))
    } else {
        Ok(value)
    }
}

pub(crate) fn bigint(value: u64) -> napi::bindgen_prelude::BigInt {
    napi::bindgen_prelude::BigInt {
        sign_bit: false,
        words: vec![value],
    }
}
