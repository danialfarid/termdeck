import io
import json
import unittest
import uuid
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch

from termdeck.config import TermdeckConfig
from termdeck.replay_recorder import ReplayRecorder
from termdeck.session_bundle import SessionBundleService
from termdeck.session_manager import TerminalSessionManager
from termdeck.transcript_service import TranscriptService


class SessionBundleServiceTest(unittest.TestCase):
    def test_export_import_preserves_profile_transcript_and_replay(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            cwd = root / "nested"
            cwd.mkdir()
            service = SessionBundleService(root / "imports")
            filename, archive = service.build(
                "1.2.3", {"title": "Review task", "title_user_set": True, "command": "codex resume original",
                          "cwd": str(cwd), "agent_kind": "codex", "agent_session_id": "original",
                          "created_at_est": "2026-09-04 01:02:03", "draft": "next", "cols": 120, "rows": 40},
                root, [{"role": "user", "text": "Review this"}, {"role": "assistant", "text": "Done"}],
                "raw-replay", b"terminal replay")

            imported = service.read(archive)

            self.assertEqual(filename, "Review-task.termdeck-session")
            self.assertEqual(imported.session["cwd_relative"], "nested")
            self.assertEqual(imported.session["agent_session_id"], "original")
            self.assertEqual(imported.replay_kind, "raw-replay")
            self.assertEqual(imported.replay, b"terminal replay")
            self.assertEqual([json.loads(line)["text"] for line in imported.transcript.splitlines()],
                             ["Review this", "Done"])

    def test_import_rejects_unexpected_archive_entries(self) -> None:
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as archive:
            archive.writestr("manifest.json", '{"format":"termdeck-session","format_version":1}')
            archive.writestr("session.json", '{"title":"x","command":"","agent_kind":"none","cwd_relative":"."}')
            archive.writestr("../../unexpected", "no")

        with TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "unexpected archive entry"):
                SessionBundleService(Path(directory)).read(payload.getvalue())

    def test_import_rejects_invalid_terminal_dimensions(self) -> None:
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as archive:
            archive.writestr("manifest.json", '{"format":"termdeck-session","format_version":1}')
            archive.writestr("session.json", '{"title":"x","command":"","agent_kind":"none",'
                                              '"cwd_relative":".","cols":"wide"}')

        with TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "invalid dimensions"):
                SessionBundleService(Path(directory)).read(payload.getvalue())

    def test_imported_session_stays_dormant_and_uses_portable_transcript_fallback(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            transcript_directory = root / "imports"
            scrollback_directory = root / "scrollback"
            service = SessionBundleService(transcript_directory)
            session_id = uuid.uuid4().hex[:12]
            transcript = b'{"role":"user","text":"portable question"}\n'
            service.store_imported_transcript(session_id, transcript)
            manager = TerminalSessionManager()
            manager._store = MagicMock()
            with patch.object(TermdeckConfig, "IMPORTED_TRANSCRIPTS_DIR", transcript_directory), \
                    patch.object(TermdeckConfig, "SCROLLBACK_DIR", scrollback_directory):
                session = manager.import_session_bundle(
                    session_id, {"title": "Imported shell", "command": "", "agent_kind": "none",
                                 "created_at_est": "2026-09-04 01:02:03", "cols": 80, "rows": 24},
                    root, "project", None, "root", session_id, ReplayRecorder.SCROLLBACK_KIND, b"shell history")
                source = manager.session_history_source(session_id)
                page = TranscriptService().history_page(*source)

            self.assertTrue(session.dormant)
            self.assertFalse(session.running)
            self.assertEqual(source, ("termdeck-archive", "", session_id))
            self.assertEqual(page["turns"][0]["text"], "portable question")
            self.assertTrue((scrollback_directory / f"{session_id}{TermdeckConfig.SCROLLBACK_SUFFIX}").is_file())


if __name__ == "__main__":
    unittest.main()
