<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/runtime`

This package assembles Axl's client-independent local runtime. It selects the native, Podman, or Docker sandbox, constructs the provider and canonical tools, loads skills and MCP servers, discovers session histories across local placements, and starts the authoritative daemon.

Presentation clients must not be imported here. Terminal, web, IDE, and headless clients attach through the daemon protocol and do not construct separate agent loops.
