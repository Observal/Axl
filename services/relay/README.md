<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Axl relay

This separately deployable Elixir/OTP service admits connections through the control plane and routes bounded opaque binary frames in memory. It has no E2EE, daemon RPC, canonical-event, account-database, or attachment-body dependency.

The first slice provides:

- one-use ticket admission through an injected control-plane client
- exact transport-v1 binary framing shared with TypeScript fixtures
- role-filtered route snapshots and updates without device-to-device enumeration
- installation-scoped `device <-> daemon` routing with same-identity replacement
- bounded per-route pending bytes and timed slow-consumer eviction
- WebSocket compression disabled and a 65,535-byte frame ceiling
- explicit inbound heartbeat deadlines, lease expiry, generation-bound revocation, and draining
- fail-closed admission and internal-authentication interfaces

Production control-plane origins, service authentication, TLS termination, and deployment configuration remain unselected. Tests use deterministic fake adapters.
