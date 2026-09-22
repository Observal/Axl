<!-- SPDX-FileCopyrightText: 2026 Shaan Narendran -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/extension-host`

Loads user daemon extensions from `~/.axl/extensions/` into the Axl daemon process.

- `discoverDaemonExtensions(directory)` lists `<name>.ts|js` files and `<name>/index.ts|js` directories.
- `loadDaemonExtensions(options)` imports each module, runs its default export with a `DaemonExtensionApi`, and returns one kernel `ExtensionHost` plus a live `CapabilitySource` for its tools.
- `DaemonExtensionRegistry` owns persistent enablement, explicit paths, project trust, package manifests, and npm or commit-pinned Git installation under the private extension package root.

Extensions are trusted by placement or an explicit install or project-trust operation and run with the daemon's permissions. Invalid extensions fail the load. Interceptors fail closed. See [`docs/extensions.md`](../../../docs/extensions.md).
