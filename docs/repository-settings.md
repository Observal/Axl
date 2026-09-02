<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GitHub repository settings

Create branch rulesets for `main` and `release/**` with these settings:

- Require pull requests and dismiss stale approvals.
- Require review from code owners.
- Require two approvals for kernel and security-boundary changes.
- Allow rebase merging only. Disable merge commits and squash merging.
- Require branches to be current with their target branch.
- Require linear history.
- Require `main` to use a rebase merge queue. Release branches may rebase-merge directly after checks.
- Block force pushes and branch deletion.
- During bootstrap governance, grant the repository administrator the sole ruleset bypass.
- Require the CI, DCO, dependency-review, CodeQL, and Gitleaks checks used for pull requests.
- Require two-factor authentication for maintainers.

Create a tag ruleset for `v*` that blocks deletion and updates and requires signed tags. Enable GitHub Immutable Releases so published assets and their associated tag cannot change. Keep repository write access limited until a dedicated release GitHub App is installed, then restrict tag creation to that App.

Configure release publication:

- Create a protected `npm` environment restricted to `release/**`.
- Configure npm trusted publishing for `@observal/axl` and `.github/workflows/release.yml`.
- Enable GitHub artifact attestations.
- Keep workflow permissions read-only by default.

Enable the dependency graph, dependency security alerts, secret scanning, push protection, code scanning, and GitHub Private Vulnerability Reporting.

These settings live on GitHub rather than in this repository. Verify them after creating the canonical remote and whenever required checks, release branches, or publishing identities change.
