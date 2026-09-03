<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/protocol`

This dependency-free package defines Axl's versioned JSONL events, model stream messages, and local wire protocol. The current wire format covers session creation, listing, paged history, resume, fork, clone, subscriptions, turns, steering, follow-ups, interruption, reload, live activity, abortable blob transport, workspace review, extension interactions, and model, thinking, and web-tool configuration. Runtime parsers validate every value received from an untrusted boundary.
