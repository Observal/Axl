<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Set up Axl

## Requirements

- Node.js `^22.19.0` or `>=24`
- pnpm `10.34.4`
- Git
- Bubblewrap on Linux for agent shell commands
- Python 3.11+, uv, and pre-commit if you want to run local license hooks

## Install and check the repository

```bash
pnpm install --frozen-lockfile
pnpm check
```

To run the license check locally:

```bash
uv tool install reuse==6.2.0
reuse lint
```

## Install the CLI

```bash
pnpm run install:cli
```

Set the Azure OpenAI credentials in your shell:

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://your-resource.openai.azure.com/
```

You can also set `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_RESOURCE_NAME`, and `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`. Exported endpoint, API-version, and deployment settings override values saved by an earlier interactive login. A stored API key still takes precedence over `AZURE_OPENAI_API_KEY`.

Start a new session, resume by ID, or open the all-placement resume picker:

```bash
axl
axl <session-id>
axl -r
```

`axl -r` and `axl --resume` list native, OCI, and unsafe histories across workspaces. Each row shows its placement. Selecting a row marked `UNSAFE` explicitly reconnects to the unsafe daemon and retains the persistent warning.

The client uses `~/.axl/axl.sock`. It starts a detached local daemon when one is not already running. Use `axl daemon` to keep the daemon in the foreground for troubleshooting. Restart an existing daemon after changing exported environment variables because a running process cannot inherit later shell changes.

### Daemon lifecycle and upgrade recovery

`/detach` leaves work and the daemon running. `/quit` interrupts work, drains accepted requests and history, shuts down the daemon, and exits. The single-session case does not require a separate interruption or confirmation. If other sessions or clients are affected, the TUI lists them and asks before proceeding. Escape interrupts without quitting. Ctrl+C clears the draft; a second press within 500 ms quits. Ctrl+D quits on an empty draft.

```bash
axl daemon status
axl daemon stop
axl daemon restart
axl daemon stop --interrupt --yes
```

Use the same `--unsafe`, `--sandbox`, `--image`, or `--socket` selection as the running daemon. Status and stop do not require provider credentials. Restart refuses to switch data directories. Stop and restart refuse active work unless `--interrupt` explicitly authorizes cancellation. `--yes` confirms disconnecting clients. A changed confirmation snapshot requires a fresh command. Exit codes are 0 for success, 1 for errors, 2 for refused or stale confirmation, and 3 for a missing daemon on status or stop. Restart starts a missing daemon.

An incompatible session wire fails loudly and points to these commands. No daemon is automatically replaced on a version mismatch. Host-control version 1 operates independently of session wire version 13 on a separate connection to the same owner-only Unix socket. It does not bypass the session handshake.

If graceful cleanup fails or exceeds the host's ten-second wait, inspect `axl daemon status`. Shutdown can still be running. The TUI offers a separate force confirmation when available. From the CLI, explicitly request:

```bash
axl daemon stop --force --yes
```

Force is accepted only after graceful shutdown has begun, and only by the same daemon instance. It asks the trusted process host to terminate itself. It never signals a PID taken from a lock file. Forced termination may lose unflushed data or leave tool processes running. If the process cannot service control requests at all, force through this channel is unavailable.

For older daemons without host control, Linux hosts can use verified OS recovery:

```bash
axl daemon status
axl daemon restart --interrupt --yes
```

Use `restart`, not `--restart`, and keep the same placement flags as the old daemon. Recovery requires Linux pidfs, readable `/proc`, and `/usr/bin/getino`, `/usr/bin/kill`, and `/usr/bin/waitpid` with `PID:inode` support. Status verifies the owner-only data directory, socket and lock, process owner, Node executable, Axl entry point, command arguments, process HOME, and listening socket ownership. The old daemon must use the same Node executable and Axl entry point as the current CLI. Its active work and clients remain unknown, so both `--interrupt` and `--yes` are mandatory even for an apparently idle daemon.

The CLI rechecks the snapshot, sends SIGTERM only to the verified non-reusable process identity with an installed SIGTERM handler, and waits for exit before restarting. It never falls back to signaling a bare PID, deletes an active lock, or escalates to SIGKILL. `--force` remains available only through host control. Ordinary startup still refuses incompatible daemons without replacing them.

If OS verification or the required utilities are unavailable, recovery fails closed. Manually inspect the old process with operating-system tools and verify its command, owner, and socket before sending SIGTERM. A PID in `.axl-data.lock` alone is not proof. Do not kill every Node process. Once the old process has exited, normal startup reclaims its stale socket and lock. Preserved sessions remain resumable.

### Model request limits

Ordinary requests default to the selected model's advertised output maximum. Axl reduces that ceiling only when needed to fit the estimated input plus 4,096 reserved tokens inside the model context window. Every request sends an explicit provider output ceiling. The selected reasoning level remains unchanged. Providers that use explicit thinking-token budgets reserve at least 1,024 tokens for the answer.

The HTTP idle timeout defaults to five minutes and applies separately while waiting for response headers and between response-body bytes. Streaming bytes, including SSE heartbeat comments, refresh it. It is not an absolute turn or request deadline. A timeout is reported separately from user cancellation and is never automatically retried after dispatch because provider acceptance may be uncertain.

Show or change daemon-owned settings in the TUI:

```text
/request
/request output 8192
/request output model
/request idle 300000
/request idle disabled
```

For a new CLI session, use `--max-output-tokens <n|model>` and `--http-idle-timeout <milliseconds>`. Zero disables the idle timeout. Effective settings are recorded in canonical history and shown by `/status`. Axl has no numerical model-call ceiling or absolute turn-duration limit. Session budgets and proactive compaction remain separate features.


Inspect local sandbox support without configuring provider credentials:

```bash
axl doctor
```

On Linux, native execution requires Bubblewrap plus the pinned Landlock launcher installed with Axl. Axl applies its versioned seccomp policy and fails startup when Bubblewrap, Landlock, or seccomp cannot be enforced.

On Ubuntu, install the local container prerequisites with:

```bash
sudo apt-get install podman uidmap slirp4netns fuse-overlayfs crun
```

For OCI execution, use rootless Podman or a Docker engine with seccomp and cgroups v2. Pull the selected image explicitly, record its digest, and start Axl with the digest-pinned reference:

```bash
podman pull docker.io/library/bash:5.2.37
podman image inspect docker.io/library/bash:5.2.37 --format '{{.Digest}}'

axl --sandbox podman \
  --image docker.io/library/bash@sha256:<64-hex-digest>
```

Docker uses the same contract:

```bash
axl --sandbox docker \
  --image docker.io/library/bash@sha256:<64-hex-digest>
```

Axl never pulls an OCI image implicitly. Podman must be rootless. Docker privilege and VM isolation are reported by `axl doctor` and recorded in each session. Prefer rootless Docker or Docker Desktop's VM-backed engine. Access to a rootful Linux Docker socket is root-equivalent host authority for the trusted Axl daemon, even though the tool container remains restricted. OCI sessions use separate state directories keyed by engine and image digest.

## Global and project configuration

Axl reads global configuration from `~/.axl`:

- `AGENTS.md` for global instructions
- `skills/<name>/SKILL.md` for global Agent Skills
- `mcp.json` for global MCP servers
- `credentials.json` for credentials managed by `axl login`
- `settings.json` for model, thinking, web-tool, theme, and terminal preferences

Credentials and settings apply in every workspace. Axl also reads `AGENTS.md`, `.axl/skills`, and `.axl/mcp.json` from the workspace root. A project skill or MCP server replaces the global entry with the same name. Reload the session after changing instructions, skills, or MCP configuration.

## Session profiles

The `standard` profile is the default. It exposes `read`, `write`, `edit`, `bash`, `web_fetch`, and `web_search`, then adds configured Skills and MCP servers.

Use the `exec` profile to create a Bash-only session:

```bash
axl --profile exec
```

The profile is fixed for the session and survives daemon restart. Exec sessions keep normal `AGENTS.md` instructions and sandbox enforcement, but do not register file tools, `web_fetch`, or `web_search`. They also skip Skill discovery, MCP configuration parsing, and MCP server startup. See [Session profiles](docs/session-profiles.md) for lifecycle, performance, and security details.

`web_fetch` and `web_search` are enabled by default in standard sessions. Toggle them for the current session through `/settings`, or set their initial state from the command line:

```bash
axl --no-web-fetch
axl --no-web-search
axl --no-web
```

`web_search` uses DuckDuckGo's keyless Instant Answer endpoint by default. For ranked Brave Search results, export `BRAVE_SEARCH_API_KEY`. `web_fetch` accepts only public HTTP and HTTPS destinations and rejects private, loopback, link-local, and reserved addresses.

## Unsafe mode

Use `--unsafe` only when you explicitly need to run without operating-system confinement:

```bash
axl --unsafe
axl daemon --unsafe
```

This disables Bubblewrap or Seatbelt and removes file-tool path restrictions. Bash commands, reads, writes, edits, and local stdio MCP servers receive the user's full host authority. The TUI displays a persistent warning, and the canonical log records `sandbox.configured` with `enforced: false`.

Unsafe mode uses a separate daemon socket and session directory under `~/.axl/unsafe/`. This prevents a normal client from silently attaching to an unsafe daemon. Provider credentials remain in the normal credential store.

## Add Agent Skills

Put skills in either location:

```text
~/.axl/skills/<name>/SKILL.md
<workspace>/.axl/skills/<name>/SKILL.md
```

A project skill overrides a global skill with the same name. Axl validates the [Agent Skills format](https://agentskills.io/specification), adds skill metadata to the startup prompt, and loads full instructions only when the model selects that skill.

## Add MCP servers

Put global MCP configuration in `~/.axl/mcp.json` or project configuration in `<workspace>/.axl/mcp.json`. Axl supports MCP `2025-11-25` over stdio and Streamable HTTP, including OAuth. See [`packages/extensions/mcp/README.md`](packages/extensions/mcp/README.md) for the schema and security rules.

## Development commands

```bash
pnpm build
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm check:boundaries
pnpm check:generated
pnpm audit --audit-level high
```

Once the canonical GitHub repository exists, apply the settings in [docs/repository-settings.md](docs/repository-settings.md).
