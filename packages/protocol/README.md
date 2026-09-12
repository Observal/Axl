<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/protocol`

This dependency-free package defines Axl's versioned JSONL events, model stream messages, local wire protocol, and opaque remote-transport framing. The current local wire format covers session creation, listing, paged history, resume, fork, clone, rename, deletion, import, export, catalog invalidation, subscriptions, turns, steering, follow-ups, interruption, reload, live activity, abortable blob transport, workspace review, extension interactions, and model, thinking, and web-tool configuration. Remote transport contracts define routing identifiers, limits, tickets, receipts, delivery states, and bounded binary frames without defining or implementing cryptography. Runtime parsers validate every value received from an untrusted boundary.
