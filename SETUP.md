<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
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

You can also set `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_RESOURCE_NAME`, and `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`. Exported endpoint, API-version, and deployment settings override values saved by an earlier interactive login. A stored API key still takes precedence over `AZURE_OPENAI_API_KEY`, which matches Pi's credential behavior.

Start a new session or resume an existing one:

```bash
axl
axl <session-id>
```

The client uses `~/.axl/axl.sock`. It starts a detached local daemon when one is not already running. Use `axl daemon` to keep the daemon in the foreground for troubleshooting. Restart an existing daemon after changing exported environment variables because a running process cannot inherit later shell changes.

## Global and project configuration

Axl reads global configuration from `~/.axl`:

- `AGENTS.md` for global instructions
- `skills/<name>/SKILL.md` for global Agent Skills
- `mcp.json` for global MCP servers
- `credentials.json` for credentials managed by `axl login`
- `settings.json` for the selected model, thinking level, and theme

Credentials and settings apply in every workspace. Axl also reads `AGENTS.md`, `.axl/skills`, and `.axl/mcp.json` from the workspace root. A project skill or MCP server replaces the global entry with the same name. Reload the session after changing instructions, skills, or MCP configuration.

## Unsafe mode

Use `--unsafe` only when you explicitly need to run without operating-system confinement:

```bash
axl --unsafe
axl daemon --unsafe
```

This disables Bubblewrap or Seatbelt and removes file-tool path restrictions. Shell commands, reads, edits, and local stdio MCP servers receive the user's full host authority. The TUI displays a persistent warning, and the canonical log records `sandbox.configured` with `enforced: false`.

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
