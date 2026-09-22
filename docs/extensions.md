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

The default export may be `async`. Registration is only allowed while the factory runs.

## API

`registerTool(definition)`
: Adds a tool under identity `extension:<name>/<tool>`. The tool is indexed for `capability_search` and stays out of the prompt until the model activates it. Tool names must match `^[a-z][a-z0-9_]*$` and must not shadow a built-in tool. A valid JSON Schema is required, and input is validated against it before `execute(input, signal)` runs. Execution returns `{ content: [{ type: "text", text }], isError? }`.

`on("tool.call", handler)`
: Runs before every registered tool executes. Return `{ block: true, reason }` to stop the call. Return nothing to allow it. A thrown error also blocks the call. The first blocking decision wins. The handler receives a copy of the input and cannot rewrite it.

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

`track(disposer)`
: Registers cleanup. Disposers run in reverse order when the session ends. Every registration also returns its own disposer.

## Failure behavior

- A missing `~/.axl/extensions/` directory loads nothing.
- A file without a default function export, an invalid tool definition, a duplicate name, or a factory that throws fails session start with the file path and reason. No extension is skipped silently.
- Reload activates the complete replacement runtime before swapping it in. Failed activation disposes the replacement, leaves the previous runtime active, and appends no partial reload boundary events.
- Blocked tool calls appear in the session log as an error `tool.result` naming the extension.
- Refused commands return the `command_blocked` RPC error to the caller. A refused automatic compaction fails the turn that needed it.

## Scope

Extensions load in the `standard` tool profile. Changed extension source is re-imported when a session runtime reloads. Registering new commands, user interface integration, providers, custom compaction, npm dependencies, enablement controls, and project-local directories are not part of this surface yet.
