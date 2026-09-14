<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Axl Lounge architecture

Status: implemented terminal client feature

## Scope

Axl Lounge provides four offline terminal games: Wordle, 2048, Minesweeper, and Sudoku. The Lounge package contains deterministic game rules and semantic activity renderers. It uses only the public `terminal.activities` and `terminal.activity-storage` extension capabilities.

## Authority and ownership

The daemon remains the sole authority for sessions, canonical events, model work, queues, and mutations. Lounge games do not append canonical events, call the daemon, or alter a session. Protocol, SDK, kernel, daemon, runtime, AI, and sandbox authority are unchanged.

The TUI owns activity registration, layout, focus, attention priority, input decoding, mouse-coordinate translation, rendering, scheduling, the live Agent transcript and composer, and cleanup. Agent input continues through the existing editor, history, completion, attachment, Vim, queue, Ctrl+O, transcript, and submission paths. The CLI composes the Lounge extension and implements bounded local activity storage.

The Lounge package does not import the TUI, SDK, CLI, daemon, runtime, kernel, sandbox, AI, filesystem, networking, or private host internals. Disabled Lounge performs no registration, storage access, timer work, or background work.

## Public capabilities

`terminal.activities` registers semantic activities through a host-owned lifecycle. Activities receive bounded input, focus and visibility changes, rendering dimensions, a monotonic clock, and tracked scheduling. Every registration and callback has deterministic cleanup. The host validates mouse input and translates terminal coordinates before delivery. Game-specific input and rendering do not create TUI host branches.

`terminal.activity-storage` provides namespaced, size-bounded local records with compare-and-swap updates. The CLI canonicalizes and validates stored data, writes atomically, limits aggregate and per-record size, and performs bounded cleanup. Storage is client-local and never becomes session state.

## Layout, attention, and input

Compact terminals show one surface at a time. Wide terminals retain the normal live Agent transcript and composer on the left while the game or game library occupies the right. `Tab` changes pane focus when Agent-local completion does not own it. `Ctrl+P` opens the game library when multiple games are registered.

Canonical interaction requests and host overlays have priority over Lounge input. Agent editing retains its normal key paths. An activity receives input only while it is visible, eligible, and focused. Focus loss, undersize, suspension, replacement, and disposal cancel decorative work and pause active timers where applicable.

## Determinism, accessibility, and cleanup

Callers supply dates, seeds, clocks, and scheduled callbacks. Game engines do not read global randomness or the system clock. Saves are versioned and validated before use. Concurrent active Wordle boards use compare-and-swap and never merge implicitly.

Every game has a text-only semantic frame and non-color distinctions. Reduced-motion mode skips decorative timing. Keyboard navigation works with arrows and HJKL where applicable. Layouts preserve readable status and controls at supported compact, standard, and wide sizes.

Disabling or disposing Lounge removes registrations, listeners, timers, queued callbacks, and local host state. Games perform no networking and require no production dependency.

## Shipped games

- **Wordle:** reviewed offline dictionaries, duplicate-aware scoring, normal and hard modes, deterministic daily and practice selection, and six attempts.
- **2048:** deterministic spawning, one merge per tile per move, exact one-move undo, win continuation, and game-over detection.
- **Minesweeper:** delayed deterministic placement, safe first reveal and neighbors, three presets, flags, chords, viewport navigation, mouse input, and active-play timing.
- **Sudoku:** twelve versioned unique-solution puzzles, three difficulties, notes, conflicts, hints, undo, and a traditional grid with strong 3×3 separators.

Word data provenance and verification are documented in [`../../packages/extensions/lounge/data/codeword/README.md`](../../packages/extensions/lounge/data/codeword/README.md). Sudoku fixture generation is documented in [`../../packages/extensions/lounge/data/sudoku/README.md`](../../packages/extensions/lounge/data/sudoku/README.md).

## Verification

Run focused checks with:

```bash
pnpm --filter @axl/extension-api test
pnpm --filter @axl/extension-lounge test
pnpm --filter @axl/tui test
pnpm --filter @axl/cli test
pnpm --filter @axl/extension-lounge benchmark
pnpm --filter @axl/tui benchmark
pnpm check:generated
pnpm check:boundaries
reuse lint
```

Manual PTY review covers 40×24, 80×24, and 120×30 terminals. It checks responsive focus, the live wide Agent pane, keyboard and mouse behavior, reduced motion, text-only output, and cleanup. Sudoku review also covers movement, notes, hint confirmation, undo, and strong 3×3 separators.

## Deferred work

Chess puzzles, web UI game support, Productive mode, and Vibe mode remain deferred. They are not part of the implemented Lounge surface.
