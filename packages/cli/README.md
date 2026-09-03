<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/cli`

This package owns the `axl` executable. It parses process arguments, manages local preferences and daemon connection startup, and selects the terminal client. Runtime assembly lives in `@axl/runtime`; terminal rendering lives in `@axl/tui`.

Use `axl doctor` to inspect native, Podman, and Docker enforcement. Select local OCI execution with `--sandbox podman|docker --image <digest-pinned-reference>`. The CLI keeps each engine and image on a separate daemon socket and rejects attachment when the requested sandbox identity differs.
