<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/e2ee-node`

Private Node-API binding for revision 1 of `axl-e2ee-mls-pq-v1`.

This package is not published and is not wired into the daemon or SDK. Its native boundary includes
a narrow witness continuation whose immutable getters return only the operation ID, exact committed
request, request hash, and status. The continuation accepts a bounded certificate only for that
operation, verifies the pinned unanimous trust set in Rust, and returns only the exact committed
output after native storage barriers are complete. Recovery construction is test-feature-only.
Production endpoint constructors still fail closed because production replica trust and hosted
witness transport are not enabled. The build and integrity loader support Windows MSVC x64 and
ARM64 artifacts in addition to the existing macOS and glibc Linux targets. The Windows test artifact can
exercise the real DPAPI envelope-key store under an explicitly selected non-built-in account by
setting `AXL_RUN_WINDOWS_DPAPI_TESTS=1`; ordinary hosted CI accounts continue to use test storage
rather than silently weakening the DPAPI identity policy. Test constructors and the test binary are
excluded from production package staging.

Every accepted JavaScript byte input is length-checked and copied before native asynchronous work
is scheduled. Returned byte arrays are new Node-owned values containing the exact committed Rust
bytes. Callers own those returned arrays and may mutate them without changing native state.

`integrity.json` detects accidental packaging corruption. It is not a signature, provenance
attestation, or independent trust anchor. Its source fields identify the Git base commit, state
whether the `packages/e2ee` tree was dirty at build time, and hash the exact tracked and untracked,
non-ignored files in that tree. A dirty artifact therefore does not claim that its base commit
contains the binding source.
