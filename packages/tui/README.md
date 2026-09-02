<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/tui`

This package contains Axl's independently implemented interactive terminal client. Components produce lines, the differential renderer updates only the live tail, and completed output remains in normal terminal scrollback. The client does not use an alternate screen or curses library.

The TUI includes:

- Unicode-aware multiline editing, soft wrapping, paste handling, history, word movement, undo, and a kill ring
- Kitty keyboard support with fallbacks for older terminals
- Full-width searchable model, thinking-level, and theme selectors
- Model, thinking, and theme selectors with persistence delegated to the executable
- Model and thinking changes recorded by the daemon
- Queued follow-up prompts while a turn is running
- Markdown, syntax highlighting, bordered prompts, compact tool output, bounded shell output, and line-numbered diffs that switch between unified and split views
- A framed editor showing token use, cache rate, cost, context, model, effort, path, Git branch, and local throughput
- The built-in `dark` theme
- Responsive resizing, interruption, detach, reconnect, searchable session resume, fork, and clone
- Interactive Azure OpenAI setup with credentials shared across workspaces
- MCP approval, browser authorization, and structured-input dialogs

The TUI attaches to an injected daemon client. It does not construct providers, tools, extensions, sandboxing, the model loop, or canonical session state. The `@axl/cli` executable handles process startup, while `@axl/runtime` assembles the local backend.

Run `/help` inside the TUI for commands and keybindings.
