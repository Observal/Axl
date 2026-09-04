<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Axl open source plan

Status: working plan. This document accompanies [ROADMAP.md](ROADMAP.md).

Updated: 2026-08-28

## 1. Why Axl is open source

Axl asks users to trust it with source code, credentials, commands, and local configuration. Its core claims need to be inspectable.

- The adoption compiler converts existing setups into code that runs on the user's machine. Users must be able to inspect the converter, provenance records, and verification process.
- The sandbox and permission system claims to enforce real boundaries. Those claims should be open to review.
- The learning loop changes local instructions based on user behavior. Source access makes those changes understandable and auditable.
- A product built around avoiding lock-in should not create a new proprietary lock-in.

Open source is part of Axl's trust model as well as its distribution model.

## 2. License

All Axl code is licensed under Apache-2.0. This includes the kernel, clients, adoption compiler, extension API, mobile apps, and cloud adapters. The project will not use an open-core split, feature paywalls, or dual licensing.

Apache-2.0 provides an explicit patent grant and clear contribution terms. Those protections matter for infrastructure that may attract corporate contributors. The contribution terms also let Axl use DCO sign-offs instead of a contributor license agreement.

Third-party work carries its original obligations:

- Any approved adaptation keeps the original copyright notice and license text and records its provenance in the file and `NOTICE`.
- Independently implemented behavior based on public specifications or black-box observation must not copy or translate external source.
- Every file has SPDX copyright and license information. `REUSE.toml` covers files that cannot hold comments, and CI runs REUSE checks.

## 3. Governance

Axl currently uses bootstrap BDFL governance. Hari Srinivasan ([@Haz3-jolt](https://github.com/Haz3-jolt)) is the founder and BDFL. The BDFL owns final project, architecture, security, repository-policy, release, and governance decisions.

No maintainer roles, area ownership, committees, or succession process have been delegated yet. The BDFL currently performs those duties. Future roles remain intentionally unspecified until the contributor base requires them.

Changes to a kernel guarantee, event format, extension API, security boundary, or protocol require prior design discussion in an issue. Other changes use the normal pull request process.

[GOVERNANCE.md](GOVERNANCE.md) is the authoritative statement of current decision authority and role status.

## 4. Contributions

### DCO instead of a CLA

Every commit must include a matching `Signed-off-by` trailer. The sign-off certifies that the contributor has the right to submit the work under Apache-2.0. Axl does not require a contributor license agreement or copyright assignment.

### AI-assisted work

AI-assisted contributions are welcome. The accountable contributor must direct the work, review the complete change, understand it, and authorize publication. The pull request template records the tool and model used, along with the review and test work performed.

Unattended pull requests, bulk-generated patches without human ownership, and issue spam are closed. See [AI_POLICY.md](AI_POLICY.md) for the full policy.

### Review requirements

Protected branches require two human approvals and BDFL approval. During bootstrap, the BDFL may use the documented administrator bypass until another maintainer role is delegated. Behavior changes include tests, and compatibility fixtures remain part of the regression floor.

The adoption compiler should produce useful starter issues. Each issue should cover one ecosystem quirk, conversion gap, or catalog failure and include a reproduction.

## 5. Working with other ecosystems

Axl converts resources from OpenCode, DSH, Claude Code, and open standards. It should help those communities rather than strip value from them.

- Report upstream bugs and offer fixes when possible.
- Preserve authorship, licenses, notices, and provenance during conversion.
- Let plugin authors run Axl's compatibility tests in their own CI.
- Do not convert packages whose licenses forbid it.
- Describe compatibility accurately and avoid hostile comparisons with other projects.

The public message is simple: users keep their existing setup and gain another runtime.

## 6. Project organization

- Keep the kernel, protocol, clients, compiler, providers, and apps in one monorepo. [CODE_STRUCTURE.md](CODE_STRUCTURE.md) explains the boundaries and CI layout.
- Keep plans in the repository so changes go through normal review.
- Use issues, versioned architecture specifications, and public chat for decisions. Summarize any private discussion in the public record.
- Follow semantic versioning. Before 1.0, minor releases may break compatibility, and the changelog must say so clearly.
- Treat CI as part of the product. Automated review can help, but it does not replace a human approval.

## 7. Security engineering

Axl establishes repository and supply-chain controls from the start. OpenSSF certification, Scorecard automation, OSS-Fuzz integration, public targets, and badges arrive during release hardening, after the underlying controls exist.

A tool that runs model-selected commands is security-sensitive. The project does not defer sandboxing, pinned dependencies, least-privilege workflows, or fail-closed behavior.

### 7.1 Supply chain

- Pin GitHub Actions to full commit SHAs and include the readable version in a comment.
- Pin container images to multi-platform manifest digests.
- Treat lockfiles as the dependency authority. Do not use unversioned requirement files or `curl | sh` install steps.
- Default workflow tokens to read-only and raise permissions only for jobs that need them.
- Run dependency review on every pull request and audit lockfiles in CI.
- Publish an SBOM with each release.

### 7.2 Signed and verifiable releases

- Produce keyless Sigstore provenance attestations with the release workflow's OIDC identity.
- Sign release tags with gitsign under the same identity.
- Verify attestations before publishing artifacts.
- Resolve tags to commit SHAs at the start of release jobs.
- Make publish jobs safe to resume.
- Publish clear instructions for checking digests, artifact provenance, and tag signatures.

### 7.3 Continuous verification

- Add OpenSSF Scorecard during release hardening, run it weekly and on pushes to `main`, and publish the results.
- Run CodeQL without path filters, including for merge-queue candidates.
- Add OSS-Fuzz once trust-boundary parsers are ready. Targets include adoption inspectors, session imports, dialect renderers, and the event-log reader.
- Run Gitleaks in CI and secret checks in pre-commit. Test fixtures must use obviously fake credentials.
- Lint workflows and container definitions in pre-commit.

### 7.4 Branch protection and merge queue

- Changes reach `main` through pull requests and a merge queue with linear history.
- CI, CodeQL, dependency review, and secret scanning run against the queued merge candidate.
- Kernel and security-boundary changes retain the two-reviewer rule.
- Maintainer accounts require two-factor authentication.
- Release credentials belong to the workflow identity rather than individual maintainers.

### 7.5 Disclosure and assurance

- `SECURITY.md` lists private reporting channels and response targets of 48 hours for acknowledgement, 7 days for assessment, and 30 days for resolution.
- Sandbox escapes, permission bypasses, and credential exposure are severity-one issues.
- Security fixes may be developed privately and disclosed after release. Reporters receive credit unless they decline it.
- The security assurance case records claims, assets, attackers, trust boundaries, requirements, mitigations, residual risks, and maintenance commitments.
- Security controls such as seccomp profiles, egress rules, and extension isolation live in the repository and remain open to audit.

## 8. Repository documents

Each contributor document has a specific job:

| File | Purpose |
| --- | --- |
| `AI_POLICY.md` | Sets the human-review and disclosure requirements for AI-assisted work. |
| `.github/pull_request_template.md` | Collects purpose, approach, tests, provenance, and AI-assistance details. |
| `CONTRIBUTING.md` | Summarizes contribution policy, licensing, commits, and review. |
| `GOVERNANCE.md` | Names current decision authority and records the status of project roles. |
| `AGENTS.md` | Gives coding agents the same repository rules contributors follow. |
| `SETUP.md` | Covers installation, provider setup, first use, and development commands. |
| `docs/DEVELOPMENT_GUIDE.md` | Explains the complete contributor workflow and current architecture. |
| `RELEASES.md` | Defines release branches, backports, channels, publication, and verification gates. |
| `.github/CODEOWNERS` | Maps default, security, and release ownership. |
| `.github/ISSUE_TEMPLATE/` | Provides forms for bugs, features, and adoption targets. |
| `SECURITY.md` | Lists private reporting channels and response times. |
| `docs/security/assurance-case.md` | States the current security argument and residual risks. |
| `docs/security/release-verification.md` | Explains how to verify release artifacts and tags. |
| `CODE_OF_CONDUCT.md` | Defines expected community behavior. |
| `ROADMAP.md` and `CHANGELOG.md` | Show current plans and user-visible changes. |
| Repository policy and workflow files | Enforce licensing, secret scanning, review, and CI rules. |

Documentation should describe controls that actually exist. CI checks claims such as SPDX coverage and DCO sign-offs where practical.

## 9. Compatibility catalog

The compatibility catalog is a public record of how real plugins, skills, and configurations behave under adoption.

- Anyone can rerun a catalog conversion and compare the result.
- A failing entry becomes an issue with a reproduction.
- Plugin authors can verify their entries, record caveats, and run the conformance suite in their own CI.
- The catalog reports compatibility without judging the quality of another project.

## 10. Community conduct

Axl follows its [Code of Conduct](CODE_OF_CONDUCT.md). Maintainers should be direct, technical, and respectful in reviews. English is the language for durable project artifacts, but contributors are not penalized for imperfect English.

## 11. Trademark and name

Apache-2.0 covers the code, not the Axl name or mark. A separate, permissive trademark policy will allow unmodified redistribution and truthful compatibility claims such as "works with Axl." Forks are welcome under names that do not claim to be the canonical Axl project.

## 12. Constraints

- No CLA or copyright assignment.
- No open-core split or feature paywall in this repository.
- No private roadmap that conflicts with the public plan.
- No committees or working groups until the contributor base needs them.
- No hostile marketing against the ecosystems Axl supports.
- No AI-assistance rules that project maintainers cannot meet themselves.

## 13. Success criteria

This plan is working when:

1. A contributor's first pull request lands within days without requiring BDFL involvement.
2. A plugin author independently verifies a catalog entry.
3. An upstream project accepts a fix found through Axl's adoption work.
4. A compliant fork exists without causing a governance dispute.
5. The project has rejected at least one kernel proposal on its merits.
6. A private security report is fixed and disclosed within the published timeline.
7. A maintainer joins who did not know the founding team before contributing.
8. The project earns the OpenSSF Best Practices Gold badge and sustains a Scorecard of 9 or higher during release hardening.
