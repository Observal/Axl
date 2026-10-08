# SPDX-FileCopyrightText: 2026 VishnuM049
# SPDX-License-Identifier: Apache-2.0

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("publish_macos", Path(__file__).with_name("publish-macos.py"))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublishMacosTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.parent = Path(self.tmp.name)
        self.parent.chmod(0o700)
        self.calls = 0

    def staged(self, content):
        stage = Path(tempfile.mkdtemp(dir=self.parent))
        app = stage / publisher.CANONICAL
        binary = app / "Contents/MacOS/axl-keychain-helper"
        binary.parent.mkdir(parents=True)
        binary.write_bytes(content)
        archive = stage / "release.zip"
        archive.write_bytes(b"stapled archive test")
        return app, archive

    def verify(self, app, team):
        self.calls += 1
        self.assertEqual(team, "ABCDEFGHIJ")
        self.assertTrue((app / "Contents/MacOS/axl-keychain-helper").is_file())

    def test_fresh_install_and_upgrade_keep_previous_version(self):
        first, zip1 = self.staged(b"v1")
        publisher.publish(first, zip1, self.parent, "ABCDEFGHIJ", self.verify)
        canonical = self.parent / publisher.CANONICAL
        old = os.readlink(canonical)
        second, zip2 = self.staged(b"v2")
        publisher.publish(second, zip2, self.parent, "ABCDEFGHIJ", self.verify)
        self.assertNotEqual(old, os.readlink(canonical))
        self.assertTrue((self.parent / old).is_dir())
        self.assertTrue(canonical.resolve().is_dir())
        self.assertEqual(len(list((self.parent / publisher.VERSIONS).glob("*.zip"))), 2)

    def test_failed_post_publish_verification_rolls_back_upgrade(self):
        first, zip1 = self.staged(b"v1")
        publisher.publish(first, zip1, self.parent, "ABCDEFGHIJ", self.verify)
        canonical = self.parent / publisher.CANONICAL
        old = os.readlink(canonical)
        second, zip2 = self.staged(b"v2")
        # First run made 3 calls, upgrade makes 4. Final call is the seventh.
        def fail_at_final(app, team):
            self.verify(app, team)
            if self.calls == 7:
                raise ValueError("failed installed verification")
        with self.assertRaisesRegex(ValueError, "failed installed verification"):
            publisher.publish(second, zip2, self.parent, "ABCDEFGHIJ", fail_at_final)
        self.assertEqual(os.readlink(canonical), old)
        self.assertTrue((self.parent / old).is_dir())

    def test_failed_first_install_leaves_no_public_helper(self):
        app, archive = self.staged(b"v1")
        def fail_at_final(path, team):
            self.verify(path, team)
            if self.calls == 3:
                raise ValueError("failed installed verification")
        with self.assertRaisesRegex(ValueError, "failed installed verification"):
            publisher.publish(app, archive, self.parent, "ABCDEFGHIJ", fail_at_final)
        self.assertFalse(os.path.lexists(self.parent / publisher.CANONICAL))

    def test_failure_before_pointer_switch_keeps_old_helper(self):
        first, zip1 = self.staged(b"v1")
        publisher.publish(first, zip1, self.parent, "ABCDEFGHIJ", self.verify)
        old = os.readlink(self.parent / publisher.CANONICAL)
        second, zip2 = self.staged(b"v2")
        with patch.object(publisher.os, "replace", side_effect=OSError("interrupted")):
            with self.assertRaises(OSError):
                publisher.publish(second, zip2, self.parent, "ABCDEFGHIJ", self.verify)
        self.assertEqual(os.readlink(self.parent / publisher.CANONICAL), old)

    def test_legacy_directory_is_never_removed(self):
        legacy = self.parent / publisher.CANONICAL
        legacy.mkdir()
        app, archive = self.staged(b"v2")
        with self.assertRaisesRegex(ValueError, "legacy"):
            publisher.publish(app, archive, self.parent, "ABCDEFGHIJ", self.verify)
        self.assertTrue(legacy.is_dir())

    def test_unrecognized_pointer_is_not_adopted_or_overwritten(self):
        elsewhere = self.parent / "unreviewed.app"
        elsewhere.mkdir()
        canonical = self.parent / publisher.CANONICAL
        canonical.symlink_to(elsewhere)
        app, archive = self.staged(b"v2")
        with self.assertRaisesRegex(ValueError, "unexpected installed helper"):
            publisher.publish(app, archive, self.parent, "ABCDEFGHIJ", self.verify)
        self.assertEqual(canonical.resolve(), elsewhere.resolve())


if __name__ == "__main__":
    unittest.main()
