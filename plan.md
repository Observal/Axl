<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Sandbox implementation plan

Status: focused plan. `IMPLEMENTATION_PLAN.md` remains the source of truth for delivery order. This document expands its Phase 7 local isolation and Phase 12 hosted-worker work.

## 1. Goal

Axl must execute model-selected actions inside an enforceable sandbox. The same canonical tools should work against:

- A local operating-system sandbox
- A local OCI container or VM
- A self-hosted remote worker
- A managed hosted worker

The sandbox enforces policy below the model, tools, extensions, and MCP servers. Missing required isolation must stop execution. It must never fall back to weaker isolation silently.

## 2. Key design choice

Sandboxing is an execution backend, not primarily a model-visible tool.

The model continues to call canonical tools such as `shell`, `read`, and `edit`. The user or session policy chooses placement:

```text
canonical tool call
  -> policy validation
  -> selected execution backend
       -> local OS sandbox
       -> local OCI sandbox
       -> remote hosted sandbox
  -> canonical tool result
  -> append result to session log
```

For hosted development sessions, move the whole session workspace and loop to the remote worker. Do not send every individual file operation across the network. This avoids stale workspace state, high latency, and ambiguous filesystem ownership.

A separate bounded `sandbox_job` capability may later run one disposable remote job. It is useful for tests, builds, untrusted package inspection, and conversion workers. It should not become a generic way for the model to choose arbitrary infrastructure or bypass session policy.

## 3. Current foundation

Axl currently provides:

- Bubblewrap per-command isolation on Linux
- Seatbelt per-command isolation on macOS
- Workspace-scoped writes
- Read-only access to most other host paths
- Protected Axl paths
- No network inside tool processes
- Cleared and allowlisted environments
- Canonical path and symlink checks
- Explicit `sandbox.configured` and `sandbox.violation` events
- Fail-closed startup when the required sandbox is unavailable

Before remote use, local isolation needs stronger read restrictions, egress controls, resource limits, and process supervision.

## 4. Common sandbox contract

All local and hosted backends implement one lifecycle:

```text
probe
create
prepareWorkspace
start
execute
attach
snapshot
stop
terminate
verifyTerminated
```

Each backend reports capabilities instead of claiming generic sandbox support:

```text
filesystem.readAllowlist
filesystem.writeAllowlist
network.egressPolicy
network.noDirectSockets
process.namespaces
process.seccomp
process.landlock
resources.cgroups
runtime.rootless
runtime.vmIsolation
secrets.brokered
termination.verified
```

A session policy states which capabilities are required. Backend selection fails when any required capability is unavailable.

The contract carries:

- Session, operation, and tool-call IDs
- Idempotency key
- Canonical tool name and validated input
- Policy digest and workspace revision
- Deadline and resource limits
- Credential-handle references, never raw managed credentials
- Result content, artifacts, usage, violations, and final workspace revision

Commands with uncertain side effects must not be retried automatically after a transport failure. The caller queries execution status by idempotency key first.

## 5. Local sandbox plan

### 5.1 Harden native per-command isolation

Linux:

- Keep Bubblewrap as the namespace and mount boundary.
- Change reads from host-wide read-only access to explicit read allowlists.
- Add Landlock for path restrictions on the process and descendants.
- Add a versioned seccomp allowlist.
- Add cgroups v2 CPU, memory, process, and I/O limits.
- Route DNS and egress through a policy proxy.
- Block local ports and Unix sockets unless granted.
- Supervise process groups and verify termination.

macOS:

- Keep Seatbelt with explicit read and write allowlists.
- Add process and resource supervision available through macOS facilities.
- Report that Seatbelt lacks Linux namespaces and seccomp.
- Require OCI or VM placement when policy needs stronger isolation.

Windows:

- Document WSL2 as the first strong path.
- Add restricted tokens, job objects, and ACL confinement later.
- Use local OCI or a VM when native controls cannot satisfy policy.

### 5.2 Add local OCI isolation

Detect Podman, Docker, and containerd through nerdctl. Prefer rootless Podman.

Default container policy:

- Image pinned to a platform-specific digest
- Read-only root filesystem
- Workspace as the only persistent writable mount
- Tmpfs for temporary files and injected secrets
- No host home mount
- All Linux capabilities dropped
- `noNewPrivileges`
- User namespaces
- Versioned seccomp profile
- Masked sensitive `/proc` and `/sys` paths
- No devices
- No published ports
- Cgroups v2 limits
- Egress only through the Axl proxy
- Signed image and provenance verification when policy requires it

Snapshots contain the workspace and canonical event log, not process memory.

### 5.3 Add stronger optional local runtimes

Report and support stronger isolation when installed:

- gVisor for a user-space kernel
- Kata Containers for a VM-backed container
- A full VM provider when required

A request for VM isolation must never run under an ordinary shared-kernel container.

## 6. Hosted and central sandbox plan

### 6.1 Components

```text
Axl client
  -> authoritative daemon
  -> hosted placement adapter
  -> sandbox control service
  -> ephemeral worker
       -> session loop
       -> workspace
       -> tools and extensions
       -> OCI or VM sandbox
```

For a hosted session, the authoritative loop runs on the worker. Clients attach through the normal Axl protocol. The local daemon coordinates placement and transfer but does not run a second loop.

The control service owns provisioning and cleanup. It does not make model decisions and does not become the canonical session log.

### 6.2 Worker lifecycle

```text
requested
-> provisioning
-> preparing
-> starting
-> running
-> draining
-> terminating
-> terminated
```

Failure is recorded separately. A failed termination must never be reported as terminated.

Every worker has:

- Session and owner tags
- Creation and expiry times
- Backend version
- Resource lease
- Policy digest
- Image digest
- Short-lived workload identity
- Dedicated workspace storage
- Dedicated network policy

### 6.3 Workspace transfer

At placement start:

1. Freeze the local workspace revision or create an isolated git worktree.
2. Build a content manifest with hashes.
3. Upload through the blob channel or clone using short-lived Git credentials.
4. Verify every transferred object on the worker.
5. Start the remote session against that fixed revision.

The workspace remains remote for the session. Results return as a verified snapshot, patch, branch, or pull request. Axl must not continuously copy individual file writes between local and hosted filesystems.

The product must decide whether transfer moves a session or forks it before implementation.

### 6.4 Network and secrets

- Workers receive no long-lived host credentials.
- Use workload identity where the provider supports it.
- Otherwise use short-lived, purpose-scoped credentials.
- Give tools opaque credential handles or sentinels.
- Substitute real credentials only in an egress broker after destination and scope checks.
- Route DNS and all network traffic through the policy proxy.
- Deny direct sockets that could bypass the proxy.
- Keep secrets out of images, snapshots, logs, tool results, and crash reports.

### 6.5 Cleanup and reconciliation

Termination sequence:

```text
stop new work
-> interrupt at a safe checkpoint
-> flush the canonical log
-> upload approved artifacts
-> stop processes
-> force kill after the grace period
-> delete compute and temporary storage
-> revoke credentials
-> verify resources are absent
```

An external reconciler deletes expired or orphaned resources even when the worker and daemon are unavailable. Cleanup is idempotent and verified against the provider API.

## 7. Remote sandbox as a tool

Provide two user-facing forms.

### Session placement

Recommended for normal hosted development:

```text
/placement hosted
```

The daemon creates or transfers a session to a hosted worker. All canonical tools then execute there without adding a new model-visible tool.

### Bounded sandbox job

Useful for disposable work:

```text
sandbox_job {
  source: workspace snapshot or selected files,
  command: approved command,
  image: approved digest,
  network: denied or explicit allowlist,
  limits: cpu, memory, time, output,
  artifacts: declared paths
}
```

The job receives no ambient credentials and cannot widen policy. It returns:

- Exit status
- Bounded stdout and stderr
- Resource usage
- Sandbox violations
- Declared artifacts by blob reference
- Image and policy digests
- Cleanup verification

Authority to use hosted compute comes from registry membership and user policy. Ordinary sessions do not receive this capability by default.

## 8. Delivery sequence

### Stage 0: contract and threat model

- Write an RFC for the sandbox backend and hosted placement contracts.
- Define capability reporting and policy matching in `packages/protocol`.
- Define assets, attackers, trust boundaries, and residual risks.
- Add a deterministic fake sandbox backend and conformance suite.

Exit: the same contract tests describe local and hosted lifecycle behavior.

### Stage 1: local policy hardening

- Implement explicit read and write allowlists.
- Complete Bubblewrap isolation.
- Add Landlock, seccomp, cgroups, socket, and egress controls.
- Improve Seatbelt policy and reporting.
- Add process supervision and verified termination.
- Extend `/doctor` with exact enforcement capabilities.

Exit: adversarial tests cannot read, write, connect, or survive outside policy.

### Stage 2: local OCI backend

- Detect rootless container engines and runtimes.
- Implement the common lifecycle.
- Generate hardened OCI runtime configuration.
- Add image digest, signature, SBOM, and provenance policy.
- Add workspace upload, snapshots, and artifact handling.
- Test gVisor or Kata capability reporting when available.

Exit: a Axl session runs in a disposable local container and cleanup is verified.

### Stage 3: remote execution foundation

- Make tool execution and session placement transport-neutral.
- Add authenticated worker registration.
- Add encrypted control connections.
- Add idempotency, status queries, deadlines, and heartbeats.
- Add resumable event and blob transfer.
- Run the fake backend through an unreliable transport simulator.

Exit: duplicate, delayed, dropped, and reordered messages do not duplicate execution or corrupt state.

### Stage 4: self-hosted single-node worker

- Run the control service and worker on a user-owned Linux host.
- Provision rootless OCI sandboxes.
- Add leases, quotas, logs, metrics, and reconciliation.
- Support hosted session placement and bounded sandbox jobs.

Exit: a local Axl client safely runs a session on another machine and verifies cleanup.

### Stage 5: first managed provider

- Select one cloud provider.
- Use its trusted provisioning APIs instead of model-authored CLI commands.
- Add workload identity, private networking, storage, and provider reconciliation.
- Add cost and resource ceilings.
- Perform an independent security review.

Exit: a hosted session survives client detachment, preserves its log, returns approved artifacts, and leaves no resources after termination.

### Stage 6: additional providers and stronger isolation

- Add providers only after the first contract is stable.
- Add Kubernetes and generic SSH workers as explicit adapters.
- Add gVisor, Kata, or VM-backed worker classes.
- Keep every unsupported capability failure explicit.

## 9. Required tests

- Symlink and mount escapes
- Read and write outside allowlists
- Direct network and DNS bypass
- Unix socket and local port access
- Environment and credential leakage
- Fork bombs and process escape
- CPU, memory, disk, output, and time exhaustion
- Worker loss during a command
- Daemon loss during workspace upload
- Duplicate execution requests
- Unknown execution status after disconnect
- Image digest and signature failures
- Snapshot tampering
- Cross-tenant workspace access
- Credential-scope violations
- Expired leases and orphan cleanup
- Graceful and forced termination verification
- Log redaction across local and hosted paths

## 10. Initial product boundary

Ship in this order:

1. Strong local Bubblewrap sandbox
2. Local rootless OCI sandbox
3. Self-hosted remote Linux worker
4. Bounded remote sandbox jobs
5. One managed hosted provider
6. Additional providers and native mobile control

Do not start with multiple cloud providers, WebRTC, process checkpointing, or a model-visible infrastructure manager.

## 11. Success criteria

The sandbox work is complete when:

- The same canonical tools run locally or hosted without changing model schemas.
- Required isolation fails closed.
- Local and hosted capabilities are reported accurately.
- No raw managed credential enters a sandbox.
- Every remote execution is authenticated, authorized, idempotent, bounded, and attributable.
- Workspace and artifact transfers are integrity checked.
- A hosted worker can be terminated and its absence verified.
- An external reconciler removes expired resources.
- The canonical redacted event log reconstructs what code, policy, image, and worker executed every action.
