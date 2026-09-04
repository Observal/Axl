<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Changelog

This file records notable user-facing changes.

## Unreleased

### Added

- A session-scoped `exec` profile that exposes only sandboxed Bash and activates no Skills or MCP servers
- Repository, licensing, contribution, and CI foundations
- Release-branch tooling for channel releases, tracked backports, signed tags, npm publication, and GitHub Releases
- The public `@observal/axl` package, checksum-verifying installer, and CLI `--help` and `--version` output
- Explicit `--unsafe` startup mode with separate state, logged unenforced status, and a persistent terminal warning
- Linux Landlock and versioned seccomp enforcement with process and file resource limits
- Digest-pinned local OCI execution through rootless Podman or Docker, including verified cleanup
- `axl doctor` sandbox capability diagnostics
- Dependency-free event and local wire protocols with runtime validation
- Crash-safe JSONL sessions, branch reconstruction, redaction, and deterministic replay
- Provider and credential contracts, thinking levels, tool dialects, a deterministic fake provider, and the built-in Azure OpenAI model catalog
- An agent loop with `read`, `write`, `edit`, `bash`, `web_fetch`, and `web_search` tools, stable prompts, cancellation, and operation ownership
- Public-web fetching with redirect and response bounds, DNS pinning, private-address rejection, readable HTML extraction, keyless DuckDuckGo search, and optional Brave Search
- An authoritative Unix-socket daemon with required operating-system sandboxing and resumable, forkable sessions
- `axl -r` and `axl --resume` startup selection across native, OCI, and visibly labeled unsafe histories
- Manual `/compact [instructions]` context compaction with durable summaries, recent-context retention, and complete JSONL history
- Daemon-owned steering and ordered follow-up messages over the local wire protocol
- A terminal client with multiline editing, resize-safe rendering, session metrics, rich tool output, syntax-highlighted line-numbered diffs, full-width selectors, global preferences, prompt queues, and reconnect support
- Buffered terminal input and fail-closed terminal lifecycle handling for fragmented escape sequences, large pastes, redirected streams, and cleanup failures
- A retained responsive editor frame with rounded Axl styling and a compact borderless narrow-terminal layout
- Central retained overlay ownership for selectors, login, approvals, and structured forms
- Shared searchable picker behavior for model, thinking, and theme selection
- Standard prompt selection, clipboard, modified-Enter newline, interruption, and searchable hotkey controls
- Searchable command and prompt-history palettes, argument completion, and external-editor handoff
- Atomic persistence of the last model, thinking level, web-tool state, theme, tool-detail mode, thought-display mode, and fullscreen preferences
- Optional fullscreen transcript mode with a separated fixed editor dock, follow state, highlighted search with match counts, prompt jumps, line and page navigation, text selection, verified copy, draggable scrollbars, safe links, live mode switching, and configurable mouse and exit behavior
- Sandboxed `!command` passthrough and context-excluded `!!command` passthrough
- Live previews for versioned Axl Dark, Axl Light, Terminal System, High Contrast, ANSI, and No Color themes
- Retained tool transactions that combine each call and result into one compact status rail with duration, bounded output, specialized previews, and compact, full, or focus detail modes
- GFM Markdown rendering for nested and task lists, tables, strikethrough, links, quotes, rules, and fenced code
- Agent Skills discovery, validation, progressive loading, and protected resource access
- MCP 2025-11-25 support over stdio and Streamable HTTP, including OAuth, tools, resources, prompts, completion, roots, sampling, elicitation, tasks, progress, cancellation, and logs
- Optional prompt stash, Vim editing, favorite-first model selection, refocus recaps, a wide developer panel, and daemon-owned checkpoint diff review

### Changed

- Local provider, tool, extension, and sandbox assembly now lives outside the terminal client, so clients remain replaceable projections over the daemon protocol.
- File tools now require explicit readable roots, and the default runtime limits them to the workspace.
- The canonical command tool is named `bash`; historical `shell` calls remain replayable.
- The exact-match local wire protocol is version 7 for session profiles, manual compaction, steering, and follow-ups.
- Bubblewrap masks the user's home directory while rebinding the authorized workspace.
- Shell cancellation now terminates the complete process group and refuses to start with an already-aborted signal.

### Fixed

- `/detach` leaves daemon-owned work running, resumed turns accept new input, and resume lists place the most recently updated session first
- Client reconnect handling no longer races the SDK's mutation retry and leaves a resumed TUI without a live attachment
- Kitty keyboard negotiation no longer requests release events that can duplicate typed characters
- Terminal editor frames no longer accumulate when WSL emits rapid resize events while moving between displays
- Session startup and runtime rebuilds no longer flood the transcript with repeated model, sandbox, thinking, and tool-dialect rows
- Live terminal frames no longer emit trailing line feeds, preventing repeated updates from growing downward scrollback
- Prompt and selector controls no longer use unsupported glyphs that render as question marks
- Tool colors are clipped inside closed blocks, with consistent transcript spacing and response indentation
- Incremental builds avoid rebuilding every unchanged package, while independent session startup scans and Git metadata resolve concurrently
- Prompt spacing is limited to one blank row, prompt blocks are unlabeled, and theme changes no longer leave redundant notices
- Command suggestions use a readable labeled panel instead of a compressed inline hint
- Shell passthrough serializes queued prompts and responds to Escape interruption
- The prompt keeps a stable gap from active tool output and uses a distinct orbital activity indicator
- Fullscreen mouse reports are consumed before editor dispatch and every enabled mouse mode is disabled during exit, suspension, external editing, and mode changes
- Regular-mode resize and theme rebuilds preserve native terminal scrollback instead of clearing and reprinting settled history
- Slash suggestions support arrow-key selection and complete the highlighted action with Tab or Enter
- Fullscreen navigation accepts Linux, xterm, and Kitty event variants, uses a clear latest or paused header, and leaves space before the composer
- Active work renders as a prominent transcript activity row instead of crowding prompt metadata
- Assistant responses and tool transactions use distinct composition, semantic colors, and restrained lifecycle backgrounds
- Warm CLI startup loads lightweight client and model entry points, defers daemon and login modules, displays immediate startup feedback, and supports `AXL_STARTUP_TIMING=1` phase reporting
- Backspace deletes one grapheme, while Ctrl plus Backspace, Alt plus Backspace, and Ctrl plus W delete the previous word; Ctrl plus B and Ctrl plus F move by character
- Settings and theme pickers use aligned labels, restrained selection colors, and protected mouse input while fullscreen overlays are active
- Tool status surfaces place their vertical padding above the label and leave a clear gap before output
- Daemon disconnects now enter a visible reconnecting state, resume canonical history after restart, and preserve uncertain prompts for user review instead of resending them silently
- Optional focus-aware terminal-bell attention signals for questions, failures, and completed turns
- Interaction dialogs remain open when a daemon response fails, allowing the user to retry after reconnecting
- Session resume pages canonical history instead of sending an unbounded wire frame, reconstructs interleaved multi-tool turns correctly, and closes interrupted tool calls and interactions explicitly
- Reconnect retries remain a neutral in-progress state, wait longer for slow daemon startup, and force cursor-safe fullscreen redraws
- Failed attachment uploads can be aborted, stale upload files are removed before the next upload after daemon restart, and workspace checkpoints reject oversized trees before copying data
