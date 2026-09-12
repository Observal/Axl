<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Axl relay

This separately deployable Elixir/OTP service admits connections through the control plane and routes bounded opaque binary frames in memory. It has no E2EE, daemon RPC, canonical-event, account-database, or attachment-body dependency.

The first slice provides:

- one-use ticket admission through an injected control-plane client
- exact transport-v1 binary framing shared with TypeScript fixtures
- installation-scoped in-memory route registration
- bounded per-route pending bytes
- WebSocket compression disabled and a 65,535-byte frame ceiling
- heartbeat, idle, lease-expiry, revocation, and draining behavior
- fail-closed admission and internal-authentication interfaces

Production control-plane origins, service authentication, TLS termination, and deployment configuration remain unselected. Tests use deterministic fake adapters.
