import asyncio
import json
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException, WebSocketDisconnect
from watchdog.events import DirModifiedEvent, FileModifiedEvent, FileMovedEvent

from tests.environment import TEST_DATA_DIRECTORY
from termdeck import agents
from termdeck.agent_session_tracker import AgentSessionTracker
from termdeck.agents.claude import ClaudeCli
from termdeck.file_service import ProjectFileService
from termdeck.models import SessionRecord
from termdeck.config import TermdeckConfig
from termdeck.proc_tree import ProcTreeSnapshot, ProcTreeUtil
from termdeck.pty_process import PtyProcess
from termdeck.server import FollowUpTaskPromptRequest, ForkSessionRequest, NotebookNote, NotebookNoteSaveRequest, ProjectStatePatch, ProjectUiState, RunTerminalTaskRequest, SessionGroupAssignmentsRequest, SubmitPromptRequest, TermdeckServer, UiSettings
from termdeck.replay_recorder import ReplayRecorder
from termdeck.session_manager import ManagedSession, TerminalSessionManager
from termdeck.transcript_turns import TurnBuilder


def record(session_id: str = "abc123") -> SessionRecord:
    return SessionRecord(session_id=session_id, title="session", title_user_set=True, command="",
                         cwd="/tmp", agent_kind="none", agent_session_id=None,
                         created_at_est="2026-01-01T00:00:00", draft="", project="test")


def process_row(pid: int, ppid: int = 1, command: str = "dtach") -> dict[str, int | float | str]:
    return {"pid": pid, "ppid": ppid, "state": "S", "cpu_percent": 0.0, "rss_kb": 4096,
            "elapsed": "01:00", "command": command}


@contextmanager
def proc_tree_probe(socket_holders: dict[str, list[int]], processes: list[dict[str, int | float | str]]):
    """Stand in for the two subprocesses a ProcTreeSnapshot samples, counting how often they are run."""
    socket_probes = AsyncMock(return_value=socket_holders)
    process_probes = AsyncMock(return_value=processes)
    with patch.object(ProcTreeUtil, "unix_socket_holders", new=socket_probes), \
         patch.object(ProcTreeUtil, "process_table", new=process_probes):
        yield SimpleNamespace(socket_probes=socket_probes, process_probes=process_probes)


class ProcTreeUtilTest(unittest.IsolatedAsyncioTestCase):
    def test_descendants_include_every_process_below_each_socket_holder(self) -> None:
        rows = [(10, 1), (11, 10), (12, 11), (20, 1), (21, 20)]
        self.assertEqual(ProcTreeUtil.descendants(rows, [10, 20]), {10, 11, 12, 20, 21})

    async def test_one_lsof_pass_attributes_every_named_socket_to_its_holders(self) -> None:
        # lsof -F output: a p line opens a process and each of its files follows as an f line, plus an
        # n line for the ones that are named sockets.
        output = "p101\nf3\nn/deck/one.sock\nf4\nn->0x9a\np202\nf7\nn/deck/two.sock\nf8\nn/deck/one.sock\n"
        with patch.object(ProcTreeUtil, "_run", new=AsyncMock(return_value=output)):
            holders = await ProcTreeUtil.unix_socket_holders()
        self.assertEqual(holders["/deck/one.sock"], [101, 202])
        self.assertEqual(holders["/deck/two.sock"], [202])

    async def test_snapshot_expands_socket_holders_into_their_whole_tree(self) -> None:
        with proc_tree_probe({"/deck/one.sock": [10]},
                             [process_row(10), process_row(11, ppid=10), process_row(99)]):
            snapshot = await ProcTreeSnapshot.capture()
        self.assertEqual(snapshot.tree_pids_for_socket("/deck/one.sock"), {10, 11})
        self.assertEqual(snapshot.tree_pids_for_socket("/deck/missing.sock"), set())
        self.assertEqual([process["pid"] for process in snapshot.process_details({11, 10})], [10, 11])


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

    def test_ungrouped_session_reposition_persists_top_level_layout_and_session_order(self) -> None:
        class Store:
            def __init__(self) -> None:
                self.payload = {"project_state": {"speechify": {
                    "terminal_layout": ["session:task1", "session:task2", "session:task3", "session:task2-audit"],
                    "session_order": ["task1", "task2", "task3", "task2-audit"],
                }}}

            def load(self) -> dict[str, object]:
                return self.payload

            def save(self, payload: dict[str, object]) -> None:
                self.payload = payload

        server = TermdeckServer.__new__(TermdeckServer)
        server.settings_store = Store()
        server.manager = MagicMock()
        server.manager.list_sessions.return_value = [
            {"session_id": "task1"}, {"session_id": "task2"},
            {"session_id": "task3"}, {"session_id": "task2-audit"},
        ]

        asyncio.run(server._put_session_group_assignments(
            SessionGroupAssignmentsRequest(assignments={"task2-audit": None}, target_session_id="task2", after=True),
            project="speechify", worktree_id="root"))

        state = server.settings_store.payload["project_state"]["speechify"]
        self.assertEqual(state["terminal_layout"], [
            "session:task1", "session:task2", "session:task2-audit", "session:task3",
        ])
        self.assertEqual(state["session_order"], ["task1", "task2", "task2-audit", "task3"])


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


class NotebookNoteApiTest(unittest.TestCase):
    def server(self, notes: list[NotebookNote]) -> TermdeckServer:
        class Store:
            def __init__(self) -> None:
                self.payload = UiSettings(project_state={
                    "stock": ProjectUiState(notebook_notes=notes, notebook_notes_initialized=True),
                }).model_dump()

            def load(self) -> dict[str, object]:
                return self.payload

            def save(self, payload: dict[str, object]) -> None:
                self.payload = payload

        server = TermdeckServer.__new__(TermdeckServer)
        server.settings_store = Store()
        server.manager = MagicMock()
        server.manager.list_sessions.return_value = []
        return server

    def notes(self, server: TermdeckServer) -> list[tuple[str, str]]:
        state = server.settings_store.payload["project_state"]["stock"]
        return [(note["note_id"], note["text"]) for note in state["notebook_notes"]]

    def test_saving_one_note_leaves_notes_another_page_added_alone(self) -> None:
        server = self.server([NotebookNote(note_id="note-1", text="first"), NotebookNote(note_id="note-2", text="second")])

        asyncio.run(server._save_notebook_note(NotebookNoteSaveRequest(text="first edited"), note_id="note-1",
                                               project="stock", worktree_id="root"))

        self.assertEqual(self.notes(server), [("note-1", "first edited"), ("note-2", "second")])

    def test_saving_an_unknown_note_appends_it(self) -> None:
        server = self.server([NotebookNote(note_id="note-1", text="first")])

        asyncio.run(server._save_notebook_note(NotebookNoteSaveRequest(text="added"), note_id="note-2",
                                               project="stock", worktree_id="root"))

        self.assertEqual(self.notes(server), [("note-1", "first"), ("note-2", "added")])

    def test_deleting_a_note_removes_only_that_note(self) -> None:
        server = self.server([NotebookNote(note_id="note-1", text="first"), NotebookNote(note_id="note-2", text="second")])

        asyncio.run(server._delete_notebook_note(note_id="note-1", project="stock", worktree_id="root"))

        self.assertEqual(self.notes(server), [("note-2", "second")])

    def test_deleting_a_missing_note_is_rejected(self) -> None:
        server = self.server([NotebookNote(note_id="note-1", text="first")])

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(server._delete_notebook_note(note_id="note-9", project="stock", worktree_id="root"))

        self.assertEqual(raised.exception.status_code, 404)

    def test_patching_the_whole_note_list_is_rejected(self) -> None:
        server = self.server([NotebookNote(note_id="note-1", text="first")])

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(server._patch_terminal_layout(
                ProjectStatePatch(notebook_notes=[NotebookNote(note_id="note-1", text="first")]),
                project="stock", worktree_id="root"))

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("notebook_notes", raised.exception.detail)

    def test_patching_the_active_note_still_works(self) -> None:
        server = self.server([NotebookNote(note_id="note-1", text="first")])

        asyncio.run(server._patch_terminal_layout(ProjectStatePatch(notebook_active_note_id="note-1"),
                                                  project="stock", worktree_id="root"))

        self.assertEqual(server.settings_store.payload["project_state"]["stock"]["notebook_active_note_id"], "note-1")
        self.assertEqual(self.notes(server), [("note-1", "first")])


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

class AgentCliRegistryTest(unittest.TestCase):
    def test_detect_agent_cli_by_command_token(self) -> None:
        self.assertEqual(agents.detect_agent_cli("claude --resume aa11").kind, "claude")
        self.assertEqual(agents.detect_agent_cli("/usr/bin/codex resume bb22").kind, "codex")
        self.assertEqual(agents.detect_agent_cli("echo claude-like && ls").kind, "none")
        self.assertEqual(agents.detect_agent_cli("").kind, "none")

    def test_model_aliases_resolve_to_agy(self) -> None:
        # "gemini" is an antigravity alias: Google deprecated gemini-cli for Antigravity.
        for alias in ("gemini", "agd", "antigravity"):
            self.assertEqual(agents.resolve_model_alias(alias), "agy")
        self.assertEqual(agents.resolve_model_alias("claude"), "claude")

    def test_unknown_permission_raises(self) -> None:
        with self.assertRaises(ValueError):
            agents.agent_cli("codex").build_command("nonsense", "", "", None)

    def test_transcript_commands_are_exposed_by_agent_descriptor(self) -> None:
        codex_commands = agents.agent_cli("codex").client_descriptor()["transcript_commands"]
        claude_commands = agents.agent_cli("claude").client_descriptor()["transcript_commands"]
        self.assertIn({"command": "/status", "description": "Show model, context, and usage status"}, codex_commands)
        self.assertIn({"command": "/context", "description": "Show current context usage"}, claude_commands)
        self.assertEqual(agents.agent_cli("none").client_descriptor()["transcript_commands"], [])

    def test_set_permission_swaps_existing_flags(self) -> None:
        self.assertEqual(
            agents.agent_cli("claude").set_permission("claude --permission-mode auto --foo", "full-access"),
            "claude --dangerously-skip-permissions --foo")
        self.assertEqual(
            agents.agent_cli("codex").set_permission(
                "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox", "read-only"),
            "codex --sandbox read-only --no-alt-screen")

    def test_every_agent_answers_the_store_discovery_surface(self) -> None:
        # Exercises the real filesystem paths (day-dir globs and friends) that mocks skip.
        for kind, agent in agents.AGENT_CLIS.items():
            candidates = agent.candidate_session_files(Path.home())
            self.assertIsInstance(candidates, list, kind)
            self.assertIsNone(agent.transcript_path(Path.home(), "ffffffff-ffff-ffff-ffff-ffffffffffff"), kind)

    def test_claude_fork_command_carries_name(self) -> None:
        self.assertEqual(
            agents.agent_cli("claude").fork_command("claude --resume aa11", "bb22", "my fork"),
            "claude --resume bb22 --fork-session --name 'my fork'")


class AgentCliResumeCommandTest(unittest.TestCase):
    def test_build_codex_resume_command_keeps_existing_flags(self) -> None:
        command = "codex --sandbox workspace-write resume aa11 --foo"
        self.assertEqual(agents.agent_cli("codex").resume_command(command, "bb22"),
            "codex --no-alt-screen --sandbox workspace-write --foo resume bb22")

    def test_build_codex_resume_command_with_path_keeps_flags(self) -> None:
        command = "/usr/bin/codex --dangerously-bypass-approvals-and-sandbox resume aa11"
        self.assertEqual(agents.agent_cli("codex").resume_command(command, "bb22"),
            "/usr/bin/codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume bb22")

    def test_build_claude_resume_command_strips_old_resume_flag(self) -> None:
        command = "claude --permission-mode auto --resume aa11"
        self.assertEqual(agents.agent_cli("claude").resume_command(command, "bb22"),
            "claude --permission-mode auto --resume bb22")

    def test_latest_claude_permission_mode_comes_from_transcript(self) -> None:
        tracker = AgentSessionTracker()
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "resolved-child.jsonl"
            path.write_text('\n'.join((
                json.dumps({"type": "permission-mode", "permissionMode": "dontAsk"}),
                json.dumps({"type": "permission-mode", "permissionMode": "auto"}),
            )))
            with patch.object(tracker, "claude_project_dir", return_value=Path(temp_dir)):
                self.assertEqual(tracker.claude_session_permission_mode(Path("/tmp"), "resolved-child"), "auto")


class TerminalRestartIdentityTest(unittest.TestCase):
    @staticmethod
    def claude_session(agent_session_id: str | None) -> ManagedSession:
        session_record = record("claude-tab")
        session_record.agent_kind = "claude"
        session_record.agent_session_id = agent_session_id
        session_record.command = "claude --permission-mode auto --resume stale-parent"
        return ManagedSession(session_record)

    def test_binding_detected_fork_session_replaces_stale_parent_resume_command(self) -> None:
        manager = TerminalSessionManager()
        session = self.claude_session(None)

        manager._set_agent_session_binding(session, "resolved-child")

        self.assertEqual(session.record.agent_session_id, "resolved-child")
        self.assertEqual(session.record.command, "claude --permission-mode auto --resume resolved-child")

    def test_restart_with_permission_resumes_resolved_child_session(self) -> None:
        manager = TerminalSessionManager()
        session = self.claude_session("resolved-child")
        manager._sessions = {session.record.session_id: session}
        manager._persist = MagicMock()
        manager._terminate_proc = AsyncMock(return_value=True)
        manager._spawn = MagicMock()

        asyncio.run(manager.restart_session(session.record.session_id, "full-access"))

        self.assertEqual(session.record.command,
                         "claude --dangerously-skip-permissions --resume resolved-child")
        manager._terminate_proc.assert_awaited_once_with(session)
        manager._spawn.assert_called_once_with(session, resume=True)

    def test_restart_preserves_latest_claude_transcript_permission(self) -> None:
        manager = TerminalSessionManager()
        session = self.claude_session("resolved-child")
        session.record.command = "claude --dangerously-skip-permissions --resume resolved-child"
        manager._sessions = {session.record.session_id: session}
        manager._tracker.claude_session_permission_mode = MagicMock(return_value="auto")
        manager._persist = MagicMock()
        manager._terminate_proc = AsyncMock(return_value=True)
        manager._spawn = MagicMock()

        asyncio.run(manager.restart_session(session.record.session_id))

        self.assertEqual(session.record.command, "claude --permission-mode auto --resume resolved-child")
        manager._spawn.assert_called_once_with(session, resume=True)

    def test_restart_refuses_agent_before_child_session_identity_is_resolved(self) -> None:
        manager = TerminalSessionManager()
        session = self.claude_session(None)
        manager._sessions = {session.record.session_id: session}
        manager._terminate_proc = AsyncMock(return_value=True)

        with self.assertRaisesRegex(RuntimeError, "identity is still resolving"):
            asyncio.run(manager.restart_session(session.record.session_id, "full-access"))

        manager._terminate_proc.assert_not_awaited()


class NewAgentCommandModelTest(unittest.TestCase):
    def test_codex_model_name_separates_model_from_reasoning_effort(self) -> None:
        command = TerminalSessionManager().command_for_new_session("codex", "default", "", "gpt-5.6-luna xhigh")
        self.assertEqual(command, "codex --no-alt-screen -c 'model_reasoning_effort=\"xhigh\"' --model gpt-5.6-luna")

    def test_model_name_is_forwarded_to_claude(self) -> None:
        command = TerminalSessionManager().command_for_new_session("claude", "default", "", "opus")
        self.assertEqual(command, "claude --model opus")

    def test_model_name_is_forwarded_to_agy(self) -> None:
        command = TerminalSessionManager().command_for_new_session("agy", "default", "", "gemini-2.5-pro")
        self.assertEqual(command, "agy --model gemini-2.5-pro")


class CodexTranscriptParsingTest(unittest.TestCase):
    def test_current_codex_agent_message_format_is_parsed_without_duplicate_response(self) -> None:
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

        turns = agents.agent_cli("codex").parse_transcript_lines(lines)

        self.assertEqual([turn["role"] for turn in turns], ["user", "assistant"])
        self.assertEqual(turns[-1]["text"], "hello")
        self.assertTrue(turns[-1]["final"])

    def test_codex_commentary_is_not_marked_as_final_answer(self) -> None:
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

        turns = agents.agent_cli("codex").parse_transcript_lines(lines)

        self.assertFalse(turns[0]["final"])
        self.assertTrue(turns[1]["final"])

    def test_codex_agent_message_and_response_item_with_different_metadata_are_one_turn(self) -> None:
        text = "I’ll inspect the transcript before changing the renderer."
        lines = [
            json.dumps({"type": "event_msg", "payload": {
                "type": "agent_message", "message": text, "phase": "commentary",
            }}),
            json.dumps({"type": "response_item", "payload": {
                "type": "message", "role": "assistant", "phase": "commentary",
                "content": [{"type": "output_text", "text": text}],
            }}),
        ]

        turns = agents.agent_cli("codex").parse_transcript_lines(lines)

        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0]["text"], text)
        self.assertEqual(turns[0]["phase"], "commentary")
        self.assertFalse(turns[0]["final"])

    def test_codex_mirrored_records_parsed_in_separate_batches_are_one_turn(self) -> None:
        text = "Assembly finished and validation is running."
        lines = [
            json.dumps({"type": "event_msg", "payload": {
                "type": "item_completed", "item": {"type": "AgentMessage", "phase": "commentary",
                "content": [{"type": "Text", "text": text}]},
            }}),
            json.dumps({"type": "response_item", "payload": {
                "type": "message", "role": "assistant", "phase": "commentary",
                "content": [{"type": "output_text", "text": text}],
            }}),
        ]
        agent = agents.agent_cli("codex")
        separately_parsed = [turn for line in lines for turn in agent.parse_transcript_lines([line])]

        turns = TurnBuilder.collapse_thinking_events(separately_parsed)

        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0]["text"], text)


class ClaudeTranscriptParsingTest(unittest.TestCase):
    def test_terminal_clear_line_prefix_is_removed_from_user_prompt(self) -> None:
        lines = [json.dumps({"type": "user", "message": {"content": "\x15Should we increase max workers?"}})]

        turns = agents.agent_cli("claude").parse_transcript_lines(lines)

        self.assertEqual(turns[0]["text"], "Should we increase max workers?")

    def test_compact_boundary_is_rendered_between_the_turns_it_separates(self) -> None:
        # Compaction never truncates the transcript file itself -- turns on both sides of the
        # boundary are ordinary lines. This is what makes the Markdown/history view immune to the
        # live terminal's redraw: it reads this file, not the rendered screen.
        lines = [
            json.dumps({"type": "user", "message": {"content": "print 1 to 100 then say hi"}}),
            json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "1\n2\nhi"}]}}),
            json.dumps({"type": "system", "subtype": "compact_boundary", "content": "Conversation compacted",
                        "compactMetadata": {"trigger": "manual", "preTokens": 31730, "postTokens": 1583}}),
            json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "What's next?"}]}}),
        ]

        turns = agents.agent_cli("claude").parse_transcript_lines(lines)

        self.assertEqual([t["text"] for t in turns],
                         ["print 1 to 100 then say hi", "1\n2\nhi", "31,730 → 1,583 tokens", "What's next?"])
        self.assertEqual(turns[2]["kind"], "compaction")
        self.assertEqual(turns[2]["title"], "Conversation compacted")

    def test_compact_boundary_without_token_metadata_still_renders(self) -> None:
        lines = [json.dumps({"type": "system", "subtype": "compact_boundary", "content": "Conversation compacted"})]

        turns = agents.agent_cli("claude").parse_transcript_lines(lines)

        self.assertEqual(turns[0]["kind"], "compaction")
        self.assertEqual(turns[0]["text"], "")


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

    def test_claude_circle_spinner_reports_processing_and_is_removed_from_persisted_title(self) -> None:
        manager, session, persists = self._manager_with_session()
        session.cli_title = "◑ intraday-fed"
        session.title_updated_monotonic = 99.0

        with patch("termdeck.session_manager.time.monotonic", return_value=100.0):
            self.assertTrue(session.processing)
        manager._remember_cli_title(session)

        self.assertEqual(session.record.cli_title, "intraday-fed")
        self.assertEqual(len(persists), 1)


class ClaudeRenameBindingReconciliationTest(unittest.IsolatedAsyncioTestCase):
    async def test_known_claude_session_does_not_claim_unrelated_recent_transcript_after_input(self) -> None:
        manager = TerminalSessionManager()
        saved = record("claude-known")
        saved.agent_kind = "claude"
        saved.agent_session_id = "current-session"
        saved.command = "claude --resume current-session"
        session = ManagedSession(saved)
        session.detached_live = True
        session.detect_kind = "claude"
        session.last_input_monotonic = 99.0
        session.last_agent_submit_monotonic = 99.0
        manager._sessions[saved.session_id] = session
        manager._tracker.session_id_from_open_files = AsyncMock(return_value=None)
        manager._tracker.absorb_and_find_new_session_file = MagicMock(return_value=None)
        manager._tracker.claude_session_id_from_recent_file_activity = MagicMock(return_value="unrelated-session")

        with patch("termdeck.session_manager.time.monotonic", return_value=100.0):
            await manager._detect_after(session, 0)

        self.assertEqual(saved.agent_session_id, "current-session")
        self.assertFalse(manager._tracker.absorb_and_find_new_session_file.call_args.kwargs["claim_allowed"])
        manager._tracker.claude_session_id_from_recent_file_activity.assert_not_called()

    async def test_codex_detection_does_not_bind_an_already_claimed_parent(self) -> None:
        manager = TerminalSessionManager()
        parent = record("codex-parent")
        parent.agent_kind = "codex"
        parent.agent_session_id = "parent-session"
        parent.command = "codex resume parent-session"
        child = record("codex-child")
        child.agent_kind = "codex"
        child.command = "codex fork parent-session"
        child_session = ManagedSession(child)
        manager._sessions = {parent.session_id: ManagedSession(parent), child.session_id: child_session}
        child_session.detached_live = True
        child_session.detect_kind = "codex"
        child_session.detect_baseline = set()
        child_session.pending_agent_rename = "codex child"
        manager._tracker.session_id_from_open_files = AsyncMock(return_value="parent-session")
        manager._tracker.absorb_and_find_new_session_file = MagicMock(return_value="child-session")
        manager._persist = MagicMock()
        manager._broadcast_control = MagicMock()
        manager._broadcast_status = MagicMock()

        with patch("termdeck.session_manager.time.monotonic", return_value=100.0):
            await manager._detect_after(child_session, 0)

        self.assertEqual(child.agent_session_id, "child-session")
        manager._tracker.absorb_and_find_new_session_file.assert_called_once()

    def test_user_renamed_claude_session_rebinds_to_matching_explicit_title(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manager = TerminalSessionManager()
            saved = record("claude-renamed")
            saved.agent_kind = "claude"
            saved.agent_session_id = "stale-session"
            saved.command = "claude --resume stale-session"
            saved.title = "L-mtermdeck"
            saved.title_user_set = True
            session = ManagedSession(saved)
            session.cli_title = "◑ L-mtermdeck"
            manager._sessions[saved.session_id] = session
            current_path = Path(directory) / "stale-session.jsonl"
            current_path.write_text("{}\n")
            manager._tracker.claude_project_dir = MagicMock(return_value=Path(directory))
            manager._tracker.claude_explicit_session_title = MagicMock(return_value=None)
            manager._tracker.claude_session_id_for_explicit_title = MagicMock(return_value="live-session")
            manager._persist = MagicMock()

            claude = agents.agent_cli("claude")
            with patch.object(claude, "initialize_subagent_state"):
                self.assertTrue(claude.reconcile_stale_binding(manager, session))

        self.assertEqual(saved.agent_session_id, "live-session")
        self.assertEqual(saved.command, "claude --resume live-session")


class CodexSessionActivityTest(unittest.TestCase):
    def test_task_state_is_read_without_starting_the_terminal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "rollout-2026-08-02T00-00-00-019f9a3e-1915-7bd3-8183-cce1db8a1e20.jsonl"
            path.write_text("\n".join([
                json.dumps({"type": "event_msg", "payload": {"type": "task_started"}}),
                json.dumps({"type": "event_msg", "payload": {"type": "token_count"}}),
            ]))
            with patch.object(agents.CodexCli, "sessions_root", root):
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

    def test_failed_plain_slash_command_does_not_keep_the_spinner_running(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = self._transcript(directory, self._assistant({"type": "text", "text": "all done"}),
                                    self._user_text("/compact"),
                                    {"type": "system", "subtype": "local_command", "content": "limit reached"})
            self.assertFalse(AgentSessionTracker().claude_session_is_active(path))

    def test_running_compaction_keeps_the_spinner_running(self) -> None:
        # A compaction in flight writes NOTHING else: no OSC title updates and no transcript appends
        # between the command and the summary it finishes with. The command with no result after it is
        # therefore the only evidence the tab is still working.
        with tempfile.TemporaryDirectory() as directory:
            command = self._user_text("<command-name>/compact</command-name>")
            command["timestamp"] = datetime.now(timezone.utc).isoformat()
            path = self._transcript(directory, self._assistant({"type": "text", "text": "all done"}), command)
            self.assertTrue(AgentSessionTracker().claude_session_is_active(path))

    def test_stale_compaction_stops_the_spinner(self) -> None:
        # Bounded, so a compaction that died without writing its result leaves the tab idle instead of
        # spinning for the life of the session -- the failure isCompactSummary once caused.
        with tempfile.TemporaryDirectory() as directory:
            command = self._user_text("<command-name>/compact</command-name>")
            command["timestamp"] = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
            path = self._transcript(directory, self._assistant({"type": "text", "text": "all done"}), command)
            self.assertFalse(AgentSessionTracker().claude_session_is_active(path))

    def test_finished_compaction_summary_stops_the_spinner(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            command = self._user_text("<command-name>/compact</command-name>")
            command["timestamp"] = datetime.now(timezone.utc).isoformat()
            summary = self._user_text("This session is being continued from a previous conversation...")
            summary["isCompactSummary"] = True
            path = self._transcript(directory, self._assistant({"type": "text", "text": "all done"}),
                                    command, summary,
                                    {"type": "system", "subtype": "local_command", "content": "done"})
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
            with patch.object(agents.AgyCli, "sessions_root", Path(directory)):
                self.assertTrue(AgentSessionTracker().agy_session_is_active(session_id))

    def test_content_event_without_thinking_marks_session_as_inactive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session_id = "6f1f1f5a-9dfd-4a65-bc2f-9b0b8f5f4d77"
            self._transcript(directory, session_id,
                             {"type": "USER_INPUT", "source": "USER_EXPLICIT",
                              "content": "<USER_REQUEST>run diagnostics</USER_REQUEST>"},
                             {"type": "AGENT_RESPONSE", "content": "<AGENT_RESPONSE>done</AGENT_RESPONSE>"})
            with patch.object(agents.AgyCli, "sessions_root", Path(directory)):
                self.assertFalse(AgentSessionTracker().agy_session_is_active(session_id))

    def test_in_progress_status_marks_session_as_active(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session_id = "e6f1f8b4-8c5d-4bbd-b3f7-21fbd7fdc11f"
            self._transcript(directory, session_id,
                             {"type": "PLANNER_RESPONSE", "source": "MODEL", "status": "IN_PROGRESS",
                              "content": "Thinking about file matches."})
            with patch.object(agents.AgyCli, "sessions_root", Path(directory)):
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
            with patch.object(agents.AgyCli, "sessions_root", Path(directory)):
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
                 proc_tree_probe({str(socket): [101]}, [process_row(101)]):
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
                 proc_tree_probe({"/elsewhere/other.sock": [7]}, [process_row(7)]):
                await manager.startup_respawn_saved_sessions()
            self.assertFalse(socket.exists())
        session = manager._sessions[saved.session_id]
        self.assertFalse(session.running)
        self.assertTrue(session.dormant)

    async def test_startup_reconciles_every_session_from_one_process_sample(self) -> None:
        # lsof costs the same whether it is asked about one socket or all of them, and the whole sweep
        # runs before uvicorn binds the port — so the probe count must not grow with the session count.
        manager = TerminalSessionManager()
        live_shell, dead_shell = record("live-shell"), record("dead-shell")
        live_claude = record("live-claude")
        live_claude.agent_kind = "claude"
        saved = [live_shell, dead_shell, live_claude]
        manager._store.load_all = lambda: saved  # type: ignore[method-assign]
        with tempfile.TemporaryDirectory() as directory:
            sockets = {item.session_id: Path(directory) / f"{item.session_id}.sock" for item in saved}
            for socket in sockets.values():
                socket.touch()
            holders = {str(sockets["live-shell"]): [101], str(sockets["live-claude"]): [201]}
            processes = [process_row(101), process_row(201, command="claude --resume " + "a" * 8)]
            with patch.object(manager, "_dtach_socket", side_effect=lambda session_id: sockets[session_id]), \
                 proc_tree_probe(holders, processes) as probes:
                await manager.startup_respawn_saved_sessions()
            self.assertFalse(sockets["dead-shell"].exists())
            self.assertTrue(sockets["live-shell"].exists())

        self.assertEqual(probes.socket_probes.await_count, 1)
        self.assertEqual(probes.process_probes.await_count, 1)
        self.assertTrue(manager._sessions["live-shell"].detached_live)
        self.assertTrue(manager._sessions["live-claude"].detached_live)
        self.assertFalse(manager._sessions["dead-shell"].detached_live)

    async def test_startup_keeps_sockets_when_the_process_probe_returns_nothing(self) -> None:
        # An lsof that timed out reports no holders for anything; unlinking on that would orphan every
        # live terminal at once.
        manager = TerminalSessionManager()
        saved = record()
        manager._store.load_all = lambda: [saved]  # type: ignore[method-assign]
        with tempfile.TemporaryDirectory() as directory:
            socket = Path(directory) / "abc123.sock"
            socket.touch()
            with patch.object(manager, "_dtach_socket", return_value=socket), \
                 proc_tree_probe({}, []):
                await manager.startup_respawn_saved_sessions()
            self.assertTrue(socket.exists())
        self.assertFalse(manager._sessions[saved.session_id].detached_live)

    async def test_active_shell_and_claude_replays_are_checkpointed_without_codex_or_agy(self) -> None:
        manager = TerminalSessionManager()
        shell = ManagedSession(record("checkpoint-shell"))
        claude_record = record("checkpoint-claude")
        claude_record.agent_kind = "claude"
        claude = ManagedSession(claude_record)
        codex_record = record("checkpoint-codex")
        codex_record.agent_kind = "codex"
        codex = ManagedSession(codex_record)
        agy_record = record("checkpoint-agy")
        agy_record.agent_kind = "agy"
        agy = ManagedSession(agy_record)
        for session in (shell, claude, codex, agy):
            session.detached_live = True
            manager._sessions[session.record.session_id] = session
            manager._append_collapsing_repaints(session, f"{session.record.session_id}\n".encode())
        manager.replay.record_output(claude, b"\x1b[Hclaude replay\n")

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(TermdeckConfig, "SCROLLBACK_DIR", Path(directory)):
            await manager.replay._checkpoint_active()
            self.assertEqual((Path(directory) / "checkpoint-shell.bin").read_bytes(), b"checkpoint-shell\n")
            self.assertTrue((Path(directory) / "checkpoint-claude.claude-replay.bin").exists())
            self.assertFalse((Path(directory) / "checkpoint-claude.bin").exists())
            self.assertFalse((Path(directory) / "checkpoint-codex.bin").exists())
            self.assertFalse((Path(directory) / "checkpoint-agy.bin").exists())

    async def test_inactive_shell_replay_is_not_checkpointed(self) -> None:
        manager = TerminalSessionManager()
        shell = ManagedSession(record("inactive-shell"))
        manager._sessions[shell.record.session_id] = shell
        manager._append_collapsing_repaints(shell, b"not running\n")

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(TermdeckConfig, "SCROLLBACK_DIR", Path(directory)):
            await manager.replay._checkpoint_active()
            self.assertFalse((Path(directory) / "inactive-shell.bin").exists())

    async def test_shell_checkpoint_appends_only_new_output_until_its_byte_limit(self) -> None:
        manager = TerminalSessionManager()
        shell = ManagedSession(record("append-shell"))
        shell.detached_live = True
        manager._sessions[shell.record.session_id] = shell

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(TermdeckConfig, "SCROLLBACK_DIR", Path(directory)), \
                patch.object(TermdeckConfig, "SCROLLBACK_BYTES", 12):
            manager._append_collapsing_repaints(shell, b"12345678")
            await manager.replay._checkpoint_active()
            checkpoint = Path(directory) / "append-shell.bin"
            self.assertEqual(checkpoint.read_bytes(), b"12345678")

            with patch.object(manager.replay, "_write_checkpoint_atomically",
                              wraps=manager.replay._write_checkpoint_atomically) as replace_checkpoint, \
                    patch.object(manager.replay, "_append_checkpoint_bytes",
                                 wraps=manager.replay._append_checkpoint_bytes) as append_checkpoint:
                manager._append_collapsing_repaints(shell, b"abcd")
                await manager.replay._checkpoint_active()
                replace_checkpoint.assert_not_called()
                append_checkpoint.assert_called_once_with(checkpoint, b"abcd")
            self.assertEqual(checkpoint.read_bytes(), b"12345678abcd")

            manager._append_collapsing_repaints(shell, b"efgh")
            await manager.replay._checkpoint_active()
            self.assertEqual(checkpoint.read_bytes(), b"5678abcdefgh")
            self.assertEqual(checkpoint.stat().st_size, 12)

    async def test_claude_checkpoint_appends_only_new_raw_output(self) -> None:
        manager = TerminalSessionManager()
        claude_record = record("append-claude")
        claude_record.agent_kind = "claude"
        claude = ManagedSession(claude_record)
        claude.detached_live = True
        manager._sessions[claude.record.session_id] = claude

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(TermdeckConfig, "SCROLLBACK_DIR", Path(directory)):
            manager.replay.record_output(claude, b"first frame\n")
            await manager.replay._checkpoint_active()
            checkpoint = Path(directory) / "append-claude.claude-replay.bin"
            self.assertEqual(checkpoint.read_bytes(), b"first frame\n")

            with patch.object(manager.replay, "_write_checkpoint_atomically",
                              wraps=manager.replay._write_checkpoint_atomically) as replace_checkpoint, \
                    patch.object(manager.replay, "_append_checkpoint_bytes",
                                 wraps=manager.replay._append_checkpoint_bytes) as append_checkpoint:
                manager.replay.record_output(claude, b"second frame\n")
                await manager.replay._checkpoint_active()
                replace_checkpoint.assert_not_called()
                append_checkpoint.assert_called_once_with(checkpoint, b"second frame\n")
            self.assertEqual(checkpoint.read_bytes(), b"first frame\nsecond frame\n")

    async def test_startup_reuses_shell_and_claude_checkpoints_without_consuming_them(self) -> None:
        manager = TerminalSessionManager()
        shell_record = record("restore-shell")
        claude_record = record("restore-claude")
        claude_record.agent_kind = "claude"
        manager._store.load_all = lambda: [shell_record, claude_record]  # type: ignore[method-assign]

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(TermdeckConfig, "SCROLLBACK_DIR", Path(directory)):
            shell_path = Path(directory) / "restore-shell.bin"
            claude_path = Path(directory) / "restore-claude.claude-replay.bin"
            shell_path.write_bytes(b"shell history\n")
            claude_path.write_bytes(b"\x1b[Hclaude history\n")
            await manager.startup_respawn_saved_sessions()
            self.assertEqual(bytes(manager._sessions["restore-shell"].buffer), b"shell history\n")
            self.assertEqual(bytes(manager._sessions["restore-claude"].raw_replay_buffer),
                             b"\x1b[Hclaude history\n")
            self.assertTrue(shell_path.exists())
            self.assertTrue(claude_path.exists())

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

    async def test_attaching_client_resizes_a_tui_to_repaint_its_stripped_screen(self) -> None:
        manager, session, proc = self._session_whose_screen_was_stripped()

        with patch.object(TermdeckConfig, "SCREEN_REPAINT_CLIENT_ATTACH_DELAY_SECONDS", 0):
            manager.attach_client(session.record.session_id)
            await session.screen_repaint_task

        self.assertEqual(proc.resize_calls, [(119, 32), (120, 32)])

    async def test_attaching_client_keeps_repaint_resize_when_output_arrives_during_the_delay(self) -> None:
        manager, session, proc = self._session_whose_screen_was_stripped()

        with patch.object(TermdeckConfig, "SCREEN_REPAINT_CLIENT_ATTACH_DELAY_SECONDS", 0):
            manager.attach_client(session.record.session_id)
            session.last_activity_at += 1
            await session.screen_repaint_task

        self.assertEqual(proc.resize_calls, [(119, 32), (120, 32)])

    async def test_attaching_client_does_not_signal_a_shell_whose_scrollback_replays_the_screen(self) -> None:
        manager, session, proc = self._session_whose_screen_was_stripped()
        session.screen_lives_only_in_stripped_sync_frames = False
        session.buffer.extend(b"prompt$ ls\nfile.txt\n")

        manager.attach_client(session.record.session_id)

        self.assertIsNone(session.screen_repaint_task)
        self.assertEqual(proc.resize_calls, [])

    async def test_attaching_client_signals_when_the_server_has_no_scrollback_to_replay(self) -> None:
        manager, session, proc = self._session_whose_screen_was_stripped()
        session.screen_lives_only_in_stripped_sync_frames = False

        with patch.object(TermdeckConfig, "SCREEN_REPAINT_CLIENT_ATTACH_DELAY_SECONDS", 0):
            manager.attach_client(session.record.session_id)
            await session.screen_repaint_task

        self.assertEqual(proc.resize_calls, [(119, 32), (120, 32)])

    async def test_explicit_codex_repaint_resizes_the_live_pty(self) -> None:
        manager, session, proc = self._session_whose_screen_was_stripped()
        session.record.agent_kind = "codex"

        self.assertTrue(manager.request_screen_repaint(session.record.session_id))
        await session.screen_repaint_task

        self.assertEqual(proc.resize_calls, [(119, 32), (120, 32)])

    def _session_whose_screen_was_stripped(self):
        class FakeProc:
            alive = True

            def __init__(self) -> None:
                self.resize_calls: list[tuple[int, int]] = []

            def resize(self, cols: int, rows: int) -> None:
                self.resize_calls.append((cols, rows))

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
        saved.agent_kind = "codex"
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
    def setUp(self) -> None:
        # These tests mock the whole manager; the model-dependency probe is the one place a
        # real PATH scan leaks in, and CI runners don't have the agent CLIs installed.
        patcher = patch("termdeck.environment_check.EnvironmentCheck.missing_model_dependency",
                        return_value=None)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def test_terminal_websocket_repaint_requests_server_pty_redraw(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        websocket = MagicMock()
        websocket.receive_text = AsyncMock(side_effect=[json.dumps({"type": "repaint"}), WebSocketDisconnect()])

        await server._pump_client_to_pty(websocket, "codex-session")

        server.manager.request_screen_repaint.assert_called_once_with("codex-session")

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

    async def test_transcript_prompt_directly_steers_busy_session_without_silent_tui_queue(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.has_session.return_value = True
        server.manager.session_summary_by_id.return_value = {"processing": True, "session_id": "busy-01"}
        server.manager.submit_prompt = AsyncMock()

        response = await server._submit_prompt("busy-01", SubmitPromptRequest(
            text="run this next", automatically_queue_when_busy=False))

        server.manager.submit_prompt.assert_awaited_once_with("busy-01", "run this next", True, False)
        self.assertTrue(response["prompt_submitted"])
        self.assertFalse(response["queued"])

    async def test_transcript_interrupt_uses_agent_interrupt_input_without_stopping_terminal(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.has_session.return_value = True
        server.manager.session_summary_by_id.return_value = {
            "processing": False, "session_id": "busy-01", "agent_kind": "codex"}

        response = await server._interrupt_session("busy-01")

        server.manager.ensure_session_running.assert_called_once_with("busy-01")
        server.manager.write_input.assert_called_once_with("busy-01", "\x1b")
        server.manager.stop_session.assert_not_called()
        self.assertFalse(response["processing"])

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


class ReplayTitleCollapseTest(unittest.TestCase):
    """The attach replay collapses OSC title churn to the final title (a spinner rewrites the title
    thousands of times; replaying each one made the client apply each in turn -- measured as 5.9s of a
    6s load on a real training session)."""

    @staticmethod
    def _replay(buffer: bytes) -> bytes:
        ms = MagicMock()
        ms.buffer = bytearray(buffer)
        return ReplayRecorder(None).replay_bytes(ms)

    def test_title_spam_collapses_to_the_final_title(self) -> None:
        spam = b"".join(b"\x1b]0;spin %d\x07" % n for n in range(500))
        replay = self._replay(b"line one\n" + spam + b"line two\n")
        self.assertEqual(replay.count(b"\x1b]0;"), 1)
        self.assertTrue(replay.endswith(b"\x1b]0;spin 499\x07"))
        self.assertIn(b"line one\n", replay)
        self.assertIn(b"line two\n", replay)

    def test_st_terminated_and_icon_titles_collapse_too(self) -> None:
        replay = self._replay(b"\x1b]2;a\x1b\\middle\x1b]1;b\x07\x1b]0;last\x1b\\")
        self.assertEqual(replay, b"middle\x1b]0;last\x1b\\")

    def test_stream_without_titles_is_untouched(self) -> None:
        data = b"plain output\x1b[31mcolored\x1b[0m\n"
        self.assertEqual(self._replay(data), data)

    def test_unterminated_tail_title_is_left_for_the_live_stream(self) -> None:
        replay = self._replay(b"\x1b]0;done\x07content\x1b]0;partial")
        self.assertTrue(replay.startswith(b"content\x1b]0;partial"))
        self.assertTrue(replay.endswith(b"\x1b]0;done\x07"))


class ClaudeActivityDetailTest(unittest.TestCase):
    def _session(self, session_id, interrupted=False):
        from types import SimpleNamespace
        claude = agents.agent_cli("claude")
        ms = SimpleNamespace(record=SimpleNamespace(agent_session_id=session_id,
                                                    claude_interrupted=interrupted),
                             agent_state=claude.new_session_state())
        return claude, ms

    def test_detail_reports_main_and_active_subagent_count(self) -> None:
        claude, ms = self._session("abc")
        ms.agent_state.main_active = False
        ms.agent_state.subagent_states = {Path("/a"): True, Path("/b"): True, Path("/c"): False}
        self.assertEqual(claude.activity_detail(ms), {"main": False, "subagents": 2, "background_jobs": 0, "monitors": 0})
        ms.agent_state.main_active = True
        ms.agent_state.background_tasks = {"b1": "/tmp/b1.output"}
        self.assertEqual(claude.activity_detail(ms), {"main": True, "subagents": 2, "background_jobs": 1, "monitors": 0})

    def test_detail_is_none_before_binding_and_main_false_when_interrupted(self) -> None:
        claude, ms = self._session(None)
        self.assertIsNone(claude.activity_detail(ms))
        claude, ms = self._session("abc", interrupted=True)
        ms.agent_state.main_active = True
        self.assertEqual(claude.activity_detail(ms), {"main": False, "subagents": 0, "background_jobs": 0, "monitors": 0})


class ClaudeBackgroundTaskScanTest(unittest.TestCase):
    def setUp(self) -> None:
        self.claude = agents.agent_cli("claude")
        self.state = self.claude.new_session_state()
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.parent = Path(self.dir.name) / "session.jsonl"
        self.parent.write_text("")

    def _output_path(self, task_id, running=True):
        path = Path(self.dir.name) / f"{task_id}.output"
        path.write_text("some output\n" + ("" if running else "\n[exited with code 0]\n"))
        return str(path)

    def _append(self, *lines):
        with self.parent.open("a") as fh:
            for line in lines:
                fh.write(line + "\n")

    def _launch(self, task_id, output):
        text = (f"Command running in background with ID: {task_id}. Output is being written to: "
                f"{output}. You will be notified when it completes.")
        return json.dumps({"type": "user", "message": {"role": "user", "content": [
            {"tool_use_id": "t1", "type": "tool_result", "content": text}]}})

    def _notification(self, task_id):
        return json.dumps({"type": "user", "message": {"role": "user", "content":
            f"<task-notification>\n<task-id>{task_id}</task-id>\n<status>completed</status>\n</task-notification>"}})

    def _task_stop(self, task_id):
        return json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [
            {"type": "tool_use", "name": "TaskStop", "input": {"task_id": task_id}}]}})

    def test_incremental_launch_then_notification(self) -> None:
        self._append(self._launch("job1", self._output_path("job1")))
        self.assertTrue(self.claude.scan_background_tasks(self.state, self.parent))
        self.assertEqual(set(self.state.background_tasks), {"job1"})
        self.assertFalse(self.claude.scan_background_tasks(self.state, self.parent))  # nothing appended
        self._append(self._notification("job1"))
        self.assertTrue(self.claude.scan_background_tasks(self.state, self.parent))
        self.assertEqual(self.state.background_tasks, {})

    def test_task_stop_removes_and_quotes_do_not_launch(self) -> None:
        quoted = json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [
            {"type": "text", "text": "it said Command running in background with ID: ghost."}]}})
        self._append(self._launch("job2", self._output_path("job2")), quoted)
        self.claude.scan_background_tasks(self.state, self.parent)
        self.assertEqual(set(self.state.background_tasks), {"job2"})
        self._append(self._task_stop("job2"))
        self.assertTrue(self.claude.scan_background_tasks(self.state, self.parent))
        self.assertEqual(self.state.background_tasks, {})

    def test_full_scan_verifies_output_files(self) -> None:
        self._append(self._launch("live", self._output_path("live", running=True)),
                     self._launch("dead", self._output_path("dead", running=False)),
                     self._launch("gone", str(Path(self.dir.name) / "missing.output")),
                     self._launch("told", self._output_path("told", running=True)),
                     self._notification("told"))
        self.assertTrue(self.claude.scan_background_tasks(self.state, self.parent))
        self.assertEqual(set(self.state.background_tasks), {"live"})

    def test_partial_last_line_is_deferred_until_newline(self) -> None:
        line = self._launch("job3", self._output_path("job3"))
        with self.parent.open("a") as fh:
            fh.write(line[:40])
        self.claude.scan_background_tasks(self.state, self.parent)
        self.assertEqual(self.state.background_tasks, {})
        with self.parent.open("a") as fh:
            fh.write(line[40:] + "\n")
        self.assertTrue(self.claude.scan_background_tasks(self.state, self.parent))
        self.assertEqual(set(self.state.background_tasks), {"job3"})

    def test_killed_marker_ends_task_without_notification(self) -> None:
        output = self._output_path("job4")
        self._append(self._launch("job4", output))
        self.claude.scan_background_tasks(self.state, self.parent)
        self.assertEqual(set(self.state.background_tasks), {"job4"})
        Path(output).write_text("partial output\n[killed]\n")
        self._append(json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [
            {"type": "text", "text": "unrelated turn"}]}}))
        self.assertTrue(self.claude.scan_background_tasks(self.state, self.parent))
        self.assertEqual(self.state.background_tasks, {})

    def test_monitor_event_notification_does_not_end_task(self) -> None:
        self._append(self._launch("job5", self._output_path("job5")))
        self.claude.scan_background_tasks(self.state, self.parent)
        event_notification = json.dumps({"type": "queue-operation", "operation": "enqueue", "content":
            "<task-notification>\n<task-id>job5</task-id>\n<summary>Monitor event: \"x\"</summary>\n<event>line</event>\n</task-notification>"})
        self._append(event_notification)
        self.assertFalse(self.claude.scan_background_tasks(self.state, self.parent))
        self.assertEqual(set(self.state.background_tasks), {"job5"})

    def test_queue_operation_terminal_notification_ends_task(self) -> None:
        self._append(self._launch("job6", self._output_path("job6")))
        self.claude.scan_background_tasks(self.state, self.parent)
        terminal = json.dumps({"type": "queue-operation", "operation": "enqueue", "content":
            "<task-notification>\n<task-id>job6</task-id>\n<status>completed</status>\n</task-notification>"})
        self._append(terminal)
        self.assertTrue(self.claude.scan_background_tasks(self.state, self.parent))
        self.assertEqual(self.state.background_tasks, {})

    def _monitor_launch(self, task_id):
        text = (f"Monitor started (task {task_id}, persistent — runs until TaskStop or session end). "
                "You will be notified on each event.")
        return json.dumps({"type": "user", "message": {"role": "user", "content": [
            {"tool_use_id": "t2", "type": "tool_result", "content": text}]}})

    def test_monitor_tracked_until_output_end_marker(self) -> None:
        from unittest.mock import patch
        output = Path(self._output_path("mon1"))
        with patch.object(type(self.claude), "_task_output_path", staticmethod(lambda parent, task_id: output)):
            self._append(self._monitor_launch("mon1"))
            self.assertTrue(self.claude.scan_background_tasks(self.state, self.parent))
            self.assertEqual(set(self.state.monitor_tasks), {"mon1"})
            self.assertEqual(self.state.background_tasks, {})
            event = json.dumps({"type": "queue-operation", "operation": "enqueue", "content":
                "<task-notification>\n<task-id>mon1</task-id>\n<summary>Monitor event: \"x\"</summary>\n</task-notification>"})
            self._append(event)
            self.assertFalse(self.claude.scan_background_tasks(self.state, self.parent))
            self.assertEqual(set(self.state.monitor_tasks), {"mon1"})
            output.write_text("events...\n[exited with code 0]\n")
            self._append(json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [
                {"type": "text", "text": "later turn"}]}}))
            self.assertTrue(self.claude.scan_background_tasks(self.state, self.parent))
            self.assertEqual(self.state.monitor_tasks, {})

    def test_task_stop_removes_monitor(self) -> None:
        from unittest.mock import patch
        output = Path(self._output_path("mon2"))
        with patch.object(type(self.claude), "_task_output_path", staticmethod(lambda parent, task_id: output)):
            self._append(self._monitor_launch("mon2"))
            self.claude.scan_background_tasks(self.state, self.parent)
            self._append(self._task_stop("mon2"))
            self.assertTrue(self.claude.scan_background_tasks(self.state, self.parent))
            self.assertEqual(self.state.monitor_tasks, {})

    def test_task_output_path_derivation(self) -> None:
        import os
        parent = Path("/Users/x/.claude/projects/-Users-x-proj/abcd-1234.jsonl")
        self.assertEqual(self.claude._task_output_path(parent, "tid9"),
                         Path(f"/tmp/claude-{os.getuid()}/-Users-x-proj/abcd-1234/tasks/tid9.output"))


class ClaudeAttentionFromOutputTest(unittest.TestCase):
    """Claude's waiting-on-you prompts, as they actually arrive on the wire.

    These boxes are laid out with cursor-movement escapes rather than literal spaces, so once the
    escapes are stripped the footer's words run together. Matching has to survive that; the fixtures
    below are written in the run-together form a live session produced.
    """

    def setUp(self) -> None:
        self.claude = ClaudeCli()
        self.manager = TerminalSessionManager.__new__(TerminalSessionManager)
        self.ms = ManagedSession(record())
        self.ms.record.agent_kind = "claude"

    def _feed(self, screen: str) -> bool:
        return self.claude.update_attention_from_output(self.manager, self.ms, screen.encode())

    def test_question_prompt_raises_attention(self) -> None:
        self.assertTrue(self._feed("1.weeklyonly 2.fullhybrid entertoselect·↑/↓tonavigate·esctocancel"))
        self.assertTrue(self.ms.attention_required)

    def test_plan_approval_raises_attention(self) -> None:
        self.assertTrue(self._feed("wouldyouliketoproceed? esctocancel tabtoamend"))
        self.assertTrue(self.ms.attention_required)

    def test_spaced_rendering_still_raises_attention(self) -> None:
        self.assertTrue(self._feed("Enter to select · Esc to cancel"))
        self.assertTrue(self.ms.attention_required)

    def test_ordinary_output_does_not_raise_attention(self) -> None:
        self.assertFalse(self._feed("running tests... 134 passed. esc to interrupt"))
        self.assertFalse(self.ms.attention_required)

    def test_marker_split_across_writes_still_matches(self) -> None:
        self.assertFalse(self._feed("choose one: enterto"))
        self.assertTrue(self._feed("select·esctocancel"))
        self.assertTrue(self.ms.attention_required)


class ClaudeAttentionReArmTest(unittest.TestCase):
    """A prompt stays on screen after it is answered, and every repaint re-sends it.

    That is what turned the badge into a strobe: a keystroke clears attention, the repaint that same
    keystroke causes re-detects it, and the badge restarts its animation per character typed.
    """

    def setUp(self) -> None:
        self.claude = ClaudeCli()
        self.manager = TerminalSessionManager.__new__(TerminalSessionManager)
        self.ms = ManagedSession(record())
        self.ms.record.agent_kind = "claude"
        self.footer = "entertoselect·esctocancel"

    def _feed(self, screen: str) -> bool:
        return self.claude.update_attention_from_output(self.manager, self.ms, screen.encode())

    def test_repaint_of_an_answered_prompt_does_not_re_arm(self) -> None:
        self.assertTrue(self._feed(f"pick one {self.footer}"))
        # The user answers: input clears the flag and the carry, exactly as write_input does.
        self.ms.attention_required = False
        self.ms.attention_text_carry = ""
        self.ms.last_typing_monotonic = 0.0
        # The answered prompt is still on screen, but this write only carries the tail of it.
        self.assertFalse(self._feed("thinking..."))
        self.assertFalse(self.ms.attention_required)

    def test_typing_at_a_live_prompt_does_not_re_arm(self) -> None:
        self.ms.last_typing_monotonic = time.monotonic()
        self.assertFalse(self._feed(f"pick one {self.footer}"))
        self.assertFalse(self.ms.attention_required)

    def test_prompt_arriving_after_the_user_stopped_typing_still_arms(self) -> None:
        self.ms.last_typing_monotonic = time.monotonic() - (self.claude.ATTENTION_TYPING_QUIET_SECONDS + 1)
        self.assertTrue(self._feed(f"pick one {self.footer}"))
        self.assertTrue(self.ms.attention_required)


class TerminalInputClassificationTest(unittest.TestCase):
    """A terminal's input channel carries more than keystrokes.

    xterm answers device-attribute and cursor-position queries, reports focus changes and mouse moves
    through the same path the user's typing takes. Treating those as typing silently dismissed waiting
    prompts and, keyed the other way, suppressed the attention badge outright: the channel never went
    quiet, so "the user is typing right now" was permanently true.
    """

    def _typing(self, text: str) -> bool:
        return TerminalSessionManager._input_is_user_typing(text)

    def test_keystrokes_count_as_typing(self) -> None:
        for text in ("a", "hello\r", "\r", "\x03", "\x7f", "\x1b"):
            self.assertTrue(self._typing(text), text)

    def test_arrow_keys_count_as_typing(self) -> None:
        # Navigating a question prompt is interaction; only the terminal's own replies are not.
        for text in ("\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D"):
            self.assertTrue(self._typing(text), text)

    def test_terminal_replies_do_not_count_as_typing(self) -> None:
        for text in ("\x1b[I", "\x1b[O", "\x1b[0n", "\x1b[?1;2c", "\x1b[>0;276;0c",
                     "\x1b[24;80R", "\x1b[<0;10;5M", "\x1b]11;rgb:1e/22/2e\x07"):
            self.assertFalse(self._typing(text), text)

    def test_a_keystroke_mixed_with_a_reply_still_counts(self) -> None:
        self.assertTrue(self._typing("\x1b[I" + "y"))


class AttentionDismissalTest(unittest.TestCase):
    """What actually takes a badge down.

    A question stays outstanding while you arrow through its options or type an answer into it: it is
    answered by Enter, abandoned by Escape, or killed by Ctrl-C. Clearing on every keystroke removed the
    badge the moment an arrow key was pressed, and -- because the prompt is still on screen -- the next
    repaint re-armed it, restarting the animation on every key.
    """

    def _dismisses(self, text: str) -> bool:
        return TerminalSessionManager._input_dismisses_attention(text)

    def test_answering_dismisses(self) -> None:
        for text in ("\r", "\n", "3\r", "\x03", "\x04", "\x1b"):
            self.assertTrue(self._dismisses(text), repr(text))

    def test_navigating_or_typing_does_not_dismiss(self) -> None:
        for text in ("\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", "y", "hello", "\x7f"):
            self.assertFalse(self._dismisses(text), repr(text))

    def test_terminal_replies_do_not_dismiss(self) -> None:
        for text in ("\x1b[I", "\x1b[O", "\x1b[0n", "\x1b[24;80R", "\x1b[<0;10;5M"):
            self.assertFalse(self._dismisses(text), repr(text))


class ClaudeCancelClearsProcessingTest(unittest.TestCase):
    """Escape cancels a Claude turn the same way Ctrl-C does.

    Only Ctrl-C used to count, so a prompt cancelled with Escape left the tab spinning indefinitely:
    the last transcript event is the user's prompt with nothing after it, Claude writes no interruption
    marker when it never started answering, and the activity scan reads a trailing user prompt as work
    in progress.
    """

    def setUp(self) -> None:
        self.claude = ClaudeCli()
        self.manager = TerminalSessionManager.__new__(TerminalSessionManager)
        self.manager._sync_processing_started = lambda *a, **k: None
        self.manager._broadcast_status = lambda *a, **k: None
        self.manager._persist = lambda *a, **k: None
        # agent_state is built from the record's kind at construction, so the kind has to be set first.
        claude_record = record()
        claude_record.agent_kind = "claude"
        self.ms = ManagedSession(claude_record)
        self.ms.agent_state.main_active = True

    def _send(self, text: str) -> None:
        self.claude.pre_write_input(self.manager, self.ms, text, "")

    def test_escape_marks_the_turn_interrupted(self) -> None:
        self._send("\x1b")
        self.assertTrue(self.ms.record.claude_interrupted)
        self.assertFalse(self.ms.agent_state.main_active)

    def test_ctrl_c_still_marks_the_turn_interrupted(self) -> None:
        self._send("\x03")
        self.assertTrue(self.ms.record.claude_interrupted)

    def test_arrow_keys_do_not_interrupt(self) -> None:
        for key in ("\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D"):
            self.ms.record.claude_interrupted = False
            self._send(key)
            self.assertFalse(self.ms.record.claude_interrupted, key)

    def test_typing_does_not_interrupt(self) -> None:
        self._send("hello")
        self.assertFalse(self.ms.record.claude_interrupted)


class ClaudeCompactionCompletionTest(unittest.TestCase):
    """A finished /compact must stop reading as work in progress.

    The two completion paths write different entries, which is what made this subtle: the refusal
    ("Not enough messages to compact.") writes a system/local_command event, while a SUCCESSFUL
    compaction writes its result as a user event carrying <local-command-stdout>. Matching only the
    system event left every successful compaction looking like one still running.
    """

    def _transcript(self, directory: str, *events: dict) -> Path:
        path = Path(directory) / "session.jsonl"
        path.write_text("".join(json.dumps(event) + "\n" for event in events))
        return path

    def _user(self, text: str, **extra) -> dict:
        return {"type": "user", "message": {"role": "user", "content": text},
                "timestamp": datetime.now(timezone.utc).isoformat(), **extra}

    def _assistant(self, *blocks: dict) -> dict:
        return {"type": "assistant", "message": {"type": "message", "role": "assistant", "content": list(blocks)}}

    def test_successful_compaction_reads_idle(self) -> None:
        # The real shape, taken from a session that was stuck on "running".
        with tempfile.TemporaryDirectory() as directory:
            path = self._transcript(
                directory,
                {"type": "system", "subtype": "compact_boundary"},
                self._user("This session is being continued from a previous conversation", isCompactSummary=True),
                self._user("<local-command-caveat>Caveat: ...</local-command-caveat>", isMeta=True),
                self._user("<command-name>/compact</command-name>"),
                self._user("<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>"),
                {"type": "attachment"}, {"type": "attachment"})
            self.assertFalse(AgentSessionTracker._claude_subagent_is_active(path))

    def test_compaction_in_flight_still_reads_active(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = self._transcript(
                directory,
                self._assistant({"type": "text", "text": "all done"}),
                self._user("<command-name>/compact</command-name>"))
            self.assertTrue(AgentSessionTracker._claude_subagent_is_active(path))

    def test_refused_compaction_reads_idle(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = self._transcript(
                directory,
                self._assistant({"type": "text", "text": "all done"}),
                self._user("<command-name>/compact</command-name>"),
                {"type": "system", "subtype": "local_command",
                 "content": "<local-command-stdout>Not enough messages to compact.</local-command-stdout>"})
            self.assertFalse(AgentSessionTracker._claude_subagent_is_active(path))


class ReplayTrailingWipeTest(unittest.TestCase):
    """A recording that ends with a TUI's clear must not be replayed as a blank screen."""

    def _session(self, raw: bytes):
        return SimpleNamespace(raw_replay_buffer=bytearray(raw), raw_replay_last_title=b"",
                               buffer=bytearray(raw))

    def test_orphaned_clear_at_the_tail_is_dropped(self) -> None:
        # The exact shape recorded from a live session whose server restarted mid-repaint:
        # claude's painted UI, then home + erase-to-end with the redraw never captured.
        painted = b"\x1b[H\x1b[Jconversation\r\n\xe2\x8f\xb5 composer here"
        served = ReplayRecorder.raw_bytes(self._session(painted + b"\x1b[H\x1b[J"))
        self.assertEqual(served, painted)

    def test_repeated_orphaned_clears_are_all_dropped(self) -> None:
        painted = b"painted screen"
        served = ReplayRecorder.raw_bytes(self._session(painted + b"\x1b[H\x1b[J\x1b[H\x1b[J"))
        self.assertEqual(served, painted)

    def test_clear_that_still_has_a_redraw_after_it_is_kept(self) -> None:
        intact = b"old\x1b[H\x1b[Jnew screen\r\n> prompt"
        self.assertEqual(ReplayRecorder.raw_bytes(self._session(intact)), intact)

    def test_only_the_tail_is_scanned_so_a_large_buffer_is_cheap(self) -> None:
        # A wipe further back than the scan window is left alone: it is history, not the screen.
        buried = b"x" * (ReplayRecorder.TRAILING_WIPE_SCAN_BYTES * 4) + b"\x1b[H\x1b[J" + b"y" * 500
        self.assertEqual(ReplayRecorder.raw_bytes(self._session(buried)), buried)

    def test_empty_recording_is_unchanged(self) -> None:
        self.assertEqual(ReplayRecorder.raw_bytes(self._session(b"")), b"")


class ClaudeInterruptReleaseTest(unittest.TestCase):
    """Esc suppresses a cancelled prompt, but must not latch past work that resumes after it."""

    def _session(self, transcript, interrupted_at):
        claude = agents.agent_cli("claude")
        ms = SimpleNamespace(
            record=SimpleNamespace(claude_interrupted=True, agent_session_id="abc", cwd="/tmp"),
            agent_state=claude.new_session_state())
        ms.agent_state.interrupted_at = interrupted_at
        return claude, ms

    def test_cancelled_prompt_stays_suppressed(self) -> None:
        # Nothing was written after the interrupt: the trailing user prompt is the cancelled one.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "abc.jsonl"
            path.write_text("{}\n")
            claude, ms = self._session(path, time.time() + 60)  # transcript older than the interrupt
            claude.release_interrupt_if_work_resumed(ms, path, True)
            self.assertTrue(ms.record.claude_interrupted)

    def test_work_that_starts_after_the_interrupt_clears_it(self) -> None:
        # Interrupting a busy Claude makes it cancel and start what was queued behind it.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "abc.jsonl"
            path.write_text("{}\n")
            claude, ms = self._session(path, time.time() - 60)  # transcript newer than the interrupt
            claude.release_interrupt_if_work_resumed(ms, path, True)
            self.assertFalse(ms.record.claude_interrupted)

    def test_idle_transcript_never_clears_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "abc.jsonl"
            path.write_text("{}\n")
            claude, ms = self._session(path, time.time() - 60)
            claude.release_interrupt_if_work_resumed(ms, path, False)  # not active
            self.assertTrue(ms.record.claude_interrupted)

    def test_missing_transcript_is_not_evidence(self) -> None:
        claude, ms = self._session(Path("/nonexistent/abc.jsonl"), time.time() - 60)
        claude.release_interrupt_if_work_resumed(ms, Path("/nonexistent/abc.jsonl"), True)
        self.assertTrue(ms.record.claude_interrupted)


class DismissAttentionTest(unittest.TestCase):
    """Ignoring an attention badge drops it without answering the prompt."""

    def _manager_with_attention(self, *, required=True, carry="esctocanceltabtoamend"):
        manager = TerminalSessionManager()
        session = ManagedSession(record())
        session.attention_required = required
        session.attention_text_carry = carry
        manager._sessions = {session.record.session_id: session}
        manager._broadcast_status = MagicMock()
        return manager, session

    def test_badge_and_carry_are_both_dropped(self) -> None:
        # The carry has to go too: the prompt stays on screen and every repaint re-sends it, so
        # matched text left behind would re-raise the badge on the next write.
        manager, session = self._manager_with_attention()
        manager.dismiss_attention(session.record.session_id)
        self.assertFalse(session.attention_required)
        self.assertEqual(session.attention_text_carry, "")
        manager._broadcast_status.assert_called_once()

    def test_dismissing_a_calm_terminal_broadcasts_nothing(self) -> None:
        manager, session = self._manager_with_attention(required=False, carry="")
        manager.dismiss_attention(session.record.session_id)
        manager._broadcast_status.assert_not_called()

    def test_carry_alone_still_counts_as_something_to_dismiss(self) -> None:
        manager, session = self._manager_with_attention(required=False)
        manager.dismiss_attention(session.record.session_id)
        self.assertEqual(session.attention_text_carry, "")
        manager._broadcast_status.assert_called_once()


class ProcessingRequiresALiveProcessTest(unittest.TestCase):
    """A terminal with no live process is not working, whatever its last signal said."""

    def _manager_with_session(self, kind="codex"):
        manager = TerminalSessionManager()
        saved = record()
        saved.agent_kind = kind
        session = ManagedSession(saved)
        # a spinner in the OSC title, refreshed just now: ms.processing is derived from these
        session.cli_title = "⠋ working"
        session.title_updated_monotonic = time.monotonic()
        session.agent_state = agents.agent_cli(kind).new_session_state()
        if hasattr(session.agent_state, "transcript_active"):
            session.agent_state.transcript_active = True
        manager._sessions = {saved.session_id: session}
        return manager, session

    def test_stopped_terminal_stops_reporting_work(self) -> None:
        manager, session = self._manager_with_session()
        session.proc = None
        session.detached_live = False              # the process is gone
        self.assertFalse(session.running)
        self.assertFalse(manager._processing_state(session))

    def test_detached_but_live_terminal_still_reports_work(self) -> None:
        # Nobody is attached, but the agent is still running under dtach and still working.
        manager, session = self._manager_with_session()
        session.proc = None
        session.detached_live = True
        self.assertTrue(session.running)
        self.assertTrue(manager._processing_state(session))

    def test_attached_running_terminal_still_reports_work(self) -> None:
        manager, session = self._manager_with_session()
        session.proc = SimpleNamespace(alive=True)
        session.detached_live = False
        self.assertTrue(manager._processing_state(session))


class ReleaseSessionGroupTest(unittest.TestCase):
    """Closing a terminal hands its group name to the archive and frees the assignment."""

    class Store:
        def __init__(self, payload):
            self.payload = payload

        def load(self):
            return json.loads(json.dumps(self.payload))

        def save(self, payload):
            self.payload = payload

    def _server(self, assignments, groups):
        server = TermdeckServer.__new__(TermdeckServer)
        server.settings_store = self.Store({"project_state": {
            "stock": {"session_groups": assignments, "terminal_groups": groups}}})
        return server

    def test_group_name_is_returned_and_assignment_released(self) -> None:
        server = self._server({"doomed": "g1", "kept": "g1"}, [{"id": "g1", "name": "cpcv"}])
        self.assertEqual(server._release_session_group("doomed"), "cpcv")
        stored = server.settings_store.payload["project_state"]["stock"]["session_groups"]
        self.assertNotIn("doomed", stored)
        self.assertEqual(stored.get("kept"), "g1", "other members stay in the group")

    def test_ungrouped_session_changes_nothing(self) -> None:
        server = self._server({"kept": "g1"}, [{"id": "g1", "name": "cpcv"}])
        before = server.settings_store.payload
        self.assertEqual(server._release_session_group("never-grouped"), "")
        self.assertIs(server.settings_store.payload, before, "no write when there was nothing to release")

    def test_assignment_is_released_even_when_the_group_has_no_name(self) -> None:
        server = self._server({"doomed": "g1"}, [{"id": "g1"}])
        self.assertEqual(server._release_session_group("doomed"), "")
        self.assertNotIn("doomed", server.settings_store.payload["project_state"]["stock"]["session_groups"])


class ColdAttachRepaintTest(unittest.TestCase):
    """Serving a raw replay leaves the repaint to the client, which orders it after the write."""

    def _manager(self):
        manager = TerminalSessionManager()
        saved = record()
        saved.agent_kind = "claude"
        session = ManagedSession(saved)
        session.raw_replay_buffer.extend(b"conversation so far\r\n> composer")
        manager._sessions = {saved.session_id: session}
        manager._schedule_screen_repaint = MagicMock()
        manager._recover_title_from_buffer = MagicMock()
        return manager, session

    def test_a_served_replay_does_not_also_repaint(self) -> None:
        # The client asks for its own repaint once it has written the replay, ordered against it
        # rather than racing it, so a second repaint from here would land mid-write.
        manager, session = self._manager()
        replay, _ = manager.attach_client(session.record.session_id, full_claude_raw_replay=True)
        self.assertTrue(replay, "the replay is still served")
        manager._schedule_screen_repaint.assert_not_called()


class SyncUpdateTailTest(unittest.TestCase):
    """A recording that stops inside a synchronized update must not leave the client mid-frame."""

    def test_unterminated_frame_is_detected(self) -> None:
        self.assertTrue(ReplayRecorder.ends_inside_sync_update(b"rows\x1b[?2026hhalf a frame"))

    def test_closed_frame_is_not(self) -> None:
        self.assertFalse(ReplayRecorder.ends_inside_sync_update(
            b"\x1b[?2026hframe\x1b[?2026lafter"))

    def test_stream_without_markers_is_not(self) -> None:
        # Claude emits none of these at all, so this must never fire for it.
        self.assertFalse(ReplayRecorder.ends_inside_sync_update(b"plain output\r\n> composer"))
        self.assertFalse(ReplayRecorder.ends_inside_sync_update(b""))
