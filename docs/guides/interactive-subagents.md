<!-- SPDX-FileCopyrightText: 2026 Shaan Narendran -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Test interactive subagents

Interactive subagent panes project daemon-owned child sessions into tmux.

## Prerequisites

- Build Axl from the repository.
- Install tmux 3.x.
- Configure a model provider for Axl.
- Use a disposable branch or worktree when testing agents that may edit files.

## Start a clean test

```bash
cd /path/to/Axl
pnpm build
axl daemon stop 2>/dev/null || true
tmux kill-session -t axl-test 2>/dev/null || true
tmux new-session -s axl-test
```

Inside tmux, run:

```bash
cd /path/to/Axl
axl --subagent-panes tmux
```

## Recursive test prompt

Paste this prompt once:

```text
Test recursive subagent delegation. Do not edit files.

Spawn one subagent named lead-coordinator with this task:

Immediately spawn exactly two children:

1. architecture-reviewer
   Read ROADMAP.md, CODE_STRUCTURE.md, and
   docs/architecture/interactive-subagent-panes.md.
   Spawn exactly two children:
   - boundary-reviewer: inspect package and client boundaries.
   - lifecycle-reviewer: inspect child creation, interruption, result delivery,
     disposal, and restart behavior.
   Do not edit files. Wait for both results and synthesize them.

2. test-reviewer
   Review the current subagent tests.
   Spawn exactly one child:
   - coverage-reviewer: identify missing recursive delegation and pane lifecycle tests.
   Do not edit files. Wait for its result and synthesize it.

Wait for architecture-reviewer and test-reviewer to finish. Return one final
synthesis to the root.

Rules:
- Do not poll, sleep, or inspect session logs for completion.
- Do not create children other than those explicitly requested.
- Results must travel to the immediate parent first.
- Every parent must wait for its direct children before finishing.
- Report each child's findings and any unverified behavior.
```

Expected tree:

```text
root
└── lead-coordinator
    ├── architecture-reviewer
    │   ├── boundary-reviewer
    │   └── lifecycle-reviewer
    └── test-reviewer
        └── coverage-reviewer
```

## Expected behavior

- Every child is a separate daemon-owned session with its own JSONL transcript.
- Model-created children start with fresh context unless a user or SDK request explicitly selects forked history.
- tmux uses a tiled layout so larger trees use rows and columns.
- Results move to the immediate parent first.
- A parent remains active until its direct descendants finish and it synthesizes their results.
- Complete child output stays in the child transcript. The model-visible result sent upward is bounded.
- Completed and failed panes close from the leaves upward.
- Aborted panes remain available for inspection.
- `/subagents` displays an indented descendant tree.
- A coordinated daemon shutdown closes all verified Axl child panes and leaves unrelated panes alone.

## Controls

```text
Ctrl+B, arrow  Focus another tmux pane
Ctrl+B, O      Cycle panes
Escape         Return paused fullscreen history to the latest line
Ctrl+C         Clear a draft, or interrupt the active session tree
Ctrl+C again   Shut down through the trusted host
```

Useful commands:

```text
/subagents
/subagents focus <name>
/subagents send <name> <message>
/subagents interrupt <name>
/subagents dispose <name>
```

## Focused automated checks

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm check:boundaries
pnpm check:generated
node --test packages/daemon/test/child-session.test.ts
node --test packages/cli/test/tmux.test.ts
```

## Troubleshooting

### A child pane exits immediately

The pane is retained on unexpected process exit. Read its visible error. Verify that the client and daemon use the same wire version and that no old daemon owns the socket.

### A child shows an old error before its assignment

That indicates forked history. Model-created children use fresh history by default. Explicit fork requests retain parent history and label it as such.

### Panes become too narrow

Axl reapplies tmux's tiled layout after every spawn and close. Start Axl in a dedicated tmux window because this layout owns that window.

### Panes remain after an abrupt process kill

Coordinated shutdown cleans tagged panes. `kill -9`, a terminal crash, or a tmux server failure can bypass cleanup. Inspect and remove an abandoned test session with:

```bash
tmux kill-session -t axl-test
```
