<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/compiler`

`@axl/compiler` discovers and inspects resources from supported agent harnesses. Its inputs are untrusted data.

The package never imports discovered modules, evaluates configuration, runs package managers, follows source lifecycle instructions, or launches a source harness. Traversal is deterministic and bounded. Recognized malformed resources remain bounded candidates with provenance and typed diagnostics so one bad file cannot hide valid siblings. It uses `lstat`, canonical roots, before/after metadata checks, strict UTF-8 decoding, and typed diagnostics. Symlinks, hard links, device files, sockets, and FIFOs are not followed.

Adapters produce an internal domain model and do not depend on daemon, SDK, client, runtime, or presentation packages. A daemon integration must explicitly map this model to public protocol DTOs and enforce project trust before requesting project executable/config discovery.

## Immutable acquisition

The package also provides bounded source acquisition primitives. Local paths are copied through stable reads into a private same-filesystem staging tree, checked for blocked credential material, made read-only, fsynced, and atomically published by content hash. npm acquisition uses HTTPS registry metadata, SHA-512 SRI, tarball SHA-256, bounded streaming downloads, a path-safe archive reader, and an optional immutable cache. It never runs lifecycle scripts. Dependency graphs must use validated lockfile version 3 data from the pinned no-script sandbox resolver contract. Git acquisition requires an administrator-selected absolute Git executable path and uses an isolated configuration, HTTPS-only fetches, disabled hooks and credential helpers, and no submodule or LFS materialization.

Remote selectors are mutable planning input only. Successful acquisition returns an exact immutable lock. Offline npm acquisition requires that lock, its credential-free tarball URL, and cached verified bytes. Cache corruption is quarantined and never triggers a network fallback in offline mode.

## Versioned roots

The v1 adapters inspect these documented roots. Project roots are read only after Axl project trust is supplied.

| Ecosystem | Global root | Project root | Supported schema |
| --- | --- | --- | --- |
| Pi | `$PI_CODING_AGENT_DIR` or `~/.pi/agent`; `$PI_PACKAGE_DIR` adds package storage | `.pi` and ancestor `.agents` skill roots | `pi-package-v1` |
| OpenCode | `~/.config/opencode` | `.opencode` | `opencode-v1` |
| DSH | `$DSH_HOME` or `~/.dsh` | `.dsh` | bounded `cordis.yml`/`cordis.yaml` (`cordis-v1`) |
| Claude Code | `~/.claude` | `.claude` | `claude-plugin-v1` |

Cordis YAML is parsed with a bounded data-only reader for plain mappings, root sequences, and nested sequence mappings such as `- insert:` entries. Tags, anchors, aliases, merge keys, expressions, directives, block scalars, and flow collections are rejected rather than evaluated. Candidate fingerprints bind normalized candidate metadata, adapter and source-schema versions, effective scanner limits, all bytes and stable metadata in the bounded source snapshot, and symlink or special-file decisions. Unknown explicit schema versions produce an error diagnostic. Missing optional roots produce typed diagnostics and do not cause execution or fallback to another location. Pi authentication, model cache, trust state, and sessions are excluded before file reads. `PI_PACKAGE_DIR` only adds a discovery root; it never grants activation or runtime capabilities.
