<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Local web client implementation tracker

Status: active local planning document

Branch base: `upstream/main` at `ea906d0`

Checklist convention: `[x]` means implemented or verified on this branch. `[ ]` means remaining work. Items marked **Deferred**, **Before stable release**, or **Blocked** are not part of the next active slice.

This file is the implementation checklist for the web rebuild branch.

## Scope

Build the local browser client described by `docs/architecture/web-client.md` without changing daemon authority.

This tracker covers:

- the static browser application
- the trusted `axl web` process host
- the authenticated loopback gateway
- browser SDK adapters and reusable controllers
- session, command, model, composer, workspace, and transcript interfaces
- packaging, browser tests, accessibility, and installed-artifact verification
- transport-neutral browser boundaries needed to reuse the application in another environment

This tracker stops at the reusable static browser boundary and local process host. Service-side connectivity and native applications are tracked elsewhere.

## Current repository state

The branch now contains the first complete local-session slice:

- `axl web [session-id]` launches an authenticated loopback gateway and packaged static client.
- The browser creates or resumes sessions, projects canonical history, follows live activity, sends prompts, interrupts work, reconnects, and switches sessions.
- Rich conversation, tool, syntax, diff, workspace-change, responsive, and persistent-layout presentation is implemented.
- The composer loads a cached daemon provider directory and configures provider-qualified model and thinking choices. A live `/reload` boundary invalidates that cache.
- Reusable theme, syntax, diff, and React conversation presentation lives in `packages/ui`.
- The SDK exhaustively classifies canonical events for presentation, and immutable projections expose compacted-event membership to every renderer.
- Ordinary session creation works. Staged Chat/Code creation, the remaining shared-command migration, paused-item requeue, presence presentation, and several hardening tests remain.

The previous PR #386 implementation was discarded when this branch was reset to `upstream/main`. Its tests and findings remain design evidence only.

## Progress snapshot

The visual foundation, ordinary local conversation path, provider authentication, and package/browser validation are complete. The web client is usable for ordinary new and resumed sessions, but this tracker is not complete.

Active remaining work:

1. Finish replacing the TUI static shared-command dispatcher with the SDK controller and remove duplicated browser command routing.
2. Add explicit paused-item requeue controls and browser presence presentation.
3. Add staged Chat/Code creation, including explicit workspace and tool-profile semantics.
4. Move the provider directory and remaining configuration sequencing into reusable SDK controllers.
5. Complete the unchecked security, cross-client, capability, and accessibility verification gates below.

Deferred work is labeled in place. It includes extension-driven command invalidation, `axl web --dev`, IndexedDB cursor persistence, localization, long-session React measurement, and pre-stable CLI flag renames.

## Active rendering completion scratchpad

Work in small vertical slices. Mark an item complete only after focused tests and the relevant package checks pass.

1. [x] Render assistant Markdown safely in the shared React conversation renderer. Raw HTML is displayed as text and unsafe links are not activated.
2. [x] Add specialized search, MCP, and workflow tool-card bodies while retaining the bounded generic fallback.
3. [x] Show complete structured tool input and useful result metadata in expanded tool cards.
4. [x] Add bounded SDK blob reads and production browser object URLs for message attachments.
5. [x] Retrieve preserved truncated output through daemon-owned blobs rather than exposing new host paths to browser code.
6. [x] Render actionable MCP interaction forms and approval prompts, with retryable typed `session.interaction.respond` submission.
7. [x] Keep permission history visible, but do not add response controls without a daemon permission-response contract.
8. [x] Keep paired queue, tool, and interaction events folded; expose bounded configuration and lifecycle history in the session usage panel.
9. [x] Run focused unit/browser checks, production build and asset verification, the Impeccable detector, then `pnpm check`.

## Active functional parity scratchpad

The normal local chat path is available. These items close the remaining gap between that path and the daemon capabilities expected by first-party clients.

### Shared command discovery

1. [x] Implement issue #389's capability-filtered daemon command catalog without adding a generic built-in `command.invoke` path.
2. [x] Add the reusable SDK command controller that validates, merges, searches, and maps catalog entries to existing typed RPCs or focused workflows.
3. [ ] Finish replacing the TUI static shared-command dispatcher with the SDK controller. Daemon-backed shared metadata and refresh are implemented; trusted-host and remaining workflow commands still need migration.
4. [x] Add the web command palette and slash discovery UI. It searches the effective daemon directory, explains unavailable commands, collects bounded arguments, and opens focused interfaces without duplicating command metadata.
5. [ ] **Deferred:** add dynamic catalog invalidation when daemon extension registration exists. Connection, reconnection, session replacement, explicit palette opening, and configuration changes already refresh the current static catalog.

### Prompt delivery

6. [x] Add draft-safe steer and follow-up submission through the shared SDK delivery workflow.
7. [ ] Finish daemon-owned queue controls. SDK queue-next, queue-last, automatic late-steer fallback, and paused outcomes are implemented; explicit paused-item requeue remains.
8. [x] Add atomic interrupt-and-deliver. It uses `session.interruptAndDeliver` and is never simulated with Stop followed by Send.
9. [x] Preserve drafts on rejection or uncertain transport outcomes and present accepted, completed, queued, paused, interrupted, failed, and uncertain states accurately.

### Attachments and direct operations

10. [x] Add browser attachment selection, bounded chunked blob upload, abort, retry, progress, and prompt-reference insertion. Bytes and object URLs remain out of durable browser storage.
11. [x] Add manual compaction with optional instructions, progress, cancellation, and failure recovery.
12. [x] Add direct shell invocation with explicit uncertain-outcome handling and no automatic replay.

### Session lifecycle and artifacts

13. [x] Add session clone and canonical rename workflows.
14. [x] Add explicit delete and dispose flows with clear durable-history consequences.
15. [x] Add bounded import and export through authenticated trusted-host artifact handoff and browser download/upload.
16. [x] Refresh session metadata after lifecycle changes from another attached client.

### Workspace authority

17. [x] Add capability-gated workspace list and read interfaces using daemon generation checks.
18. [x] Add checkpoint enablement and inspection without exposing browser filesystem authority.

### Provider credentials

19. [x] Complete issue #372's trusted-process-host credential interaction contract.
20. [x] Add provider login and reauthentication UI only after the trusted host can collect secrets without exposing them to browser JavaScript, storage, URLs, logs, or canonical events.

### Validation completed for the implemented scope

21. [x] Run focused workflow and failure-path tests, then desktop and mobile browser smoke tests against the installed production package.
22. [x] Run installed-package verification, the Impeccable detector, `pnpm check`, and an authorized real-provider browser smoke test. The smoke used Azure OpenAI Responses and returned the expected exact response without exposing credentials to browser JavaScript.

## CLI contract

- [x] Bare `axl` launches the TUI.
- [x] `axl <session-id>` opens that session in the TUI.
- [x] `axl web` starts the local gateway and opens the browser without importing or launching the TUI.
- [x] `axl web <session-id>` opens that session in the browser without launching the TUI.
- [x] `axl web --no-open` starts the gateway and prints the safe token-free origin.
- [ ] **Deferred:** `axl web --dev` uses the explicit same-origin development proxy.
- [ ] **Before stable release:** rename the ambiguous model-tool flags `--web` and `--no-web` to `--web-tools` and `--no-web-tools`. Keep `--web-search` and `--web-fetch` explicit.
- [x] Make command parsing distinguish the `web` subcommand from session IDs before any daemon or TUI startup work.
- [x] Keep gateway shutdown distinct from browser detach, operation interrupt, session disposal, and daemon shutdown.

## Architecture decision

Retain:

- the authoritative daemon and canonical JSONL log
- the typed protocol and generic SDK request path
- idempotent mutation handling
- paged snapshot, cursor, subscription, presence, and reconnect behavior
- the deterministic SDK projector
- bounded workspace and blob RPCs
- provider inventory and daemon-owned runtime composition

Build or replace:

- the browser package
- the browser WebSocket transport adapter
- the trusted loopback gateway
- the web application shell and command layer
- reusable SDK controllers missing above raw RPC
- static-asset build, verification, and packaging

The browser must never implement an agent loop, canonical event reducer, prompt queue, workspace policy, provider behavior, tool execution, or daemon lifecycle authority.

## Static application and bootstrap

The web client is a static single-page application. It has no server-side rendering dependency.

- [x] Build production HTML with no inline scripts or styles.
- [x] Emit content-hashed JavaScript and CSS.
- [x] Emit validated metadata containing package, source, web-asset, and wire versions plus asset hashes.
- [x] Load a small validated bootstrap document before constructing application state.
- [x] Have bootstrap supply an initialized SDK transport and only the trusted host operations available in the current environment.
- [x] Keep React code independent of loopback hostname, selected port, cookie format, process path prefix, and Unix socket details.
- [x] Do not let React launch or stop a process, acquire credentials, or infer authority from its environment name.
- [x] Drive controls from granted protocol capabilities and injected host operations.
- [x] Keep browser preferences independent of the gateway's random origin where persistence across launches is required.
- [ ] **Deferred:** add an IndexedDB cursor-store adapter. Cursor-store failure must remain visible and fall back to a fresh snapshot.
- [x] Avoid a service worker initially. Entry documents use `no-store`; hashed assets may be immutable.
- [ ] Add tracked tests for the fake environment adapter so presentation behavior is not verified only by ignored local preview fixtures.

## Trusted local gateway

- [x] Validate production asset metadata and hashes before listening.
- [x] Connect to or start the selected daemon through CLI process-host code.
- [x] Bind only one canonical loopback IP origin on an OS-assigned port.
- [x] Validate exact `Host` and `Origin` values.
- [x] Create a 256-bit, one-use, 60-second launch token.
- [x] Pass the launch token only in the URL fragment.
- [x] Remove the fragment before application startup.
- [x] Exchange it for a process-scoped HttpOnly, host-only, path-scoped, SameSite Strict cookie.
- [x] Require cookie, exact origin, exact host, and random process path for each WebSocket upgrade.
- [x] Keep browser credentials out of JavaScript, URLs, persistent storage, and logs.
- [x] Apply CSP, frame denial, nosniff, no-referrer, no-store, and cross-origin isolation headers.
- [ ] Finish gateway bounds. Request bodies, WebSocket frames, assembled daemon messages, message rate, buffered output, artifact size, and attachment count are bounded; HTTP handshake/request timeouts and remaining queue bounds still need explicit coverage.
- [x] Reject binary frames and disable compression.
- [x] Evict a slow browser attachment without blocking another attachment.
- [x] Open one independent daemon connection per browser attachment.
- [x] Stop only gateway attachments when the gateway exits. Leave daemon sessions and accepted work running.
- [ ] **Deferred with `axl web --dev`:** keep development browser traffic on the authenticated gateway origin while proxying only approved Vite paths.

## Shared human-command plane

Architecture: `docs/architecture/human-command-plane.md`

Tracking issue: [#389](https://github.com/Observal/Axl/issues/389)

Do not recreate separate hardcoded TUI and browser command tables.

- [x] Add a daemon-owned, session-aware registry for shared first-party commands. Extension-contributed commands remain deferred until daemon extension registration exists.
- [x] Add typed protocol discovery and SDK execution over existing typed RPC operations.
- [x] Include command name, description, aliases, input hint, input requirement, capability requirements, and current availability.
- [ ] Publish command-catalog invalidation when session composition or extension registration changes. Clients currently refresh on connection, reconnection, session replacement, explicit palette opening, and configuration changes.
- [x] Execute commands against the exact target session without converting them into model messages.
- [x] Preserve typed structured failures and cancellation through the underlying RPC operations.
- [x] Record command effects through the canonical events emitted by their typed operations rather than a generic invocation event.
- [x] Let clients merge honest presentation-only commands into the shared directory.
- [x] Keep terminal-only mechanics local to the TUI and define browser-native semantics where a command is shared.
- [ ] Delete duplicated browser command routing after the remaining migration.

This is a protocol and ownership change and requires architecture review before implementation.

## Reusable SDK controllers

`RpcMethodMap` types the current RPC surface, but the generic request method is not enough for consistent first-party clients.

- [x] Add command discovery, execution, explicit refresh, and typed outcome projection.
- [ ] Add event-driven command-catalog invalidation when daemon extension registration exists.
- [ ] Move the provider directory into the SDK with observable loading, ready, partial-failure, refresh, auth-change, reconnect, and disposal states. The current web-owned directory preserves partial results and supports explicit refresh.
- [ ] Add staged new-session intent shared by direct controls and slash commands.
- [ ] Add session-configuration mutation ordering, optimistic intent, effective values, and field-scoped failures.
- [x] Add attachment upload, abort, retry, and retrieval helpers over blob RPCs.
- [x] Add high-level steer, follow-up, interrupt, and interrupt-and-deliver methods with draft-safe semantics.
- [x] Keep direct shell's explicit uncertain-outcome behavior.
- [ ] Move remaining reusable provider and configuration behavior out of the React shell.
- [x] Keep SDK caches disposable and daemon state authoritative.

## Staged new-session composition

Use one client-local staged object before `session.create`:

```text
mode
workspace
provider/model
thinking
request settings
web tool configuration
```

- [ ] Chat creation requires no workspace and sends no model-visible tools.
- [ ] Code creation requires an explicit resolved workspace.
- [ ] Direct controls and slash commands update the same staged object.
- [ ] Submit staged intent atomically through `session.create`.
- [ ] Preserve daemon defaults for fields the user did not explicitly select.
- [ ] Render a running session's exact profile as identity rather than a lossy Chat/Code toggle.
- [ ] Never display `minimal` or `exec` as mutable `standard` Code.
- [ ] Keep workspace navigation absent from Chat.

## Model and thinking selection

- [x] Use provider-qualified `{ providerId, modelId }` identity throughout.
- [x] Load one provider/model directory for the active daemon generation.
- [ ] Share one focused picker between `/model`, composer controls, and new-session creation. The composer picker is implemented.
- [ ] Group searchable model rows by provider.
- [x] Show provider-local errors without erasing usable providers.
- [ ] Disable unavailable models and explain why. Unavailable models are currently omitted.
- [x] Reject ambiguous bare model IDs.
- [x] Derive thinking choices from the selected model's supported levels.
- [x] Preserve the daemon thinking default until the user explicitly changes it.
- [ ] Stage model and thinking choices before creation and configure them after creation.
- [x] Show effective clamped thinking values.
- [x] Keep model and thinking controls out of generic Web settings.

## Honest Search and Fetch controls

- [ ] Render controls only when the selected profile can expose those tools.
- [ ] Never render them in Chat.
- [ ] Label them as configuration, not immediate tool actions.
- [ ] Show explicit enabled and disabled state derived from canonical effective configuration.
- [ ] Show runtime rebuild progress and field-scoped failure.
- [x] Remove fake Plan and Web buttons that only open Settings.
- [ ] Add deterministic browser coverage for enabling, disabling, invocation, tool-card rendering, and results.

## Active-turn input semantics

Expose four distinct actions:

- [x] **Steer:** default active-turn input delivered at the next safe model boundary.
- [x] **Follow-up:** explicit next-turn delivery after current work completes.
- [x] **Interrupt:** stop active work without replacement input.
- [x] **Interrupt and deliver:** atomically stop and deliver replacement input.

Also:

- [x] Keep ordinary send, steer, follow-up, queued delivery, and interrupt-and-deliver as distinct operations.
- [x] Preserve drafts across failed send, queue, steer, follow-up, and interrupt-and-deliver calls.
- [x] Show accepted, delivered, queued, paused, rejected, interrupted, and uncertain outcomes accurately.
- [x] Never simulate atomic interrupt-and-deliver with Stop followed by Send.

## Slash-command coverage

The browser command interface must use the shared live command directory.

| Command | Browser requirement |
| --- | --- |
| `/model` | Focused model picker with staged and live selection. |
| `/thinking` | Model-aware effort picker with staged and live selection. |
| `/theme` | Focused browser theme picker. |
| `/settings` | Browser preferences only after focused runtime controls move out. |
| `/details` | Compact, full, and focused transcript detail modes. |
| `/fullscreen` | Browser fullscreen or focus layout. |
| `/regular` | Restore the ordinary layout. |
| `/providers` | Provider and catalog status surface. |
| `/login` | Trusted-process-host credential interaction. |
| `/logout` | Provider logout with explicit consequences. |
| `/refresh` | Refresh one provider or all dynamic catalogs. |
| `/reload` | Daemon-owned runtime reload with visible state. |
| `/compact` | Optional instructions, progress, cancellation, and failure. |
| `/status` | Inspectable synchronized status surface. |
| `/usage` | Session token, cache-hit, cost, and throughput summary. |
| `/requeue` | Paused-item selection instead of an opaque required ID. |
| `/resume` | Searchable session picker and exact-ID support. |
| `/fork` | Selected-message and earlier-user-message selection. |
| `/clone` | Full-session clone. |
| `/import` | Reviewed browser upload or trusted-host artifact selection. |
| `/export` | Browser download or trusted-host destination flow. |
| `/stash` | Browser-local draft semantics with explicit persistence scope. |
| `/favorite` | Integrate with the model picker and preference storage. |
| `/developer` | Browser diagnostics surface. |
| `/review` | Working, last-turn, and off state with message-level entry. |
| `/attach` | Upload, paste, drop, validation, preview, retry, and removal. |
| `/vim` | Actual browser editor mode or explicit unavailability. |
| `/commands` | Live shared command directory plus browser-local commands. |
| `/history` | Searchable prompt history with draft-safe selection. |
| `/edit` | Defined browser editor semantics without claiming terminal `$EDITOR`. |
| `/hotkeys` | Help generated from the actual browser keymap. |
| `/help` | Complete command and shortcut directory. |
| `/detach` | Detach this browser attachment only. |
| `/web` | Display current local browser attachment information without starting another loop. |
| `/request` | Edit output-token and HTTP idle limits. |
| `/quit` | Trusted-host shutdown flow or explicit detach wording, never silent conflation. |

Additional input forms:

- [x] `!command` executes through `session.shell` and includes output in model context.
- [x] `!!command` executes through `session.shell` and excludes output from model context.
- [x] Shell uncertainty is visible and never automatically retried.
- [x] Choosing an argument-requiring command enters argument mode instead of executing malformed input.

## Protocol capability adoption

The browser should support every capability granted to its connection.

### Session lifecycle and delivery

- [x] `session.create`
- [x] `session.list`
- [x] `session.resume`
- [x] `session.fork`
- [x] `session.clone`
- [x] `session.rename`
- [x] `session.delete`
- [x] `session.export`
- [x] `session.import`
- [x] `session.send.prompt`
- [x] `session.steer`
- [x] `session.follow_up`
- [x] `session.interrupt_deliver`
- [x] `session.queue.enqueue`
- [ ] `session.queue.requeue`
- [x] `session.interrupt`
- [x] `session.dispose`

### Runtime and interaction

- [x] `session.compact`
- [x] `session.shell`
- [x] `session.reload`
- [x] `session.configure`
- [x] `session.interaction.respond` for explicit MCP interactions, not routine sandboxed tool approval
- [x] `session.subscribe`
- [x] `session.activity`
- [ ] `session.presence`

### Blobs and workspace

- [x] `session.blob.start`
- [x] `session.blob.chunk`
- [x] `session.blob.commit`
- [x] `session.blob.abort`
- [x] `session.blob.read`
- [x] `session.workspace.list`
- [x] `session.workspace.read`
- [x] `session.workspace.status`
- [x] `session.workspace.diff`
- [x] `session.workspace.checkpoint`

### Providers

- [x] `provider.list`
- [x] `provider.catalog.refresh`
- [x] `provider.auth.status`
- [x] `provider.auth.login` is intentionally declined by the browser attachment; login uses the typed trusted-host operation instead.
- [x] `provider.auth.logout`

Do not request a capability before its interaction, error behavior, and security boundary are implemented. Missing capability UI must fail explicitly rather than provide a local fallback.

## Provider management

- [ ] Add `/providers` with provider, authentication, catalog, region, enabled, and model availability state. The web provider status surface covers authentication, catalog, enabled state, and model counts; shared command routing and region detail remain.
- [x] Refresh inventory after login, logout, catalog refresh, settings changes, and reconnect.
- [ ] Add per-provider catalog-refresh cancellation. Web already shows bounded refresh progress, results, and retry; trusted-host login has correlated cancellation.
- [x] Preserve usable provider groups when one provider fails.
- [x] Present errors beside the owning provider.
- [x] Acquire credentials only through an injected trusted-process-host interaction.
- [x] Keep credential values out of React, browser storage, URLs, logs, and canonical events.

## Conversation and workspace presentation

- [x] Render projected user, assistant, thinking, error, compaction, and interruption records.
- [x] Classify every canonical event through one exhaustive SDK presentation contract so new event types require an explicit rendering policy.
- [x] Hide compacted transcript records while retaining canonical history, and expose the retained summary through an expandable shared React renderer.
- [x] Render shell, read, edit, search, fetch, MCP, workflow, and bounded generic tool cards.
- [x] Show complete structured tool inputs and useful result metadata when expanded.
- [x] Provide a bounded route to inspect truncated tool output stored as a session-owned blob.
- [x] Render image attachments as media and support browser upload through daemon-owned blob references.
- [x] Show a clear incomplete-response warning for `stopReason: "length"`.
- [x] Attribute cost to the provider, model, and thinking level that produced each usage record.
- [x] Distinguish unknown cost from zero cost.
- [x] Show per-turn cache-hit rate and throughput, collapsed by default.
- [x] Add an inspectable whole-session usage summary in web and `/usage` in the TUI.
- [x] Add transcript search and prompt navigation.
- [x] Add message copy and fork actions. Do not add response ratings without a daemon-owned feedback contract and a real consumer.
- [x] Clear conversation, workspace, queue, dialog, and selection state before loading another session.
- [x] Keep generation checks for implemented workspace status and diff views.
- [ ] **Deferred until profiling is needed:** measure long-session React rendering before adding optimization abstractions. The SDK projector already has a 100,000-event bounded-history test.

## Browser state and settings

- [x] Separate browser preferences from session configuration and trusted host actions.
- [x] Define durable preference storage that survives random local gateway ports without placing authority credentials in application storage.
- [x] Expose browser-owned layout and change-review preferences through a focused Web settings surface.
- [x] Refresh session catalog metadata after another client changes it.
- [ ] **Deferred until a second locale:** replace hardcoded English copy with a typed localization owner.
- [ ] Show errors inside the dialog or picker that initiated the action.
- [ ] Keep disabled features absent from menus, empty states, prompts, and background work.
- [ ] **Blocked on an approved source and license:** replace visual components with Linear UI Kit only if that migration is still desired.

## Original implementation order

This sequence is historical planning context, not a completion checklist. Current status is recorded in the checklists above and verification gates below.

1. Add the shared human-command contract and SDK controller.
2. Add the static web package, validated bootstrap boundary, and fake environment adapter.
3. Add the browser WebSocket and IndexedDB cursor adapters.
4. Add the trusted `axl web` host, loopback gateway, and packaged assets.
5. Add one staged new-session controller.
6. Add focused model, thinking, theme, provider, and resume interfaces.
7. Implement honest Chat and Code creation.
8. Implement Search and Fetch configuration only where effective.
9. Implement active-turn semantics and draft-safe failures.
10. Implement the remaining shared slash-command interfaces.
11. Adopt blob, workspace, provider, shell, import, and export capabilities.
12. Complete transcript, tool, cost, state, and accessibility surfaces.
13. Add public extension presentation only when its public contract has a real consumer.
14. Migrate component styling only after license approval.

## Verification gates

### Architecture

- [x] `packages/web` has no runtime dependency on kernel, daemon, runtime, AI, sandbox, or TUI packages.
- [x] React consumes the public SDK projector instead of reducing canonical events.
- [ ] The same browser behavior suite passes through fake and loopback gateway environments.
- [ ] Missing capabilities remove or disable controls with an explicit reason.
- [x] Detaching the browser never interrupts daemon-owned work.

### Behavior

- [ ] TUI and browser converge on one session under simultaneous use.
- [x] Reconnect neither loses nor duplicates canonical events through SDK cursor and snapshot replacement semantics.
- [x] Session switching cannot display state from the prior session.
- [ ] Chat has no workspace or tool interface.
- [ ] Code requires an explicit workspace.
- [x] Model identity remains provider-qualified.
- [x] Thinking choices match model support.
- [x] Active-turn delivery modes remain distinct.
- [x] Ordinary failed prompt sends preserve drafts and show visible errors. Other delivery modes remain.
- [ ] Attachments survive upload, reload, retrieval, and second-client projection.

### Security and packaging

- [ ] Gateway security acceptance tests in `docs/architecture/web-gateway-security.md` pass.
- [x] Production assets fail closed when missing, altered, or incompatible.
- [ ] Development mode keeps one authenticated browser origin.
- [x] The installed package works without the repository, Vite, or pnpm.
- [x] No source maps ship unless separately approved.
- [x] No browser credential appears in logs, URLs, storage, fixtures, or errors.

### Accessibility and presentation

- [ ] Session navigation, tabs, dialogs, menus, composer, interrupt, and reconnect are keyboard-operable.
- [x] Focus restoration and Escape behavior are deterministic for Web settings, provider status, transcript search, and the mobile session drawer.
- [x] Connection and action outcomes use accessible status regions.
- [x] Reduced motion and no-color-only meaning are supported.
- [x] Wide and narrow viewport layouts received bounded Firefox inspection with no horizontal overflow.
- [x] Run the Impeccable detector once over changed web targets after behavior is complete.
- [x] Keep screenshots and generated review artifacts untracked.

### Repository checks

- [x] Run the smallest focused tests for each implemented vertical slice.
- [x] Run the web package tests.
- [x] Run the production-package browser smoke test at desktop and mobile sizes.
- [ ] **Deferred with `axl web --dev`:** run the development-gateway browser smoke test.
- [x] Run `pnpm check` after the current UI wave. Run it again before publication.
- [x] Run `reuse lint`.
- [x] Run an authorized live-provider prompt through the installed browser client.

## Required issue alignment

These checkboxes track GitHub issue closure, not whether an individual implementation slice exists. All listed issues remain open until their full acceptance criteria are reviewed and closed.

- [ ] #389 shared human-command plane
- [ ] #101 browser WebSocket SDK adapter
- [ ] #108 trusted `axl web` host and packaged assets epic
- [ ] #109 trusted `axl web` process host
- [ ] #113 localhost Code and Chat shell epic
- [ ] #114 session navigation and profiles
- [ ] #115 conversation and composer
- [ ] #116 detach, reconnect, and state replacement
- [ ] #117 accessibility and responsive behavior
- [ ] #118 tool, file, and change-review surfaces
- [ ] #119 built-in and generic tool cards
- [ ] #121 status and diff review
- [ ] #123 browser attachment upload
- [ ] #125 extension contributions
- [ ] #126 budgets, usage, sandbox, and operation state
- [ ] #127 permission responses
- [ ] #372 provider authentication and model selection
