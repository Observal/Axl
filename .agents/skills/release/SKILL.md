---
name: release
description: Cut and maintain Axl release branches, prepare alpha, beta, rc, stable, and patch releases, create traceable backports from main, publish @observal/axl to npm and GitHub Releases, and recover failed release operations. Use for every Axl release, backport, channel promotion, release-status audit, or release-process change.
license: Apache-2.0
metadata:
  repository: Observal/Axl
  policy: RELEASES.md
---

# Axl release operations

Use this skill for any Axl release or backport task. Read [`RELEASES.md`](../../../RELEASES.md) completely before acting. It is the authoritative release policy.

## Hard rules

1. Never publish from `main`.
2. Publish only from a protected `release/X.Y` branch.
3. Never merge a release branch back into `main`.
4. Land ordinary fixes on `main` first.
5. Backport merged main PRs with `git cherry-pick -x` through a pull request.
6. Never force-push or rebase a published release branch.
7. Never move a published tag.
8. Never republish an npm version.
9. Never let an older maintenance line move npm's `latest` tag backward.
10. Never bypass failed checks, provenance verification, checksum verification, SBOM validation, OpenVEX review, or DCO.

A release branch is intentionally independent after it is cut. A PR targeting `release/0.2` must be current with `release/0.2`, not with `main`.

## Safety

Release actions create external side effects. Before cutting a remote branch, pushing a release-preparation branch, creating a backport PR, tagging, or publishing, obtain explicit user approval for that action unless the user's current request already grants it.

Do not expose credentials, npm tokens, environment files, GitHub App keys, or OIDC material. Use npm trusted publishing and GitHub workflow identity.

Use `--force-with-lease` only when a reviewed PR branch must be rebased. Never force a release branch or tag.

## Prerequisites

Confirm:

```bash
git status --short --branch
git remote -v
gh auth status
node --version
pnpm --version
```

The worktree must be clean. `upstream` must point to `Observal/Axl`. The local target branch must exactly match its canonical upstream branch before release tooling runs.

Run repository checks before publication:

```bash
pnpm check
pnpm audit --audit-level high
uvx --from reuse==6.2.0 reuse lint
```

## Inspect release state

From `main`, list release lines:

```bash
pnpm release -- --status
```

From a release branch, show its latest tag and unreleased commits:

```bash
pnpm release -- --status
```

Also inspect immutable history directly:

```bash
git tag --merged HEAD --list 'v*'
git log --oneline "$(git describe --tags --abbrev=0)..HEAD"
```

Do not rely on memory or compare only commit hashes. Rebase merges and cherry-picks create different hashes for equivalent patches.

## Cut a release line

Only cut from exact canonical `main`:

```bash
git switch main
git fetch upstream --prune
git merge --ff-only upstream/main
pnpm release -- --cut 0.2
```

The command creates `upstream/release/0.2` at the current `main` commit. It does not publish a release.

After branch creation:

```bash
git fetch upstream --prune
git switch --track upstream/release/0.2
```

Verify the repository ruleset covers the new branch before accepting changes.

## Backport a main PR

The source PR must already be merged to `main`.

```bash
pnpm release -- --backport 123 --to release/0.2
```

The command creates an isolated worktree, reads all commits from PR #123, cherry-picks them in order with `-x`, pushes `backport/0.2/123`, and opens a PR against `release/0.2`.

Review the resulting PR for:

- `Backport-of: #123`;
- the target release branch;
- every original commit SHA;
- preserved DCO trailers;
- conflict-resolution changes;
- release-line compatibility; and
- required release-note updates.

Apply backports from newest to oldest supported line:

```text
main
release/0.4
release/0.3
release/0.2
```

If a cherry-pick conflicts, the tool preserves `.worktrees/backport-X.Y-N`. Inspect the conflict, resolve it explicitly, run focused tests, continue the cherry-pick, and update the same backport branch. Never skip a conflicting commit silently.

## Verify a backport

Use PR linkage and patch equivalence:

```bash
git cherry release/0.2 main
git show ORIGINAL_SHA | git patch-id --stable
git show BACKPORT_SHA | git patch-id --stable
```

Record branch-specific status with labels when available:

```text
backport/0.2-requested
backport/0.2-complete
```

A backport is complete only when its target PR is merged and required checks pass.

## Prepare a release

Check out the exact release line:

```bash
git switch release/0.2
git fetch upstream --prune
git merge --ff-only upstream/release/0.2
```

Preview first:

```bash
pnpm release:preview
```

Prepare interactively:

```bash
pnpm release
```

Or select a channel:

```bash
pnpm release -- --channel alpha
pnpm release -- --channel beta
pnpm release -- --channel rc
pnpm release -- --channel stable
```

The release command creates a `release-prep/vX.Y.Z` branch and PR against the current release branch. It must never target `main`.

## Channels

| Channel | SemVer | npm tag | GitHub type |
| --- | --- | --- | --- |
| alpha | `X.Y.Z-alpha.N` | `alpha` | prerelease |
| beta | `X.Y.Z-beta.N` | `beta` | prerelease |
| rc | `X.Y.Z-rc.N` | `next` | prerelease |
| stable | `X.Y.Z` | `latest` or `lts-X.Y` | full release |

The tool increments serials and rejects backward channel movement. An older stable line receives `lts-X.Y`, not `latest`.

## Review the release-preparation PR

The PR should change only:

```text
.release.json
.github/release-notes.md
distribution/npm/package.json
```

Confirm:

- the target is `release/X.Y`;
- `.release.json.branch` names that branch;
- `.release.json.cutoff` equals the release commit's eventual parent;
- version and channel agree;
- npm tag policy is correct;
- all intended backports are present;
- release notes are accurate;
- comparison links are correct;
- checks pass; and
- the commit carries a matching DCO sign-off.

If the release branch advances, rebase the release-preparation branch and regenerate the cutoff. The workflow rejects stale metadata.

## Common scenarios

### Stable bug needs a patch release

Suppose `0.2.0` is stable and a bug needs `0.2.1`:

1. Fix the bug through a PR to `main`.
2. Wait for that PR to merge through rebase.
3. Run `pnpm release -- --backport PR --to release/0.2`.
4. Review and merge the backport PR.
5. Run `pnpm release -- --channel rc` if the fix needs a release candidate, producing `0.2.1-rc.1`.
6. Run `pnpm release -- --channel stable` when approved, producing `0.2.1`.

Do not patch `release/0.2` directly and remember to fix `main` later.

### Bug found during alpha or beta

Suppose `0.3.0-beta.1` has a bug:

1. Fix and merge the bug on `main`.
2. Backport the main PR to `release/0.3`.
3. Merge the backport PR.
4. Prepare another beta with `pnpm release -- --channel beta`, producing `0.3.0-beta.2`.
5. Move to rc only when the release line is ready.

The tool increments the serial for the current channel and refuses movement from beta back to alpha or rc back to beta.

### One fix affects several stable lines

For a fix needed in `0.4`, `0.3`, and `0.2`:

1. Merge the source fix to `main`.
2. Backport to `release/0.4` and merge.
3. Backport to `release/0.3` and merge.
4. Backport to `release/0.2` and merge.
5. Prepare and publish a patch from each affected release branch.
6. Verify each `.release.json` records its own backport PR.

Never copy the newest release branch into an older one. Each line gets an explicit PR and independent checks.

### Emergency fix starts under embargo

If disclosure rules require private release-branch work, record a mandatory forward-port to `main` before publication. After disclosure, apply and verify the equivalent patch on `main`. The task is incomplete until both histories contain equivalent code.

## Automatic publication

Merging the release-preparation PR into `release/X.Y` triggers `.github/workflows/release.yml`.

The workflow:

1. validates the release commit and manifest;
2. runs checks, audit, and REUSE;
3. builds and smoke-tests `@observal/axl`;
4. generates a CycloneDX SBOM, OpenVEX document, and checksums;
5. creates and verifies a signed tag;
6. publishes the tarball to npm using trusted publishing;
7. attests the package and security metadata;
8. publishes the same package bytes to an immutable GitHub Release; and
9. downloads and verifies public artifacts.

Do not run `npm publish`, `gh release create`, or `git tag` manually as a substitute for this workflow.

## Published artifacts

Expected GitHub assets:

```text
observal-axl-X.Y.Z.tgz
observal-axl-X.Y.Z.cdx.json
observal-axl-X.Y.Z.openvex.json
install.sh
checksums.txt
build-provenance.intoto.jsonl
```

The npm package is:

```text
@observal/axl@X.Y.Z
```

The npm and GitHub tarballs must be byte-identical.

## Post-release verification

Check workflow results:

```bash
gh run list --repo Observal/Axl --workflow release.yml --limit 5
gh release view vX.Y.Z --repo Observal/Axl
gh release verify vX.Y.Z --repo Observal/Axl
npm view @observal/axl@X.Y.Z version dist.integrity
```

Download and verify:

```bash
gh release download vX.Y.Z --repo Observal/Axl --dir axl-release
cd axl-release
sha256sum --check checksums.txt
```

Follow [`docs/security/release-verification.md`](../../../docs/security/release-verification.md) for provenance and signed-tag checks.

## Recovery

### Preparation failure

Inspect the preserved `.worktrees/release-vX.Y.Z`. Do not rerun until the existing branch and worktree are understood.

### Backport conflict

Resolve the preserved backport worktree and continue the exact cherry-pick sequence. Do not delete conflict evidence or omit a commit.

### npm version exists

The workflow compares SHA-512 integrity. Continue only when npm contains identical bytes.

### GitHub asset exists

The workflow downloads and compares the asset. Continue only when bytes match.

### Tag exists

The tag must point to the expected release commit and verify against the release workflow's OIDC identity. Never move it.

## Completion report

After a release task, report:

- release branch;
- source `main` PRs and backport PRs;
- version and channel;
- npm dist-tag;
- release-preparation PR;
- release commit and signed tag;
- exact checks run and outcomes;
- npm package URL;
- GitHub Release URL;
- provenance and checksum verification;
- SBOM validation and any reviewed OpenVEX statements; and
- anything not verified.
