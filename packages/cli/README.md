<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/cli`

This package owns the `axl` executable. It parses process arguments, manages local preferences and daemon connection startup, and selects the terminal client. Runtime assembly lives in `@axl/runtime`; terminal rendering lives in `@axl/tui`.

Use `axl -r` or `axl --resume` to open the all-placement session picker. Native, OCI, and unsafe histories are listed together, with unsafe sessions visibly marked before selection.

Use `axl doctor` to inspect native, Podman, and Docker enforcement. Select local OCI execution with `--sandbox podman|docker --image <digest-pinned-reference>`. The CLI keeps each engine and image on a separate daemon socket and rejects attachment when the requested sandbox identity differs.

Web fetch and search are enabled by default. Use `--no-web-fetch`, `--no-web-search`, or `--no-web-tools` to remove them from a new session's tool roster.

New sessions default to the selected model's output maximum and a five-minute model HTTP idle timeout. Use `--max-output-tokens <n|model>` and `--http-idle-timeout <milliseconds>` to change those defaults. Zero disables the idle timeout. Existing sessions retain their canonical settings and can be changed through `/request`.

Interactive sessions load global prompt templates from `~/.axl/prompts/*.md` and project overrides from `.axl/prompts/*.md`. Use `/prompt` to browse templates or `/prompt <name> [arguments]` to expand one into an editable draft.

User themes load from `~/.axl/themes/*.json` and project overrides from `.axl/themes/*.json`. Select one with `/theme <id>`. Existing theme directories are watched for live changes, and `/reload` rescans them.

## Model providers

The daemon owns provider operations and canonical `{ providerId, modelId }` session selection. API dialect is model metadata and cannot be selected independently. The `provider` and `model` startup options set defaults for a new session only.

```bash
axl providers
axl providers openrouter
axl models
axl models openrouter
axl login openrouter oauth
axl logout openrouter
axl refresh openrouter
```

`providers` checks explicit authentication status and shows safe source labels, login methods, catalog type, model count, and catalog errors. `models` groups text models by provider and includes unavailable reasons and published token prices. Neither command refreshes catalogs, and metadata listing does not read credentials or perform network requests.

`login` supports `api_key` or `oauth` when offered by the provider. Prompt answers, API keys, OAuth codes, and tokens remain in the trusted daemon process-host adapter and never cross daemon RPC. Browser authorization is restricted to HTTPS URLs without embedded credentials. `logout` affects only the named provider. `refresh` is explicit and applies only to dynamic catalogs. Ctrl+C cancels an active provider operation, and externally effective operations are not replayed after reconnect.

Errors include a safe category, provider and model identity when available, a concrete action, and retry guidance. There is no silent provider, model, dialect, authentication, or catalog fallback.

## Print mode

`axl print <prompt>` or `axl -p <prompt>` creates a durable session, runs one headless turn, writes only the final assistant text to stdout, and exits. Piped UTF-8 stdin is appended to the argument prompt after a blank line. Diagnostics and failures go to stderr, and a request for interactive input makes the command fail instead of waiting indefinitely.

```bash
axl print "Summarize this repository"
printf 'extra context\n' | axl -p "Use this input"
```

## JSON mode

`axl json <prompt>` or `axl --json <prompt>` runs the same durable headless turn and writes every canonical event as one JSON line. The stream includes session configuration, prompt sections, tool lifecycle, user messages, and assistant messages in canonical order. Transient activity is excluded because it is not part of the authoritative session log. Diagnostics and failures go to stderr.

```bash
axl json "Inspect this repository" > events.jsonl
```

## RPC mode

`axl rpc` connects to the matching local daemon, starting it when needed, then bridges stdin and stdout directly to Axl's newline-delimited JSON wire protocol. It does not translate method names, events, errors, request IDs, or capability checks. Host startup and connection failures go to stderr.

The daemon sends `hello` first. The caller must send `connection.initialize`, request the capabilities it needs, and send `connection.ping` at the advertised heartbeat interval. Requests, responses, canonical events, transient activity, and presence use the schemas exported by `@axl/protocol`.

```json
{"kind":"request","id":1,"method":"connection.initialize","params":{"client":{"kind":"rpc","version":"1","instanceId":"<unique-id>"},"requestedCapabilities":["session.list"]}}
{"kind":"request","id":2,"method":"session.list","params":{"scope":"all_local","order":"recent","pageSize":20}}
```

Keep stdin open while waiting for responses or subscribed events. Closing stdin closes the RPC attachment without interrupting daemon-owned session work.
