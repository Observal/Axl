<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/protocol`

This dependency-free package defines Axl's versioned JSONL events, model stream messages, and local wire protocol. The current wire format covers session creation, listing, paged history, resume, fork, clone, rename, deletion, import, export, catalog invalidation, subscriptions, turns, steering, follow-ups, interruption, reload, live activity, abortable blob transport, workspace review, extension interactions, model configuration, and adoption operations. Adoption contracts use closed vocabularies, versioned identifiers, method-specific capabilities, bounded pages and summaries, blob references for large artifacts, and a resumable global operation feed. Runtime parsers validate every value received from an untrusted boundary.
