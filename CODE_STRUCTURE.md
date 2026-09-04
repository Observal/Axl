<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Axl code structure

Status: working plan. This document accompanies [ROADMAP.md](ROADMAP.md) and [OPEN_SOURCE.md](OPEN_SOURCE.md).

Updated: 2026-08-28

## 1. Keep everything in one repository

The kernel, protocol, adoption compiler, clients, extensions, documentation, and plans all belong in one monorepo.

Many open source projects keep their mobile apps in separate repositories. That works for products such as Signal, Element, Zulip, Mattermost, and Tailscale because their mobile apps own substantial state, storage, and cryptographic logic.

Axl clients are much thinner. They display state owned by the daemon and communicate through one protocol. A repository boundary would cut across the part of the system that changes most often during early development.

A monorepo gives Axl three practical benefits:

- **One compliance surface.** The project has one merge queue, one `CODEOWNERS` file, one security policy, and one set of OpenSSF checks.
- **Atomic protocol changes.** A single reviewed commit can update the TypeScript protocol, each client, and any generated SDKs that exist later.
- **An easy escape route.** Splitting an app into a separate repository later is straightforward because it depends only on the protocol SDK. Combining repositories later would lose history and cross-references.

The tradeoff is heavier CI. Section 8 limits that cost with path-based jobs, while section 9 keeps app-store releases separate from package releases.

Codex offers a useful contrast. Its CLI and Rust core share a repository, while its desktop and mobile products live elsewhere. Axl keeps the whole product open, including its apps.

## 2. Languages

- Use **TypeScript** for the kernel, protocol, daemon, adoption compiler, terminal client, web client, and extensions. It matches the ecosystems and standards Axl integrates with.
- Use **Kotlin with Jetpack Compose** for Android and **Swift with SwiftUI** for iOS. Choose protocol code generation when the first of these clients is built.
- Do not add another application language. Tooling should use TypeScript or POSIX shell.

## 3. Repository layout

```text
axl/
  packages/
    kernel/            # event log, agent loop, tool protocol, and policy (roadmap §2.3)
    protocol/          # authoritative TypeScript event, RPC, and capability contracts
    ai/                # provider adapters, tool dialects, and thinking levels (roadmap §2.7, 7.4, 7.6)
    compiler/          # adoption inspectors, converters, and verifiers (roadmap §4)
    daemon/            # sessions, placements, and pooling (roadmap §13, 14, 15)
    runtime/           # client-independent local runtime assembly
    sandbox/           # operating-system providers and OCI runtime (roadmap §10, 11)
    cli/               # axl executable, process startup, and client selection
    tui/               # terminal event projection and interaction UI
    web/               # web client
    sdk/               # shared TypeScript client SDK when multiple clients need it
    extensions/        # first-party extensions, one package per feature (roadmap §2.9)
  apps/
    android/           # Gradle project using the generated Kotlin SDK
    ios/               # Xcode project using the generated Swift SDK
  fuzz/                # fuzz targets and oracles (OS §7.3)
  docs/                # user docs, security material, and architecture specifications
  ROADMAP.md           # product vision and technical implementation roadmap
  .github/             # workflows, templates, and CODEOWNERS (OS §8)
```

These rules keep package ownership clear:

- `packages/protocol` has no runtime dependencies.
- `packages/kernel` depends only on `packages/protocol` and Node.js built-ins.
- First-party extensions use the same public extension API as third-party extensions.
- `packages/protocol` is the only source of wire-format truth. TypeScript definitions stay authoritative until a non-TypeScript client creates a real need for generation.
- Apps use the public protocol SDK rather than package internals.
- `packages/runtime` assembles providers, tools, extensions, sandboxing, and the authoritative daemon without importing a presentation client.
- `packages/tui` is a daemon client projection. It does not construct the runtime or depend at runtime on sandbox, kernel, or concrete extension implementations. It may depend on the dependency-free public `@axl/extension-api` for client-local presentation customization.
- `packages/cli` owns process startup and selects the current client, so replacing the TUI does not move backend assembly.

CI enforces these boundaries.

## 4. Protocol boundary

The protocol package owns the contract between the daemon and every client.

- TypeScript definitions are authoritative while all clients use TypeScript.
- A schema change requires prior design discussion and compatibility notes.
- The first Swift or Kotlin client triggers a decision on the schema language and generator.
- Generated SDKs then ship through their native package systems so external and in-tree clients use the same contract.

## 5. Independent implementation

Axl derives requirements from public specifications and black-box behavior, then implements them independently in the appropriate Axl package. It does not keep modified copies of external agent harnesses under `third_party/`.

Any approved adaptation records its source, commit, and changes in an SPDX header. Behavior tests pin compatibility where needed. The `third_party/` directory is reserved for unmodified imported material.

## 6. Build tools

- Use pnpm workspaces for package management. Add a task runner with remote caching only when repository scale justifies it.
- Keep Gradle and Xcode native. CI coordinates the build systems but the JavaScript toolchain does not wrap them.
- Version packages in `packages/` together. Mobile apps keep their own store versions.

Bazel would add more contributor cost than value at the current scale.

## 7. Tests

- Unit tests live with the package they cover.
- Behavior tests live with the package that makes the promise. This includes compatibility fixtures, child-contract tests, and permission-policy cases.
- Fuzz targets live in `fuzz/` and exercise the same input paths as production.
- End-to-end tests drive real clients against the real daemon in a sandboxed workspace. Catalog runs use their own schedule rather than blocking the merge queue.
- Recorded sessions serve as deterministic replay fixtures.

## 8. CI layout

Every required check reports a result. Path filters decide whether the full job runs or a small gate job reports that no relevant files changed.

- Kernel, protocol, and SDK changes run all builds, including both mobile apps.
- App-only changes run that app and lint checks.
- Documentation and plan changes run formatting, link checking, and REUSE checks.
- CodeQL, Gitleaks, and dependency review run for every merge candidate.

macOS runners are reserved for iOS and protocol changes. If mobile CI becomes a persistent burden, the project can revisit the monorepo decision without changing app architecture.

## 9. Release schedules

The repository has three release schedules:

- Packages, CLI binaries, and container images share one version and release pipeline.
- Android has its own tags and Play Store schedule. F-Droid builds from the Android subdirectory.
- iOS follows its own tags and App Store schedule.

Clients declare the protocol versions they support. An older app should report an unsupported capability or version clearly instead of failing in an unclear way.

## 10. Constraints

- Keep first-party code in this repository until CI cost or contributor friction proves that a split is worthwhile.
- Never edit generated code by hand or commit generated files without the required marker.
- Do not create a generic `utils` package. Shared code needs a clear owner.
- Do not use private imports across the extension boundary.
- Do not add a build tool that contributors must learn before making a small change.
