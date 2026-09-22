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
| Explicit extension paths | Done | `extension.install` records canonical local paths with precedence above global and package sources. |
| Project-local extensions | Done | `<project>/.axl/extensions/` loads only after a remembered canonical-root trust decision. |
| Package-provided extensions | Partial | The versioned package manifest declares daemon, TUI, and web entry points; daemon loading is complete and presentation hosts remain. |
| npm package installation | Done | Daemon-owned install, update, remove, exact version reporting, and SDK methods use a private package root. |
| Git package installation | Done | Git installs require credential-free HTTPS plus a full commit hash. |
| Extension-owned dependencies | Done | Installed package entries load from their package directory and use native Node dependency resolution. |
| TypeScript authoring declarations | Done | Releases export `@observal/axl/extension-api`. |
| JavaScript and TypeScript loading | Done | The daemon host loads both forms through Node. |
| Extension list and inspection | Done | Typed daemon RPC and SDK inventory includes source, state, package metadata, and lifecycle diagnostics. |
| Per-extension enable and disable | Done | Enablement is persisted and disabled IDs are removed before import. The selected session reloads atomically. |
| Per-extension reload | Partial | A typed per-extension reload control exists, but it currently rebuilds the complete selected session runtime. |
| Atomic replacement | Done | Replacement activation completes before the runtime swap; failed activation leaves the prior runtime active and writes no partial boundary. |

## Lifecycle and interception events

| Pi capability | Axl status | Axl evidence or remaining work |
| --- | --- | --- |
| `project_trust` | Done | Trust is resolved and persisted before project extension discovery or import. |
| `resources_discover` | Done | Extensions contribute bounded canonical resources before prompt construction. |
| `session_start` | Done | Typed activation notification runs with the owning cancellation signal. |
| `session_info_changed` | Done | Canonical rename and configuration events project to the typed lifecycle notification. |
| `session_before_switch` | Missing | Add cancellable pre-switch interception. |
| `session_before_fork` | Missing | Existing command interception covers fork arguments only. |
| `session_before_compact` | Partial | The command hook can replace a summary or block compaction; a dedicated lifecycle contract is missing. |
| `session_compact` | Done | Successful canonical compaction projects to a typed lifecycle notification. |
| `session_compact_failed` | Done | Canonical compaction failure projects to a typed lifecycle notification. |
| `session_before_tree` | Missing | Add pre-navigation interception. |
| `session_tree` | Missing | Add post-navigation notification. |
| `session_shutdown` | Done | Typed shutdown handlers run within the cleanup budget before owned resources are disposed. |
| `before_agent_start` | Missing | Add mutable prompt/context behavior before an agent operation starts. |
| `agent_start` | Done | Canonical user-turn admission projects to a typed lifecycle notification. |
| `agent_end` | Done | Final canonical assistant completion projects to a typed lifecycle notification. |
| `agent_settled` | Partial | Final assistant completion is reported, but queue-drain settlement still needs a distinct signal. |
| `ui_prompt_start` and `ui_prompt_end` | Missing | Add client prompt lifecycle through SDK projections. |
| `turn_start` and `turn_end` | Done | User and final assistant canonical events project typed turn boundaries. |
| `message_start`, `message_update`, and `message_end` | Done | Bounded activity plus canonical assistant completion project typed message lifecycle events. |
| `tool_execution_start` | Done | Effective canonical tool calls project a typed start event before execution. |
| `tool_execution_update` | Partial | Tool-call stream activity is exposed; arbitrary tool progress remains to be projected. |
| `tool_execution_end` | Done | Completion is observed and validated result patches are canonicalized. |
| `context` | Missing | Add mutable per-request context with canonical reconstruction. |
| `before_provider_headers` | Missing | Add provider-boundary header mutation outside the kernel. |
| `before_provider_request` | Missing | Add validated provider payload mutation outside the kernel. |
| `after_provider_response` | Missing | Add provider response observation outside the kernel. |
| `model_select` | Partial | Model changes project typed notifications; pre-change interception remains. |
| `thinking_level_select` | Partial | Thinking changes project typed notifications; pre-change interception remains. |
| `tool_call` | Done | Extensions can allow, block, or chain input replacements before the effective call is written and validated. |
| `tool_result` | Done | Result patches chain in load order and pass the canonical event validator. |
| `user_bash` | Done | Daemon-owned shell intent passes through the cancellable command interceptor before execution. |
| `input` | Done | Input handlers chain continue, validated transform, and handled outcomes before admission. |
| Durable canonical event observation | Done | `session.event` receives cloned durable events and an abortable lifecycle signal. |

## Extension context and control API

| Pi capability | Axl status | Axl evidence or remaining work |
| --- | --- | --- |
| Async factory | Done | The daemon awaits asynchronous default exports. |
| Lifecycle abort signal | Done | Factories, resource discovery, tool hooks, command hooks, and observers receive operation or disposal cancellation. |
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
| Register tool | Done | Tools can register and unregister dynamically; collisions, including built-in overrides, fail explicitly. |
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
