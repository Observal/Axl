<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Human command plane

Status: implementation in progress for [issue #389](https://github.com/Observal/Axl/issues/389)

The wire-version 16 baseline implements a capability-filtered daemon catalog, strict protocol validation, an SDK command controller, daemon-backed TUI and web discovery, TUI shared-command dispatch, dynamic client presentation-command merging, and staged browser session creation. Dynamic daemon catalog invalidation and daemon extension registration remain pending.

## Purpose

Axl exposes human commands through terminal, web, and later clients. Commands that affect shared or durable state must have one daemon-owned definition and execution path. A client may add commands only for presentation behavior local to that client.

This document defines command ownership, discovery, invocation, staged new-session behavior, extension participation, collision handling, and migration from the current TUI command switch.

## Current problem

The command plane replaces the TUI's former static shared-command list and large mixed-ownership dispatcher. Shared commands now come from the daemon catalog and execute through typed SDK workflows. TUI presentation and trusted-host commands join the effective directory through a dynamic client source alongside terminal extension commands.

Browser command execution uses the same daemon catalog and SDK controller. Client-specific focused surfaces still render locally.

The existing typed RPC surface remains useful and authoritative. The command plane coordinates human-facing discovery and invocation over that surface. It does not replace typed RPC for SDK and automation callers.

## Invariants

1. The daemon executes every standard command that changes shared or durable state.
2. The daemon revalidates authorization and availability when a command is invoked.
3. A listed command grants no authority. Effective protocol capabilities and policy remain authoritative.
4. TUI and web collect input, render focused interfaces, and invoke SDK operations. They do not reproduce command business logic.
5. Client-only presentation commands run through the owning client's extension host and never create canonical session state.
6. Shared-state extension commands register with the daemon extension API and appear through daemon discovery.
7. Disabling an extension removes its commands, UI, prompt content, listeners, and background work.
8. Command-name collisions fail explicitly. No source silently shadows another.
9. Shared command effects use the same session manager and canonical events as direct typed RPC calls.
10. A command wrapper never widens protocol capability, sandbox, project, provider, credential, or device policy.
11. Direct shell retains explicit uncertain-outcome behavior and is never automatically retried.
12. Clients may hold drafts and staged new-session intent, but neither is canonical session state.

## Ownership model

### Daemon commands

The daemon owns commands that change or inspect shared runtime state:

- session creation, configuration, branching, cloning, import, export, and disposal
- model, provider, thinking, request, profile, and tool configuration
- send, steer, follow-up, queue, requeue, restore queued input, interrupt, and interrupt-and-deliver
- compaction and runtime reload
- provider status, catalog refresh, and logout
- workspace status, review, diff, and checkpoint behavior
- permission and interaction responses
- shared extension commands

The daemon publishes descriptors for commands authorized on the current attachment. It may report an authorized command as temporarily unavailable with a safe reason.

### SDK workflows

Some human commands coordinate typed daemon RPCs with disposable client state. Their reusable behavior belongs in `packages/sdk`, not in React or terminal rendering:

- selecting a model or thinking level before session creation
- listing and resuming sessions
- selecting a fork point before invoking `session.fork`
- preparing attachment references before `session.send`
- importing or exporting through an injected artifact handoff
- provider login through an injected credential interaction

The SDK workflow owns sequencing, cancellation, stale-result rejection, and normalized outcomes. The daemon still validates and performs every shared effect.

### Trusted process-host commands

Operations requiring host authority remain behind typed host interfaces:

- provider credential acquisition
- filesystem artifact selection or destination selection
- external editor launch
- local browser launch
- daemon shutdown

A browser renderer and TUI component may request one of these operations only when its process host injected that exact capability. Raw process, socket, filesystem, or credential access is never exposed.

### Presentation extensions

Built-in presentation commands and custom client modifications use the same client extension boundary.

TUI examples:

- theme
- fullscreen and regular layout
- Vim editor mode
- terminal hotkeys
- external-editor presentation
- terminal widgets and status lines

Web examples:

- web theme
- focus layout
- browser shortcuts
- panel layout
- custom web panels and renderers

Browser keybindings are presentation behavior but may invoke shared SDK workflows. The active web keymap, including Pi-equivalent `Ctrl/⌘+L` model selection and composer-focused `Shift+Tab` reasoning cycling, is specified in [web-client.md](web-client.md#browser-keyboard-controls) and shown from the browser Settings surface.

A presentation extension may read bounded projected state and mutate only client-local presentation or draft state. It cannot invoke daemon internals. If it needs a shared effect, it calls an authorized SDK operation or pairs with a daemon-registered extension command.

The existing terminal extension API remains the only implemented client extension host. A parallel web extension API is added only with its first real custom web contribution.

## Effective command directory

Each client displays one deterministic directory:

```text
daemon command catalog
+ built-in client presentation extension commands
+ enabled custom client-extension commands
```

Reusable SDK workflows implement focused collection and invocation for daemon-published commands. They do not contribute a second command catalog. The SDK owns merging and validation. The presentation client owns rendering.

Ordering is:

1. exact command name
2. command source priority only for stable display grouping, never shadowing
3. extension ID

Names are lowercase ASCII identifiers with single internal hyphens. The slash is presentation syntax and is not part of the identifier.

Core names and aliases are reserved. A duplicate name or alias fails the registering extension's activation transaction. Existing commands remain active. Duplicate daemon registrations fail daemon extension activation. A client must not silently choose a winner.

## Protocol catalog

Add negotiated capability `command.list` and a typed method with a bounded result. The final schema requires the normal protocol review, wire-version decision, parser, fixtures, and allowed-error matrix.

Conceptual request:

```ts
interface CommandListParams {
  readonly sessionId?: SessionId;
}
```

Conceptual descriptor:

```ts
interface CommandDescriptor {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly context: "global" | "session" | "either";
  readonly argument: {
    readonly required: boolean;
    readonly hint?: string;
  };
  readonly requiredCapabilities: readonly CapabilityId[];
  readonly availability:
    | { readonly state: "available" }
    | { readonly state: "unavailable"; readonly reason: string };
  readonly extensionId?: string;
}
```

Conceptual result:

```ts
interface CommandListResult {
  readonly generation: string;
  readonly commands: readonly CommandDescriptor[];
}
```

Rules:

- The result contains only commands the authenticated attachment may know about.
- Capability requirements are descriptive. Dispatch still enforces them.
- Availability reasons are bounded, safe user-facing strings.
- Dynamic provider models, sessions, files, queue items, and other large choices are not embedded in descriptors. Existing typed RPCs supply them when a focused interface opens.
- A catalog generation changes when daemon command registration or composition changes.
- Clients refresh on connection, reconnection, session replacement, explicit reload, and catalog invalidation.
- Invocation always rechecks current state, so stale availability cannot authorize an operation.

## Execution through typed operations

The first implementation adds command discovery, not a second generic execution API. The SDK command controller maps each built-in daemon command to its existing typed RPC and reusable controller. Both slash invocation and direct controls call that same SDK path.

This preserves:

- method-specific request and response types
- capability checks
- allowed-error matrices
- idempotency and reconciliation rules
- direct-shell uncertainty
- existing canonical event evidence

The client passes a bounded raw argument to the SDK command controller. The controller parses client workflow syntax, opens focused selection when needed, and constructs the typed RPC request. The daemon validates the request again and calls the existing authoritative service method.

Commands with no argument may execute immediately. A command requiring input enters argument mode or opens its focused interface. It never submits malformed input merely because a menu row was selected.

A generic daemon `command.invoke` method is deferred until the first daemon extension command needs dynamic execution. Adding it then requires a concrete consumer, runtime validation, capability enforcement, cancellation semantics, and durable reconciliation. Built-in commands do not need it.

## Idempotency and durable outcomes

Each built-in command inherits the idempotency contract of its typed RPC. The SDK keeps the same idempotency key when a replay-safe operation reconnects and retries.

The command plane does not append a duplicate generic command event when the underlying operation already has canonical evidence. It returns or projects the existing operation and event IDs through the typed RPC and subscription paths.

Read-only commands do not create canonical events. Presentation commands never create canonical events.

Direct shell remains outside automatic command retry. `!` and `!!` call the typed `session.shell` SDK operation with a caller operation ID. A lost result resolves to a recorded canonical shell event or an explicit uncertain outcome. The client never resends automatically.

## Catalog invalidation

Command registration changes are uncommon, but clients must not retain stale extension commands.

The daemon publishes a bounded non-canonical catalog-invalidated delivery containing the new generation and optional affected session ID. It contains no command arguments or session content.

The SDK:

1. marks the affected directory stale
2. coalesces repeated invalidations
3. requests one fresh catalog
4. validates and merges it
5. publishes one immutable replacement

Disconnect clears daemon catalog freshness. Reconnect reloads before command UI becomes interactive. Invocation against a stale command still fails safely at the daemon.

Ordinary runtime state changes do not require an invalidation for every token or activity frame. The client refreshes availability when opening the command directory, after known configuration changes, and after a catalog-invalidated delivery.

## Staged new-session commands

A new-session draft is disposable SDK state. It is not a daemon session and is not written to JSONL.

```ts
interface NewSessionDraft {
  readonly mode: "chat" | "code";
  readonly workspace?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly requestSettings?: ModelRequestSettings;
  readonly webFetch?: boolean;
  readonly webSearch?: boolean;
}
```

The SDK command controller gives `/model`, `/thinking`, and `/request` context-sensitive behavior:

- without an active session, validate against current daemon inventory and update the draft
- with an active session, invoke the daemon-owned command or equivalent typed configuration operation

The daemon default remains absent from the draft until the user makes an explicit selection. Session creation submits the draft atomically. The daemon validates it again.

Chat removes workspace and tool choices. Code requires an explicit workspace before creation. A client cannot turn a running non-Chat profile into `standard` merely because it labels both as Code.

## Focused interfaces

A command descriptor supplies only bounded argument metadata. The SDK associates known core commands with reusable data controllers. Each client renders its own accessible interface.

Examples:

- `/model`: provider inventory and searchable model selection
- `/thinking`: thinking levels supported by the selected model
- `/providers`: provider and catalog status
- `/login`: provider and method selection followed by trusted-host credential interaction
- `/resume`: session listing and selection
- `/fork`: eligible user-message selection
- `/requeue`: paused queue-item selection
- `/attach`: platform file acquisition followed by blob upload
- `/review`: workspace status and diff selection

Selecting a command that requires input opens its interface or places the editor into argument mode. It never immediately invokes malformed input merely because the command menu row was selected.

## Extension commands

### Client extensions

TUI and web extension hosts may register presentation-only commands. Registration includes name, aliases, description, argument hint, and handler. The host supplies an abort signal and bounded presentation API.

Activation is transactional:

1. validate the manifest and declared presentation capabilities
2. reserve every command name and alias
3. activate registrations
4. roll back all registrations if any collision or activation step fails

Disable or reload aborts active handlers, awaits bounded cleanup, removes every owned registration, and increments the client directory generation.

### Daemon extensions

The public daemon extension API can observe and intercept built-in commands, but it cannot register new shared commands yet. Shared command registration requires:

- a stable extension-qualified command ID
- bounded metadata
- an argument parser and validator
- an execution handler using public daemon extension operations
- cancellation behavior
- cleanup ownership

Extensions receive no kernel or daemon objects through the API. Global extension files are trusted by placement and run in process with the daemon's host authority. Project-local executable extensions require a separate explicit project-trust decision before loading. Registration changes invalidate the daemon catalog.

A first-party command must use the same public registration path as a third-party command after registration exists. Until then, built-in daemon commands may use the internal registry that implements the descriptor and invocation contract.

## Command classification

| Command | Owner and execution |
| --- | --- |
| `/model` | SDK staged workflow before creation; daemon configuration after creation. |
| `/thinking` | SDK staged workflow before creation; daemon configuration after creation. |
| `/theme` | Client presentation extension. |
| `/settings` | Client presentation extension that opens local preferences. |
| `/details` | Client presentation extension. |
| `/fullscreen` | TUI presentation extension. |
| `/regular` | TUI presentation extension. |
| `/providers` | SDK workflow over daemon provider inventory and status. |
| `/login` | SDK workflow plus injected trusted-host credential interaction and daemon status refresh. |
| `/logout` | Daemon provider operation. |
| `/refresh` | Daemon provider catalog operation. |
| `/reload` | Daemon session command. |
| `/compact` | Daemon session command. |
| `/status` | Client presentation over SDK-projected canonical state. |
| `/usage` | Client presentation over SDK-projected canonical usage. |
| `/requeue` | SDK selection workflow followed by daemon queue operation. |
| `/resume` | SDK session-list and resume workflow. |
| `/fork` | SDK message selection followed by daemon fork operation. |
| `/clone` | Daemon session operation. |
| `/rename` | Canonical daemon session rename. |
| `/dispose` | Daemon runtime disposal with durable history retained. |
| `/delete` | Confirmed permanent deletion of session history. |
| `/import` | Injected artifact handoff followed by daemon import. |
| `/export` | Daemon export followed by injected artifact handoff. |
| `/stash` | Client presentation extension over local draft state. |
| `/favorite` | Client presentation extension over client preferences. |
| `/developer` | Client presentation extension. |
| `/review` | SDK workspace workflow with client rendering. |
| `/attach` | Platform file acquisition plus SDK blob upload workflow. |
| `/vim` | TUI presentation extension. |
| `/commands` | Client presentation extension over the effective directory. |
| `/history` | Client presentation extension over local prompt history. |
| `/edit` | TUI trusted-host presentation extension. |
| `/hotkeys` | Client presentation extension. |
| `/help` | Client presentation extension over commands and shortcuts. |
| `/detach` | SDK attachment lifecycle operation. |
| `/web` | TUI trusted-host command that opens the current session in a browser. |
| `/request` | SDK staged workflow before creation; daemon configuration after creation. |
| `/quit` | Trusted process-host shutdown flow with daemon preview and confirmation. |
| `!command` | Typed daemon shell operation; output enters model context. |
| `!!command` | Typed daemon shell operation; output stays outside model context. |

The classification is normative. Shared daemon and SDK commands require parity when a client requests their capabilities. Presentation command names do not require cross-client parity: for example, the web command palette may replace the TUI's `/commands`. A client may choose different visual controls, but it may not move a shared effect into presentation code.

## SDK command controller

The SDK exposes one controller per client attachment. It owns:

- loading and refreshing the daemon catalog
- merging daemon and client-extension descriptors
- reserved-name validation
- deterministic ordering and search normalization
- staged new-session command behavior
- invoking daemon commands and typed workflows
- cancellation state
- stale result rejection after session switches
- normalized success, failure, accepted, and uncertain outcomes

It does not own canonical state or command authorization. Its staged draft and presentation entries are disposable.

The controller accepts adapters for:

- client presentation extension directory
- focused core surfaces
- trusted host interactions
- local notices

The TUI and web implementations render controller state. They do not switch over daemon command names to implement behavior.

## Failure behavior

- Unknown command: preserve input and show an explicit error.
- Missing argument: preserve input and enter argument mode or focused selection.
- Invalid argument: preserve input and show the daemon or SDK validation message at the initiating surface.
- Missing capability: disable or omit according to the descriptor, with an inspectable reason.
- Stale catalog: refresh once, then fail if the command remains absent.
- Session switch during invocation: reject stale presentation results; canonical effects remain attached to their target session.
- Disconnect before replay-safe acknowledgment: reconnect and retry with the same idempotency key.
- Disconnect during direct shell: report completed evidence or an uncertain outcome without retry.
- Extension disable: abort local handlers, remove registrations, and refresh the effective directory.
- Name collision: fail the new registration and preserve the existing directory.

Errors are bounded safe user-facing messages. They contain no stack, credentials, prompt contents, file contents, or rejected secret value.

## Migration plan

1. Add protocol schemas and fixtures for command catalog, invalidation, and errors.
2. Add a daemon built-in registry that describes existing typed operations.
3. Add SDK command catalog and staged-session controllers.
4. Migrate TUI shared commands without changing their visible behavior.
5. Move built-in TUI presentation commands behind the terminal extension host.
6. Verify extension collision, disable, reload, cancellation, and cleanup behavior.
7. Build the browser command directory from the same SDK controller.
8. Add the web presentation extension API only with its first custom web contribution.
9. Add daemon extension command registration only with its first runtime extension consumer.
10. Delete the old TUI command table and dispatcher after parity tests pass.

The migration is hard. Do not keep a legacy command table, compatibility shim, or fallback dispatcher after each client has moved.

## Verification

### Protocol

- Every descriptor, catalog request, result, error, and invalidation is runtime validated.
- Unknown and extra fields fail.
- Catalog and message bounds are enforced before allocation.
- Capability narrowing removes unauthorized commands.
- Invocation rechecks authorization and availability.
- Same-key retries cannot duplicate a shared effect.
- Same-key, different-command reuse fails.
- Wire-version compatibility fails loudly.

### SDK

- Catalog merge order is deterministic.
- Core and extension collisions fail explicitly.
- Reconnect and invalidation replace stale catalogs.
- Session switches reject stale workflow results.
- Staged commands never create canonical events before session creation.
- Direct controls and slash commands produce the same typed daemon operation.

### Clients

- TUI and web show the same shared command names and availability.
- Selecting an argument-requiring command does not invoke it prematurely.
- Focused pickers restore focus and preserve drafts on cancellation or failure.
- Presentation commands produce no canonical events.
- Disabling a client extension removes its commands and UI.
- A mutation from either client converges through the ordinary canonical subscription.

### Extensions

- A presentation extension cannot access daemon internals.
- A shared-state extension command cannot register through a client extension host.
- Activation collision rolls back all registrations from the failing extension.
- Disable and reload abort active handlers and complete bounded cleanup.
- Disabled features contribute no command metadata, prompt content, UI, or background work.

## Non-goals

- Replacing typed RPC with a generic workflow language.
- Sending React components or terminal rendering instructions over the protocol.
- Making presentation preferences canonical session state.
- Giving browser code raw process, filesystem, socket, or credential authority.
- Adding the public daemon extension API before a working runtime consumer needs it.
- Preserving the current hardcoded TUI dispatcher as a compatibility fallback.
