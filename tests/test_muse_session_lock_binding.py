"""A Muse terminal is bound to the session its own process holds the lock for.

A running muse holds `.session.lock` open in its own session's directory and nowhere else; it does not
hold its log open. Detection asked which session files a terminal's processes had open, recognised
only the log, found nothing, and fell back to the newest new log -- so terminals started seconds
apart each bound the next one's session, and showed another agent's report under their own title.
"""

import asyncio
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from termdeck.agents.muse import MuseCli


class LockNamesItsSessionTest(unittest.TestCase):
    def setUp(self) -> None:
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name) / "muse" / "sessions"
        patched = patch.object(MuseCli, "sessions_root", self.root)
        patched.start()
        self.addCleanup(patched.stop)
        self.cli = MuseCli()

    def path(self, *parts: str) -> Path:
        return self.root.joinpath(*parts)

    def test_the_lock_in_a_session_directory(self) -> None:
        self.assertEqual(self.cli.session_id_from_path(self.path("2026", "10", "05", "01a10dbb-944b", ".session.lock")),
                         "01a10dbb-944b")

    def test_the_log_still_names_its_session(self) -> None:
        self.assertEqual(self.cli.session_id_from_path(self.path("2026", "10", "05", "01a10dbb-944b", "session.jsonl")),
                         "01a10dbb-944b")

    def test_a_lock_nested_under_a_session_is_not_a_session(self) -> None:
        # A subagent's files live under its parent's directory and must not bind as sessions of their own.
        nested = self.path("2026", "10", "05", "01a10dbb-944b", "subagents", "child", ".session.lock")

        self.assertIsNone(self.cli.session_id_from_path(nested))

    def test_a_lock_outside_the_store(self) -> None:
        self.assertIsNone(self.cli.session_id_from_path(Path("/tmp/elsewhere/01a10dbb-944b/.session.lock")))

    def test_another_file_beside_the_log(self) -> None:
        self.assertIsNone(self.cli.session_id_from_path(self.path("2026", "10", "05", "01a10dbb-944b", "index.db")))

    def test_lsof_output_reads_as_which_process_holds_which_session(self) -> None:
        lock = self.path("2026", "10", "05", "01a10dbb-944b", ".session.lock")
        other = self.path("2026", "10", "05", "01a10dbb-db34", ".session.lock")
        output = f"p29980\nn{lock}\nn/Users/dan/.local/share/muse/session-index.db\np30049\nn{other}\n"

        self.assertEqual(self.cli.session_locks_from_lsof(output), {29980: "01a10dbb-944b", 30049: "01a10dbb-db34"})

    def test_a_log_a_process_has_open_is_not_a_session_it_owns(self) -> None:
        # The resume picker opens the log of every session it lists; only the lock says whose it is.
        lock = self.path("2026", "10", "05", "01a10dbb-944b", ".session.lock")
        listed = self.path("2026", "10", "02", "01a0ff0a-3771", "session.jsonl")
        output = f"p29980\nn{lock}\nn{listed}\n"

        self.assertEqual(self.cli.session_locks_from_lsof(output), {29980: "01a10dbb-944b"})


class OneTerminalOneLockTest(unittest.TestCase):
    class Tree:
        def __init__(self, pids_by_socket: dict[str, set[int]]) -> None:
            self.pids_by_socket = pids_by_socket

        def tree_pids_for_socket(self, socket: str) -> set[int]:
            return self.pids_by_socket.get(socket, set())

    def test_the_lock_held_under_this_terminal(self) -> None:
        tree = self.Tree({"/sock/a": {29979, 29980}})

        self.assertEqual(MuseCli.lock_owned_session(Path("/sock/a"), tree, {29980: "s1", 30049: "s2"}), "s1")

    def test_a_terminal_holding_no_lock(self) -> None:
        # A muse at its resume picker owns no session yet; nothing should be bound from that.
        tree = self.Tree({"/sock/a": {29979, 29980}})

        self.assertIsNone(MuseCli.lock_owned_session(Path("/sock/a"), tree, {30049: "s2"}))

    def test_a_terminal_holding_two_is_not_guessed_between(self) -> None:
        tree = self.Tree({"/sock/a": {29980, 29981}})

        self.assertIsNone(MuseCli.lock_owned_session(Path("/sock/a"), tree, {29980: "s1", 29981: "s2"}))


class StartupSweepTest(unittest.TestCase):
    """The terminals bound before this fix are corrected from the lock when the deck starts."""

    def sweep(self, bound: dict[str, str | None], owned: dict[str, str | None],
              claimed_elsewhere: set[str] = frozenset()) -> dict[str, str | None]:
        cli = MuseCli()
        rebinds: dict[str, str] = {}

        class Record:
            def __init__(self, session_id: str, agent_session_id: str | None) -> None:
                self.session_id, self.agent_session_id = session_id, agent_session_id
                self.cwd = "/workspace"

        class Session:
            def __init__(self, session_id: str) -> None:
                self.record = Record(session_id, bound[session_id])
                self.detached_live = True

        class Tracker:
            def muse_resume_ref_from_process_arguments(self, socket, tree):
                return None

        class Manager:
            _tracker = Tracker()

            def _dtach_socket(self, session_id: str) -> str:
                return session_id

            def _claimed_agent_ids(self, ms) -> set[str]:
                return set(claimed_elsewhere)

            def _set_agent_session_binding(self, ms, agent_session_id: str) -> None:
                ms.record.agent_session_id = agent_session_id
                rebinds[ms.record.session_id] = agent_session_id

        async def locks(manager, proc_tree):
            return {}

        sessions = [Session(session_id) for session_id in bound]
        with patch.object(cli, "_session_locks_by_pid", locks), \
                patch.object(MuseCli, "lock_owned_session", staticmethod(lambda socket, tree, held: owned[socket])):
            for ms in sessions:
                asyncio.run(cli.reconcile_bindings(Manager(), ms, object()))
        return {ms.record.session_id: ms.record.agent_session_id for ms in sessions}

    def test_a_chain_of_neighbours_is_put_right(self) -> None:
        # The batch that showed it: each terminal sat on the session of the one started after it.
        result = self.sweep(bound={"float": "db34", "cons": "220f", "mipo": "6947", "eodhist": None},
                            owned={"float": "944b", "cons": "db34", "mipo": "220f", "eodhist": "b056"},
                            claimed_elsewhere={"db34", "220f", "6947"})

        self.assertEqual(result, {"float": "944b", "cons": "db34", "mipo": "220f", "eodhist": "b056"})

    def test_a_terminal_already_on_its_own_session_is_left_alone(self) -> None:
        self.assertEqual(self.sweep(bound={"a": "s1"}, owned={"a": "s1"}), {"a": "s1"})

    def test_a_terminal_holding_no_lock_keeps_its_binding(self) -> None:
        self.assertEqual(self.sweep(bound={"a": "s1"}, owned={"a": None}), {"a": "s1"})


if __name__ == "__main__":
    unittest.main()
