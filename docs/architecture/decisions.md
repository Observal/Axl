<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Foundation decisions

These decisions set the package and compatibility boundaries established during Phase 0.

## Names

`Axl`, the `@axl/*` scope, and the `axl` executable are working names. Packages remain private until naming is reviewed for the first public release.

## Dependencies

`packages/protocol` owns shared event and RPC definitions and has no runtime dependencies.

`packages/kernel` owns the event log, agent loop, tool execution, cancellation, policy enforcement, extension-host lifecycle, client attachment, and worker lifecycle. It may import only `packages/protocol` and Node.js built-ins.

Other packages use the kernel through public exports. Extensions cannot import private kernel paths.

Linux filesystem confinement uses `@deepseek-ai/node-addon-landlock-run` 0.1.1 from <https://github.com/deepseek-harness/deepseek-harness>. Axl uses its published JavaScript API and unmodified platform launcher as a dependency. The reviewed entry tarball SHA-256 was `02c123a4eb4acedfd386fe06192dcf05e7fbb96e2845de9e2958efee4b4f0b92`. The Linux x64 platform tarball was `392e5ee27297117a058728f3a938a5b5b3302c16b423ee2a2f2dbdf612a6c0a9`, containing launcher SHA-256 `a752bc72f111fcc573c3e61fb90fa544541dac0ca498d2e279e1630d7c659b31`. The Linux arm64 platform tarball was `ecbbe99368422ac4f28a0bcf8dc3e4cb8c0a24086fb9b73cc21e77433d5d5dc8`, containing launcher SHA-256 `f6ae2ad5893e3123f45329ade5518b33c3ac3b102978001ff1c6a6a8ebe2ad9b`. The entry tarball includes an MIT notice while its package metadata declares BSD-3-Clause; the platform packages include BSD-3-Clause. Axl retains the dependency notices and does not copy or modify launcher source.

These rules are stricter than the external architecture inspected for Phase 0. DSH at `cd5ef8148158c3a752a658978873241fdf8e2bbc` builds its loop from several workspace packages and uses Schemastery at runtime. Axl treats it as a read-only behavioral reference, not as a package-layout template.

## Event identity

Event, session, and operation IDs are opaque lowercase RFC 9562 UUIDs. Their owning component uses the platform's cryptographic UUID generator. Every event includes its session ID and parent event ID. Events include an operation ID only when an operation owns them.

## Versioning

- The JSONL event format remains version `1`.
- The current local wire protocol is version `8`; version `1` was the initial protocol.
- Before the first stable release, readers and clients accept only an exact supported version. Later client-protocol work may introduce compatibility ranges.

## Event-log durability and redaction

Each session has one serialized append queue. An append writes a complete newline-terminated event, syncs the file, and restores the previous length if either step fails. Startup keeps every valid complete line, removes an unfinished final line, and reports malformed complete lines as corruption.

Redaction happens before serialization. Version 1 masks known credential fields and replaces configured secret values in payload strings. Tool schemas keep property names that resemble secrets because those names describe fields rather than contain credentials.

## Extension isolation

Third-party extensions start in isolation. Trusted in-process execution requires a later reviewed decision.

## First model provider

Decision from 2026-08-29: the first production adapter uses Azure OpenAI's Responses API with API-key authentication. The OpenAI tool dialect is the first provider dialect. Tests continue to use the deterministic fake provider. Broader provider and authentication support belongs to later phases.

## Session resume across placements

Native, OCI, and unsafe daemons retain separate state and execution authority. The local runtime may build a read-only catalog from their canonical logs. `axl -r`, `axl --resume`, and `/resume` show that combined catalog. Selecting a row marked `UNSAFE` is an explicit unsafe-mode choice; the client reconnects to the owning daemon and preserves the persistent unsafe warning.

## Standard tool names and web defaults

The standard model-visible tools are `read`, `write`, `edit`, `bash`, `web_fetch`, and `web_search`. Historical `shell` events remain valid and are projected to the renamed `bash` tool when resumed. Web tools start enabled and may be removed independently from a session through startup flags or terminal settings. Their effective state is recorded as `config.tools`, and changing it creates a tool-dialect boundary.

The built-in web transport uses pinned public DNS results, rejects private and reserved addresses across redirects, forwards no ambient credentials, and bounds request time and response size. Keyless search uses DuckDuckGo Instant Answers. A configured `BRAVE_SEARCH_API_KEY` selects Brave Search and is included in write-boundary redaction. Full egress policy and credential brokering remain later work.

## Generated files

Generated TypeScript files use the `*.generated.ts` suffix and begin with `@generated by <generator>; do not edit.` Their TypeScript generator must support `--check`, which `pnpm check:generated` runs. Edit the source and regenerate instead of changing generated output directly.
