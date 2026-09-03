<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/tui`

This package contains Axl's independently implemented interactive terminal client. Components produce lines, the differential renderer updates only the live tail, and completed output remains in normal terminal scrollback. Optional fullscreen mode uses the alternate screen, while regular mode does not. The client does not use a curses library.

The TUI includes:

- Unicode-aware multiline editing, selection, clipboard paste, searchable history, word movement, undo, a kill ring, and external-editor handoff
- Kitty keyboard support with fallbacks for older terminals
- Searchable command, model, thinking-level, theme, hotkey, and history selectors
- Atomic global preferences in `~/.axl/settings.json` for model, thinking, web-tool availability, theme, and terminal presentation
- Sandboxed `!command` passthrough, plus context-excluded `!!command` passthrough
- Model and thinking changes recorded by the daemon
- Queued follow-up prompts while a turn or manual context compaction is running
- GFM Markdown, syntax highlighting, Unicode Mermaid diagrams, safe visible links, bordered prompts, retained tool transactions, bounded shell output, and line-numbered diffs that switch between unified and split views
- A framed editor showing token use, cache rate, cost, context, model, effort, path, Git branch, and local throughput
- Clean resize reconstruction, interruption, detach, daemon restart reconnect, searchable all-placement session resume with visible unsafe labels, fork, clone, and visible connection state
- Optional persistent fullscreen mode with a separated fixed dock, highlighted transcript search, prompt jumps, line, half-page, and page navigation, draggable scrollbars, mouse selection with verified copy, native mouse mode, and transcript or resume-hint exit output
- Opt-in focus-aware terminal bell and deterministic refocus recaps for questions, failures, changes, and completed turns
- Prompt stash and optional Vim insert or normal editing
- Favorite-first model selection and an optional wide developer panel
- Daemon-owned, checkpoint-backed working-tree and last-turn diff review with unified and split layouts
- Interactive Azure OpenAI setup that preserves stored credentials when editing configuration
- MCP approval, browser authorization, and structured-input dialogs
- Capability-scoped terminal extensions with commands, shortcuts, status, working labels, bounded widgets, lifecycle listeners, and safe tool renderers
- Sequenced live text and thinking output that reconciles to canonical history across reconnects
- Dropped-file and explicit-path image attachments through daemon-owned chunked blob transport
- Bounded Kitty and iTerm2 images in regular mode, with safe metadata in fullscreen and unsupported terminals

The TUI attaches to an injected daemon client. It does not construct providers, tools, extensions, sandboxing, the model loop, or canonical session state. The `@axl/cli` executable handles process startup, while `@axl/runtime` assembles the local backend. Startup displays an immediate progress line. Set `AXL_STARTUP_TIMING=1` to add a local phase breakdown after first paint when diagnosing a slow launch.

Terminal extensions declare capabilities before activation. Every registration returns a disposer, and `/reload` removes all extension-owned UI, listeners, and tracked work before activating a fresh instance. MCP and Agent Skills use the public tool-renderer registration. Renderer output is sanitized and bounded, and failures remain visible while the built-in generic renderer preserves the canonical tool transaction.

Run `/commands` for searchable actions, `/hotkeys` for keybindings, `/details` for compact, full, or focus transcript presentation, and `/settings` for persistent terminal preferences. `/compact [instructions]` summarizes older context while retaining recent work and the complete JSONL history. `/stash` preserves or swaps a draft, `/favorite` manages model favorites, `/developer` toggles the wide workspace panel, `/vim` toggles Vim editing, and `/review` opens bounded workspace review. Workspace checkpoints remain off until review is enabled and can be disabled with `/review off`.

Ctrl plus V pastes text. Dropping image paths attaches them to the next prompt. `/attach <path>` provides an explicit keyboard flow, while `/attach clear` removes pending attachments. Clipboard image paste is deferred until its terminal-specific paths pass real-terminal verification. Image display can be set to auto, inline, or metadata in `/settings`. See `docs/terminal-compatibility.md` for capability overrides and the manual terminal matrix.

Fullscreen navigation uses Page Up and Page Down, Shift plus Page Up and Page Down for half pages, Alt plus Up and Down for lines, Home and End for transcript bounds, Ctrl plus Shift plus Up and Down for prompt jumps, and Ctrl plus F for search. Enter selects the next search match, Shift plus Enter selects the previous match, and Escape closes search. Mouse capture can be changed to native terminal selection in `/settings`.

Shift plus Enter depends on the terminal reporting a modified Enter sequence. Some Ubuntu terminal configurations send the same carriage-return byte for Shift plus Enter and Enter, which no terminal application can distinguish. `Ctrl+J` and backslash followed by Enter remain portable newline alternatives until terminal-specific setup guidance is completed.

Ctrl plus Backspace also depends on a distinct terminal sequence. When a terminal sends the ordinary Backspace byte for both keys, use Alt plus Backspace or Ctrl plus W for word deletion. Ordinary Backspace always remains single-grapheme deletion.
