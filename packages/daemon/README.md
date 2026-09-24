<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 Srihari -->
<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-FileCopyrightText: 2026 VishnuM049 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/daemon`

The daemon owns sessions, agent loops, event logs, and active operations. Clients connect through a local Unix socket, load bounded history pages, and follow the live event stream. They do not keep their own copy of the agent loop.

The local wire protocol uses newline-delimited JSON and requires an exact `WIRE_PROTOCOL_VERSION` match. It currently supports daemon security and sandbox identity, session creation and profiles, listing, paged history, resume, fork, clone, manual compaction, daemon-owned steering and follow-ups, subscriptions, turns, interruption, reload, live activity, abortable blob transport, workspace review, model, thinking, and web-tool configuration, and user interactions requested by extensions. Phase 9 adds the full RPC surface and generated SDK.

Remote-authority infrastructure persists local device grants, intersects them with hosted narrowing grants, and enforces terminal revocation. An internal authenticated attachment maps an explicit RPC subset to `observe` or `steer` and reuses the existing dispatcher and durable command journal. `WindowsRemoteE2eeBridge` connects an injected native endpoint and a witness transport (`HostedDaemonWitnessTransport` in production) to this boundary: every endpoint mutation completes its witness barrier (`DaemonWitnessBarrier`) before the bridge parses plaintext, authorizes a request, frames a response, or acknowledges; it checks the hosted grant generation and encrypts daemon responses before opaque relay delivery. The bridge owns the endpoint's witness lifecycle: work is admitted only while the state is `ready`, `start()` reconciles first, `witness_unavailable` enters `recovering` (work refused, retries from 1 s doubling to a 30 s cap with bounded jitter, never abandoned), and `quarantined` or `revoked` are terminal. Each transition is one audit record in `RemoteDeviceAuthorityStore`, written before it takes effect; a failed write blocks the bridge. Pass the store as `remoteAuthority` to `AxlDaemon` so `daemon.info.remoteEndpoints` and `remote_endpoints_changed` report it. Production runtime construction remains disabled; local integration tests use the real OpenMLS binding with test-only key and rollback stores.
