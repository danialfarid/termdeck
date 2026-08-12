import asyncio
import json
import os
import re
import signal
import subprocess
import time
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from termdeck.config import TermdeckConfig
from termdeck.file_history_service import FileHistoryService
from termdeck.file_service import ProjectFileService
from termdeck.history_index import HistorySearchIndex
from termdeck.models import AgentKind, ApiFields, WsMessageFields
from termdeck.platform_paths import PlatformPaths
from termdeck.search_service import ProjectSearchService
from termdeck.session_manager import TerminalSessionManager
from termdeck.settings_store import UiSettingsStore
from termdeck.state_backup import StateBackupManager
from termdeck.stats_service import ResourceStatsService
from termdeck.transcript_service import TranscriptService


class CreateSessionRequest(BaseModel):
    command: str = ""
    cwd: str = ""
    title: str = ""
    project: str = ""
    model: str = ""
    model_name: str = ""
    permission: str = ""
    session_ref: str = ""
    after: str | None = None


class RunTerminalTaskRequest(BaseModel):
    model: str = "codex"
    permission: str = "default"
    model_name: str = ""
    title: str = ""
    cwd: str = ""
    project: str = ""
    prompt: str = ""
    command: str = ""
    output_path: str = ""
    session_ref: str = ""
    after: str | None = None
    origin_session: str = ""
    fork: bool = False
    write_back: bool = False
    bracketed: bool = True
    queue: bool = False


class ProjectRegistrationRequest(BaseModel):
    root: str
    name: str = ""


class SubmitPromptRequest(BaseModel):
    text: str
    bracketed: bool = True
    queue: bool = False


class FollowUpTaskPromptRequest(BaseModel):
    prompt: str
    bracketed: bool = True


class BatchTerminalSpec(BaseModel):
    name: str
    prompt: str | None = None
    cwd: str | None = None
    project: str | None = None
    model: str | None = None
    model_name: str | None = None
    permission: str | None = None
    session_ref: str | None = None
    bracketed: bool | None = None
    queue: bool | None = None
    after: str | None = None


class BatchTerminalsRequest(BaseModel):
    terminals: list[BatchTerminalSpec]
    prompt: str = ""
    cwd: str = ""
    project: str = ""
    model: str = "codex"
    model_name: str = ""
    permission: str = "default"
    bracketed: bool = True
    queue: bool = False
    after: str | None = None


class RenameSessionRequest(BaseModel):
    title: str


class MoveSessionProjectRequest(BaseModel):
    project: str


class RestartSessionRequest(BaseModel):
    permission: str = ""


class CloseSessionRequest(BaseModel):
    group_name: str = ""


class StateRecoveryRestoreRequest(BaseModel):
    snapshot: str


class ProjectStatePatch(BaseModel):
    active_session_id: str | None = None
    open_files: list[dict[str, str]] | None = None
    open_files_collapsed: bool | None = None
    recent_files_collapsed: bool | None = None
    session_order: list[str] | None = None
    # Legacy-only fields: the desktop client migrates saved pins into its
    # ordinary terminal layout, then clears them. New UI/API code has no pin action.
    pinned_sessions: list[str] | None = None
    pinned_groups: list[str] | None = None
    unread_sessions: list[str] | None = None
    terminal_groups: list[dict[str, str | bool]] | None = None
    session_groups: dict[str, str] | None = None
    terminal_layout: list[str] | None = None


class FileOpRequest(BaseModel):
    root: str
    path: str
    new_name: str = ""
    destination: str = ""


class FileWriteRequest(BaseModel):
    root: str
    path: str
    content: str


class FileCreateRequest(BaseModel):
    root: str
    path: str
    directory: bool = False


class FileHistoryRestoreRequest(BaseModel):
    root: str
    path: str
    version_id: int


class ReplaceRequest(BaseModel):
    root: str
    q: str
    glob: str = ""
    ignore: str = ""
    word: bool = False
    case_sensitive: bool = False
    regex: bool = False
    replacement: str = ""
    paths: list[str] = []


class NotebookTrashRequest(BaseModel):
    title: str
    content: str


class ProjectUiState(BaseModel):
    active_session_id: str = ""
    open_files: list[dict[str, str]] = []
    open_files_collapsed: bool = False
    recent_files_collapsed: bool = False
    session_order: list[str] = []
    # Retained solely so older settings files can be migrated by the client.
    pinned_sessions: list[str] = []
    pinned_groups: list[str] = []
    unread_sessions: list[str] = []
    terminal_groups: list[dict[str, str | bool]] = []
    session_groups: dict[str, str] = {}
    terminal_layout: list[str] = []


class NotebookNote(BaseModel):
    note_id: str
    text: str = ""


class UiSettings(BaseModel):
    sidebar_width: int = 250
    files_width: int = 380
    sidebar_font_size: int = 13
    terminal_font_size: int = 13
    ui_font_size: int = 11
    viewer_font_size: int = 12
    code_font_size: int = 12
    diff_font_size: int = 13
    active_session_id: str = ""
    open_files: list[dict[str, str]] = []
    project_state: dict[str, ProjectUiState] = {}
    theme: str = "dark"
    ignored_dirs: list[str] = []
    tree_font_size: int = 12
    hide_excluded: bool = True
    hide_dot_folders: bool = True
    file_tree_sort: str = "name"
    show_stats: bool = True
    show_mtime: bool = True
    show_git_status: bool = True
    recent_exclude: str = ""
    word_wrap: bool = False
    search_glob: str = "!*.json, !*.csv, !*.log"
    keybindings: dict[str, str] = {}
    vscode_keybindings: dict[str, str] = {}
    last_command: str = "codex"
    last_model: str = "codex"
    last_permissions: dict[str, str] = {}
    show_terminal_icons: bool = False
    prompt_wrap_guard: bool = False
    history_mode: bool = False
    claude_snapshot_experimental: bool = False
    prompt_history: dict[str, list[str]] = {}
    selection_copy_history: list[str] = []
    notebook_open: bool = False
    notebook_left: int = -1
    notebook_preview: bool = False
    notebook_text: str = ""
    notebook_notes: list[NotebookNote] = []
    notebook_active_note_id: str = ""
    notebook_notes_initialized: bool = False
    files_pinned: bool = False
    sidebar_text_color: str = "#d5dbe5"
    side_full: bool = False
    side_split: float = 0.55
    side_split_user_set: bool = False
    search_scope: str = "project"
    recent_closed_files: list[dict[str, str]] = []


class TermdeckServer:
    """HTTP + websocket surface of the mini terminal IDE: session CRUD API, static UI, one websocket per terminal.
    Terminal websocket protocol: server sends raw output as binary frames (scrollback replay first) and control
    events as JSON text frames; client sends JSON text frames for input and resize."""

    def __init__(self) -> None:
        self.state_backup = StateBackupManager(TermdeckConfig.DATA_DIR, TermdeckConfig.STATE_BACKUP_MAX_BYTES,
                                               TermdeckConfig.STATE_BACKUP_INTERVAL_SECONDS,
                                               TermdeckConfig.STATE_BACKUP_PREWRITE_INTERVAL_SECONDS)
        self.state_recovery = self.state_backup.recovery_status()
        self.recovery_mode = bool(self.state_recovery["required"])
        self.manager: TerminalSessionManager | None = None
        if not self.recovery_mode:
            self.manager = TerminalSessionManager(self.state_backup)
        self.files = ProjectFileService()
        self.file_history = FileHistoryService(TermdeckConfig.FILE_HISTORY_DATABASE)
        self.search = ProjectSearchService(self.files)
        self.stats = ResourceStatsService()
        self.transcripts = TranscriptService()
        self.history_index = HistorySearchIndex(TermdeckConfig.HISTORY_INDEX_FILE)
        if self.manager is not None:
            self.manager.attach_transcript_service(self.transcripts)
            self.manager.attach_history_index(self.history_index)
        self.transcripts.add_file_change_listener(self.history_index.notify_file_changed)
        if self.manager is not None:
            self.transcripts.add_file_change_listener(self.manager.notify_agent_transcript_changed)
        self.settings_store = UiSettingsStore(TermdeckConfig.SETTINGS_FILE, self.state_backup)
        self._state_backup_task: asyncio.Task | None = None
        self._origin_delivery_locks: dict[str, asyncio.Lock] = {}
        self._task_delivery_jobs: set[asyncio.Task] = set()

    @asynccontextmanager
    async def _lifespan(self, _app: FastAPI) -> AsyncGenerator[None]:
        if self.recovery_mode:
            yield
            return
        self.state_backup.create_snapshot("startup", True)
        self._state_backup_task = asyncio.create_task(self.state_backup.run_periodic_snapshots())
        await self.manager.startup_respawn_saved_sessions()
        self.manager.start_background_tasks()
        self.transcripts.start(asyncio.get_running_loop())
        self.history_index.start()
        try:
            yield
        finally:
            if self._state_backup_task is not None:
                self._state_backup_task.cancel()
                try:
                    await self._state_backup_task
                except asyncio.CancelledError:
                    pass
            self.history_index.stop()
            self.transcripts.stop()
            self.manager.stop_background_tasks()
            self.manager.detach_for_shutdown()
            self.state_backup.create_snapshot("shutdown", True)
            self.files.close()

    def build_app(self) -> FastAPI:
        app = FastAPI(lifespan=self._lifespan)
        app.middleware("http")(self._no_cache_middleware)
        app.mount(TermdeckConfig.STATIC_ROUTE, StaticFiles(directory=TermdeckConfig.STATIC_DIR), name=TermdeckConfig.STATIC_NAME)
        app.get("/", response_model=None)(self._index)
        app.get(TermdeckConfig.PROJECT_PAGE_ROUTE, response_model=None)(self._project_page)
        app.get(TermdeckConfig.API_STATE_RECOVERY_ROUTE, response_model=None)(self._state_recovery_status)
        app.post(TermdeckConfig.API_STATE_RECOVERY_RESTORE_ROUTE, response_model=None)(self._restore_state_recovery)
        app.get(TermdeckConfig.API_PROJECTS_ROUTE, response_model=None)(self._list_projects)
        app.post(TermdeckConfig.API_PROJECTS_ROUTE, response_model=None)(self._add_project)
        app.post(TermdeckConfig.API_PROJECT_FOLDER_PICKER_ROUTE, response_model=None)(self._pick_project_folder)
        app.get(TermdeckConfig.API_SESSIONS_ROUTE, response_model=None)(self._list_sessions)
        app.post(TermdeckConfig.API_SESSIONS_ROUTE, response_model=None)(self._create_session)
        app.post(TermdeckConfig.API_TERMINAL_TASK_ROUTE, response_model=None)(self._run_terminal_task)
        app.post(TermdeckConfig.API_TERMINAL_TASK_PROMPT_ROUTE, response_model=None)(self._follow_up_task_prompt)
        app.post(TermdeckConfig.API_TERMINALS_BATCH_ROUTE, response_model=None)(self._launch_terminal_batch)
        app.post(TermdeckConfig.API_SESSION_RESTART_ROUTE, response_model=None)(self._restart_session)
        app.post(TermdeckConfig.API_SESSION_FORK_ROUTE, response_model=None)(self._fork_session)
        app.post(TermdeckConfig.API_SESSION_RENAME_ROUTE, response_model=None)(self._rename_session)
        app.post(TermdeckConfig.API_SESSION_PROJECT_ROUTE, response_model=None)(self._move_session_to_project)
        app.get(TermdeckConfig.API_SESSION_TASK_STATUS_ROUTE, response_model=None)(self._task_status)
        app.get(TermdeckConfig.API_SESSION_TASK_RESULT_ROUTE, response_model=None)(self._task_result)
        app.get(TermdeckConfig.API_SESSION_LAST_TURN_ROUTE, response_model=None)(self._task_result)
        app.post(TermdeckConfig.API_SESSION_PROMPT_ROUTE, response_model=None)(self._submit_prompt)
        app.post(TermdeckConfig.API_KILL_ALL_TERMINALS_ROUTE, response_model=None)(self._kill_all_terminals)
        app.get(TermdeckConfig.API_TERMINAL_PROCESSES_ROUTE, response_model=None)(self._terminal_process_report)
        app.post(TermdeckConfig.API_RECLAIM_ORPHAN_TERMINALS_ROUTE, response_model=None)(self._reclaim_orphan_terminals)
        app.get(TermdeckConfig.API_SESSION_HISTORY_ROUTE, response_model=None)(self._session_history)
        app.get(TermdeckConfig.API_SESSION_HISTORY_PAGE_ROUTE, response_model=None)(self._session_history_page)
        app.get(TermdeckConfig.API_TERMINAL_LAYOUT_ROUTE, response_model=None)(self._get_terminal_layout)
        app.patch(TermdeckConfig.API_TERMINAL_LAYOUT_ROUTE, response_model=None)(self._patch_terminal_layout)
        app.get(TermdeckConfig.API_TERMINAL_SEARCH_ROUTE, response_model=None)(self._search_terminal_buffers)
        app.get(TermdeckConfig.API_HISTORY_SEARCH_ROUTE, response_model=None)(self._search_history)
        app.get(TermdeckConfig.API_HISTORY_CONTEXT_ROUTE, response_model=None)(self._history_context)
        app.delete(TermdeckConfig.API_SESSION_ROUTE, response_model=None)(self._delete_session)
        app.get(TermdeckConfig.API_CLOSED_ROUTE, response_model=None)(self._list_closed)
        app.post(TermdeckConfig.API_CLOSED_REOPEN_ROUTE, response_model=None)(self._reopen_closed)
        app.delete(TermdeckConfig.API_CLOSED_ITEM_ROUTE, response_model=None)(self._purge_closed)
        app.get(TermdeckConfig.API_SETTINGS_ROUTE, response_model=None)(self._get_settings)
        app.put(TermdeckConfig.API_SETTINGS_ROUTE, response_model=None)(self._put_settings)
        app.post(TermdeckConfig.API_NOTEBOOK_TRASH_ROUTE, response_model=None)(self._trash_notebook_note)
        app.get(TermdeckConfig.API_FILE_LIST_ROUTE, response_model=None)(self._list_files)
        app.get(TermdeckConfig.API_FILE_RECENT_ROUTE, response_model=None)(self._recent_files)
        app.get(TermdeckConfig.API_FILE_READ_ROUTE, response_model=None)(self._read_file)
        app.get(TermdeckConfig.API_FILE_SEARCH_ROUTE, response_model=None)(self._search_files)
        app.get(TermdeckConfig.API_FILE_FIND_ROUTE, response_model=None)(self._find_files)
        app.post(TermdeckConfig.API_FILE_HISTORY_RESTORE_ROUTE, response_model=None)(self._restore_file_history)
        app.get(TermdeckConfig.API_FILE_HISTORY_VERSION_ROUTE, response_model=None)(self._file_history_version)
        app.get(TermdeckConfig.API_FILE_HISTORY_ROUTE, response_model=None)(self._file_history)
        app.get(TermdeckConfig.API_FILE_GIT_HISTORY_ROUTE, response_model=None)(self._git_file_history)
        app.get(TermdeckConfig.API_FILE_GIT_HISTORY_VERSION_ROUTE, response_model=None)(self._git_file_history_version)
        app.get(TermdeckConfig.API_FILE_GIT_STATUS_ROUTE, response_model=None)(self._git_status)
        app.post(TermdeckConfig.API_UPLOAD_ROUTE, response_model=None)(self._upload_file)
        app.post(TermdeckConfig.API_FILE_WRITE_ROUTE, response_model=None)(self._write_file)
        app.post(TermdeckConfig.API_FILE_CREATE_ROUTE, response_model=None)(self._create_file)
        app.post(TermdeckConfig.API_FILE_DUPLICATE_ROUTE, response_model=None)(self._duplicate_file)
        app.post(TermdeckConfig.API_FILE_REPLACE_ROUTE, response_model=None)(self._replace_in_files)
        app.post(TermdeckConfig.API_FILE_RENAME_ROUTE, response_model=None)(self._rename_file)
        app.post(TermdeckConfig.API_FILE_MOVE_ROUTE, response_model=None)(self._move_file)
        app.post(TermdeckConfig.API_FILE_DELETE_ROUTE, response_model=None)(self._delete_file)
        app.get(TermdeckConfig.API_STATS_ROUTE, response_model=None)(self._resource_stats)
        app.websocket(TermdeckConfig.STATUS_WS_ROUTE)(self._ws_status)
        app.websocket(TermdeckConfig.FILE_TREE_WS_ROUTE)(self._ws_file_tree)
        app.websocket(TermdeckConfig.TRANSCRIPT_WS_ROUTE)(self._ws_transcript)
        app.websocket(TermdeckConfig.WS_ROUTE)(self._ws_terminal)
        return app

    async def _list_closed(self, project: str = "") -> list[dict[str, object]]:
        return list(self.manager.list_closed_sessions(project or None))

    async def _reopen_closed(self, session_id: str) -> dict[str, object]:
        try:
            ms = self.manager.reopen_closed_session(session_id)
        except KeyError as missing:
            raise HTTPException(status_code=404, detail=session_id) from missing
        return self.manager.session_summary(ms)

    async def _purge_closed(self, session_id: str) -> dict[str, object]:
        self.manager.purge_closed_session(session_id)
        return {ApiFields.DELETED: session_id}

    async def _get_settings(self) -> dict[str, int | str]:
        return UiSettings(**self.settings_store.load()).model_dump()

    async def _put_settings(self, settings: UiSettings) -> dict[str, int | str]:
        payload = self._preserve_active_layout_entries(settings.model_dump())
        self.settings_store.save(payload)
        return payload

    def _preserve_active_layout_entries(self, incoming_payload: dict[str, object]) -> dict[str, object]:
        current_settings = UiSettings(**self.settings_store.load())
        incoming_settings = UiSettings(**incoming_payload)
        active_sessions = self.manager.list_sessions(None)
        active_session_ids_by_project: dict[str, set[str]] = {}
        for session in active_sessions:
            project = str(session.get("project", "") or "")
            active_session_ids_by_project.setdefault(project or "__all__", set()).add(str(session["session_id"]))
        for project_key, current_state in current_settings.project_state.items():
            incoming_state = incoming_settings.project_state.get(project_key)
            if incoming_state is None:
                incoming_settings.project_state[project_key] = current_state
                continue
            incoming_state.open_files = current_state.open_files
            active_ids = active_session_ids_by_project.get(project_key, set())
            incoming_state.terminal_layout = self._preserve_missing_ordered_values(
                current_state.terminal_layout,
                incoming_state.terminal_layout,
                {f"session:{session_id}" for session_id in active_ids},
            )
            incoming_state.session_order = self._preserve_missing_ordered_values(
                current_state.session_order,
                incoming_state.session_order,
                active_ids,
            )
        return incoming_settings.model_dump()

    @staticmethod
    def _preserve_missing_ordered_values(current_values: list[str], incoming_values: list[str],
                                         allowed_values: set[str]) -> list[str]:
        merged_values = list(incoming_values)
        for value in current_values:
            if value not in allowed_values or value in merged_values:
                continue
            current_index = current_values.index(value)
            next_values = current_values[current_index + 1:]
            next_index = next((merged_values.index(candidate) for candidate in next_values if candidate in merged_values), None)
            if next_index is not None:
                merged_values.insert(next_index, value)
                continue
            previous_values = current_values[:current_index]
            previous_index = next((len(merged_values) - 1 - merged_values[::-1].index(candidate)
                                   for candidate in previous_values if candidate in merged_values), None)
            merged_values.insert(previous_index + 1 if previous_index is not None else len(merged_values), value)
        return merged_values

    async def _trash_notebook_note(self, request: NotebookTrashRequest) -> dict[str, str]:
        try:
            return {"trashed_to": self.files.move_notebook_note_to_trash(request.title, request.content)}
        except (OSError, PermissionError) as trash_error:
            raise HTTPException(status_code=500, detail=f"could not move note to Trash: {trash_error}") from trash_error

    async def _list_files(self, root: str, path: str = "") -> list[dict[str, object]]:
        try:
            return self.files.list_dir(root, path)
        except (ValueError, FileNotFoundError, NotADirectoryError, PermissionError) as list_error:
            raise HTTPException(status_code=404, detail=str(list_error)) from list_error

    async def _recent_files(self, root: str, path: str = "", limit: int = TermdeckConfig.RECENT_FILES_MAX_ENTRIES) -> list[dict[str, object]]:
        try:
            return await asyncio.to_thread(self.files.recent_files, root, path, limit)
        except (ValueError, FileNotFoundError, NotADirectoryError, PermissionError, OSError) as recent_error:
            raise HTTPException(status_code=404, detail=str(recent_error)) from recent_error

    async def _git_status(self, root: str) -> dict[str, str]:
        try:
            return await asyncio.to_thread(self.files.git_statuses, root)
        except (ValueError, FileNotFoundError, NotADirectoryError, PermissionError, OSError) as git_error:
            raise HTTPException(status_code=404, detail=str(git_error)) from git_error

    async def _read_file(self, root: str, path: str) -> dict[str, object]:
        try:
            result = self.files.read_file(root, path)
            self.file_history.observe_file(root, path, str(result["content"]))
            return result
        except (ValueError, FileNotFoundError, IsADirectoryError, PermissionError) as read_error:
            raise HTTPException(status_code=404, detail=str(read_error)) from read_error

    async def _search_files(self, root: str, q: str, glob: str = "", ignore: str = "", word: bool = False,
                            case_sensitive: bool = False, regex: bool = False) -> list[dict[str, str | int]]:
        if not q.strip():
            return []
        try:
            return await self.search.search(root, q, glob, ignore, word, case_sensitive, regex)
        except (ValueError, FileNotFoundError, PermissionError) as search_error:
            raise HTTPException(status_code=404, detail=str(search_error)) from search_error

    async def _find_files(self, root: str, q: str, glob: str = "", ignore: str = "", case_sensitive: bool = False) -> list[dict[str, str | bool | int]]:
        try:
            return await self.search.find_files(root, q, ignore, glob, case_sensitive)
        except (ValueError, FileNotFoundError, PermissionError) as find_error:
            raise HTTPException(status_code=404, detail=str(find_error)) from find_error

    async def _resource_stats(self, session_id: str = "") -> dict[str, object]:
        sockets = self.manager.session_dtach_sockets()
        if session_id:
            socket = sockets.get(session_id)
            sockets = {session_id: socket} if socket else {}
        return await self.stats.sample(sockets)

    async def _write_file(self, request: FileWriteRequest) -> dict[str, int]:
        try:
            current = self.files.read_file(request.root, request.path)
            self.file_history.observe_file(request.root, request.path, str(current["content"]))
            result = self.files.write_file(request.root, request.path, request.content)
            self.file_history.record_snapshot(request.root, request.path, request.content, "manual")
            return result
        except (ValueError, FileNotFoundError, PermissionError, OSError) as write_error:
            raise HTTPException(status_code=400, detail=str(write_error)) from write_error

    async def _create_file(self, request: FileCreateRequest) -> dict[str, str | bool]:
        try:
            return self.files.create_path(request.root, request.path, request.directory)
        except (ValueError, FileNotFoundError, FileExistsError, PermissionError, OSError) as create_error:
            raise HTTPException(status_code=400, detail=str(create_error)) from create_error

    async def _duplicate_file(self, request: FileOpRequest) -> dict[str, str]:
        try:
            return {"rel": self.files.duplicate_path(request.root, request.path, request.destination)}
        except (ValueError, FileNotFoundError, FileExistsError, PermissionError, OSError) as duplicate_error:
            raise HTTPException(status_code=400, detail=str(duplicate_error)) from duplicate_error

    async def _file_history(self, root: str, path: str) -> list[dict[str, object]]:
        try:
            return self.file_history.list_versions(root, path)
        except (ValueError, OSError) as history_error:
            raise HTTPException(status_code=400, detail=str(history_error)) from history_error

    async def _file_history_version(self, version_id: int) -> dict[str, object]:
        version = self.file_history.get_version(version_id)
        if version is None:
            raise HTTPException(status_code=404, detail="file history version not found")
        return version

    async def _git_file_history(self, root: str, path: str, limit: int = 50) -> list[dict[str, str]]:
        try:
            base = self.files.resolve_confined(root, "")
            result = await asyncio.to_thread(self._run_git_history_log, base, path, max(1, min(limit, 100)))
        except (ValueError, FileNotFoundError, PermissionError, OSError, subprocess.SubprocessError) as history_error:
            raise HTTPException(status_code=400, detail=str(history_error)) from history_error
        return result

    @staticmethod
    def _run_git_history_log(base: Path, path: str, limit: int) -> list[dict[str, str]]:
        result = subprocess.run(
            ["git", "-C", str(base), "log", "--follow", "--format=%H%x00%h%x00%an%x00%ad%x00%s",
             "--date=iso-strict", "-n", str(limit), "--", path],
            capture_output=True, text=True, timeout=10, check=False,
        )
        if result.returncode != 0:
            raise OSError(result.stderr.strip() or "git history unavailable")
        commits = []
        for line in result.stdout.splitlines():
            fields = line.split("\x00", 4)
            if len(fields) != 5:
                continue
            commits.append({"commit_id": fields[0], "short_id": fields[1], "author": fields[2],
                            "committed_at": fields[3], "message": fields[4]})
        return commits

    async def _git_file_history_version(self, commit_id: str, root: str, path: str) -> dict[str, str]:
        if not re.fullmatch(r"[0-9a-fA-F]{7,64}", commit_id):
            raise HTTPException(status_code=400, detail="invalid git commit id")
        try:
            base = self.files.resolve_confined(root, "")
            content = await asyncio.to_thread(self._run_git_history_version, base, path, commit_id)
        except (ValueError, FileNotFoundError, PermissionError, OSError, subprocess.SubprocessError) as version_error:
            raise HTTPException(status_code=404, detail=str(version_error)) from version_error
        return {"commit_id": commit_id, "root": str(base), "path": path, "content": content}

    @staticmethod
    def _run_git_history_version(base: Path, path: str, commit_id: str) -> str:
        result = subprocess.run(["git", "-C", str(base), "show", f"{commit_id}:{path}"],
                                capture_output=True, timeout=10, check=False)
        if result.returncode != 0:
            raise FileNotFoundError(result.stderr.decode(errors="replace").strip() or "git file version unavailable")
        return result.stdout.decode("utf-8", errors="replace")

    async def _restore_file_history(self, request: FileHistoryRestoreRequest) -> dict[str, object]:
        try:
            version = self.file_history.get_version(request.version_id)
            if version is None or not self.file_history.version_belongs_to_file(request.version_id, request.root, request.path):
                raise FileNotFoundError(f"file history version not found: {request.version_id}")
            current = self.files.read_file(request.root, request.path)
            self.file_history.observe_file(request.root, request.path, str(current["content"]))
            result = self.files.write_file(request.root, request.path, str(version["content"]))
            self.file_history.record_snapshot(request.root, request.path, str(version["content"]), "restore")
            return {**result, "version_id": request.version_id}
        except (ValueError, FileNotFoundError, PermissionError, OSError) as restore_error:
            raise HTTPException(status_code=400, detail=str(restore_error)) from restore_error

    async def _replace_in_files(self, request: ReplaceRequest) -> dict[str, int]:
        if not request.q.strip():
            raise HTTPException(status_code=400, detail="empty query")
        try:
            return await self.search.replace_all(request.root, request.q, request.glob, request.ignore,
                                                 request.word, request.case_sensitive, request.regex,
                                                 request.replacement, request.paths)
        except (ValueError, FileNotFoundError, PermissionError, re.error) as replace_error:
            raise HTTPException(status_code=400, detail=str(replace_error)) from replace_error

    async def _upload_file(self, file: UploadFile) -> dict[str, str]:
        data = await file.read()
        try:
            return {"path": self.files.save_upload(file.filename or "", data)}
        except (ValueError, OSError) as upload_error:
            raise HTTPException(status_code=400, detail=str(upload_error)) from upload_error

    async def _rename_file(self, request: FileOpRequest) -> dict[str, str]:
        try:
            return {"new_name": self.files.rename_path(request.root, request.path, request.new_name)}
        except (ValueError, FileNotFoundError, PermissionError, OSError) as rename_error:
            raise HTTPException(status_code=400, detail=str(rename_error)) from rename_error

    async def _move_file(self, request: FileOpRequest) -> dict[str, str]:
        try:
            return {"rel": self.files.move_path(request.root, request.path, request.destination)}
        except (ValueError, FileNotFoundError, PermissionError, OSError) as move_error:
            raise HTTPException(status_code=400, detail=str(move_error)) from move_error

    async def _delete_file(self, request: FileOpRequest) -> dict[str, str]:
        try:
            return {"trashed_to": self.files.move_to_trash(request.root, request.path)}
        except (ValueError, FileNotFoundError, PermissionError, OSError) as delete_error:
            raise HTTPException(status_code=400, detail=str(delete_error)) from delete_error

    async def _no_cache_middleware(self, request: Request, call_next: Callable) -> Response:
        response = await call_next(request)
        if not request.url.path.startswith("/static/vendor/"):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return response

    async def _index(self) -> FileResponse:
        index_file = "recovery.html" if self.recovery_mode else TermdeckConfig.INDEX_FILE
        return FileResponse(TermdeckConfig.STATIC_DIR / index_file)

    async def _project_page(self, project_name: str) -> FileResponse:
        if self.recovery_mode:
            return FileResponse(TermdeckConfig.STATIC_DIR / "recovery.html")
        if self.manager.registry.root_for(project_name) is None:
            raise HTTPException(status_code=404, detail=project_name)
        return FileResponse(TermdeckConfig.STATIC_DIR / TermdeckConfig.INDEX_FILE)

    async def _state_recovery_status(self) -> dict[str, object]:
        return self.state_backup.recovery_status()

    async def _restore_state_recovery(self, request: StateRecoveryRestoreRequest) -> dict[str, object]:
        if not self.recovery_mode:
            raise HTTPException(status_code=409, detail="state recovery is not required")
        try:
            restored = self.state_backup.restore_snapshot(request.snapshot)
        except ValueError as restore_error:
            raise HTTPException(status_code=400, detail=str(restore_error)) from restore_error
        asyncio.create_task(self._restart_after_state_recovery())
        return {"restored": [path.name for path in restored], "restart_scheduled": True}

    @staticmethod
    async def _restart_after_state_recovery() -> None:
        await asyncio.sleep(0.25)
        os.kill(os.getpid(), signal.SIGTERM)

    async def _list_projects(self) -> list[dict[str, str]]:
        return self.manager.registry.list_projects()

    async def _add_project(self, request: ProjectRegistrationRequest) -> dict[str, str]:
        try:
            return self.manager.registry.add_project(request.root, request.name)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    async def _pick_project_folder(self) -> dict[str, object]:
        if not PlatformPaths.IS_MACOS:
            raise HTTPException(status_code=501, detail="native folder selection is only available on macOS desktop mode")
        picker_script = 'POSIX path of (choose folder with prompt "Choose TermDeck project folder")'
        try:
            result = await asyncio.to_thread(
                subprocess.run,
                ["/usr/bin/osascript", "-e", picker_script],
                capture_output=True, text=True, timeout=120, check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise HTTPException(status_code=504, detail="native folder selection timed out") from error
        except OSError as error:
            raise HTTPException(status_code=500, detail=f"native folder selection failed: {error}") from error
        if result.returncode != 0:
            if "User canceled" in result.stderr or "User canceled" in result.stdout:
                return {"cancelled": True}
            detail = result.stderr.strip() or "native folder selection failed"
            raise HTTPException(status_code=500, detail=detail)
        root = result.stdout.strip()
        if not root:
            return {"cancelled": True}
        try:
            project = self.manager.registry.add_project(root)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return {"cancelled": False, "project": project}

    async def _list_sessions(self, project: str = "") -> list[dict[str, object]]:
        return self.manager.list_sessions(project or None)

    def _terminal_layout_payload(self, project: str, settings: UiSettings) -> dict[str, object]:
        key = project or "__all__"
        state = settings.project_state.get(key, ProjectUiState())
        return {"project": project, "sessions": self.manager.list_sessions(project or None), **state.model_dump()}

    async def _get_terminal_layout(self, project: str = "") -> dict[str, object]:
        settings = UiSettings(**self.settings_store.load())
        return self._terminal_layout_payload(project, settings)

    async def _patch_terminal_layout(self, patch: ProjectStatePatch, project: str = "") -> dict[str, object]:
        settings = UiSettings(**self.settings_store.load())
        key = project or "__all__"
        current = settings.project_state.get(key, ProjectUiState()).model_dump()
        current.update(patch.model_dump(exclude_none=True))
        settings.project_state[key] = ProjectUiState(**current)
        payload = settings.model_dump()
        self.settings_store.save(payload)
        return self._terminal_layout_payload(project, UiSettings(**payload))

    def _place_session_after(self, project: str, session_id: str, after: str,
                             anchor_token: str | None = None) -> dict[str, object]:
        """Insert a newly-created session after a visible session or group.

        The UI persists layout entries as ``session:<id>`` and ``group:<id>``.
        Automation callers can use either one of those stable tokens or the
        exact display name of a session/group. Name matching is case-insensitive
        but deliberately rejects ambiguous matches.
        """
        requested = after.strip()
        if not requested:
            return {"after": requested, "token": f"session:{session_id}"}

        settings = UiSettings(**self.settings_store.load())
        key = project or "__all__"
        state = settings.project_state.get(key, ProjectUiState())
        sessions = self.manager.list_sessions(project or None)
        groups = [group for group in state.terminal_groups
                  if str(group.get("id", "")).strip() and str(group.get("name", "")).strip()]
        session_ids = {str(session.get("session_id", "")) for session in sessions}
        group_ids = {str(group.get("id", "")) for group in groups}

        layout = list(state.terminal_layout)
        session_groups = dict(state.session_groups)
        anchor_session_id: str | None = None
        if anchor_token is None:
            if requested.startswith("session:"):
                anchor_session_id = requested[8:]
                if anchor_session_id not in session_ids:
                    raise ValueError(f"placement session not found: {anchor_session_id}")
                anchor_token = requested
            elif requested.startswith("group:"):
                if requested[6:] not in group_ids:
                    raise ValueError(f"placement group not found: {requested[6:]}")
                anchor_token = requested
            else:
                normalized = requested.casefold()
                session_matches = [session for session in sessions
                                   if normalized in self._placement_names(session)]
                group_matches = [group for group in groups
                                 if str(group.get("name", "")).strip().casefold() == normalized]
                if len(session_matches) + len(group_matches) != 1:
                    if len(session_matches) + len(group_matches) > 1:
                        raise ValueError(f"placement target is ambiguous: {requested}")
                    raise ValueError(f"placement target not found: {requested}")
                if session_matches:
                    anchor_session_id = str(session_matches[0]["session_id"])
                    anchor_token = f"session:{anchor_session_id}"
                else:
                    anchor_token = f"group:{group_matches[0]['id']}"
        elif anchor_token.startswith("session:"):
            anchor_session_id = anchor_token[8:]
            if anchor_session_id not in session_ids:
                raise ValueError(f"placement anchor is no longer present: {anchor_token}")
        elif anchor_token.startswith("group:") and anchor_token[6:] in group_ids:
            # The group may be valid but absent from a legacy/incomplete
            # top-level layout; the materialization below will restore it.
            pass
        elif anchor_token not in layout:
            raise ValueError(f"placement anchor is no longer present: {anchor_token}")

        # Group members are ordered by session_order; terminal_layout only
        # contains the group's top-level token. Keep a new API terminal in
        # that group and insert it immediately after the requested member.
        if anchor_session_id and session_groups.get(anchor_session_id) in group_ids:
            group_id = session_groups[anchor_session_id]
            ordered_session_ids = [str(session.get("session_id", "")) for session in sessions]
            order = [str(item) for item in state.session_order if str(item) in session_ids]
            order.extend(item for item in ordered_session_ids if item not in order)
            order = [item for item in order if item != session_id]
            anchor_index = order.index(anchor_session_id)
            order.insert(anchor_index + 1, session_id)
            session_groups[session_id] = group_id
            state.session_groups = session_groups
            state.session_order = order
            settings.project_state[key] = state
            self.settings_store.save(settings.model_dump())
            return {"after": requested, "anchor": anchor_token, "token": f"session:{session_id}",
                    "group": f"group:{group_id}", "position": "after"}

        # A legacy settings file may have no explicit layout yet. Preserve the
        # requested relationship by materializing the resolved anchor first;
        # the frontend will append any other missing entries in its normal
        # migration path.
        if anchor_token not in layout:
            layout.append(anchor_token)
        new_token = f"session:{session_id}"
        layout = [entry for entry in layout if entry != new_token]
        anchor_index = layout.index(anchor_token)
        layout.insert(anchor_index + 1, new_token)
        state.terminal_layout = layout
        state.session_groups = session_groups
        settings.project_state[key] = state
        self.settings_store.save(settings.model_dump())
        return {"after": requested, "anchor": anchor_token, "token": new_token, "position": "after"}

    @staticmethod
    def _placement_names(session: dict[str, object]) -> set[str]:
        names: set[str] = set()
        for value in (session.get("title"), session.get("cli_title")):
            name = str(value or "").strip()
            if not name:
                continue
            names.add(name.casefold())
            visible = re.sub(r"^[\u2800-\u28ff○-◗⏳⚡✳]\s+", "", name).strip()
            if visible:
                names.add(visible.casefold())
        return names

    def _resolve_project_from_after_anchor(self, after: str | None, fallback_project: str) -> str:
        requested = after.strip() if after else ""
        if not requested:
            return fallback_project
        if requested.startswith("session:"):
            target_session = requested[8:].strip()
            if target_session:
                for session in self.manager.list_sessions(None):
                    if str(session.get("session_id", "")).strip() == target_session:
                        return str(session.get("project", fallback_project) or fallback_project)
            return fallback_project
        if requested.startswith("group:"):
            target_group = requested[6:].strip()
            if target_group:
                try:
                    settings = UiSettings(**self.settings_store.load())
                except ValueError:
                    return fallback_project
                for key, state in settings.project_state.items():
                    for group in state.terminal_groups:
                        if str(group.get("id", "")).strip() == target_group:
                            return "" if key == "__all__" else key
            return fallback_project
        normalized = requested.casefold()
        projects = set[str]()
        for session in self.manager.list_sessions(None):
            if normalized in self._placement_names(session):
                projects.add(str(session.get("project", fallback_project) or fallback_project))
        try:
            settings = UiSettings(**self.settings_store.load())
        except ValueError:
            settings = UiSettings()
        for key, state in settings.project_state.items():
            if not str(key) or key == "":
                continue
            for group in state.terminal_groups:
                if normalized == str(group.get("name", "")).strip().casefold():
                    projects.add("" if key == "__all__" else key)
        if len(projects) != 1:
            return fallback_project
        return projects.pop()

    async def _create_session(self, request: CreateSessionRequest) -> dict[str, object]:
        try:
            command = request.command
            if request.model.strip():
                command = self.manager.command_for_new_session(request.model, request.permission, request.session_ref, request.model_name)
            project = self._resolve_project_from_after_anchor(request.after, request.project)
            ms = self.manager.create_session(
                command, request.cwd, request.title, project,
                agent_rename=request.title if not request.session_ref.strip() else None,
            )
        except ValueError as bad_request:
            raise HTTPException(status_code=400, detail=str(bad_request)) from bad_request
        result = self.manager.session_summary(ms)
        if request.after and request.after.strip():
            try:
                result["placement"] = self._place_session_after(
                    ms.record.project, ms.record.session_id, request.after)
            except (ValueError, OSError) as placement_error:
                result["placement_error"] = str(placement_error)
        return result

    async def _run_terminal_task(self, request: RunTerminalTaskRequest) -> dict[str, object]:
        prompt = request.prompt.strip() or request.command.strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="prompt is required")
        try:
            origin_session_id = self._resolve_origin_session(request.origin_session)
            if request.fork and not origin_session_id:
                raise ValueError("fork requires origin_session")
            placement_after = f"session:{origin_session_id}" if origin_session_id else request.after
            origin_summary = self.manager.session_summary_by_id(origin_session_id) if origin_session_id else {}
            if request.fork:
                ms = self.manager.fork_session(origin_session_id, request.title)
            else:
                base_command = self.manager.command_for_new_session(request.model, request.permission, request.session_ref, request.model_name)
                cwd = request.cwd or str(origin_summary.get("cwd", ""))
                project = self._resolve_project_from_after_anchor(placement_after, request.project or str(origin_summary.get("project", "")))
                ms = self.manager.create_session(
                    base_command,
                    cwd,
                    request.title,
                    project,
                    output_path=request.output_path,
                    agent_rename=request.title if request.title.strip() and not request.session_ref.strip() else None,
                )
            summary = self.manager.session_summary(ms)
            self.manager.ensure_session_running(ms.record.session_id)
            if placement_after and placement_after.strip():
                try:
                    summary["placement"] = self._place_session_after(
                        ms.record.project,
                        ms.record.session_id,
                        placement_after,
                    )
                except (ValueError, OSError) as placement_error:
                    summary["placement_error"] = str(placement_error)
            await self.manager.submit_prompt(ms.record.session_id, prompt, request.bracketed, request.queue)
            latest = self.manager.session_summary(ms)
            latest["placement"] = summary.get("placement")
            latest["placement_error"] = summary.get("placement_error")
            summary = latest
            summary["prompt_submitted"] = True
            summary["queued"] = request.queue
            if origin_session_id and request.write_back:
                self._schedule_task_result_delivery(ms.record.session_id, origin_session_id)
            return summary
        except ValueError as task_error:
            raise HTTPException(status_code=400, detail=str(task_error)) from task_error

    def _resolve_origin_session(self, reference: str) -> str | None:
        resolved_session_id = self._find_open_session_id_by_reference(reference)
        if resolved_session_id is None:
            raise ValueError(f"no open originating session found: {reference}")
        return resolved_session_id

    def _find_open_session_id_by_reference(self, reference: str) -> str | None:
        requested = reference.strip()
        if not requested:
            return None
        matches = [session for session in self.manager.list_sessions(None)
                   if str(session.get("session_id", "")) == requested or requested.casefold() in self._placement_names(session)]
        if len(matches) > 1:
            raise ValueError(f"session name is ambiguous: {reference}")
        return str(matches[0]["session_id"]) if matches else None

    def _schedule_task_result_delivery(self, child_session_id: str, origin_session_id: str) -> None:
        job = asyncio.create_task(self._deliver_task_result(child_session_id, origin_session_id))
        self._task_delivery_jobs.add(job)
        job.add_done_callback(self._forget_task_delivery_job)

    def _forget_task_delivery_job(self, job: asyncio.Task) -> None:
        self._task_delivery_jobs.discard(job)

    async def _deliver_task_result(self, child_session_id: str, origin_session_id: str) -> None:
        started_at = time.monotonic()
        last_turn: dict[str, object] | None = None
        status = "error"
        while self.manager.has_session(child_session_id):
            summary = self.manager.session_summary_by_id(child_session_id)
            last_turn = await self._read_last_turn_once(child_session_id, final_only=True)
            if last_turn is not None:
                status = "error" if summary.get(ApiFields.EXIT_CODE) not in (None, 0) else "completed"
                break
            if not summary.get(ApiFields.RUNNING):
                break
            if time.monotonic() - started_at >= TermdeckConfig.TASK_RESULT_MAX_WAIT_SECONDS:
                break
            await asyncio.sleep(0.5)
        if not self.manager.has_session(origin_session_id):
            return
        if last_turn is None and self.manager.has_session(child_session_id):
            last_turn = await self._read_last_turn(child_session_id, final_only=True)
        response_text = self._format_task_result(child_session_id, status, last_turn)
        delivery_locks = getattr(self, "_origin_delivery_locks", {})
        lock = delivery_locks.setdefault(origin_session_id, asyncio.Lock())
        self._origin_delivery_locks = delivery_locks
        async with lock:
            origin_summary = self.manager.session_summary_by_id(origin_session_id)
            await self.manager.submit_prompt(origin_session_id, response_text, True, bool(origin_summary.get("processing")))

    async def _read_last_turn(self, session_id: str, final_only: bool = False) -> dict[str, object] | None:
        for attempt in range(12):
            turn = await self._read_last_turn_once(session_id, final_only)
            if turn is not None:
                return turn
            if attempt < 11:
                await asyncio.sleep(0.25)
        return None

    async def _read_last_turn_once(self, session_id: str, final_only: bool = False) -> dict[str, object] | None:
        agent_kind, cwd, agent_session_id = self.manager.session_history_source(session_id)
        transcript = await asyncio.to_thread(self.transcripts.history_page, agent_kind, cwd, agent_session_id, None, 1)
        return self._latest_assistant_turn(transcript.get("turns", []), final_only)

    @staticmethod
    def _latest_assistant_turn(turns: list[dict[str, object]], final_only: bool = False) -> dict[str, object] | None:
        return next((turn for turn in reversed(turns)
                     if str(turn.get("role", "")) == "assistant" and (not final_only or bool(turn.get("final")))), None)

    @staticmethod
    def _format_task_result(session_id: str, status: str, last_turn: dict[str, object] | None) -> str:
        if last_turn is None:
            return f"[TermDeck task {session_id} {status}] No agent response was produced."
        text = str(last_turn.get("text", "")).strip()
        return f"[TermDeck task {session_id} {status}]\n{text}" if text else f"[TermDeck task {session_id} {status}]\n{json.dumps(last_turn, ensure_ascii=False)}"

    async def _task_status(self, session_id: str) -> dict[str, object]:
        if not self.manager.has_session(session_id):
            raise HTTPException(status_code=404, detail=session_id)
        summary = self.manager.session_summary_by_id(session_id)
        agent_kind, cwd, agent_session_id = self.manager.session_history_source(session_id)
        transcript = await asyncio.to_thread(
            self.transcripts.history_page,
            agent_kind,
            cwd,
            agent_session_id,
            None,
            max(20, min(TranscriptService.HISTORY_PAGE_TURNS, 160)),
        )
        turns = transcript.get("turns", [])
        latest_turn = self._latest_assistant_turn(turns)
        return {
            "session_id": session_id,
            "completed": not bool(summary.get(ApiFields.RUNNING)) and summary.get(ApiFields.EXIT_CODE) is not None,
            "output_path": summary.get("output_path"),
            "transcript": {
                "tail": transcript.get("turns", []),
                "before": transcript.get("before"),
                "has_more": transcript.get("has_more", False),
            },
            "latest_turn": latest_turn,
            "agent_session_id": agent_session_id,
            "monitoring_url": f"/api/sessions/{session_id}/task-result",
            **summary,
        }

    async def _task_result(self, session_id: str) -> dict[str, object]:
        resolved_session_id = session_id if self.manager.has_session(session_id) else None
        if resolved_session_id is None:
            try:
                resolved_session_id = self._find_open_session_id_by_reference(session_id)
            except ValueError as ambiguous_error:
                raise HTTPException(status_code=409, detail=str(ambiguous_error)) from ambiguous_error
        if resolved_session_id is None:
            raise HTTPException(status_code=404, detail=session_id)
        summary = self.manager.session_summary_by_id(resolved_session_id)
        agent_kind, cwd, agent_session_id = self.manager.session_history_source(resolved_session_id)
        transcript = await asyncio.to_thread(
            self.transcripts.history_page,
            agent_kind,
            cwd,
            agent_session_id,
            None,
            1,
        )
        turns = transcript.get("turns", [])
        running = bool(summary.get(ApiFields.RUNNING))
        exit_code = summary.get(ApiFields.EXIT_CODE)
        status = "running" if running else "error" if exit_code is not None and exit_code != 0 else "completed"
        return {
            "session_id": resolved_session_id,
            "status": status,
            "last_turn": self._latest_assistant_turn(turns),
        }

    async def _submit_prompt(self, session_id: str, request: SubmitPromptRequest,
                             automatically_queue_when_busy: bool = True) -> dict[str, object]:
        if not self.manager.has_session(session_id):
            raise HTTPException(status_code=404, detail=session_id)
        if not request.text.strip():
            raise HTTPException(status_code=400, detail="prompt text cannot be empty")
        try:
            self.manager.ensure_session_running(session_id)
            queued = request.queue or (automatically_queue_when_busy and bool(self.manager.session_summary_by_id(session_id).get("processing")))
            await self.manager.submit_prompt(session_id, request.text, request.bracketed, queued)
        except ValueError as prompt_error:
            raise HTTPException(status_code=409, detail=str(prompt_error)) from prompt_error
        return {"session": self.manager.session_summary_by_id(session_id), "prompt_submitted": True, "queued": queued}

    async def _follow_up_task_prompt(self, session_id: str, request: FollowUpTaskPromptRequest) -> dict[str, object]:
        return await self._submit_prompt(session_id, SubmitPromptRequest(
            text=request.prompt, bracketed=request.bracketed), automatically_queue_when_busy=False)

    async def _launch_terminal_batch(self, request: BatchTerminalsRequest) -> dict[str, object]:
        if not request.terminals:
            raise HTTPException(status_code=400, detail="terminals cannot be empty")
        if len(request.terminals) > TermdeckConfig.TERMINAL_BATCH_MAX_ITEMS:
            raise HTTPException(status_code=400,
                                detail=f"at most {TermdeckConfig.TERMINAL_BATCH_MAX_ITEMS} terminals per request")
        if not request.prompt.strip() and not any(item.prompt and item.prompt.strip() for item in request.terminals):
            raise HTTPException(status_code=400, detail="a shared prompt or per-terminal prompt is required")

        results: list[dict[str, object]] = []
        placement_cursors: dict[tuple[str, str], str] = {}
        for item in request.terminals:
            result: dict[str, object] = {"name": item.name}
            try:
                name = item.name.strip()
                if not name:
                    raise ValueError("terminal name cannot be empty")
                prompt = request.prompt if item.prompt is None else item.prompt
                if not prompt.strip():
                    raise ValueError(f"prompt is empty for terminal {name}")
                model = request.model if item.model is None else item.model
                model_name = request.model_name if item.model_name is None else item.model_name
                permission = request.permission if item.permission is None else item.permission
                cwd = request.cwd if item.cwd is None else item.cwd
                project = request.project if item.project is None else item.project
                session_ref = item.session_ref or ""
                bracketed = request.bracketed if item.bracketed is None else item.bracketed
                queue = request.queue if item.queue is None else item.queue
                placement_after = request.after if item.after is None else item.after
                project = self._resolve_project_from_after_anchor(placement_after, project)
                command = self.manager.command_for_new_session(model, permission, session_ref, model_name or "")
                ms = self.manager.create_session(
                    command, cwd, name, project,
                    agent_rename=name if not session_ref.strip() else None,
                )
                result["session"] = self.manager.session_summary(ms)

                if placement_after and placement_after.strip():
                    actual_project = ms.record.project
                    placement_key = (actual_project, placement_after.strip().casefold())
                    try:
                        placement = self._place_session_after(
                            actual_project,
                            ms.record.session_id,
                            placement_after,
                            placement_cursors.get(placement_key),
                        )
                        placement_cursors[placement_key] = placement["token"]
                        result["placement"] = placement
                    except (ValueError, OSError) as placement_error:
                        result["placement_error"] = str(placement_error)

                self.manager.ensure_session_running(ms.record.session_id)
                await self.manager.submit_prompt(ms.record.session_id, prompt, bracketed, queue)
                result["prompt_submitted"] = True
                result["queued"] = queue
                result["session"] = self.manager.session_summary(ms)
            except (ValueError, OSError) as batch_error:
                result["error"] = str(batch_error)
            results.append(result)
        created = sum(1 for result in results if "session" in result)
        submitted = sum(1 for result in results if result.get("prompt_submitted"))
        placement_failed = sum(1 for result in results if "placement_error" in result)
        return {"requested": len(results), "created": created, "prompt_submitted": submitted,
                "failed": len(results) - submitted, "placement_failed": placement_failed, "items": results}

    async def _session_history(self, session_id: str) -> list[dict[str, object]]:
        if not self.manager.has_session(session_id):
            raise HTTPException(status_code=404, detail=session_id)
        agent_kind, cwd, agent_session_id = self.manager.session_history_source(session_id)
        return self.transcripts.transcript_for(agent_kind, cwd, agent_session_id)

    async def _session_history_page(self, session_id: str, before: int | None = None,
                                    limit: int = TranscriptService.HISTORY_PAGE_TURNS) -> dict[str, object]:
        if not self.manager.has_session(session_id):
            raise HTTPException(status_code=404, detail=session_id)
        agent_kind, cwd, agent_session_id = self.manager.session_history_source(session_id)
        return await asyncio.to_thread(self.transcripts.history_page, agent_kind, cwd, agent_session_id, before, limit)

    async def _search_terminal_buffers(self, q: str, case_sensitive: bool = False, regex: bool = False) -> list[dict[str, object]]:
        if not q.strip():
            return []
        try:
            return self.manager.search_terminal_buffers(q, case_sensitive, regex)
        except re.error as search_error:
            raise HTTPException(status_code=400, detail=f"invalid regular expression: {search_error}") from search_error
        except ValueError as search_error:
            raise HTTPException(status_code=400, detail=str(search_error)) from search_error

    async def _search_history(self, q: str, include_operations: bool = False) -> dict[str, object]:
        if not q.strip():
            return {"indexing": self.history_index.indexing, "results": []}
        results = await asyncio.to_thread(self.history_index.search, q, include_operations)
        open_sessions = {(item.get("agent_kind"), item.get("agent_session_id")): item
                         for item in self.manager.list_sessions(None) if item.get("agent_session_id")}
        closed_sessions = {(item.get("agent_kind"), item.get("agent_session_id")): item
                           for item in self.manager.list_closed_sessions(None) if item.get("agent_session_id")}
        enriched: list[dict[str, object]] = []
        for result in results:
            key = (result.get("agent_kind"), result.get("agent_session_id"))
            open_session = open_sessions.get(key)
            closed_session = closed_sessions.get(key)
            parent_key = (result.get("agent_kind"), result.get("parent_agent_session_id"))
            parent_open_session = open_sessions.get(parent_key) if result.get("is_subagent") else None
            parent_closed_session = closed_sessions.get(parent_key) if result.get("is_subagent") else None
            result["parent_open_session_id"] = parent_open_session.get("session_id") if parent_open_session else None
            result["parent_closed_session_id"] = parent_closed_session.get("session_id") if parent_closed_session else None
            result["parent_status"] = (("open" if parent_open_session else
                                         "closed" if parent_closed_session else "not_open")
                                        if result.get("is_subagent") else None)
            result["parent_title"] = ((parent_open_session or parent_closed_session or {}).get("title")
                                       or result.get("parent_title") if result.get("is_subagent") else None)
            result["parent_cwd"] = ((parent_open_session or parent_closed_session or {}).get("cwd")
                                     or result.get("parent_cwd") if result.get("is_subagent") else None)
            result["status"] = "open" if open_session else "closed" if closed_session else "not_open"
            result["open_session_id"] = open_session.get("session_id") if open_session else None
            result["closed_session_id"] = closed_session.get("session_id") if closed_session else None
            if open_session:
                result["title"] = open_session.get("title") or result.get("title")
                result["cwd"] = open_session.get("cwd") or result.get("cwd")
            elif closed_session:
                result["title"] = closed_session.get("title") or result.get("title")
                result["cwd"] = closed_session.get("cwd") or result.get("cwd")
            if str(result.get("title", "")).startswith(("<user_instructions>", "<INSTRUCTIONS>", "# AGENTS.md")):
                result["title"] = f"{result.get('agent_kind', 'agent')} · {Path(str(result.get('cwd', ''))).name or 'session'}"
            enriched.append(result)
        return {"indexing": self.history_index.indexing, "results": enriched}

    async def _history_context(self, source: str, line: int, radius: int = 4, q: str = "",
                               include_operations: bool = False) -> dict[str, object]:
        try:
            return await asyncio.to_thread(self.history_index.context, source, line, radius, q, include_operations)
        except (FileNotFoundError, OSError, ValueError) as context_error:
            raise HTTPException(status_code=404, detail=str(context_error)) from context_error

    async def _restart_session(self, session_id: str, permission: str = "",
                               request: RestartSessionRequest | None = None) -> dict[str, object]:
        if not self.manager.has_session(session_id):
            raise HTTPException(status_code=404, detail=session_id)
        try:
            request_permission = request.permission.strip() if request else ""
            permission = permission.strip() or request_permission
            await self.manager.restart_session(session_id, permission)
        except RuntimeError as restart_error:
            raise HTTPException(status_code=409, detail=str(restart_error)) from restart_error
        except ValueError as restart_error:
            raise HTTPException(status_code=400, detail=str(restart_error)) from restart_error
        return self.manager.session_summary_by_id(session_id)

    async def _fork_session(self, session_id: str, request: RenameSessionRequest) -> dict[str, object]:
        if not self.manager.has_session(session_id):
            raise HTTPException(status_code=404, detail=session_id)
        forked = self.manager.fork_session(session_id, request.title)
        result = self.manager.session_summary(forked)
        result["placement"] = self._place_session_after(
            forked.record.project, forked.record.session_id, f"session:{session_id}")
        return result

    async def _rename_session(self, session_id: str, request: RenameSessionRequest) -> dict[str, object]:
        if not self.manager.has_session(session_id):
            raise HTTPException(status_code=404, detail=session_id)
        self.manager.rename_session(session_id, request.title)
        return self.manager.session_summary_by_id(session_id)

    async def _move_session_to_project(self, session_id: str, request: MoveSessionProjectRequest) -> dict[str, object]:
        if not self.manager.has_session(session_id):
            raise HTTPException(status_code=404, detail=session_id)
        try:
            self.manager.move_session_to_project(session_id, request.project)
        except ValueError as project_error:
            raise HTTPException(status_code=400, detail=str(project_error)) from project_error
        return self.manager.session_summary_by_id(session_id)

    async def _delete_session(self, session_id: str, request: CloseSessionRequest | None = None) -> dict[str, object]:
        if not self.manager.has_session(session_id):
            raise HTTPException(status_code=404, detail=session_id)
        socket_removed = await self.manager.delete_session(session_id, request.group_name if request else "")
        if not socket_removed:
            raise HTTPException(status_code=409, detail="could not terminate the detached terminal process tree")
        return {ApiFields.DELETED: session_id, "socket_removed": True}

    async def _kill_all_terminals(self) -> dict[str, int]:
        return {"killed": await self.manager.kill_all_running_sessions()}

    async def _terminal_process_report(self) -> dict[str, object]:
        return await self.manager.terminal_process_report()

    async def _reclaim_orphan_terminals(self) -> dict[str, object]:
        return await self.manager.reclaim_orphan_dtach_sessions()

    async def _ws_terminal(self, websocket: WebSocket, session_id: str) -> None:
        if not self.manager.has_session(session_id):
            await websocket.close(code=TermdeckConfig.WS_CODE_UNKNOWN_SESSION)
            return
        await websocket.accept()
        screen_repaint = websocket.query_params.get("screen_repaint", "1").lower() not in {"0", "false", "no", "off"}
        have_buffer = websocket.query_params.get("have_buffer", "0").lower() not in {"0", "false", "no", "off"}
        repaint_preserved_buffer = websocket.query_params.get("repaint_preserved_buffer", "0").lower() not in {"0", "false", "no", "off"}
        scrollback, queue = self.manager.attach_client(session_id, screen_repaint, have_buffer, repaint_preserved_buffer)
        try:
            if not have_buffer:
                scrollback = await self._terminal_first_paint_scrollback(session_id, scrollback)
            await websocket.send_bytes(scrollback)
            await websocket.send_text(json.dumps({WsMessageFields.TYPE: WsMessageFields.DRAFT,
                                                   WsMessageFields.DRAFT: self.manager.session_draft(session_id)}))
            client_pump = asyncio.create_task(self._pump_client_to_pty(websocket, session_id))
            output_pump = asyncio.create_task(self._pump_queue_to_client(websocket, queue))
            done, pending = await asyncio.wait({client_pump, output_pump}, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                pump_error = task.exception()
                if pump_error is not None and not isinstance(pump_error, (WebSocketDisconnect, RuntimeError)):
                    raise pump_error
        finally:
            self.manager.detach_client(session_id, queue)

    async def _terminal_first_paint_scrollback(self, session_id: str, scrollback: bytes) -> bytes:
        if self._terminal_bytes_have_visible_text(scrollback):
            return scrollback
        agent_kind, cwd, agent_session_id = self.manager.session_history_source(session_id)
        if agent_kind != AgentKind.CODEX.value or not agent_session_id:
            return scrollback
        try:
            payload = await asyncio.wait_for(
                asyncio.to_thread(self.transcripts.history_page, agent_kind, cwd, agent_session_id, None, 24),
                timeout=0.15,
            )
        except TimeoutError:
            return scrollback
        turns = [turn for turn in payload.get("turns", [])
                 if turn.get("role") in {"user", "assistant"} and str(turn.get("text", "")).strip()]
        if not turns:
            return scrollback
        lines = ["\x1b[2J\x1b[H\x1b[2mRecent conversation · restoring live terminal…\x1b[0m", ""]
        for turn in turns[-10:]:
            role = "You" if turn["role"] == "user" else "Codex"
            text = re.sub(r"\s+", " ", str(turn["text"])).strip().replace("\x1b", "")
            lines.extend((f"\x1b[1m{role}\x1b[0m", text[:1200], ""))
        return "\r\n".join(lines).encode()

    @staticmethod
    def _terminal_bytes_have_visible_text(data: bytes) -> bool:
        text = data.decode("utf-8", errors="replace")
        text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)
        text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
        text = re.sub(r"\x1b[()][0-2A-Za-z]", "", text)
        return bool("".join(character for character in text if ord(character) >= 0x20).strip())

    async def _ws_status(self, websocket: WebSocket) -> None:
        await websocket.accept()
        queue = self.manager.attach_status_client()
        try:
            for status in self.manager.status_snapshot():
                await websocket.send_text(json.dumps(status))
            while True:
                await websocket.send_text(json.dumps(await queue.get()))
        except WebSocketDisconnect:
            return
        finally:
            self.manager.detach_status_client(queue)

    async def _ws_file_tree(self, websocket: WebSocket) -> None:
        root = websocket.query_params.get("root", "")
        try:
            canonical_root, queue = self.files.subscribe_file_tree(root, asyncio.get_running_loop())
        except (ValueError, FileNotFoundError, NotADirectoryError, PermissionError) as tree_error:
            await websocket.close(code=1008, reason=str(tree_error))
            return
        await websocket.accept()
        try:
            while True:
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=TermdeckConfig.FILE_TREE_WS_HEARTBEAT_SECONDS)
                except TimeoutError:
                    message = {WsMessageFields.TYPE: WsMessageFields.FILE_TREE_PING}
                await websocket.send_text(json.dumps(message))
        except WebSocketDisconnect:
            return
        finally:
            self.files.unsubscribe_file_tree(canonical_root, queue)

    async def _ws_transcript(self, websocket: WebSocket, session_id: str) -> None:
        if not self.manager.has_session(session_id):
            await websocket.close(code=TermdeckConfig.WS_CODE_UNKNOWN_SESSION)
            return
        await websocket.accept()
        try:
            request = json.loads(await websocket.receive_text())
            since_revision = int(request.get(WsMessageFields.REVISION, 0))
        except (WebSocketDisconnect, ValueError, TypeError, json.JSONDecodeError):
            return
        agent_kind, cwd, agent_session_id = self.manager.session_history_source(session_id)
        path, turns, revision, queue = self.transcripts.subscribe(agent_kind, cwd, agent_session_id)
        try:
            if path is not None and revision == 0:
                # Register the queue first, then initialize only a bounded
                # tail. This avoids blocking the first Markdown snapshot on
                # the full 64 MB live-state reload.
                revision = await asyncio.to_thread(self.transcripts.prime_subscription, agent_kind, path)
            updates = self.transcripts.updates_since(path, since_revision)
            if since_revision > 0 and since_revision == revision:
                await websocket.send_text(json.dumps({WsMessageFields.TYPE: WsMessageFields.TRANSCRIPT_READY,
                                                       WsMessageFields.SESSION_ID: session_id,
                                                       WsMessageFields.REVISION: revision}))
            elif since_revision > 0 and updates is not None:
                for update in updates:
                    message = dict(update)
                    message[WsMessageFields.SESSION_ID] = session_id
                    await websocket.send_text(json.dumps(message))
            else:
                page = await asyncio.to_thread(self.transcripts.history_page, agent_kind, cwd, agent_session_id)
                await self._send_transcript_snapshot(websocket, session_id, revision, page["turns"],
                                                      before=page.get("before"), has_more=bool(page.get("has_more")))
            while True:
                update = await queue.get()
                update[WsMessageFields.SESSION_ID] = session_id
                await websocket.send_text(json.dumps(update))
        except WebSocketDisconnect:
            return
        finally:
            self.transcripts.unsubscribe(path, queue)

    async def _send_transcript_snapshot(self, websocket: WebSocket, session_id: str,
                                        revision: int, turns: list[dict[str, object]],
                                        before: int | None = None, has_more: bool = False) -> None:
        """Send large transcript snapshots in browser-friendly frames.

        Long Codex sessions contain many collapsed tool/result blocks. Sending
        all of them as one JSON WebSocket message can exceed the browser's
        frame limit and leaves Markdown stuck on its previous partial render.
        Keep each frame comfortably below 1 MB; the client reassembles the
        ordered chunks before applying the authoritative snapshot.
        """
        chunk_limit = 256_000
        chunks: list[list[dict[str, object]]] = []
        current: list[dict[str, object]] = []
        current_size = 2
        for turn in turns:
            turn_size = len(json.dumps(turn, ensure_ascii=False, separators=(",", ":"))) + 1
            if current and current_size + turn_size > chunk_limit:
                chunks.append(current)
                current = []
                current_size = 2
            current.append(turn)
            current_size += turn_size
        if current or not chunks:
            chunks.append(current)
        await websocket.send_text(json.dumps({WsMessageFields.TYPE: WsMessageFields.TRANSCRIPT_SNAPSHOT_START,
                                               WsMessageFields.SESSION_ID: session_id,
                                               WsMessageFields.REVISION: revision,
                                               "before": before,
                                               "has_more": has_more,
                                               "chunks": len(chunks)}))
        for index, chunk in enumerate(chunks):
            await websocket.send_text(json.dumps({WsMessageFields.TYPE: WsMessageFields.TRANSCRIPT_SNAPSHOT_CHUNK,
                                                   WsMessageFields.SESSION_ID: session_id,
                                                   "index": index,
                                                   WsMessageFields.TURNS: chunk},
                                                  ensure_ascii=False, separators=(",", ":")))
        await websocket.send_text(json.dumps({WsMessageFields.TYPE: WsMessageFields.TRANSCRIPT_SNAPSHOT_END,
                                               WsMessageFields.SESSION_ID: session_id,
                                               WsMessageFields.REVISION: revision,
                                               "before": before,
                                               "has_more": has_more,
                                               "chunks": len(chunks)}))

    async def _pump_client_to_pty(self, websocket: WebSocket, session_id: str) -> None:
        while True:
            try:
                raw = await websocket.receive_text()
            except WebSocketDisconnect:
                return
            message = json.loads(raw)
            message_type = message[WsMessageFields.TYPE]
            if message_type == WsMessageFields.INPUT:
                self.manager.write_input(session_id, message[WsMessageFields.DATA])
            elif message_type == WsMessageFields.RESIZE:
                self.manager.resize(session_id, int(message[WsMessageFields.COLS]), int(message[WsMessageFields.ROWS]))
            elif message_type == WsMessageFields.REPAINT:
                self.manager.request_screen_repaint(session_id)
            elif message_type == WsMessageFields.DRAFT_SYNC:
                self.manager.set_draft(session_id, message.get(WsMessageFields.DRAFT, ""))
            elif message_type == WsMessageFields.SUBMIT:
                await self.manager.submit_prompt(session_id, message.get(WsMessageFields.TEXT, ""),
                                                 bool(message.get("bracketed", False)),
                                                 bool(message.get("queue", False)))
            elif message_type == WsMessageFields.QUEUE_EDIT:
                await self.manager.edit_queued_prompt(
                    session_id,
                    int(message.get(WsMessageFields.INDEX, -1)),
                    message.get(WsMessageFields.QUEUE, []),
                    message.get(WsMessageFields.TEXT, ""),
                    bool(message.get(WsMessageFields.REMOVE, False)),
                    bool(message.get("bracketed", False)),
                )

    async def _pump_queue_to_client(self, websocket: WebSocket, queue: asyncio.Queue) -> None:
        while True:
            item = await queue.get()
            if isinstance(item, bytes):
                await websocket.send_bytes(item)
            else:
                await websocket.send_text(json.dumps(item))

    def run(self) -> None:
        TermdeckConfig.DATA_DIR.mkdir(parents=True, exist_ok=True)
        uvicorn.run(self.build_app(), host=TermdeckConfig.HOST, port=TermdeckConfig.PORT,
                    log_level=TermdeckConfig.UVICORN_LOG_LEVEL, access_log=False)
