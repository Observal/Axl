<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Production E2EE storage and rollback

Status: proposed architecture and dependency decision; no production implementation is approved

Drafted: 2026-09-18

Baseline: `03397d00c01896326ff13b18be432dd72b7a380d`, the verified `origin/RC` tip after Session 50.5

## Decision summary

This RFC defines the production storage gate that must pass before the authoritative Axl daemon can consume real OpenMLS endpoints.

The decisions are:

1. Keep the existing encrypted redb state model and fresh-DEK-per-successor design.
2. Implement a platform-owned `EnvelopeKeyStore` in Rust. JavaScript never provides keys, key callbacks, DEKs, wrapping keys, or secure-store decisions.
3. Use the macOS data-protection Keychain for an interactive per-user daemon.
4. Use Secret Service only for a Linux daemon running in the same unlocked desktop login session as the user. Explicitly accept its legacy encrypted session only against passive observation on a locally authenticated user D-Bus connection. Support is limited to separately runtime-tested service implementations.
5. Keep headless Linux unsupported in the first production slice. A TPM 2.0 sealed-key implementation is the preferred later direction, but it needs a separate dependency, attestation, PCR-policy, recovery, and hardware test decision.
6. Use nested user-scope and machine-scope Windows DPAPI as the selected Windows key-store design. Windows remains unsupported until the native store, filesystem lifecycle, Node artifact, installer, crash, reboot, restore, and arm64 matrices pass.
7. Use one hosted monotonic witness protocol backed by a unanimous 3-of-3 independently operated witness quorum on every production endpoint. It is the portable rollback anchor. Local secure stores, redb, IndexedDB, TPM sealing, and filesystem durability do not replace it.
8. Reuse the endpoint's existing Ed25519 MLS credential key for witness requests with strict domain separation and no general-purpose signing API. This adds no key or field to the pairing transcript.
9. Require an online witness barrier after every local state-advancing commit and before releasing ciphertext or plaintext. Offline E2EE mutation and decryption are unsupported.
10. Select an origin-bound, non-extractable WebCrypto AES-KW key stored in IndexedDB as the browser `EnvelopeKeyStore` under the explicit browser threat model. It is not device-bound or hardware-backed. Browser pairing remains disabled only until the production adapter, witness path, artifact isolation, and runtime matrix pass.
11. Keep all target triples fail-closed until runtime, restart, crash, rollback, packaging, and installer evidence exists. Compilation does not establish support.

This RFC does not approve a dependency insertion. It does not change a manifest or lockfile. The dependency candidates in this document require a later focused approval against the exact resulting repository lock.

## Scope and non-goals

This document specifies:

- the endpoint threat model;
- platform key-store choices and unsupported environments;
- the hosted witness trust and protocol model;
- exact mutation and recovery ordering;
- browser and Windows release gates;
- dependency candidates;
- package ownership;
- runtime and packaging evidence required for a support claim; and
- a sequence of focused implementation changes.

This document does not implement:

- a secure store;
- a witness service;
- daemon, SDK, relay, or ordinary-session wiring;
- remote approval;
- attachments;
- UI or mobile applications;
- production deployment; or
- a production browser endpoint.

Draft PR #394 is not part of this work and must not be modified or merged by this branch.

## Existing invariants and terminology

The existing native adapter owns one redb database per `crypto_session_id`. Every state-advancing operation commits the complete encrypted OpenMLS provider image, its exact result, the operation fingerprint, replay state, and the outbox or accepted-message record in one immediate-durability, two-phase redb transaction. It then activates the prepared key, advances the injected rollback anchor, erases the obsolete key, and only then returns ciphertext or plaintext.

This RFC preserves that shape and replaces the test-only external dependencies with production contracts.

Terms used below:

- **Local state**: the redb or IndexedDB records, encrypted OpenMLS image, operation records, exact results, and authenticated manifest for one `crypto_session_id`.
- **Envelope key store**: the platform facility that stores one prepared or active record for each state DEK. It is outside the redb snapshot domain.
- **Witness**: the hosted, authenticated, monotonic compare-and-swap protocol backed by three independently operated replicas and a required unanimous 3-of-3 quorum certificate. It is the production `RollbackAnchor`.
- **Lineage**: the immutable tuple `(account_id, installation_id, device_id, crypto_session_id, profile_id, profile_revision, endpoint_role)`. The daemon role uses the all-zero device identifier as already specified by the E2EE profile.
- **Counter**: the strictly increasing rollback counter for one lineage.
- **Commitment**: a SHA-384 digest that binds one exact committed local state without revealing that state.
- **Barrier**: successful local durable commit, current-key activation, witness compare-and-swap, verification of a unanimous 3-of-3 quorum certificate, and obsolete-key erasure.
- **Output**: MLS ciphertext, plaintext, Welcome bytes, KeyPackage bytes, pairing claims or invitations, activation messages, commits, epoch-ready messages, or another value whose release would make a state transition externally observable. A bounded witness request is not application output.

## Threat model

### Protected assets

The design protects:

- OpenMLS group and signer state;
- pending pairing state and invitation nonces;
- KeyPackage private material;
- state DEKs and platform wrapping authority;
- exact ciphertext retry records;
- sealed receive plaintext awaiting acknowledgement;
- replay and operation-id state;
- epoch authenticators and rollback counters; and
- the binding between all of those values and one endpoint lineage.

### Adversaries in scope

The production storage design considers an attacker who can:

- copy, restore, roll back, reorder, or replace local database files;
- copy or restore the complete application data directory;
- restore an old filesystem, VM, browser profile, system backup, or machine image and then run the unmodified endpoint;
- crash or kill the daemon at any storage or network boundary;
- interrupt power or reboot the host after any durable step;
- replay witness requests or responses;
- race two cloned endpoints that hold the same endpoint credential;
- control the relay or ordinary control-plane application storage;
- observe witness metadata and network timing;
- corrupt an untrusted local file;
- attempt access from another process under the same ordinary user, with protection claimed only where the selected platform store enforces a verified per-application boundary; and
- cause the secure store or witness to be absent, locked, unavailable, revoked, or partially failed.

The witness quorum is trusted for monotonicity while at least one of its three replicas preserves its monotonic history and signing authority. One or two unavailable, restored, or malicious replicas cannot create a conflicting unanimous certificate, but any unavailable replica stops progress. Only coordinated rollback or compromise of all three replicas can defeat hosted rollback detection. This unanimity assumption is explicit and must be reflected in deployment, credentials, monitoring, backup, and disaster-recovery evidence.

### Adversaries and failures outside the claim

The design does not protect plaintext from:

- malware or an administrator controlling the endpoint while it is unlocked;
- a compromised browser origin that can invoke a non-extractable key;
- for the browser profile, forensic extraction of user-agent-private key material outside the WebCrypto API or compromise of the operating-system account that owns the profile;
- on Linux Secret Service and Windows DPAPI profiles, another malicious process already running as the same OS user and able to access that user's store or protected blob;
- a malicious or compromised operating-system secure-store implementation;
- memory inspection of a live privileged process;
- firmware or hardware compromise below the selected platform service;
- forensic recovery from media, swap, crash dumps, snapshots, or backups unless a platform-specific test establishes deletion; or
- a malicious witness with current signing authority and control of every authoritative witness copy.

The control plane and relay remain outside the confidentiality boundary. They may deny service. They must never receive OpenMLS private state, plaintext, a DEK, a wrapping key, an invitation nonce, or a decrypted Welcome.

### Security goals

A supported production endpoint must:

1. keep every native DEK in Rust memory only for the bounded operation that uses it; in browsers, keep DEK `CryptoKey` handles and transient snapshot bytes only inside the dedicated worker for the bounded operation;
2. store DEKs only through the selected native platform `EnvelopeKeyStore` or the selected worker-owned browser WebCrypto wrapping design;
3. authenticate all local durable records before using them;
4. detect a stale, forked, or conflicting local state before releasing output;
5. commit receive replay state before releasing plaintext;
6. commit send state and exact ciphertext before transmission;
7. pass the hosted witness quorum barrier before releasing either;
8. erase the obsolete key record only after the successor local state and a matching witness quorum head are durable;
9. fail closed when the key store, witness, required durability, or lifecycle ownership is unavailable; and
10. never create an empty replacement store in response to corruption or state loss.

## Production support matrix

No target is production-supported at the date of this RFC. The table records the selected design and the evidence still required. A later release may mark one row supported without waiting for another row, but every unproven row must continue returning a stable failure.

| Target family | Selected envelope-key design | Rollback anchor | Current decision |
| --- | --- | --- | --- |
| macOS arm64 | Data-protection Keychain item with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, no synchronization | Hosted witness quorum | Selected for implementation. Unsupported until arm64 runtime, restart, crash, lock, backup, package, and installer evidence passes. |
| macOS x64 | Same Keychain design. Secure Enclave is not required and no hardware-backing claim is made. | Hosted witness quorum | Selected for implementation. Requires native Intel evidence. Rosetta evidence does not substitute for x64 hardware. |
| Linux glibc arm64, desktop login session | Secret Service 0.2 item in an unlocked user collection, restricted to tested service implementations | Hosted witness quorum | Selected with an explicit non-claim against malicious same-user processes. A missing session bus, prompt requirement, unknown service, or locked collection fails closed. |
| Linux glibc x64, desktop login session | Same Secret Service design | Hosted witness quorum | Selected with the same non-claim and gates. |
| Linux glibc arm64 or x64, headless | No v1 store | Hosted witness quorum would still be required | Unsupported. TPM 2.0 sealing is the preferred later candidate, not an approved fallback. |
| Windows MSVC arm64 | Nested machine-scope and user-scope DPAPI record under a dedicated user identity | Hosted witness quorum | Design selected, implementation unsupported until the complete Windows matrix passes. |
| Windows MSVC x64 | Same nested DPAPI design | Hosted witness quorum | Design selected, implementation unsupported until the complete Windows matrix passes. |
| Browser | Origin-bound non-extractable AES-KW `CryptoKey` stored in IndexedDB | Hosted witness quorum | Selected under the browser threat model. Pairing remains disabled until production promotion and the complete browser matrix pass. |

Artifact names are not support claims. A build that imports successfully but lacks the required store or evidence returns `unsupported_platform`, `secure_store_unavailable`, or `rollback_anchor_unavailable` as appropriate.

## Envelope-key store contract

### Common record model

Every implementation stores a versioned record containing:

- `crypto_session_id`;
- 16-byte `key_id`;
- SHA-384 of the authenticated context;
- lifecycle `prepared` or `active`;
- the 32-byte DEK as the secure value, or an operating-system-protected blob containing that value; and
- a format version and platform binding.

Public labels and lookup attributes may contain only the version, session ID, key ID, and lifecycle. They must not contain a DEK, wrapping key, plaintext, invitation nonce, or sensitive OpenMLS state.

The implementation must preserve the current trait behavior:

- `prepare` creates one inactive record and rejects conflicting reuse;
- `load` accepts an active record only and verifies session, key ID, and context;
- `activate` is idempotent for the same bound record;
- `reconcile_prepared` activates only the key referenced by authenticated committed state and removes every other inactive record for that session;
- `erase` is idempotent and verifies the session binding before deletion; and
- `destroy_session` is available only to the proven interrupted-initialization cleanup path.

Preparation, activation, deletion, and enumeration must each be crash-tested. A prepared record may survive a crash, but it is never loadable until authenticated committed state references it. An active obsolete record may survive until witness reconciliation, but it is never selected as current. Deletion failure blocks output and is retried after restart. Revocation at the witness does not silently delete local records; explicit local reset or uninstall cleanup performs deletion only after terminal state is durable.

No implementation may use an environment variable, command-line value, plaintext file, in-memory-only persistence fallback, JavaScript callback, or lower-grade substitute when its selected secure store is unavailable.

### macOS selection

The selected store is the macOS data-protection Keychain accessed through Security.framework.

Each DEK is a generic-password item with:

- `kSecUseDataProtectionKeychain = true`;
- `kSecAttrAccessible = kSecAttrAccessibleWhenUnlockedThisDeviceOnly`;
- `kSecAttrSynchronizable = false`;
- an Axl-specific service name;
- account and label attributes containing only the record version, session ID, key ID, and lifecycle;
  and
- keychain authentication UI disabled for daemon operations.

The SHA-384 authenticated-context hash is stored only inside the protected record value. It is not a
public Keychain attribute. The complete value is stored by Keychain Services. Axl does not place a
second wrapped copy in its data directory.

#### Identity and lifecycle behavior

- **Binding**: user-bound and device-only under the macOS data-protection keychain. It is not a machine-wide service secret.
- **Daemon mode**: supported only for a per-user daemon launched in that user's login session. A root launch daemon, a daemon running before login, and an arbitrary service account are unsupported in the first slice.
- **Lock and login**: before login or while the item is inaccessible because the device or keychain is locked, operations return `secure_store_locked`. The daemon never opens a UI prompt and never caches a DEK to work around a lock.
- **Backup and migration**: `ThisDeviceOnly` items do not migrate to another device. A restored database without its current item is `state_loss` and requires re-pairing. A same-device restore is accepted only when the state equals the witness quorum head.
- **Roaming and cloning**: iCloud synchronization is disabled. Copying the data directory does not copy the item. A complete machine clone is not claimed safe without runtime evidence; the hosted witness quorum still prevents two branches from advancing.
- **Deletion**: call `SecItemDelete`, then query the exact item and require not-found before releasing output. No forensic deletion claim is made.
- **Hardware backing**: a generic-password Keychain item does not prove Secure Enclave backing. The implementation reports `hardware_backing = false`. Secure Enclave keys are rejected as the baseline because arbitrary DEKs are not stored directly in the enclave and Intel Macs cannot meet a Secure Enclave requirement.

Unavailable data-protection Keychain support, denied entitlements, a locked item, duplicate ambiguous records, or any unexpected access-control downgrade fails closed.

### Windows selection

The selected Windows design stores a versioned record protected by two DPAPI layers:

1. protect the record with `CryptProtectData(..., CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN)`; then
2. protect that result with user-scope `CryptProtectData(..., CRYPTPROTECT_UI_FORBIDDEN)`.

Unprotect runs in the reverse order. The authenticated plaintext record binds the session, key ID, context hash, lifecycle, and DEK. The DPAPI blob is written only to the dedicated Axl key-record directory with an explicit ACL for the daemon identity. Both DPAPI layers and the ACL are required. Machine scope alone is forbidden because Microsoft documents that any user on that computer can decrypt such data. User scope alone is not selected because roaming profiles can make a DPAPI blob decryptable on another computer.

#### Identity and lifecycle behavior

- **Binding**: both the protecting user profile and the Windows installation are required. A full cloned Windows installation may clone machine DPAPI material, so cloning resistance is not claimed. The witness prevents both copies from advancing the same lineage.
- **Interactive daemon**: runs under the signed-in user and uses that user's DPAPI master key.
- **Service daemon**: requires a dedicated, non-roaming service account with a loaded profile and a directory ACL assigned by SID. `LocalSystem`, `LocalService`, `NetworkService`, shared accounts, and profiles whose load behavior was not tested are unsupported.
- **Lock and login**: DPAPI is not treated as screen-lock-gated after logon. Locking the workstation does not revoke the daemon's user token. The UI-forbidden flag prevents a prompt. Missing profile keys or an access failure returns `secure_store_unavailable` or `secure_store_access_denied`.
- **Password reset and domain recovery**: an administrative password reset can make DPAPI material unavailable. A domain DPAPI backup key may allow domain administrators to recover user-scope material. This is an explicit enterprise trust consequence, not an Axl backup mechanism.
- **Roaming**: the user layer may roam, but the nested machine layer must fail on a different installation. No silent rewrap occurs.
- **Backup, restore, and clone**: a restored current blob can open only with both DPAPI authorities and a matching witness quorum head. An older restore is rejected. Migration uses re-pairing, never blob copying.
- **Deletion**: delete and durably replace the key-record directory entry, then reopen by handle and verify absence before release. No forensic deletion claim is made for NTFS, ReFS, VSS, hibernation, page files, or physical media.
- **Hardware backing**: ordinary DPAPI does not prove TPM backing. The implementation reports `hardware_backing = false`.

CNG with the Microsoft Platform Crypto Provider is a possible stronger mode. It is not selected for v1 because availability differs by machine, arbitrary DEK wrapping needs a reviewed construction, and a provider name does not by itself prove a physical TPM. A hardware claim would require key attestation rooted in an accepted endorsement-key certificate and must distinguish firmware TPMs and vTPMs according to policy.

### Linux desktop selection

The selected desktop design stores each record as a Secret Service item on the user's session bus. It uses an application-specific collection when the tested service can create and unlock it without an Axl-owned password. Otherwise it uses a separately approved default collection policy. The item secret contains the complete versioned record. Lookup attributes contain only non-secret identifiers.

The Rust client must request `dh-ietf1024-sha256-aes128-cbc-pkcs7`, the only encrypted session mode defined by Secret Service 0.2 and exposed by the selected client. It must not fall back to the specification's `plain` session mode. This RFC explicitly accepts that legacy mode only to reduce passive disclosure through the local D-Bus broker, operating-system caches, and diagnostics. The specification says this transfer mode is not designed to resist an active man-in-the-middle attack. Axl therefore relies on the authenticated per-user D-Bus connection, service ownership, session-bus policy, and the selected secret service as the trust boundary. A process that controls the user's bus or secret-service process is equivalent to a compromised secure store and is outside the claim. This is not approval of 1024-bit DH for network use or any other protocol.

The adapter never supplies, receives, or automates a GUI password prompt. Failure to negotiate exactly the encrypted mode, a changed service owner, an unexpected bus type, or a prompt fails closed.

#### Identity and lifecycle behavior

- **Binding**: user-login-session bound. Secret Service 0.2 does not mandate application access control or hardware backing. Axl therefore makes no Linux confidentiality claim against another process already running as the same user and able to call that user's Secret Service. Named implementation and version testing verifies behavior and reliability, not per-application isolation. If a future implementation exposes a verifiable signed-application ACL, Axl may make a narrower claim for that implementation after separate review.
- **Daemon mode**: the daemon must run as the same user with the same D-Bus session and unlocked collection. A system daemon, SSH-only login without the tested user service, container without the user bus, and another service account are unsupported.
- **Lock and login**: a missing bus or service returns `secure_store_unavailable`. A locked collection or an operation that returns a prompt returns `secure_store_locked`. Axl does not display the prompt through the daemon and does not continue from cached keys.
- **Backup, migration, and cloning**: the Secret Service implementation controls keyring backup behavior. Axl does not treat it as portable. Restored or cloned state must match the hosted witness quorum and the current key record. Migration uses re-pairing.
- **Deletion**: invoke item deletion, reject a returned prompt, search by the complete binding, and require no match. No forensic deletion claim is made.
- **Hardware backing**: Secret Service exposes no portable proof. Report `hardware_backing = false`.

The freedesktop specification explicitly allows services to choose their own locking and access-control behavior. Protocol conformance alone is not enough. The installer records the tested service implementation and version. Unknown implementations fail closed until approved.

### Linux headless evaluation

Headless Linux is unsupported in the first production slice.

The preferred later candidate is TPM 2.0 sealing through the system TSS2 ESAPI. A sealed object would bind a wrapping key to one TPM and an explicit boot policy. A dedicated service account and restrictive file permissions would protect the public/private TPM object blobs. The hosted witness would remain mandatory because TPM sealing does not provide a portable per-operation monotonic anchor.

This candidate is deferred because it still needs decisions for:

- physical TPM, firmware TPM, cloud vTPM, and software simulator acceptance;
- endorsement-key certificate validation and attestation policy;
- PCR selection, signed PCR policy, kernel and firmware update recovery;
- TPM clearing, motherboard replacement, VM migration, and disaster recovery;
- ownership, lockout, resource-manager, and concurrent-client behavior;
- `tpm2-tss` system library packaging on glibc arm64 and x64;
- service-account access to `/dev/tpmrm0`;
- sealed-object crash ordering and deletion; and
- runtime evidence on every accepted hardware and cloud class.

A successful `TPM2_GetCapability` call does not establish hardware backing. A hardware claim requires validated attestation evidence. A vTPM can be supported as a separately named trust class, but it must never be reported as a discrete hardware TPM.

Rejected headless substitutes are:

- an environment variable or command-line secret;
- a plaintext or statically encrypted file;
- the Linux kernel keyring, because it is not durable across reboot;
- `systemd-creds` as a subprocess, because dynamic per-operation key records and exact crash reconciliation would cross a command boundary and depend on external mutable files;
- a password prompt, because unattended restart cannot satisfy it; and
- a silent in-memory key, because restart would destroy the security state.

## Rejected envelope-key options

| Option | Decision | Reason |
| --- | --- | --- |
| One long-lived database key | Rejected | Old redb pages and snapshots remain decryptable and violate the existing per-state erasure design. |
| Environment variable, CLI argument, JavaScript callback, plaintext file | Rejected | Secret exposure, logging, inheritance, and downgrade risks violate the required boundary. |
| macOS login-keychain item without data-protection attributes | Rejected | Backup, migration, synchronization, and lock behavior are too broad for the selected policy. |
| macOS Secure Enclave as a universal requirement | Rejected | No Intel-Mac coverage and no direct arbitrary-secret storage. It may be defense in depth on separately tested hardware. |
| Windows DPAPI machine scope alone | Rejected | Any user on the machine can decrypt the blob. |
| Windows DPAPI user scope alone | Rejected | Roaming-profile behavior conflicts with the selected machine binding. |
| Windows DPAPI-NG | Deferred | It is aimed at sharing to AD groups or web credentials and widens recovery and enterprise-principal semantics. |
| Linux Secret Service on any implementation | Rejected | The specification does not mandate access control, lock policy, or hardware protection. Support must name tested implementations. |
| TPM sealing as a portable Linux default | Rejected for v1 | TPM presence, provenance, policy, update behavior, and system libraries vary. |

## Independent rollback anchor

### Selected design

Every production endpoint uses a hosted unanimous 3-of-3 witness quorum. There is no offline production mode.

The three replicas have distinct signing keys, storage, deployment credentials, administrative recovery credentials, backup policies, and failure domains. No database restore, infrastructure role, or operator credential may control two replicas. A gateway may fan out requests, but it has no signing key and no state authority. The endpoint accepts a head or advance only when all three replicas sign the same lineage, counter, commitment, operation, request hash, and revocation generation.

The witness replicas store no E2EE secret. They receive only lineage identifiers, counters, state commitments, operation IDs, request nonces, endpoint public keys, signatures, receipt-chain hashes, revocation state, and operational timestamps.

### Rejected anchor options

| Candidate | Decision | Reason |
| --- | --- | --- |
| Keychain, DPAPI, Secret Service, encrypted key files | Rejected | They protect secrets but do not provide a portable monotonic compare-and-swap counter. Their state can be restored with local state. |
| redb or IndexedDB counter | Rejected | It is in the rollback domain it is meant to detect. IndexedDB key generators are not a trusted monotonic service. |
| TPM NV counter | Not selected | It is not available on all target machines, has authorization and endurance constraints, and vTPM snapshot semantics vary. It may be local defense in depth after separate review. |
| TPM-sealed counter in a file | Rejected as an anchor | Sealing provides confidentiality and machine binding, not monotonicity of the sealed blob. |
| Filesystem timestamps, fsync, APFS, NTFS, ext4, snapshots | Rejected | Durability is not rollback detection. |
| Authenticated daemon/device peer witness | Deferred | It can detect some forks when the peer is reachable, but both peers can be restored or unavailable. It also changes the profile and recovery protocol. |
| Hosted unanimous 3-of-3 witness quorum | Selected | It gives one portable online CAS contract to native and browser endpoints and stays outside the local snapshot domain. One unavailable or inconsistent replica stops progress rather than weakening rollback detection. |

TPM NV counters are not a hidden fallback. They have limited and implementation-specific NV resources, ownership and authorization requirements, wear considerations, TPM-clear recovery, and different physical TPM and vTPM snapshot behavior. macOS and many Linux environments expose no application-owned TPM NV facility, and a Windows-only counter would not provide the required portable contract. A later target may use an NV counter as defense in depth, but the hosted witness remains authoritative.

A daemon/device peer witness would make each peer retain and sign the other's latest commitment. It detects a stale peer when the other endpoint is reachable, but it cannot distinguish simultaneous restoration of both peers, provides no answer when the peer is lost, and can make one offline device a liveness dependency. It also adds new MLS control messages and recovery semantics. It is therefore deferred rather than combined silently with witness v1.

### Trust and attacker model

The quorum is trusted to maintain one non-decreasing head per lineage while at least one of the three replicas preserves its high-water history and signing behavior. It may learn that a device exists, its account and installation association, mutation frequency, approximate availability, and IP metadata. It cannot decrypt or classify the committed state.

One or two unavailable, restored, or malicious replicas cannot create a fresh conflicting quorum certificate, but either condition stops availability. If all three replicas are restored to the same older point, compromised, or operated through a common failure domain, they can produce an older unanimous certificate and defeat the guarantee. Protection against three-replica correlated failure is not claimed. This is the explicit high-water assumption. Deployment and recovery evidence must prove that no backup, account, credential, region, automation path, or operator action can roll back all three replicas.

Availability failure never weakens the barrier. Fewer than three matching live responses means `witness_unavailable`. A malicious replica can deny service but cannot make the endpoint accept fewer signatures. Each replica also uses an append-only ledger, immutable high-water journal, narrowly scoped service identity, audited recovery, and no administrative decrement operation. Those controls aid recovery but do not replace quorum independence.

TLS is required but is not the receipt trust root. Each replica signs with its own versioned key. All three trust sets are pinned in the native artifact and compatible browser bundle. Rotation for one replica requires an overlap period and authorization signed by that replica's already trusted key; rotations for two replicas cannot share one approval event or credential. A control-plane response cannot introduce a new trust root by itself.

### Endpoint request-signing key

Witness requests reuse the endpoint's existing Ed25519 MLS credential key. This is an explicit decision. A dedicated witness key is not introduced.

The reuse is constrained as follows:

- the only additional operation is an internal signature over `"Axl rollback witness request v1" || canonical_witness_request_without_signature`;
- the Rust core and private WASM worker construct the complete message and invoke the signer internally;
- no binding exposes `sign`, a signer handle, raw private-key bytes, or caller-selected bytes;
- registration carries the canonical Axl basic credential and proves possession of its embedded public key; hosted account and installation authorization bind the daemon credential, while a device pre-join registration is bound before claim publication and the later pairing claim must contain the exact same credential hash;
- witness signatures cannot be parsed as MLS credentials, pairing signatures, MLS messages, or another profile transcript because each has a distinct fixed domain and encoding; and
- changing the domain, key use, or request encoding requires witness protocol revision and security review.

This choice adds no field or key to the revision 1 pairing transcript and does not change OpenMLS wire bytes. A dedicated witness key would require a signed binding, key rotation and loss rules, and pairing/profile changes without providing a clear v1 security benefit.

### Acyclic state commitment and persisted request

The commitment is deliberately outside the sealed inner image. For successor state `n`, construction is ordered as follows:

1. Serialize `inner_state_n` without `commitment_n`, witness request bytes, request hash, or receipt. It contains the complete OpenMLS provider image and the authenticated durable-record manifest.
2. Seal `inner_state_n` under the fresh DEK and inner-state nonce to produce exact `sealed_inner_n` bytes.
3. Calculate `sealed_hash_n = SHA-384(sealed_inner_n)`.
4. Calculate the state commitment from that hash and the clear authenticated header.
5. Generate the 32-byte witness request nonce, construct the complete canonical request containing the commitment, and sign it with the domain-separated endpoint signing operation.
6. Calculate `request_hash_n = SHA-384(exact_witness_request_n)`.
7. Seal a separate `outer_metadata_n` value under the same DEK with a different nonce and domain. It contains `commitment_n`, `commitment_(n-1)`, the exact witness request bytes, and `request_hash_n`.
8. Atomically commit the clear header, exact sealed inner bytes, exact sealed outer metadata, operation records, and exact operation result.

The commitment is:

```text
sealed_hash_n = SHA-384(exact sealed_inner_n bytes)

commitment_n = SHA-384(
  "Axl rollback state commitment v1" ||
  profile_id || profile_revision || endpoint_role ||
  account_id || installation_id || device_id || crypto_session_id ||
  counter_n || generation_n || epoch_n || epoch_authenticator_n ||
  current_key_id_n || sealed_hash_n || commitment_(n-1)
)
```

Lengths and integers use fixed canonical big-endian encodings. The initial predecessor is 48 zero bytes. The clear header is authenticated as AEAD associated data for both envelopes. The two envelopes use independently generated nonces and distinct domain labels. The current key ID and both nonces may be clear; all other outer metadata is encrypted and authenticated.

This format is acyclic. The sealed inner bytes determine the commitment. The commitment determines the signed witness request. The signed request is then stored in separately authenticated outer metadata. The signed witness quorum certificate binds `commitment_n` and `request_hash_n`, so it authenticates the exact persisted request without being an input to its own commitment.

On load, the adapter decrypts both envelopes, validates the inner durable manifest, recomputes the sealed hash and commitment, hashes and verifies the exact stored request, verifies its endpoint signature and fields, and then compares it with a fresh signed witness quorum head or the matching quorum certificate. The witness replicas see only the commitment and request metadata, not the sealed inner bytes or manifest.

A witness request is never transmitted before the corresponding local commit succeeds. If the local commit is absent, an unreferenced prepared key and uncommitted request may be discarded. If the commit is present or uncertain, every retry resends the exact stored request bytes. It never generates a new nonce or signature.

### Protocol operations

Witness protocol v1 has three bounded binary requests:

- `register`: create a never-reusable lineage at counter 1;
- `read`: return the current head and revocation state; and
- `advance`: compare `(expected_counter, expected_commitment)` and append exactly one successor.

Every request includes the protocol version, request kind, lineage, operation ID, 32-byte request nonce, expected head where applicable, proposed counter and commitment where applicable, hash of the previous quorum certificate, endpoint credential fingerprint, and an Ed25519 signature over the complete canonical request. `register` additionally includes the bounded canonical Axl basic credential so the service can validate the role, identifiers, public key, and proof of possession. The maximum request is 1 KiB.

Each replica receipt includes the protocol version, result, replica ID, witness key ID, lineage hash, counter, commitment, predecessor commitment, operation ID, request hash, append-ledger sequence, issued time, revocation generation, and replica Ed25519 signature. A quorum certificate contains exactly three matching replica receipts and is at most 3 KiB. A `read` receipt also binds the fresh read-request hash, preventing replay of an old head as a fresh quorum response.

Normal registration, read, and advance requests authenticate both the hosted account/device session and the endpoint signature. Account authentication cannot substitute for the endpoint signature. Registration validates the canonical basic credential, its role and identifiers, and proof of possession, then binds its public key and credential hash to the lineage. A device registration occurs before claim publication; subsequent hosted pairing handoff and daemon claim validation must use that exact credential hash. No later request may replace it. The sole exception is receipt-only recovery for an exact operation accepted before revocation: it requires the bound endpoint proof of possession and exact request hash but does not require a still-active hosted grant.

The counter-1 `register` request follows the same persistence rule as `advance`: its exact signed bytes and hash commit with the initial local state before the request is sent. An absent lineage accepts one registration. At each replica, the same lineage and request hash returns that replica's byte-identical registration receipt. A different request for an existing lineage returns terminal `registration_conflict`; deletion or account recovery never makes that lineage reusable. `read` is non-mutating and may use a fresh nonce because it creates no local successor and cannot advance or reset a head.

### Compare-and-swap and idempotency

Each replica validates request syntax, `next_counter = expected_counter + 1`, lineage, endpoint signature, and account binding before applying this ordered decision table. The endpoint or stateless gateway collects matching replica results into a quorum certificate.

1. If the operation ID is recorded with the same request hash and its accepted ledger sequence precedes a later revocation event, return the byte-identical stored `advanced` receipt. This receipt-only recovery remains available by endpoint proof of possession after account or device revocation and grants no new operation. A forked lineage does not use this exception.
2. If the operation ID is recorded with a different request hash, return `operation_conflict`.
3. If the lineage is already forked, return its signed terminal result. If it is revoked, return `revoked` for every request except the exact accepted-operation recovery in step 1.
4. If `(expected_counter, expected_commitment)` is the current head, append the proposed successor and return `advanced`.
5. If the expected pair is the immediate predecessor of the current head:
   - when the proposed successor equals that recorded current head but step 2 did not match, return `stale_expected`; or
   - when the proposed successor differs, append terminal `forked` and return `conflicting_successor`.
6. If the expected pair is an older historical head:
   - when the proposed successor equals the successor already recorded for that historical head, return `stale_expected`; or
   - when it proposes a different historical branch, append terminal `forked` and return `historical_fork`.
7. If the expected counter is lower than the current counter but the expected pair is not in the retained history, return `stale_expected`. It is invalid and cannot prove a fork.
8. If the expected counter is equal to or greater than the current counter but its commitment is not the current head, or the counters are not consecutive, return `invalid_expected`.

`conflicting_successor` and `historical_fork` are terminal. No later advance is accepted for either clone. The winner may already have released the operation that won before the second branch became visible; no later output may be released.

One lineage can have only one row for each counter and one successor for each predecessor at each replica. The head index is derived from append-only rows. Request and receipt bytes are retained for the full lifetime of an active lineage so historical-fork classification is deterministic; archival after revocation must preserve their hashes and chain positions. The unanimous rule prevents a conflicting certificate as long as at least one replica preserves monotonic non-equivocation.

### Witness persistence and disaster recovery

Each production replica must provide serializable or linearizable CAS semantics. Its authoritative record is an append-only ledger. A mutable head table is a disposable index. Its immutable high-water journal is in a separate storage and credential domain from its primary database.

A replica signs an advance only after it durably places the accepted ledger entry in both its authoritative store and its immutable journal. If the second write is uncertain, that replica returns no vote and reconciles by request hash. The endpoint releases output only after all three replicas return matching signed receipts. A lagging replica may catch up only from a prior valid unanimous certificate and complete predecessor chain; no endpoint operation progresses while it catches up.

A replica that restarts performs these checks before voting:

- rebuild its head from the highest valid append-only chain;
- compare that head with its own immutable journal;
- obtain fresh signed heads from both other replicas;
- refuse to vote if its head is lower than a valid peer quorum, if peers conflict, or if its local stores disagree; and
- catch up from a verified quorum chain without deleting or rewriting history.

System-wide recovery rules are:

- never restore multiple replicas from one backup set or under one recovery credential;
- place every replica in a distinct cloud account, region, database cluster, administrative credential set, and recovery path;
- freeze a lineage if a predecessor is missing or two successors exist;
- never restore a lower counter, delete a lineage, reassign a lineage, or accept an administrative counter reset;
- keep each replica's signing key outside its database backups and rotate it through the pinned keyset process; and
- test loss and restore of each replica and rollback of any two replicas while at least one preserves the high-water mark.

A witness quorum certificate is evidence of service acceptance, not a recovery copy of endpoint state. If local successor state is lost after the quorum advances, re-pairing is required.

### Privacy

The service stores a keyed or direct lineage identifier, not user-readable session content. It stores no group ID, epoch authenticator, OpenMLS bytes, ciphertext, plaintext, DEK, wrapping record, KeyPackage private material, Welcome plaintext, prompt, tool input, or canonical event.

Counters and timing reveal activity. Retention and access controls must be documented before deployment. Security-audit events use stable reason codes and lineage hashes. Application logs must not log complete requests, signatures, receipts, or commitments at info level.

### Revocation

Revocation and fork quarantine are append-only quorum events with a monotonically increasing revocation generation. A revoked or forked endpoint cannot register another lineage under the old device identity or advance an existing lineage. A race is resolved by ledger order at each quorum replica: if revocation reaches quorum first, the advance fails and no output is released; if the advance reaches quorum first, that exact operation may recover its original certificate and complete even when the response was lost. The receipt-only recovery endpoint requires proof of possession, compares the full stored request hash, and cannot advance state. All later operations fail. A later conflicting successor makes the lineage terminal even though the first successor remains the historical head.

Account recovery cannot clear device revocation or reuse a lineage. Recovery creates a new device identity, crypto session, group, and witness lineage.

## Exact crash-safe state machine

### States

For one endpoint, the production adapter has these durable logical states:

```text
READY(n, Cn)
LOCAL_COMMITTED(
  n+1,
  Cn+1,
  operation_id,
  exact_result,
  exact_witness_request,
  request_hash
)
WITNESS_CONFIRMED(n+1, Cn+1, request_hash)
READY(n+1, Cn+1)
QUARANTINED(reason)
```

`WITNESS_CONFIRMED` need not be a second security-sensitive local database commit. A verified quorum certificate may be cached, but a fresh quorum head remains authoritative. The next load reads all three replicas and proves unanimous equality before another operation. Avoiding a receipt-only local generation prevents an infinite requirement to witness the receipt write itself.

### 1. Load and authenticate committed local state

Under the per-session lifecycle claim and operation mutex:

1. Canonicalize the storage root and reject symlinks, reparse escapes, mismatched owners, and unsafe permissions or ACLs.
2. Open redb or IndexedDB without creating missing state.
3. Reconcile prepared key records against the key ID referenced by committed state. Never activate a record until committed state names it.
4. Load the active DEK from the platform store. If the store is locked, unavailable, ambiguous, or missing the current record, stop.
5. Decrypt the sealed inner state and separately sealed outer metadata. Validate schema, profile, lineage, manifest, operation records, generation, counter, epoch, epoch authenticator, commitment, exact witness request, request hash, endpoint request signature, and the acyclic reconstruction described above.
6. Read and verify matching fresh signed heads and revocation generations from all three witness replicas.
7. Reconcile only the cases in the table below. No OpenMLS object becomes reusable until reconciliation succeeds.
8. Erase a pending obsolete key only after local and quorum heads match and the quorum certificate binds the persisted request hash.

### 2. Prepare one OpenMLS mutation

1. Hold the exclusive writer claim for the endpoint.
2. Require local state and a fresh witness quorum head to equal `(n, Cn)` and the endpoint to be active and unrevoked.
3. Start the native redb write transaction, or retain the browser Web Lock and load the authenticated IndexedDB snapshot.
4. Bind a fresh operation ID to a canonical input fingerprint.
5. Reconstruct OpenMLS state only from the authenticated committed image.
6. Perform exactly one OpenMLS transition and build all successor durable records and the exact result.
7. Serialize the inner successor without commitment or witness fields, prepare a fresh inactive DEK, and seal the inner state.
8. Hash the exact sealed inner bytes and calculate `Cn+1`.
9. Generate one request nonce, construct `advance(n, Cn, n+1, Cn+1, operation_id)`, and sign the exact canonical request with the domain-separated endpoint identity key.
10. Hash the exact request and seal the outer metadata with an independent nonce.

A duplicate operation ID with the same fingerprint recovers the old exact result and, while the witness is pending, the exact stored witness request. A duplicate with another fingerprint is a conflict. A pending witness operation blocks every later mutation. No request is sent during preparation.

### 3. Atomically commit local state and exact result

For native storage, write all successor records, exact result, clear authenticated header, exact sealed inner state, and exact sealed outer metadata in the existing immediate-durability, two-phase redb transaction. The outer metadata contains the exact signed witness request bytes and request hash. For the browser adapter, use one short `readwrite` IndexedDB transaction over every affected store with requested and observed `strict` durability.

The transaction rechecks the expected generation, counter, commitment, lineage, and operation fingerprint. It then commits every successor value atomically. After durable commit, activate the prepared current key. Do not erase the old key yet.

If commit reports an uncertain result, close the engine, reopen it, authenticate committed state, and inspect the operation record. Candidate state from the failed process is never reused.

### 4. Advance or reconcile the witness

Load the exact signed witness request from authenticated committed outer metadata and send those byte-identical bytes to all three replicas through the authenticated HTTPS control-plane endpoint. Verify three matching replica receipts in Rust or the private WASM worker against the pinned replica keysets, persisted request hash, commitment, operation ID, lineage, and revocation generation. Never reconstruct, resign, or renonce a committed request.

- A quorum certificate for `advanced`, including byte-identical duplicate recovery receipts, satisfies the witness barrier.
- A timeout, transport error, fewer than three matching receipts, or unavailable quorum leaves the endpoint in `LOCAL_COMMITTED` and frozen.
- A conflicting successor, stale quorum head, invalid receipt, revocation of a new operation, fork, or service inconsistency quarantines the endpoint.
- An exact request accepted before revocation may recover its quorum certificate after revocation. It does not authorize or advance another operation.

After a valid quorum certificate, erase the obsolete active key record. If erasure fails, return no application output. Recovery verifies local and quorum equality and retries erasure.

### 5. Release output

Only after local durable commit, current-key activation, a valid unanimous 3-of-3 witness quorum certificate, and obsolete-key erasure may the binding:

- return ciphertext for transport;
- return Welcome, KeyPackage, invitation, claim, activation, commit, or epoch-ready bytes;
- return plaintext to daemon authorization; or
- return plaintext to a client projection.

The Node and browser public APIs may expose a bounded signed witness request before the barrier. They must not expose candidate ciphertext, plaintext, state snapshots, DEKs, raw keys, mutable OpenMLS state, or transaction handles. Supplying a receipt is a typed continuation by operation ID, not authority to select state.

### 6. Restart recovery

Restart repeats the load algorithm. It loads and authenticates the exact pending witness request and request hash committed with local state. It resends those bytes without reconstruction, a new nonce, or a new signature. It does not need an in-memory prepared handle.

| Local state | Fresh quorum state | Meaning | Recovery |
| --- | --- | --- | --- |
| `(n, Cn)` | `(n, Cn)` | Clean committed head | Continue. |
| `(n+1, Cn+1)` with one pending operation | `(n, Cn)` | Local commit present, witness not advanced | Resend the exact CAS. No output until receipt. |
| `(n+1, Cn+1)` | `(n+1, Cn+1)` | Witness advanced, acknowledgement or local receipt lost | Query or resend. Verify duplicate receipt, erase obsolete key, return exact stored result if the caller retries. |
| `(n, Cn)` | `(n+1, Cn+1)` | Local successor lost or an old backup was restored | `stale_local_state`, quarantine, revoke when possible, re-pair. The witness cannot reconstruct private state. |
| `(n+1, Cx)` | `(n+1, Cy)`, `Cx != Cy` | Fork or corruption | `witness_conflict`, quarantine both branches, re-pair. |
| local ahead by more than one | any lower witness head | Violated serialization or corruption | `corrupt_state`, quarantine. |
| quorum behind by more than one | local current | Correlated three-replica rollback or service corruption outside the high-water guarantee | `witness_inconsistent`, freeze service and endpoint. |
| local state absent, witness exists | any | State loss | `state_loss`, revoke and re-pair. |
| local state exists, witness lineage absent after registration should have completed | any | Witness loss or wrong account | `witness_inconsistent`, no re-registration under the old lineage. |

## Retry and exceptional behavior

| Condition | Required behavior |
| --- | --- |
| Local commit absent | Remove only the unreferenced prepared key. Retry from the old committed state with the same operation ID and input fingerprint. |
| Local commit present, witness not advanced | Freeze the endpoint and resend the same signed CAS. Do not rerun OpenMLS. |
| Witness quorum advanced, acknowledgement lost | `read` or duplicate `advance` returns the stored replica receipts. Verify the quorum certificate and recover the exact local result. |
| Duplicate witness request | For a non-forked lineage, return matching byte-identical replica receipts when operation ID and request hash match, including after a later revocation. |
| Same operation ID, different request | Return `operation_conflict`; quarantine the caller's endpoint state. |
| Conflicting successor | The first CAS wins. The losing endpoint releases no output and returns `witness_conflict`; both copies require operator-visible investigation and normally re-pairing. |
| Stale local state | Never fast-forward from witness metadata. Re-pair because private successor state is unavailable. |
| Restored backup | Continue only if commitment and counter equal the witness. One-ahead local state may finish its pending CAS. Any behind state is stale. |
| Unavailable witness | Return `rollback_anchor_unavailable` or `witness_unavailable`. Keep the committed exact result sealed and retryable. No offline release. |
| Revoked endpoint, new operation | Return `endpoint_revoked`, release no result, and retain enough local evidence for explicit cleanup. |
| Revoked endpoint, exact operation accepted before revocation | Permit receipt-only lookup by endpoint proof of possession and return the original quorum certificate. Release only the exact locally committed result. |
| Invalid replica signature, key ID, or mismatched quorum tuple | Return `witness_receipt_invalid`, quarantine, and emit a bounded security audit event. |
| Secure store locked | Return `secure_store_locked`. Do not prompt or use cached key material. |
| Current key missing | Return `state_loss`, then require re-pairing. Never create a new key for old state. |
| Obsolete-key deletion failed | Return `secure_store_unavailable`; on restart verify heads and retry deletion before output. |

## Backup, restore, migration, and cloning

A normal filesystem backup is not a portable E2EE backup.

- A backup is usable on the same endpoint only when its exact commitment equals a fresh witness quorum head and the selected secure store can load its current key.
- A backup one local commit ahead of the witness may finish only the exact pending CAS already recorded locally.
- An older backup is stale and requires re-pairing.
- A backup newer than the witness by more than one transition is corrupt.
- Copying local state to another machine is not migration.
- macOS `ThisDeviceOnly` items intentionally do not migrate.
- Windows nested DPAPI intentionally requires both the user and original Windows installation, subject to full-image clone limitations.
- Secret Service export or keyring copying is not supported migration.
- TPM clearing, motherboard replacement, browser profile loss, and secure-store reset require re-pairing.
- A supported migration creates a fresh endpoint lineage and pairwise MLS group, authenticates the transition through the old group when available, activates the new pair, and revokes the old endpoint. It never reuses a group ID, device ID, crypto session ID, witness lineage, or KeyPackage.

The installer and uninstaller must not silently delete E2EE state or secure-store records. Uninstall presents or documents an explicit revoke-and-remove flow. A reinstall discovers existing state, verifies the binary provenance and platform identity, and opens it through normal reconciliation. It never adopts an unverified directory.

## Offline behavior

Production E2EE is online-only with respect to the witness.

- Endpoint creation, pairing artifact release, send, receive, commit, update, acknowledgement that changes encrypted state, and reset all require the witness barrier.
- A witness outage may leave one locally committed transition pending. The endpoint remains frozen until reconciliation.
- The daemon may report local diagnostics that reveal no E2EE content. It may not decrypt queued content, create fresh ciphertext, release sealed plaintext, or advance MLS offline.
- There is no bounded offline counter lease in version 1. Such a lease would weaken rollback detection and require a separate RFC.
- Headless machines without an approved key store remain unsupported even when the witness is online. Browser production remains disabled until the production persistence adapter, witness integration, artifact isolation, and required runtime evidence pass.

## Error taxonomy

The production binding uses stable codes and bounded non-secret details.

| Code | Meaning | Retry class |
| --- | --- | --- |
| `unsupported_platform` | Artifact or platform profile is not approved | Retry only after installing a supported artifact or environment |
| `secure_store_unavailable` | Required platform store or service is absent | Retry after repairing the environment |
| `secure_store_locked` | Store exists but the current identity cannot access it without unlock or prompt | Retry after explicit user login or unlock |
| `secure_store_access_denied` | Wrong identity, ACL, entitlement, D-Bus policy, or service account | Configuration error |
| `secure_store_ambiguous` | Duplicate or inconsistent records exist | Quarantine |
| `key_record_missing` | Authenticated state references no usable current key | State loss and re-pair |
| `rollback_anchor_unavailable` | No approved witness is configured | Unsupported configuration |
| `witness_unavailable` | Three matching live replica responses are unavailable | Retry exact pending request; no output |
| `witness_auth_failed` | Hosted or endpoint authentication failed | Reauthenticate; no automatic downgrade |
| `witness_receipt_invalid` | Signature, key ID, request hash, or lineage mismatch | Quarantine and audit |
| `witness_operation_conflict` | Operation ID was reused with different bytes | Quarantine |
| `witness_registration_conflict` | An existing lineage received a different registration | Quarantine and investigate |
| `witness_conflict` | Another immediate or historical successor forked the lineage | Quarantine and re-pair |
| `witness_invalid_expected` | Expected head is future, malformed, or non-consecutive | Quarantine |
| `stale_local_state` | Witness is ahead of local state without a matching local successor | Re-pair |
| `witness_inconsistent` | Witness is missing, behind too far, forked, or restored | Service incident; freeze |
| `endpoint_revoked` | Revocation won before the witness transition | Terminal for this lineage |
| `rollback_detected` | Local commitment, counter, epoch, or authenticator regressed | Quarantine |
| `strict_durability_unavailable` | Required local durability cannot be demonstrated | Unsupported environment |
| `storage_unavailable` | Local durable operation failed or remains uncertain | Reopen and reconcile |
| `state_loss` | Required committed state or secure key is absent | Re-pair |
| `re_pair_required` | The old lineage cannot safely continue | Explicit new pairing |

Existing codes such as `conflict`, `corrupt_state`, `lifecycle_busy`, `retention_exceeded`, and `clock_rollback` remain. Raw OS, redb, D-Bus, OpenMLS, Rust panic, file path, or witness backend errors do not cross the public boundary.

## Package ownership and dependency boundaries

### `packages/e2ee`

The Rust package owns:

- the acyclic inner-state and outer-metadata format and native sealing;
- state commitment calculation and the private browser finalization operation over exact sealed bytes;
- domain-separated endpoint request signing and exact-request persistence;
- local and witness-head reconciliation;
- the pending-witness state machine;
- receipt signature and request-hash validation;
- exact output gating;
- platform `EnvelopeKeyStore` implementations behind target-specific modules;
- typed secure-store and witness outcomes; and
- canonical witness binary fixtures.

It does not own account authorization, relay routing, HTTP policy, UI, or daemon capabilities.

### `packages/e2ee/bindings/node`

The private Node binding owns:

- copying and bounding witness request and receipt bytes;
- keeping endpoint operations serialized;
- exposing only an immutable witness request when a local commit needs the hosted barrier;
- accepting only a signed receipt for the matching operation; and
- returning the exact committed result only after Rust validates the barrier.

It exposes no key callback, raw key, DEK, snapshot, storage provider, mutable group, transaction, state commitment constructor, or counter setter. Test constructors remain feature-gated and excluded from production artifacts.

### `packages/daemon`

A later wiring PR may own authenticated HTTPS transport to the witness and retry scheduling. It treats witness requests and receipts as bounded opaque bytes from the binding. It cannot tell the binding to accept a counter or select a local branch. Daemon authorization still runs after MLS authentication and before a received request is accepted as a daemon operation.

### `packages/protocol`

The dependency-free protocol package owns public service request and response validation and stable error codes when the witness API becomes a public control-plane API. It does not own cryptographic state or construct commitments. Canonical binary fixtures keep the Rust and TypeScript parsers aligned without a runtime dependency between them.

### `services/control-plane`

The control plane owns authenticated witness admission, device revocation checks, quorum fan-out, append-only CAS interfaces, signed replica receipts, audit events, and disaster recovery. The gateway has no witness signing key or state authority. Each replica is separately deployed and administered. The witness modules are isolated from ordinary account tables behind typed interfaces and receive no private E2EE state.

### Browser binding

The private worker owns IndexedDB, Web Locks, WebCrypto key use, commitment calculation, receipt validation, and output gating. Page JavaScript may transport a bounded witness request and return a receipt. It cannot inspect state or make a receipt valid.

No presentation package depends on the E2EE core or native binding. `packages/kernel` remains unchanged and dependency-free except for `packages/protocol`.

## Browser production path

The hosted witness protocol satisfies the browser's independent rollback-anchor requirement. It is outside IndexedDB and detects a restored or forked browser profile through the same CAS rules.

This RFC also selects the browser envelope-key mechanism under the stated browser threat model: one origin-bound, non-extractable AES-KW `CryptoKey`, generated with `extractable = false` in the dedicated worker and persisted by structured clone in the key database. It wraps each fresh state DEK. Raw wrapping-key bytes never exist in JavaScript, and a DEK handle never crosses the worker boundary.

WebCrypto, not Rust/WASM, performs browser state sealing and unsealing. The browser path is an explicit exception to the native Rust-memory rule:

1. The transient WASM endpoint performs one OpenMLS transition and serializes the inner successor into one worker-owned `Uint8Array`. The mutable endpoint remains reachable only through an internal pending mutation.
2. WebCrypto generates a fresh AES-256-GCM state `CryptoKey`. It is temporarily extractable only so `subtle.wrapKey("raw", stateKey, wrappingKey, "AES-KW")` can wrap it without exposing raw bytes to application code.
3. WebCrypto seals the inner snapshot with the state key and inner nonce.
4. The worker passes the exact sealed-inner bytes back through a private WASM finalization call. Rust validates the pending mutation, computes the commitment, generates and signs the fixed witness request, and returns only the non-secret outer metadata bytes to the worker. This call is not exported by the public worker protocol.
5. WebCrypto seals the outer metadata with the same state key and an independent AES-GCM nonce.
6. The wrapped state-key bytes, ciphertexts, headers, exact witness request, and operation result commit in the strict IndexedDB transaction.
7. The worker overwrites its inner snapshot, outer metadata, AAD, sealed-byte staging, and temporary result buffers immediately after WebCrypto settles, drops every state-key reference, destroys the transient WASM endpoint, and returns no application output before the witness quorum barrier.
8. On load, WebCrypto unwraps the state key as non-extractable and decrypt-only, decrypts both envelopes, passes the inner and outer bytes to a fresh WASM endpoint, then overwrites the JavaScript plaintext buffers after Rust has copied and validated them.

No public API can request `exportKey`, receive either key object, or receive snapshot bytes. The implementation must never call `exportKey` for a state or wrapping key. JavaScript and user agents can retain unobservable copies, so reliable zeroization of JS heaps, browser internals, JIT state, swap, and crash dumps is not claimed.

This selection has explicit limits and lifecycle behavior:

- non-extractability prevents API-level key export; it does not prevent the origin from invoking the key;
- compromised same-origin code is outside the threat model, as already stated;
- hardware backing is neither required nor claimed, and the adapter reports `hardware_backing = false`;
- the store is origin-and-profile-bound, not user-bound or machine-bound;
- browser or operating-system screen lock does not provide a portable key-unavailable signal, so no lock-screen protection is claimed;
- the browser may lose, evict, restore, migrate, or copy the key with its profile;
- profile loss or a missing wrapping key is `state_loss` and requires re-pairing;
- a current complete profile copy may open, but two copies cannot both advance because the witness CAS detects the fork;
- an older profile restore is rejected by the witness before plaintext or ciphertext release;
- logout from the hosted account revokes network authorization but does not itself delete local keys;
- explicit local reset deletes wrapped DEKs and then the wrapping key only after terminal state and revocation are durable; and
- deletion has no forensic guarantee for browser profiles, backups, snapshots, caches, swap, or physical media.

These properties are weaker than the selected native stores, but they satisfy the approved browser threat model. Hardware backing and compromised-origin resistance are non-goals for both this browser path and some native configurations. The witness supplies the security property that IndexedDB and WebCrypto lack: an independent monotonic state commitment.

The Session 50.5 adapter remains test-only in the current tree. Browser pairing remains disabled until a focused production PR completes all of the following, not until another architecture decision:

1. move only reviewed persistence code from the test artifact into production source;
2. remove `test_anchor_v1`, all test constructors, fault controls, deterministic fixtures, and test-only exports;
3. replace the test anchor with signed hosted witness requests and verified unanimous 3-of-3 quorum certificates;
4. add the acyclic inner-state, outer-metadata, exact-request, and request-hash format;
5. retain one dedicated worker and one exclusive per-session Web Lock;
6. retain one strict IndexedDB transaction for state, operation, exact result, exact witness request, and both sealed envelopes;
7. use WebCrypto for state encryption, decryption, wrapping, and unwrapping, with worker-local transfer and zeroization behavior exactly as specified above;
8. keep wrapping keys and state-key handles inside the worker;
9. expose no raw key, DEK, snapshot, mutable OpenMLS state, transaction, or prepared mutation through the public worker protocol;
10. destroy the transient WASM endpoint after every operation and immediately after any abort, conflict, lock loss, worker loss, or ambiguous completion;
11. require fresh runtime evidence for Chrome, Edge, Firefox, actual Safari, private browsing, profile migration, storage pressure, browser update, worker suspension, and device restore; and
12. keep production package scans that reject test symbols and test paths.

Playwright WebKit is not Safari evidence. A test anchor in a separate artifact is not production rollback evidence.

## Windows implementation audit

The current source can select redb for Windows at compile time because `redb` is enabled for every non-WASM target. That is not Windows support.

Current blockers are:

- `sync_parent_directory` is a no-op on non-Unix systems. Marker creation, marker removal, and lifecycle publication therefore lack a demonstrated Windows directory-durability barrier.
- `restrict_directory` and `restrict_file` are no-ops on non-Unix systems. The database, marker, and lifecycle lock receive no Axl-owned Windows ACL hardening.
- `File::try_lock` is portable in the Rust API, but its Windows sharing, abrupt-process-exit, antivirus, and installer interactions have not been tested for this lifecycle protocol.
- `is_symlink` and path canonicalization do not constitute a reviewed defense against every Windows reparse point, junction, mount point, UNC form, path prefix, case alias, and handle-swap race.
- redb 4.2.0 contains a Windows file backend and uses file synchronization for immediate durability, but Axl has no Windows crash, reboot, torn-write, antivirus, VSS restore, NTFS, or ReFS evidence.
- The Node loader recognizes only macOS and glibc Linux. Windows returns `unsupported_platform` before loading an addon.
- The build script expects `.dylib` or `.so`; it does not stage an MSVC `.dll` as a `.node` artifact.
- There is no Windows artifact manifest row, CI builder, Authenticode signing, installer selection, ARM64 runner, or fresh-install smoke test.
- There is no DPAPI implementation, service-account profile policy, SID-bound ACL, or nested user-and-machine record.
- The current tests do not exercise Windows reboot and power-loss boundaries.

A Windows PR must replace the no-op filesystem helpers with handle-based Windows implementations. It must reject reparse-point traversal, apply and verify owner/SID ACLs, use write-through and `FlushFileBuffers` where required by the lifecycle protocol, and redesign any directory-publication step that cannot make a defensible durability claim. Passing a cross-compile check is not enough.

Until all Windows evidence passes, both MSVC architectures must keep the stable loader outcome `unsupported_platform`. A partially installed secure store may instead return `secure_store_unavailable`, but it must never open production state.

## Dependency evaluation

### Rules

This RFC records candidates only. A dependency-bearing PR must regenerate its candidate from its then-current RC baseline and record:

- the exact direct declaration and features;
- the complete selected normal, build, and development graph;
- the committed lockfile hash;
- every crate checksum and license;
- source tags and commits for direct candidates;
- build scripts, procedural macros, native libraries, downloaded tools, and system services;
- `cargo audit`, `cargo deny`, npm audit where applicable, and license results; and
- runtime evidence on every claimed target.

No candidate below is approved by this RFC.

### Operating-system APIs and services

| API or service | Version and source | Integrity and license | Native or service dependency | Decision |
| --- | --- | --- | --- | --- |
| Apple Security.framework Keychain Services | OS API, `SecItemAdd`, `SecItemCopyMatching`, `SecItemUpdate`, `SecItemDelete`; data-protection keychain available on macOS 10.15+, selected release floor to be fixed by packaging PR | No standalone source tag or crate checksum. Integrity comes from the signed macOS build. Apple platform terms apply. Evidence must record exact macOS version and build. | `/System/Library/Frameworks/Security.framework` | Selected API. A Rust wrapper candidate is below. |
| Windows DPAPI | `CryptProtectData` and `CryptUnprotectData` from `Crypt32.dll`; supported Windows desktop API | No standalone package checksum. Integrity comes from Windows servicing and Authenticode. Evidence records exact Windows build. | `Crypt32.dll`, `Kernel32.dll`, user profile, DPAPI master keys | Selected API with nested user and machine scopes. |
| Windows CNG Platform Crypto Provider | Windows 8+ CNG provider and TPM APIs | OS-provided. Hardware provenance requires key attestation, not merely API presence. | TPM and Microsoft Platform Crypto Provider | Deferred stronger mode. |
| Secret Service | Secret Service 0.2 DRAFT, publication 2026-04-08 | Specification has no binary checksum. Each approved implementation and distro package needs its own version, package digest, and license record. | D-Bus user session and tested secret-service implementation | Selected only for named, tested desktop implementations. |
| TPM2 TSS ESAPI | TPM 2.0 and system `tpm2-tss` ABI selected by a future distro matrix | System library version and package digest must be recorded per distro. | `libtss2-esys`, TPM resource manager, `/dev/tpmrm0` | Deferred headless candidate. |
| IndexedDB 3.0 and Web Locks | Browser-provided web APIs | No standalone checksum. Evidence records exact signed browser build. IndexedDB `strict` is a durability hint, not a rollback anchor. | Browser profile and origin | Selected local transaction and single-writer mechanisms; hosted witness supplies rollback protection. |
| WebCrypto | Browser-provided API, non-extractable AES-KW key | No standalone checksum. Evidence records browser build. Non-extractability is not hardware attestation. | Browser crypto implementation | Selected browser envelope-key mechanism under the explicit origin-compromise non-claim. |

### Rust candidates

| Candidate | Exact source and checksum | License and maintenance | Selected graph and system dependencies | Decision |
| --- | --- | --- | --- | --- |
| `security-framework` 3.7.0 with default features off and `OSX_10_15` | crates.io SHA-256 `b7f4bc775c73d9a02cde8bf7b2ec4c9d12743edf609006c7facc23998404cd1d`; tag object `4efde9cf6495e2ac366a98134c1f98f9eced627b`; source commit `5f6e65114b77d5bc161d2b099cad09f2a67609d2` | MIT OR Apache-2.0; released 2026-02-20; current stable candidate found in the evaluation | 6 external pairs including the direct crate; links Apple frameworks; no downloaded binary | Preferred macOS binding. Direct manual FFI is rejected because it adds an avoidable unsafe CoreFoundation ownership boundary. |
| `windows-sys` 0.61.2 with only required Win32 features | crates.io SHA-256 `ae137229bcbd6cdf0f7b80a31df61766145077ddf49416a728b02cb3921ff3fc`; source commit `32c3144490c016fe496a0aed769bce60987a2e9d`; no distinct crate tag was found in the evaluated source metadata | MIT OR Apache-2.0; current stable candidate | 2 external pairs: `windows-sys` 0.61.2 and `windows-link` 0.2.1; links Windows system DLLs | Preferred Windows bindings. It is smaller than the high-level `windows` crate for this narrow API. |
| Axl-maintained `secret-service` 5.2.0 fork with `rt-async-io-crypto-rust` | exact commit `1721451b21acfc3450be8799d92947653a5656e3`, based directly on upstream tag and commit `1fe4fbe405b152bc969deb5de417847e1e4e4c7b`; upstream crates.io checksum `5107b24b91445dd2aa449a258a1807b63240942157292354dc5bfdbeb8bc6db8` no longer authenticates the fork | MIT OR Apache-2.0; the maintained fork adds only no-prompt item creation and deletion outcomes | 101 external pairs in the selected Linux normal/build closure; D-Bus service required; no native crypto library with the Rust crypto feature | Selected Linux desktop client after the released API was found to execute returned prompts internally. The exact fork restores a fail-closed no-prompt boundary without reimplementing D-Bus framing or session cryptography. Replace it with an upstream release after equivalent APIs ship and pass dependency review. |
| `tss-esapi` 7.7.0, defaults off | crates.io SHA-256 `3f10b25a84912b894d0e6d68f4a3771c923e9c44ddaaed7920cde92ed28aa84e`; tag and commit `27d506313be57a22c62d632d4f7b21b3f5b7b422` | Apache-2.0; released 2026-04-24; stable 7.x while 8.0.0 is alpha | 39 external selected pairs; requires `tss-esapi-sys` 0.6.0, `pkg-config`, and system TSS2 libraries | Deferred, not selected for v1 headless support. |

The isolated candidate lock hashes were:

```text
security-framework 3.7.0: c2d3ad0f09b27da0f93f441e7734e82eab6a98166155a9da077edf99baeafbe3
windows-sys 0.61.2:      387d6b9f2d51c9b1267daa83f58c77619d092a15c2634044ac15ef3920f42e62
secret-service 5.2.0 upstream candidate: a59c3db2a6ab7c69e089e082e80e3af040dd4ef4923bbfde3d23d64435bc09da
tss-esapi 7.7.0:         1c8efd8a427f747f0c9ecbc90051aa47523189764e880f92226f5da5bef4b063
```

These locks were generated under a temporary directory and are evidence only. They are not repository implementation locks. A combined 140-dependency candidate lock was scanned against 1,246 RustSec advisories with `cargo-audit` 0.22.2 on 2026-09-18 and reported no vulnerability. That result expires when any candidate or graph changes.

### Selected transitive graphs

The macOS candidate selected these external package/version pairs:

```text
bitflags 2.13.2
core-foundation 0.10.1
core-foundation-sys 0.8.7
libc 0.2.189
security-framework 3.7.0
security-framework-sys 2.17.0
```

The Windows candidate selected:

```text
windows-sys 0.61.2
windows-link 0.2.1
```

The Linux Secret Service candidate selected:

```text
aes 0.9.3; async-broadcast 0.7.2; async-channel 2.5.0; async-executor 1.14.0;
async-io 2.6.0; async-lock 3.4.2; async-process 2.5.0; async-recursion 1.1.1;
async-signal 0.2.14; async-task 4.7.1; async-trait 0.1.92; atomic-waker 1.1.2;
autocfg 1.5.1; bitflags 2.13.2; block-buffer 0.12.1; block-padding 0.4.2;
blocking 1.7.0; cbc 0.2.1; cfg-if 1.0.5; cipher 0.5.2; cmov 0.5.4;
concurrent-queue 2.5.0; const-oid 0.10.2; cpubits 0.1.1; cpufeatures 0.3.1;
crossbeam-utils 0.8.23; crypto-common 0.2.2; ctutils 0.4.2; digest 0.11.3;
endi 1.1.1; enumflags2 0.7.12; enumflags2_derive 0.7.12; equivalent 1.0.2;
errno 0.3.14; event-listener 5.4.2; event-listener-strategy 0.5.4; fastrand 2.5.0;
futures-core 0.3.34; futures-io 0.3.34; futures-lite 2.6.1; futures-macro 0.3.34;
futures-task 0.3.34; futures-util 0.3.34; getrandom 0.4.3; hashbrown 0.17.1;
hex 0.4.3; hkdf 0.13.0; hmac 0.13.0; hybrid-array 0.4.15; indexmap 2.14.2;
inout 0.2.2; libc 0.2.189; linux-raw-sys 0.12.1; num 0.4.3;
num-bigint 0.4.8; num-complex 0.4.6; num-integer 0.1.47; num-iter 0.1.46;
num-rational 0.4.2; num-traits 0.2.19; once_cell 1.21.4; ordered-stream 0.2.0;
parking 2.2.1; pin-project-lite 0.2.17; piper 0.2.5; polling 3.11.0;
proc-macro-crate 3.5.0; proc-macro2 1.0.107; quote 1.0.47; rustix 1.1.4;
secret-service 5.2.0; serde 1.0.229; serde_core 1.0.229; serde_derive 1.0.229;
serde_repr 0.1.21; sha2 0.11.0; signal-hook-registry 1.4.8; slab 0.4.12;
syn 2.0.119; syn 3.0.5; toml_datetime 1.1.1+spec-1.1.0;
toml_edit 0.25.15+spec-1.1.0; toml_parser 1.1.3+spec-1.1.0; tracing 0.1.44;
tracing-attributes 0.1.31; tracing-core 0.1.36; typenum 1.20.1;
unicode-ident 1.0.25; uuid 1.26.1; winnow 1.0.4; zbus 5.19.0;
zbus_macros 5.19.0; zbus_names 4.3.4; zcheapstr 1.1.0; zvariant 5.15.0;
zvariant_derive 5.15.0; zvariant_utils 4.2.0
```

The deferred TPM candidate selected:

```text
aho-corasick 1.1.5; autocfg 1.5.1; base64 0.22.1; bitfield 0.19.5;
bitfield-macros 0.19.5; cfg-if 1.0.5; enumflags2 0.7.12;
enumflags2_derive 0.7.12; getrandom 0.4.3; hostname-validator 1.1.1;
libc 0.2.189; log 0.4.34; mbox 0.7.1; memchr 2.8.3; num-derive 0.4.2;
num-traits 0.2.19; oid 0.2.1; picky-asn1 0.10.1; picky-asn1-der 0.5.6;
picky-asn1-x509 0.15.4; pkg-config 0.3.34; proc-macro2 1.0.107;
quote 1.0.47; regex 1.13.1; regex-automata 0.4.18; regex-syntax 0.8.11;
serde 1.0.229; serde_bytes 0.11.19; serde_core 1.0.229; serde_derive 1.0.229;
stable_deref_trait 1.2.1; syn 2.0.119; syn 3.0.5; target-lexicon 0.12.16;
tss-esapi 7.7.0; tss-esapi-sys 0.6.0; unicode-ident 1.0.25;
zeroize 1.9.0; zeroize_derive 1.5.0
```

Procedural macros are explicitly shown in the generated evidence and require source review. The Secret Service graph adds D-Bus framing and a DH/AES transfer implementation. The TPM graph adds a build-time system-library probe. No candidate downloads an executable, but the TPM candidate requires distribution-provided native libraries.

### Why direct standard APIs are insufficient

- Rust's standard library has no Keychain, DPAPI, Secret Service, TPM, or attestation API.
- Manual Security.framework and CoreFoundation FFI would add unsafe retain/release and dictionary ownership code that the maintained wrapper already tests.
- Manual Windows declarations are possible, but `windows-sys` provides exact generated signatures with a two-package graph and avoids hand-maintained ABI definitions.
- Implementing D-Bus, Secret Service sessions, prompts, object lifetimes, and transfer encryption directly would create a new protocol and cryptographic maintenance surface.
- Implementing TPM TSS marshaling directly is not acceptable. The deferred candidate still requires the reviewed system TSS library.
- The hosted witness binary codec, SHA-384, and Ed25519 can use the already approved E2EE cryptographic graph. The daemon HTTPS transport can use existing Node built-ins. No new witness client dependency is selected here.

## Runtime test matrix

A support row requires stored evidence from a released or release-candidate artifact. CI compilation is only one line in the matrix.

### Every native target

Run on macOS arm64, macOS x64, Linux glibc arm64, Linux glibc x64, Windows MSVC arm64, and Windows MSVC x64 independently:

- Node 22.19 and Node 24 import, ABI, and fresh-randomness tests;
- create, pair, send, receive, update, commit, epoch-ready, revoke, reset, and re-pair;
- hard process kill after inner sealing, request signing, local commit, key activation, witness call, receipt, key erasure, marker, and close boundaries;
- operating-system reboot at every durable boundary;
- proof that a pre-commit request is never transmitted and that every post-commit retry resends byte-identical request bytes, nonce, signature, and hash;
- acyclic commitment reconstruction and separate outer-metadata authentication and tamper tests;
- exact-ciphertext and exact-plaintext recovery after an acknowledgement loss;
- duplicate witness request, lost witness response, conflicting successor, stale backup, local-ahead, witness-ahead, and invalid receipt;
- witness outage before mutation, after local commit, after one replica vote, after quorum commit, and during disaster recovery;
- rollback of each replica's primary database and immutable journal to the same older point while either or both other replicas retain the high-water mark;
- proof that one or two replicas cannot satisfy a read or advance, only three matching replicas can, conflicting votes do not form a certificate, and correlated three-replica rollback is reported as outside the guarantee rather than passed as tested support;
- secure-store absent, locked, denied, duplicate record, missing current key, failed activation, and failed deletion;
- same-session process contention and unrelated-session parallel progress;
- database, key-record, operation, manifest, commitment, receipt, and epoch-authenticator tampering;
- backup restore at current, one-behind, one-local-ahead, and conflicting states;
- full machine or VM clone with both copies racing the witness;
- account and endpoint revocation races;
- installer fresh install, upgrade, downgrade rejection, repair, uninstall, and reinstall;
- artifact hash, signature, SBOM, third-party notices, test-symbol exclusion, and offline installation; and
- no plaintext, DEK, wrapping key, private state, or invitation nonce in databases, logs, crash reports, installer logs, environment, process arguments, or packaged files.

### Platform-specific evidence

**macOS**

- actual Apple Silicon and actual Intel machines;
- login, logout, screen lock, sleep, wake, fast-user switching, keychain lock, and password change;
- unsigned development build and signed/notarized release build behavior;
- data-protection Keychain item non-migration and iCloud non-synchronization;
- app update with the same signing identity and rejection of an unauthorized binary; and
- Time Machine restore on the same machine and restore to another machine.

**Linux desktop**

- each named distro, glibc version, desktop, D-Bus implementation, and Secret Service implementation;
- GNOME Keyring and any KWallet path as separate support claims;
- login unlock, manual keyring lock, sleep, wake, logout, no session bus, service restart, and prompt-required behavior;
- proof that `dh-ietf1024-sha256-aes128-cbc-pkcs7` was negotiated, `plain` fallback is rejected, and an unexpected D-Bus service owner fails closed;
- package upgrade of the secret service and D-Bus;
- same-user retrieval and competing-process behavior recorded as an explicit non-claim, plus verified denial to another OS user; and
- arm64 hardware, not only emulation.

**Linux headless, future only**

- each approved physical TPM, firmware TPM, or vTPM class separately;
- EK certificate and attestation verification;
- Secure Boot and PCR-policy update behavior;
- kernel, initramfs, firmware, bootloader, and daemon update recovery;
- TPM clear, dictionary lockout, resource-manager restart, motherboard replacement, and cloud VM migration; and
- `tpm2-tss` package and device permissions on both architectures.

**Windows**

- Windows 11 x64 and native Windows on ARM hardware;
- NTFS and any claimed ReFS configuration;
- interactive user and a dedicated service account with loaded profile as separate modes;
- screen lock, sign out, password change, administrative password reset, domain join, domain leave, and roaming-profile attempt;
- VSS restore, full-system image restore, machine clone, antivirus scanning, and Windows Update reboot;
- reparse points, junctions, UNC paths, long paths, case aliases, ACL inheritance, owner changes, and handle races;
- abrupt service termination and reboot after `FlushFileBuffers` boundaries;
- MSVC CRT linkage and native Node addon load on arm64 and x64; and
- Authenticode verification, SmartScreen behavior, installer repair, and uninstall cleanup.

### Browser evidence before any later enablement

- branded Chrome, Edge, Firefox, and actual Safari;
- worker termination before and after local commit and witness advance;
- tab suspension, page freeze, process discard, device sleep, browser restart, and OS restart;
- storage pressure, eviction, private browsing, profile copy, profile restore, browser sync, and browser upgrade;
- Web Lock contention and unexpected lock loss;
- strict-durability reporting and actual crash recovery;
- witness outage, duplicate, fork, revocation, and disaster recovery; and
- production artifact scans proving the absence of test anchors, test constructors, raw key APIs, snapshots, mutable state, and transaction handles.

## Production packaging requirements

A production release must:

- ship prebuilt, integrity-manifested `.node` binaries for only the target rows with complete evidence;
- never compile native code on the user's machine during installation;
- sign and notarize macOS artifacts and sign Windows artifacts with the release identity;
- include the Rust lock hash, source commit, target triple, toolchain, Node-API version, OS deployment floor, artifact SHA-256, SBOM, licenses, and notices;
- select one exact binary by OS, architecture, libc family, and approved storage profile;
- reject musl, unknown Linux secret services, headless-without-TPM, unsupported Windows identities, Rosetta substitutions, and unknown architectures;
- package no test store, test anchor, fault injector, test constructor, fixture private state, or all-features artifact;
- preserve current package-content and exported-symbol negative checks;
- install data directories and ACLs before endpoint creation;
- make upgrade and rollback compatibility explicit and reject a binary that cannot read the existing schema;
- avoid deleting state or key records during ordinary uninstall; and
- verify the installed artifact before daemon wiring enables the capability.

Production support metadata must distinguish `built`, `runtime_tested`, `installer_tested`, and `supported`. Only the last state may enable endpoint creation.

## Approved implementation sequencing decisions

The responsible human approved these sequencing decisions for this draft PR:

- The hosted-witness implementation begins behind typed injected storage, signing, authentication, journal, and recovery interfaces with deterministic in-memory test implementations. Production assembly and deployment remain blocked until a focused decision selects and approves each replica's concrete datastore, Ed25519 signing-key service, immutable journal, failure domain, backup identity, and recovery authority. No deployment is part of this PR.
- The macOS, Linux desktop, and Windows dependency candidates recorded above are the preferred starting points, not unconditional dependency approvals. Each dependency-bearing commit must regenerate and receive approval for its exact current lockfile, features, transitive graph, licenses, advisories, build scripts, native requirements, and runtime evidence.
- Source review found that released `secret-service` 5.2.0 automatically executes prompts returned by item creation and item deletion. The approved minimal Axl-maintained fork adds no-prompt variants for only those operations and remains pinned by full commit. The adapter uses the existing unlocked default collection and never requests collection creation or unlock. No other upstream behavior is changed. This exception does not permit a moving branch dependency, direct Secret Service protocol implementation, or an enabled Linux support row without the required runtime evidence.
- Platform implementation proceeds in this order unless hardware availability requires a reviewed change: macOS, Linux desktop, Windows, then the production browser path. Ordering is not a support claim.
- Missing physical runtime evidence does not block merging code that remains fail-closed. It does block setting the target to `supported`, shipping an enabled production artifact for that target, or enabling endpoint creation. Emulation does not replace physical evidence where this RFC requires physical hardware.

Witness verifier keysets contain exactly three replica identities and at most four canonically ordered keys per replica. The bound permits controlled overlap across released artifact generations and emergency rotation. Rotation procedures must remove obsolete keys explicitly and may never use the larger bound to bypass the one-replica-at-a-time approval rule.

Endpoint reconciliation distinguishes overlapping counter-distance cases using the last locally confirmed witness head. A malformed pending chain more than one successor ahead is `LocalAheadMoreThanOne`; a fresh quorum below an already confirmed local head by more than one is `WitnessBehindMoreThanOne`. Neither case permits local fast-forward, output release, or another mutation.

## Phased implementation plan

All production-storage steps below are implemented in one draft PR from the current reviewed RC baseline, with each step kept in a separate DCO-signed commit and reviewed before work proceeds to the next dependency-bearing commit. Unsupported targets continue to fail closed. Session 60 remains a separate PR created only after this production-storage PR merges. The non-normative repository mapping and acceptance checklists are maintained in [`production-e2ee-implementation-briefs.md`](production-e2ee-implementation-briefs.md).

1. **Shared rollback-witness protocol and state machine**
   - Add commitment, request, receipt, reconciliation, and output-barrier behavior to `packages/e2ee`.
   - Add canonical Rust and TypeScript fixtures and exhaustive crash tests.
   - Keep all production constructors unavailable.

2. **Hosted witness storage and authenticated compare-and-swap**
   - Add the stateless control-plane gateway plus three independently deployed replicas, endpoint-signature validation, append-only CAS interface, separate receipt signers, revocation, immutable high-water journals, quorum certificates, and disaster-recovery tests.
   - Select and separately approve each replica's concrete production datastore, signing-key service, failure domain, and recovery authority before deployment. No two replicas may share one rollback path.

3. **macOS envelope-key store**
   - Re-evaluate and approve the exact `security-framework` graph.
   - Implement the data-protection Keychain adapter and macOS arm64/x64 lock, backup, crash, and signing tests.

4. **Linux envelope-key store**
   - Re-evaluate and approve the exact `secret-service` graph.
   - Implement only the desktop profile first and name supported service implementations.
   - Keep headless Linux unsupported. Handle TPM support in a later focused decision if required.

5. **Windows envelope-key store**
   - Re-evaluate and approve `windows-sys`.
   - Implement nested DPAPI, Windows ACL and path handling, durable lifecycle publication, and the complete native test matrix.
   - Keep the loader unsupported until both architectures pass.

6. **Production Node binding enablement and packaging**
   - Add the narrow witness-pending API, receipt continuation, supported artifact manifest, signatures, installer selection, and negative package checks.
   - Wire no daemon yet unless the target row is approved.

7. **Production browser persistence and witness enablement**
   - Implement the selected non-extractable AES-KW store and hosted witness path under the threat model in this RFC.
   - Promote reviewed persistence code without test facilities, preserve worker-only key use, and pass the complete browser matrix before enabling pairing.

8. **Cross-platform crash, restore, rollback, and installer evidence**
   - Run and archive every required matrix row on physical or accepted virtual hardware.
   - Update the support matrix only for complete rows.

9. **Session 60 real hosted integration**
   - Replace fake E2EE only after the production target's store, witness, binding, package, and evidence are approved.
   - Keep ordinary-session remote access and remote approvals behind their separate gates.

A platform may move earlier when hardware and reviewers are available. This does not allow one platform's evidence to stand in for another.

## Approval gates

Implementation must not begin until responsible humans explicitly approve:

- this threat model and its non-claims;
- mandatory online witness behavior;
- the witness trust and disaster-recovery assumptions;
- each platform support row and identity mode;
- the selected dependency candidate for the first implementation PR;
- the selected browser key-store threat model, non-claims, and production evidence gate; and
- the focused PR sequence.

Production daemon consumption additionally requires an independent review of the exact OpenMLS/libcrux graph, Axl storage and witness state machines, platform store, bindings, packaging, and operational recovery.

## Primary sources

- [Apple Keychain Services](https://developer.apple.com/documentation/security/keychain-services)
- [Apple `kSecUseDataProtectionKeychain`](https://developer.apple.com/documentation/security/ksecusedataprotectionkeychain)
- [Apple `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`](https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly)
- [Apple Secure Enclave key protection](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave)
- [Apple `SecItemDelete`](https://developer.apple.com/documentation/security/secitemdelete(_:))
- [Microsoft `CryptProtectData`](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)
- [Microsoft CNG DPAPI](https://learn.microsoft.com/en-us/windows/win32/seccng/cng-dpapi)
- [Microsoft TPM fundamentals](https://learn.microsoft.com/en-us/windows/security/hardware-security/tpm/tpm-fundamentals)
- [Microsoft Windows TPM and Platform Crypto Provider](https://learn.microsoft.com/en-us/windows/security/hardware-security/tpm/how-windows-uses-the-tpm)
- [Microsoft `FlushFileBuffers`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)
- [Secret Service API 0.2](https://specifications.freedesktop.org/secret-service/latest-single/)
- [systemd credentials and TPM binding](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html)
- [Indexed Database API 3.0](https://www.w3.org/TR/IndexedDB-3/)
- [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)
- [Web Cryptography Level 2](https://www.w3.org/TR/webcrypto/)
- [WebCrypto `CryptoKey.extractable`](https://developer.mozilla.org/en-US/docs/Web/API/CryptoKey/extractable)
- [Node-API ABI stability and prebuilt binaries](https://nodejs.org/api/n-api.html)
- [`security-framework` 3.7.0 metadata](https://crates.io/api/v1/crates/security-framework/3.7.0)
- [`windows-sys` 0.61.2 metadata](https://crates.io/api/v1/crates/windows-sys/0.61.2)
- [`secret-service` 5.2.0 metadata](https://crates.io/api/v1/crates/secret-service/5.2.0)
- [`tss-esapi` 7.7.0 metadata](https://crates.io/api/v1/crates/tss-esapi/7.7.0)
