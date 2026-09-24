"""What a Codex terminal has running besides the answer it is writing.

The dots under a terminal's title report the work a session is doing that is not the main thread:
Claude's background shells and subagents were counted, Codex's were not, so a Codex terminal waiting
on a long command showed nothing at all.
"""

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from termdeck.agents.codex import CodexCli, CodexSessionState


def call(name: str, arguments: dict[str, object]) -> str:
    return json.dumps({"type": "response_item",
                       "payload": {"type": "function_call", "name": name, "arguments": json.dumps(arguments)}})


def output(text: str) -> str:
    return json.dumps({"type": "response_item", "payload": {"type": "function_call_output", "output": text}})


def world_state(agents: list[str] | None, full: bool = False) -> str:
    state = {"environments": {}} if agents is None else {
        "environments": {"subagents": " ".join(f'<agent name="{name}" />' for name in agents)}}
    return json.dumps({"type": "world_state", "payload": {"full": full, "state": state}})


class BackgroundCellTest(unittest.TestCase):
    def scan(self, *lines: str) -> CodexSessionState:
        state = CodexSessionState()
        with TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            path.write_text("\n".join(lines) + "\n")
            CodexCli().scan_background_activity(state, path)
        return state

    def test_a_command_left_running_is_counted(self) -> None:
        state = self.scan(call("exec", {"cmd": "./long-job"}), output("Script running with cell ID 196\n"))

        self.assertEqual(sorted(state.background_cells), ["196"])

    def test_the_wait_that_collects_it_ends_it(self) -> None:
        state = self.scan(call("exec", {"cmd": "./long-job"}), output("Script running with cell ID 196\n"),
                          call("wait", {"cell_id": "196"}), output("Script completed\nWall time 12.3 seconds\n"))

        self.assertEqual(state.background_cells, {})

    def test_a_command_that_failed_is_over_too(self) -> None:
        state = self.scan(call("exec", {"cmd": "./long-job"}), output("Script running with cell ID 7\n"),
                          call("wait", {"cell_id": "7"}), output("Script failed\nWall time 1.2 seconds\n"))

        self.assertEqual(state.background_cells, {})

    def test_several_at_once(self) -> None:
        state = self.scan(call("exec", {"cmd": "a"}), output("Script running with cell ID 1\n"),
                          call("exec", {"cmd": "b"}), output("Script running with cell ID 2\n"),
                          call("wait", {"cell_id": "1"}), output("Script completed\n"))

        self.assertEqual(sorted(state.background_cells), ["2"])

    def test_a_still_running_answer_keeps_it(self) -> None:
        state = self.scan(call("exec", {"cmd": "a"}), output("Script running with cell ID 196\n"),
                          call("wait", {"cell_id": "196"}), output("Script running with cell ID 196\n"))

        self.assertEqual(sorted(state.background_cells), ["196"])


class SubagentRosterTest(unittest.TestCase):
    def scan(self, *lines: str) -> CodexSessionState:
        state = CodexSessionState()
        with TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            path.write_text("\n".join(lines) + "\n")
            CodexCli().scan_background_activity(state, path)
        return state

    def test_the_agents_this_one_spawned(self) -> None:
        state = self.scan(world_state(["/root/one", "/root/two"]))

        self.assertEqual(state.subagents, ("/root/one", "/root/two"))

    def test_the_newest_roster_is_the_one_that_counts(self) -> None:
        state = self.scan(world_state(["/root/one", "/root/two"]), world_state(["/root/two"]))

        self.assertEqual(state.subagents, ("/root/two",))

    def test_a_whole_state_naming_none_means_none(self) -> None:
        state = self.scan(world_state(["/root/one"]), world_state(None, full=True))

        self.assertEqual(state.subagents, ())

    def test_a_partial_state_that_says_nothing_changes_nothing(self) -> None:
        state = self.scan(world_state(["/root/one"]), world_state(None))

        self.assertEqual(state.subagents, ("/root/one",))


class ReadsOnlyWhatIsNewTest(unittest.TestCase):
    """A status build asks this on every payload, so it must cost nothing on a quiet transcript."""

    def test_appended_bytes_only(self) -> None:
        cli = CodexCli()
        state = CodexSessionState()
        with TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            path.write_text(call("exec", {"cmd": "a"}) + "\n" + output("Script running with cell ID 5\n") + "\n")
            cli.scan_background_activity(state, path)
            first = state.background_scan_offset
            with path.open("a") as handle:
                handle.write(call("wait", {"cell_id": "5"}) + "\n" + output("Script completed\n") + "\n")
            changed = cli.scan_background_activity(state, path)

            self.assertTrue(changed)
            self.assertEqual(state.background_cells, {})
            self.assertGreater(state.background_scan_offset, first)

    def test_a_transcript_that_has_not_moved_changes_nothing(self) -> None:
        cli = CodexCli()
        state = CodexSessionState()
        with TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            path.write_text(call("exec", {"cmd": "a"}) + "\n" + output("Script running with cell ID 5\n") + "\n")
            cli.scan_background_activity(state, path)

            self.assertFalse(cli.scan_background_activity(state, path))
            self.assertEqual(sorted(state.background_cells), ["5"])

    def test_another_rollout_is_read_from_the_beginning(self) -> None:
        # A resumed session writes a new file; its cells are not the old file's, and reading on from
        # the old offset would keep counting cells that belong to a rollout nobody is watching.
        cli = CodexCli()
        state = CodexSessionState()
        with TemporaryDirectory() as directory:
            first = Path(directory) / "rollout-one.jsonl"
            first.write_text(call("exec", {"cmd": "a"}) + "\n" + output("Script running with cell ID 5\n") + "\n")
            cli.scan_background_activity(state, first)
            second = Path(directory) / "rollout-two.jsonl"
            second.write_text(call("exec", {"cmd": "b"}) + "\n" + output("Script running with cell ID 9\n") + "\n")
            cli.scan_background_activity(state, second)

            self.assertEqual(sorted(state.background_cells), ["9"])

    def test_a_rollout_that_shrank_is_read_from_the_beginning(self) -> None:
        cli = CodexCli()
        state = CodexSessionState()
        with TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            path.write_text(call("exec", {"cmd": "a"}) + "\n" + output("Script running with cell ID 5\n") + "\n")
            cli.scan_background_activity(state, path)
            path.write_text(output("Script running with cell ID 9\n") + "\n")
            cli.scan_background_activity(state, path)

            self.assertEqual(sorted(state.background_cells), ["9"])


class ActivityDetailTest(unittest.TestCase):
    """What the deck reads to draw the dots."""

    def session(self, cells: dict[str, str], subagents: tuple[str, ...]) -> object:
        state = CodexSessionState()
        state.background_cells, state.subagents = cells, subagents

        class Session:
            agent_state = state
            processing = False

            class record:
                agent_session_id = "abc123"

        return Session()

    def test_it_reports_both_kinds(self) -> None:
        detail = CodexCli().activity_detail(self.session({"1": "running"}, ("/root/a", "/root/b")))

        self.assertEqual(detail["background_jobs"], 1)
        self.assertEqual(detail["subagents"], 2)

    def test_a_session_with_no_agent_has_nothing_to_report(self) -> None:
        session = self.session({}, ())
        session.record.agent_session_id = ""

        self.assertIsNone(CodexCli().activity_detail(session))


if __name__ == "__main__":
    unittest.main()
