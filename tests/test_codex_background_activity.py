"""What a Codex terminal has running besides the answer it is writing.

The dots under a terminal's title report the work a session is doing that is not the main thread.
Deriving that from the rollout was wrong in both directions: a terminal that was running a background
command showed nothing, because a newer codex keeps its shells in numbered sessions rather than the
cells the older one printed, and a terminal whose agents had long finished kept three dots, because
the roster its transcript holds says nothing after the last time it asked.

Both answers are taken from something that is true now. A spawned agent is running for exactly as long
as its own rollout is still being written. A background terminal is whatever codex itself says it has,
on the line it keeps above its composer -- and because codex patches that footer in place with cursor
moves, the bytes are replayed through a terminal to be read back rather than searched.
"""

import json
import os
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from termdeck.agents.codex import CodexCli, CodexSessionState


# The footer codex draws under a transcript: its own line above the composer, addressed absolutely and
# rewritten in place, which is why the last mention of it in the byte stream says nothing about now.
FOOTER_ROW = 44


def footer(*lines: str, row: int = FOOTER_ROW) -> bytes:
    painted = "".join(f"\x1b[{row + index};1H\x1b[K{line}" for index, line in enumerate(lines))
    return painted.encode()


class BackgroundTerminalScreenTest(unittest.TestCase):
    """What codex says it is running, read off the screen it drew."""

    def count(self, stream: bytes, cols: int = 112, rows: int = 48) -> int:
        return CodexCli.background_terminals_on_screen(stream, cols, rows)

    def test_the_line_codex_keeps_above_its_composer(self) -> None:
        # Idle, with a command still running: the count is on a line of its own.
        self.assertEqual(self.count(footer("  1 background terminal running · /ps to view · /stop to close",
                                           "› Ask Codex to do anything",
                                           "  GPT-6-Astra low · Context 33% used")), 1)

    def test_several(self) -> None:
        self.assertEqual(self.count(footer("  3 background terminals running · /ps to view",
                                           "› Ask Codex to do anything")), 3)

    def test_while_it_is_working(self) -> None:
        self.assertEqual(self.count(footer("• Working (48s • esc to interrupt) · 2 background terminals running")), 2)

    def test_a_terminal_with_none(self) -> None:
        self.assertEqual(self.count(footer("› Ask Codex to do anything", "  GPT-6-Astra low")), 0)

    def test_the_row_being_repainted_without_it(self) -> None:
        # The bytes still carry the line that said one was running; the screen does not, because codex
        # drew over it. Reading the stream instead of the screen is what got this wrong.
        self.assertEqual(self.count(footer("  1 background terminal running · /ps to view")
                                    + footer("› Ask Codex to do anything")), 0)

    def test_what_a_command_printed_is_not_the_footer(self) -> None:
        # A terminal reading this file back, or grepping a log, puts the words in the transcript above --
        # nowhere near the rows codex keeps for itself.
        printed = b"\x1b[1;1H  self.assertEqual(self.count(footer(\"1 background terminal running\")), 1)\r\n"
        self.assertEqual(self.count(printed + footer("› Ask Codex to do anything")), 0)

    def test_a_terminal_that_has_drawn_nothing(self) -> None:
        self.assertEqual(self.count(b""), 0)


class LiveSubagentsTest(unittest.TestCase):
    """A spawned agent writes its own rollout, naming the thread it was forked from."""

    def rollout(self, directory: str, name: str, parent: str, age_seconds: float = 0.0) -> Path:
        path = Path(directory) / f"rollout-2026-09-24T10-00-00-{name}.jsonl"
        path.write_text(json.dumps({"type": "session_meta", "timestamp": "2026-09-24T10:00:00.000Z",
                                    "payload": {"id": name, "parent_thread_id": parent,
                                                "cwd": "/Users/dan/workspace/stock"}}) + "\n")
        if age_seconds:
            when = time.time() - age_seconds
            os.utime(path, (when, when))
        return path

    def cli(self, directory: str) -> CodexCli:
        cli = CodexCli()
        cli.sessions_root = Path(directory)
        cli._recent_day_dirs = staticmethod(lambda: [Path(directory)])
        return cli

    def test_an_agent_still_writing_is_running(self) -> None:
        with TemporaryDirectory() as directory:
            cli = self.cli(directory)
            self.rollout(directory, "01a0-child", parent="01a0-parent")

            self.assertEqual(cli.live_subagent_count("01a0-parent"), 1)

    def test_an_agent_that_stopped_writing_is_finished(self) -> None:
        # Nothing announces the ending: the parent only learns it the next time it asks, which on a
        # session left alone is never. The rollout going quiet is the ending.
        with TemporaryDirectory() as directory:
            cli = self.cli(directory)
            self.rollout(directory, "01a0-child", parent="01a0-parent", age_seconds=2 * 60 * 60)

            self.assertEqual(cli.live_subagent_count("01a0-parent"), 0)

    def test_another_session_s_agents_are_not_this_one_s(self) -> None:
        with TemporaryDirectory() as directory:
            cli = self.cli(directory)
            self.rollout(directory, "01a0-child", parent="01a0-somebody-else")

            self.assertEqual(cli.live_subagent_count("01a0-parent"), 0)

    def test_a_session_of_its_own_is_not_an_agent(self) -> None:
        # An ordinary terminal's rollout names no parent, and there are far more of those.
        with TemporaryDirectory() as directory:
            cli = self.cli(directory)
            self.rollout(directory, "01a0-plain", parent="")

            self.assertEqual(cli.live_subagent_count("01a0-parent"), 0)

    def test_all_the_agents_one_session_holds(self) -> None:
        with TemporaryDirectory() as directory:
            cli = self.cli(directory)
            for name in ("01a0-one", "01a0-two", "01a0-three"):
                self.rollout(directory, name, parent="01a0-parent")

            self.assertEqual(cli.live_subagent_count("01a0-parent"), 3)

    def test_a_session_with_no_agent_id_asks_for_nothing(self) -> None:
        with TemporaryDirectory() as directory:
            self.assertEqual(self.cli(directory).live_subagent_count(""), 0)


class ActivityDetailTest(unittest.TestCase):
    """What the deck reads to draw the dots."""

    def session(self, *, running: bool = True, agent_session_id: str = "01a0-parent") -> object:
        class Session:
            agent_state = CodexSessionState()
            processing = False

            class record:
                pass

        Session.running = running
        Session.buffer = bytearray()
        Session.raw_replay_buffer = bytearray()
        Session.record.agent_session_id = agent_session_id
        Session.record.session_id = "term1"
        Session.record.cols = 112
        Session.record.rows = 48
        return Session()

    def test_it_reports_what_the_screen_says_is_running(self) -> None:
        with TemporaryDirectory() as directory:
            cli = CodexCli()
            cli._recent_day_dirs = staticmethod(lambda: [Path(directory)])
            session = self.session()
            # What codex wrote, where a codex terminal keeps it.
            session.raw_replay_buffer = bytearray(footer("  2 background terminals running · /ps to view",
                                                         "› Ask Codex to do anything"))

            self.assertEqual(cli.activity_detail(session)["background_jobs"], 2)

    def test_a_terminal_is_not_replayed_for_every_status_build(self) -> None:
        # Replaying a terminal is dear, and status is built far more often than a background command
        # starts or ends, so a recent answer stands.
        with TemporaryDirectory() as directory:
            cli = CodexCli()
            cli._recent_day_dirs = staticmethod(lambda: [Path(directory)])
            session = self.session()
            session.raw_replay_buffer = bytearray(footer("  1 background terminal running · /ps to view"))
            self.assertEqual(cli.background_terminal_count(session), 1)
            reads = []
            with patch.object(CodexCli, "background_terminals_on_screen",
                              staticmethod(lambda *arguments: reads.append(arguments) or 0)):
                self.assertEqual(cli.background_terminal_count(session), 1)

            self.assertEqual(reads, [])

    def test_it_reports_the_agents_this_session_is_holding(self) -> None:
        with TemporaryDirectory() as directory:
            cli = CodexCli()
            cli._recent_day_dirs = staticmethod(lambda: [Path(directory)])
            LiveSubagentsTest().rollout(directory, "01a0-child", parent="01a0-parent")

            self.assertEqual(cli.activity_detail(self.session())["subagents"], 1)

    def test_a_terminal_that_is_not_running_has_nothing_running(self) -> None:
        # Its codex is gone, and with it the agents it spawned -- even if one of their rollouts is
        # still being written, because what is writing it is no longer this terminal's.
        with TemporaryDirectory() as directory:
            cli = CodexCli()
            cli._recent_day_dirs = staticmethod(lambda: [Path(directory)])
            LiveSubagentsTest().rollout(directory, "01a0-child", parent="01a0-parent")

            self.assertEqual(cli.activity_detail(self.session(running=False))["subagents"], 0)

    def test_a_session_with_no_agent_has_nothing_to_report(self) -> None:
        self.assertIsNone(CodexCli().activity_detail(self.session(agent_session_id="")))


if __name__ == "__main__":
    unittest.main()
