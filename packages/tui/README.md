<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/tui`

This package contains Axl's independently implemented interactive terminal client. Components produce lines, the differential renderer updates only the live tail, and completed output remains in normal terminal scrollback. Optional fullscreen mode uses the alternate screen, while regular mode does not. The client does not use a curses library.

Rendering shares one 16 ms queue for model updates, mouse input, spinner ticks, and resize
notifications. Keyboard input preempts that queue and coalesces within the current input burst.
Each paint reads current terminal dimensions. Fullscreen hit testing uses the last painted
layout; paused viewports retain per-call anchors while incoming content stays navigable.
Oversized docks keep the editor cursor visible, and regular-mode tool previews retain the
active tool header within the terminal's row budget. Full output remains in fullscreen and
`/export`.

Regular mode never clears native scrollback. Resize moves the old viewport into native history
and redraws only the current viewport at its new width. Explicit presentation changes reprint
the transcript. Earlier renderings can therefore remain in native history. Fullscreen repairs
only its alternate-screen viewport after resize or Ctrl+L.

The TUI includes:

- Unicode-aware multiline editing, selection, clipboard paste, searchable history, word movement, undo, a kill ring, and external-editor handoff
- Kitty keyboard support with fallbacks for older terminals
- Searchable command, model, thinking-level, theme, hotkey, and history selectors
- Atomic global preferences in `~/.axl/settings.json` for model, thinking, web-tool availability, theme, and terminal presentation
- Sandboxed `!command` passthrough, plus context-excluded `!!command` passthrough
- Model and thinking changes recorded by the daemon
- Daemon-owned steering with Enter and ordered follow-ups with Alt+Enter while a model turn runs; prompts entered during shell or compaction work wait locally
- GFM Markdown, broad language-aware syntax highlighting across code fences, file reads, edit/write previews, and workspace diffs, Unicode Mermaid diagrams, safe visible links, bordered prompts, retained tool transactions, bounded shell output, and line-numbered diffs that switch between unified and split views
- A framed editor showing token use, cache rate, cost, context, model, effort, path, Git branch, and local throughput
- Clean resize reconstruction, interruption, detach, daemon restart reconnect, searchable all-placement session resume with visible unsafe labels, fork, clone, and visible connection state
- Optional persistent fullscreen mode with a separated fixed dock, highlighted transcript search, prompt jumps, line, half-page, and page navigation, draggable scrollbars, mouse selection with verified copy, native mouse mode, and transcript or resume-hint exit output
- Opt-in focus-aware terminal bell and deterministic refocus recaps for questions, failures, changes, and completed turns
- Prompt stash and optional Vim insert or normal editing
- Favorite-first model selection and an optional wide developer panel
- Daemon-owned, checkpoint-backed working-tree and last-turn diff review with unified and split layouts
- Provider-neutral login dialogs supplied by the process host
- MCP approval, browser authorization, and structured-input dialogs
- Capability-scoped terminal extensions with commands, shortcuts, status, working labels, bounded widgets, lifecycle listeners, and safe tool renderers
- Global and project prompt templates that expand into an editable draft through `/prompt`
- Global and project JSON themes with bounded validation and live reload
- Sequenced live text and thinking output that reconciles to canonical history across reconnects
- Clipboard, dropped-file, and explicit-path image attachments through daemon-owned chunked blob transport
- Bounded Kitty and iTerm2 images in regular mode, with safe metadata in fullscreen and unsupported terminals

## User themes

Theme files live in `~/.axl/themes/*.json` or `.axl/themes/*.json`. The project file wins when both locations define the same ID. The ID must match the lowercase, hyphenated filename and cannot replace a built-in theme. Each theme inherits one built-in palette and overrides only the roles it needs:

```json
{
  "version": 1,
  "id": "violet-dusk",
  "label": "Violet Dusk",
  "appearance": "dark",
  "inherits": "axl-dark",
  "foregrounds": {
    "accent": "#a78bfa",
    "mdHeading": 141
  },
  "backgrounds": {
    "userMessage": "#211b2e",
    "toolBackground": "#17131f"
  },
  "pairs": {
    "selection": {
      "foreground": "#ffffff",
      "background": "#6d28d9"
    }
  },
  "thinking": {
    "high": "#f0abfc"
  }
}
```

A color is `"default"`, a `#RRGGBB` value, or an xterm 256-color integer from 0 through 255. `foregrounds` accepts `dim`, `accent`, `error`, `border`, `success`, `warning`, `text`, `diffAdded`, `diffRemoved`, `diffContext`, `mdHeading`, `mdCode`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdListBullet`, `syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, `syntaxPunctuation`, `keyword`, and `literal`. `backgrounds` accepts `userMessage`, `searchMatch`, `toolBackground`, `toolPendingBackground`, `toolSuccessBackground`, `toolErrorBackground`, `toolDeniedBackground`, `diffAddedBackground`, and `diffRemovedBackground`. `pairs` accepts `userMessage`, `selection`, and `searchCurrent`. `thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

Select a theme with `/theme <id>` or the `/theme` picker. Changes in existing theme directories reload automatically. An invalid edit leaves the active palette intact and displays the validation error. Use `/reload` after creating a theme directory while Axl is already running.

The TUI attaches to an injected daemon client. It does not construct providers, tools, extensions, sandboxing, the model loop, or canonical session state. The `@axl/cli` executable handles process startup, while `@axl/runtime` assembles the local backend. Startup displays an immediate progress line. Set `AXL_STARTUP_TIMING=1` to add a local phase breakdown after first paint when diagnosing a slow launch.

Terminal extensions declare capabilities before activation. Every registration returns a disposer, and `/reload` removes all extension-owned UI, listeners, and tracked work before activating a fresh instance. MCP and Agent Skills use the public tool-renderer registration. Renderer output is sanitized and bounded, and failures remain visible while the built-in generic renderer preserves the canonical tool transaction.

Consecutive tool calls form a compact group by default, showing call counts, status, and recent targets. Press Ctrl plus O to expand the calls with their inputs and results, or click a tool group in fullscreen mode to toggle only that group. Dragging still selects text. Oversized inputs show bounded beginning/end previews and their approximate character count; full mode increases the preview budget, while `/export` retains the complete input.

Run `/commands` for searchable actions, `/hotkeys` for keybindings, `/details` for compact, full, or focus transcript presentation, and `/settings` for persistent terminal preferences. `/prompt` browses reusable Markdown prompts from `~/.axl/prompts/` and `.axl/prompts/`; `/prompt <name> [arguments]` expands one into the editor, and `/reload` reloads template files. `/compact [instructions]` summarizes older context while retaining recent work and the complete JSONL history. `/export [directory]` writes a portable session artifact, and `/import <directory>` validates that artifact and opens it as a new session in the current workspace. `/stash` preserves or swaps a draft, `/favorite` manages model favorites, `/developer` toggles the wide workspace panel, `/vim` toggles Vim editing, and `/review` opens bounded workspace review. Workspace checkpoints remain off until review is enabled and can be disabled with `/review off`.

Ctrl plus V pastes an image or text. Images are saved to owner-only `axl-clipboard-<uuid>` files in the operating system's temporary directory, and their paths appear in the draft. On submission, intact standalone paths created by this client are uploaded through the daemon blob channel. Delete a path from the draft to omit that image. Temp files remain available for reuse until the operating system removes them; use `/attach <path>` to reuse one after restarting Axl. Clipboard reading uses `wl-paste` on Wayland, `xclip` on X11, AppKit through `osascript` on macOS, and PowerShell on Windows or WSL. Missing helpers and unsupported image formats produce visible errors.

During a model turn, Enter sends steering after the current complete tool-call batch and Alt plus Enter queues a follow-up after the turn would otherwise finish. Dropping image paths attaches them to the next prompt. `/attach <path>` provides an explicit keyboard flow, while `/attach clear` removes pending attachments and clears clipboard-path recognition. Image display can be set to auto, inline, or metadata in `/settings`. See `docs/terminal-compatibility.md` for capability overrides and the manual terminal matrix.

Fullscreen navigation uses Page Up and Page Down, Shift plus Page Up and Page Down for half pages, Alt plus Up and Down for lines, Home and End for transcript bounds, Ctrl plus Shift plus Up and Down for prompt jumps, and Ctrl plus F for search. Enter selects the next search match, Shift plus Enter selects the previous match, and Escape closes search. Mouse capture can be changed to native terminal selection in `/settings`.

Shift plus Enter depends on the terminal reporting a modified Enter sequence. Some Ubuntu terminal configurations send the same carriage-return byte for Shift plus Enter and Enter, which no terminal application can distinguish. `Ctrl+J` and backslash followed by Enter remain portable newline alternatives until terminal-specific setup guidance is completed.

Ctrl plus Backspace also depends on a distinct terminal sequence. When a terminal sends the ordinary Backspace byte for both keys, use Alt plus Backspace or Ctrl plus W for word deletion. Ordinary Backspace always remains single-grapheme deletion.
