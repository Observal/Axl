<!-- SPDX-FileCopyrightText: 2026 Shaan Narendran -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Extensions

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
| `<project>/.axl/extensions/<name>.ts` or `.js` | trusted project extension `<name>` |
| `<project>/.axl/extensions/<name>/index.ts` or `index.js` | trusted project extension `<name>` |

Names must match `^[a-z0-9]+(?:[.-][a-z0-9]+)*$`. Entries starting with `.` and files with other extensions are ignored. Discovery is one level deep and sorted by name; handlers run in that order. Untrusted project-local extension directories are not loaded.

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

At least one entry point is required. A package with only `tui` runs no daemon extension code. The `daemon` and `tui` entries must resolve to JavaScript or TypeScript files inside the package, including after symlink resolution. A package can live under `~/.axl/extensions/<id>/` or a trusted project's `.axl/extensions/<id>/`, or be installed with `extension.install` from a directory, npm, or pinned Git. The directory name must match the manifest ID. `web` declares a self-contained JavaScript module that is served only to an authenticated local browser client. Installing a package or trusting a project grants its code host-process or browser-client authority, according to the entry point.

The public SDK exposes `listExtensions`, `enableExtension`, `disableExtension`, `reloadExtension`, `installExtension`, `updateExtension`, `removeExtension`, and `trustExtensionProject`. Mutations rebuild the selected session through the same atomic runtime replacement used by `/reload`. Inventory results include source, enablement, package version, and the latest lifecycle diagnostic. `/extensions` renders that inventory through the shared command controller in terminal and web clients.

## Terminal entry points

A terminal entry point default-exports a `TerminalExtension` object. It runs in the **local TUI process**, not in the daemon. The local client reads the daemon's `extension.list` inventory so project trust, precedence, and enablement are shared. A disabled entry is not imported. The public terminal API supports commands, shortcuts, status, working labels, widgets, header/footer slots, tool and canonical-entry renderers, Markdown transforms, asynchronous autocomplete, and session/working/prompt events. Commands can notify, select, confirm, request text or multiline input, and edit prompt text. With `terminal.ui`, `api.ui` exposes an owned custom overlay and theme helpers. Each registration and tracked resource is disposed on reload or exit. See `@observal/axl/extension-api` for types.

```ts
import type { TerminalExtension } from "@observal/axl/extension-api";

const extension: TerminalExtension = {
  manifest: {
    id: "example-tools",
    name: "Example tools",
    capabilities: ["terminal.commands", "terminal.widgets", "terminal.ui"],
  },
  activate(ui) {
    ui.registerWidget("summary", {
      render: () => [{ text: "Extension ready", tone: "accent" }],
    });
    ui.registerCommand({
      name: "hello",
      description: "Greet from the terminal",
      run: async (_args, ctx) => {
        const name = await ctx.input("Who should we greet?", "your name");
        if (name !== undefined) ctx.notify(`Hello, ${name}!`, "success");
      },
    });
  },
};
export default extension;
```

TUI entries reload when `/reload-tui` runs without restarting the daemon session, when `/reload` runs, when the client switches sessions, or when the daemon extension inventory changes. Built-in prompt templates and skills appear in the same inventory and can be disabled with `extension.disable`; disabled modules are not imported. The host validates the extension's manifest identity, declared capabilities, and collisions with built-in commands and reserved shortcuts before enabling it. A failed replacement preserves the previous terminal host. User-installed code has full access to the local terminal process; do not install untrusted extensions.

`ctx.input` accepts a single line; `ctx.editor` accepts multiline text. Selection, confirmation, and prompts resolve `undefined` on cancellation (confirmation resolves `false`). `api.ui.custom(title, create)` owns one dialog component with `render`, `handleKey`, optional `cursor`, and optional `dispose`. The `done(value)` callback settles it. Extension dialogs cannot replace an active approval or other dialog. On extension disable, reload, or terminal exit, pending prompts are cancelled and owned components are disposed. Outside an interactive TUI, `api.ui.hasUI` is `false` and UI calls throw an explicit unavailable error. `registerMarkdownTransformer` changes display text only, not the canonical log or model input. `registerMessageRenderer` handles `context.extension` sources; `registerEntryRenderer` handles `extension.state` keys and `extension.event` channels. Both render bounded, sanitized terminal lines. `registerEditor` replaces the main composer without changing daemon state. It receives the retained draft, model label, working state, and theme. Return bounded lines and a cursor, and return `true` from `handleKey` only for keys it consumes. Enter, Escape, interruption, and other safety keys remain built-in; disposing the registration restores the default composer without losing the draft. Autocomplete providers may return `{ value, label?, start? }`, where `start` is an offset in the text before the cursor. Their completion replaces text from that offset to the cursor and preserves the trailing draft. Markdown transformers run for both streaming and settled assistant display. See the [extension parity matrix](architecture/extension-parity.md) for other remaining work.

## API

`registerTool(definition)`
: Adds a tool under identity `extension:<name>/<tool>`. The tool is indexed for `capability_search` and stays out of the prompt until the model activates it. Tool names must match `^[a-z][a-z0-9_]*$` and must not shadow a built-in tool. A valid JSON Schema is required, and input is validated against it before `execute(input, signal, context)` runs. `context.reportProgress(value)` publishes bounded transient progress. Execution returns `{ content: [{ type: "text", text }], isError? }`. Registration and its returned disposer remain usable after factory activation for dynamic tool lifecycles.

`registerCommand(definition)`
: Registers a daemon-owned command with a unique lowercase hyphenated name. Built-in names cannot be replaced. Every client can discover the command through `command.list` and invoke it through `extension.command.invoke`, including the typed SDK command controller.

`registerProvider(provider)`
: Registers an implementation of Axl's existing `ModelProvider` contract in the shared AI registry. Registrations are reference-counted across session extension instances and are removed after the last owning instance is disposed. Provider IDs cannot replace a built-in or another extension's provider.

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
: Contribute bounded context before the turn and before each provider request. A contribution targets either `message` by default or the appended `system` suffix. Contributions append `context.extension` before model dispatch, so reconstruction remains exact and the stable prompt prefix is unchanged.

`on("before_provider_headers", handler)`, `on("before_provider_request", handler)`, and `on("after_provider_response", handler)`
: Run around model HTTP dispatch inside `packages/ai`. Header and JSON payload replacements chain in extension order. The response hook runs after headers arrive and before the response body is consumed. All receive the owning model request's cancellation signal.

`on("command", handler)`
: Runs before every built-in command. Return nothing to run it unchanged, `{ args }` to run it with replaced inputs, or `{ block: true, reason }` to refuse it. A thrown error refuses it. Replacements chain in load order; the first refusal wins. Refused commands fail with the `command_blocked` error and the reason, whoever triggered them: a client, the model, or the daemon itself. The daemon revalidates replaced inputs and refuses invalid ones. `project_trust`, `session_before_fork`, `session_before_compact`, and `user_bash` are typed aliases scoped to their corresponding command.

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

## Ordering and cancellation

Factories and handlers run in resolved extension order. Input, command, provider-header, provider-payload, tool-input, and tool-result replacements chain so each handler sees the prior handler's value. The first explicit block stops an intercepted operation. Tool input and result replacements cross their normal validation boundaries before execution or persistence. Concurrent tool calls keep independent inputs and cancellation signals.

The owning daemon operation's signal reaches activation, context discovery, input, command, provider, and tool handlers. Disposal also aborts the extension lifecycle signal. Observer and cleanup work is bounded during disposal, but active operation hooks do not receive a shorter extension-only deadline.

## Failure behavior

- A missing `~/.axl/extensions/` directory loads nothing.
- A file without a default function export, an invalid tool definition, a duplicate name, or a factory that throws fails session start with the file path and reason. No extension is skipped silently.
- Reload activates the complete replacement runtime before swapping it in. Failed activation disposes the replacement, leaves the previous runtime active, and appends no partial reload boundary events.
- Blocked tool calls appear in the session log as an error `tool.result` naming the extension.
- Refused commands return the `command_blocked` RPC error to the caller. A refused automatic compaction fails the turn that needed it.

## Scope

Daemon extensions load in the `standard` tool profile. Changed source is re-imported when a session runtime reloads. A browser entry declares `axl.web` in the same package manifest and default-exports a version-1 `WebExtension`. The browser host loads only enabled entries through authenticated gateway routes. Browser modules must be self-contained JavaScript; they run with the authority of the local browser client. Project packages still require explicit trust. See [`examples/extensions/browser.mjs`](../examples/extensions/browser.mjs) for a self-contained browser module. Its package manifest declares `{"name":"example-browser","axl":{"id":"example-browser","apiVersion":1,"web":"./browser.mjs"}}`; compile TypeScript to JavaScript before installation. The browser presentation surface is incomplete; consult the [extension parity matrix](architecture/extension-parity.md) before relying on it for parity.
