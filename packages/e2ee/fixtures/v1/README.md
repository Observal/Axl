<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Revision 1 pairing fixtures

Native Rust is the sole producer of these canonical TLS fixtures.

- `pairing-invitation.tls` is a valid signed invitation.
- `pairing-claim-v1.tls` is its valid signed claim with a real OpenMLS KeyPackage.
- `pairing-claim-v1-maximum.tls` is the structurally canonical 17,320-byte schema-boundary value. It intentionally uses maximum-width fields and is not a semantically valid profile claim.
- `expected.txt` contains non-secret transcript metadata, SHA-384 digests, and the comparison value.
- `witness-register-v1.bin`, `witness-read-v1.bin`, and `witness-advance-v1.bin` are canonical signed rollback-witness requests.
- `witness-receipt-{1,2,3}.bin` are three distinct signed replica receipts, and `witness-quorum-v1.bin` is their canonical unanimous certificate.
- `witness-expected.txt` contains only public verification keys, identifiers, lengths, and SHA-384 digests. It contains no private key.

The installation, device, and crypto-session identifiers use canonical UUIDv7 version and RFC 4122
variant bits. Account IDs remain governed by their separate account-ID contract.

## Witness binary schema decisions

Witness protocol version 1 fixes these choices:

- protocol versions are unsigned `u16` values;
- request-kind and result tags are unsigned `u8` values;
- fixed-width integers use big-endian encoding;
- conditional fields use explicit zero-or-one presence tags followed by their bounded fixed value or
  bounded `u16` vector;
- a quorum contains exactly three `u16`-length-prefixed receipts in ascending replica-ID order;
- result, lineage hash, counter, commitment, predecessor commitment, operation ID, request hash, and
  revocation generation must match across all three receipts; and
- replica ID, pinned witness-key ID, append-ledger sequence, issue time, and signature are
  replica-specific fields and therefore differ by replica.

Each of the exactly three replica identities has a canonical, bounded pinned keyset of one to four
keys ordered by key ID. Key IDs and verification keys may not be duplicated within or across
replica identities. This permits a reviewed overlap interval during one replica's key rotation
without weakening the three-replica requirement.

The generator is the opt-in `generate_checked_in_native_fixtures` test in `src/pairing.rs`. Run it explicitly with:

```sh
AXL_REGENERATE_PAIRING_FIXTURES=1 cargo test --locked pairing::tests::generate_checked_in_native_fixtures -- --exact
AXL_REGENERATE_WITNESS_FIXTURES=1 cargo test --locked witness::tests::generate_checked_in_witness_fixtures -- --exact
```

The generators use the production OpenMLS/libcrux random provider and the production Ed25519 credential implementation. Binary requests contain test-only random nonces because the nonce is part of the signed protocol request. Nonces are not duplicated in manifests, test names, diagnostics, or assertion messages. No private signing key or KeyPackage private state is checked in. Rust validates every fixture, while `bindings/node/test/witness-fixtures.test.ts` independently parses and verifies the witness corpus with Node's standard cryptography APIs.
