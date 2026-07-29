import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from termdeck.file_service import ProjectFileService
from termdeck.models import AgentKind, SessionRecord
from termdeck.config import TermdeckConfig
from termdeck.proc_tree import ProcTreeUtil
from termdeck.server import NotebookNote, TermdeckServer, UiSettings
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


class UiSettingsTest(unittest.TestCase):
    def test_notebook_fields_round_trip_through_settings_model(self) -> None:
        payload = UiSettings(notebook_open=True, notebook_preview=True, notebook_text="# Notes\n\n- item",
                             notebook_notes=[NotebookNote(note_id="note-1", text="# Notes\n\n- item")],
                             notebook_active_note_id="note-1", notebook_notes_initialized=True).model_dump()
        self.assertTrue(payload["notebook_open"])
        self.assertTrue(payload["notebook_preview"])
        self.assertEqual(payload["notebook_text"], "# Notes\n\n- item")
        self.assertEqual(payload["notebook_notes"], [{"note_id": "note-1", "text": "# Notes\n\n- item"}])
        self.assertEqual(payload["notebook_active_note_id"], "note-1")
        self.assertTrue(payload["notebook_notes_initialized"])

    def test_client_customization_fields_round_trip_through_settings_model(self) -> None:
        payload = UiSettings(ui_font_size=15, vscode_keybindings={"toggle-notebook": "Ctrl+Alt+n"}).model_dump()
        self.assertEqual(payload["ui_font_size"], 15)
        self.assertEqual(payload["vscode_keybindings"], {"toggle-notebook": "Ctrl+Alt+n"})


class NotebookTrashTest(unittest.TestCase):
    def test_notebook_note_moves_to_trash_as_markdown(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(TermdeckConfig, "DATA_DIR", root / "data"), \
                 patch.object(TermdeckConfig, "TRASH_DIR", root / "trash"):
                target = Path(ProjectFileService().move_notebook_note_to_trash("Planning / note", "# Keep this"))
            self.assertTrue(target.is_file())
            self.assertEqual(target.parent, root / "trash")
            self.assertEqual(target.read_text(), "# Keep this")


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

    async def test_sync_repaint_frames_are_not_saved_to_scrollback(self) -> None:
        manager = TerminalSessionManager()
        session = ManagedSession(record())
        manager._append_collapsing_repaints(session, b"before\n")
        manager._append_collapsing_repaints(
            session,
            TermdeckConfig.SYNC_UPDATE_START + b"\rstatus redraw" + TermdeckConfig.SYNC_UPDATE_END + b"\r\n",
        )
        manager._append_collapsing_repaints(session, b"after\n")

        self.assertEqual(bytes(session.buffer), b"before\nafter\n")

    async def test_split_sync_repaint_frame_is_not_saved_to_scrollback(self) -> None:
        manager = TerminalSessionManager()
        session = ManagedSession(record())
        manager._append_collapsing_repaints(session, b"before\n" + TermdeckConfig.SYNC_UPDATE_START + b"\rstatus")
        self.assertEqual(bytes(session.buffer), b"before\n")
        self.assertTrue(session.scrollback_sync_carry)

        manager._append_collapsing_repaints(session, b" redraw" + TermdeckConfig.SYNC_UPDATE_END + b"\r\nafter\n")
        self.assertEqual(bytes(session.buffer), b"before\nafter\n")
        self.assertEqual(session.scrollback_sync_carry, b"")

    async def test_sync_repaint_frames_are_not_sent_to_browser_clients(self) -> None:
        manager = TerminalSessionManager()
        session = ManagedSession(record())
        queue: asyncio.Queue = asyncio.Queue()
        session.client_queues.add(queue)

        manager._handle_output(
            session,
            b"before\n" + TermdeckConfig.SYNC_UPDATE_START + b"\rstatus redraw" +
            TermdeckConfig.SYNC_UPDATE_END + b"\r\nafter\n",
        )

        self.assertEqual(await queue.get(), b"before\nafter\n")
        self.assertTrue(queue.empty())
        self.assertEqual(bytes(session.buffer), b"before\nafter\n")

    async def test_agent_cursor_repaint_controls_are_not_sent_to_browser_clients(self) -> None:
        manager = TerminalSessionManager()
        saved = record()
        saved.agent_kind = AgentKind.CODEX.value
        session = ManagedSession(saved)
        queue: asyncio.Queue = asyncio.Queue()
        session.client_queues.add(queue)

        manager._handle_output(session, b"answer\n\x1b[2Arewritten\x1b[0m\n\x1b]2;title\x07")

        self.assertEqual(await queue.get(), b"answer\nrewritten\x1b[0m\n")
        self.assertTrue(queue.empty())
        self.assertEqual(bytes(session.buffer), b"answer\nrewritten\x1b[0m\n")

    async def test_shell_cursor_controls_stay_raw_for_terminal_programs(self) -> None:
        manager = TerminalSessionManager()
        session = ManagedSession(record())
        queue: asyncio.Queue = asyncio.Queue()
        session.client_queues.add(queue)
        raw = b"progress\r\x1b[2Kdone\n"

        manager._handle_output(session, raw)

        self.assertEqual(await queue.get(), raw)
        self.assertEqual(bytes(session.buffer), raw)

    async def test_rename_codex_session_sends_codex_rename_command(self) -> None:
        manager = TerminalSessionManager()
        saved = record()
        saved.agent_kind = AgentKind.CODEX.value
        saved.agent_session_id = "codex-thread-id"
        session = ManagedSession(saved)

        class FakeProc:
            alive = True

            def __init__(self) -> None:
                self.writes: list[bytes] = []

            def write(self, data: bytes) -> None:
                self.writes.append(data)

        proc = FakeProc()
        session.proc = proc
        manager._sessions[saved.session_id] = session
        manager._persist = lambda: None  # type: ignore[method-assign]
        with patch.object(TermdeckConfig, "FORK_RENAME_SUBMIT_DELAY_SECONDS", 0):
            manager.rename_session(saved.session_id, "renamed thread")
            await asyncio.sleep(0)
            await asyncio.sleep(0)

        self.assertEqual(saved.title, "renamed thread")
        self.assertEqual(proc.writes, [
            b"\x15" + TermdeckConfig.BRACKETED_PASTE_START + b"/rename renamed thread" +
            TermdeckConfig.BRACKETED_PASTE_END,
            b"\r",
        ])
