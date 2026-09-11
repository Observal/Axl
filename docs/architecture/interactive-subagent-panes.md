<!-- SPDX-FileCopyrightText: 2026 Shaan Narendran -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Interactive subagent panes

Status: design draft. Implementation is deferred to roadmap Phase 8.

## Purpose

Interactive subagent panes let a user create explicit child sessions and attach one terminal client to each child in tmux. tmux is the only multiplexer in the first implementation. The panes make parent and child relationships, assigned work, and child status visible. Each pane remains interactive.

This document uses **parent** and **child** rather than master and slave.

## Fit with the roadmap

The product contract already defines subagents as child sessions in `ROADMAP.md` sections 6 and 15.4. It also requires `/subagents` to be user-invoked and prohibits model-visible delegation in ordinary sessions by default.

The feature belongs in Phase 8 after the current immediate dogfood slice. It must not be implemented as a TUI-only process launcher. The daemon child-session contract, protocol RPC, SDK support, and canonical lifecycle events come first. Multiplexer panes are then a terminal projection over those child sessions.

A pane is not a subagent. A child is a daemon-owned session with its own JSONL log. A pane is one replaceable client attachment to that session. Closing a pane detaches its client and does not silently cancel or dispose the child. Interrupting or disposing a child uses daemon RPC. In the initial autonomous pane mode, a terminal child result closes the managed pane after the result reaches the parent; the child session and transcript remain durable.

## User experience

### Starting Axl

Pane projection is explicit:

```text
axl --subagent-panes auto
axl --subagent-panes tmux
axl --subagent-panes auto
axl --subagent-panes off
```

`off` is the default for the first slice. `auto` selects tmux only when the current terminal is inside a supported active tmux session. It does not pick an installed multiplexer that does not own the current terminal. Explicit `tmux` mode fails if tmux does not own the current terminal.

Diagnostics are available before starting a session:

```text
axl doctor

Interactive subagent panes
  tmux     installed 3.x, active session, available
  selected tmux
```

If pane projection was explicitly requested and no compatible active multiplexer exists, startup fails with a specific message and remediation. Axl does not silently open another terminal, start a multiplexer session, or replace pane mode with an unrelated UI.

### Creating children

The initial command surface is user-owned:

```text
/subagents
/subagents start reviewer --task "Review the current diff"
/subagents start tester --count 3 --task "Run one test area and report failures"
/subagents list
/subagents focus <child>
/subagents interrupt <child>
/subagents dispose <child>
```

The picker form asks for the agent definition or ad hoc prompt, model, thinking level, tools, history mode, placement, isolation, budget slice, and child count. Defaults are shown before creation. The first implementation supports fresh-context and forked-history native children. Model-created children use fresh context by default so inherited transcript failures are not presented as current child failures. Explicit user and SDK operations may still request forked history.

Ordinary sessions receive no child creation authority. Starting Axl with `--subagent-panes auto` or `--subagent-panes tmux` is an explicit user grant for that session tree. The daemon then includes model-visible `subagent` and `subagent_message` tools, allowing one natural-language request to create and coordinate several children asynchronously within configured limits. Without that startup grant, natural-language requests can only propose `/subagents`; they cannot create children.

When pane mode is off, `/subagents` still creates daemon-owned children and shows them in the session tree when that Phase 8 surface exists. `/subagents start ... --pane` requires a pane adapter and fails before child creation if none is available. This avoids creating an unexpected background child after a requested presentation action failed.

### Pane contents

Every child pane runs the normal Axl terminal client attached to the existing daemon and child session. It does not start another agent loop. A fixed relationship header shows:

```text
Child reviewer-1
Parent 01J...
Authority user
Task Review the current diff
State running
Budget $0.42 of parent $2.00
```

The parent pane shows descendants as an indented tree with task, model, state, elapsed time, and cost. Selecting a child focuses its pane when supported or opens its session view in the current client. Interrupting the parent from the TUI aborts active descendants as one session-tree operation; a second Ctrl+C detaches the client promptly.

Uniformity applies only to panes created in the current Axl-managed pane group. Axl must not resize unrelated user panes. The adapter gives managed panes the same launch command, title format, initial dimensions where supported, and relationship header. Reflow is bounded to the managed group. Exact geometry remains multiplexer-specific and is reported when unsupported.

## Architecture

### Protocol

`packages/protocol` owns typed, validated contracts for:

- child start, send, interrupt, status, wait, snapshot, resume, and dispose
- spawn authority and requested child capabilities
- fresh-context and forked-history creation
- parent ID, child ID, task label, agent definition, budget slice, placement, and policy narrowing
- attributed child results returned to the parent
- child lifecycle and relationship events
- capability identifiers for every public operation

The protocol must not contain tmux command details. Multiplexer state is presentation metadata, not canonical session truth.

A likely first RPC shape is one `child.start` request with a bounded list of child specifications and an idempotency key. The daemon returns child session IDs only after durable creation events have been appended. Exact schemas require the architecture discussion mandated for protocol changes.

### Kernel and daemon

`packages/kernel` owns the common child lifecycle and operation ownership. `packages/daemon` owns RPC enforcement, spawn-authority checks, child runtime creation, parent-child indexing, recovery, and disposal cascades.

Creation order is:

1. Validate authority, budget, placement, tools, and narrowed policy.
2. Reserve bounded child capacity under the parent.
3. Append the parent spawn-request event.
4. Create each child log and append its `session.created` relationship event.
5. Start the child operation.
6. Return child IDs to the requesting client.
7. Append attributed completion or failure results to the parent at a safe boundary.

The current `parentSessionId` field and fork or clone behavior provide part of the relationship model, but they are not the full child contract. A fork is not automatically a delegated child, and child authority, task, budget, result attribution, and lifecycle still need explicit contracts.

The daemon remains authoritative after all terminal clients detach. Restart recovery reconstructs the child tree from JSONL before accepting lifecycle mutations. Parent disposal disposes children. Parent client detachment does not. An explicitly granted child may create descendants through the same daemon. Descendant results are attributed to their immediate parent; that parent decides what synthesis travels farther up the tree. Transcripts remain separate at every level.

### SDK

`packages/sdk` exposes typed methods for every child RPC and one deterministic child-tree projection. It owns retries, idempotency, subscriptions, and reconnect behavior. It does not spawn processes or panes.

The projection lets every client show the same relationship and status. Web, mobile, IDE, and headless clients can use child sessions without knowing about terminal multiplexers.

### CLI process host

`packages/cli` owns local multiplexer detection and process execution because it is the trusted terminal process host. It injects a narrow presentation adapter into the TUI, similar to other host-supplied platform dialogs. The adapter may:

- report the selected multiplexer and supported presentation operations
- create a pane that runs a fixed Axl attach command
- focus a known managed pane
- close a known managed pane after explicit user intent
- reflow only the managed pane group when supported

The adapter may not create child sessions, infer spawn authority, append canonical events, or run an agent loop.

Commands are executed with `spawn(executable, argv)` and fixed argument construction. Session IDs, socket paths, pane IDs, titles, and executable paths are passed as arguments, not interpolated into shell source. Environment values and multiplexer output are untrusted and bounded before use.

The child launch command attaches to the same daemon, conceptually:

```text
axl <child-session-id> --socket <existing-socket>
```

The implementation must use the resolved current Axl executable and preserve the selected local placement. It must never accidentally start a daemon in a different state directory.

### TUI

`packages/tui` renders the child tree and invokes SDK operations. After `child.start` succeeds, it asks the injected presentation adapter to attach panes for the returned child IDs. Pane-launch failure is shown clearly and leaves the durable children visible and attachable. The UI then offers retry, attach in the current view, or explicit disposal.

This narrow post-creation failure differs from `--pane` preflight failure. Preflight prevents known unsupported requests. Runtime failures can still occur after durable child creation, so the TUI must not pretend the children were rolled back.

The TUI does not invoke tmux directly and does not maintain authoritative child status. Child pane attachments do not reapply client-local workspace-checkpoint preferences while their daemon-owned task is already active.

## Multiplexer detection

Detection has three distinct states: installed, active, and usable.

### tmux

The tmux adapter requires both `TMUX` and `TMUX_PANE`. It captures the server socket, session ID, window ID, and parent pane ID through `display-message`. Pane creation targets the captured server and window directly with `split-window -d -P`; focus and closure target the returned pane ID. Commands use fixed argument arrays rather than shell interpolation. Pane mutations are serialized so concurrent child starts cannot race multiplexer focus or placement.

### Selection

For the first release, `auto` selects tmux only when a supported active tmux session owns the current terminal. Explicit selection performs the same ownership and compatibility checks. Nested or ambiguous multiplexer ownership fails loudly rather than guessing.

## tmux pane operations

### Create

Use `split-window` with the captured server socket, window ID, working directory, and fixed child attach argv. Creation does not steal focus. Each pane receives a bounded `axl:<name>` title and a private `@axl_child_session` option containing its session ID.

### Inspect and reconcile

Use `display-message` and `list-panes` with explicit targets. Verify the pane ID, title, window, and child-session tag before focus or destructive cleanup. Pane IDs are ephemeral presentation handles and never enter canonical events.

### Focus

Use `select-pane -t <pane-id>` only after direct user intent such as `/subagents focus`. Automatic completion does not steal focus.

### Close

Use `kill-pane -t <pane-id>` only after ownership verification. Closing a pane detaches its client and does not dispose the durable child session. Coordinated daemon shutdown closes every verified tagged child pane in the captured window and never closes the parent or an untagged pane.

### Layout

Use `select-layout tiled` after every spawn and close. Pane mode treats the selected tmux window as an Axl-managed layout group, so users should use a dedicated window when unrelated panes must retain their geometry.

## Capacity, layout, and concurrency

"Any number" means any user-requested count within explicit limits. The first recursive slice allows four direct children per node, three descendant levels below the root, and twelve total descendants in one tree. A child inherits model-visible spawn authority only from an explicitly granted parent, and may narrow or drop it. The daemon also enforces parent budget, provider concurrency, sandbox capacity, and placement capacity. The multiplexer adapter enforces a separate managed-pane limit. Hitting any limit fails with the exact limiting resource.

Child sessions execute concurrently because each is independently owned by the daemon. Pane creation is presentation work and may be serialized to keep deterministic pane ordering. A failed pane does not alter another child's lifecycle.

Initial layout policy:

- tmux child panes are created in request order in the captured parent window
- tmux reapplies its `tiled` layout after every spawn and close so larger trees use both rows and columns instead of shrinking into narrow vertical strips
- selecting tmux pane mode therefore treats the current tmux window as the managed Axl group; users should start Axl in a dedicated window if unrelated panes must not be resized
- only verified Axl child pane IDs are tracked for focus and close

## Failure and security behavior

- Missing or inactive multiplexer: fail explicit pane requests before child creation.
- Unsupported tmux version or missing required command: report the failed capability probe and do not mutate panes.
- Session or tab changed after preflight: repeat ownership checks and fail instead of creating a pane in an unintended location.
- Pane process exits: report client detachment; keep the child running unless the user interrupts or disposes it.
- Child completes before pane attachment: attach to its retained transcript and terminal state.
- Parent pane exits: detach that client only. The daemon and children continue.
- Parent daemon shutdown: close every pane carrying a verified Axl child-session tag in the captured tmux window, then restore the tiled layout. Never close the parent or an untagged pane.
- Daemon restarts: rebuild the tree and allow panes to reconnect through normal SDK recovery.
- Duplicate client retry: child-start idempotency prevents duplicate children.
- Partial multi-child creation: return a durable per-child result and never hide created children. The final design should prefer an all-validated reservation before the first append.
- Policy narrowing failure or unavailable required isolation: create no child and fail closed.
- Pane command injection: avoid a shell, validate identifiers, bound text, and pass fixed argv.
- Untrusted titles and task labels: sanitize for terminal controls and multiplexer format syntax.
- Socket access: child panes use the existing local socket permissions. No credentials enter argv, titles, environment diagnostics, or canonical events.

## Delivery plan

### 0. Prerequisites

Complete the roadmap's immediate dogfood slice. Open the required architecture discussion before changing protocol, event formats, or kernel guarantees.

### 1. Daemon-owned child vertical slice

Implement one user-authorized native child with fresh context:

- protocol schemas and validation
- canonical relationship and lifecycle events
- daemon RPC and authority enforcement
- SDK methods and child-tree projection
- restart recovery, parent disposal, and explicit result attribution
- focused public-behavior tests

No multiplexer code belongs in this step.

### 2. Interactive child management

Add forked-history children, `send`, `interrupt`, `status`, `wait`, `resume`, and `dispose`. Add `/subagents` list, start, focus, interrupt, and dispose through SDK calls. Prove that ordinary model sessions still receive no delegation tool or prompt text.

### 3. tmux projection

Add the CLI-hosted tmux detector and adapter behind `--subagent-panes`. Spawn one child attachment, then bounded fan-out. Add `axl doctor` output and deterministic adapter tests using a fake executable. Run a manual real-tmux matrix before claiming support.

### 4. pi-like asynchronous interaction

Add immediate-return spawning, stable child names, parent-to-child messaging, child questions, automatic attributed result steering, autonomous auto-exit, and the live parent status widget. Multiple spawn calls accepted in one model tool batch start concurrently within daemon limits. This behavior remains explicitly enabled and contributes no model-visible delegation tools when disabled.

### 5. Uniform managed groups

Add managed-pane tagging, bounded group reflow, focus, pane titles, relationship headers, and parent tree status. Verify that unrelated panes are not resized or closed.

### 6. Broader child backends

After the tmux-native slice is stable, add persistent background, OCI, external-harness, remote, and workflow-managed children as required by Phase 8. Pane projection continues to attach through the same SDK regardless of multiplexer or child backend.

## Research basis

This design uses tmux's documented command contract rather than its internal implementation. The implementation relies on `display-message`, `list-panes`, `split-window`, `select-pane`, `kill-pane`, pane-local user options, and `select-layout tiled`. Commands use fixed argv and explicit server, window, and pane identifiers.

## Verification

Focused automated tests must prove:

- a user authority can create a child and an ordinary model session cannot
- every child has a separate log and durable parent relation
- append-before-derived-state ordering survives injected failures
- idempotent retries do not duplicate children or panes
- parent and child policy, budget, and placement validation fails closed
- child completion creates an attributed parent event without merging transcripts
- closing a client or pane does not cancel daemon-owned work
- parent disposal disposes descendants
- daemon restart reconstructs and resumes the child tree
- SDK projections converge across parent and child clients
- detection distinguishes installed, active, usable, ambiguous, and unsupported states
- generated multiplexer calls use fixed argv and reject hostile identifiers or titles
- partial pane-launch failures leave every durable child discoverable
- Axl never closes an unrelated pane, and tmux layout changes remain bounded to the explicitly selected parent window

Manual evidence for the initial release must cover supported tmux versions, regular and fullscreen TUI modes, nested SSH, detach and reattach, daemon restart, pane closure, fan-out, completion before attachment, tiled layout, and terminal cleanup.

## Decisions required before implementation

1. The exact protocol event and RPC names for the child contract.
2. Whether multi-child creation is one atomic logical request or a batch with durable partial results.
3. The initial limits are depth 3, four direct children per node, and twelve total descendants. A later configuration surface may only narrow these daemon defaults.
4. Whether pane mode should require a dedicated tmux window rather than reflowing the selected window.
5. The supported minimum tmux version based on real fixtures.
6. The first slice treats spawned panes as autonomous and closes the managed pane after the terminal child result reaches the parent. A later child-definition lifecycle policy can keep interactive panes open.
7. Whether `auto` remains opt-in after manual terminal evidence is complete.
