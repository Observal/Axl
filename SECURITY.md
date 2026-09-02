<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security policy

The [security assurance case](docs/security/assurance-case.md) lists Axl's assets, trust boundaries, current controls, and known limits. Axl has not published release artifacts yet. [Release verification](docs/security/release-verification.md) defines what must be in place before that happens.

## Supported versions

Until Axl publishes its first release, only `main` receives security fixes. Afterward, fixes land on `main` first and are backported to the current stable `release/X.Y` branch and any older line carrying an `lts-X.Y` npm tag. Permanent release branches without an active stable or LTS channel remain available for audit but are not supported.

## Report a vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub Private Vulnerability Reporting in the canonical repository when it is available. Otherwise, email `hari@observal.io`.

Include the affected revision, expected impact, reproduction steps, and any suggested fix. Do not send live credentials or private user data.

## Response targets

- Acknowledge the report within 48 hours
- Provide an initial assessment within 7 days
- Aim to resolve a confirmed issue within 30 days, depending on complexity

Sandbox escapes, permission bypasses, and credential exposure are severity-one issues. When in doubt, report privately.

Release notes will credit valid reports unless the reporter asks to remain anonymous.
