<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/protocol`

This dependency-free package defines Axl's versioned JSONL events, model stream messages, and local wire protocol. The current wire format covers session creation, listing, paged history, resume, fork, clone, rename, deletion, import, export, catalog invalidation, subscriptions, turns, steering, follow-ups, interruption, reload, live activity, abortable blob transport, workspace review, extension interactions, model configuration, and adoption operations. Adoption contracts use closed vocabularies, versioned identifiers, method-specific capabilities, bounded pages and summaries, blob references for large artifact inventories, and a resumable global operation feed. Operation, revision, and inspection details page a combined surfaces-then-diagnostics stream with explicit total counts and offsets. Source-disclosure manifests inline at most 100 file metadata entries and use a content-addressed metadata blob for larger inventories. Runtime parsers validate every value received from an untrusted boundary, including syntactically canonical absolute local source paths.

The package also owns the strict versioned `adoption.json` contract for immutable revisions. Its parser rejects unknown fields, unsafe paths and URIs, duplicate set members, inconsistent capability decisions, unacknowledged unsupported surfaces, unsupported primary surfaces, and source-lock/hash mismatches.
