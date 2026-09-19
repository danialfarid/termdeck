import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from termdeck.models import SessionRecord
from termdeck.server import RunTerminalTaskRequest, TermdeckServer
from termdeck.session_manager import TerminalSessionManager


def record(session_id: str, **overrides) -> SessionRecord:
    fields = dict(session_id=session_id, title=session_id, title_user_set=False, command="codex",
                  cwd="/tmp", agent_kind="codex", agent_session_id=None, created_at_est="2026-09-18 10:00:00",
                  draft="", project="stock")
    fields.update(overrides)
    return SessionRecord(**fields)


class SpawnedByRecordTest(unittest.TestCase):
    """A spawned agent is filed under the terminal that asked for it, so that link has to outlive the
    request that created it -- the sidebar draws the stack long after the task API has returned."""

    def test_the_link_survives_a_round_trip_through_storage(self) -> None:
        # Sessions are reloaded from JSON on every restart, so a field that does not survive to_dict and
        # back is a stack that quietly flattens the next time the deck starts.
        original = record("child", spawned_by_session_id="parent")

        restored = SessionRecord.from_dict(original.to_dict())

        self.assertEqual(restored.spawned_by_session_id, "parent")

    def test_a_record_written_before_the_field_existed_still_loads(self) -> None:
        payload = record("old").to_dict()
        del payload["spawned_by_session_id"]

        self.assertIsNone(SessionRecord.from_dict(payload).spawned_by_session_id)

    def test_it_is_distinct_from_the_agent_fork_parent(self) -> None:
        # fork_parent_agent_session_id is the AGENT's own session that a fork continues. This is
        # TermDeck's terminal that issued the request. Conflating them would file a forked terminal
        # under a session id the sidebar has never heard of.
        spawned = record("child", spawned_by_session_id="deck-parent",
                         fork_parent_agent_session_id="agent-uuid")

        self.assertNotEqual(spawned.spawned_by_session_id, spawned.fork_parent_agent_session_id)


class SetSpawnedByTest(unittest.TestCase):
    def setUp(self) -> None:
        self.manager = TerminalSessionManager.__new__(TerminalSessionManager)
        self.manager._sessions = {name: SimpleNamespace(record=record(name)) for name in ("parent", "child")}
        for method in ("_persist", "_broadcast_status"):
            patcher = patch.object(TerminalSessionManager, method, lambda *a, **k: None)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_it_records_the_parent(self) -> None:
        self.manager.set_spawned_by("child", "parent")

        self.assertEqual(self.manager._sessions["child"].record.spawned_by_session_id, "parent")

    def test_a_terminal_cannot_be_its_own_parent(self) -> None:
        # The sidebar walks from child to parent to place a row. A self-reference is a stack that
        # contains itself, which cannot be drawn.
        self.manager.set_spawned_by("child", "child")

        self.assertIsNone(self.manager._sessions["child"].record.spawned_by_session_id)

    def test_a_parent_the_deck_does_not_have_is_ignored(self) -> None:
        # Otherwise the child is filed under a row that will never be rendered, and disappears.
        self.manager.set_spawned_by("child", "closed-long-ago")

        self.assertIsNone(self.manager._sessions["child"].record.spawned_by_session_id)


class CycleGuardTest(unittest.TestCase):
    """Filing by hand can close a loop the task API never could -- a spawned child is always newer than
    its origin. A cycle is a stack that contains itself, and the sidebar would recurse into it."""

    def setUp(self) -> None:
        self.manager = TerminalSessionManager.__new__(TerminalSessionManager)
        self.manager._sessions = {name: SimpleNamespace(record=record(name)) for name in ("a", "b", "c")}
        for method in ("_persist", "_broadcast_status"):
            patcher = patch.object(TerminalSessionManager, method, lambda *a, **k: None)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _file_under(self, child: str, parent: str) -> None:
        self.manager._sessions[child].record.spawned_by_session_id = parent

    def test_a_direct_swap_is_a_cycle(self) -> None:
        self._file_under("b", "a")

        self.assertTrue(self.manager.would_cycle_spawned_by("a", "b"))

    def test_a_longer_chain_is_a_cycle(self) -> None:
        self._file_under("b", "a")
        self._file_under("c", "b")

        self.assertTrue(self.manager.would_cycle_spawned_by("a", "c"))

    def test_an_ordinary_parent_is_not_a_cycle(self) -> None:
        self.assertFalse(self.manager.would_cycle_spawned_by("b", "a"))

    def test_an_already_broken_chain_does_not_hang_the_walk(self) -> None:
        # Records are edited by hand and reloaded from JSON, so a loop can already be on disk. The walk
        # has to terminate on it rather than spin.
        self._file_under("a", "b")
        self._file_under("b", "a")

        self.assertTrue(self.manager.would_cycle_spawned_by("c", "a") is False)

    def test_clearing_puts_a_terminal_back_on_its_own(self) -> None:
        self._file_under("b", "a")

        self.manager.clear_spawned_by("b")

        self.assertIsNone(self.manager._sessions["b"].record.spawned_by_session_id)


class TaskApiRecordsOriginTest(unittest.IsolatedAsyncioTestCase):
    """An agent delegating work passes origin_session=$TERMDECK_SESSION_ID, which the docs make required
    for a child task. TermDeck used it only to place the row and to write the result back; nothing kept
    it, so the parentage was gone the moment the request returned."""

    def _server(self) -> TermdeckServer:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.command_for_new_session.return_value = "codex"
        child = MagicMock()
        child.record.session_id = "child-01"
        child.record.project = "stock"
        child.record.worktree_id = "root"
        server.manager.create_session.return_value = child
        server.manager.registry.root_for.return_value = "/tmp"
        server.manager.session_summary.return_value = {"session_id": "child-01", "project": "stock"}
        server.manager.session_summary_by_id.return_value = {"cwd": "/tmp", "project": "stock",
                                                             "worktree_id": "root"}
        server.manager.submit_prompt = AsyncMock()
        for method in ("_broadcast_project_state_snapshot", "_place_session_after",
                       "_raise_if_model_dependency_missing"):
            patcher = patch.object(TermdeckServer, method, lambda *a, **k: None)
            patcher.start()
            self.addCleanup(patcher.stop)
        return server

    async def test_a_delegated_child_is_recorded_against_the_agent_that_asked(self) -> None:
        server = self._server()
        with patch.object(TermdeckServer, "_resolve_origin_session", lambda self, ref: "parent-01"):
            await server._run_terminal_task(
                RunTerminalTaskRequest(prompt="review this", cwd="/tmp", project="stock",
                                       origin_session="parent-01"))

        server.manager.set_spawned_by.assert_called_once_with("child-01", "parent-01")

    async def test_a_task_with_no_origin_records_no_parent(self) -> None:
        # A terminal started from the UI has no parent, and inventing one would file it under an
        # unrelated agent.
        server = self._server()

        await server._run_terminal_task(
            RunTerminalTaskRequest(prompt="run checks", cwd="/tmp", project="stock"))

        server.manager.set_spawned_by.assert_not_called()


if __name__ == "__main__":
    unittest.main()


class RestartWithExtraParamsTest(unittest.IsolatedAsyncioTestCase):
    """Restart can change the permission and add start parameters in one go, which is why the context
    menu opens a dialog rather than a submenu of permissions."""

    def setUp(self) -> None:
        self.manager = TerminalSessionManager.__new__(TerminalSessionManager)
        self.session = SimpleNamespace(
            record=record("s1", command="claude --permission-mode default", agent_kind="claude",
                          agent_session_id=None),
            detect_task=None, exit_code=0, dormant=True)
        self.manager._sessions = {"s1": self.session}
        for method in ("_persist", "_spawn", "_canonicalize_agent_resume_command"):
            patcher = patch.object(TerminalSessionManager, method, lambda *a, **k: None)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.terminate = AsyncMock(return_value=True)
        terminate = patch.object(TerminalSessionManager, "_terminate_proc", self.terminate)
        terminate.start()
        self.addCleanup(terminate.stop)
        # With no permission chosen, the agent is asked what the terminal already runs under, which it
        # reads off the agent's own session state. Nothing here is testing that lookup.
        self.manager._tracker = SimpleNamespace(claude_session_permission_mode=lambda *a, **k: "")
        clear = patch.object(TerminalSessionManager, "replay", SimpleNamespace(clear_for_restart=lambda ms: None),
                             create=True)
        clear.start()
        self.addCleanup(clear.stop)

    async def test_extra_parameters_reach_the_restarted_command(self) -> None:
        await self.manager.restart_session("s1", "", "--verbose")

        self.assertIn("--verbose", self.session.record.command)

    async def test_an_option_given_here_replaces_the_one_already_there(self) -> None:
        # Otherwise the command carries the flag twice and the agent sees whichever it reads last.
        await self.manager.restart_session("s1", "", "--permission-mode plan")

        self.assertEqual(self.session.record.command.count("--permission-mode"), 1)
        self.assertIn("plan", self.session.record.command)

    async def test_a_typed_flag_wins_over_the_chosen_permission(self) -> None:
        # Writing it out by hand is more specific than picking from a list.
        await self.manager.restart_session("s1", "acceptEdits", "--permission-mode plan")

        self.assertIn("plan", self.session.record.command)
        self.assertNotIn("acceptEdits", self.session.record.command)

    async def test_unparseable_parameters_are_refused_before_the_terminal_is_killed(self) -> None:
        # Raising is not enough: raising AFTER the terminal has been stopped leaves it dead with nothing
        # restarted. The parameters have to be rejected while the terminal is still running.
        with self.assertRaises(ValueError):
            await self.manager.restart_session("s1", "", '--flag "unclosed')

        self.terminate.assert_not_awaited()

    async def test_no_extra_parameters_leaves_the_command_alone(self) -> None:
        await self.manager.restart_session("s1", "")

        self.assertEqual(self.session.record.command, "claude --permission-mode default")
