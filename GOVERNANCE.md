<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Axl governance

Status: bootstrap governance

Axl currently uses a benevolent dictator for life, or BDFL, governance model. The project is young, so this document names the accountable decision-maker without inventing committees or maintainer structures that do not exist yet.

## BDFL

Hari Srinivasan ([@Haz3-jolt](https://github.com/Haz3-jolt)) is Axl's founder and BDFL.

The BDFL has final authority over:

- project direction and scope;
- kernel, protocol, security, and compatibility guarantees;
- repository policy and release approval;
- maintainer appointments and removal;
- governance changes; and
- decisions that do not reach consensus through ordinary review.

The BDFL should seek technical consensus, explain material decisions in public repository artifacts, and use final authority only when a clear decision is needed.

Protected branches require two approvals. Until another maintainer role is delegated, the BDFL may use the repository administrator bypass to merge reviewed work that satisfies every required check.

## Routine contributions

Contributors propose changes through issues and pull requests. Review requirements, DCO sign-off, licensing, testing, and AI-assistance rules are defined in [CONTRIBUTING.md](CONTRIBUTING.md), [AI_POLICY.md](AI_POLICY.md), and [OPEN_SOURCE.md](OPEN_SOURCE.md).

Accepted changes become project decisions when they merge. Changes to kernel guarantees, event formats, the extension API, security boundaries, or the wire protocol require prior design discussion and an RFC when requested by the BDFL.

## Maintainers

No maintainer roles have been delegated yet. The BDFL currently performs maintainer duties for every project area.

This section is intentionally a stub. Maintainer areas, appointment criteria, permissions, inactivity rules, and removal procedures will be documented when the contributor base requires them.

## Succession

No standing succession process has been adopted yet.

This section is intentionally a stub. A succession policy will be added before authority is delegated broadly or the project reaches a stable release.

## Amendments

Governance changes use the normal pull request process and require BDFL approval. The repository history is the authoritative record of amendments.
