<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Revision 1 pairing fixtures

Native Rust is the sole producer of these canonical TLS fixtures.

- `pairing-invitation.tls` is a valid signed invitation.
- `pairing-claim-v1.tls` is its valid signed claim with a real OpenMLS KeyPackage.
- `pairing-claim-v1-maximum.tls` is the structurally canonical 17,320-byte schema-boundary value. It intentionally uses maximum-width fields and is not a semantically valid profile claim.
- `expected.txt` contains non-secret transcript metadata, SHA-384 digests, and the comparison value.

The installation, device, and crypto-session identifiers use canonical UUIDv7 version and RFC 4122
variant bits. Account IDs remain governed by their separate account-ID contract.

The generator is the opt-in `generate_checked_in_native_fixtures` test in `src/pairing.rs`. Run it explicitly with:

```sh
AXL_REGENERATE_PAIRING_FIXTURES=1 cargo test --locked pairing::tests::generate_checked_in_native_fixtures -- --exact
```

The generator uses the production OpenMLS/libcrux random provider and the production Ed25519 credential implementation. The binary invitation contains a test-only random nonce because the nonce is part of the QR payload. The nonce is not duplicated in the manifest, test names, diagnostics, or assertion messages. No private signing key or KeyPackage private state is checked in.
