<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Verify an Axl release

Axl has not published a release. Source archives and local builds are not signed release artifacts. Maintainers must complete the gate in [RELEASES.md](../../RELEASES.md) before publishing the first release.

Published Axl releases are built from protected `release/X.Y` branches. The same npm package tarball is published to GitHub Releases and npm. GitHub keyless provenance binds the artifact to the release workflow, and a separately signed tag binds the version to its source commit.

Checksums detect corrupted downloads. They do not prove who produced an artifact. Verify checksums, provenance, and the signed tag.

## Choose a release

Replace `v0.2.1` and `release/0.2` in the examples with the release you are verifying:

```bash
version=v0.2.1
series=release/0.2
```

Alpha, beta, and release-candidate tags include the prerelease suffix:

```text
v0.2.0-alpha.1
v0.2.0-beta.1
v0.2.0-rc.1
```

## Download GitHub Release assets

Install the [GitHub CLI](https://cli.github.com/), then run:

```bash
gh release download "$version" \
  --repo Observal/Axl \
  --dir axl-release
cd axl-release
```

Expected assets are:

```text
observal-axl-X.Y.Z.tgz
observal-axl-X.Y.Z.cdx.json
observal-axl-X.Y.Z.openvex.json
install.sh
checksums.txt
build-provenance.intoto.jsonl
```

## Verify the immutable GitHub Release

GitHub generates a release attestation when the draft becomes an immutable release. Verify the release and each downloaded asset:

```bash
gh release verify "$version" --repo Observal/Axl
for artifact in ./*; do
  gh release verify-asset "$version" "$artifact" --repo Observal/Axl
done
```

Both commands must identify `Observal/Axl`, the selected tag, and matching asset digests.

## Verify checksums

On Linux:

```bash
sha256sum --check checksums.txt
```

On macOS:

```bash
shasum -a 256 --check checksums.txt
```

The command must report success for the package tarball, installer, SBOM, and OpenVEX document.

## Inspect the SBOM and OpenVEX document

The CycloneDX 1.5 SBOM must identify the exact package version:

```bash
jq '{specVersion, component: .metadata.component, components: (.components | length)}' \
  ./observal-axl-0.2.1.cdx.json
```

Confirm `specVersion` is `1.5`, the component name is `@observal/axl`, and the version is `0.2.1`.

Inspect the OpenVEX statements:

```bash
jq '{context: .["@context"], id: .["@id"], timestamp, statements}' \
  ./observal-axl-0.2.1.openvex.json
```

Each non-empty statement is a maintainer-reviewed vulnerability status claim. An empty statement list means that the project makes no VEX exception claims for that release. It does not mean that the package has no vulnerabilities.

## Verify GitHub provenance

Verify every checksummed asset against the downloaded provenance bundle:

```bash
for artifact in \
  ./observal-axl-0.2.1.tgz \
  ./observal-axl-0.2.1.cdx.json \
  ./observal-axl-0.2.1.openvex.json \
  ./install.sh \
  ./checksums.txt; do
  gh attestation verify "$artifact" \
    --repo Observal/Axl \
    --bundle ./build-provenance.intoto.jsonl \
    --signer-workflow "Observal/Axl/.github/workflows/release.yml@refs/heads/$series"
done
```

Successful verification checks each artifact digest, the Sigstore certificate chain, source repository, source revision, and release workflow identity.

## Verify the signed tag

Install [gitsign](https://github.com/sigstore/gitsign), clone the repository, and fetch the tag:

```bash
cd ..
git clone https://github.com/Observal/Axl.git axl-source
cd axl-source
git fetch origin tag "$version"
```

Verify the tag identity:

```bash
gitsign verify-tag "$version" \
  --certificate-identity "https://github.com/Observal/Axl/.github/workflows/release.yml@refs/heads/$series" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Confirm the tagged commit belongs to the expected release branch:

```bash
git fetch origin "$series"
git merge-base --is-ancestor "$version^{commit}" "origin/$series"
```

A zero exit status confirms ancestry. The tag must not point to `main` release metadata or an unrelated branch.

## Compare GitHub and npm package bytes

Download the exact package from npm without installing it:

```bash
mkdir ../npm-copy
cd ../npm-copy
npm pack @observal/axl@0.2.1
```

Compare it with the GitHub Release tarball:

```bash
cmp ./observal-axl-0.2.1.tgz ../axl-release/observal-axl-0.2.1.tgz
```

No output and a zero exit status mean both destinations contain identical bytes.

Inspect npm metadata and provenance:

```bash
npm view @observal/axl@0.2.1 version dist.integrity dist.tarball
```

## Test an isolated install

Install the downloaded GitHub tarball into a temporary prefix:

```bash
prefix=$(mktemp -d)
npm install --prefix "$prefix" --ignore-scripts \
  ../axl-release/observal-axl-0.2.1.tgz
"$prefix/node_modules/.bin/axl" --version
"$prefix/node_modules/.bin/axl" --help
```

The reported version must match the release exactly.

## Verify channel metadata

Expected npm tags are:

| Version | Expected tag |
| --- | --- |
| `X.Y.Z-alpha.N` | `alpha` |
| `X.Y.Z-beta.N` | `beta` |
| `X.Y.Z-rc.N` | `next` |
| Current stable line | `latest` |
| Older maintained line | `lts-X.Y` |

Inspect tags:

```bash
npm dist-tag ls @observal/axl
```

An older maintenance release must not move `latest` backward.

## Report a verification failure

Stop using the artifact if any digest, provenance, signature, ancestry, version, or byte comparison fails.

Report the failure privately through the process in [SECURITY.md](../../SECURITY.md). Include:

- release version;
- failing command and complete non-secret output;
- downloaded filenames and digests;
- operating system and tool versions; and
- whether npm, GitHub Releases, or both were affected.

Do not work around a verification failure by disabling checks or downloading an unverified replacement from another location.
