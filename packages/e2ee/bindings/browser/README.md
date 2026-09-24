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

Production endpoint creation and opening fail with `rollback_anchor_unavailable` because
build-pinned production replica trust does not exist yet. Behind that gate, the production worker
contains a worker-private device endpoint over the atomic witness barrier: the Rust `BrowserEndpoint`
owns the witness state machine, the authenticated committed image, duplicate lookup, the exact-result
index, certificate verification against Rust-owned `BrowserReplicaTrust`, and the output gate;
`worker/storage.js` owns one lifetime Web Lock, one version 2 IndexedDB database, a non-extractable
AES-KW wrapping key, wrapped AES-GCM state keys, and the canonical committed-transition record shared
with the native endpoint; `worker/endpoint.js` sequences the two. WebCrypto seals and unseals; private
WASM finalization owns the header, nonces, AADs, key ID, commitment over the exact sealed bytes,
signed witness request, and record. Every supported mutation (KeyPackage creation, Welcome join,
activation send, application send and receive, self-Update proposal send, received commit apply,
epoch-ready send as a separate operation, epoch-ready confirmation receive, and received removal)
runs exactly one OpenMLS transition and returns either the exact pending witness request or the exact
released typed result. The successor key commits as `prepared` and activates only after the commit
completes; continuation verifies the certificate in WASM, rechecks the successor key, erases and
observes the obsolete key absent, and only then releases the exact result from Rust. Abort, lock
loss, worker loss, or ambiguous completion destroys the transient endpoint (`recovery_required`) and
recovery reopens from committed data. Version 1 and unknown newer databases fail closed with
`unsupported_schema`. No WASM class has a JavaScript constructor, and the page protocol never
receives the endpoint, the store, a key, a transition, or a plaintext buffer. The native-only pairing
lifecycle (claims, reservations, acknowledgements, outbox, reset) has no browser implementation yet;
see the coverage table in
[`../../../../docs/architecture/atomic-witness-integration.md`](../../../../docs/architecture/atomic-witness-integration.md).

The separate test artifact drives the byte-identical driver and store from inside the dedicated
test worker with an in-WASM peer daemon and an in-WASM deterministic three-replica witness. Its
evidence covers every supported mutation, duplicates, restart with pending and completed operations,
an aborted commit, a durable commit whose key activation failed, witness unavailability, Web Lock
loss, real worker termination between commit and completion, unpersisted quarantine writes,
corrupted stored requests, forged certificates, and schema handling. The test artifact additionally
retains the earlier prepare-and-compare feasibility adapter with real IndexedDB, Web Locks,
WebCrypto, and disposable WASM endpoints, covering close/reopen, exact-byte retry, operation
conflicts, strict transaction faults, worker and document termination, lock contention, key
reconciliation, corruption, schema handling, quota failure, and state loss. Test-only constructors
and the explicitly test-only anchor remain inside the dedicated worker and never accept keys, DEKs,
or counters from page JavaScript. See [`../../BROWSER_STORAGE.md`](../../BROWSER_STORAGE.md).

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
