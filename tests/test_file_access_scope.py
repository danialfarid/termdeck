"""File access reaches the whole filesystem, not just the home directory.

The allowed-root gate is gone by request: any absolute path resolves, and `..`
segments collapse the way the OS resolves them. What stays is the size cap on
reads (read_file truncates past FILE_READ_MAX_BYTES) and, for the media route,
the content-type allowlist.
"""

import shutil
import tempfile
import unittest
from pathlib import Path

from termdeck.file_service import ProjectFileService


class FileAccessScopeTest(unittest.TestCase):
    def setUp(self) -> None:
        # Plain system temp on purpose: outside the home directory, proving the
        # fixture itself would have been refused under the old gate.
        self.directory = Path(tempfile.mkdtemp(prefix="termdeck-access-test-"))
        self.addCleanup(shutil.rmtree, self.directory, True)
        self.service = ProjectFileService()
        (self.directory / "note.txt").write_text("hi from outside home\n")

    def test_absolute_path_outside_home_resolves(self) -> None:
        target = self.service.resolve_confined(str(self.directory), "/etc/hosts")
        self.assertEqual(target, Path("/etc/hosts").resolve())

    def test_traversal_past_home_collapses_instead_of_refusing(self) -> None:
        target = self.service.resolve_confined(
            str(Path.home() / "sub"), "../../../../etc/hosts")
        self.assertEqual(target, Path("/etc/hosts").resolve())

    def test_read_outside_home_returns_content(self) -> None:
        result = self.service.read_file(str(self.directory), "note.txt")
        self.assertEqual(result["content"], "hi from outside home\n")
        self.assertFalse(result["truncated"])
