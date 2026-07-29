import asyncio
import json
import re
import subprocess
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from termdeck.config import TermdeckConfig
from termdeck.file_service import ProjectFileService
from termdeck.history_index import HistorySearchIndex
from termdeck.models import ApiFields, WsMessageFields
from termdeck.platform_paths import PlatformPaths
from termdeck.search_service import ProjectSearchService
from termdeck.session_manager import TerminalSessionManager
from termdeck.settings_store import UiSettingsStore
from termdeck.stats_service import ResourceStatsService
from termdeck.transcript_service import TranscriptService


class CreateSessionRequest(BaseModel):
    command: str = ""
    cwd: str = ""
    title: str = ""
    project: str = ""
    model: str = ""
    permission: str = ""
    session_ref: str = ""
    after: str | None = None


class ProjectRegistrationRequest(BaseModel):
    root: str
    name: str = ""


class SubmitPromptRequest(BaseModel):
    text: str
    bracketed: bool = True
    queue: bool = False


class BatchTerminalSpec(BaseModel):
    name: str
    prompt: str | None = None
    cwd: str | None = None
    project: str | None = None
    model: str | None = None
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
    permission: str = "default"
    bracketed: bool = True
    queue: bool = False
    after: str | None = None


class RenameSessionRequest(BaseModel):
    title: str


class MoveSessionProjectRequest(BaseModel):
    project: str


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


class ReplaceRequest(BaseModel):
    root: str
    q: str
    glob: str = ""
    ignore: str = ""
    word: bool = False
    case_sensitive: bool = False
    regex: bool = False
    replacement: str = ""


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
    hide_excluded: bool = False
    show_stats: bool = True
    show_mtime: bool = True
    show_git_status: bool = True
    recent_exclude: str = ""
    word_wrap: bool = False
    search_glob: str = "!*.json, !*.csv"
    keybindings: dict[str, str] = {}
    vscode_keybindings: dict[str, str] = {}
    last_command: str = "codex"
    last_model: str = "codex"
    last_permissions: dict[str, str] = {}
    show_terminal_icons: bool = False
    history_mode: bool = False
    notebook_open: bool = False
    notebook_preview: bool = False
    notebook_text: str = ""
    files_pinned: bool = False
    sidebar_text_color: str = "#d5dbe5"
    side_full: bool = False
    side_split: float = 0.55
    side_split_user_set: bool = False


class TermdeckServer:
    """HTTP + websocket surface of the mini terminal IDE: session CRUD API, static UI, one websocket per terminal.
    Terminal websocket protocol: server sends raw output as binary frames (scrollback replay first) and control
    events as JSON text frames; client sends JSON text frames for input and resize."""

    def __init__(self) -> None:
        self.manager = TerminalSessionManager()
        self.files = ProjectFileService()
        self.search = ProjectSearchService(self.files)
        self.stats = ResourceStatsService()
        self.transcripts = TranscriptService()
        self.history_index = HistorySearchIndex(TermdeckConfig.HISTORY_INDEX_FILE)
        self.manager.attach_transcript_service(self.transcripts)
        self.manager.attach_history_index(self.history_index)
        self.transcripts.add_file_change_listener(self.history_index.notify_file_changed)
        self.settings_store = UiSettingsStore(TermdeckConfig.SETTINGS_FILE)

    @asynccontextmanager
    async def _lifespan(self, _app: FastAPI) -> AsyncGenerator[None]:
        await self.manager.startup_respawn_saved_sessions()
        self.manager.start_background_tasks()
        self.transcripts.start(asyncio.get_running_loop())
        self.history_index.start()
        try:
            yield
        finally:
            self.history_index.stop()
            self.transcripts.stop()
            self.manager.stop_background_tasks()
            self.manager.detach_for_shutdown()
            self.files.close()

    def build_app(self) -> FastAPI:
        app = FastAPI(lifespan=self._lifespan)
        app.middleware("http")(self._no_cache_middleware)
        app.mount(TermdeckConfig.STATIC_ROUTE, StaticFiles(directory=TermdeckConfig.STATIC_DIR), name=TermdeckConfig.STATIC_NAME)
        app.get("/", response_model=None)(self._index)
        app.get(TermdeckConfig.PROJECT_PAGE_ROUTE, response_model=None)(self._project_page)
        app.get(TermdeckConfig.API_PROJECTS_ROUTE, response_model=None)(self._list_projects)
        app.post(TermdeckConfig.API_PROJECTS_ROUTE, response_model=None)(self._add_project)
        app.post(TermdeckConfig.API_PROJECT_FOLDER_PICKER_ROUTE, response_model=None)(self._pick_project_folder)
        app.get(TermdeckConfig.API_SESSIONS_ROUTE, response_model=None)(self._list_sessions)
        app.post(TermdeckConfig.API_SESSIONS_ROUTE, response_model=None)(self._create_session)
        app.post(TermdeckConfig.API_TERMINALS_BATCH_ROUTE, response_model=None)(self._launch_terminal_batch)
        app.post(TermdeckConfig.API_SESSION_RESTART_ROUTE, response_model=None)(self._restart_session)
        app.post(TermdeckConfig.API_SESSION_FORK_ROUTE, response_model=None)(self._fork_session)
        app.post(TermdeckConfig.API_SESSION_RENAME_ROUTE, response_model=None)(self._rename_session)
        app.post(TermdeckConfig.API_SESSION_PROJECT_ROUTE, response_model=None)(self._move_session_to_project)
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
        app.get(TermdeckConfig.API_FILE_LIST_ROUTE, response_model=None)(self._list_files)
        app.get(TermdeckConfig.API_FILE_RECENT_ROUTE, response_model=None)(self._recent_files)
        app.get(TermdeckConfig.API_FILE_READ_ROUTE, response_model=None)(self._read_file)
        app.get(TermdeckConfig.API_FILE_SEARCH_ROUTE, response_model=None)(self._search_files)
        app.get(TermdeckConfig.API_FILE_FIND_ROUTE, response_model=None)(self._find_files)
        app.post(TermdeckConfig.API_UPLOAD_ROUTE, response_model=None)(self._upload_file)
        app.post(TermdeckConfig.API_FILE_WRITE_ROUTE, response_model=None)(self._write_file)
        app.post(TermdeckConfig.API_FILE_REPLACE_ROUTE, response_model=None)(self._replace_in_files)
        app.post(TermdeckConfig.API_FILE_RENAME_ROUTE, response_model=None)(self._rename_file)
        app.post(TermdeckConfig.API_FILE_MOVE_ROUTE, response_model=None)(self._move_file)
        app.post(TermdeckConfig.API_FILE_DELETE_ROUTE, response_model=None)(self._delete_file)
        app.get(TermdeckConfig.API_STATS_ROUTE, response_model=None)(self._resource_stats)
        app.websocket(TermdeckConfig.STATUS_WS_ROUTE)(self._ws_status)
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
        payload = settings.model_dump()
        self.settings_store.save(payload)
        return payload

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

    async def _read_file(self, root: str, path: str) -> dict[str, object]:
        try:
            return self.files.read_file(root, path)
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

    async def _find_files(self, root: str, q: str, ignore: str = "") -> list[dict[str, str]]:
        try:
            return await self.search.find_files(root, q, ignore)
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
            return self.files.write_file(request.root, request.path, request.content)
        except (ValueError, FileNotFoundError, PermissionError, OSError) as write_error:
            raise HTTPException(status_code=400, detail=str(write_error)) from write_error

    async def _replace_in_files(self, request: ReplaceRequest) -> dict[str, int]:
        if not request.q.strip():
            raise HTTPException(status_code=400, detail="empty query")
        try:
            return await self.search.replace_all(request.root, request.q, request.glob, request.ignore,
                                                 request.word, request.case_sensitive, request.regex,
                                                 request.replacement)
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
        return FileResponse(TermdeckConfig.STATIC_DIR / TermdeckConfig.INDEX_FILE)

    async def _project_page(self, project_name: str) -> FileResponse:
        if self.manager.registry.root_for(project_name) is None:
            raise HTTPException(status_code=404, detail=project_name)
        return FileResponse(TermdeckConfig.STATIC_DIR / TermdeckConfig.INDEX_FILE)

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

    async def _create_session(self, request: CreateSessionRequest) -> dict[str, object]:
        try:
            command = request.command
            if request.model.strip():
                command = self.manager.command_for_new_session(request.model, request.permission, request.session_ref)
            ms = self.manager.create_session(
                command, request.cwd, request.title, request.project,
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

    async def _submit_prompt(self, session_id: str, request: SubmitPromptRequest) -> dict[str, object]:
        if not self.manager.has_session(session_id):
            raise HTTPException(status_code=404, detail=session_id)
        if not request.text.strip():
            raise HTTPException(status_code=400, detail="prompt text cannot be empty")
        try:
            self.manager.ensure_session_running(session_id)
            await self.manager.submit_prompt(session_id, request.text, request.bracketed, request.queue)
        except ValueError as prompt_error:
            raise HTTPException(status_code=409, detail=str(prompt_error)) from prompt_error
        return {"session": self.manager.session_summary_by_id(session_id), "prompt_submitted": True,
                "queued": request.queue}

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
                permission = request.permission if item.permission is None else item.permission
                cwd = request.cwd if item.cwd is None else item.cwd
                project = request.project if item.project is None else item.project
                session_ref = item.session_ref or ""
                bracketed = request.bracketed if item.bracketed is None else item.bracketed
                queue = request.queue if item.queue is None else item.queue
                command = self.manager.command_for_new_session(model, permission, session_ref)
                ms = self.manager.create_session(
                    command, cwd, name, project,
                    agent_rename=name if not session_ref.strip() else None,
                )
                result["session"] = self.manager.session_summary(ms)

                placement_after = request.after if item.after is None else item.after
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

    async def _restart_session(self, session_id: str) -> dict[str, object]:
        if not self.manager.has_session(session_id):
            raise HTTPException(status_code=404, detail=session_id)
        try:
            await self.manager.restart_session(session_id)
        except RuntimeError as restart_error:
            raise HTTPException(status_code=409, detail=str(restart_error)) from restart_error
        return self.manager.session_summary_by_id(session_id)

    async def _fork_session(self, session_id: str, request: RenameSessionRequest) -> dict[str, object]:
        if not self.manager.has_session(session_id):
            raise HTTPException(status_code=404, detail=session_id)
        return self.manager.session_summary(self.manager.fork_session(session_id, request.title))

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

    async def _delete_session(self, session_id: str) -> dict[str, object]:
        if not self.manager.has_session(session_id):
            raise HTTPException(status_code=404, detail=session_id)
        socket_removed = await self.manager.delete_session(session_id)
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
        scrollback, queue = self.manager.attach_client(session_id)
        try:
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
