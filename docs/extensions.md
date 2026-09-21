<!-- SPDX-FileCopyrightText: 2026 Shaan Narendran -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Daemon extensions

A daemon extension is a TypeScript or JavaScript file you put in `~/.axl/extensions/`. The daemon loads it at session start and runs it inside its own process with the daemon's permissions. Placing a file there is the trust decision. Axl does not sandbox extension code.

Extensions can:

- add tools the model can discover and activate through `capability_search`;
- block a tool call before it runs;
- replace the inputs of, or refuse, any built-in command before the daemon runs it; and
- observe every canonical event as it becomes durable.

They cannot widen sandbox or policy limits. Enforcement sits below the extension seam.

## Locations

| Path | Loaded as |
| --- | --- |
| `~/.axl/extensions/<name>.ts` or `.js` | extension `<name>` |
| `~/.axl/extensions/<name>/index.ts` or `index.js` | extension `<name>` |

Names must match `^[a-z0-9]+(?:[.-][a-z0-9]+)*$`. Entries starting with `.` and files with other extensions are ignored. Discovery is one level deep and sorted by name; handlers run in that order. Project-local extension directories are not loaded yet.

TypeScript files load through Node's built-in type stripping. Use `import type` for `@axl/extension-api`; there is no runtime module to import.

## Writing an extension

```ts
import type { DaemonExtensionApi } from "@axl/extension-api";

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
: Adds a tool under identity `extension:<name>/<tool>`. The tool is indexed for `capability_search` and stays out of the prompt until the model activates it. Tool names must match `^[a-z][a-z0-9_]*$` and must not shadow a built-in tool. `execute(input, signal)` returns `{ content: [{ type: "text", text }], isError? }`.

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
: Receives `{ id, type, timestamp, payload }` for every canonical event after it is written. Payloads are copies. A throwing observer is reported on the daemon's stderr and does not stop the session.

`track(disposer)`
: Registers cleanup. Disposers run in reverse order when the session ends. Every registration also returns its own disposer.

## Failure behavior

- A missing `~/.axl/extensions/` directory loads nothing.
- A file without a default function export, an invalid tool definition, a duplicate name, or a factory that throws fails session start with the file path and reason. No extension is skipped silently.
- Blocked tool calls appear in the session log as an error `tool.result` naming the extension.
- Refused commands return the `command_blocked` RPC error to the caller. A refused automatic compaction fails the turn that needed it.

## Scope

Extensions load in the `standard` tool profile. Commands, user interface, providers, custom compaction, npm dependencies, `/reload` of extension code, and project-local directories are not part of this surface.
