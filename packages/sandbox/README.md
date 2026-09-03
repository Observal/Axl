<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/sandbox`

This package provides operating-system and OCI sandbox adapters. Linux combines Bubblewrap namespaces with Landlock filesystem rules, a versioned seccomp denylist, dropped capabilities, private runtime directories, process supervision, and rlimits. macOS uses Seatbelt to restrict writes, network access, protected paths, and environment variables. In-process tools allow reads only from explicit readable roots and apply the same protected-path and workspace-write policy through the kernel's canonical path checks.

The OCI backend supports Podman and Docker with digest-pinned local images. It applies a read-only root, workspace-only persistent writes, private temporary storage, no network, dropped capabilities, `no-new-privileges`, seccomp, cgroups v2 limits, rlimits, and verified container removal. Podman must be rootless. Docker reports whether it is rootless, VM-backed, or rootful.

A session that requires isolation will not start without a suitable provider. Each provider records the controls, versions, image, privilege mode, and limits it actually enforces in `sandbox.configured.details`. Seatbelt reports that it cannot provide Linux-style namespaces. Windows native sandboxing remains future work.
