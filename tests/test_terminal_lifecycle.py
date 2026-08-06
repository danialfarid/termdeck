import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from watchdog.events import DirModifiedEvent, FileModifiedEvent, FileMovedEvent

from termdeck.agent_session_tracker import AgentSessionTracker
from termdeck.file_service import ProjectFileService
from termdeck.models import AgentKind, SessionRecord
from termdeck.config import TermdeckConfig
from termdeck.proc_tree import ProcTreeUtil
from termdeck.server import NotebookNote, RenameSessionRequest, TermdeckServer, UiSettings
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

    def test_fork_endpoint_persists_placement_after_source_session(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.has_session.return_value = True
        forked = MagicMock()
        forked.record.project = "stock"
        forked.record.session_id = "fork-id"
        server.manager.fork_session.return_value = forked
        server.manager.session_summary.return_value = {"session_id": "fork-id"}
        with patch.object(server, "_place_session_after", return_value={"position": "after"}) as place:
            result = asyncio.run(server._fork_session("termde-id", RenameSessionRequest(title="termde fork")))
        place.assert_called_once_with("stock", "fork-id", "session:termde-id")
        self.assertEqual(result["placement"], {"position": "after"})


class FileTreeEventTest(unittest.TestCase):
    def test_file_modification_refreshes_only_its_containing_directory(self) -> None:
        service = ProjectFileService()
        root = Path("/Users/dan/workspace/stock")
        event = FileModifiedEvent(str(root / "trainer" / "model.py"))
        self.assertEqual(service._file_tree_event_directories(root, event), {"trainer"})

    def test_directory_modification_refreshes_that_directory(self) -> None:
        service = ProjectFileService()
        root = Path("/Users/dan/workspace/stock")
        event = DirModifiedEvent(str(root / "trainer"))
        self.assertEqual(service._file_tree_event_directories(root, event), {"trainer"})

    def test_move_refreshes_both_containing_directories(self) -> None:
        service = ProjectFileService()
        root = Path("/Users/dan/workspace/stock")
        event = FileMovedEvent(str(root / "trainer" / "old.py"), str(root / "models" / "new.py"))
        self.assertEqual(service._file_tree_event_directories(root, event), {"trainer", "models"})

    def test_ignored_virtual_environment_change_is_not_forwarded(self) -> None:
        service = ProjectFileService()
        root = Path("/Users/dan/workspace/stock")
        event = FileModifiedEvent(str(root / ".venv" / "lib" / "package.py"))
        self.assertEqual(service._file_tree_event_directories(root, event), set())


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


class SessionSizePersistenceTest(unittest.TestCase):
    def test_record_written_before_sizes_existed_falls_back_to_the_initial_size(self) -> None:
        payload = record().to_dict()
        del payload["cols"], payload["rows"]

        restored = SessionRecord.from_dict(payload)

        self.assertEqual((restored.cols, restored.rows), (TermdeckConfig.INITIAL_COLS, TermdeckConfig.INITIAL_ROWS))

    def test_size_survives_a_persist_reload_roundtrip(self) -> None:
        saved = record()
        saved.cols, saved.rows = 162, 61

        restored = SessionRecord.from_dict(saved.to_dict())

        self.assertEqual((restored.cols, restored.rows), (162, 61))

    def test_reattached_session_starts_at_the_persisted_size(self) -> None:
        saved = record()
        saved.cols, saved.rows = 162, 61

        self.assertEqual((ManagedSession(saved).cols, ManagedSession(saved).rows), (162, 61))

    def test_resizing_persists_the_new_size_onto_the_record(self) -> None:
        manager = TerminalSessionManager()
        session = ManagedSession(record())
        manager._sessions[session.record.session_id] = session
        persists: list[int] = []
        manager._persist = lambda: persists.append(1)  # type: ignore[method-assign]

        manager.resize(session.record.session_id, 162, 61)
        manager.resize(session.record.session_id, 162, 61)

        self.assertEqual((session.record.cols, session.record.rows), (162, 61))
        self.assertEqual(len(persists), 1)


class AgentSessionTrackerResumeCommandTest(unittest.TestCase):
    def test_build_codex_resume_command_keeps_existing_flags(self) -> None:
        tracker = AgentSessionTracker()
        command = "codex --sandbox workspace-write resume aa11 --foo"
        self.assertEqual(tracker.build_resume_command(
            AgentKind.CODEX, command, "bb22"),
            "codex --sandbox workspace-write --foo resume bb22")

    def test_build_codex_resume_command_with_path_keeps_flags(self) -> None:
        tracker = AgentSessionTracker()
        command = "/usr/bin/codex --dangerously-bypass-approvals-and-sandbox resume aa11"
        self.assertEqual(tracker.build_resume_command(
            AgentKind.CODEX, command, "bb22"),
            "/usr/bin/codex --dangerously-bypass-approvals-and-sandbox resume bb22")

    def test_build_claude_resume_command_strips_old_resume_flag(self) -> None:
        tracker = AgentSessionTracker()
        command = "claude --permission-mode auto --resume aa11"
        self.assertEqual(tracker.build_resume_command(
            AgentKind.CLAUDE, command, "bb22"),
            "claude --permission-mode auto --resume bb22")


class CliTitlePersistenceTest(unittest.TestCase):
    def _manager_with_session(self) -> tuple[TerminalSessionManager, ManagedSession, list[int]]:
        manager = TerminalSessionManager()
        session = ManagedSession(record())
        manager._sessions[session.record.session_id] = session
        persists: list[int] = []
        manager._persist = lambda: persists.append(1)  # type: ignore[method-assign]
        return manager, session, persists

    def test_agent_title_is_stored_without_its_spinner_marker(self) -> None:
        manager, session, persists = self._manager_with_session()
        session.cli_title = "⠧ intraday-fed"

        manager._remember_cli_title(session)

        self.assertEqual(session.record.cli_title, "intraday-fed")
        self.assertEqual(len(persists), 1)

    def test_spinner_frames_do_not_rewrite_the_stored_title(self) -> None:
        manager, session, persists = self._manager_with_session()
        for marker in ("⠧", "⠏", "⠹"):
            session.cli_title = f"{marker} intraday-fed"
            manager._remember_cli_title(session)

        self.assertEqual(session.record.cli_title, "intraday-fed")
        self.assertEqual(len(persists), 1)

    def test_stored_title_names_the_terminal_before_anyone_attaches(self) -> None:
        saved = record()
        saved.cli_title = "intraday-fed"

        self.assertEqual(ManagedSession(saved).cli_title, "intraday-fed")

    def test_restored_title_does_not_report_the_session_as_processing(self) -> None:
        saved = record()
        saved.cli_title = "intraday-fed"

        self.assertFalse(ManagedSession(saved).processing)


class CodexSessionActivityTest(unittest.TestCase):
    def test_task_state_is_read_without_starting_the_terminal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "rollout-2026-08-02T00-00-00-019f9a3e-1915-7bd3-8183-cce1db8a1e20.jsonl"
            path.write_text("\n".join([
                json.dumps({"type": "event_msg", "payload": {"type": "task_started"}}),
                json.dumps({"type": "event_msg", "payload": {"type": "token_count"}}),
            ]))
            with patch.object(TermdeckConfig, "CODEX_SESSIONS_DIR", root):
                self.assertTrue(AgentSessionTracker().codex_session_is_active("019f9a3e-1915-7bd3-8183-cce1db8a1e20"))
                path.write_text("\n".join([
                    json.dumps({"type": "event_msg", "payload": {"type": "task_started"}}),
                    json.dumps({"type": "event_msg", "payload": {"type": "task_complete"}}),
                ]))
                self.assertFalse(AgentSessionTracker().codex_session_is_active("019f9a3e-1915-7bd3-8183-cce1db8a1e20"))


class ClaudeSessionActivityTest(unittest.TestCase):
    def _transcript(self, directory: str, *events: dict) -> Path:
        path = Path(directory) / "session.jsonl"
        path.write_text("\n".join(json.dumps(event) for event in events))
        return path

    def _user_text(self, text: str) -> dict:
        return {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}}

    def _assistant(self, *parts: dict) -> dict:
        return {"type": "assistant", "message": {"type": "message", "role": "assistant", "content": list(parts)}}

    def test_escape_interruption_ends_the_processing_spinner(self) -> None:
        for marker in ("[Request interrupted by user]", "[Request interrupted by user for tool use]"):
            with tempfile.TemporaryDirectory() as directory:
                path = self._transcript(directory, self._assistant({"type": "tool_use", "name": "Bash"}),
                                        self._user_text(marker))
                self.assertFalse(AgentSessionTracker().claude_session_is_active(path), marker)

    def test_submitted_prompt_still_reads_as_working(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = self._transcript(directory, self._assistant({"type": "text", "text": "done"}),
                                    self._user_text("please keep going"))
            self.assertTrue(AgentSessionTracker().claude_session_is_active(path))

    def test_tool_result_still_reads_as_working(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = self._transcript(directory, self._assistant({"type": "tool_use", "name": "Bash"}),
                                    {"type": "user", "message": {"role": "user", "content": [
                                        {"type": "tool_result", "tool_use_id": "x", "content": "ok"}]}})
            self.assertTrue(AgentSessionTracker().claude_session_is_active(path))

    def test_injected_system_reminder_does_not_keep_the_spinner_running(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            reminder = self._user_text("<system-reminder>The user named this session</system-reminder>")
            reminder["isMeta"] = True
            path = self._transcript(directory, self._assistant({"type": "text", "text": "all done"}), reminder)
            self.assertFalse(AgentSessionTracker().claude_session_is_active(path))

    def test_finished_answer_reads_as_idle(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = self._transcript(directory, self._user_text("hello"),
                                    self._assistant({"type": "text", "text": "all done"}))
            self.assertFalse(AgentSessionTracker().claude_session_is_active(path))


class AgySessionActivityTest(unittest.TestCase):
    def _transcript(self, directory: str, session_id: str, *events: dict) -> Path:
        log_dir = Path(directory) / session_id / ".system_generated" / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        path = log_dir / "transcript.jsonl"
        path.write_text("\n".join(json.dumps(event) for event in events))
        return path

    def test_user_input_marks_session_as_active(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session_id = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
            self._transcript(directory, session_id,
                             {"type": "USER_INPUT", "source": "USER_EXPLICIT",
                              "content": "<USER_REQUEST>run diagnostics</USER_REQUEST>"})
            with patch.object(TermdeckConfig, "AGY_SESSIONS_DIR", Path(directory)):
                self.assertTrue(AgentSessionTracker().agy_session_is_active(session_id))

    def test_content_event_without_thinking_marks_session_as_inactive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session_id = "6f1f1f5a-9dfd-4a65-bc2f-9b0b8f5f4d77"
            self._transcript(directory, session_id,
                             {"type": "USER_INPUT", "source": "USER_EXPLICIT",
                              "content": "<USER_REQUEST>run diagnostics</USER_REQUEST>"},
                             {"type": "AGENT_RESPONSE", "content": "<AGENT_RESPONSE>done</AGENT_RESPONSE>"})
            with patch.object(TermdeckConfig, "AGY_SESSIONS_DIR", Path(directory)):
                self.assertFalse(AgentSessionTracker().agy_session_is_active(session_id))

    def test_in_progress_status_marks_session_as_active(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session_id = "e6f1f8b4-8c5d-4bbd-b3f7-21fbd7fdc11f"
            self._transcript(directory, session_id,
                             {"type": "PLANNER_RESPONSE", "source": "MODEL", "status": "IN_PROGRESS",
                              "content": "Thinking about file matches."})
            with patch.object(TermdeckConfig, "AGY_SESSIONS_DIR", Path(directory)):
                self.assertTrue(AgentSessionTracker().agy_session_is_active(session_id))

    def test_transcript_full_preferred_for_activity_detection(self) -> None:
        session_id = "7f8f2a7a-c4c2-4ca3-a4d4-e5f6a7c9d012"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / session_id / ".system_generated" / "logs"
            root.mkdir(parents=True, exist_ok=True)
            (root / "transcript.jsonl").write_text("{}\n")
            (root / "transcript_full.jsonl").write_text(
                json.dumps({"type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "<USER_REQUEST>run diagnostics</USER_REQUEST>"})
            )
            with patch.object(TermdeckConfig, "AGY_SESSIONS_DIR", Path(directory)):
                self.assertTrue(AgentSessionTracker().agy_session_is_active(session_id))


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
        self.assertTrue(session.screen_lives_only_in_stripped_sync_frames)

    async def test_plain_output_leaves_screen_reconstructable_from_scrollback(self) -> None:
        manager = TerminalSessionManager()
        session = ManagedSession(record())
        manager._append_collapsing_repaints(session, b"plain shell output\n")

        self.assertFalse(session.screen_lives_only_in_stripped_sync_frames)

    async def test_attaching_client_nudges_pty_width_so_a_tui_repaints_its_stripped_screen(self) -> None:
        manager, session, proc = self._session_whose_screen_was_stripped()

        with patch.object(TermdeckConfig, "SCREEN_REPAINT_CLIENT_ATTACH_DELAY_SECONDS", 0), \
             patch.object(TermdeckConfig, "SCREEN_REPAINT_NUDGE_HOLD_SECONDS", 0):
            manager.attach_client(session.record.session_id)
            await session.screen_repaint_task

        self.assertEqual(proc.resizes, [(119, 32), (120, 32)])

    async def test_attaching_client_skips_nudge_when_the_screen_already_repainted(self) -> None:
        manager, session, proc = self._session_whose_screen_was_stripped()

        with patch.object(TermdeckConfig, "SCREEN_REPAINT_CLIENT_ATTACH_DELAY_SECONDS", 0), \
             patch.object(TermdeckConfig, "SCREEN_REPAINT_NUDGE_HOLD_SECONDS", 0):
            manager.attach_client(session.record.session_id)
            session.last_activity_at += 1
            await session.screen_repaint_task

        self.assertEqual(proc.resizes, [])

    async def test_attaching_client_does_not_nudge_a_shell_whose_scrollback_replays_the_screen(self) -> None:
        manager, session, proc = self._session_whose_screen_was_stripped()
        session.screen_lives_only_in_stripped_sync_frames = False
        session.buffer.extend(b"prompt$ ls\nfile.txt\n")

        manager.attach_client(session.record.session_id)

        self.assertIsNone(session.screen_repaint_task)
        self.assertEqual(proc.resizes, [])

    async def test_attaching_client_nudges_when_the_server_has_no_scrollback_to_replay(self) -> None:
        manager, session, proc = self._session_whose_screen_was_stripped()
        session.screen_lives_only_in_stripped_sync_frames = False

        with patch.object(TermdeckConfig, "SCREEN_REPAINT_CLIENT_ATTACH_DELAY_SECONDS", 0), \
             patch.object(TermdeckConfig, "SCREEN_REPAINT_NUDGE_HOLD_SECONDS", 0):
            manager.attach_client(session.record.session_id)
            await session.screen_repaint_task

        self.assertEqual(proc.resizes, [(119, 32), (120, 32)])

    def _session_whose_screen_was_stripped(self):
        class FakeProc:
            alive = True

            def __init__(self) -> None:
                self.resizes: list[tuple[int, int]] = []

            def resize(self, cols: int, rows: int) -> None:
                self.resizes.append((cols, rows))

        manager = TerminalSessionManager()
        session = ManagedSession(record())
        proc = FakeProc()
        session.proc = proc
        session.cols, session.rows = 120, 32
        session.screen_lives_only_in_stripped_sync_frames = True
        manager._sessions[session.record.session_id] = session
        return manager, session, proc

    async def test_split_sync_repaint_frame_is_not_saved_to_scrollback(self) -> None:
        manager = TerminalSessionManager()
        session = ManagedSession(record())
        manager._append_collapsing_repaints(session, b"before\n" + TermdeckConfig.SYNC_UPDATE_START + b"\rstatus")
        self.assertEqual(bytes(session.buffer), b"before\n")
        self.assertTrue(session.scrollback_sync_carry)

        manager._append_collapsing_repaints(session, b" redraw" + TermdeckConfig.SYNC_UPDATE_END + b"\r\nafter\n")
        self.assertEqual(bytes(session.buffer), b"before\nafter\n")
        self.assertEqual(session.scrollback_sync_carry, b"")

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
