<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native and OCI local sandbox backends

Status: implemented architecture

## Problem

Axl's Linux sandbox used Bubblewrap namespaces and mounts, but its read-only host root still exposed files that Unix permissions allowed. It did not apply a project-owned seccomp policy or resource limits. Axl also had no local OCI execution option for users who require a container boundary or an image-defined toolchain.

The terminal package previously assembled the daemon and sandbox, which made another execution backend a presentation concern. That assembly now belongs to `packages/runtime`.

## Decision

Axl keeps canonical tools independent of execution placement. The local runtime selects one of these backends before constructing a session:

- Native Linux: Bubblewrap, Landlock, seccomp, dropped capabilities, private runtime directories, and rlimits.
- Native macOS: Seatbelt.
- OCI: Podman or Docker with a digest-pinned image and a shared hardened argument contract.
- Explicit unsafe execution: no operating-system enforcement.

The CLI selects OCI with `--sandbox podman|docker --image <digest-reference>`. Native execution remains the default. Unsafe execution cannot be combined with OCI selection. Each OCI engine and image digest receives separate daemon state, and clients reject a daemon whose provider or image differs from the request.

## Linux native enforcement

Bubblewrap establishes mount, PID, IPC, UTS, network, and user namespaces. It masks the host home and runtime directories, rebinds the workspace read/write, and rebinds additional readable roots read-only.

Inside that namespace, the pinned `landlock-run` launcher applies filesystem rules before executing the command. Axl functionally probes both ordinary access and truncate mediation. A kernel that cannot enforce the required filesystem operations makes the native provider unavailable.

Axl writes a versioned classic-BPF seccomp policy to a private per-user directory and passes it to Bubblewrap through an inherited descriptor. The policy denies high-risk kernel, namespace, module, keyring, tracing, and asynchronous-I/O system calls. It is a denylist, not a complete syscall allowlist.

`prlimit` bounds address space, CPU time, process count, output file size, and open descriptors. Long-lived MCP processes omit the CPU-time limit but retain the other limits. Process groups provide cancellation and forced termination.

## OCI enforcement

OCI images must be supplied by immutable SHA-256 digest and must already exist in the selected engine. Axl never pulls an image implicitly.

Podman must report rootless operation. Docker may report rootless, Docker Desktop VM isolation, or rootful operation. Rootful Docker is visible in the canonical sandbox details and gives the trusted Axl daemon root-equivalent control through the Docker socket.

Every OCI command uses:

- Read-only image root
- Workspace-only persistent writes
- Additional readable roots mounted read-only
- Protected paths replaced by private tmpfs mounts
- Private temporary storage
- No network
- No published ports or devices
- All capabilities dropped
- `no-new-privileges`
- Engine seccomp
- Cgroups v2 CPU, memory, and PID limits
- File-size and descriptor rlimits
- Numeric host user identity
- A unique container name
- Remove-on-exit plus an idempotent removal and absence check

Podman and Docker use the same builder and conformance tests. Engine-specific arguments are limited to features such as Podman's `keep-id` user namespace.

## Reporting

`sandbox.configured` includes the provider, enforced controls, and structured details. Native details contain the Bubblewrap version, Landlock result, seccomp policy version, and rlimits. OCI details contain the engine version, image digest, privilege mode, runtime, seccomp and cgroups state, and limits.

`daemon.info` reports the daemon's security mode, sandbox provider, and OCI image. `axl doctor` probes native, Podman, and Docker support without requiring provider credentials.

## Compatibility

The `details` field added to `sandbox.configured` is optional, so existing event logs remain readable. `daemon.info` adds response fields without changing its request shape. OCI selection is opt-in, and native sandboxing remains the default.

The shell wrapper contract now optionally carries an idempotent cleanup callback. Existing array-valued wrappers remain valid.

## Security limitations

All implemented Linux backends share a kernel unless Docker Desktop supplies a VM. Landlock support depends on the running kernel ABI. Native resource limits use rlimits rather than cgroups. The native seccomp profile is a denylist. OCI image signatures, SBOM policy, registry credential helpers, egress brokering, and remote workers are outside this change.

## Alternatives

A Podman-only implementation was rejected because Docker compatibility can share the same narrow engine contract and conformance suite. Making Docker the default was rejected because rootless Podman provides a safer daemonless baseline. Pulling mutable image tags automatically was rejected because the executed artifact would not be reconstructable from the session log.
