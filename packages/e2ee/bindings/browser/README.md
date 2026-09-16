<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/e2ee-browser`

Private browser WebAssembly binding for Axl's `axl-e2ee-mls-pq-v1` profile. It is not published or
connected to the daemon, SDK, relay, or web application.

The ESM loader runs the single-threaded WebAssembly module in a same-origin dedicated module worker.
It requires `crypto.getRandomValues()` and verifies the packaged WASM digest before instantiation.
It does not use shared memory, `SharedArrayBuffer`, inline code, blob URLs, data URLs, or runtime code
from another origin. Closing the binding is idempotent and terminal for that module instance;
subsequent calls fail with `endpoint_closed`. A malformed worker response or worker failure is also
terminal and cannot transparently start a replacement worker.

Production endpoint creation and opening fail with `rollback_anchor_unavailable`. The production
package does not contain IndexedDB persistence, a browser rollback anchor, or persistence
constructors. The separate test artifact implements the reviewed prepare-and-compare feasibility
protocol with real IndexedDB, Web Locks, WebCrypto, and disposable WASM endpoints. It covers
close/reopen, exact-byte retry, operation conflicts, strict transaction faults, worker and document
termination, lock contention, key reconciliation, corruption, schema handling, quota failure, and
state loss. Test-only constructors and the explicitly test-only anchor remain inside the dedicated
worker and never accept keys, DEKs, or counters from page JavaScript. See
[`../../BROWSER_STORAGE.md`](../../BROWSER_STORAGE.md).

The test artifact also executes a fresh in-memory OpenMLS lifecycle covering KeyPackage creation,
Welcome join, pair activation, bidirectional application protection, a device self-Update proposal,
the daemon commit, device commit application, and epoch-ready delivery. Focused negative browser
cases exercise MLS replay, duplicate ciphertext, mutation, AAD and authenticated-identity mismatch,
profile mismatch, and competing commit rejection. Isolated secure-randomness and Rust-bound probes
remain test-only. All test exports are built into `dist/test-artifact` only and are excluded from
`dist/package`, declarations, and npm tarball checks.

Linux browser CI pins Ubuntu 24.04 x64 and installs Firefox 155.0 revision 1543 and WebKit 26.6
revision 2359 through `scripts/install-verified-playwright-linux.mjs`. That script verifies the
reviewed archive SHA-256 before extraction. Browser downloads remain test-only and are never copied
into the package. Branded Chrome uses the GitHub-hosted runner installation. Actual Safari runs in a
separate macOS WebDriver job.

A compatible serving policy is:

```text
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'
```

No broader script or worker source is required.
