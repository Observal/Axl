<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Session profiles

A session profile selects the tools and optional capabilities that Axl exposes to the model. Profiles belong to individual sessions, not daemon processes or clients. One daemon can therefore own sessions with different profiles, and every attached client observes the profile recorded for its session.

Axl currently supports two profiles:

| Profile | Model-visible tools | Skills | MCP | `web_fetch` and `web_search` |
| --- | --- | --- | --- | --- |
| `standard` | `bash`, `read`, `write`, `edit`, `web_fetch`, and `web_search` when enabled | Discovered and exposed when configured | Loaded and started when configured | Enabled by default and configurable |
| `exec` | `bash` only | Not discovered or exposed | Configuration is not parsed and servers are not started | Disabled |

`standard` is the default. Use `exec` when Bash alone is sufficient and you want the smallest available tool surface.

## Start an exec session

Select the profile when creating a session:

```bash
axl --profile exec
```

You can combine it with normal model, thinking, workspace, and sandbox options:

```bash
axl --profile exec --cwd ~/code/project --thinking high

axl --profile exec \
  --sandbox podman \
  --image docker.io/library/bash@sha256:<64-hex-digest>
```

The profile is fixed when the session is created. `--profile` cannot be used with a session ID, `--resume`, or the `daemon` command. Resume uses the profile already recorded for that session. Existing sessions created before profiles were recorded resume as `standard` sessions so their previous behavior is preserved.

Run `/status` in the terminal client to see the active profile.

## What exec keeps

An exec session still uses the normal Axl session machinery:

- The daemon owns the agent loop, operation lifecycle, and canonical event log.
- Global and project `AGENTS.md` instructions remain active.
- Model and thinking-level selection work normally.
- Bash runs through the configured native or OCI sandbox.
- Tool calls, results, sandbox state, model configuration, and the selected profile are recorded in JSONL.
- Reloads, model changes, daemon restarts, forks, and clones retain the profile.

The `bash` tool accepts a command, an optional working directory, and an optional timeout. It returns bounded combined output and exit information. Large output is truncated for the model while the complete output is preserved by the runtime.

## What exec removes

The runtime does not merely tell the model to avoid other tools. It leaves them out of session assembly:

- `read`, `write`, and `edit` are not registered.
- `web_fetch` and `web_search` are disabled, even if web defaults or command-line flags enable them.
- Skill directories are not discovered, and skill catalog text is not added to the prompt.
- MCP configuration is not parsed, MCP packages are not loaded, and MCP servers are not started.

As a result, disabled capabilities contribute no model-visible tool schemas or prompt sections and create no daemon-side MCP work.

## Why use it

Bash can cover repository inspection, editing, tests, builds, and version-control commands through standard command-line programs. A single tool can reduce:

- Tool-schema tokens sent with each model request
- Tool-selection ambiguity
- Startup work from Skills and MCP
- Model round trips when several operations fit safely in one shell command or script

The improvement depends on the workload. It is usually largest when the standard session would load many Skills or MCP tools. For a small repository with no optional capabilities, model inference and command execution may dominate, so the speed difference can be modest.

## Tradeoffs

A smaller tool surface is not always a better working surface:

- Shell-based file edits can be more error-prone than exact-match editing tools.
- Raw command output can consume more context than bounded, structured file operations.
- Specialized tools provide clearer validation, rendering, and audit detail.
- A model may need additional shell calls to perform work that one dedicated tool could complete.
- Skills, MCP integrations, and built-in web access are unavailable to the model in the session.

Use `standard` for general interactive development. Use `exec` for benchmarks, constrained environments, shell-oriented models, and tasks where minimal startup and prompt overhead matter more than specialized tooling.

## Security

The exec profile is a capability-shaping option, not a security boundary. Bash can read and modify files, launch subprocesses, and use any operating-system capability available inside its environment.

Sandbox policy remains the security boundary:

- Native sessions use the detected operating-system sandbox.
- OCI sessions use the selected digest-pinned image and container policy.
- If required isolation is unavailable, Axl fails closed.
- `axl --unsafe --profile exec` still gives Bash the user's full host authority and retains the persistent unsafe warning.

Choosing one model-visible tool does not make unsafe execution safe.

## Client independence

The terminal client currently exposes `--profile` and displays the selected value, but it does not enforce profile behavior. The client sends the requested profile through `session.create`; the daemon retains it; and the runtime builds the allowed tool roster.

Any future web, IDE, mobile, headless, or SDK client can use the same protocol field. Clients that attach to an existing session receive the profile from the canonical event stream rather than maintaining their own profile state.
