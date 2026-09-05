<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contributing to Axl

Contributions to code, tests, documentation, and design are welcome. Read the [Code of Conduct](CODE_OF_CONDUCT.md), [AI Policy](AI_POLICY.md), [governance](GOVERNANCE.md), and [development guide](docs/DEVELOPMENT_GUIDE.md) before contributing. Coding agents must also follow [AGENTS.md](AGENTS.md).

## Prerequisites

- Node.js `^22.19.0` or `>=24.0.0`
- pnpm `10.34.4`
- Git
- Python `3.11+`, `uv`, and REUSE `6.2.0` for local license checks
- pre-commit for local hooks

## Fork and clone

Fork the canonical repository, clone your fork, and add the canonical repository as `upstream`.

```bash
git clone <your-fork-url>
cd axl
git remote add upstream <canonical-repository-url>
```

## Run locally

```bash
pnpm install --frozen-lockfile
pnpm check
```

See [SETUP.md](SETUP.md) for provider configuration and local CLI usage.

## Find and claim work

Search existing issues first. Discuss changes to kernel guarantees, event formats, the extension API, or the wire protocol in an issue before implementation. Include compatibility notes with the change.

## Make changes

### Branch names

Use a short descriptive branch name such as `feature/event-schema`, `fix/log-recovery`, or `docs/setup`.

Never commit directly to `main`.

### Code style

```bash
pnpm format
pnpm lint
pnpm typecheck
```

Use TypeScript for application code. Prefer Node.js built-ins to new dependencies. Ask before adding a production dependency.

### Package boundaries

- `packages/protocol` has no runtime dependencies.
- `packages/kernel` may depend only on `packages/protocol` and Node.js built-ins.
- Extensions use only public package exports and never import kernel source paths.
- Mobile clients, when added, import only their generated SDK.

`pnpm check:boundaries` enforces these rules.

### Generated files

Do not edit generated files. Change their source or generator and regenerate. Generated TypeScript files must use the `*.generated.ts` suffix, name their generator in the required header, and pass `pnpm check:generated`.

### SPDX and provenance

Every file must carry SPDX copyright and license information. Files that cannot contain comments are covered by `REUSE.toml`.

Before changing an existing file, inspect its surviving authorship:

```bash
git blame --line-porcelain --follow -- path/to/file
```

Preserve existing copyright lines and add one `SPDX-FileCopyrightText` line for every contributor whose authored lines remain in the file. Use the contributor identity and contribution year from Git history. Collapse consecutive years into a range. Do not infer ownership from another file or replace contributor names with a company name unless the contributor or repository policy establishes that ownership.

For a new file, add the creating contributor's copyright line and the repository license identifier. For JSON, generated fixtures, license texts, and other files that cannot carry comments, add exact path coverage to `REUSE.toml` with every applicable copyright holder. Do not edit generated files to change headers. Update the generator or REUSE annotation and regenerate instead.

Credit externally inspired behavior beside its implementation with a source link and note that it was independently implemented from public interfaces or black-box observation. Preserve required attribution and notices for copied or adapted material.

```bash
reuse lint
```

### Tests

Add the smallest runnable test that would fail if non-trivial behavior regressed. Run the focused test first, then broader checks when risk warrants it.

```bash
pnpm test
pnpm check
```

### Commit messages and DCO

Use concise conventional commit subjects. Sign off every commit to certify the [Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit --signoff -m "feat(protocol): add event version"
```

### Release notes

Describe user-visible changes in the pull request. Release preparation generates GitHub Release notes from merged pull requests and commits.

## Submit a pull request

1. Update your branch from `upstream/main`.
2. Review the complete diff.
3. Run the relevant checks and record their results.
4. Complete the pull request template, including AI assistance and external provenance.
5. Resolve all review and CI findings.

Keep each pull request focused on one concern. Protected branches require two approvals and BDFL approval. During bootstrap, the BDFL may use the documented administrator bypass until another maintainer role is delegated.

## Report issues

Use the issue forms for bugs, feature requests, and adoption targets. Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Contributions are accepted under Apache-2.0 through DCO sign-off. Axl does not require a contributor license agreement or copyright assignment.
