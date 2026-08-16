import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException, WebSocketDisconnect
from watchdog.events import DirModifiedEvent, FileModifiedEvent, FileMovedEvent

from tests.environment import TEST_DATA_DIRECTORY
from termdeck.agent_session_tracker import AgentSessionTracker
from termdeck.file_service import ProjectFileService
from termdeck.models import AgentKind, SessionRecord
from termdeck.config import TermdeckConfig
from termdeck.proc_tree import ProcTreeUtil
from termdeck.pty_process import PtyProcess
from termdeck.server import FollowUpTaskPromptRequest, ForkSessionRequest, NotebookNote, ProjectUiState, RunTerminalTaskRequest, TermdeckServer, UiSettings
from termdeck.session_manager import ManagedSession, TerminalSessionManager
from termdeck.transcript_service import TranscriptService


def record(session_id: str = "abc123") -> SessionRecord:
    return SessionRecord(session_id=session_id, title="session", title_user_set=True, command="",
                         cwd="/tmp", agent_kind="none", agent_session_id=None,
                         created_at_est="2026-01-01T00:00:00", draft="", project="test")


class ProcTreeUtilTest(unittest.TestCase):
    def test_descendants_include_every_process_below_each_socket_holder(self) -> None:
        rows = [(10, 1), (11, 10), (12, 11), (20, 1), (21, 20)]
        self.assertEqual(ProcTreeUtil.descendants(rows, [10, 20]), {10, 11, 12, 20, 21})


class PtyEnvironmentTest(unittest.TestCase):
    def test_session_identity_is_added_to_child_environment(self) -> None:
        environment = PtyProcess._build_child_env({
            TermdeckConfig.SESSION_ID_ENV_KEY: "abc123",
            TermdeckConfig.SESSION_NAME_ENV_KEY: "termde",
            TermdeckConfig.SESSION_PROJECT_ENV_KEY: "stock",
        })

        self.assertEqual(environment[TermdeckConfig.SESSION_ID_ENV_KEY], "abc123")
        self.assertEqual(environment[TermdeckConfig.SESSION_NAME_ENV_KEY], "termde")
        self.assertEqual(environment[TermdeckConfig.SESSION_PROJECT_ENV_KEY], "stock")


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
            def list_sessions(project: str | None = None, worktree_id: str | None = None) -> list[dict[str, object]]:
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
        forked.record.worktree_id = "root"
        server.manager.fork_session.return_value = forked
        server.manager.session_summary_by_id.return_value = {"session_id": "termde-id", "project": "stock"}
        server.manager.session_summary.return_value = {"session_id": "fork-id"}
        with patch.object(server, "_place_session_after", return_value={"position": "after"}) as place:
            result = asyncio.run(server._fork_session("termde-id", ForkSessionRequest(title="termde fork")))
        server.manager.fork_session.assert_called_once_with("termde-id", "termde fork", None)
        place.assert_called_once_with("stock", "fork-id", "session:termde-id", worktree_id="root")
        self.assertEqual(result["placement"], {"position": "after"})

    def test_settings_put_preserves_new_server_session_missing_from_stale_client_layout(self) -> None:
        class Store:
            def __init__(self) -> None:
                self.payload = {
                    "project_state": {
                        "stock": {
                            "terminal_layout": ["session:origin-id", "session:child-id", "session:other-id"],
                            "session_order": ["origin-id", "child-id", "other-id"],
                        }
                    }
                }

            def load(self) -> dict[str, object]:
                return self.payload

            def save(self, payload: dict[str, object]) -> None:
                self.payload = payload

        server = TermdeckServer.__new__(TermdeckServer)
        server.settings_store = Store()
        server.manager = MagicMock()
        server.manager.list_sessions.return_value = [
            {"session_id": "origin-id", "project": "stock"},
            {"session_id": "child-id", "project": "stock"},
            {"session_id": "other-id", "project": "stock"},
        ]
        incoming = UiSettings(project_state={
            "stock": ProjectUiState(terminal_layout=["session:origin-id", "session:other-id"],
                                     session_order=["origin-id", "other-id"]),
        })

        asyncio.run(server._put_settings(incoming))

        self.assertEqual(server.settings_store.payload["project_state"]["stock"]["terminal_layout"], [
            "session:origin-id", "session:child-id", "session:other-id",
        ])
        self.assertEqual(server.settings_store.payload["project_state"]["stock"]["session_order"], [
            "origin-id", "child-id", "other-id",
        ])


class FileTreeEventTest(unittest.TestCase):
    def test_file_modification_reports_the_changed_file(self) -> None:
        service = ProjectFileService()
        root = Path("/Users/dan/workspace/stock")
        event = FileModifiedEvent(str(root / "trainer" / "model.py"))
        self.assertEqual(service._file_tree_event_changes(root, event), [{
            "path": "trainer/model.py", "parent": "trainer", "operation": "modified", "is_directory": False,
        }])

    def test_directory_modification_is_not_forwarded(self) -> None:
        service = ProjectFileService()
        root = Path("/Users/dan/workspace/stock")
        event = DirModifiedEvent(str(root / "trainer"))
        self.assertEqual(service._file_tree_event_changes(root, event), [])

    def test_move_reports_the_source_and_destination(self) -> None:
        service = ProjectFileService()
        root = Path("/Users/dan/workspace/stock")
        event = FileMovedEvent(str(root / "trainer" / "old.py"), str(root / "models" / "new.py"))
        self.assertEqual(service._file_tree_event_changes(root, event), [
            {"path": "trainer/old.py", "parent": "trainer", "operation": "deleted", "is_directory": False},
            {"path": "models/new.py", "parent": "models", "operation": "created", "is_directory": False},
        ])

    def test_ignored_virtual_environment_change_is_not_forwarded(self) -> None:
        service = ProjectFileService()
        root = Path("/Users/dan/workspace/stock")
        event = FileModifiedEvent(str(root / ".venv" / "lib" / "package.py"))
        self.assertEqual(service._file_tree_event_changes(root, event), [])


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

    def test_transcript_first_geometry_keeps_agent_session_size_authoritative(self) -> None:
        manager = TerminalSessionManager()
        saved = record()
        saved.agent_kind = AgentKind.CODEX.value
        saved.cols, saved.rows = 120, 32
        session = ManagedSession(saved)
        manager._sessions[saved.session_id] = session
        manager.set_transcript_first_terminal_stability(True)

        manager.resize(saved.session_id, 162, 61)
        _, queue = manager.attach_client(saved.session_id, screen_repaint=True)

        self.assertEqual((session.cols, session.rows), (120, 32))
        self.assertEqual((session.record.cols, session.record.rows), (120, 32))
        self.assertIsNone(session.screen_repaint_task)
        manager.detach_client(saved.session_id, queue)

    def test_transcript_first_geometry_does_not_freeze_shell_sessions(self) -> None:
        manager = TerminalSessionManager()
        session = ManagedSession(record())
        manager._sessions[session.record.session_id] = session
        manager._persist = lambda: None  # type: ignore[method-assign]
        manager.set_transcript_first_terminal_stability(True)

        manager.resize(session.record.session_id, 162, 61)

        self.assertEqual((session.record.cols, session.record.rows), (162, 61))


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


class NewAgentCommandModelTest(unittest.TestCase):
    def test_codex_model_name_separates_model_from_reasoning_effort(self) -> None:
        command = TerminalSessionManager().command_for_new_session("codex", "default", "", "gpt-5.6-luna xhigh")
        self.assertEqual(command, "codex -c 'model_reasoning_effort=\"xhigh\"' --model gpt-5.6-luna")

    def test_model_name_is_forwarded_to_claude(self) -> None:
        command = TerminalSessionManager().command_for_new_session("claude", "default", "", "opus")
        self.assertEqual(command, "claude --model opus")

    def test_model_name_is_forwarded_to_agy(self) -> None:
        command = TerminalSessionManager().command_for_new_session("agy", "default", "", "gemini-2.5-pro")
        self.assertEqual(command, "agy --model gemini-2.5-pro")


class CodexTranscriptParsingTest(unittest.TestCase):
    def test_current_codex_agent_message_format_is_parsed_without_duplicate_response(self) -> None:
        service = TranscriptService()
        lines = [
            json.dumps({"type": "response_item", "payload": {
                "type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}],
            }}),
            json.dumps({"type": "event_msg", "payload": {
                "type": "item_completed", "item": {"type": "AgentMessage", "phase": "final_answer",
                "content": [{"type": "Text", "text": "hello"}]},
            }}),
            json.dumps({"type": "response_item", "payload": {
                "type": "message", "role": "assistant", "phase": "final_answer",
                "content": [{"type": "output_text", "text": "hello"}],
            }}),
        ]

        turns = service._parse_codex_lines(lines)

        self.assertEqual([turn["role"] for turn in turns], ["user", "assistant"])
        self.assertEqual(turns[-1]["text"], "hello")
        self.assertTrue(turns[-1]["final"])

    def test_codex_commentary_is_not_marked_as_final_answer(self) -> None:
        service = TranscriptService()
        lines = [
            json.dumps({"type": "response_item", "payload": {
                "type": "message", "role": "assistant", "phase": "commentary",
                "content": [{"type": "output_text", "text": "I’ll inspect the store first."}],
            }}),
            json.dumps({"type": "response_item", "payload": {
                "type": "message", "role": "assistant", "phase": "final_answer",
                "content": [{"type": "output_text", "text": "The audit is complete."}],
            }}),
        ]

        turns = service._parse_codex_lines(lines)

        self.assertFalse(turns[0]["final"])
        self.assertTrue(turns[1]["final"])


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
    def test_unit_test_data_directory_is_not_live_state(self) -> None:
        self.assertNotEqual(TermdeckConfig.DATA_DIR, Path.home() / ".termdeck")
        self.assertEqual(TermdeckConfig.DATA_DIR, Path(TEST_DATA_DIRECTORY.name))

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

    async def test_attaching_client_keeps_nudge_when_output_arrives_during_the_delay(self) -> None:
        manager, session, proc = self._session_whose_screen_was_stripped()

        with patch.object(TermdeckConfig, "SCREEN_REPAINT_CLIENT_ATTACH_DELAY_SECONDS", 0), \
             patch.object(TermdeckConfig, "SCREEN_REPAINT_NUDGE_HOLD_SECONDS", 0):
            manager.attach_client(session.record.session_id)
            session.last_activity_at += 1
            await session.screen_repaint_task

        self.assertEqual(proc.resizes, [(119, 32), (120, 32)])

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

    async def test_explicit_codex_repaint_nudges_the_live_pty(self) -> None:
        manager, session, proc = self._session_whose_screen_was_stripped()
        session.record.agent_kind = AgentKind.CODEX.value

        with patch.object(TermdeckConfig, "SCREEN_REPAINT_NUDGE_HOLD_SECONDS", 0):
            self.assertTrue(manager.request_screen_repaint(session.record.session_id))
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

class TerminalTaskApiTest(unittest.IsolatedAsyncioTestCase):
    async def test_terminal_websocket_repaint_requests_server_pty_redraw(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        websocket = MagicMock()
        websocket.receive_text = AsyncMock(side_effect=[json.dumps({"type": "repaint"}), WebSocketDisconnect()])

        await server._pump_client_to_pty(websocket, "codex-session")

        server.manager.request_screen_repaint.assert_called_once_with("codex-session")

    async def test_transcript_first_websocket_ignores_agent_resize_and_repaint(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.session_supports_transcript_first_geometry.return_value = True
        server.transcript_first_terminal_stability = True
        websocket = MagicMock()
        websocket.receive_text = AsyncMock(side_effect=[
            json.dumps({"type": "resize", "cols": 180, "rows": 50}),
            json.dumps({"type": "repaint"}),
            WebSocketDisconnect(),
        ])

        await server._pump_client_to_pty(websocket, "codex-session")

        server.manager.resize.assert_not_called()
        server.manager.request_screen_repaint.assert_not_called()

    async def test_follow_up_prompt_directly_steers_busy_task_session(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.has_session.return_value = True
        server.manager.session_summary_by_id.return_value = {"processing": True, "session_id": "child-01"}
        server.manager.ensure_session_running.return_value = None
        server.manager.submit_prompt = AsyncMock()

        response = await server._follow_up_task_prompt(
            "child-01", FollowUpTaskPromptRequest(prompt="summarize the result"))

        server.manager.submit_prompt.assert_awaited_once_with("child-01", "summarize the result", True, False)
        self.assertTrue(response["prompt_submitted"])
        self.assertFalse(response["queued"])

    async def test_run_terminal_task_forwards_model_name_to_session_builder(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.command_for_new_session.return_value = "codex --model gpt-5.6-luna xhigh"
        ms = MagicMock()
        ms.record.session_id = "task-model"
        ms.record.project = "stock"
        server.manager.create_session.return_value = ms
        server.manager.session_summary.side_effect = [
            {"session_id": "task-model", "project": "stock"},
            {"session_id": "task-model", "project": "stock", "running": True},
        ]
        server.manager.ensure_session_running.return_value = None
        server.manager.submit_prompt = AsyncMock()
        request = RunTerminalTaskRequest(command="run checks", model_name="gpt-5.6-luna xhigh")
        await server._run_terminal_task(request)
        server.manager.command_for_new_session.assert_called_once_with(
            "codex",
            "default",
            "",
            "gpt-5.6-luna xhigh",
        )

    async def test_run_terminal_task_forks_origin_and_places_child_after_it(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.list_sessions.return_value = [{"session_id": "origin-01", "title": "origin"}]
        server.manager.session_summary_by_id.return_value = {"session_id": "origin-01", "cwd": "/origin", "project": "stock"}
        child = MagicMock()
        child.record.session_id = "fork-01"
        child.record.project = "stock"
        server.manager.fork_session.return_value = child
        server.manager.session_summary.side_effect = [
            {"session_id": "fork-01", "project": "stock"},
            {"session_id": "fork-01", "project": "stock", "running": True},
        ]
        server.manager.ensure_session_running.return_value = None
        server.manager.submit_prompt = AsyncMock()
        server._schedule_task_result_delivery = MagicMock()

        with patch.object(server, "_place_session_after", return_value={"position": "after"}) as place:
            response = await server._run_terminal_task(RunTerminalTaskRequest(
                prompt="inspect this", title="reviewer", origin_session="origin-01", fork=True,
                model="claude", model_name="opus", permission="full-access"))

        server.manager.fork_session.assert_called_once_with("origin-01", "reviewer", None)
        server.manager.command_for_new_session.assert_not_called()
        server.manager.create_session.assert_not_called()
        place.assert_called_once_with("stock", "fork-01", "session:origin-01", worktree_id=child.record.worktree_id)
        server.manager.submit_prompt.assert_awaited_once_with("fork-01", "inspect this", True, False)
        server._schedule_task_result_delivery.assert_not_called()
        self.assertEqual(response["placement"], {"position": "after"})

    async def test_run_terminal_task_creates_and_submits_prompt(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.command_for_new_session.return_value = "codex"
        ms = MagicMock()
        ms.record.session_id = "task-01"
        ms.record.project = "stock"
        ms.record.worktree_id = "root"
        server.manager.create_session.return_value = ms
        server.manager.registry.root_for.return_value = "/tmp"
        server.manager.session_summary.side_effect = [
            {"session_id": "task-01", "project": "stock"},
            {"session_id": "task-01", "project": "stock", "running": True},
        ]
        server.manager.ensure_session_running.return_value = None
        server.manager.submit_prompt = AsyncMock()

        request = RunTerminalTaskRequest(command="run checks", cwd="/tmp", project="stock", output_path="/tmp/task-out.txt")
        response = await server._run_terminal_task(request)

        server.manager.command_for_new_session.assert_called_once_with("codex", "default", "", "")
        server.manager.create_session.assert_called_once_with(
            "codex",
            "/tmp",
            "",
            "stock",
            output_path="/tmp/task-out.txt",
            agent_rename=None,
            worktree=None,
            worktree_id="root",
        )
        server.manager.ensure_session_running.assert_called_once_with("task-01")
        server.manager.submit_prompt.assert_awaited_once_with("task-01", "run checks", True, False)
        self.assertEqual(response["prompt_submitted"], True)
        self.assertEqual(response["session_id"], "task-01")
        self.assertNotIn("monitoring_url", response)

    async def test_run_terminal_task_infers_project_from_after_anchor(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.command_for_new_session.return_value = "codex"
        server.manager.list_sessions.return_value = [{"session_id": "ref-01", "title": "termde fork", "project": "stock", "cli_title": "termde fork"}]
        ms = MagicMock()
        ms.record.session_id = "task-02"
        ms.record.project = "stock"
        ms.record.worktree_id = "root"
        server.manager.create_session.return_value = ms
        server.manager.registry.root_for.return_value = "/stock"
        server.manager.session_summary.side_effect = [
            {"session_id": "task-02", "project": ""},
            {"session_id": "task-02", "project": "stock", "running": True},
        ]
        server.manager.ensure_session_running.return_value = None
        server.manager.submit_prompt = AsyncMock()

        class Store:
            def __init__(self) -> None:
                self.payload = {"project_state": {}}

            def load(self) -> dict[str, object]:
                return self.payload

            def save(self, payload: dict[str, object]) -> None:
                self.payload = payload

        server.settings_store = Store()

        request = RunTerminalTaskRequest(command="run checks", after="termde fork")
        await server._run_terminal_task(request)

        server.manager.create_session.assert_called_once_with(
            "codex",
            "/stock",
            "",
            "stock",
            output_path="",
            agent_rename=None,
            worktree=None,
            worktree_id="root",
        )

    async def test_task_status_marks_done_only_when_terminal_has_exited(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.has_session.return_value = True
        server.manager.session_summary_by_id.return_value = {
            "running": False, "exit_code": 0, "output_path": "/tmp/task-out.txt"
        }
        server.manager.session_history_source.return_value = ("codex", "/tmp", "session-xyz")
        server.transcripts = MagicMock()
        server.transcripts.history_page.return_value = {"turns": [], "before": None, "has_more": False}

        response = await server._task_status("task-02")

        self.assertTrue(response["completed"])
        self.assertEqual(response["session_id"], "task-02")
        self.assertEqual(response["output_path"], "/tmp/task-out.txt")

    async def test_task_status_includes_transcript_tail(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.has_session.return_value = True
        server.manager.session_summary_by_id.return_value = {
            "running": False, "exit_code": 0, "output_path": "/tmp/task-out.txt"
        }
        server.manager.session_history_source.return_value = ("codex", "/tmp", "session-xyz")
        server.transcripts = MagicMock()
        server.transcripts.history_page.return_value = {
            "turns": [{"role": "assistant", "text": "first"}, {"role": "assistant", "text": "second"}],
            "before": 0,
            "has_more": False,
        }

        response = await server._task_status("task-03")

        self.assertTrue(response["completed"])
        self.assertEqual(response["agent_session_id"], "session-xyz")
        self.assertEqual(response["latest_turn"], {"role": "assistant", "text": "second"})
        self.assertEqual(len(response["transcript"]["tail"]), 2)

    async def test_task_result_returns_only_the_last_turn_and_completion_state(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.has_session.return_value = True
        server.manager.session_summary_by_id.return_value = {"running": False, "exit_code": 0}
        server.manager.session_history_source.return_value = ("codex", "/tmp", "session-xyz")
        server.transcripts = MagicMock()
        server.transcripts.history_page.return_value = {"turns": [
            {"role": "assistant", "text": "older"},
            {"role": "user", "text": "latest prompt"},
            {"role": "assistant", "text": "done"},
        ]}

        response = await server._task_result("task-04")

        self.assertEqual(response, {"session_id": "task-04", "status": "completed",
                                     "last_turn": {"role": "assistant", "text": "done"}})
        server.transcripts.history_page.assert_called_once_with("codex", "/tmp", "session-xyz", None, 1)

    async def test_task_result_accepts_unique_session_name(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.has_session.return_value = False
        server.manager.list_sessions.return_value = [{"session_id": "task-05", "title": "reviewer"}]
        server.manager.session_summary_by_id.return_value = {"running": False, "exit_code": 0}
        server.manager.session_history_source.return_value = ("codex", "/tmp", "session-xyz")
        server.transcripts = MagicMock()
        server.transcripts.history_page.return_value = {"turns": [{"role": "assistant", "text": "done"}]}

        response = await server._task_result("reviewer")

        self.assertEqual(response, {"session_id": "task-05", "status": "completed",
                                     "last_turn": {"role": "assistant", "text": "done"}})
        server.manager.session_history_source.assert_called_once_with("task-05")

    async def test_task_result_rejects_duplicate_session_name(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.has_session.return_value = False
        server.manager.list_sessions.return_value = [
            {"session_id": "task-06", "title": "reviewer"},
            {"session_id": "task-07", "title": "reviewer"},
        ]

        with self.assertRaises(HTTPException) as raised:
            await server._task_result("reviewer")

        self.assertEqual(raised.exception.status_code, 409)

    async def test_child_result_is_delivered_to_origin_session_after_processing_finishes(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.has_session.return_value = True
        server.manager.session_summary_by_id.side_effect = [
            {"running": True, "processing": True},
            {"running": True, "processing": False},
            {"processing": False},
        ]
        server.manager.session_history_source.return_value = ("codex", "/tmp", "child-agent")
        server.manager.submit_prompt = AsyncMock()
        server.transcripts = MagicMock()
        server.transcripts.history_page.return_value = {"turns": [{"role": "assistant", "text": "finished", "final": True}]}
        server._origin_delivery_locks = {}

        await server._deliver_task_result("child-01", "origin-01")

        server.manager.submit_prompt.assert_awaited_once_with(
            "origin-01", "[TermDeck task child-01 completed]\nfinished", True, False)

    async def test_child_result_uses_latest_assistant_turn_after_user_prompt(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.session_history_source.return_value = ("codex", "/tmp", "child-agent")
        server.transcripts = MagicMock()
        server.transcripts.history_page.return_value = {"turns": [
            {"role": "user", "text": "hi"},
            {"role": "assistant", "text": "hello"},
        ]}

        result = await server._read_last_turn("child-01")

        self.assertEqual(result, {"role": "assistant", "text": "hello"})

    async def test_child_result_waits_for_assistant_turn_when_processing_marker_is_already_clear(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.has_session.return_value = True
        server.manager.session_summary_by_id.side_effect = [
            {"running": True, "processing": False},
            {"running": True, "processing": False},
            {"processing": True},
        ]
        server.manager.session_history_source.return_value = ("codex", "/tmp", "child-agent")
        server.manager.submit_prompt = AsyncMock()
        server.transcripts = MagicMock()
        server.transcripts.history_page.side_effect = [
            {"turns": [{"role": "user", "text": "hi"}]},
            {"turns": [{"role": "user", "text": "hi"}, {"role": "assistant", "text": "hello", "final": True}]},
        ]
        server._origin_delivery_locks = {}

        await server._deliver_task_result("child-01", "origin-01")

        server.manager.submit_prompt.assert_awaited_once_with(
            "origin-01", "[TermDeck task child-01 completed]\nhello", True, True)

    async def test_origin_defaults_child_cwd_project_and_placement(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.list_sessions.return_value = [{
            "session_id": "origin-01", "title": "termde", "project": "stock", "cwd": "/origin",
        }]
        server.manager.session_summary_by_id.return_value = {
            "session_id": "origin-01", "project": "stock", "cwd": "/origin",
        }
        server.manager.command_for_new_session.return_value = "codex"
        child = MagicMock()
        child.record.session_id = "child-01"
        child.record.project = "stock"
        child.record.worktree_id = "root"
        server.manager.create_session.return_value = child
        server.manager.session_summary.side_effect = [{"session_id": "child-01"}, {"session_id": "child-01"}]
        server.manager.ensure_session_running.return_value = None
        server.manager.submit_prompt = AsyncMock()
        server._schedule_task_result_delivery = MagicMock()

        with patch.object(server, "_place_session_after", return_value={"position": "after"}):
            await server._run_terminal_task(RunTerminalTaskRequest(
                prompt="hi", title="child", origin_session="termde", write_back=True))

        server.manager.create_session.assert_called_once_with(
            "codex", "/origin", "child", "stock", output_path="", agent_rename="child",
            worktree=None, worktree_id="root")
        server._schedule_task_result_delivery.assert_called_once_with("child-01", "origin-01")

    async def test_output_path_defaults_to_absolute_for_session_records(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manager = TerminalSessionManager()
            manager._spawn = MagicMock()
            manager._persist = lambda: None
            ms = manager.create_session("bash", directory, "task", output_path="logs/task.out")
            self.assertEqual(ms.record.output_path, str(Path(directory, "logs", "task.out").resolve()))
