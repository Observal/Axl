<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# RFC 0002: Bash-only exec profile

Status: Implemented

## Summary

Add an `exec` session profile whose only model-visible tool is the canonical `bash` tool. The tool continues to execute through the configured operating-system sandbox. Exec sessions do not discover or activate Agent Skills or MCP servers.

## Motivation

Some users and model benchmarks need the smallest practical execution surface. The existing standard runtime exposes Bash, file tools, and web tools, then adds Skills and MCP when configured. Hiding those capabilities only in prompt text would be insufficient because their schemas and implementations would remain available.

The profile must therefore constrain runtime assembly below prompt construction. It must also remain reconstructable from the canonical event log and survive daemon restart.

## Decision

- Add `standard` and `exec` as the currently supported session profiles.
- Default sessions without a recorded profile to `standard` for compatibility with existing logs.
- Add the profile to `session.create`. Profiles remain fixed for a session in this slice.
- Record the effective profile as `config.profile` whenever a runtime opens.
- In `exec`, register only the sandbox-provided canonical `bash` tool.
- Skip Skills discovery, skill catalog prompt content, MCP configuration parsing, and MCP manager creation in `exec`.
- Keep global and project `AGENTS.md` instructions and essential constraints active.
- Keep sandbox behavior unchanged. `exec` is a smaller model interface, not a security boundary.
- Keep the canonical tool name `bash`. Provider-specific naming remains a tool-dialect concern.

## Compatibility

Existing logs do not contain `config.profile`. Resume treats those sessions as `standard`, which preserves their prior runtime behavior. The local wire protocol validates the optional profile on session creation. Unsupported values fail loudly.

Forks, clones, model switches, reloads, and daemon restart retain the selected profile. Mid-session profile switching is deferred until the complete profile configuration work.

## Security

Exec mode does not weaken or replace operating-system isolation. Safe sessions continue to run Bash through Bubblewrap or the selected platform provider. Unsafe sessions still provide Bash with the user's full host access and retain the existing persistent warning.

Disabled Skills and MCP servers contribute no schemas, prompt content, credential resolution, process startup, or background work.

## Alternatives considered

### Prompt-only instruction

Rejected because hidden tools would remain callable and disabled extensions could still perform background work.

### Daemon-wide mode

Rejected because one daemon must own sessions with different configurations.

### Reuse the minimal profile

Rejected because the minimal profile includes file editing, while `exec` promises Bash alone.

## Verification

The implementation includes protocol validation, daemon restart and rebuild tests, runtime tests with deliberately invalid disabled MCP configuration, TUI projection tests, and CLI validation. The runtime test verifies that an exec session records exactly one `tool.schema`, named `bash`.
