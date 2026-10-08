#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 VishnuM049
# SPDX-License-Identifier: Apache-2.0
"""Publish a verified helper via a versioned bundle and atomic pointer switch.

A legacy installation that occupies the canonical path as a directory needs a separately
reviewed migration. Never remove the Keychain item, state, old helper, or old archive here.
"""

import hashlib
import importlib.util
import os
from pathlib import Path
import plistlib
import subprocess
import sys

CANONICAL = "AxlKeychainHelper.app"
VERSIONS = "keychain-helper-versions"


def publish(app: Path, archive: Path, parent: Path, team: str, verify) -> str:
    """Install from same-volume staging. Caller holds the exclusive installer lock."""
    canonical = parent / CANONICAL
    versions = parent / VERSIONS
    if parent.is_symlink() or parent.stat().st_uid != os.geteuid():
        raise ValueError("installation directory is not owned by this user")
    if versions.is_symlink():
        raise ValueError("versions directory is symlinked")
    versions.mkdir(mode=0o700, exist_ok=True)
    if versions.stat().st_uid != os.geteuid() or versions.stat().st_mode & 0o077:
        raise ValueError("versions directory is not owner-only")

    old = None
    if os.path.lexists(canonical):
        if not canonical.is_symlink():
            raise ValueError("legacy helper directory requires a reviewed migration")
        old = os.readlink(canonical)
        old_path = (parent / old).resolve(strict=True)
        if old_path.parent != versions.resolve() or old_path.name != Path(old).name:
            raise ValueError("unexpected installed helper target")
        verify(old_path, team)
    verify(app, team)
    digest = hashlib.sha256((app / "Contents/MacOS/axl-keychain-helper").read_bytes()).hexdigest()
    destination = versions / f"AxlKeychainHelper-{digest}.app"
    release_zip = versions / f"AxlKeychainHelper-{digest}.zip"
    if os.path.lexists(destination) or os.path.lexists(release_zip):
        raise ValueError("version already published; never overwrite release artifacts")
    if app.stat().st_dev != versions.stat().st_dev or archive.stat().st_dev != versions.stat().st_dev:
        raise ValueError("staging and destination must be on the same volume")
    os.rename(app, destination)
    # Until the pointer switch, even a crash leaves the old installed helper selected.
    verify(destination, team)
    os.rename(archive, release_zip)
    link = parent / f".axl-keychain-next-{os.getpid()}"
    target = str(Path(VERSIONS) / destination.name)
    try:
        os.symlink(target, link)
        os.replace(link, canonical)
        # Check the published pointer and the exact installed bytes. A failure restores the old
        # pointer atomically; a fresh install removes only the pointer, not any release artifact.
        if os.readlink(canonical) != target or canonical.resolve(strict=True) != destination.resolve():
            raise ValueError("installed helper changed during publication")
        verify(canonical.resolve(strict=True), team)
    except Exception:
        if canonical.is_symlink() and os.readlink(canonical) == target:
            if old is None:
                canonical.unlink()
            else:
                os.symlink(old, link)
                os.replace(link, canonical)
        raise
    finally:
        if os.path.lexists(link):
            link.unlink()
    return digest


def main() -> None:
    if len(sys.argv) != 5:
        raise ValueError("usage: publish-macos.py STAGED_APP STAPLED_ZIP PARENT TEAM_ID")
    spec = importlib.util.spec_from_file_location("verify_macos", Path(__file__).with_name("verify-macos.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    digest = publish(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4], module.verify)
    print(f"Installed verified helper version {digest}; previous version and Keychain data retained")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError, subprocess.CalledProcessError, plistlib.InvalidFileException) as error:
        print(f"Keychain helper publication failed: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)
