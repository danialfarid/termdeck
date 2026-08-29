import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from termdeck import agents

SESSION_ID = "7446fac7-4b39-49d1-bfb6-0b428c2fbd0f"


def session_document() -> dict:
    return {
        "sessionId": SESSION_ID,
        "projectHash": "x",
        "startTime": "2026-08-04T17:34:39.744Z",
        "lastUpdated": "2026-08-04T17:40:00.000Z",
        "messages": [
            {"id": "1", "type": "info", "content": "Authentication succeeded\n"},
            {"id": "2", "type": "user", "content": "compare these two jsons"},
            {"id": "3", "type": "gemini", "content": "Here is a comparison.",
             "thoughts": [{"subject": "Assessing", "description": "comparing the payloads"}],
             "tokens": {"input": 20749, "output": 4376, "cached": 100, "total": 25225},
             "model": "gemini-2.5-pro"},
        ],
    }


class GeminiAgentTest(unittest.TestCase):
    def _tree(self, directory: str, cwd: Path) -> Path:
        root = Path(directory)
        chats = root / hashlib.sha256(str(cwd).encode()).hexdigest() / "chats"
        chats.mkdir(parents=True)
        path = chats / f"session-2026-08-04T17-34-{SESSION_ID.split('-')[0]}.json"
        path.write_text(json.dumps(session_document(), indent=2))
        return path

    def test_discovery_and_transcript_path(self) -> None:
        gemini = agents.agent_cli("gemini")
        cwd = Path("/tmp/some-project")
        with tempfile.TemporaryDirectory() as directory:
            path = self._tree(directory, cwd)
            with patch.object(type(gemini), "sessions_root", Path(directory)):
                self.assertEqual(gemini.candidate_session_files(cwd), [(path, SESSION_ID)])
                self.assertEqual(gemini.transcript_path(cwd, SESSION_ID), path)
                self.assertEqual(gemini.session_id_from_path(path), SESSION_ID)
                self.assertIsNone(gemini.transcript_path(cwd, "00000000-0000-0000-0000-000000000000"))

    def test_whole_document_parses_into_turns(self) -> None:
        gemini = agents.agent_cli("gemini")
        lines = json.dumps(session_document(), indent=2).splitlines()
        turns = gemini.parse_transcript_lines(lines)
        self.assertEqual([turn["role"] for turn in turns], ["event", "user", "event", "assistant"])
        self.assertEqual(turns[1]["text"], "compare these two jsons")
        self.assertEqual(turns[3]["model"], "gemini-2.5-pro")
        self.assertEqual(gemini.parse_transcript_lines(lines[: len(lines) // 2]), [])

    def test_latest_usage_from_tokens(self) -> None:
        gemini = agents.agent_cli("gemini")
        cwd = Path("/tmp/some-project")
        with tempfile.TemporaryDirectory() as directory:
            self._tree(directory, cwd)
            with patch.object(type(gemini), "sessions_root", Path(directory)):
                usage = gemini.latest_usage(cwd, SESSION_ID)
        self.assertEqual(usage, {"context_tokens": 20849, "output_tokens": 4376,
                                 "context_window": None, "total_tokens": 25225})

    def test_command_building(self) -> None:
        self.assertEqual(
            agents.agent_cli("gemini").build_command("full-access", "gemini-2.5-pro", "", None),
            "gemini --yolo --model gemini-2.5-pro")
        self.assertEqual(agents.detect_agent_cli("gemini --yolo").kind, "gemini")
        with self.assertRaises(ValueError):
            agents.agent_cli("gemini").build_command("default", "", "some-session-ref", None)
