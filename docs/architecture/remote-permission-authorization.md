<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Remote permission authorization contract

Status: proposed for architecture and security review

## Purpose

This contract binds a remote permission response to one pending daemon action. It defines authorization and durable acceptance after endpoint authentication. It does not define E2EE, pairing, signatures, or ratchet behavior.

The existing `permission.requested` event does not carry enough action-binding data, and the existing `session.interaction.respond` RPC covers MCP interactions rather than daemon policy approval. Neither existing surface is remotely approvable under this contract.

## Initial release boundary

The first remotely approvable action is a gated tool call in an ordinary session that:

- runs under an enforced sandbox
- remains within the daemon's current policy ceiling
- is already pending local permission review
- exposes `allow_once` and `deny` only
- comes from a device with the effective `approve_within_policy` scope

Remote `allow_session` is excluded initially because it changes authority for future actions. Unsafe sessions, sandbox bypasses, credential grants, device administration, policy changes, network or filesystem widening, audit changes, and generated-code activation are never remotely approvable.

Observer devices cannot respond, including with a denial. This prevents an observer from cancelling work.

## Identifiers

Use distinct nominal types:

```ts
type PermissionInteractionId = EventId;
type PolicyGeneration = string; // lowercase RFC 9562 UUID
type ActionDigest = string; // 64 lowercase hexadecimal SHA-256 characters
type DeviceGrantGeneration = number;
```

`PermissionInteractionId` is the canonical `permission.action_requested` event ID. It is never reused. No identifier grants authority.

`PolicyGeneration` is an opaque equality token created and durably stored by the daemon. It changes whenever any input to the effective action policy changes, including permission profile, sandbox enforcement, filesystem or network policy, credential policy, project policy, or administrator ceiling. It is not a counter supplied by a client.

Hosted and local device-grant generations remain separate from `PolicyGeneration`. The daemon checks all three at acceptance time.

## Canonical action binding

The daemon constructs this record only after typed tool input, paths, destinations, and policy effects have been normalized:

```ts
interface PermissionActionBindingV1 {
  readonly version: 1;
  readonly sessionId: SessionId;
  readonly operationId: OperationId;
  readonly interactionId: PermissionInteractionId;
  readonly capability: string;
  readonly subject: {
    readonly kind: "tool_call";
    readonly toolCallEventId: EventId;
    readonly callId: string;
    readonly toolName: string;
    readonly canonicalInputHash: string;
  };
  readonly effects: readonly PermissionEffect[];
  readonly policyGeneration: PolicyGeneration;
  readonly sandbox: {
    readonly securityMode: "sandboxed";
    readonly provider: string;
    readonly policyHash: string;
  };
  readonly allowedDecisions: readonly ["allow_once", "deny"];
  readonly expiresAt: number;
}
```

A `PermissionEffect` is a typed, normalized consequence. Initial variants are:

```ts
type PermissionEffect =
  | { readonly kind: "filesystem_read"; readonly canonicalPath: string }
  | { readonly kind: "filesystem_write"; readonly canonicalPath: string }
  | { readonly kind: "network_connect"; readonly scheme: string; readonly host: string; readonly port: number }
  | { readonly kind: "process_execute"; readonly executable: string }
  | { readonly kind: "capability_use"; readonly capability: string };
```

Paths are canonicalized before this record is created. Network hosts use the daemon's canonical host representation. Effects are sorted by the dependency-free canonical JSON encoder's defined order. Duplicate effects are removed. Unknown effect kinds are rejected rather than converted to text.

`canonicalInputHash` is the existing lowercase SHA-256 hash of the fully validated canonical tool input. Raw arguments remain in their existing canonical tool-call event and are not duplicated into the permission event.

`policyHash` is the lowercase SHA-256 hash of the normalized effective policy record used for this decision. That record contains rules and credential identifiers, never credential values. The hash is audit binding, not authority. The current policy object remains authoritative.

## Action digest

`actionDigest` is lowercase hexadecimal SHA-256 over the exact dependency-free canonical UTF-8 encoding of:

```text
{ type: "axl.permission-action", binding: PermissionActionBindingV1 }
```

The digest excludes transport IDs, device IDs, timestamps, descriptions, UI labels, and the digest itself. It is computed once by the daemon and stored with the canonical request event.

The digest detects accidental or malicious substitution after endpoint authentication. It is not a signature, possession proof, or replacement for E2EE.

`expiresAt` is the daemon-created absolute expiry for this interaction. Expiry never extends because a client reconnects or retries.

Any change to the action, effects, sandbox, policy, or expiry produces a new interaction and digest. The old interaction becomes stale. A digest algorithm or encoding change requires a new binding version.

## Canonical events

Add new variants instead of changing historical permission-event meanings.

```ts
interface PermissionActionRequestedPayload {
  readonly binding: PermissionActionBindingV1;
  readonly actionDigest: ActionDigest;
  readonly description: string;
}

interface PermissionActionResolvedPayload {
  readonly interactionId: PermissionInteractionId;
  readonly actionDigest: ActionDigest;
  readonly policyGeneration: PolicyGeneration;
  readonly decision: "allow_once" | "deny";
  readonly actor:
    | { readonly kind: "local_attachment"; readonly attachmentId: string }
    | { readonly kind: "remote_device"; readonly deviceId: DeviceId };
}
```

The event types are `permission.action_requested` and `permission.action_resolved`. The request event is appended and synced before any client may answer. The resolved event is the single canonical winner and is appended before execution proceeds.

Descriptions are presentation text and never participate in the digest. Events contain no credentials, relay tickets, E2EE material, or internal service credentials.

## Remote response RPC

Add a daemon RPC named `session.permission.respond`:

```ts
interface RemotePermissionResponseV1 {
  readonly version: 1;
  readonly sessionId: SessionId;
  readonly interactionId: PermissionInteractionId;
  readonly actionDigest: ActionDigest;
  readonly policyGeneration: PolicyGeneration;
  readonly decision: "allow_once" | "deny";
}
```

The ordinary RPC request ID and UUID idempotency key remain transport metadata. Both are required for a remote mutation. The response does not contain `deviceId`; the daemon uses only the identity established by successful endpoint authentication.

A local client may use the same RPC with attachment authority. The daemon records the actual actor after authorization.

## Authorization and acceptance order

The daemon performs these steps in order:

1. Bound and parse the outer frame.
2. Authenticate and open it through the injected E2EE boundary.
3. Establish the authenticated device identity.
4. Validate the plaintext RPC schema.
5. Load current hosted and local grants and their revocation generations.
6. Require the effective `approve_within_policy` scope.
7. Require an enforced sandbox and reject unsafe mode or bypass actions.
8. Load the exact pending interaction and reject it after its fixed expiry.
9. Compare session, interaction ID, action digest, and policy generation exactly.
10. Recompute the current policy ceiling and confirm `allow_once` remains an offered decision.
11. Apply the command journal's idempotency and request-hash rules.
12. Atomically accept the first unresolved response.
13. Append and sync `permission.action_resolved` with the authenticated actor.
14. Continue or deny the daemon-owned operation.
15. Seal the response through the endpoint E2EE boundary.

Decryption establishes identity only. Steps 5 through 13 establish authority and durable acceptance.

## Races and recovery

- The first durably accepted response wins across local and remote clients.
- A retry with the same idempotency key and request hash returns the original result.
- Reusing the key for another response returns `idempotency_conflict`.
- A different key after resolution returns `permission_already_resolved` and the canonical resolution event ID.
- A changed policy generation returns `stale_policy` without resolving the interaction.
- A changed digest returns `action_mismatch` without revealing the current action.
- A revoked or narrowed device returns `unauthorized` and creates no acceptance record.
- If acceptance is synced but the resolution event is missing after a crash, restart reconciliation either appends the deterministic resolution or proves no action resumed. It never asks the user to guess.
- Revocation after durable acceptance does not cancel the already daemon-owned operation. A separately authorized interrupt is required.

## Stable rejection classes

```text
unknown_permission
permission_expired
permission_already_resolved
stale_policy
action_mismatch
decision_not_allowed
observer_forbidden
device_revoked
scope_forbidden
unsafe_remote_approval_forbidden
sandbox_bypass_forbidden
idempotency_conflict
```

Public errors remain bounded and do not echo tool input, paths, commands, policy records, credentials, or device secrets.

## Required tests before implementation can ship

- modified action digest, policy generation, session, or interaction fails
- observer, revoked device, narrowed hosted grant, and narrowed local grant fail
- unsafe sessions and sandbox bypasses fail
- remotely supplied device identity is impossible
- `allow_session` is rejected remotely
- simultaneous local and remote responses produce one canonical winner
- same-key retry replays and conflicting-key reuse fails
- restart between acceptance and resolution reconciles without executing twice
- policy changes invalidate every old response
- permission events and diagnostics contain no credentials or cryptographic material
- successful approval cannot exceed the current daemon policy ceiling

## Release gate

This draft does not enable remote approvals. Implementation starts only after protocol and security review. User release still requires Person 1's E2EE library, secure state storage, integrated revocation tests, lost-device tests, and independent security review.
