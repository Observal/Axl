<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Extension parity matrix

This matrix tracks Axl against the extension surface documented by Pi 0.85.0. It is a completion gate, not a compatibility claim. A row is complete only when Axl has equivalent public behavior and a runnable test, or a maintainer approves an architectural exclusion.

Status values:

- **Done**: public behavior and focused tests exist.
- **Partial**: related behavior exists, but the public contract or part of the behavior is missing.
- **Missing**: no supported third-party equivalent exists.
- **Excluded**: a maintainer approved the documented architectural difference.

No rows are currently approved exclusions.

## Discovery, trust, and packaging

| Pi capability | Axl status | Axl evidence or remaining work |
| --- | --- | --- |
| Global extension directory | Done | `~/.axl/extensions/` discovers `.ts`, `.mts`, `.js`, and `.mjs` entries deterministically. |
| Explicit extension paths | Missing | Add trusted CLI and daemon configuration with deterministic precedence. |
| Project-local extensions | Missing | Add hierarchical discovery after an explicit remembered project-trust decision. |
| Package-provided extensions | Missing | Define package manifests and daemon, TUI, and web entry points. |
| npm package installation | Missing | Add daemon-owned install, update, remove, and version reporting. |
| Git package installation | Missing | Add pinned source acquisition, provenance, update, and removal. |
| Extension-owned dependencies | Missing | Resolve package dependencies outside monorepo-only workspace behavior. |
| TypeScript authoring declarations | Done | Releases export `@observal/axl/extension-api`. |
| JavaScript and TypeScript loading | Done | The daemon host loads both forms through Node. |
| Extension list and inspection | Missing | Add typed daemon RPC and SDK methods with source, state, compatibility, and failures. |
| Per-extension enable and disable | Missing | Persist global state and remove every contribution while disabled. |
| Per-extension reload | Missing | Reload one extension without replacing unrelated instances. |
| Atomic replacement | Done | Replacement activation completes before the runtime swap; failed activation leaves the prior runtime active and writes no partial boundary. |

## Lifecycle and interception events

| Pi capability | Axl status | Axl evidence or remaining work |
| --- | --- | --- |
| `project_trust` | Missing | Resolve trust before project code discovery or execution. |
| `resources_discover` | Missing | Add bounded resource contribution before prompt construction. |
| `session_start` | Partial | Factories run for each session, but no typed session-start event exists. |
| `session_info_changed` | Missing | Add typed metadata-change observation. |
| `session_before_switch` | Missing | Add cancellable pre-switch interception. |
| `session_before_fork` | Missing | Existing command interception covers fork arguments only. |
| `session_before_compact` | Partial | The command hook can replace a summary or block compaction; a dedicated lifecycle contract is missing. |
| `session_compact` | Missing | Add successful compaction notification. |
| `session_compact_failed` | Missing | Add failed compaction notification. |
| `session_before_tree` | Missing | Add pre-navigation interception. |
| `session_tree` | Missing | Add post-navigation notification. |
| `session_shutdown` | Partial | Tracked cleanup runs, but no typed shutdown event exists. |
| `before_agent_start` | Missing | Add mutable prompt/context behavior before an agent operation starts. |
| `agent_start` | Missing | Add operation lifecycle notification. |
| `agent_end` | Missing | Add operation completion notification. |
| `agent_settled` | Missing | Add post-queue settled notification. |
| `ui_prompt_start` and `ui_prompt_end` | Missing | Add client prompt lifecycle through SDK projections. |
| `turn_start` and `turn_end` | Missing | Add typed turn lifecycle events. |
| `message_start`, `message_update`, and `message_end` | Missing | Add typed streamed-message lifecycle events. |
| `tool_execution_start` | Partial | `tool.call` runs before execution but exposes only gate behavior. |
| `tool_execution_update` | Missing | Add progress observation. |
| `tool_execution_end` | Missing | Add completion observation and validated result mutation. |
| `context` | Missing | Add mutable per-request context with canonical reconstruction. |
| `before_provider_headers` | Missing | Add provider-boundary header mutation outside the kernel. |
| `before_provider_request` | Missing | Add validated provider payload mutation outside the kernel. |
| `after_provider_response` | Missing | Add provider response observation outside the kernel. |
| `model_select` | Missing | Add model-change interception and notification. |
| `thinking_level_select` | Missing | Add thinking-level interception and notification. |
| `tool_call` | Partial | Extensions can allow or block tool calls in deterministic order; input replacement is not exposed. |
| `tool_result` | Missing | Add validated tool-result mutation. |
| `user_bash` | Missing | Add interception around daemon-owned direct shell intent. |
| `input` | Missing | Add continue, transform, and handled outcomes for user and extension-produced input. |
| Durable canonical event observation | Done | `session.event` receives cloned durable events and an abortable lifecycle signal. |

## Extension context and control API

| Pi capability | Axl status | Axl evidence or remaining work |
| --- | --- | --- |
| Async factory | Done | The daemon awaits asynchronous default exports. |
| Lifecycle abort signal | Partial | Event callbacks receive a disposal signal; factory activation cannot yet be cancelled. |
| Deterministic cleanup | Done | Registration rollback, reverse cleanup, asynchronous draining, and bounded disposal are tested. |
| Working directory | Done | `DaemonExtensionApi.cwd` exposes the canonical session directory. |
| Mode and UI availability | Missing | Define daemon, TUI, web, and headless entry-point contexts. |
| Project trust query | Missing | Depends on project-trust storage and discovery. |
| Session manager access | Missing | Add scoped daemon operations instead of exposing mutable kernel objects. |
| Model registry and selected model | Missing | Add read-only registry access and typed model changes through daemon RPC. |
| Idle, abort, and pending-message state | Missing | Add scoped operation state and cancellation. |
| Shutdown | Missing | Add authorized daemon shutdown intent. |
| Context usage | Missing | Add public SDK projection of current context usage. |
| Compact | Partial | Model and clients can compact through daemon commands; extensions lack a direct scoped method. |
| Current system prompt | Missing | Add reconstructable prompt input and rendered-prompt access. |
| New session | Missing | Add scoped creation through daemon RPC. |
| Fork, clone, navigation, and switch | Missing | Existing client RPCs are not exposed through the extension API. |
| Runtime reload | Partial | A session can reload, but extensions lack a direct scoped method and per-extension reload. |
| Register tool | Partial | Factory-time registration works; dynamic registration and explicit override policy are missing. |
| Send extension message | Missing | Add namespaced canonical extension messages. |
| Send user message | Missing | Add defined prompt, steer, and follow-up semantics. |
| Append custom entry | Missing | Add bounded namespaced canonical extension state and replay. |
| Session name | Missing | Add read and update methods through daemon ownership. |
| Entry labels | Missing | Add canonical label operations. |
| Register shared command | Missing | Implement OBS-923 with typed SDK invocation from every client. |
| Enumerate commands | Missing | Expose the authoritative daemon command catalog to extensions. |
| Execute subprocess | Missing | Define whether trusted daemon code uses Node directly or a cancellable Axl helper. |
| Get and set active tools | Missing | Preserve capability authority and progressive-disclosure invariants. |
| Get and set model or thinking | Missing | Route changes through existing daemon configuration operations. |
| Shared extension event bus | Missing | Add namespaced cross-entry-point events with bounded payloads. |
| Register and unregister provider | Missing | Implement through `packages/ai` and daemon boundaries, never the kernel. |
| Persistent extension state | Missing | Persist namespaced canonical state and reconstruct it after restart. |

## TUI presentation API

| Pi capability | Axl status | Axl evidence or remaining work |
| --- | --- | --- |
| Load user and package TUI entry points | Missing | The current host is wired only to first-party extensions. |
| Commands | Partial | Internal extensions can contribute commands; installable third-party entry points cannot. |
| Shortcuts | Partial | Internal extensions can register shortcuts with reserved-key checks. |
| Status and working labels | Partial | Internal extension support exists but is not installable. |
| Widgets | Partial | Internal extension support exists but lacks the complete positioning contract. |
| Tool renderers | Partial | Internal extension support exists with bounded fallback rendering. |
| Event observation | Partial | Internal host events exist; public package loading is missing. |
| Reload and cleanup | Partial | Internal lifecycle cleanup exists; package-scoped reload is missing. |
| Notifications | Missing | Add bounded terminal notifications. |
| Select, confirm, and input dialogs | Missing | Add extension-facing wrappers around the existing interaction components. |
| Custom dialogs and components | Missing | Add owned overlay/component lifecycle. |
| Custom editor | Missing | Add replacement editor ownership and restoration. |
| Header and footer | Missing | Add positioned owned surfaces. |
| Autocomplete provider | Missing | Add registration, ordering, cancellation, and cleanup. |
| Message and canonical-entry renderers | Missing | Add public renderer registration for both projections. |
| Markdown transformers | Missing | Add deterministic transformation and failure isolation. |
| Theme access | Missing | Add read-only theme roles and safe rendering helpers. |
| Non-interactive behavior | Missing | Define which UI calls fail, return defaults, or are unavailable. |

## Web presentation API

| Capability | Axl status | Axl evidence or remaining work |
| --- | --- | --- |
| Browser-safe extension entry point | Missing | Define package declaration, loading, compatibility, and isolation. |
| Commands and applicable shortcuts | Missing | Route shared commands through SDK and keep browser-only intent local. |
| Notifications and dialogs/forms | Missing | Add owned, accessible UI surfaces with cleanup. |
| Status and widget slots | Missing | Define stable browser presentation slots. |
| Tool, message, and event renderers | Missing | Add bounded rendering contracts and visible failure fallbacks. |
| Markdown transforms | Missing | Add deterministic safe transforms before rendering. |
| Theme access | Missing | Expose browser-safe semantic theme tokens. |
| Lifecycle and cleanup | Missing | Remove all DOM, handlers, and background work on disable or reload. |
| Daemon state parity | Missing | Consume extension commands, enablement, lifecycle, and errors through the public SDK. |
| Terminal/browser parity mapping | Missing | Document explicit equivalents or maintainer-approved exclusions. |

## Release evidence

| Completion evidence | Axl status | Remaining work |
| --- | --- | --- |
| First-party daemon consumer | Missing | Migrate one real daemon feature to the public third-party API. |
| First-party TUI consumer | Partial | Existing internal consumers must load through the public package path. |
| First-party web consumer | Missing | Requires the web host. |
| Runnable examples | Partial | Basic probes exist in tests; publish examples for every capability group. |
| Multi-extension ordering and collisions | Partial | Core ordering and collision tests exist; add dynamic reload, disable, and concurrent execution cases. |
| Installed JavaScript and TypeScript artifact tests | Partial | Declaration consumption passes; installed daemon, TUI, web, and dependency loading remain. |
| Live packaged daemon smoke test | Partial | Source-tree live daemon tests pass; repeat from the release artifact. |
| Live packaged TUI smoke test | Missing | Exercise an installable TUI extension. |
| Live packaged web smoke test | Missing | Exercise an installable browser extension. |
