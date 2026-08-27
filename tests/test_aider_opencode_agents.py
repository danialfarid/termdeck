import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from termdeck import agents

SESSION_SCHEMA = """
CREATE TABLE session (
  id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL,
  directory text NOT NULL, title text NOT NULL, cost real DEFAULT 0 NOT NULL,
  tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
  tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL,
  tokens_cache_write integer DEFAULT 0 NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL)
"""


class DescriptorPresentationTest(unittest.TestCase):
    def test_every_agent_ships_an_icon_and_the_tui_flag(self) -> None:
        for cli in agents.AGENT_CLIS.values():
            descriptor = cli.client_descriptor()
            self.assertIn("icon_svg", descriptor, cli.kind)
            self.assertIn("fullscreen_tui", descriptor, cli.kind)
            if cli.is_agent:
                self.assertIn("<svg", str(descriptor["icon_svg"]), cli.kind)
        self.assertTrue(agents.agent_cli("opencode").fullscreen_tui)
        self.assertFalse(agents.agent_cli("claude").fullscreen_tui)


class AiderAgentTest(unittest.TestCase):
    def test_command_building_and_capabilities(self) -> None:
        aider = agents.agent_cli("aider")
        self.assertTrue(aider.sessionless)
        self.assertEqual(aider.build_command("auto", "sonnet", "", None),
                         "aider --restore-chat-history --yes-always --model sonnet")
        self.assertEqual(agents.detect_agent_cli("aider --model sonnet").kind, "aider")
        # Sessionless resume: the same command in the same cwd IS the resume.
        self.assertEqual(aider.resume_command("aider --restore-chat-history", "ignored"),
                         "aider --restore-chat-history")


class OpencodeAgentTest(unittest.TestCase):
    def _db(self, directory: str, rows: list[tuple]) -> Path:
        path = Path(directory) / "opencode.db"
        with sqlite3.connect(path) as connection:
            connection.execute(SESSION_SCHEMA)
            connection.executemany(
                "INSERT INTO session (id, project_id, parent_id, slug, directory, title, "
                "tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, "
                "time_created, time_updated) VALUES (?, 'p', ?, 's', ?, ?, ?, ?, ?, ?, ?, ?)",
                rows)
        return path

    def test_resume_fork_and_ref(self) -> None:
        opencode = agents.agent_cli("opencode")
        self.assertEqual(opencode.resume_command("opencode -s old123 --fork", "new456"),
                         "opencode -s new456")
        self.assertEqual(opencode.fork_command("opencode -c", "abc"), "opencode -s abc --fork")
        self.assertEqual(opencode.build_command("default", "anthropic/claude-sonnet-4", "ses_1", None),
                         "opencode -m anthropic/claude-sonnet-4 -s ses_1")

    def test_detection_titles_and_usage_from_database(self) -> None:
        opencode = agents.agent_cli("opencode")
        now_ms = int(time.time() * 1000)
        with tempfile.TemporaryDirectory() as directory:
            db = self._db(directory, [
                ("ses_old", None, "/work/project", "old run", 10, 5, 0, 0, now_ms - 60_000, now_ms),
                ("ses_new", None, "/work/project", "fixing the tests", 20749, 4376, 100, 50, now_ms - 5_000, now_ms),
                ("ses_sub", "ses_new", "/work/project", "subtask", 1, 1, 0, 0, now_ms - 1_000, now_ms),
                ("ses_other", None, "/elsewhere", "other project", 1, 1, 0, 0, now_ms - 1_000, now_ms),
            ])
            ms = SimpleNamespace(record=SimpleNamespace(
                cwd="/work/project", created_at_est="2020-01-01 00:00:00"))
            with patch.object(type(opencode), "DB_PATH", db):
                found = opencode.detection_fallback_session_id(None, ms, claimed=set())
                self.assertEqual(found, "ses_new")  # newest top-level session in this cwd
                self.assertEqual(opencode.detection_fallback_session_id(None, ms, claimed={"ses_new"}),
                                 "ses_old")
                self.assertEqual(opencode.session_title(None, Path("/work/project"), "ses_new"),
                                 "fixing the tests")
                usage = opencode.latest_usage(Path("/work/project"), "ses_new")
        self.assertEqual(usage, {"context_tokens": 20899, "output_tokens": 4376,
                                 "context_window": None, "total_tokens": 25275})

    def test_missing_database_is_quietly_empty(self) -> None:
        opencode = agents.agent_cli("opencode")
        with patch.object(type(opencode), "DB_PATH", Path("/nonexistent/opencode.db")):
            ms = SimpleNamespace(record=SimpleNamespace(cwd="/x", created_at_est="2020-01-01 00:00:00"))
            self.assertIsNone(opencode.detection_fallback_session_id(None, ms, set()))
            self.assertIsNone(opencode.latest_usage(Path("/x"), "any"))
