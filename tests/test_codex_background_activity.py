"""What a Codex terminal has running besides the answer it is writing.

The dots under a terminal's title report the work a session is doing that is not the main thread.
Deriving that from the rollout was wrong in both directions: a terminal that was running a background
command showed nothing, because a newer codex keeps its shells in numbered sessions rather than the
cells the older one printed, and a terminal whose agents had long finished kept three dots, because
the roster its transcript holds says nothing after the last time it asked.

A spawned agent is counted from something that is true now: it is running for exactly as long as its
own rollout is still being written. Background terminals are not counted at all -- codex reports them
only in the footer it redraws, which cannot be read back from the byte stream without emulating the
screen, and every cheaper reading of the transcript was wrong for one codex build or the other.
"""

import json
import os
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from termdeck.agents.codex import CodexCli, CodexSessionState


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
        Session.record.agent_session_id = agent_session_id
        return Session()

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
