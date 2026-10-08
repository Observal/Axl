# SPDX-FileCopyrightText: 2026 VishnuM049
# SPDX-License-Identifier: Apache-2.0

import datetime
import importlib.util
import pathlib
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

module_path = pathlib.Path(__file__).with_name("verify-macos.py")
spec = importlib.util.spec_from_file_location("verify_macos", module_path)
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
TEAM = "ABCDEFGHIJ"
IDENTITY = f"{TEAM}.{verifier.BUNDLE_ID}"


class VerifyMacosTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = pathlib.Path(self.tmp.name) / "AxlKeychainHelper.app"
        binary = self.app / "Contents/MacOS/axl-keychain-helper"
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"test only")
        (self.app / "Contents/Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": verifier.BUNDLE_ID,
            "CFBundleExecutable": binary.name,
        }))
        (self.app / "Contents/embedded.provisionprofile").write_bytes(b"test only")
        self.entitlements = {
            "com.apple.application-identifier": IDENTITY,
            "com.apple.developer.team-identifier": TEAM,
            "keychain-access-groups": [IDENTITY],
        }
        self.profile = {
            "TeamIdentifier": [TEAM],
            "Entitlements": {"application-identifier": IDENTITY,
                             "keychain-access-groups": [IDENTITY]},
            "ExpirationDate": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
                              + datetime.timedelta(days=1),
        }
        self.details = (f"TeamIdentifier={TEAM}\nAuthority=Developer ID Application: test\n"
                        "Timestamp=Jan 1, 2026\nCodeDirectory v=20400 size=4 flags=0x10000(runtime)\n")
        self.calls = []

    def command(self, *args):
        self.calls.append(args)
        if args[:3] == ("codesign", "--display", "--entitlements"):
            return plistlib.dumps(self.entitlements)
        if args[:3] == ("security", "cms", "-D"):
            return plistlib.dumps(self.profile)
        return b""

    def display(self, *args, **kwargs):
        return subprocess.CompletedProcess(args, 0, stderr=self.details)

    def verify(self):
        with patch.object(verifier, "run", self.command), patch.object(verifier.subprocess, "run", self.display):
            verifier.verify(self.app, TEAM)

    def test_valid_bundle_requires_staple_and_gatekeeper(self):
        self.verify()
        self.assertTrue(any(call[:3] == ("xcrun", "stapler", "validate") for call in self.calls))
        self.assertTrue(any(call[:3] == ("spctl", "--assess", "--type") for call in self.calls))

    def test_rejects_wrong_entitlement_and_wildcard_profile(self):
        self.entitlements["keychain-access-groups"] = ["*"]
        with self.assertRaisesRegex(ValueError, "entitlements"):
            self.verify()
        self.entitlements["keychain-access-groups"] = [IDENTITY]
        self.profile["Entitlements"]["application-identifier"] = f"{TEAM}.*"
        with self.assertRaisesRegex(ValueError, "profile"):
            self.verify()

    def test_rejects_adhoc_and_missing_runtime(self):
        self.details = f"TeamIdentifier={TEAM}\nAuthority=Apple Development: test\nTimestamp=now\n"
        with self.assertRaisesRegex(ValueError, "runtime"):
            self.verify()

    def test_rejects_notarization_failure(self):
        def failed(*args):
            if args[:3] == ("xcrun", "stapler", "validate"):
                raise subprocess.CalledProcessError(1, args)
            return self.command(*args)
        with patch.object(verifier, "run", failed), patch.object(verifier.subprocess, "run", self.display):
            with self.assertRaises(subprocess.CalledProcessError):
                verifier.verify(self.app, TEAM)


if __name__ == "__main__":
    unittest.main()
