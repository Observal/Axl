<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Extension examples

Axl ships small, independently inspectable examples. The [authoring guide](../../docs/extensions.md) describes the public API, trust decisions, and package format. These examples are independent Axl implementations, not Pi source ports.

| File | Try it for |
| --- | --- |
| [`daemon-kitchen-sink.ts`](daemon-kitchen-sink.ts) | Context, tool interception, hooks, session state, and a daemon command |
| [`provider.ts`](provider.ts) | A deterministic provider with no external credentials |
| [`terminal.ts`](terminal.ts) | Local TUI commands, shortcuts, widgets, selection, and multiline input |
| [`browser.mjs`](browser.mjs) and [`browser-daemon.ts`](browser-daemon.ts) | Authenticated browser module, dialogs, widget, shortcut, custom renderers, and a canonical daemon event |

## Install the browser example

The browser module is self-contained JavaScript. The daemon module uses Node's built-in TypeScript type stripping and a type-only import. Inspect both files before installation because extensions run with browser-client or daemon-process authority, respectively.

From the Axl repository, after installing the Axl CLI:

```sh
mkdir -p ~/.axl/extensions/example-browser
cp examples/extensions/browser.mjs ~/.axl/extensions/example-browser/web.mjs
cp examples/extensions/browser-daemon.ts ~/.axl/extensions/example-browser/daemon.ts
cat > ~/.axl/extensions/example-browser/package.json <<'JSON'
{
  "name": "example-browser",
  "version": "1.0.0",
  "type": "module",
  "axl": {
    "id": "example-browser",
    "apiVersion": 1,
    "daemon": "./daemon.ts",
    "web": "./web.mjs"
  }
}
JSON
axl web
```

Open a **standard** Code session, or run `/reload` in an existing one. The browser should show a "Browser extension ready" status and a "Choose a greeting" button. Click it and select a name, or run `/hello-web` to enter one. Run `/note-web` for a multiline dialog. Press Ctrl+Shift+Y outside an input to exercise the shortcut. Run `/web-example-event` to publish canonical entries for the example renderers. `/browser-extensions` is Axl's first-party browser management command; select this extension to inspect, disable, enable, or reload it. Disabled browser entries are not imported.

The browser module has no filesystem or daemon access. Its renderer receives SDK-projected records for display only. Daemon operations belong in the paired daemon entry. `/reload` reloads daemon state and browser entries, while switching or closing the browser session disposes the browser UI. Do not put secrets in extension notifications or event examples.

For a terminal-only example, copy `terminal.ts` into an installable package with an `axl.tui` entry and the matching `example-terminal` ID. The [authoring guide](../../docs/extensions.md#terminal-entry-points) documents the same package shape and local trust rules. The daemon-only files can be placed under `~/.axl/extensions/` and will be discovered at the next standard-session start or reload.
