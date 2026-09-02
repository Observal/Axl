<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@observal/axl`

This package installs the `axl` command-line interface for the [Axl agent harness](https://github.com/Observal/Axl).

## Install

```bash
npm install --global @observal/axl
```

Axl requires Node.js `^22.19.0` or `>=24.0.0`. Sandboxed command execution requires Bubblewrap on Linux. macOS uses Seatbelt.

Configure Azure OpenAI and start Axl:

```bash
axl login
axl
```

See the [repository README](https://github.com/Observal/Axl#readme) for configuration, security behavior, and documentation.
