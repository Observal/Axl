<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 Shaan Narendran -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/extension-mcp`

This package connects Axl to Model Context Protocol servers using protocol version `2025-11-25` and the official TypeScript SDK.

## Configuration

Run `/mcp` in the terminal or web client to see every configured server with its discovery status and tools, and to add, enable, disable, remove, or reload servers. Adding a server is either a paste of the README `mcpServers` block (or a bare URL or command line) or a guided flow, both ending in a review of the exact JSON to be written; the daemon probes the server (`mcp.config.probe`) and persists it only when it answers. The daemon validates and atomically writes `~/.axl/mcp.json` with mode `0600`, then the client reloads the active session. The model can perform the same list, upsert, and remove operations through the progressively disclosed `configure_mcp` capability.

A remote server that answers `401` without configured headers is treated as an OAuth server: the manager arms OAuth (discovery, dynamic registration, PKCE, loopback callback), asks the user to authorize in the browser through the session's interaction channel, and stores tokens privately. A probe cannot show that prompt, so it reports `authorization: "required"` and the client saves the server; the prompt appears on the next reload.

A server that fails discovery does not block the session. Its failure is recorded in the metadata cache, projected to clients as `failed` with a redacted error, and retried on the next reload.

Configure other trusted global servers directly in `~/.axl/mcp.json`. Axl does not load project-local MCP configuration.

```json
{
  "mcpServers": {
    "local": {
      "command": "node",
      "args": ["/absolute/path/server.mjs"],
      "env": { "API_TOKEN": "SOURCE_ENVIRONMENT_VARIABLE" },
      "roots": ["."],
      "requestTimeoutMs": 60000
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "MCP_AUTHORIZATION_HEADER" },
      "oauth": { "scope": "tools resources" },
      "roots": ["."],
      "requestTimeoutMs": 60000
    }
  }
}
```

A `url` selects Streamable HTTP. A `command` selects stdio. Each entry must contain exactly one. Set `"enabled": false` to exclude a server completely.

Environment and header entries are read from the daemon's environment, so credentials do not appear in configuration: a bare name such as `TOKEN` sends that variable's value, and a template such as `Bearer ${TOKEN}` wraps it in literal text. Literal values are rejected. HTTP URLs must use HTTPS unless they point to the local machine. OAuth supports protected-resource and authorization-server discovery, PKCE, dynamic or configured client registration, a loopback callback, and token files with mode `0600`.

Local stdio servers run through Axl's configured execution sandbox. `roots` are opt-in and must resolve inside the active workspace.

## Capability discovery

Axl indexes each MCP tool as an inactive capability. The model finds and activates selected tools through `capability_search`. Activated tools use their original input schema and call their exact configured server and tool name. There is no generic model-visible MCP gateway.

A versioned metadata cache at `~/.axl/cache/mcp-tools.json` avoids starting every configured server for every session. It contains configuration fingerprints, public tool metadata, and redacted discovery failures only. It never contains credentials, command arguments, tool results, OAuth state, or server instructions. Missing, stale, or mismatched entries are refreshed with a bounded `tools/list` probe and written atomically with mode `0600`.

Connections remain lazy after metadata is available. Tool calls retain approval, cancellation, progress, tasks, redaction, blobs, sampling, elicitation, OAuth, and bounded-output handling. Binary content is stored by SHA-256 digest under Axl state, and canonical history contains only the reference.
