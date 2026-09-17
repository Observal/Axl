<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Axl control plane

This separately deployable TypeScript service owns hosted control-plane mutations. It implements
relay-ticket issuance and consumption plus the rollback-witness gateway and replica state machine.

`POST /v1/e2ee/witness` accepts at most 1 KiB with content type
`application/vnd.axl.rollback-witness-v1`. The authenticated body is the exact canonical Rust-owned
witness request. A successful response is the canonical certificate containing exactly three
ordered signed replica receipts. JSON error responses use the stable witness service codes exported
by `@axl/protocol`.

The witness gateway is stateless and has no signing key. Each replica independently checks hosted
admission and endpoint proof, applies append-only compare-and-swap state, journals its high-water
mark, and signs only a typed canonical receipt. A constructed or restarted replica cannot vote until
it validates local history and receives fresh matching signed heads from both other pinned replicas.
A new empty store instead requires explicit registration-only bootstrap. Tests use deterministic
in-memory storage and journals behind the public interfaces.

No production identity provider, datastore, replica signing-key service, immutable journal provider,
cloud account, failure domain, backup identity, recovery authority, or deployment is selected. No
production witness assembly is available. The service never receives private E2EE state, plaintext,
DEKs, wrapping keys, invitation nonces, or decrypted Welcomes.
