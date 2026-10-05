<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-FileCopyrightText: 2026 PranavD2905 -->
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

## Mascot

The mascot (`/mascot`, off by default) picks the best drawing the terminal offers, in this order:

1. **Kitty graphics**, where Kitty graphics are detected or requested with `AXL_IMAGE_PROTOCOL=kitty`: real pixels, placed above the text, one placement per frame.
2. **Sixel**, where the terminal reports sixel in its device attributes (the `4` in its answer to `CSI c`, which the terminal session already asks for) and answers `CSI 16 t` with its cell size. The mascot asks for the cell size only when it is turned on, and waits up to 400 ms for the answers before drawing. The image is written into the text grid, four rows tall at the reported cell size, and each frame clears the strip and redraws it in one write.
3. **Text**, everywhere else: the half-block pack, 12 rows tall. It uses only `▀` and `▄`, which every monospace font has, with the colours set per character. Where the terminal has 24-bit colour (`COLORTERM=truecolor` or `24bit`, a `TERM` ending in `direct`, or Windows Terminal, Kitty, WezTerm, Ghostty, iTerm2 or VS Code recognised from their environment variables) the pack is drawn as built. Otherwise each colour is swapped once, at load, for the nearest of the 256 xterm colours, so terminals such as Apple Terminal draw it in colours they have instead of guessing.

Fullscreen always uses the text pack, because the application scrolls the transcript itself and an image cannot follow it. `AXL_IMAGE_PROTOCOL=none` turns the images off, so the mascot uses the text pack.

The text pack is 12 rows tall where the images are 4, cannot face the other way, and in 256 colours loses some shading. Those and the other known gaps, including the Windows Terminal leftover below, are listed under Limitations in `docs/mascot/ART.md`.

| Terminal | Mascot drawing | Verified |
| --- | --- | --- |
| Kitty | Kitty graphics | Kitty 0.32 under WSLg, every state |
| Ghostty, WezTerm | Kitty graphics | Not yet |
| Windows Terminal 1.22 or newer | Sixel | Windows Terminal 1.24 under WSL: draws and animates every state. Known issue: after the screen scrolls, a slice of an older frame can remain above the mascot |
| foot, Konsole, mlterm, Contour, xterm as a VT340 (`-ti vt340`) | Sixel, when the terminal reports it | Not yet |
| iTerm2 | Sixel if it reports it, otherwise text | Not yet |
| Windows Terminal before 1.22, VS Code, JetBrains, tmux, others | Text | Text pack in Windows Terminal 1.24 |
| Apple Terminal | Text in 256 colours | Recorded with a pseudo-terminal that answers like Apple Terminal, not on a Mac |

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

## Clipboard image paste

Ctrl plus V reads an image from the system clipboard when available, writes an exclusive owner-only temp file, and inserts its path into the draft. Submitting the path uploads the image through the daemon blob channel; no host `/tmp` access is granted to sandboxed tools. Removing the path from the draft omits the image. Temp files remain available for reuse and follow operating-system temp retention.

Wayland uses `wl-paste`; X11 uses `xclip`. macOS uses AppKit through `osascript`, and Windows or WSL uses PowerShell. Clipboard operations are time-bounded and images retain the 20 MiB attachment limit. Unsupported formats or unavailable helpers fail visibly instead of being treated as clipboard text. Text paste remains available when no image format is present.

Automated tests cover private temp files, validation, Linux command selection, text paste, editable draft paths, failed imports, and daemon blob delivery. Platform-specific live verification is still required for macOS, Windows, WSL, and X11. Explicit `/attach <path>` and dropped image paths remain available.

## Manual parity matrix

Record the terminal version, operating system, multiplexer, width, image mode, and result. Test regular and fullscreen modes, resizing, Ctrl+V, dropped images, links, mouse selection, suspend where supported, disconnect recovery, and terminal restoration.

| Environment | Text and resize | Keyboard | Mouse and links | Images | Cleanup | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Windows Terminal with WSL | Pending | Pending | Pending | Metadata | Pending | User test |
| Native Linux terminal | Pending | Pending | Pending | Capability dependent | Pending | User test |
| VS Code terminal | Not run yet | Not run yet | Not run yet | Metadata expected, not run yet | Not run yet | VS Code 1.134.0, zsh 5.9, macOS 26.5.2 arm64, no multiplexer, default image mode. Manual scenario not run yet, see #466 |
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
