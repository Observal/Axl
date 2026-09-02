<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Changelog

This file records notable user-facing changes.

## Unreleased

### Added

- Repository, licensing, contribution, and CI foundations
- Release-branch tooling for channel releases, tracked backports, signed tags, npm publication, and GitHub Releases
- The public `@observal/axl` package, checksum-verifying installer, and CLI `--help` and `--version` output
- Explicit `--unsafe` startup mode with separate state, logged unenforced status, and a persistent terminal warning
- Dependency-free event and local wire protocols with runtime validation
- Crash-safe JSONL sessions, branch reconstruction, redaction, and deterministic replay
- Provider and credential contracts, thinking levels, tool dialects, a deterministic fake provider, and the full Pi-compatible Azure OpenAI model catalog
- An agent loop with shell, read, and edit tools, stable prompts, cancellation, and operation ownership
- An authoritative Unix-socket daemon with required operating-system sandboxing and resumable, forkable sessions
- A terminal client with multiline editing, resize-safe rendering, session metrics, rich tool output, syntax-highlighted line-numbered diffs, full-width selectors, global preferences, prompt queues, and reconnect support
- Agent Skills discovery, validation, progressive loading, and protected resource access
- MCP 2025-11-25 support over stdio and Streamable HTTP, including OAuth, tools, resources, prompts, completion, roots, sampling, elicitation, tasks, progress, cancellation, and logs

### Changed

- Local provider, tool, extension, and sandbox assembly now lives outside the terminal client, so clients remain replaceable projections over the daemon protocol.
- File tools now require explicit readable roots, and the default runtime limits them to the workspace.
- Bubblewrap masks the user's home directory while rebinding the authorized workspace.
- Shell cancellation now terminates the complete process group and refuses to start with an already-aborted signal.
