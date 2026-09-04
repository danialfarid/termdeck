import io
import json
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from termdeck.support_bundle import SupportBundleBuilder


class SupportBundleBuilderTest(unittest.TestCase):
    def test_bundle_omits_private_session_fields_and_redacts_log_secrets(self) -> None:
        with TemporaryDirectory() as directory:
            data_dir = Path(directory)
            log_path = data_dir / "termdeck.log"
            log_path.write_text(
                "GET http://127.0.0.1/api/search?q=private-query\n"
                "Authorization: Bearer-secret token=abc user@example.com /Users/example/private/file.py\n"
                "Authorization: Bearer bearer-secret\n"
                "Cookie: sid=session-cookie; csrf=csrf-secret\n"
                '{"token":"json-secret","authorization":"Bearer json-bearer",'
                '"cookie":"sid=json-cookie; csrf=json-csrf"}\n')
            diagnostics = data_dir / "diagnostics"
            diagnostics.mkdir()
            (diagnostics / "recording.jsonl").write_text('{"session":"123e4567-e89b-12d3-a456-426614174000"}\n')
            builder = SupportBundleBuilder(data_dir, log_path, Path("/Users/example"))

            archive_bytes = builder.build(
                "1.2.3", "abcdef1234567890", {"theme": "dark", "selection_copy_history": ["private"]},
                [{"session_id": "secret-id", "title": "private title", "command": "codex secret prompt",
                  "cwd": "/Users/example/private", "project": "private-project", "agent_kind": "codex",
                  "running": True, "processing": True, "cols": 100, "rows": 30}],
                [{"program": "dtach", "resolved_path": "/secret/dtach", "is_present": True,
                  "is_required": True, "used_for": "terminals", "install_hint": "brew install dtach"}],
                {"summary": {"processes": 1}, "sockets": [{"session_id": "secret-id", "socket": "/private/socket",
                  "known_session": True, "live": True, "processes": [{"pid": 12, "command": "/bin/zsh private"}]}]},
                {"enabled": True, "servers": [{"key": "python", "name": "pyright", "languages": ["python"],
                  "available": True, "source": "PATH", "version": "1"}], "active": []},
                {"state": "connected", "relay_url": "https://relay", "public_url": "https://public",
                 "email": "user@example.com", "error": ""}, 1)

            with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
                self.assertEqual(set(archive.namelist()), {
                    "manifest.json", "environment.json", "settings.json", "sessions.json",
                    "terminal-processes.json", "language-servers.json", "remote-access.json",
                    "termdeck.log", "browser-diagnostics.jsonl"})
                settings = json.loads(archive.read("settings.json"))
                sessions = json.loads(archive.read("sessions.json"))
                combined = "\n".join(archive.read(name).decode() for name in archive.namelist())

            self.assertEqual(settings, {"theme": "dark"})
            self.assertNotIn("title", sessions[0])
            self.assertNotIn("command", sessions[0])
            self.assertNotIn("cwd", sessions[0])
            for private_value in ("private-query", "Bearer-secret", "bearer-secret", "token=abc", "json-secret",
                                  "json-bearer", "session-cookie", "csrf-secret", "json-cookie", "json-csrf",
                                  "user@example.com",
                                  "/Users/example", "123e4567-e89b-12d3-a456-426614174000"):
                self.assertNotIn(private_value, combined)


if __name__ == "__main__":
    unittest.main()
