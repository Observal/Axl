#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 VishnuM049
# SPDX-License-Identifier: Apache-2.0
"""Fail-closed verification of a stapled, signed Axl Keychain helper app."""

import datetime
import pathlib
import plistlib
import re
import subprocess
import sys

BUNDLE_ID = "ai.observal.axl.keychain-helper"


def run(*args: str) -> bytes:
    return subprocess.check_output(args, stderr=subprocess.PIPE)


def verify(app: pathlib.Path, team: str) -> None:
    if not re.fullmatch(r"[A-Z0-9]{10}", team):
        raise ValueError("invalid team identifier")
    if app.is_symlink() or not app.is_dir():
        raise ValueError("bundle missing or symlinked")
    binary = app / "Contents/MacOS/axl-keychain-helper"
    profile = app / "Contents/embedded.provisionprofile"
    if binary.is_symlink() or not binary.is_file() or profile.is_symlink() or not profile.is_file():
        raise ValueError("binary or embedded profile missing or symlinked")
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != BUNDLE_ID or info.get("CFBundleExecutable") != binary.name:
        raise ValueError("unexpected bundle identity")

    run("codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app))
    details = subprocess.run(
        ["codesign", "--display", "--verbose=4", str(app)],
        check=True, capture_output=True, text=True,
    ).stderr
    if (f"TeamIdentifier={team}" not in details.splitlines()
            or "Authority=Developer ID Application:" not in details
            or not re.search(r"^Timestamp=", details, re.MULTILINE)
            or not re.search(r"^CodeDirectory .*flags=.*\bruntime\b", details, re.MULTILINE)):
        raise ValueError("Developer ID team, timestamp, or hardened runtime missing")
    entitlements = plistlib.loads(run("codesign", "--display", "--entitlements", ":-", str(app)))
    identity = f"{team}.{BUNDLE_ID}"
    required = {
        "com.apple.application-identifier": identity,
        "com.apple.developer.team-identifier": team,
        "keychain-access-groups": [identity],
    }
    if entitlements != required:
        raise ValueError("unexpected signed entitlements")
    provision = plistlib.loads(run("security", "cms", "-D", "-i", str(profile)))
    if (team not in provision.get("TeamIdentifier", [])
            or provision.get("Entitlements", {}).get("application-identifier") != identity
            or identity not in provision.get("Entitlements", {}).get("keychain-access-groups", [])
            or provision.get("ExpirationDate") is None
            or provision["ExpirationDate"] <= datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)):
        raise ValueError("provisioning profile does not grant the helper's exact identity")
    run("xcrun", "stapler", "validate", str(app))
    run("spctl", "--assess", "--type", "execute", str(app))


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("usage: verify-macos.py APP TEAM_ID")
        verify(pathlib.Path(sys.argv[1]), sys.argv[2])
    except (ValueError, OSError, subprocess.CalledProcessError, plistlib.InvalidFileException) as error:
        print(f"Keychain helper verification failed: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)
    print("Keychain helper signature, profile, hardened runtime, and notarization verified")
