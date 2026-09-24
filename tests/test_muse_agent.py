"""Muse, Meta's terminal coding agent, as the deck starts and resumes it.

Its sessions are directories rather than files -- the log lives at
`<data home>/muse/sessions/<yyyy>/<mm>/<dd>/<session>/session.jsonl` -- so the id a terminal binds
to is the name of the directory holding the log, and `muse resume <id>` is what reopens it.
"""

import unittest
from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from termdeck import agents
from termdeck.agents.muse import MuseCli
from termdeck.util import TimeUtil


class RegisteredTest(unittest.TestCase):
    def test_the_deck_offers_it(self) -> None:
        self.assertIn("muse", agents.AGENT_CLIS)
        self.assertIs(type(agents.agent_cli("muse")), MuseCli)

    def test_a_muse_command_is_recognised_as_one(self) -> None:
        # What a terminal started from the command line is detected as, and what its dialog shows.
        self.assertEqual(agents.detect_agent_cli("muse --approval-mode never").kind, "muse")

    def test_a_muse_log_is_recognised_as_its_own(self) -> None:
        log = MuseCli.sessions_root / "2026" / "09" / "24" / "01a0-one" / MuseCli.SESSION_LOG_NAME

        self.assertEqual(agents.agent_for_transcript_path(log).kind, "muse")

    def test_it_says_how_to_get_it(self) -> None:
        self.assertIn("muse", MuseCli.install_hint.lower())


class AttentionTest(unittest.TestCase):
    def test_the_trust_prompt_asks_for_you(self) -> None:
        # What muse opens an untrusted workspace with, seen on a real terminal. Markers are matched
        # against lowercased output.
        drawn = "Do you trust this workspace?\n> 1  Trust and continue\n  2  Quit".lower()

        self.assertTrue(any(marker in drawn for marker in MuseCli.attention_output_markers))


class WatchableRootsTest(unittest.TestCase):
    """The transcript watcher reads `sessions_root` off every agent and calls `is_dir()` on it.

    Handing it something to call instead of a path took the whole server down at startup, and every
    test still passed, because nothing else in the suite touches all the agents at once.
    """

    def test_every_agent_offers_a_path_or_nothing(self) -> None:
        for cli in agents.AGENT_CLIS.values():
            root = getattr(cli, "sessions_root", None)
            with self.subTest(agent=cli.kind):
                self.assertTrue(root is None or isinstance(root, Path), f"{cli.kind}: {root!r}")


class CommandTest(unittest.TestCase):
    def setUp(self) -> None:
        self.cli = MuseCli()

    def test_resuming_keeps_the_options_the_terminal_was_started_with(self) -> None:
        self.assertEqual(self.cli.resume_command("muse --approval-mode never --model m", "abc-123"),
                         "muse --approval-mode never --model m resume abc-123")

    def test_resuming_a_resumed_terminal_does_not_stack_session_refs(self) -> None:
        # The saved command is rewritten as a resume of the bound session, so it is read back often.
        self.assertEqual(self.cli.resume_command("muse resume old-id --model m", "abc-123"),
                         "muse --model m resume abc-123")

    def test_starting_fresh_drops_the_session_it_was_resuming(self) -> None:
        self.assertEqual(self.cli.fresh_session_command("muse resume old-id --model m"), "muse --model m")

    def test_attaching_to_a_session_by_reference(self) -> None:
        self.assertEqual(self.cli.new_session_resume_arguments("my-session", None), ("resume", "my-session"))

    def test_a_trailing_effort_word_is_an_effort_not_a_model(self) -> None:
        # Muse takes the reasoning effort as its own option; leaving it on the id starts nothing.
        self.assertEqual(self.cli.model_arguments("some-model xhigh"),
                         ("--reasoning-effort", "xhigh", "--model", "some-model"))

    def test_a_model_id_is_left_alone(self) -> None:
        self.assertEqual(self.cli.model_arguments("some-model"), ("--model", "some-model"))

    def test_a_model_whose_last_word_is_not_an_effort(self) -> None:
        self.assertEqual(self.cli.model_arguments("some model"), ("--model", "some model"))

    def test_the_permission_modes_are_muse_s_own(self) -> None:
        self.assertEqual(self.cli.permission_flags["never"], ("--approval-mode", "never"))
        self.assertEqual(self.cli.permission_flags["full-access"], ("--yolo",))
        self.assertEqual(self.cli.permission_flags["default"], ())


class SessionStoreTest(unittest.TestCase):
    """A session is a directory; the log inside it is what the deck watches."""

    def setUp(self) -> None:
        self.cli = MuseCli()
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "muse" / "sessions"
        patched = patch.object(MuseCli, "sessions_root", self.root)
        patched.start()
        self.addCleanup(patched.stop)

    def day_dir(self, offset_days: int = 0) -> Path:
        day = TimeUtil.today_est() + timedelta(days=offset_days)
        return self.root / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}"

    def session(self, session_id: str, offset_days: int = 0) -> Path:
        path = self.day_dir(offset_days) / session_id / MuseCli.SESSION_LOG_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")
        return path

    def test_the_log_of_a_session(self) -> None:
        path = self.session("01a0-one")

        self.assertEqual(self.cli.transcript_path(None, "01a0-one"), path)

    def test_each_session_gets_its_own_log(self) -> None:
        # Every session's log is named the same; only the directory holding it tells them apart.
        first, second = self.session("01a0-one"), self.session("01a0-two", offset_days=-1)

        self.assertEqual(self.cli.transcript_path(None, "01a0-one"), first)
        self.assertEqual(self.cli.transcript_path(None, "01a0-two"), second)

    def test_a_session_started_before_midnight(self) -> None:
        # A terminal left running overnight keeps writing into yesterday's day directory.
        path = self.session("01a0-one", offset_days=-1)

        self.assertEqual(self.cli.transcript_path(None, "01a0-one"), path)

    def test_a_session_that_is_not_there(self) -> None:
        self.assertIsNone(self.cli.transcript_path(None, "01a0-missing"))

    def test_what_a_new_terminal_could_bind_to(self) -> None:
        self.session("01a0-one")
        self.session("01a0-two")
        (self.day_dir() / "01a0-empty").mkdir(parents=True, exist_ok=True)

        found = self.cli.candidate_session_files(Path("/workspace"))

        self.assertEqual(sorted(session_id for _, session_id in found), ["01a0-one", "01a0-two"])

    def test_the_session_a_log_belongs_to(self) -> None:
        path = self.session("01a0-one")

        self.assertEqual(self.cli.session_id_from_path(path), "01a0-one")

    def test_another_file_in_the_session_directory_is_not_the_log(self) -> None:
        path = self.session("01a0-one").parent / "notes.json"
        path.write_text("{}")

        self.assertIsNone(self.cli.session_id_from_path(path))

    def test_a_log_belonging_to_another_agent(self) -> None:
        elsewhere = Path(self.directory.name) / "codex" / MuseCli.SESSION_LOG_NAME
        elsewhere.parent.mkdir(parents=True, exist_ok=True)
        elsewhere.write_text("")

        self.assertIsNone(self.cli.session_id_from_path(elsewhere))


if __name__ == "__main__":
    unittest.main()
