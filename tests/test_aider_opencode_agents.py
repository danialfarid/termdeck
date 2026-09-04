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

MESSAGE_SCHEMA = """
CREATE TABLE message (
  id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
  time_updated integer NOT NULL, data text NOT NULL)
"""


class DescriptorPresentationTest(unittest.TestCase):
    def test_every_agent_ships_an_icon_and_the_tui_flag(self) -> None:
        for cli in agents.AGENT_CLIS.values():
            descriptor = cli.client_descriptor()
            self.assertIn("icon_svg", descriptor, cli.kind)
            self.assertIn("fullscreen_tui", descriptor, cli.kind)
            self.assertIn("activity_source", descriptor, cli.kind)
            self.assertIn("supports_agent_rename", descriptor, cli.kind)
            if cli.is_agent:
                self.assertIn("<svg", str(descriptor["icon_svg"]), cli.kind)
        self.assertTrue(agents.agent_cli("opencode").fullscreen_tui)
        self.assertFalse(agents.agent_cli("claude").fullscreen_tui)


class FullscreenTuiTrimTest(unittest.TestCase):
    def test_trim_cuts_at_a_respawn_boot_not_a_sync_frame(self) -> None:
        from termdeck.config import TermdeckConfig
        from termdeck.replay_recorder import ReplayRecorder
        sync = TermdeckConfig.SYNC_UPDATE_START
        divider = TermdeckConfig.RESPAWN_DIVIDER.encode()
        buffer = bytearray(b"boot" + sync + b"frame1" + sync + b"frame2" + divider + b"boot2" + sync + b"frame3")
        removed = ReplayRecorder._trim_front(buffer, 2, boot_boundary_only=True)
        self.assertEqual(bytes(buffer), divider + b"boot2" + sync + b"frame3")
        self.assertGreater(removed, 2)

    def test_trim_without_a_respawn_falls_back_to_the_minimum_cut(self) -> None:
        from termdeck.replay_recorder import ReplayRecorder
        buffer = bytearray(b"0123456789")
        removed = ReplayRecorder._trim_front(buffer, 4, boot_boundary_only=True)
        self.assertEqual(removed, 4)
        self.assertEqual(bytes(buffer), b"456789")


class OutputActivityProcessingTest(unittest.TestCase):
    def _ms(self, agent):
        return SimpleNamespace(processing=False, agent_state=agent.new_session_state(),
                               repaint_activity_suppressed_until_monotonic=0.0,
                               last_input_monotonic=0.0, last_resize_monotonic=0.0)

    def test_output_arms_processing_and_it_lapses_in_silence(self) -> None:
        oc = agents.agent_cli("opencode")
        ms = self._ms(oc)
        with patch("termdeck.agents.base.time") as clock:
            clock.monotonic.return_value = 100.0
            self.assertFalse(oc.is_processing(ms))
            oc.on_pty_output(None, ms)
            self.assertTrue(oc.is_processing(ms))
            self.assertGreater(oc.output_activity_remaining(ms), 0.0)
            clock.monotonic.return_value = 103.9
            self.assertTrue(oc.is_processing(ms))
            clock.monotonic.return_value = 104.1
            self.assertFalse(oc.is_processing(ms))

    def test_echo_resize_and_reattach_repaints_do_not_arm(self) -> None:
        aider = agents.agent_cli("aider")
        ms = self._ms(aider)
        with patch("termdeck.agents.base.time") as clock:
            clock.monotonic.return_value = 100.0
            ms.last_input_monotonic = 99.5      # typing echo
            aider.on_pty_output(None, ms)
            self.assertFalse(aider.is_processing(ms))
            ms.last_input_monotonic = 0.0
            ms.last_resize_monotonic = 99.0     # resize-triggered TUI repaint
            aider.on_pty_output(None, ms)
            self.assertFalse(aider.is_processing(ms))
            ms.last_resize_monotonic = 0.0
            ms.repaint_activity_suppressed_until_monotonic = 101.0  # reattach repaint window
            aider.on_pty_output(None, ms)
            self.assertFalse(aider.is_processing(ms))
            ms.repaint_activity_suppressed_until_monotonic = 0.0
            aider.on_pty_output(None, ms)
            self.assertTrue(aider.is_processing(ms))

    def test_submit_arms_output_agent_before_first_response_chunk(self) -> None:
        aider = agents.agent_cli("aider")
        manager = SimpleNamespace(_schedule_output_activity_expiry=lambda ms: None,
                                  _broadcast_status=lambda ms: None)
        ms = self._ms(aider)
        with patch("termdeck.agents.base.time") as clock:
            clock.monotonic.return_value = 100.0
            aider.pre_write_input(manager, ms, "\r", "run the task")
            self.assertTrue(aider.is_processing(ms))
            aider.post_write_input(manager, ms, "\r")

    def test_title_driven_agents_are_untouched(self) -> None:
        claude = agents.agent_cli("claude")
        self.assertFalse(claude.processing_from_output)
        self.assertEqual(claude.output_activity_remaining(SimpleNamespace(agent_state=None)), 0.0)


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
            connection.execute(MESSAGE_SCHEMA)
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
        self.assertEqual(opencode.build_command("auto", "openrouter/anthropic/claude-sonnet-4", "", None),
                         "opencode --auto -m openrouter/anthropic/claude-sonnet-4")

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

    def test_database_activity_survives_server_refresh_without_starting_session(self) -> None:
        opencode = agents.agent_cli("opencode")
        with tempfile.TemporaryDirectory() as directory:
            db = self._db(directory, [])
            with sqlite3.connect(db) as connection:
                connection.execute(
                    "INSERT INTO message VALUES (?, ?, ?, ?, ?)",
                    ("msg1", "ses_active", 1000, 1000,
                     '{"role":"assistant","time":{"created":1000}}'))
                connection.execute(
                    "INSERT INTO message VALUES (?, ?, ?, ?, ?)",
                    ("msg2", "ses_done", 1000, 1000,
                     '{"role":"assistant","time":{"created":900,"completed":1000}}'))
            with patch.object(type(opencode), "DB_PATH", db):
                self.assertTrue(opencode._database_session_is_active("ses_active"))
                self.assertFalse(opencode._database_session_is_active("ses_done"))
