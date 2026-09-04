<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Terminal compatibility matrix

Status: Slice 11 automated coverage complete. Manual terminal evidence is required before the final parity gate.

## Capability behavior

Axl detects only capabilities with reliable environment signals. Unknown terminals receive text, ordinary keyboard input, and metadata-only image output. A missing capability never changes session semantics.

Environment overrides:

- `AXL_IMAGE_PROTOCOL=kitty`: request Kitty graphics.
- `AXL_IMAGE_PROTOCOL=iterm2`: request iTerm2 inline images.
- `AXL_IMAGE_PROTOCOL=none`: force metadata-only images.
- `AXL_TUI_ESCAPE_TIMEOUT_MS=<milliseconds>`: tune lone Escape handling for delayed links.

Fullscreen suppresses inline image escape sequences and shows bounded metadata. This prevents an image placement from escaping or corrupting the application-owned viewport. Regular mode may use bounded inline images. Images larger than 2 MiB remain metadata-only. Attachments larger than 20 MiB are rejected before upload.

## Automated coverage

| Surface | Automated evidence |
| --- | --- |
| Fixed widths | Semantic virtual terminal at 40, 80, and 120 columns |
| Resize | Repeated width and height reconstruction without duplicate frames |
| Keyboard | Fragmented CSI, Kitty negotiation, modifyOtherKeys fallback, delayed Escape |
| Lifecycle | Exit, failure, suspend, resume, mouse cleanup, paste cleanup, autowrap restoration |
| Input safety | Oversized and unterminated controls, hostile ANSI, bounded paste |
| Unicode | Combining marks, emoji, CJK, Indic graphemes, mixed-direction text |
| Streaming | Ordered deltas, stale-frame rejection, final-event reconciliation, reconnect snapshots |
| Media | Chunked upload and read, digest verification, JSONL reference-only persistence, Kitty and iTerm2 encoding, metadata fallback |
| Performance | 100,000-event deterministic benchmark, 1,000 assistant messages, 1,000 settled tool calls, keystroke and delta p95 budgets |

Run the performance evidence with:

```bash
pnpm --filter @axl/tui benchmark
```

## Deferred clipboard image paste

Clipboard image paste is disabled. WSL dogfood did not verify a reliable terminal-independent path. Explicit `/attach <path>` and dropped image paths remain available. Revisit clipboard images only with real Windows Terminal, WSL, Wayland, X11, and macOS fixtures and visible failure reporting.

## Manual parity matrix

Record the terminal version, operating system, multiplexer, width, image mode, and result. Test regular and fullscreen modes, resizing, Ctrl+V, dropped images, links, mouse selection, suspend where supported, disconnect recovery, and terminal restoration.

| Environment | Text and resize | Keyboard | Mouse and links | Images | Cleanup | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Windows Terminal with WSL | Pending | Pending | Pending | Metadata | Pending | User test |
| Native Linux terminal | Pending | Pending | Pending | Capability dependent | Pending | User test |
| VS Code terminal | Pending | Pending | Pending | Metadata | Pending | User test |
| tmux on Linux | Pending | Pending | Pending | Metadata by default | Pending | User test |
| Kitty | Pending | Pending | Pending | Kitty | Pending | User test |
| Ghostty | Pending | Pending | Pending | Kitty | Pending | User test |
| WezTerm | Pending | Pending | Pending | Kitty | Pending | User test |
| iTerm2 | Pending | Pending | Pending | iTerm2 | Pending | User test |
| Apple Terminal | Pending | Pending | Pending | Metadata | Pending | User test |
| JetBrains terminal | Pending | Pending | Pending | Metadata | Pending | User test |
| SSH with delayed Escape | Pending | Pending | Pending | Metadata | Pending | User test |
| Termux | Pending | Pending | Pending | Metadata | Pending | User test |

### Manual scenario

1. Start a session in regular mode and send a multiline Unicode prompt.
2. Resize repeatedly between 40, 80, and 120 columns.
3. Confirm one composer, correct hardware cursor placement, and no duplicated transcript rows.
4. Confirm Ctrl plus V pastes ordinary text without delay or disappearing input.
5. Drop PNG, JPEG, GIF, and WebP paths. Confirm unsupported or oversized files fail visibly.
6. Disconnect the daemon during streaming. Confirm partial output disappears or resumes from the daemon snapshot, then converges to canonical history.
7. Enter fullscreen, scroll away from live output, search, select, copy, and return to latest.
8. Confirm fullscreen images use metadata and cannot overwrite the dock.
9. Exit normally, interrupt, suspend where supported, and force a startup failure. Confirm raw mode, cursor, mouse, paste, keyboard protocol, autowrap, and alternate screen are restored.
