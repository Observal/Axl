<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 Srihari -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/daemon`

The daemon owns sessions, agent loops, event logs, and active operations. Clients connect through a local Unix socket, load bounded history pages, and follow the live event stream. They do not keep their own copy of the agent loop.

The local wire protocol uses newline-delimited JSON and requires an exact `WIRE_PROTOCOL_VERSION` match. It currently supports daemon security and sandbox identity, session creation and profiles, listing, paged history, resume, fork, clone, manual compaction, daemon-owned steering and follow-ups, subscriptions, turns, interruption, reload, live activity, abortable blob transport, workspace review, model, thinking, web-tool configuration, adoption discovery and inspection, and user interactions requested by extensions. Phase 9 adds the full RPC surface and generated SDK.

The daemon-owned adoption store publishes source, converted output, tests, overlays, verification evidence, and provenance as separate files in immutable revision directories. Every revision is checked against its strict versioned `adoption.json` manifest and aggregate source hashes. Registry updates use a generation check, an inter-process lock, durable atomic writes, and validated pointers to existing revisions. Startup removes abandoned staging trees and fails closed on malformed published revisions. Its immutable artifact cache supports verified offline acquisition and explicit quarantine.
