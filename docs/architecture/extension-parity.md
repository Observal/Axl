<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Extension parity matrix

This matrix tracks Axl against the extension surface documented by Pi 0.85.0. It is a completion gate, not a compatibility claim. A row is complete only when Axl has equivalent public behavior and a runnable test, or a maintainer approves an architectural exclusion.

Status values:

- **Done**: public behavior and focused tests exist.
- **Partial**: related behavior exists, but the public contract or part of the behavior is missing.
- **Missing**: no supported third-party equivalent exists.
- **Excluded**: a maintainer approved the documented architectural difference.

Daemon-global session selection, tree-navigation UI, and UI prompt lifecycle are excluded by `client-boundaries.md`; their equivalents belong to the separate presentation extension hosts.

## Discovery, trust, and packaging

| Pi capability | Axl status | Axl evidence or remaining work |
| --- | --- | --- |
| Global extension directory | Done | `~/.axl/extensions/` discovers `.ts`, `.mts`, `.js`, and `.mjs` entries deterministically. |
| Explicit extension paths | Done | `extension.install` records canonical local paths with precedence above global and package sources. |
| Project-local extensions | Done | `<project>/.axl/extensions/` loads only after a remembered canonical-root trust decision. |
| Package-provided extensions | Partial | Versioned manifests support daemon-only, TUI-only, and combined entries. The local TUI loads enabled, validated entries through daemon inventory; the web host remains. |
| npm package installation | Done | Daemon-owned install, update, remove, exact version reporting, and SDK methods use a private package root. |
| Git package installation | Done | Git installs require credential-free HTTPS plus a full commit hash. |
| Extension-owned dependencies | Done | Installed package entries load from their package directory and use native Node dependency resolution. |
| TypeScript authoring declarations | Done | Releases export `@observal/axl/extension-api`. |
| JavaScript and TypeScript loading | Done | The daemon host loads both forms through Node. |
| Extension list and inspection | Done | Typed daemon RPC and SDK inventory includes source, state, package metadata, and lifecycle diagnostics. |
| Per-extension enable and disable | Done | Enablement is persisted and disabled IDs are removed before import. The selected session reloads atomically. |
| Per-extension reload | Done | The targeted RPC validates the requested ID, then atomically rebuilds the selected session so prompt, provider, tool, and hook contributions stay coherent. Content-hashed imports load changed source, but Node retains prior ESM module instances and their untracked top-level side effects until daemon exit. |
| Atomic replacement | Done | Replacement activation completes before the runtime swap; failed activation leaves the prior runtime active and writes no partial boundary. |

## Lifecycle and interception events

| Pi capability | Axl status | Axl evidence or remaining work |
| --- | --- | --- |
| `project_trust` | Done | Trust is resolved and persisted before project extension discovery or import. |
| `resources_discover` | Done | Extensions contribute bounded canonical resources before prompt construction. |
| `session_start` | Done | Typed activation notification runs with the owning cancellation signal. |
| `session_info_changed` | Done | Canonical rename and configuration events project to the typed lifecycle notification. |
| `session_before_switch` | Excluded | Axl has no daemon-global selected session; each client owns its attachment and switch intent under `client-boundaries.md`. |
| `session_before_fork` | Done | The typed alias can replace the fork point or block before copy. |
| `session_before_compact` | Done | The typed alias can replace instructions or summary, or block before compaction starts. |
| `session_compact` | Done | Successful canonical compaction projects to a typed lifecycle notification. |
| `session_compact_failed` | Done | Canonical compaction failure projects to a typed lifecycle notification. |
| `session_before_tree` | Excluded | Branch-tree navigation is a client projection operation and cannot be globally blocked by an in-process daemon extension. |
| `session_tree` | Excluded | Presentation extensions observe client navigation locally; canonical branch changes remain visible through `session.event`. |
| `session_shutdown` | Done | Typed shutdown handlers run within the cleanup budget before owned resources are disposed. |
| `before_agent_start` | Done | Extensions append bounded canonical context before an agent operation starts. |
| `agent_start` | Done | Canonical user-turn admission projects to a typed lifecycle notification. |
| `agent_end` | Done | Final canonical assistant completion projects to a typed lifecycle notification. |
| `agent_settled` | Done | The notification fires only after the active turn and transient and durable queued input are drained. |
| `ui_prompt_start` and `ui_prompt_end` | Excluded | UI prompt lifecycle belongs to the separate TUI and web extension hosts, not the daemon host. |
| `turn_start` and `turn_end` | Done | User and final assistant canonical events project typed turn boundaries. |
| `message_start`, `message_update`, and `message_end` | Done | Bounded activity plus canonical assistant completion project typed message lifecycle events. |
| `tool_execution_start` | Done | Effective canonical tool calls project a typed start event before execution. |
| `tool_execution_update` | Done | Extension and built-in tools can publish bounded progress through transient activity frames. |
| `tool_execution_end` | Done | Completion is observed and validated result patches are canonicalized. |
| `context` | Done | Extensions append canonical message context or a system-prompt suffix per request without rewriting the stable prefix. |
| `before_provider_headers` | Done | Shared HTTP model transports support ordered header mutation; adapter-managed transports expose no unavailable raw headers. |
| `before_provider_request` | Done | Shared HTTP model transports support ordered provider-payload replacement before dispatch. |
| `after_provider_response` | Done | Shared HTTP model transports report response metadata before body consumption and cancel bodies on handler failure. |
| `model_select` | Done | Canonical model changes project typed notifications with previous state recoverable from prior events. |
| `thinking_level_select` | Done | Canonical thinking-level changes project typed notifications. |
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
| Mode and UI availability | Done | Daemon entry points report `mode: "daemon"` and `uiAvailable: false`; presentation entry points remain separate. |
| Project trust query | Done | `session.info()` reports the remembered canonical project-trust decision. |
| Session manager access | Done | The public session facade exposes scoped operations and snapshots without mutable kernel objects. |
| Model registry and selected model | Done | `session.info()` returns the available model identities and selection; setters route through daemon configuration. |
| Idle, abort, and pending-message state | Done | The session facade exposes abort plus current operation and pending-message state. |
| Shutdown | Done | Trusted daemon extensions can request asynchronous daemon shutdown through the scoped session facade. |
| Context usage | Done | `session.info()` exposes the latest bounded context-token count when available. |
| Compact | Done | The scoped session facade invokes daemon-owned compaction. |
| Current system prompt | Done | Context handlers and `session.info()` expose the stable system prompt without mutable kernel access. |
| New session | Done | The scoped session facade creates sessions through daemon ownership. |
| Fork, clone, navigation, and switch | Done | Scoped fork and clone use daemon operations; navigation and switching remain client-owned by architecture. |
| Runtime reload | Done | The scoped session facade and management RPC both use atomic daemon reload. |
| Register tool | Done | Tools can register and unregister dynamically; collisions, including built-in overrides, fail explicitly. |
| Send extension message | Done | Namespaced extension messages append canonical `context.extension` events and enter model context. |
| Send user message | Done | The scoped session facade supports validated steering and follow-up delivery. |
| Append custom entry | Done | Bounded namespaced `extension.state` events provide canonical custom state. |
| Session name | Done | Scoped read and rename route through daemon-owned session state. |
| Entry labels | Done | Namespaced labels append canonical `extension.label` events and rebuild after restart. |
| Register shared command | Done | Commands register in the daemon and invoke through typed public SDK RPC. |
| Enumerate commands | Done | Extension commands appear in both extension inventory and the authoritative daemon command catalog. |
| Execute subprocess | Done | Trusted daemon extensions use Node process APIs directly and receive lifecycle cancellation signals; no redundant process wrapper is added. |
| Get and set active tools | Done | `session.info()` reads active tools and `activateTools()` uses the authority-checked capability service. |
| Get and set model or thinking | Done | Scoped reads and setters route through daemon configuration. |
| Shared extension event bus | Done | `emit()` appends bounded namespaced `extension.event` records visible through daemon and SDK event streams. |
| Register and unregister provider | Done | Ref-counted registrations use the existing `packages/ai` `ModelProvider` contract and registry, with cleanup after the last owning session. |
| Persistent extension state | Done | Namespaced JSON state is canonical and rebuilt from `extension.state` events. |

## TUI presentation API

| Pi capability | Axl status | Axl evidence or remaining work |
| --- | --- | --- |
| Load user and package TUI entry points | Done | Enabled global, explicit, npm/Git, and trusted project package entries are selected by daemon inventory, imported locally by the TUI, and identity-checked. |
| Commands | Done | Installable third-party terminal entries register commands with collision checks and lifecycle cleanup. |
| Shortcuts | Done | Installed entries use the same reserved-key and duplicate-key checks as first-party entries. |
| Status and working labels | Done | Installed entries can contribute and clean up both. |
| Widgets | Done | Installable entries contribute bounded rows above or below the editor and dispose on reload. |
| Tool renderers | Done | Installed entries use the bounded public renderer registration and fallback rendering. |
| Event observation | Done | Installed entries receive abortable session and working events. |
| Reload and cleanup | Partial | Changed-source `/reload`, session switch, and daemon-side mutation reload rebuild the terminal host atomically and dispose old registrations; isolated terminal-only reload remains. |
| Notifications | Done | `ctx.notify` and `api.ui.notify` show sanitized terminal notices. |
| Select, confirm, and input dialogs | Done | Commands and UI entries use owned, cancellable selection, confirmation, single-line input, and multiline editor overlays. |
| Custom dialogs and components | Done | `api.ui.custom` owns a bounded dialog component with keyboard focus, cursor placement, explicit cancellation, and disposal. |
| Custom editor | Done | `registerEditor` replaces the main composer locally, intercepts non-reserved keys, retains the canonical draft and built-in safety keys, and restores the default on disposal. |
| Header and footer | Done | Owned `registerHeader` and `registerFooter` surfaces render in the live terminal frame. |
| Autocomplete provider | Done | Installed async providers return labeled, range-started completions at any cursor position, in registration order, with stale-request cancellation, built-in precedence, cleanup, and cursor-preserving insertion. |
| Message and canonical-entry renderers | Done | Channel-specific public renderers project canonical context, state, and extension events as bounded terminal lines without changing durable data. |
| Markdown transformers | Done | Assistant and user canonical messages plus in-flight assistant output transform in registration order with visible failure text. Canonical data and model input remain unchanged. |
| Theme access | Partial | UI entries can list or select themes and style text with semantic roles. The public surface does not expose every internal theme token. |
| Non-interactive behavior | Done | Headless terminal hosts report `hasUI: false` and UI methods throw an explicit unavailable error. |

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
| First-party daemon consumer | Done | The built-in `/extensions` diagnostics command is registered through the same `DaemonExtensionFactory` API as third-party commands. |
| First-party TUI consumer | Partial | Existing internal consumers must load through the public package path. |
| First-party web consumer | Missing | Requires the web host. |
| Runnable examples | Partial | `examples/extensions/daemon-kitchen-sink.ts` covers daemon tools, hooks, state, commands, and progress; presentation examples remain. |
| Multi-extension ordering and collisions | Done | Tests cover deterministic precedence, collisions, chained mutation, cancellation, disablement, replacement, restart reconstruction, and cleanup. |
| Installed JavaScript and TypeScript artifact tests | Partial | Packaged JavaScript execution and external TypeScript declaration consumption pass; local daemon-backed TUI loader tests pass, but separately installed release TUI and web loading remain. |
| Live packaged daemon smoke test | Done | An installed release artifact loaded provider hooks and completed a real Azure-backed turn. |
| Live packaged TUI smoke test | Missing | Exercise an installable TUI extension. |
| Live packaged web smoke test | Missing | Exercise an installable browser extension. |
