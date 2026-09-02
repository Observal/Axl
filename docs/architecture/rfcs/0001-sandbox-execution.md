<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# RFC 0001: Local and hosted sandbox execution

Status: accepted for staged implementation

## Problem

Axl currently confines shell commands with Bubblewrap on Linux and Seatbelt on macOS. The bootstrap denies tool-process network access, limits writes to the workspace, masks Axl state, and fails when the platform sandbox is unavailable.

This is sufficient for the Phase 4 dogfood gate but not for third-party executable extensions, remote jobs, or hosted sessions. Current file tools may read any host path outside the protected Axl directory. Bubblewrap also exposes a read-only view of most host paths. There is no common lifecycle for OCI or hosted workers, no resource lease, and no verified remote cleanup.

## Decision

Axl will treat sandboxing as an execution backend below canonical tools.

The model continues to call canonical tools such as `shell`, `read`, and `edit`. Session placement and policy choose the execution backend. A provider-specific or remote tool schema does not replace canonical tool identity.

Axl will implement the work in this order:

1. Add explicit readable roots to the kernel path policy and use workspace-only reads by default.
2. Harden native operating-system confinement and process supervision.
3. Add a rootless local OCI backend.
4. Define the common backend lifecycle from working local consumers.
5. Add one self-hosted remote Linux worker.
6. Add bounded remote sandbox jobs.
7. Add one managed hosted provider after the contract proves itself.

A normal hosted development session moves the loop and workspace to the worker. Axl will not proxy every file operation to a remote filesystem. A separate bounded sandbox job may execute disposable tests, builds, package inspection, and adoption work.

Required isolation fails closed. A backend reports the controls it actually obtained. Policy may select only a backend that satisfies every required control.

## Local policy

The first hardening slice changes file-tool reads from host-wide access to explicit readable roots. The active workspace is the only readable root in the default runtime. Protected paths continue to override all grants. Writes remain limited to the workspace.

The Bubblewrap shell remains a separate enforcement surface. Until Landlock or an equivalent path boundary is active, its capability report must not claim a complete filesystem read allowlist. Masking the user home reduces exposure but does not replace Landlock.

## Hosted authority

Exactly one daemon owns a session loop. For local placement it is the local daemon. For hosted placement it is the daemon on the worker. A local coordinator may request placement and transfer state but must not run a competing loop.

The hosted control service provisions and destroys workers. It does not make model decisions and does not become the canonical event store.

Every remote execution carries session, operation, and tool-call identity, a policy digest, a deadline, and an idempotency key. A transport failure does not authorize automatic replay of a command with uncertain side effects. The caller queries status first.

## Workspace and results

A hosted session receives an integrity-checked workspace snapshot or a clone made with short-lived Git credentials. The workspace stays on the worker until the session stops or transfers. Results return as a verified snapshot, patch, branch, pull request, or declared artifact.

Large workspace data and artifacts use the blob channel. JSONL contains references and integrity metadata, not embedded payloads.

## Credentials and network

Workers receive workload identity or short-lived credentials. Sandboxed tools receive opaque credential handles or sentinels, never raw Axl-managed credentials. An egress broker substitutes credentials only after validating destination and scope.

DNS and network traffic must pass through the policy proxy. Direct sockets, local ports, and Unix sockets remain denied unless policy grants them.

## Cleanup

Hosted resources carry owner, session, creation, expiry, backend-version, policy, and image-digest metadata. Stop and terminate are idempotent. Termination is complete only after the provider confirms that compute, temporary storage, and temporary credentials are absent.

An external reconciler removes expired and orphaned resources without depending on the worker process.

## Alternatives rejected

### A model-visible remote shell as the primary interface

Rejected because it lets model behavior choose placement, duplicates canonical tool schemas, and encourages policy bypass. A bounded sandbox-job capability may be added only for a concrete first consumer.

### Proxy every tool call to a remote workspace

Rejected for normal development sessions because network latency, stale workspace revisions, partial failures, and ambiguous file ownership make correctness harder. Moving the session loop with the workspace gives one authority.

### Start with several cloud providers

Rejected. Axl will prove the lifecycle and cleanup contract with a self-hosted worker and one managed provider first.

### Treat containers as a complete security boundary

Rejected. Shared-kernel OCI runtimes, gVisor, Kata, and full VMs provide different isolation strengths. Axl reports the distinction and never substitutes a weaker class silently.

## Compatibility

The initial readable-root change is a deliberate pre-1.0 tightening of the public `WorkspacePolicy` contract. Callers must name readable roots explicitly. The default Axl runtime names only its workspace.

Future wire or event schema changes for hosted placement require their own compatibility notes before implementation.

## Security review

Kernel path policy, operating-system confinement, credential brokering, remote authentication, tenant isolation, and cleanup require independent review. The conformance suite must test duplicate requests, worker loss, path and mount escapes, network bypass, resource exhaustion, credential leakage, cross-tenant access, and orphan reconciliation.
