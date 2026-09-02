<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Axl

Axl, short for Axolotl, is an agent harness that works with existing tools, models, and client setups. A single daemon owns each session, while terminal and future clients render the same event stream.

**Current status:** phases 0 through 4 of the [implementation plan](IMPLEMENTATION_PLAN.md) are complete. The TUI, Agent Skills, and MCP support were brought forward from later phases. Other later-phase work has not started.

## Run Axl locally

You need:

- Node.js `^22.19.0` or `>=24`
- pnpm `10.34.4`
- Bubblewrap on Linux
- An Azure OpenAI API key and endpoint

```bash
git clone https://github.com/Haz3-jolt/Axl
cd Axl
pnpm install --frozen-lockfile
pnpm run install:cli

export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://your-resource.openai.azure.com/
axl
```

The `axl` command connects to the local daemon and starts one in the background when necessary. Pass a session ID to resume earlier work:

```bash
axl <session-id>
axl --cwd ~/code/project
axl daemon
```

The TUI supports multiline editing, model and theme selection, queued prompts, compact tool output, session metrics, and terminal scrollback. Run `/help` for commands and keys. Run `/quit` to detach without stopping the session.

Axl will not run shell tools when the required sandbox is unavailable. To opt out explicitly, start a separate unsafe daemon and session with:

```bash
axl --unsafe
```

Unsafe mode disables operating-system isolation and file-tool path policy. Shell commands, MCP stdio servers, reads, and edits run with the user's full host access. Axl stores unsafe sessions separately under `~/.axl/unsafe/`, records the unenforced sandbox state, and keeps a warning visible in the terminal client.

## Packages

| Package | Responsibility |
| --- | --- |
| `packages/protocol` | Event and local wire contracts with no runtime dependencies |
| `packages/kernel` | JSONL history, replay, the agent loop, tools, and path policy |
| `packages/ai` | Provider contracts, credentials, dialects, and the full Pi-compatible Azure OpenAI model catalog |
| `packages/daemon` | Authoritative sessions and Unix-socket transport |
| `packages/runtime` | Client-independent provider, tool, extension, and sandbox assembly |
| `packages/sandbox` | Required operating-system confinement |
| `packages/cli` | `axl` executable, local process startup, and client selection |
| `packages/tui` | Interactive terminal projection over the daemon protocol |
| `packages/extensions/skills` | Agent Skills discovery, validation, and progressive loading |
| `packages/extensions/mcp` | MCP 2025-11-25 over stdio and Streamable HTTP |

## Project documents

- [Setup](SETUP.md)
- [Product plan](HARNESS_PLAN.md)
- [Implementation plan](IMPLEMENTATION_PLAN.md)
- [Repository structure](CODE_STRUCTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)

## Development

```bash
pnpm install --frozen-lockfile
pnpm check
reuse lint
```

## License

Axl is licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
