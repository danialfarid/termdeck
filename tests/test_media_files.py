import shutil
import tempfile
import unittest
from pathlib import Path

from termdeck.file_service import ProjectFileService

PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944"
    "4154789c6360000002000100fdff03fa0000000049454e44ae426082")


class MediaFileServiceTest(unittest.TestCase):
    """What the media endpoint will and will not hand to a browser.

    This route serves raw file bytes from the app's own origin, so its allowlist is the security
    boundary: anything the browser might treat as a document must not pass, whatever its extension
    looks like.
    """

    def setUp(self) -> None:
        # Under the home directory on purpose: file access is confined to it, so a fixture in /tmp would
        # be refused by the guard before any of these cases were reached.
        self.directory = Path(tempfile.mkdtemp(prefix=".termdeck-media-test-", dir=Path.home()))
        self.addCleanup(shutil.rmtree, self.directory, True)
        self.service = ProjectFileService()
        (self.directory / "shot.png").write_bytes(PNG_BYTES)
        (self.directory / "clip.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42")
        (self.directory / "notes.md").write_text("# hi\n")
        (self.directory / "page.html").write_text("<script>alert(1)</script>")
        (self.directory / "run.sh").write_text("echo hi\n")

    def test_media_types_are_served_as_their_own_type(self) -> None:
        for name, expected in (("shot.png", "image/png"), ("clip.mp4", "video/mp4")):
            path, content_type = self.service.media_file(str(self.directory), name)
            self.assertEqual(path, (self.directory / name).resolve())
            self.assertEqual(content_type, expected)

    def test_documents_and_scripts_are_refused(self) -> None:
        """HTML is the one that matters: served inline it would run as the app's own origin."""
        for name in ("page.html", "run.sh", "notes.md"):
            with self.assertRaises(ValueError, msg=name):
                self.service.media_file(str(self.directory), name)

    def test_missing_file_is_not_found(self) -> None:
        with self.assertRaises(FileNotFoundError):
            self.service.media_file(str(self.directory), "absent.png")

    def test_directory_is_not_a_file(self) -> None:
        (self.directory / "images").mkdir()
        with self.assertRaises(FileNotFoundError):
            self.service.media_file(str(self.directory), "images")

    def test_path_escape_is_refused(self) -> None:
        """Same confinement as every other read: nothing outside the allowed root, traversal included.

        Raised as PermissionError, not ValueError, so the route answers 403 rather than reporting an
        escape attempt as an unsupported file type.
        """
        for escape in ("../../../../etc/hosts", "/etc/hosts"):
            with self.assertRaises(PermissionError, msg=escape):
                self.service.media_file(str(self.directory), escape)

    def test_extension_matching_ignores_case(self) -> None:
        (self.directory / "SHOT.PNG").write_bytes(PNG_BYTES)
        _, content_type = self.service.media_file(str(self.directory), "SHOT.PNG")
        self.assertEqual(content_type, "image/png")

    def test_client_and_server_agree_on_what_is_media(self) -> None:
        """The client picks the element, the server picks the bytes; a type in one and not the other is
        either a preview that will not load or a file the deck refuses to show."""
        static = Path(__file__).resolve().parent.parent / "termdeck" / "static" / "app.js"
        source = static.read_text()
        block = source.split("const MEDIA_FILE_KINDS = {", 1)[1].split("};", 1)[0]
        client = {part.split(":")[0].strip().strip('"') for part in block.split(",") if ":" in part}
        self.assertTrue(client, "MEDIA_FILE_KINDS was not found in app.js")
        self.assertEqual(client - set(ProjectFileService.MEDIA_CONTENT_TYPES), set(),
                         "the client previews types the server will not serve")
        self.assertEqual(set(ProjectFileService.MEDIA_CONTENT_TYPES) - client, set(),
                         "the server serves types the client has no element for")
