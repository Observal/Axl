<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security assurance case

## Claim

Axl runs model-selected actions under an enforceable local policy and keeps a redacted canonical record. The current implementation provides the Phase 4 sandbox and session controls. Later phases will add stronger isolation, remote workers, and release verification.

## Assets

Axl protects:

- Provider credentials and authorization state
- Session events, prompts, tool inputs, tool outputs, and artifacts
- User workspaces and other host files
- Extension and adopted-package source
- Release artifacts and the software supply chain

## Threat model

Treat repository content, tool output, web content, extensions, MCP servers, imported logs, and model output as untrusted. Maintainers and the local machine administrator are trusted to protect repository settings, signing identities, and development systems.

## Trust boundaries

1. Protocol parsers receiving untrusted data
2. The kernel receiving model-selected tool calls
3. Tool processes entering operating-system or OCI isolation
4. Extensions entering the extension host
5. Credentials entering provider adapters
6. Clients attaching to the daemon
7. Source entering CI and release workflows

## Current controls

- Runtime validation for canonical events and local wire messages
- Redaction before canonical event-log writes
- Canonical path checks, explicit file-tool readable roots, and symlink-escape rejection
- Bubblewrap confinement on Linux with explicit Landlock read rules, a versioned seccomp denylist, dropped capabilities, private runtime directories, rlimits, and the user home masked
- Digest-pinned Podman and Docker execution with read-only roots, restricted mounts, no network, seccomp, cgroups v2 limits, and verified container removal
- Fail-closed startup when required isolation is unavailable, unless the user explicitly starts a separate `--unsafe` daemon
- Logged unenforced state and a persistent terminal warning for unsafe sessions
- Sandboxed stdio MCP servers with limited environment variables and no network
- Explicit approval for MCP tools, sampling, OAuth browser launches, and elicitation
- Restricted credential, OAuth, task, and blob storage permissions
- Append-only JSONL sessions with torn-write recovery
- DCO, REUSE, dependency, package-boundary, generated-file, and secret checks
- SHA-pinned GitHub Actions with read-only default permissions
- Private vulnerability-reporting guidance and response targets

## Remaining risks

- Bubblewrap, Landlock, seccomp, and ordinary OCI runtimes share the host kernel. They do not provide a virtual-machine boundary.
- The current seccomp policy is a versioned high-risk syscall denylist rather than a complete syscall allowlist.
- Landlock enforcement depends on the running kernel ABI. Axl reports partial enforcement when newer rights are unavailable.
- Native Linux resource enforcement uses rlimits. Cgroups v2 limits are enforced by the OCI backends, not the native provider.
- Docker may be rootful. Axl records this distinction; rootless Podman remains the preferred local OCI engine.
- Seatbelt does not provide Linux-style namespaces.
- Windows native sandboxing is not implemented yet.
- Streamable HTTP MCP servers run remotely and must be trusted with requests sent to them.
- GitHub branch protection and Private Vulnerability Reporting depend on repository settings outside this tree.
- No signed release artifacts exist yet.
- Explicit `--unsafe` sessions grant shell, file tools, and local stdio MCP processes the user's full host authority. They rely on the startup warning and separate state until permission profiles are implemented.

## Maintenance

Review this document whenever a change affects authentication, authorization, logging, sandboxing, extension isolation, remote execution, or release signing. Update any claim invalidated by a security finding as part of the fix.
