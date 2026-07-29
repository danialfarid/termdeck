import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from termdeck.models import SessionRecord
from termdeck.proc_tree import ProcTreeUtil
from termdeck.server import TermdeckServer
from termdeck.session_manager import ManagedSession, TerminalSessionManager


def record(session_id: str = "abc123") -> SessionRecord:
    return SessionRecord(session_id=session_id, title="session", title_user_set=True, command="",
                         cwd="/tmp", agent_kind="none", agent_session_id=None,
                         created_at_est="2026-01-01T00:00:00", draft="", project="test")


class ProcTreeUtilTest(unittest.TestCase):
    def test_descendants_include_every_process_below_each_socket_holder(self) -> None:
        rows = [(10, 1), (11, 10), (12, 11), (20, 1), (21, 20)]
        self.assertEqual(ProcTreeUtil.descendants(rows, [10, 20]), {10, 11, 12, 20, 21})


class PlacementNameTest(unittest.TestCase):
    def test_placement_matches_visible_cli_title_without_status_marker(self) -> None:
        names = TermdeckServer._placement_names({"title": "codex · stock", "cli_title": "⠦ termde"})
        self.assertIn("termde", names)
        self.assertIn("⠦ termde", names)
        self.assertNotIn("codex", names)

    def test_placement_inserts_after_cli_title_anchor(self) -> None:
        class Store:
            def __init__(self) -> None:
                self.payload = {
                    "project_state": {
                        "stock": {
                            "terminal_layout": ["session:termde-id", "session:other-id"],
                            "session_order": ["termde-id", "other-id"],
                        }
                    }
                }

            def load(self) -> dict[str, object]:
                return self.payload

            def save(self, payload: dict[str, object]) -> None:
                self.payload = payload

        class Manager:
            @staticmethod
            def list_sessions(project: str | None = None) -> list[dict[str, object]]:
                return [
                    {"session_id": "termde-id", "title": "codex · stock", "cli_title": "⠦ termde"},
                    {"session_id": "other-id", "title": "other", "cli_title": "other"},
                ]

        server = TermdeckServer.__new__(TermdeckServer)
        server.settings_store = Store()
        server.manager = Manager()
        placement = server._place_session_after("stock", "new-id", "termde")
        self.assertEqual(placement["anchor"], "session:termde-id")
        self.assertEqual(server.settings_store.payload["project_state"]["stock"]["terminal_layout"], [
            "session:termde-id", "session:new-id", "session:other-id",
        ])


class TerminalLifecycleTest(unittest.IsolatedAsyncioTestCase):
    async def test_startup_marks_live_socket_as_detached_not_dormant(self) -> None:
        manager = TerminalSessionManager()
        saved = record()
        manager._store.load_all = lambda: [saved]  # type: ignore[method-assign]
        with tempfile.TemporaryDirectory() as directory:
            socket = Path(directory) / "abc123.sock"
            socket.touch()
            with patch.object(manager, "_dtach_socket", return_value=socket), \
                 patch.object(ProcTreeUtil, "tree_pids_for_socket", new=AsyncMock(return_value={101})):
                await manager.startup_respawn_saved_sessions()
        session = manager._sessions[saved.session_id]
        self.assertTrue(session.running)
        self.assertTrue(session.detached_live)
        self.assertFalse(session.dormant)
        self.assertTrue(session.lazy_start_pending)

    async def test_startup_removes_dead_socket_without_starting_a_terminal(self) -> None:
        manager = TerminalSessionManager()
        saved = record()
        manager._store.load_all = lambda: [saved]  # type: ignore[method-assign]
        with tempfile.TemporaryDirectory() as directory:
            socket = Path(directory) / "abc123.sock"
            socket.touch()
            with patch.object(manager, "_dtach_socket", return_value=socket), \
                 patch.object(ProcTreeUtil, "tree_pids_for_socket", new=AsyncMock(return_value=set())):
                await manager.startup_respawn_saved_sessions()
            self.assertFalse(socket.exists())
        session = manager._sessions[saved.session_id]
        self.assertFalse(session.running)
        self.assertTrue(session.dormant)

    async def test_delete_keeps_record_when_socket_cleanup_fails(self) -> None:
        manager = TerminalSessionManager()
        session = ManagedSession(record())
        manager._sessions[session.record.session_id] = session
        with patch.object(manager, "_terminate_proc", new=AsyncMock(return_value=False)):
            deleted = await manager.delete_session(session.record.session_id)
        self.assertFalse(deleted)
        self.assertIn(session.record.session_id, manager._sessions)

    async def test_kill_all_includes_detached_sessions(self) -> None:
        manager = TerminalSessionManager()
        attached = ManagedSession(record("attached"))
        detached = ManagedSession(record("detached"))
        attached.proc = type("FinishedProcess", (), {"alive": True})()
        detached.detached_live = True
        manager._sessions = {attached.record.session_id: attached, detached.record.session_id: detached}
        manager._persist = lambda: None  # type: ignore[method-assign]
        with patch.object(manager, "_terminate_proc", new=AsyncMock(return_value=True)) as terminate:
            killed = await manager.kill_all_running_sessions()
        self.assertEqual(killed, 2)
        self.assertEqual(terminate.await_count, 2)
        self.assertFalse(detached.detached_live)
