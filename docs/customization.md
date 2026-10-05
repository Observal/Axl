<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-FileCopyrightText: 2026 Srihari -->
<!-- SPDX-FileCopyrightText: 2026 Shaan Narendran -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Customizing Axl

Project instructions, optional capabilities, prompt templates, themes, and MCP servers.

## Project instructions

Axl loads `AGENTS.md` files from the nearest Git repository root through the session working directory, with broader instructions first and nearer instructions last. Outside a Git repository, only the working directory is considered. `AGENTS.override.md` replaces `AGENTS.md` in the same directory. Global instructions come from `~/.axl/AGENTS.md` and support the same override filename.

Loaded paths and exact model-visible content are recorded in the canonical session log and projected through the SDK. A resumed session keeps its recorded instruction snapshot. Run `/reload` to discover file changes and record a new context boundary. Symlinks that escape the applicable project or global root are rejected.

## Optional capabilities

Standard sessions expose one stable `capability_search` tool instead of placing every installed Skill in the prompt. The model searches compact authorized metadata, then explicitly activates selected identities once. Activation rechecks policy and path containment, records the exact model-visible instructions canonically, and keeps them active for the rest of the session, including after restart. Referenced files remain sandboxed behind the same tool's `read` action and require an active Skill.

Agent Skills are discovered from `~/.axl/skills/`, `~/.agents/skills/`, and repository-root-to-working-directory `.axl/skills/` and `.agents/skills/` locations. Later definitions replace earlier definitions with the same `skill:<name>` identity. Discovery validates frontmatter and containment only. It does not execute scripts or expose instruction bodies, references, or assets. Full instructions load only through explicit activation.

Daemon extensions are TypeScript or JavaScript files in `~/.axl/extensions/`. They run inside the daemon process with its permissions and can add model-discoverable tools, block tool calls, replace or refuse built-in commands such as `/compact`, and observe canonical events. See [Daemon extensions](docs/extensions.md).

Daemon commands may declare a model-callable tool in the authoritative command registry. The current `compact_context` and `reload_context` tools use that progressive disclosure path: their provider-native schemas are absent until activation and remain available for the session afterward. Compaction and reload requests made during a response queue behind that response.

## Prompt templates

Put reusable Markdown prompts in `~/.axl/prompts/` or `.axl/prompts/`. Project templates override global templates with the same filename. Run `/prompt` to browse them or `/prompt <name> [arguments]` to expand one into the editor for review before sending. Templates reload with `/reload`.

```markdown
---
description: Review one file
usage: "<path> [focus]"
---
Review {{1}}. Focus on {{2=correctness}}.
```

Use `{{1}}` through `{{99}}` for quoted positional arguments, `{{all}}` for every argument, and `{{1=default}}` or `{{all=default}}` for defaults.

## User themes

Put Axl theme JSON files in `~/.axl/themes/` or `.axl/themes/`. Project themes override global themes with the same ID. Select one with `/theme <id>`. Axl reloads changed theme files while the TUI is running, retains the last valid palette after an invalid edit, and reports the validation error. Use `/reload` after creating a theme directory during an active session. See [`packages/tui/README.md`](packages/tui/README.md) for the format and color roles.

## Configure MCP servers

Run `/mcp` in the terminal or web client. The panel lists every configured server with its daemon-reported discovery state (`discovered`, `failed` with the error, `disabled`, or `not discovered yet`), its tool count, and the tools that are active in the current session. From there you can add, enable, disable, remove, or reload servers.

To add a server quickly, press `p` (terminal) or **Paste config** (web) and paste the `mcpServers` block from the server's README, a bare server URL, or a command line. Axl translates common host formats, derives a name when none is given, maps VS Code `${input:id}` placeholders to `${ID}`, and lists the environment variables the entry reads so you know what to export. Both GitHub README snippets paste as-is: the header-less one is authorized with OAuth in your browser, the PAT one only needs `export GITHUB_MCP_PAT=…` before starting the daemon.

The guided alternative asks step by step: name, transport (remote Streamable HTTP or local stdio process), the URL or command line copied from the server's README, optional header or environment variable names for secrets, and optional filesystem roots. The review step shows the exact JSON that will be written. Axl connects to the server and lists its tools first; only a server that answers is saved to `~/.axl/mcp.json` (validated, atomic, mode `0600`), after which the active session reloads. A server that later fails discovery is isolated: the rest of the session loads, the panel shows the failure, and the footer reports `mcp:discovered/total`.

The model can discover and activate the same `configure_mcp` capability when you ask it to add or remove an MCP server. This configuration path is daemon-managed and does not require weakening the command sandbox.

You can also edit the file directly. For a remote server, add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "EXAMPLE_API_TOKEN" }
    }
  }
}
```

Header and child-process environment values are read from the daemon's environment, never stored: a bare name such as `GITHUB_TOKEN` sends that variable's value, and a template such as `Bearer ${GITHUB_TOKEN}` wraps it in literal text. A remote server that answers `401` without configured headers is authorized with OAuth: Axl opens the browser prompt, and saves the token privately. Local stdio servers use `command`, optional `args`, `cwd`, `env`, and `roots`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31", "/path/to/project"],
      "roots": ["/path/to/project"]
    }
  }
}
```

Restart the daemon or run `/reload` after editing the file manually. MCP tools stay outside the stable prompt until selected through capability discovery.

