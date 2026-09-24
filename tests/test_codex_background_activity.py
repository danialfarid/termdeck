"""What a Codex terminal has running besides the answer it is writing.

The dots under a terminal's title report the work a session is doing that is not the main thread:
Claude's background shells and subagents were counted, Codex's were not, so a Codex terminal waiting
on a long command showed nothing at all.

The shapes here are the ones the rollouts on this machine actually carry: a tool answer that is a
string in one build and a list of content parts in another, a wait that ends "Script completed",
"Script terminated" or "aborted by user", and an agent roster whose first entry is the session itself.
"""

import json
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from termdeck.agents.codex import CodexCli, CodexSessionState

DAY = 24 * 60 * 60
# What a command that is still going answers with, as the rollouts record it.
RUNNING = "Script running with cell ID {}\nWall time 11.0 seconds\nOutput:\n"


def call(name: str, arguments: dict[str, object], call_id: str = "call_1") -> str:
    """A tool call as the rollout records it: every one carries the id its answer will quote."""
    return json.dumps({"type": "response_item",
                       "payload": {"type": "function_call", "name": name, "call_id": call_id,
                                   "arguments": json.dumps(arguments)}})


def output(text: str, parts: bool = False, call_id: str = "call_1") -> str:
    body: object = [{"type": "input_text", "text": text}] if parts else text
    return json.dumps({"type": "response_item",
                       "payload": {"type": "function_call_output", "call_id": call_id, "output": body}})


def at(line: str, when: str) -> str:
    entry = json.loads(line)
    entry["timestamp"] = when
    return json.dumps(entry)


class BackgroundCellTest(unittest.TestCase):
    def scan(self, *lines: str) -> CodexSessionState:
        state = CodexSessionState()
        with TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            path.write_text("\n".join(lines) + "\n")
            CodexCli().scan_background_activity(state, path)
        return state

    def test_a_command_left_running_is_counted(self) -> None:
        state = self.scan(call("exec", {"cmd": "./long-job"}), output(RUNNING.format(196)))

        self.assertEqual(sorted(state.background_cells), ["196"])

    def test_the_wait_that_collects_it_ends_it(self) -> None:
        state = self.scan(call("exec", {"cmd": "./long-job"}), output(RUNNING.format(196)),
                          call("wait", {"cell_id": "196"}), output("Script completed\nWall time 12.3 seconds\n"))

        self.assertEqual(state.background_cells, {})

    def test_a_command_that_failed_is_over_too(self) -> None:
        state = self.scan(call("exec", {"cmd": "./long-job"}), output(RUNNING.format(7)),
                          call("wait", {"cell_id": "7"}), output("Script failed\nWall time 1.2 seconds\n"))

        self.assertEqual(state.background_cells, {})

    def test_a_terminated_command_is_over(self) -> None:
        state = self.scan(call("exec", {"cmd": "./long-job"}), output(RUNNING.format(7)),
                          call("wait", {"cell_id": "7"}), output("Script terminated\nWall time 0.0 seconds\n"))

        self.assertEqual(state.background_cells, {})

    def test_a_command_the_user_interrupted_is_over(self) -> None:
        # An interrupt answers the wait without the "Script" word the other endings share.
        state = self.scan(call("exec", {"cmd": "./long-job"}), output(RUNNING.format(7)),
                          call("wait", {"cell_id": "7"}), output("aborted by user after 132.9s"))

        self.assertEqual(state.background_cells, {})

    def test_an_answer_that_arrives_as_content_parts(self) -> None:
        # The majority shape in these rollouts: output is a list of blocks, not a string.
        state = self.scan(call("exec", {"cmd": "a"}), output(RUNNING.format(5), parts=True),
                          call("wait", {"cell_id": "5"}), output("Script completed\n", parts=True))

        self.assertEqual(state.background_cells, {})

    def test_several_at_once(self) -> None:
        state = self.scan(call("exec", {"cmd": "a"}), output(RUNNING.format(1)),
                          call("exec", {"cmd": "b"}), output(RUNNING.format(2)),
                          call("wait", {"cell_id": "1"}), output("Script completed\n"))

        self.assertEqual(sorted(state.background_cells), ["2"])

    def test_a_command_that_merely_prints_the_words(self) -> None:
        # A terminal reading this very file back, or a test run quoting it, answers with the marker in
        # the middle of its output. Counting that gave one terminal here nine cells it never owned.
        state = self.scan(call("exec", {"cmd": "cat saved-answer.txt"}),
                          output("$ cat saved-answer.txt\n" + RUNNING.format(7)))

        self.assertEqual(state.background_cells, {})

    def test_an_ending_quoted_by_a_command_collects_nothing(self) -> None:
        # Searching a log for how a run ended answers with those words somewhere in the middle, while
        # the wait this session is actually holding has not come back yet.
        state = self.scan(call("exec", {"cmd": "./long-job"}), output(RUNNING.format(7)),
                          call("wait", {"cell_id": "7"}),
                          output("$ grep -n 'Script completed' run.log\n12:Script completed\n"))

        self.assertEqual(sorted(state.background_cells), ["7"])

    def test_a_file_that_opens_with_the_words(self) -> None:
        # Printing an old answer back -- the head of a log, a saved transcript -- starts with the same
        # line. What makes it a cell of this session's own is the wall time codex prints after it.
        state = self.scan(call("exec", {"cmd": "head -1 saved-output.txt"}),
                          output("Script running with cell ID 7\nsomething else entirely\n"))

        self.assertEqual(state.background_cells, {})

    def test_a_still_running_answer_keeps_it(self) -> None:
        state = self.scan(call("exec", {"cmd": "a"}), output(RUNNING.format(196)),
                          call("wait", {"cell_id": "196"}), output(RUNNING.format(196)))

        self.assertEqual(sorted(state.background_cells), ["196"])

    def test_a_cell_is_stamped_with_the_line_that_reported_it(self) -> None:
        # The stamp is what later decides the cell is too old to still be running, so it has to come
        # from the transcript rather than from whenever the scan happened to run.
        state = self.scan(at(call("exec", {"cmd": "a"}), "2026-09-24T10:00:00.000Z"),
                          at(output(RUNNING.format(3)), "2026-09-24T10:00:02.000Z"))

        self.assertEqual(state.background_cells["3"],
                         datetime(2026, 9, 24, 10, 0, 2, tzinfo=timezone.utc).timestamp())


class SubagentRosterTest(unittest.TestCase):
    """`spawn_agent` says one started; `list_agents` says which are still running."""

    def scan(self, *lines: str) -> CodexSessionState:
        state = CodexSessionState()
        with TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            path.write_text("\n".join(lines) + "\n")
            CodexCli().scan_background_activity(state, path)
        return state

    def roster(self, *agents: tuple[str, object]) -> str:
        return json.dumps({"agents": [{"agent_name": "/root", "agent_status": "running"},
                                      *({"agent_name": name, "agent_status": status} for name, status in agents)]})

    def test_a_spawned_agent_is_counted(self) -> None:
        state = self.scan(call("spawn_agent", {"task_name": "review"}),
                          output(json.dumps({"task_name": "/root/review"})))

        self.assertEqual(sorted(state.subagents), ["/root/review"])

    def test_the_roster_says_which_are_still_running(self) -> None:
        state = self.scan(call("spawn_agent", {"task_name": "one"}), output(json.dumps({"task_name": "/root/one"})),
                          call("spawn_agent", {"task_name": "two"}), output(json.dumps({"task_name": "/root/two"})),
                          call("list_agents", {}),
                          output(self.roster(("/root/one", {"completed": "done"}), ("/root/two", "running"))))

        self.assertEqual(sorted(state.subagents), ["/root/two"])

    def test_the_session_itself_is_not_one_of_its_agents(self) -> None:
        # The roster's first entry is the asking session, always running -- counting it would put a
        # subagent dot on every terminal that ever listed its agents.
        state = self.scan(call("list_agents", {}), output(self.roster()))

        self.assertEqual(state.subagents, {})

    def test_a_roster_that_arrives_as_content_parts_is_read(self) -> None:
        # The agent tools answer with a string most of the time and with blocks the rest, and a roster
        # read as its own JSON dump names nobody.
        state = self.scan(call("list_agents", {}), output(self.roster(("/root/one", "running")), parts=True))

        self.assertEqual(sorted(state.subagents), ["/root/one"])

    def test_an_agent_named_only_by_the_roster_counts(self) -> None:
        # A session resumed after its spawns still learns what it is holding.
        state = self.scan(call("list_agents", {}), output(self.roster(("/root/earlier", "running"))))

        self.assertEqual(sorted(state.subagents), ["/root/earlier"])


class WhatIsStillRunningTest(unittest.TestCase):
    """A dot means work is happening now, so what the rollout last said is not enough."""

    def session(self, *, running: bool = True, cells: dict[str, float] | None = None,
                subagents: dict[str, float] | None = None) -> object:
        state = CodexSessionState()
        state.background_cells = cells or {}
        state.subagents = subagents or {}

        class Session:
            agent_state = state
            processing = False

            class record:
                agent_session_id = "abc123"

        Session.running = running
        return Session()

    def test_it_reports_both_kinds(self) -> None:
        now = time.time()
        detail = CodexCli().activity_detail(self.session(cells={"1": now}, subagents={"/root/a": now, "/root/b": now}))

        self.assertEqual(detail["background_jobs"], 1)
        self.assertEqual(detail["subagents"], 2)

    def test_a_terminal_that_is_not_running_has_nothing_running(self) -> None:
        # Cells and agents belong to the codex process; when it is gone, so are they.
        now = time.time()
        detail = CodexCli().activity_detail(self.session(running=False, cells={"1": now}, subagents={"/root/a": now}))

        self.assertEqual((detail["background_jobs"], detail["subagents"]), (0, 0))

    def test_a_cell_nobody_collected_stops_counting(self) -> None:
        # Nearly every real cell is collected within minutes; one still open days later was abandoned,
        # and its dot would otherwise never go out.
        detail = CodexCli().activity_detail(self.session(cells={"1": time.time() - DAY}))

        self.assertEqual(detail["background_jobs"], 0)

    def test_an_agent_outlives_a_cell(self) -> None:
        # Spawned agents run for hours, so the hour that buries a cell must not bury them.
        old = time.time() - 2 * 60 * 60
        detail = CodexCli().activity_detail(self.session(cells={"1": old}, subagents={"/root/a": old}))

        self.assertEqual((detail["background_jobs"], detail["subagents"]), (0, 1))

    def test_an_agent_whose_parent_stopped_asking_stops_counting(self) -> None:
        detail = CodexCli().activity_detail(self.session(subagents={"/root/a": time.time() - 2 * DAY}))

        self.assertEqual(detail["subagents"], 0)

    def test_a_rollout_that_is_gone_leaves_nothing_to_count(self) -> None:
        # The deck asks for the count right after a scan that found no file, so whatever the scan
        # leaves behind has to be countable.
        state = CodexSessionState()
        state.background_cells = {"1": time.time()}
        state.subagents = {"/root/a": time.time()}
        session = self.session()
        session.agent_state = state
        CodexCli().scan_background_activity(state, Path("/nonexistent/rollout.jsonl"))

        self.assertEqual(CodexCli().activity_detail(session)["subagents"], 0)

    def test_a_session_with_no_agent_has_nothing_to_report(self) -> None:
        session = self.session()
        session.record.agent_session_id = ""

        self.assertIsNone(CodexCli().activity_detail(session))


class ReadsOnlyWhatIsNewTest(unittest.TestCase):
    """A status build asks this on every payload, so it must cost nothing on a quiet transcript."""

    def test_appended_bytes_only(self) -> None:
        cli = CodexCli()
        state = CodexSessionState()
        with TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            path.write_text(call("exec", {"cmd": "a"}) + "\n" + output(RUNNING.format(5)) + "\n")
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
            path.write_text(call("exec", {"cmd": "a"}) + "\n" + output(RUNNING.format(5)) + "\n")
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
            first.write_text(call("exec", {"cmd": "a"}) + "\n" + output(RUNNING.format(5)) + "\n")
            cli.scan_background_activity(state, first)
            second = Path(directory) / "rollout-two.jsonl"
            second.write_text(call("exec", {"cmd": "b"}) + "\n" + output(RUNNING.format(9)) + "\n")
            cli.scan_background_activity(state, second)

            self.assertEqual(sorted(state.background_cells), ["9"])

    def test_a_call_and_its_answer_split_across_two_scans(self) -> None:
        # The watcher scans whatever has been appended, so a call and the answer that collects it land
        # in different scans all the time; a pairing held in a local lost the cell every time it did.
        cli = CodexCli()
        state = CodexSessionState()
        with TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            path.write_text(call("exec", {"cmd": "a"}) + "\n" + output(RUNNING.format(7)) + "\n"
                            + call("wait", {"cell_id": "7"}, call_id="call_wait") + "\n")
            cli.scan_background_activity(state, path)
            self.assertEqual(sorted(state.background_cells), ["7"])
            with path.open("a") as handle:
                handle.write(output("Script completed\n", call_id="call_wait") + "\n")
            cli.scan_background_activity(state, path)

            self.assertEqual(state.background_cells, {})

    def test_a_spawn_answered_in_the_next_scan(self) -> None:
        cli = CodexCli()
        state = CodexSessionState()
        with TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            path.write_text(call("spawn_agent", {"task_name": "one"}, call_id="call_spawn") + "\n")
            cli.scan_background_activity(state, path)
            with path.open("a") as handle:
                handle.write(output(json.dumps({"task_name": "/root/one"}), call_id="call_spawn") + "\n")
            cli.scan_background_activity(state, path)

            self.assertEqual(sorted(state.subagents), ["/root/one"])

    def test_an_answer_belongs_to_the_call_that_asked_it(self) -> None:
        # A wait that reports its cell still running, then an unrelated command that finishes: taking
        # the completion for the last cell_id seen would collect a cell that is still going.
        cli = CodexCli()
        state = CodexSessionState()
        with TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            path.write_text("\n".join((
                call("exec", {"cmd": "./long-job"}, call_id="call_a"),
                output(RUNNING.format(7), call_id="call_a"),
                call("wait", {"cell_id": "7"}, call_id="call_b"),
                output(RUNNING.format(7), call_id="call_b"),
                call("exec", {"cmd": "./quick"}, call_id="call_c"),
                output("Script completed\nWall time 0.2 seconds\n", call_id="call_c"))) + "\n")
            cli.scan_background_activity(state, path)

            self.assertEqual(sorted(state.background_cells), ["7"])

    def test_answers_that_come_back_out_of_order(self) -> None:
        # Codex keeps several calls in flight and answers them as they finish -- 27,407 answers in the
        # rollouts here arrive before the answer to the call that preceded them.
        cli = CodexCli()
        state = CodexSessionState()
        with TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            path.write_text("\n".join((
                call("exec", {"cmd": "./long-job"}, call_id="call_a"),
                output(RUNNING.format(7), call_id="call_a"),
                call("exec", {"cmd": "./quick"}, call_id="call_quick"),
                call("wait", {"cell_id": "7"}, call_id="call_wait"),
                output("Script completed\nWall time 0.2 seconds\n", call_id="call_quick"))) + "\n")
            cli.scan_background_activity(state, path)
            # The completion belongs to the quick command, not to the wait that is still outstanding.
            self.assertEqual(sorted(state.background_cells), ["7"])

            with path.open("a") as handle:
                handle.write(output("Script completed\nWall time 90.0 seconds\n", call_id="call_wait") + "\n")
            cli.scan_background_activity(state, path)

            self.assertEqual(state.background_cells, {})

    def test_a_record_still_being_written_is_read_once_it_is_whole(self) -> None:
        # Appends are seen mid-line. Counting the half-written line as read would drop it for good,
        # because the next scan starts after it.
        cli = CodexCli()
        state = CodexSessionState()
        with TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            whole = call("exec", {"cmd": "a"}) + "\n" + output(RUNNING.format(9)) + "\n"
            half = len(whole) - 20
            path.write_text(whole[:half])
            cli.scan_background_activity(state, path)
            path.write_text(whole)
            cli.scan_background_activity(state, path)

            self.assertEqual(sorted(state.background_cells), ["9"])

    def test_a_rollout_that_shrank_is_read_from_the_beginning(self) -> None:
        cli = CodexCli()
        state = CodexSessionState()
        with TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            path.write_text(call("exec", {"cmd": "a"}) + "\n" + output(RUNNING.format(5)) + "\n")
            cli.scan_background_activity(state, path)
            path.write_text(output(RUNNING.format(9)) + "\n")
            cli.scan_background_activity(state, path)

            self.assertEqual(sorted(state.background_cells), ["9"])


class ScansOnBindTest(unittest.TestCase):
    """A terminal the deck has just picked up again knows what it left running.

    The scan is driven by rollout appends, so a session restored on startup -- or bound after a
    restart -- had an empty state and showed no dots until its agent wrote its next line, which on a
    terminal waiting for a long command is exactly when nobody is watching.
    """

    def session(self, directory: str) -> tuple[object, object, object]:
        path = Path(directory) / "rollout-2026-09-24T10-00-00-01a0-cells.jsonl"
        path.write_text(call("exec", {"cmd": "./long-job"}) + "\n" + output(RUNNING.format(4)) + "\n")
        cli = CodexCli()
        cli.sessions_root = Path(directory)

        class Tracker:
            codex_session_is_active = staticmethod(lambda _: False)

        class Manager:
            _tracker = Tracker()

        class Session:
            agent_state = CodexSessionState()
            cli_title = "already named"

            class record:
                agent_session_id = "01a0-cells"

        return cli, Manager(), Session()

    def test_a_restored_session_is_read_on_startup(self) -> None:
        with TemporaryDirectory() as directory:
            cli, manager, ms = self.session(directory)
            cli.refresh_persisted_activity(manager, ms)

            self.assertEqual(sorted(ms.agent_state.background_cells), ["4"])

    def test_a_session_that_has_just_been_bound_is_read(self) -> None:
        with TemporaryDirectory() as directory:
            cli, manager, ms = self.session(directory)
            cli.on_agent_session_bound(manager, ms)

            self.assertEqual(sorted(ms.agent_state.background_cells), ["4"])


if __name__ == "__main__":
    unittest.main()
