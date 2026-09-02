<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Axl implementation plan

Status: local execution plan. This file is the current source of truth for build order. `HARNESS_PLAN.md`, `CODE_STRUCTURE.md`, and `OPEN_SOURCE.md` describe the product, repository, and project policies.

## 1. Delivery rules

1. Build vertical slices, not empty package scaffolding.
2. Use Pi and DSH as read-only behavioral and architectural references. Write Axl-native implementations. Do not copy files, paste source, or translate implementations line by line.
3. Build phases 0 through 4 with a stable external harness.
4. Start using Axl to build Axl when the phase 4 dogfood gate passes.
5. Continue using independent review for kernel, protocol, sandbox, credentials, adoption trust boundaries, and cloud cleanup.
6. Fail loudly. An unavailable capability must never silently become a weaker capability.
7. Keep the kernel limited to the guarantees listed in `HARNESS_PLAN.md` section 2.3.
8. Add one focused runnable check for every non-trivial behavior.
9. Do not implement a later phase merely to prepare for hypothetical use. Preserve the seam and stop.
10. Complete security prerequisites before activating the feature that depends on them.
11. Keep the TypeScript protocol definitions authoritative until a second implementation language creates a real code-generation need.

## 2. Foundational dependency decisions

Resolve these before implementation because they affect irreversible boundaries.

- [x] Make `packages/protocol` dependency-free and authoritative for event and RPC schemas.
- [x] Allow `packages/kernel` to depend only on `packages/protocol` and Node.js built-ins, with no third-party runtime dependencies.
- [x] Use private `@axl/*` package names and the future `axl` executable as temporary working names. Revisit naming before publication.
- [x] Define the first at-rest event format version as `1`.
- [x] Define the first local wire protocol version as `1`, with exact-version compatibility before the first stable release.
- [x] Confirm Apache-2.0 for Axl and establish the attribution process for behavior or fixtures derived from external projects.
- [x] Record Pi and DSH reference commits used during implementation.
- [x] Keep third-party extensions out of the daemon process in v1. Only trusted first-party extensions may run in process.
- [x] Keep capability search local and lexical. V1 uses BM25, not embeddings or provider-native tool search.
- [x] Keep TypeScript definitions authoritative until the first non-TypeScript client requires code generation.

Decisions that can wait are listed in the phase where they become necessary.

## Phase 0: Repository and assurance baseline

Build this before product code so security and license hygiene do not become a retrofit.

### Repository

- [x] Initialize the monorepo.
- [x] Configure pnpm workspaces and TypeScript.
- [x] Add packages only when they receive working code. Phase 0 starts with `protocol`. `kernel`, `ai`, `sandbox`, `daemon`, and the minimal CLI wait for their working slices.
- [x] Establish package-boundary checks.
- [x] Prohibit private kernel imports from extensions.
- [x] Prohibit hand-edited generated code.
- [x] Keep mobile applications in the monorepo when they are introduced.

### Licensing and contribution policy

- [x] Add Apache-2.0 license files.
- [x] Add REUSE configuration and SPDX validation.
- [x] Add `NOTICE` and a process for recording external provenance.
- [x] Add DCO sign-off enforcement.
- [x] Add the AI contribution policy.
- [x] Add `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `AGENTS.md`, `SETUP.md`, `ROADMAP.md`, and `CHANGELOG.md` using the project conventions in `OPEN_SOURCE.md`.
- [x] Add issue forms, the pull request template, and CODEOWNERS.

### CI baseline

- [x] Pin GitHub Actions by full commit SHA.
- [x] Use read-only workflow permissions by default.
- [x] Add formatting, type checking, unit tests, license checks, and DCO checks.
- [x] Add Gitleaks, dependency review, CodeQL, actionlint, and lockfile auditing.
- [x] Configure path-gated jobs while ensuring every required check reports a result.
- [ ] Protect main with pull requests, linear history, and a merge queue after the canonical GitHub remote exists.

### Exit gate

A minimal TypeScript package builds and tests from a clean clone, all policy checks run, and the repository carries no unlicensed file.

## Phase 1: Canonical protocol and event log

This is the most expensive layer to change later and must precede the agent loop.

### Review checkpoints

Do not cross a checkpoint without user review and approval:

- [x] Define identifiers, the event envelope, and runtime validation with focused tests. Stop before adding the event catalog.
- [x] Add the required event variants and their validation tests. Stop before persistence.
- [x] Add serialized crash-safe JSONL append, truncation recovery, and write-boundary redaction. Stop before tree reconstruction.
- [x] Add tree reconstruction and integrity checks. Stop before replay.
- [x] Add deterministic replay and the initial event-reader fuzz target, then verify the Phase 1 exit gate.

### Event schema

- [x] Define stable event IDs, session IDs, operation IDs, and `parentId` tree links.
- [x] Define session lifecycle events.
- [x] Define user, assistant, tool-call, tool-result, configuration, permission, sandbox, compaction, and error events.
- [x] Define explicit events for model, provider, entitlement, thinking level, prompt sections, tool schemas, injected context, and extension context.
- [x] Define attributed child-session result events.
- [x] Define blob references for images, uploads, and artifacts without placing large payloads in JSONL.
- [x] Version every event and validate untrusted event input.

### JSONL source of truth

- [x] Implement one serialized append path per session.
- [x] Make writes crash-safe so recovery can discard only a torn final line.
- [x] Reconstruct session trees from IDs and parent links.
- [x] Preserve every historical branch.
- [x] Append to the log before updating any derived state. Derived state (trees, replay) is computed only from log reads.
- [x] Implement truncation recovery and explicit corruption errors.
- [x] Add model-visible redaction at the log-write boundary.
- [x] Version the list of credential and secret fields that must be masked.

### Replay and tests

- [x] Add deterministic regression replay with model responses and tool results stubbed from the log.
- [x] Test branch reconstruction, malformed events, interrupted writes, duplicate IDs, missing parents, and tool call/result integrity.
- [x] Add the event-log reader as an early fuzz target.

### Exit gate

A process can append a branched session, crash during an append, recover, replay it deterministically, and produce the same tree without exposing fixture secrets.

## Phase 2: Provider and model foundation

Adapt Pi's provider architecture as an Axl-native contract. Do not create another wrapper above it.

### Provider contract

- [x] Define provider identity, authentication methods, model discovery, optional refresh, streaming, cancellation, and optional deferred responses.
- [x] Define model metadata: provider, model ID, API dialect, input capabilities, context window, output limit, cost, headers, and compatibility flags.
- [x] Define canonical streaming events for text, thinking, tool calls, completion, errors, aborts, and usage.
- [x] Require provider failures after dispatch to terminate through the stream contract.
- [x] Add runtime provider registration and disposal for future extensions.
- [x] Add one fake provider for deterministic tests.

### Authentication and credentials

- [x] Store credential references separately from provider and session configuration.
- [x] Support environment, file-backed, OAuth, ambient, and keyless-local authentication shapes without exposing values to extensions.
- [x] Keep credentials out of prompts, events, generated artifacts, and diagnostics. Resolved authentication exposes `secretValues` for log redaction. Session wiring lands with the daemon and is checked again at the dogfood gate.
- [x] Implement explicit login, logout, refresh, and invalid-auth states.

### Models and thinking

- [x] Implement capability checks for tool use, structured output, images, and other role requirements.
- [x] Implement `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` thinking levels.
- [x] Implement per-model thinking maps and visible clamping.
- [x] Support token-budget reasoning providers while reserving answer space.
- [x] Log model and thinking changes as configuration events. Clamping returns the `config.thinking` payload, and the kernel loop records it.
- [x] Track input, output, cache, reasoning, and cost usage.

### Initial adapters

- [x] Implement only the provider adapter required for the first dogfood sessions. Decided and built: Azure OpenAI over the Responses API.
- [x] Add generic OpenAI-compatible support only when the first provider needs it. `OpenAiResponsesProvider` supplies the shared layer, and Azure adds its endpoint policy.
- [x] Keep provider breadth deferred until the stream contract is stable. Azure exposes Pi's full Azure OpenAI model catalog, but no other provider adapters ship in this phase.

### Tool dialect foundation

- [x] Separate canonical tool identity from provider-visible names and schemas.
- [x] Define a generic dialect and the dialect needed by the first model.
- [x] Freeze the provider-visible tool list between explicit dialect boundaries.
- [x] Log model switches and explicit reloads that break the prompt cache. `config.model` and `config.dialect` are announced at every session open, and `/reload` rebuilds the runtime as a logged `reload` boundary.

### Exit gate

The fake provider and one real provider produce identical canonical stream shapes, capability mismatches fail before a request, cancellation terminates cleanly, and no credential appears in the log.

## Phase 3: Minimal kernel and agent loop

### Kernel ownership

- [x] Implement the agent loop over the canonical protocol.
- [x] Implement tool execution dispatch and tool call/result pairing.
- [x] Implement cancellation and operation ownership so only one operation mutates a branch at a time.
- [x] Implement extension-host lifecycle as an empty seam, not a full extension system yet.
- [x] Keep provider-specific logic outside the kernel. The kernel consumes an injected `ModelPort`, while `@axl/protocol` owns canonical stream and message types.

### Prompt behavior

- [x] Build the stable prompt from identity, working directory, active tools, applicable `AGENTS.md`, and essential constraints.
- [x] Preserve an append-only prompt-cache prefix.
- [x] Append loaded skills, context, steering, and injected instructions rather than rewriting prior content.
- [x] Exclude subagent instructions and tools by default.
- [x] Add the minimal profile with only shell and editing capabilities.

### Minimal tools

- [x] Implement canonical `shell`, `read`, and `edit` tools.
- [x] Validate tool input before execution.
- [x] Enforce tool cancellation and output bounds.
- [x] Preserve complete tool outputs outside the model surface when truncation is needed. Shell overflow is written whole to the configured overflow directory and referenced from the result.

### Exit gate

A deterministic fake-model session can inspect a fixture repository, edit one file, run one command, record a valid tool result, and stop or abort without corrupting the log.

## Phase 4: Minimal daemon, client, and sandbox

This is the final phase built primarily with the stable external harness.

### Authoritative daemon

- [x] Make the daemon the sole owner of sessions, loops, logs, and operations.
- [x] Implement create, resume, send, interrupt, subscribe, and dispose.
- [x] Use a local Unix socket transport first.
- [x] Implement snapshot plus event tail for client attachment.
- [x] Keep the client free of agent-loop behavior.

### Minimal client

- [x] Build a plain terminal or headless client.
- [x] Show streamed text, tool activity, errors, model, thinking level, and sandbox status. Text currently arrives one event at a time. Phase 9 adds token-delta streaming over the wire.
- [x] Support send, interrupt, detach, reconnect, and resume.
- [x] Add a searchable `/resume` selector over daemon-owned session metadata. Treat this as bootstrap behavior, not a later convenience.
- [x] Defer the polished TUI and public SDK at the Phase 4 gate. The TUI work below was later brought forward. The public SDK remains deferred.

### Minimum enforceable sandbox

- [x] Canonicalize every file path before policy evaluation.
- [x] Reject symlink escapes and writes outside the workspace.
- [x] Protect Axl configuration, credentials, and session storage from tool access.
- [x] Execute shell commands through Bubblewrap on Linux.
- [x] Start with workspace-scoped writes and no tool-process network access.
- [x] Set `failIfUnavailable` for dogfood sessions.
- [x] Emit explicit sandbox violation events.
- [x] Provide no implicit unsandboxed fallback. The later explicit `--unsafe` mode uses separate state, logs the unenforced configuration, and shows a persistent warning.

### Dogfood gate

Switch to Axl building Axl when all of the following pass:

- [x] Axl edits its own source in a disposable worktree using Azure OpenAI.
- [x] Axl runs the smallest relevant test inside Bubblewrap.
- [x] A fresh daemon restores the full session history and completes another turn.
- [x] Interrupting model output or a tool records an aborted turn without corrupting the branch.
- [x] Credentials and secret fixtures are absent from the event log.
- [x] Deterministic replay reproduces the complete session byte for byte.

After this gate, use Axl for ordinary development. Continue independent review of kernel and security-boundary changes.

### Dogfood follow-up

The Phase 4 gate still stands, but several current paths need replacement before dogfooding expands:

- [ ] Replace the prompt-wide skill catalog with BM25 selection before each user turn.
- [ ] Replace the generic MCP invocation path with turn-selected, provider-native tool schemas and frozen per-turn bindings.
- [ ] Add `ask_user_question` to interactive sessions and verify that it is absent from goals and headless runs.
- [ ] Add blind credential brokering before dogfooding credentialed third-party extensions or local MCP servers.
- [x] Keep the fail-closed sandbox default and test the explicit `--unsafe` mode separately.

These are the next dogfood prerequisites. They take priority over the remaining Phase 5 convenience work.

## Phase 5: Productive single-session development

Make Axl comfortable enough for sustained daily use before expanding its ecosystem.

The checked TUI items in this phase were pulled forward as an explicit exception to phase ordering. They do not mark Phase 5 complete.

### Standard profile and web access

- [ ] Add `write`, `web_search`, and `fetch_content` to the standard profile.
- [ ] Adapt the two-tool shape and routing principles of `pi-web-access` without copying its source.
- [ ] Provide keyless search where available and explicit configuration for optional providers.
- [ ] Add readable, raw, and summarized fetch modes.
- [ ] Clone GitHub repositories locally instead of scraping rendered pages.
- [ ] Add SSRF protection, content sanitization, and explicit third-party-fetch opt-in.
- [ ] Defer browser automation to the full sandbox phase.

### Compaction

- [ ] Implement proactive threshold compaction and overflow recovery.
- [ ] Implement manual compaction.
- [ ] Preserve turn boundaries and tool call/result integrity.
- [ ] Handle split turns and previous-summary iteration.
- [ ] Produce structured continuation summaries.
- [ ] Track cumulative read and modified files.
- [ ] Summarize branches independently and exclude side-channel branches.
- [ ] Retain original history outside the compacted model surface.
- [ ] Track compaction tokens and cost.
- [ ] Add behavior tests against Pi fixtures where fixture licensing permits use.

### Session controls

- [x] Add model and thinking-level switching.
- [ ] Add `ask_user_question` as a typed tool in interactive terminal, web, IDE, and mobile sessions.
- [ ] Remove the tool and its prompt text from goals, headless runs, and unattended automation.
- [ ] When a goal needs missing information, record a reversible assumption or emit a visible blocker and pause.
- [ ] Add context, token, cache, latency, and cost visibility.
- [ ] Add token, cost, and wall-clock budgets with safe-boundary pauses.
- [ ] Implement steer, follow-up, and interrupt semantics.
- [x] Queue multiple follow-ups in order.
- [x] Add `/fork` from a selected user message and `/clone` from the current tip.
- [ ] Add in-session branch and tree navigation.
- [ ] Add workspace checkpoints after modifying turns.
- [ ] Add conversation-only, workspace-only, and combined rewind.
- [ ] Report allowed writes outside the workspace that rewind cannot undo.
- [ ] Isolate parallel sessions with git worktrees.

### Configuration

- [ ] Read global and project `AGENTS.md` files.
- [ ] Read global `~/.axl/` and project `.axl/` configuration.
- [ ] Resolve project settings over global settings while allowing project policy only to narrow capabilities.
- [ ] Add standard, minimal, and chat profiles.

### Terminal experience

- [x] Add differential rendering and synchronized output.
- [x] Preserve normal terminal scrollback.
- [ ] Add responsive layouts, inline diffs, inline images, overlays, and IME-safe cursor handling.
- [ ] Keep alternate-screen mode optional.

### Exit gate

Use Axl for multiple real development sessions across restarts and branches without returning to the stable harness for routine edits, tests, compaction, or recovery.

## Phase 6: Native extension runtime and open standards

Build this before adding most first-party features so those features prove the public API.

### Extension API

- [ ] Start with `registerTool`, `registerCommand`, `registerSkill`, and `on`.
- [ ] Return a disposer from every registration.
- [ ] Add `registerProvider`, `registerHook`, `registerTheme`, `registerRenderer`, and `registerWebPanel` only when the first working consumer needs each API.
- [ ] Require an explicit capability manifest before activation.
- [ ] Keep arbitrary kernel internals inaccessible.
- [ ] Make first-party extensions use only the public extension API once that API exists.
- [ ] Ensure disabling a feature removes its prompt tokens, UI, and background work.

### Resource formats

The checked standards items were brought forward by request. They do not complete the Phase 6 extension API. The current prompt-wide skill catalog and generic MCP gateway are temporary and must be replaced by the BM25 and direct-tool path below.

- [ ] Support native extensions, skills, hooks, prompt templates, themes, MCP servers, and `AGENTS.md`.
- [x] Implement MCP natively against protocol version `2025-11-25`.
- [x] Implement the open Agent Skills format.
- [ ] Implement Agent Plugins installation without conversion.
- [ ] Apply the same capability grant and isolation checks to open-standard packages as converted packages.

### Progressive capability discovery

- [ ] Build one disposable BM25 index over enabled skill, tool, command, and agent metadata.
- [ ] Store each capability's name, kind, description, aliases, path, and project or global scope.
- [ ] Rank each user-authored turn before its first model request, with exact names and aliases first and project scope as the tie-breaker.
- [ ] Apply a fixed relevance threshold and disclose no more than three matches.
- [ ] Keep the stable prompt to a short statement that optional capabilities may be supplied with a request.
- [ ] Append only compact metadata and a path for matching skills, commands, and agents. Let the model use the normal read tool to load full bodies.
- [ ] Let explicit user requests such as `/skill:pull-request` bypass ranking and load the named capability.
- [ ] Expose a matching executable tool through its complete provider-native schema before inference, then dispatch it directly.
- [ ] Freeze the selected tool roster and implementation bindings through every continuation in that turn.
- [ ] Recompute the roster only at the next user-turn boundary and validate input again at dispatch.
- [ ] Record every disclosed capability in the canonical log.
- [ ] Remove disabled, unavailable, and untrusted capabilities before ranking. Discovery does not grant authority.
- [ ] Do not add embeddings, a vector database, provider-native `tool_search`, or generic untyped invocation for normal tool execution.
- [ ] Add a scoped harness-control capability for daemon RPCs.

### Blind credential foundation

- [ ] Represent every Axl-managed credential with an opaque identifier outside the secrets layer.
- [ ] Give each sandbox a per-session sentinel instead of the real credential.
- [ ] Keep real credentials in a broker outside the sandbox.
- [ ] Have the egress proxy validate the destination and requested credential scope before substituting a real value.
- [ ] Support bearer-token and basic-auth flows first.
- [ ] Reject authentication schemes that cannot be brokered safely instead of passing plaintext to an extension.
- [ ] Keep log redaction as a second layer of protection.
- [ ] Verify that managed credentials never enter model context or persistent session logs.

### Executable activation boundary

- [ ] Build a process host for third-party and adopted executable extensions before allowing them to activate.
- [ ] Run those processes under the selected sandbox and expose only capability RPC.
- [ ] Give untrusted processes bounded filesystem and network access plus credential handles, never raw managed credentials.
- [ ] Fail activation when required isolation is unavailable.
- [ ] Keep third-party in-process promotion out of v1.
- [x] Allow declarative skills before the executable process host exists.
- [x] Run local stdio MCP servers as sandboxed child processes.

### Initial first-party extensions

- [ ] Move web access behind the public extension API.
- [ ] Add static, rate-limited usage tips with dismissal and `/tip off`.
- [ ] Add plan mode with a submit-plan capability present only during planning.
- [ ] Add the terminal plan-review flow. Add browser annotations when the web client exists.

### Exit gate

The initial public registrations have real first-party consumers, each registration returns a disposer, disabled features leave no prompt, UI, or background work, and untrusted executable extensions cannot run in the daemon process.

## Phase 7: Complete permission and isolation system

### Permission profiles

- [ ] Implement `direct`, `auto`, `manual`, and `deny`.
- [ ] Use `direct` by default only when the requested operating-system sandbox is active.
- [ ] Fail startup when the requested sandbox is unavailable.
- [x] Add `axl --unsafe` as the only way to start without operating-system isolation.
- [ ] Default an unsafe session to `auto`, show the unsafe state in every client, and record it in the session log.
- [ ] Allow users to choose a stricter permission level while unsafe.
- [ ] Treat bypassing an active sandbox as a separate action that always requires approval.
- [ ] Do not present the classifier as a security boundary or use deterministic command rules in place of isolation.
- [ ] Show concise consequences for manual approvals.
- [ ] Build structured classifier input from resolved paths, domains, requested capability changes, and sandbox state.
- [ ] Constrain classifier output to policy-precomputed options.
- [ ] Log every automatic decision and reason.

### OS sandbox providers

- [ ] Complete Linux Bubblewrap support.
- [ ] Add Landlock capability detection and enforcement where available.
- [ ] Add seccomp filters and report their version.
- [ ] Add macOS Seatbelt support.
- [ ] Add Windows restricted-token, job-object, and ACL support, with WSL2 as the stronger documented path.
- [ ] Report the exact controls each provider can enforce.
- [ ] Fail session startup when required controls are unavailable.

### Full policy controls

- [ ] Add filesystem read/write allowlists and denials.
- [ ] Add network domain allowlists, denylists, and strict allowlist mode.
- [ ] Add local port, Unix socket, HTTP proxy, and SOCKS proxy policies.
- [ ] Block or mask credential files and secret environment variables.
- [ ] Add loopback-only port publishing by default.
- [ ] Add per-site explicit opt-in for authenticated browsing.

### Extension isolation hardening

- [ ] Add resource limits and lifecycle supervision to the Phase 6 extension process host.
- [ ] Verify that extension processes cannot bypass filesystem, network, or credential policy through host APIs.
- [ ] Keep trusted in-process execution limited to first-party extensions throughout v1.

### OCI runtime

- [ ] Detect Podman, Docker, and containerd/nerdctl rather than requiring one engine.
- [ ] Prefer rootless execution and report rootful operation.
- [ ] Support runc, crun, and youki capabilities.
- [ ] Report stronger gVisor and Kata isolation where installed.
- [ ] Implement create, workspace upload, start, attach, snapshot, stop, terminate, and termination verification.
- [ ] Generate runtime-spec configuration with read-only root, dropped capabilities, no-new-privileges, seccomp, masked paths, user namespaces, no devices, and cgroups v2 limits.
- [ ] Make termination idempotent and verifiable.
- [ ] Resolve images to platform-specific digests.
- [ ] Add signature, SBOM, and attestation verification policy.
- [ ] Use existing registry credential helpers without exposing credentials.
- [ ] Make offline cache behavior explicit.
- [ ] Route container DNS and egress through the policy proxy.
- [ ] Keep host home unmounted and inject secrets through non-snapshotted memory-backed paths.

### Dev containers and browser

- [ ] Drive the reference devcontainer tooling instead of inventing another format.
- [ ] Support image, Dockerfile, Compose, features, users, environment, mounts, and forwarded ports.
- [ ] Require first-run approval for lifecycle commands.
- [ ] Verify devcontainer feature artifacts under the image policy.
- [ ] Add the browser as an opt-in tool inside the same sandbox and network policy.
- [ ] Add screenshots, downloads, and local-app interaction without a policy bypass.

### Doctor

- [ ] Report detected runtimes, sandbox controls, rootless support, cgroups, missing binaries, credentials needing setup, elevated extensions, and policy mismatches.

### Exit gate

Adversarial tests cannot escape workspace path rules, tool egress policy, extension process capabilities, or required container isolation. Missing enforcement always blocks execution.

## Phase 8: Child sessions, modes, and orchestration

### Unified child contract

- [ ] Represent every subagent as a full child session with its own log and tree node.
- [ ] Implement start, send, interrupt, status, wait, snapshot, resume, and dispose.
- [ ] Expose child-agent lifecycle through daemon RPC and the public SDK so RPC clients never own an agent loop.
- [ ] Support fresh-context and forked-history children first.
- [ ] Add persistent background, local subprocess, OCI, remote, external-harness, and workflow-managed backends as needed.
- [ ] Make backend capability requests fail when unsupported.
- [ ] Return results to parents through explicit attributed events.
- [ ] Roll child budgets into the parent.
- [ ] Allow child policy only to narrow.
- [ ] Dispose children with their parent.

### Spawn authorities

- [ ] Implement user, script, goal, and bounded system authorities.
- [ ] Enforce authority through registry membership, not a disabled ambient tool.
- [ ] Keep ordinary sessions free of model-visible delegation by default.
- [ ] Require explicit user confirmation when natural language requests an authority-gated action.

### User-facing orchestration

- [ ] Add `/subagents` for explicit child creation.
- [ ] Add `/btw` threads forked from the current compacted surface.
- [ ] Keep side threads out of main-branch context and compaction.
- [ ] Allow explicit injection of a side-thread conclusion into the main branch.
- [ ] Add script-based workflows over the SDK without a workflow language.
- [ ] Add agent definitions in project and global `agents/` directories.
- [ ] Support model, thinking, tools, placement, and execution constraints in definitions.
- [ ] Require explicit disclosure when an imported plugin enables model-visible delegation.

### Goal mode

- [ ] Add persistent objectives with explicit completion criteria.
- [ ] Continue plan, act, verify, and correct until completion, a blocker, or a budget boundary.
- [ ] Allow bounded child attempts under goal authority.
- [ ] Persist goals through detach, restart, and placement changes.
- [ ] Run sandboxed unattended goals without prompts.
- [ ] Pause unsandboxed gated actions as visible blockers.
- [ ] Notify on blocked and completed goals.

### Plan mode completion

- [ ] Add exact-text comments, step removal, direct edits, general notes, revision, and approval.
- [ ] Reuse the annotation surface for review-inbox diffs.

### Exit gate

Child sessions remain inspectable, budgeted, cancellable, policy-narrowed, replayable, and non-ambient across every implemented backend.

## Phase 9: Full protocol, SDK, web, and viewer

Do not build public or multi-language SDKs before this phase. The second real client creates the need.

### Wire protocol

- [ ] Complete RPCs for session lifecycle, branching, transfer, configuration, permissions, placement, and commands.
- [ ] Add event subscription from any tree node.
- [ ] Add resumable cursors with at-least-once delivery.
- [ ] Add idempotency keys for sends and permission responses.
- [ ] Add the separate blob channel.
- [ ] Add revocable device credentials with observer and steering scopes.
- [ ] Add capability negotiation and loud version mismatch behavior.
- [ ] Add attachment presence.
- [ ] Add WebSocket transport while retaining local Unix sockets.

### SDK

- [ ] Package the authoritative TypeScript protocol definitions as the TypeScript SDK without introducing a generator.
- [ ] Make in-tree clients consume the public SDK surface.
- [ ] Publish the SDK only when an external consumer exists.
- [ ] Choose TypeSpec, Protobuf, or another generator only when the first non-TypeScript client creates a concrete need.
- [ ] Keep Swift and Kotlin generation in Phase 13 with mobile implementation.

### Web client

- [ ] Add localhost `code` and zero-tool `chat` modes.
- [ ] Render one conversation event projection.
- [ ] Add diff, terminal, read, search, web, workflow, and generic cards.
- [ ] Support extension-provided panels and nodes.
- [ ] Show permissions, budgets, costs, sandbox state, and background operations live.
- [ ] Support detach, reconnect, steering, follow-ups, and interruption.

### Session viewer and indexes

- [ ] Add per-session deterministic JSON sidecar caches.
- [ ] Build the session picker and aggregate stats from sidecars.
- [ ] Add SQLite FTS5 only when cross-session transcript search requires it.
- [ ] Keep every index disposable and rebuildable from JSONL.
- [ ] Add tree visualization, event timeline, usage, latency, tool inspection, permission reasons, compaction details, live tail, filtering, and subtree export.

### Media transport and roles

- [ ] Accept pasted, dropped, and referenced images.
- [ ] Send images directly to capable main models.
- [ ] Add explicit vision-description fallback events for non-vision models.
- [ ] Add optional OCR, speech recognition, and speech synthesis roles.
- [ ] Keep OCR and voice roles disabled with no default model.
- [ ] Send media through the blob channel and log every cross-model handoff visibly.

### Exit gate

Terminal and web clients attach simultaneously to one authoritative session, reconnect without loss, and render the same tree and state from the same protocol.

## Phase 10: Adoption compiler and compatibility catalog

Implement the unified child mechanism and extension isolation before model-driven conversion.

### Discovery and installation

- [ ] Scan known Pi, OpenCode, DSH, and Claude Code locations without executing discovered code.
- [ ] Present first-launch findings without a setup wizard.
- [ ] Add interactive `/adopt` and direct `axl install` commands.
- [ ] Add optional passthrough adoption syntax.
- [ ] Install MCP, `AGENTS.md`, Agent Skills, and Agent Plugins natively through the trust pipeline.

### Conversion pipeline

- [ ] Fetch and lock source by immutable version or commit.
- [ ] Inspect packages without executing them.
- [ ] Give the source and target extension contract directly to the conversion model.
- [ ] Generate native output in a staging directory with no network or host credentials.
- [ ] Treat package instructions as untrusted data.
- [ ] Typecheck and run available upstream tests in isolation.
- [ ] Allow one repair prompt when validation fails, then stop.
- [ ] Let generated tests supplement upstream tests without treating them as proof of semantic equivalence.
- [ ] Do not build feature-mapping rules, type-equivalence machinery, mutation analysis, differential fuzzing, or a custom semantic verifier for v1.
- [ ] Present the complete diff, requested permissions, unsupported behavior, and the checks that actually ran.
- [ ] Activate atomically only after approval.

### Compatibility behavior

- [ ] Assign `native`, `adapted`, `isolated`, or `unsupported` to every surface.
- [ ] Never substitute compatibility levels silently.
- [ ] Permit partial activation only after explicit acknowledgement.
- [ ] Fail the complete adoption when the primary entry surface is unsupported.
- [ ] Make unsupported calls fail explicitly instead of generating no-op stubs.

### Storage, provenance, and updates

- [ ] Store original source, converted output, tests, and `adoption.json` separately.
- [ ] Record source hash, license, notices, converter version, model settings, translations, unsupported behavior, capabilities, generated files, and verification.
- [ ] Estimate conversion time and model cost before execution.
- [ ] Cache conversion by source hash and converter version.
- [ ] Make deterministic verification independent of model repeatability.
- [ ] Store local conversion changes as overlay patches.
- [ ] Implement three-way update, diff, rollback, remove, and loud conflicts.

### Ecosystem order

- [ ] Pi resources.
- [ ] OpenCode resources.
- [ ] DSH resources.
- [ ] Claude Code resources and agent definitions.
- [ ] External harness children for Claude Code and Codex inside Axl-controlled isolation.

### Catalog

- [ ] Publish reproducible conformance entries for real packages.
- [ ] Let plugin authors run and verify the same suite.
- [ ] Track primary-surface and total-surface conversion rates.
- [ ] Require every failure to be named and visible.
- [ ] Feed reproducible catalog failures into contributor issues.

### Exit gate

A real third-party package from each initial ecosystem is adopted without modifying its source installation, runs inside required isolation, and updates or rolls back safely.

## Phase 11: Insights and evidence-gated learning

### Insights engine

- [ ] Scan session logs and permanently cache deterministic statistics.
- [ ] Extract model-generated facets per session with explicit refresh controls.
- [ ] Aggregate with temporal decay and week-over-week comparisons.
- [ ] Detect trends, anomalies, resolved friction, ongoing friction, overspend, and underspend.
- [ ] Compare suggestions against existing instructions, skills, extensions, and packages.
- [ ] Generate HTML and Markdown reports through parallel sections and synthesis.
- [ ] Add `/insights`, refresh, date-range, and Markdown commands.
- [ ] Treat reports as candidate generators rather than learning evidence.

### Learning ledger

- [ ] Create an append-only ledger separate from modified artifacts.
- [ ] Record tier, provenance, user-originated evidence, confidence, activation, and rollback.
- [ ] Add `/learn`, diff, why, forget, and rollback commands.
- [ ] Compare outcomes before and after changes.
- [ ] Group changes that activated together when evaluating regressions.
- [ ] Auto-revert regressing tier 1 automatic changes and ledger the reversion.

### Tier 1 instructions

- [ ] Keep tier 1 automatic by default while tiers 2 and 3 remain manual.
- [ ] Modify only the managed global `AGENTS.md` block.
- [ ] Enforce line and byte budgets, deduplication, conflict detection, locks, atomic writes, revisions, and rollback.
- [ ] Keep project-derived rules project-scoped.
- [ ] Require user-originated evidence before global promotion.
- [ ] Announce every automatic change immediately in every attached client with the rule, target file, evidence summary, diff command, and rollback command.
- [ ] Persist notifications when no client is attached and show them on the next attachment.

### Tiers 2 and 3

- [ ] Draft skills, prompt templates, workflows, and hooks.
- [ ] Draft native extensions in an explicitly experimental tier.
- [ ] Quarantine executable output.
- [ ] Require capability manifests, isolated type checks, tests, complete diffs, and explicit activation approval.
- [ ] Never permit automatic activation of generated executable code.
- [ ] Allow evidence-based first-party feature toggle proposals while respecting explicit user disables.
- [ ] Add one-command disable and rollback for generated artifacts.

### Project-start suggestions

- [ ] Inspect languages, frameworks, scripts, and CI.
- [ ] Suggest project-scoped capabilities without injecting suggestions into model context.
- [ ] Rate-limit suggestions and permanently honor dismissal.

### Exit gate

Every learned change is visible, evidence-backed, reversible, regression-tracked, and unable to execute new code without explicit approval.

## Phase 12: Cloud placement and subscription pooling

Resolve the first cloud provider and whether transfer moves or forks a session before this phase.

### Cloud workers

- [ ] Implement one trusted cloud adapter first.
- [ ] Add AWS ECS/Fargate, Azure jobs or container instances, GCP Cloud Run Jobs, Kubernetes, and generic SSH only after the contract proves itself.
- [ ] Implement requested, provisioning, starting, running, draining, terminating, and terminated states.
- [ ] Flush logs and artifacts before bounded graceful shutdown and forced termination.
- [ ] Tag every resource with session, owner, creation, expiry, and adapter version.
- [ ] Add an external reconciler for expired and orphaned resources.
- [ ] Revoke temporary credentials and verify resource absence.
- [ ] Use managed identities, workload identity, short-lived Git credentials, and external secret brokers.
- [ ] Add local, cloud, and attach placements plus transfer according to the chosen move-or-fork policy.

### Subscription pools

- [ ] Represent entitlements by credential reference, provider, models, windows, identity, weight, and state.
- [ ] Bind pools independently per model-calling role.
- [ ] Make a single entitlement a zero-configuration pool of one.
- [ ] Implement sticky-session routing first to preserve provider cache affinity.
- [ ] Add explicit round-robin, weighted, least-utilized, priority, and pinned strategies later.
- [ ] Track available, throttled, exhausted, degraded, and failed states.
- [ ] Spill over only when a request is safe to retry.
- [ ] Surface reauthentication instead of looping on invalid auth.
- [ ] Stop loudly when all members are exhausted.
- [ ] Never downgrade model or thinking level without an explicit setting and visible event.
- [ ] Enforce provider terms that prohibit pooling.
- [ ] Add `/pool` status, use, disable, and cost commands.
- [ ] Decide whether cross-provider and shared-team pools ship initially.

### Exit gate

A session moves or forks to the first cloud provider, survives client detachment, cleans up verifiably, and can spill between two authorized entitlements with switch reason and cache cost logged.

## Phase 13: Mobile, IDE, headless automation, and notifications

### Mobile clients

- [ ] Generate Swift and Kotlin SDKs from the protocol schema.
- [ ] Build native SwiftUI and Jetpack Compose clients.
- [ ] Add session list, start, open, live events, steering, permissions, diff review, detach, and reconnect.
- [ ] Add revocable device pairing and read-only observer mode.
- [ ] Exclude secrets and full file contents from notifications.
- [ ] Add iOS Live Activities and Android foreground notification actions.
- [ ] Decide whether hosted relay or direct daemon pairing ships first.

### IDE clients

- [ ] Add VS Code and JetBrains projections over the generated SDK.
- [ ] Keep agent logic in the daemon.
- [ ] Reuse protocol diff, terminal, permission, and session events.

### Headless and automation

- [ ] Add `axl run -p` with structured JSON output.
- [ ] Add CI and GitHub Action integration with session logs as artifacts.
- [ ] Add event subscriptions, webhooks, schedules, and wake-up behavior.
- [ ] Record trigger identity and acting user.
- [ ] Apply the same sandbox, budgets, logging, and authority rules as interactive sessions.
- [ ] Add push notifications for permission requests, blockers, completion, and pull-request events.

### Exit gate

Terminal, web, mobile, IDE, and headless clients remain projections of one daemon protocol with no duplicated loop or business state.

## Phase 14: Derived product features

Build these only after their underlying primitives are used and stable.

### Session-tree features

- [ ] What-if branch reruns with model, prompt, or approach changes.
- [ ] Side-by-side branch comparison and winner selection.
- [ ] Cross-model second opinion on the current diff.
- [ ] Shareable, scrubbed subtree replays.

### Learning-derived features

- [ ] Cost autopilot with explicit routing reasons and escalation behavior.
- [ ] Guardrail hooks drafted from repeated failures.
- [ ] Pull-only cross-session recall.
- [ ] Daily session, cost, and blocker digest.

### Daemon and placement features

- [ ] Mission control across repositories and placements.
- [ ] Live app previews tunneled from cloud sessions.
- [ ] Review inbox with batch diff approval using the plan annotation surface.

### Adoption and security features

- [ ] Checked-in team profile lockfile.
- [ ] Personal configuration synchronization.
- [ ] Per-session zero-egress privacy mode with a local model.
- [ ] Blind-secret placeholders with execution-time injection.

### Exit gate

Each derived feature is implemented from existing public primitives without expanding the kernel or creating a private first-party API.

## Phase 15: Release and ecosystem hardening

### Diagnostics and compatibility

- [ ] Complete `/doctor` coverage for installed harnesses, incompatible resources, API drift, dependency conflicts, cloud readiness, generated artifacts, and leaked resources.
- [ ] Meet the compatibility catalog targets from `HARNESS_PLAN.md`.
- [ ] Add bench replay with live models and tools in disposable sandboxes.
- [ ] Build the personal model comparison surface from real session replays.

### Supply chain and release

- [ ] Generate release SBOMs.
- [ ] Produce keyless Sigstore provenance attestations.
- [ ] Sign release tags through the workflow identity.
- [ ] Verify attestations before publishing.
- [ ] Make publication idempotent and resume-safe.
- [ ] Publish release-verification instructions.
- [ ] Publish signed Axl base images with SBOMs and provenance.
- [ ] Separate package, Android, and iOS release trains.

### Security maturity

- [ ] Publish the security assurance case.
- [ ] Add OSS-Fuzz coverage for adoption inspectors, session imports, dialect renderers, and the event-log reader.
- [ ] Keep OpenSSF Scorecard above the project target.
- [ ] Complete the OpenSSF Best Practices Gold requirements.
- [ ] Establish private vulnerability reporting and the documented response windows.

### Final product-thesis gate

- [ ] One-command installation works.
- [ ] Existing Pi, OpenCode, and DSH resources are detected.
- [ ] A real plugin is adopted with provenance, verification, permissions, and unsupported behavior visible.
- [ ] The adopted plugin runs in the terminal and web clients against one session inside required isolation.
- [ ] Detach, reconnect, update, and rollback work.
- [ ] A cloud session can be watched and steered from mobile.
- [ ] A mobile permission request can be answered safely.
- [ ] A second entitlement continues a session after the first is exhausted, with the reason and cache cost visible.

## 3. Features intentionally not scheduled

Do not implement these unless the product plan changes:

- Another skill format.
- Another MCP replacement.
- A second provider abstraction above the Pi-inspired contract.
- A plugin marketplace before adoption is reliable.
- Default model-controlled subagents in ordinary sessions.
- A custom workflow language.
- Automatic activation of generated executable code.
- Silent emulation of unsupported APIs.
- A general cowork surface before the Code surface is excellent.
- Ambient memory that injects past sessions without an explicit pull.
- Process-level container checkpointing.
- Native Windows containers.

## 4. Decision checkpoints

Resolve each decision only before its dependent phase:

| Decision | Required before |
| --- | --- |
| Package namespace and executable name | Phase 0 |
| Event and protocol versioning | Phase 1 |
| First real model provider | Phase 2, resolved 2026-08-29: Azure OpenAI |
| Trusted in-process extension promotion | Phase 7 |
| Initial ecosystem compatibility promise | Phase 10 |
| Global and project learning budgets | Phase 11 |
| First cloud provider | Phase 12 |
| Cloud transfer as move or fork | Phase 12 |
| Cross-provider and shared-team pooling | Phase 12 |
| Hosted relay or direct mobile pairing | Phase 13 |

## 5. Immediate next slice

Sandbox execution is the active user-approved priority. Follow [plan.md](plan.md) and [RFC 0001](docs/architecture/rfcs/0001-sandbox-execution.md) in complete vertical slices:

1. Add explicit readable roots to kernel path policy and make the default runtime workspace-only.
2. Harden native process isolation and report only controls actually enforced.
3. Add the rootless local OCI backend and verify cleanup.
4. Add one self-hosted remote Linux worker before selecting a managed provider.
5. Stop at each plan exit gate and verify the security boundary before continuing.

After the sandbox priority is complete, return to these dogfood fixes before other Phase 5 work:

1. Add interactive-only `ask_user_question` with visible blocker behavior for non-interactive goals.
2. Build the local BM25 capability index and log the three-or-fewer records disclosed for each user turn.
3. Replace the generic MCP gateway with selected provider-native tool schemas and frozen per-turn dispatch bindings.
4. Add the bearer-token and basic-auth credential broker before using credentialed third-party processes in dogfood sessions.
5. Stop and verify these paths before returning to web access or compaction.
