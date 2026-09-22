<!-- SPDX-FileCopyrightText: 2026 Shaan Narendran -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Daemon extensions

A daemon extension is a TypeScript or JavaScript file you put in `~/.axl/extensions/`. The daemon loads it at session start and runs it inside its own process with the daemon's permissions. Placing a file there is the trust decision. Axl does not sandbox extension code.

Full Pi-level coverage is tracked in the [extension parity matrix](architecture/extension-parity.md).

Extensions can:

- add tools the model can discover and activate through `capability_search`;
- block a tool call before it runs;
- replace the inputs of, or refuse, any built-in command before the daemon runs it; and
- observe every canonical event as it becomes durable.

Extension code is trusted host code and can use the daemon process's filesystem, network, environment, and process authority directly. Sandbox and policy limits still govern model-invoked built-in tools and sandboxed MCP processes, but they do not confine the extension implementation itself. Install only extensions you trust as fully as Axl.

## Locations

| Path | Loaded as |
| --- | --- |
| `~/.axl/extensions/<name>.ts` or `.js` | extension `<name>` |
| `~/.axl/extensions/<name>/index.ts` or `index.js` | extension `<name>` |

Names must match `^[a-z0-9]+(?:[.-][a-z0-9]+)*$`. Entries starting with `.` and files with other extensions are ignored. Discovery is one level deep and sorted by name; handlers run in that order. Project-local extension directories are not loaded yet.

TypeScript files load through Node's built-in type stripping. Installed releases expose the authoring declarations at `@observal/axl/extension-api`; use `import type` because there is no runtime module to import. Repository-local development may import the private workspace package `@axl/extension-api` instead.

## Writing an extension

```ts
import type { DaemonExtensionApi } from "@observal/axl/extension-api";

export default function (axl: DaemonExtensionApi) {
  axl.registerTool({
    name: "greet",
    description: "Greets a person by name",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    execute: (input) => ({
      content: [{ type: "text", text: `hello ${String(input.name)} from ${axl.cwd}` }],
    }),
  });

  axl.on("tool.call", (event) => {
    if (event.name === "bash" && String(event.input.command).includes("rm -rf")) {
      return { block: true, reason: "destructive command" };
    }
  });

  axl.on("command", (event) => {
    // write the compaction summary yourself instead of asking the model
    if (event.name === "compact") {
      return { args: { ...event.args, summary: summarize(String(event.args.transcript)) } };
    }
    // refuse a command outright
    if (event.name === "rename" && String(event.args.title).includes("secret")) {
      return { block: true, reason: "titles must not contain secrets" };
    }
  });

  axl.on("session.event", (event) => {
    if (event.type === "assistant.message") console.error(`[greet] reply at ${event.timestamp}`);
  });

  axl.track(() => {
    // runs when the session ends
  });
}
```

The default export may be `async`. Event and resource handlers register while the factory runs. Tools may also register and unregister later while the extension remains active. `axl.signal` aborts if activation is cancelled or the extension begins disposal.

## Discovery and packages

Axl resolves daemon extensions in deterministic precedence order: global files, installed packages, explicit paths, then trusted project extensions. A later source replaces an earlier source with the same extension ID.

- Global files remain under `~/.axl/extensions/` and are trusted by placement.
- Explicit files or directories are added with `extension.install` using `{ type: "path", path }`.
- Project files under `<project>/.axl/extensions/` load only after `extension.trust` records that canonical project root.
- npm and pinned Git packages install under `~/.axl/extensions/.packages/`, where Node resolves their own dependencies normally.

An installable package declares its entry points in `package.json`:

```json
{
  "name": "@example/axl-tools",
  "version": "1.0.0",
  "axl": {
    "id": "example-tools",
    "apiVersion": 1,
    "daemon": "./dist/daemon.js",
    "tui": "./dist/tui.js",
    "web": "./dist/web.js"
  }
}
```

The daemon entry is required for daemon installation and must resolve inside the package. TUI and web declarations are reserved for their separate presentation hosts. Installing a package or trusting a project grants its code full process authority.

The public SDK exposes `listExtensions`, `enableExtension`, `disableExtension`, `reloadExtension`, `installExtension`, `updateExtension`, `removeExtension`, and `trustExtensionProject`. Mutations rebuild the selected session through the same atomic runtime replacement used by `/reload`. Inventory results include source, enablement, package version, and the latest lifecycle diagnostic.

## API

`registerTool(definition)`
: Adds a tool under identity `extension:<name>/<tool>`. The tool is indexed for `capability_search` and stays out of the prompt until the model activates it. Tool names must match `^[a-z][a-z0-9_]*$` and must not shadow a built-in tool. A valid JSON Schema is required, and input is validated against it before `execute(input, signal)` runs. Execution returns `{ content: [{ type: "text", text }], isError? }`. Registration and its returned disposer remain usable after factory activation for dynamic tool lifecycles.

`registerCommand(definition)`
: Registers a daemon-owned command with a unique lowercase hyphenated name. Built-in names cannot be replaced. Every client can list and invoke the command through `extension.list` and `extension.command.invoke`, including the typed SDK methods.

`state`
: Provides namespaced `get`, `set`, and `delete` operations. Updates append `extension.state` events and reconstruct after daemon restart. Values must be bounded JSON.

`session`
: Provides scoped daemon operations for steering or follow-up input, namespaced extension messages, compaction, reload, abort, rename, model and thinking-level changes, capability activation, new sessions, forks, and clones. `info()` returns the current name, model, thinking level, active tools, system prompt, context usage, and pending-message counts. Entry labels are namespaced and persisted through canonical `extension.label` events. Operations retain the daemon's ordinary ownership, validation, canonical logging, and cancellation rules.

`on("tool.call", handler)`
: Runs before every canonical tool call, including built-in tools such as `bash` and extension tools. Return `{ block: true, reason }` to stop the call, `{ input }` to replace its arguments, or nothing to allow it unchanged. Replacements chain in load order and are validated by the selected tool before execution. The canonical `tool.call` records the effective input.

`on("tool.result", handler)`
: Runs after execution and before the canonical result is written. Return a partial patch containing `content`, `details`, or `isError`. Patches chain in load order and the effective result is validated at the canonical event boundary.

`on("resources_discover", handler)`
: Returns up to 32 named text resources before prompt construction. Resources are bounded, recorded in `context.resources`, and included in the stable prompt. Project-extension resources retain project scope.

`on("input", handler)`
: Intercepts client or extension-produced input before the agent loop. Return `{ action: "transform", content }`, `{ action: "handled" }`, or nothing. Transforms chain and are validated before admission.

`on("before_agent_start", handler)` and `on("context", handler)`
: Contribute bounded context before the turn and before each provider request. Contributions append `context.extension` before model dispatch, so reconstruction remains exact and the stable prompt prefix is unchanged.

`on("before_provider_headers", handler)`, `on("before_provider_request", handler)`, and `on("after_provider_response", handler)`
: Run around model HTTP dispatch inside `packages/ai`. Header and JSON payload replacements chain in extension order. The response hook runs after headers arrive and before the response body is consumed. All receive the owning model request's cancellation signal.

`on("command", handler)`
: Runs before every built-in command. Return nothing to run it unchanged, `{ args }` to run it with replaced inputs, or `{ block: true, reason }` to refuse it. A thrown error refuses it. Replacements chain in load order; the first refusal wins. Refused commands fail with the `command_blocked` error and the reason, whoever triggered them: a client, the model, or the daemon itself. The daemon revalidates replaced inputs and refuses invalid ones.

  | `name` | `source` | `args` | Replaceable |
  | --- | --- | --- | --- |
  | `compact` | `client`, `model`, `automatic` | `reason` (`manual`, `threshold`, `overflow`), `instructions?`, `previousSummary?`, `transcript` (the messages about to be summarised) | `instructions`, `summary` (skips the model summariser) |
  | `reload` | `client`, `model` | none | none |
  | `model` | `client` | `providerId?`, `modelId?` | same fields |
  | `thinking` | `client` | `thinkingLevel` | same field |
  | `request` | `client` | `requestSettings` | same field |
  | `configure` | `client` | any mix of session configuration fields | same fields |
  | `fork` | `client` | `fromEventId` | `fromEventId` |
  | `clone` | `client` | none | none |
  | `rename` | `client` | `title` | `title` |

  Commands that are not bound to an active session (`providers`, `login`, `logout`, `refresh`, `mcp`, `resume`, `attach`, `delete`, `dispose`, `export`, `import`, `requeue`, `review`) do not reach extensions yet.

`on("session.event", handler)`
: Receives `{ id, type, timestamp, payload, signal }` for every canonical event after it is written. Payloads are copies. The signal aborts when disposal starts. Disposal drains cooperative asynchronous observers before cleaning up their resources and reports handlers that exceed the cleanup deadline. A throwing observer is reported on the daemon's stderr and does not stop the session.

Typed lifecycle notifications are also available for `session_start`, `session_info_changed`, `session_compact`, `session_compact_failed`, `session_shutdown`, `agent_start`, `agent_end`, `agent_settled`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `model_select`, `thinking_level_select`, and `extension_event`. Durable notifications carry the canonical event projection. Streaming notifications carry the bounded activity frame. `emit(channel, value)` publishes a bounded namespaced `extension.event` through the same canonical stream.

`track(disposer)`
: Registers cleanup. Disposers run in reverse order when the session ends. Every registration also returns its own disposer.

## Failure behavior

- A missing `~/.axl/extensions/` directory loads nothing.
- A file without a default function export, an invalid tool definition, a duplicate name, or a factory that throws fails session start with the file path and reason. No extension is skipped silently.
- Reload activates the complete replacement runtime before swapping it in. Failed activation disposes the replacement, leaves the previous runtime active, and appends no partial reload boundary events.
- Blocked tool calls appear in the session log as an error `tool.result` naming the extension.
- Refused commands return the `command_blocked` RPC error to the caller. A refused automatic compaction fails the turn that needed it.

## Scope

Daemon extensions load in the `standard` tool profile. Changed source is re-imported when a session runtime reloads. Shared command registration, persistent namespaced state, provider hooks, and the independently loaded TUI and web entry points remain tracked in the extension parity matrix.
