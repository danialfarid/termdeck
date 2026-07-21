import asyncio
import json
import re
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from termdeck.config import TermdeckConfig
from termdeck.file_service import ProjectFileService
from termdeck.models import ApiFields, WsMessageFields
from termdeck.search_service import ProjectSearchService
from termdeck.session_manager import TerminalSessionManager
from termdeck.settings_store import UiSettingsStore
from termdeck.stats_service import ResourceStatsService
from termdeck.transcript_service import TranscriptService


class CreateSessionRequest(BaseModel):
    command: str = ""
    cwd: str = ""
    title: str = ""
    model: str = ""
    permission: str = ""
    session_ref: str = ""


class RenameSessionRequest(BaseModel):
    title: str


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
    session_order: list[str] = []
    pinned_sessions: list[str] = []
    unread_sessions: list[str] = []


class UiSettings(BaseModel):
    sidebar_width: int = 250
    files_width: int = 380
    sidebar_font_size: int = 13
    terminal_font_size: int = 13
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
    tree_sort: str = "name"
    show_mtime: bool = False
    word_wrap: bool = False
    search_glob: str = "!*.json, !*.csv"
    keybindings: dict[str, str] = {}
    last_command: str = "codex"
    last_model: str = "codex"
    last_permissions: dict[str, str] = {}
    show_terminal_icons: bool = False
    history_mode: bool = False
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
        self.settings_store = UiSettingsStore(TermdeckConfig.SETTINGS_FILE)

    @asynccontextmanager
    async def _lifespan(self, _app: FastAPI) -> AsyncGenerator[None]:
        await self.manager.startup_respawn_saved_sessions()
        self.manager.start_background_tasks()
        try:
            yield
        finally:
            self.manager.stop_background_tasks()
            self.manager.terminate_all()

    def build_app(self) -> FastAPI:
        app = FastAPI(lifespan=self._lifespan)
        app.middleware("http")(self._no_cache_middleware)
        app.mount(TermdeckConfig.STATIC_ROUTE, StaticFiles(directory=TermdeckConfig.STATIC_DIR), name=TermdeckConfig.STATIC_NAME)
        app.get("/", response_model=None)(self._index)
        app.get(TermdeckConfig.PROJECT_PAGE_ROUTE, response_model=None)(self._project_page)
        app.get(TermdeckConfig.API_PROJECTS_ROUTE, response_model=None)(self._list_projects)
        app.get(TermdeckConfig.API_SESSIONS_ROUTE, response_model=None)(self._list_sessions)
        app.post(TermdeckConfig.API_SESSIONS_ROUTE, response_model=None)(self._create_session)
        app.post(TermdeckConfig.API_SESSION_RESTART_ROUTE, response_model=None)(self._restart_session)
        app.post(TermdeckConfig.API_SESSION_FORK_ROUTE, response_model=None)(self._fork_session)
        app.post(TermdeckConfig.API_SESSION_RENAME_ROUTE, response_model=None)(self._rename_session)
        app.get(TermdeckConfig.API_SESSION_HISTORY_ROUTE, response_model=None)(self._session_history)
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
        if not q.strip():
            return []
        try:
            return await self.search.find_files(root, q, ignore)
        except (ValueError, FileNotFoundError, PermissionError) as find_error:
            raise HTTPException(status_code=404, detail=str(find_error)) from find_error

    async def _resource_stats(self) -> dict[str, object]:
        return await self.stats.sample(self.manager.session_dtach_sockets())

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

    async def _list_sessions(self, project: str = "") -> list[dict[str, object]]:
        return self.manager.list_sessions(project or None)

    async def _create_session(self, request: CreateSessionRequest) -> dict[str, object]:
        try:
            command = request.command
            if request.model.strip():
                command = self.manager.command_for_new_session(request.model, request.permission, request.session_ref)
            ms = self.manager.create_session(command, request.cwd, request.title)
        except ValueError as bad_request:
            raise HTTPException(status_code=400, detail=str(bad_request)) from bad_request
        return self.manager.session_summary(ms)

    async def _session_history(self, session_id: str) -> list[dict[str, str]]:
        if not self.manager.has_session(session_id):
            raise HTTPException(status_code=404, detail=session_id)
        agent_kind, cwd, agent_session_id = self.manager.session_history_source(session_id)
        return self.transcripts.transcript_for(agent_kind, cwd, agent_session_id)

    async def _restart_session(self, session_id: str) -> dict[str, object]:
        if not self.manager.has_session(session_id):
            raise HTTPException(status_code=404, detail=session_id)
        await self.manager.restart_session(session_id)
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

    async def _delete_session(self, session_id: str) -> dict[str, object]:
        if not self.manager.has_session(session_id):
            raise HTTPException(status_code=404, detail=session_id)
        await self.manager.delete_session(session_id)
        return {ApiFields.DELETED: session_id}

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
