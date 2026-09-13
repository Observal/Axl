<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Axl control plane

This separately deployable TypeScript service owns hosted control-plane mutations. The first slice implements authorized relay-ticket issuance, atomic one-use consumption, and the authenticated internal HTTP boundary used by the relay.

The service uses injected principal authentication, relay authentication, authorization, proof verification, clocks, and stores. Tests use deterministic in-memory implementations. No production identity provider, datastore, service-authentication scheme, or cryptographic proof is selected.

The service never logs or places tickets or internal credentials in URLs. Production assembly remains blocked until those deployment decisions receive owner approval.
