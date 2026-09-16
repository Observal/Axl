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

Production endpoint creation and opening fail with `rollback_anchor_unavailable`. The package does
not contain IndexedDB, Web Locks, persistent storage, or a rollback-anchor implementation. The
test artifact executes a fresh in-memory OpenMLS lifecycle covering KeyPackage creation, Welcome
join, pair activation, bidirectional application protection, a device self-Update proposal, the
daemon commit, device commit application, and epoch-ready delivery. Focused negative browser cases
exercise MLS replay, duplicate ciphertext, mutation, AAD and authenticated-identity mismatch,
profile mismatch, and competing commit rejection. The artifact also exposes isolated
secure-randomness and Rust-bound probes. These test-only exports are built into
`dist/test-artifact` only and are excluded from `dist/package` and npm tarball checks.

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
