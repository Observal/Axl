<!-- SPDX-FileCopyrightText: 2026 Shaan Narendran -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Sub-daemon workers

Status: design note. Not implemented.

## Summary

Axl may use subordinate daemons for isolated or remote execution. The root daemon remains the canonical authority for the complete session tree. A sub-daemon receives a bounded lease and owns execution only within that lease.

A sub-daemon must not become a competing authority for the same session or workspace.

## Advantages

### Strong isolation

A sub-daemon can run in a separate process, container, VM, or remote host. A crash, memory leak, or unsafe extension affects a smaller part of the session tree.

### Reliable resource limits

The execution platform can enforce CPU, memory, process, network, and filesystem limits around one delegated subtree.

### Clear process termination

The root can revoke a lease and terminate the worker process group or container. This gives cancellation a stronger operating-system boundary than in-process cleanup alone.

### Remote placement

Sub-daemons can run beside remote repositories, specialized hardware, mobile build hosts, or cloud sandboxes without moving the root daemon.

### Independent backpressure

Each worker can have bounded provider concurrency, tool scheduling, event buffering, and memory use. A busy subtree does not need to block unrelated root sessions.

### Heterogeneous execution

Workers may use different operating systems, sandbox providers, model pools, or hardware capabilities under one typed delegation contract.

### Long-running autonomy

A remote worker can continue after a client disconnects and later submit a durable result to the root daemon.

## Disadvantages

### Distributed state

The root and worker can disagree after a network failure. Axl must reconcile accepted work, cancellation, completion, and retries without inventing a successful outcome.

### More difficult event ordering

Worker events and root decisions occur in separate logs. The root must authenticate, deduplicate, order, and acknowledge imported event ranges and results.

### Uncertain external effects

A worker may complete an external write and disconnect before reporting it. The root cannot safely retry unless the operation has its own idempotency contract.

### Workspace conflicts

Two daemons must never write to the same checkout. Workers require isolated worktrees, containers, remote checkouts, or immutable source snapshots. Returned patches must be generation checked before application.

### Larger security surface

Worker authentication, lease signing, scoped credentials, transport security, revocation, and remote sandbox verification become trust boundaries.

### Harder cleanup

The root must detect and recover orphan processes, containers, cloud jobs, stale leases, pending result envelopes, and unknown termination states.

### Version management

Root and worker protocol versions must be negotiated. An incompatible worker with active work cannot be replaced silently.

### Higher operational cost

Each worker duplicates process startup, runtime assembly, health reporting, logs, and resource supervision. This is usually unnecessary for ordinary local subagents.

### More complex debugging

One logical request may span root logs, worker logs, transport retries, workspace artifacts, and descendant workers. Replay requires preserving every lease and accepted result boundary.

## Required design constraints

- The root daemon owns the logical session tree, user authorization, aggregate budgets, and accepted results.
- Every worker receives an authenticated, expiring delegation lease.
- A descendant lease may only narrow its parent lease.
- Budget and descendant reservations are atomic.
- Workers use isolated workspaces.
- Result delivery is idempotent and acknowledged.
- Cancellation remains explicit when remote termination is unconfirmed.
- Required isolation fails closed.
- Credentials are scoped, short lived, referenced by identifier, and excluded from canonical logs.
- Clients continue to use the public child-session SDK. Worker placement remains a daemon concern.

## Recommendation

Use recursive sessions under one daemon for ordinary local interactive subagents.

Introduce sub-daemons first as lease-bound local worker processes when process isolation provides a measurable benefit. Prove crash recovery, duplicate delivery, cancellation, workspace conflict handling, and orphan cleanup with one root and one worker before adding OCI, SSH, cloud, or recursive remote workers.
