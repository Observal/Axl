<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Axl

Axl, short for Axolotl, is an agent harness that works with existing tools, models, and client setups. A single daemon owns each session, while terminal and future clients render the same event stream.

**Current status:** phases 0 through 4 of the [technical implementation roadmap](ROADMAP.md#technical-implementation-roadmap) are complete. The TUI, Agent Skills, MCP support, native Linux hardening, and local OCI execution were brought forward from later phases. Other later-phase work has not started.

## Install

Axl requires Node.js `^22.19.0` or `>=24`. Native sandboxed execution requires Bubblewrap on Linux; Axl installs its pinned Landlock launcher dependency. macOS uses Seatbelt. Local OCI execution optionally uses rootless Podman or Docker with seccomp and cgroups v2.

Install the package from npm:

```bash
npm install --global @observal/axl
```

Or install the latest package artifact from GitHub Releases with checksum verification:

```bash
curl -fsSL https://github.com/Observal/Axl/releases/latest/download/install.sh | sh
```

Install a specific GitHub release by setting `AXL_VERSION`:

```bash
AXL_VERSION=v0.1.0 \
  curl -fsSL https://github.com/Observal/Axl/releases/download/v0.1.0/install.sh | sh
```

Axl has not published its first release yet. These commands become available after the first release passes the gate in [RELEASES.md](RELEASES.md).

Configure Azure OpenAI and start Axl:

```bash
axl login
axl
```

The `axl` command connects to the local daemon and starts one in the background when necessary. Pass a session ID to resume earlier work, or open the all-placement resume picker with `-r`:

```bash
axl <session-id>
axl -r
axl --cwd ~/code/project
axl daemon
axl doctor
```

The resume picker includes native, OCI, and unsafe histories. Every row shows its placement, and unsafe sessions are marked `UNSAFE` before selection.

The TUI supports multiline editing, model and theme selection, daemon-owned steering and follow-up prompts, manual context compaction with `/compact [instructions]`, compact tool output, session metrics, and terminal scrollback. While a turn runs, Enter steers it after the current tool-call batch and Alt+Enter queues a follow-up for when it would otherwise finish. Run `/help` for commands and keys. Run `/quit` to detach without stopping the session.

Axl will not run shell tools when the required sandbox is unavailable. On Linux, the native provider requires working Bubblewrap, Landlock, and the versioned Axl seccomp policy. `axl doctor` reports the controls available on the host.

To use a local OCI sandbox, first pull an image and pass its immutable digest:

```bash
podman pull docker.io/library/bash:5.2.37
axl --sandbox podman \
  --image docker.io/library/bash@sha256:<64-hex-digest>
```

Replace `podman` with `docker` to use the Docker adapter. Axl never pulls implicitly and rejects mutable image tags.

To opt out explicitly, start a separate unsafe daemon and session with:

```bash
axl --unsafe
```

Unsafe mode disables operating-system isolation and file-tool path policy. Bash commands, MCP stdio servers, reads, writes, and edits run with the user's full host access. Axl stores unsafe sessions separately under `~/.axl/unsafe/`, records the unenforced sandbox state, and keeps a warning visible in the terminal client. Selecting a visibly marked unsafe session from `axl --resume` is also an explicit unsafe-mode choice.

## Built-in tools

The standard session exposes `read`, `write`, `edit`, `bash`, `web_fetch`, and `web_search`. Web tools are enabled by default and can be toggled per session in `/settings` or at startup:

```bash
axl --no-web-fetch
axl --no-web-search
axl --no-web
```

`web_fetch` accepts public HTTP and HTTPS URLs, blocks private and reserved destinations, limits redirects and response size, and returns readable or raw text. `web_search` uses the keyless DuckDuckGo Instant Answer API by default. Set `BRAVE_SEARCH_API_KEY` for ranked Brave Search results.

## Packages

| Package | Responsibility |
| --- | --- |
| `packages/protocol` | Event and local wire contracts with no runtime dependencies |
| `packages/kernel` | JSONL history, replay, the agent loop, tools, and path policy |
| `packages/ai` | Provider contracts, credentials, dialects, and the built-in Azure OpenAI model catalog |
| `packages/daemon` | Authoritative sessions and Unix-socket transport |
| `packages/runtime` | Client-independent provider, tool, extension, and sandbox assembly |
| `packages/sandbox` | Required operating-system confinement |
| `packages/cli` | `axl` executable, local process startup, and client selection |
| `packages/tui` | Interactive terminal projection over the daemon protocol |
| `packages/extensions/skills` | Agent Skills discovery, validation, and progressive loading |
| `packages/extensions/mcp` | MCP 2025-11-25 over stdio and Streamable HTTP |

## Project documents

- [Setup](SETUP.md)
- [Development guide](docs/DEVELOPMENT_GUIDE.md)
- [Contributing](CONTRIBUTING.md)
- [Governance](GOVERNANCE.md)
- [Product vision and technical roadmap](ROADMAP.md)
- [Repository structure](CODE_STRUCTURE.md)
- [Release guide](RELEASES.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)

## Development

```bash
git clone https://github.com/Observal/Axl.git
cd Axl
pnpm install --frozen-lockfile
pnpm run install:cli
pnpm check
reuse lint
```

See the [development guide](docs/DEVELOPMENT_GUIDE.md) for architecture, focused test commands, contribution workflow, and debugging.

## License

Axl is licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
