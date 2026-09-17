<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Session 60 Windows E2EE integration

Status: local integration implemented; production deployment and enablement remain gated

## Scope

This slice replaces the fake-crypto integration seam with typed adapters that can consume the real
Node endpoint binding. It targets Windows first. macOS, Linux, mobile, ordinary-session remote
approval, and production infrastructure deployment are outside this slice.

The relay remains an opaque byte router. The protocol now defines a bounded binary E2EE envelope
that carries only the operation ID, logical message ID, message class, hosted grant generation, and
MLS ciphertext needed by the receiving endpoint to reconstruct and authenticate AAD. It never
contains plaintext or key material.

## Runtime ownership

The device-side `RemoteDeviceE2ee` adapter in `packages/sdk`:

1. validates the authenticated remote request;
2. invokes the injected native or browser endpoint;
3. frames only the immutable committed ciphertext for relay delivery;
4. recovers inbound daemon ciphertext through the endpoint; and
5. acknowledges receive state only after SDK message acceptance.

The daemon-side `WindowsRemoteE2eeBridge`:

1. serializes inbound and outbound cryptographic operations;
2. decodes and bounds the opaque E2EE envelope;
3. compares its hosted grant generation with current daemon authority;
4. invokes the native endpoint before parsing plaintext;
5. submits the authenticated device request through the existing daemon authority boundary and
   command journal;
6. encrypts daemon acceptance, result, error, and subscription delivery messages; and
7. acknowledges native receive state only after daemon processing succeeds.

The SDK `HostedWitnessClient` sends byte-identical committed witness requests to the existing
control-plane gateway over HTTPS, bounds the response, and gives the certificate back only to the
matching native continuation. The local integration test uses the real three-replica gateway with
three distinct signing keys and stores.

## Windows artifact path

The Node build and integrity loader recognize `win32-x64-msvc` and `win32-arm64-msvc`. Windows test
artifacts use the real nested DPAPI envelope-key store for the current non-built-in test account and
an explicitly test-only rollback anchor. CI executes the full Node binding suite on Windows x64 and
cross-compiles both MSVC architectures.

Production endpoint constructors and `productionStorageReady` remain disabled. The test anchor is
not present in production artifacts. Production enablement requires configured witness trust,
hosted transport, Windows service identity and installer provisioning, signing, native crash and
restore evidence, and independent security review.

## Local topology

The integration coverage composes:

```text
real device OpenMLS endpoint
  -> authenticated E2EE envelope
  -> opaque relay delivery contract
  -> real daemon OpenMLS endpoint
  -> authenticated daemon attachment
  -> daemon authorization and command journal
  -> encrypted daemon result
  -> real device OpenMLS endpoint
```

Witness integration composes the SDK HTTP client, control-plane HTTP handler, one gateway, three
independent in-memory replica stores and journals, three signing keys, and the native continuation.
The relay and witness deployment tests remain separate so local simulation cannot be mistaken for
production failure-domain evidence.

## Remaining production gates

- provision and pin three independently administered production witness replicas;
- provision the dedicated Windows service identity and verify profile loading;
- sign the Node addon and installer;
- complete Windows x64 runtime, ACL, reparse, NTFS/ReFS, antivirus, reboot, restore, upgrade, repair,
  and uninstall evidence;
- complete an independent review of the exact dependency graph, storage, witness, binding, and
  integration code; and
- explicitly change support metadata and constructors in a reviewed enablement change.
