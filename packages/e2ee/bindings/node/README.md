<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/e2ee-node`

Private Node-API binding for revision 1 of `axl-e2ee-mls-pq-v1`.

This package is not published and is not wired into the daemon or SDK. Its endpoint constructors
are not wired to the target-gated macOS secure store or to a rollback witness, so production
creation and opening fail closed. The macOS store is not exported through JavaScript. A separate
local test artifact enables in-memory test stores. Test constructors and the test binary are excluded
from production package staging.

Every accepted JavaScript byte input is length-checked and copied before native asynchronous work
is scheduled. Returned byte arrays are new Node-owned values containing the exact committed Rust
bytes. Callers own those returned arrays and may mutate them without changing native state.

`integrity.json` detects accidental packaging corruption. It is not a signature, provenance
attestation, or independent trust anchor. Its source fields identify the Git base commit, state
whether the `packages/e2ee` tree was dirty at build time, and hash the exact tracked and untracked,
non-ignored files in that tree. A dirty artifact therefore does not claim that its base commit
contains the binding source.
