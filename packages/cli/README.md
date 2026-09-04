<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/cli`

This package owns the `axl` executable. It parses process arguments, manages local preferences and daemon connection startup, and selects the terminal client. Runtime assembly lives in `@axl/runtime`; terminal rendering lives in `@axl/tui`.

Use `axl -r` or `axl --resume` to open the all-placement session picker. Native, OCI, and unsafe histories are listed together, with unsafe sessions visibly marked before selection.

Use `axl doctor` to inspect native, Podman, and Docker enforcement. Select local OCI execution with `--sandbox podman|docker --image <digest-pinned-reference>`. The CLI keeps each engine and image on a separate daemon socket and rejects attachment when the requested sandbox identity differs.

Web fetch and search are enabled by default. Use `--no-web-fetch`, `--no-web-search`, or `--no-web` to remove them from a new session's tool roster.

Interactive sessions load global prompt templates from `~/.axl/prompts/*.md` and project overrides from `.axl/prompts/*.md`. Use `/prompt` to browse templates or `/prompt <name> [arguments]` to expand one into an editable draft.

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
