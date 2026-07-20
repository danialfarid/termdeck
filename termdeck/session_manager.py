import asyncio
import functools
import os
import signal
import subprocess
import time
import uuid
from pathlib import Path

from termdeck.agent_session_tracker import AgentSessionTracker
from termdeck.config import TermdeckConfig
from termdeck.proc_tree import ProcTreeUtil
from termdeck.draft_tracker import DraftInputTracker
from termdeck.models import AgentKind, ApiFields, SessionRecord, WsMessageFields
from termdeck.project_registry import ProjectRegistry
from termdeck.pty_process import PtyProcess
from termdeck.session_store import ClosedSessionStore, SessionStore
from termdeck.util import OscTitleParser, TimeUtil


class ManagedSession:
    """Runtime state for one terminal: persisted record, live pty (if running), scrollback, attached client queues."""

    def __init__(self, record: SessionRecord) -> None:
        self.record = record
        self.proc: PtyProcess | None = None
        self.buffer = bytearray()
        self.client_queues: set[asyncio.Queue] = set()
        self.exit_code: int | None = None
        self.detect_task: asyncio.Task | None = None
        self.detect_kind: AgentKind = AgentKind.NONE
        self.detect_baseline: set[Path] = set()
        self.cols = TermdeckConfig.INITIAL_COLS
        self.rows = TermdeckConfig.INITIAL_ROWS
        self.cli_title: str | None = None
        self.title_carry = b""
        self.title_recovered_from_buffer = False
        self.osc_query_carry = b""
        self.last_repaint_offset: int | None = None
        self.draft_tracker = DraftInputTracker(record.draft)
        self.last_input_monotonic = 0.0

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.alive


class TerminalSessionManager:
    """Creates, respawns, and tears down terminal sessions; broadcasts pty output to attached websocket queues;
    persists session records and resolves claude/codex agent session ids so a server restart can resume them."""

    def __init__(self) -> None:
        self._store = SessionStore(TermdeckConfig.SESSIONS_FILE)
        self._closed_store = ClosedSessionStore(TermdeckConfig.CLOSED_SESSIONS_FILE)
        self.registry = ProjectRegistry(TermdeckConfig.PROJECTS_FILE)
        self._tracker = AgentSessionTracker()
        self._sessions: dict[str, ManagedSession] = {}
        self._draft_persist_task: asyncio.Task | None = None

    async def startup_respawn_saved_sessions(self) -> None:
        for record in self._store.load_all():
            ms = ManagedSession(record)
            self._sessions[record.session_id] = ms
            saved = TermdeckConfig.SCROLLBACK_DIR / f"{record.session_id}{TermdeckConfig.SCROLLBACK_SUFFIX}"
            if saved.exists():
                ms.buffer.extend(saved.read_bytes()[-TermdeckConfig.SCROLLBACK_BYTES:])
                saved.unlink()
            self._recover_title_from_buffer(ms)
            self._spawn(ms, resume=True)

    def create_session(self, command: str, cwd: str, title: str) -> ManagedSession:
        clean_command = command.strip()
        cwd_path = Path(cwd).expanduser() if cwd.strip() else TermdeckConfig.DEFAULT_CWD
        if not cwd_path.is_dir():
            raise ValueError(f"cwd is not a directory: {cwd_path}")
        return self._create(clean_command, cwd_path, title, initial_command=None)

    def _create(self, clean_command: str, cwd_path: Path, title: str, initial_command: str | None) -> ManagedSession:
        kind = self._tracker.detect_agent_kind(clean_command)
        record = SessionRecord(session_id=uuid.uuid4().hex[:12], title=title.strip() or self._auto_title(clean_command, cwd_path),
                               title_user_set=bool(title.strip()), command=clean_command, cwd=str(cwd_path),
                               agent_kind=kind.value, agent_session_id=None, created_at_est=TimeUtil.now_est_naive_iso(),
                               draft="", project=self.registry.ensure_project_for_cwd(cwd_path))
        ms = ManagedSession(record)
        self._sessions[record.session_id] = ms
        self._spawn(ms, resume=False, initial_command=initial_command)
        self._persist()
        return ms

    def fork_session(self, session_id: str, title: str) -> ManagedSession:
        src = self._sessions[session_id].record
        kind = AgentKind(src.agent_kind)
        if kind is not AgentKind.NONE and src.agent_session_id:
            initial = self._tracker.build_fork_command(kind, src.command, src.agent_session_id)
        else:
            initial = None
        return self._create(src.command, Path(src.cwd), title, initial_command=initial)

    @staticmethod
    def _auto_title(command: str, cwd: Path) -> str:
        head = Path(command.split()[0]).name if command else Path(TermdeckConfig.SHELL).name
        return f"{head} · {cwd.name}"

    def _spawn(self, ms: ManagedSession, resume: bool, initial_command: str | None = None) -> None:
        kind = AgentKind(ms.record.agent_kind)
        socket = self._dtach_socket(ms.record.session_id)
        reattach = resume and self._dtach_socket_live(socket)
        command = ms.record.command
        if initial_command is not None and not reattach:
            command = initial_command
        elif resume and not reattach and kind is not AgentKind.NONE and ms.record.agent_session_id:
            command = self._tracker.build_resume_command(kind, ms.record.command, ms.record.agent_session_id)
        baseline = self._tracker.snapshot_session_files(kind, Path(ms.record.cwd)) if kind is not AgentKind.NONE else set()
        if ms.buffer:
            divider = TermdeckConfig.REATTACH_DIVIDER if reattach else TermdeckConfig.RESPAWN_DIVIDER
            self._handle_output(ms, ("\r\n" * ms.rows + divider + "\r\n").encode())
        elif not reattach:
            self._handle_output(ms, TermdeckConfig.SPAWN_BANNER_TEMPLATE.format(command=command or TermdeckConfig.SHELL).encode())
        ms.exit_code = None
        try:
            ms.proc = PtyProcess(command, Path(ms.record.cwd), ms.cols, ms.rows,
                                 functools.partial(self._handle_output, ms), functools.partial(self._handle_exit, ms),
                                 dtach_socket=socket)
        except (FileNotFoundError, NotADirectoryError, PermissionError) as spawn_error:
            ms.exit_code = TermdeckConfig.EXIT_CODE_SPAWN_FAILED
            self._handle_output(ms, TermdeckConfig.SPAWN_ERROR_TEMPLATE.format(error=spawn_error).encode())
            return
        if kind is not AgentKind.NONE:
            ms.detect_kind = kind
            ms.detect_baseline = baseline
            self._schedule_detection(ms, TermdeckConfig.AGENT_DETECT_INITIAL_DELAY_SECONDS)
        if resume and not reattach and ms.record.draft:
            asyncio.create_task(self._replay_draft_into_respawn(ms, ms.proc))

    @staticmethod
    def _dtach_socket_live(socket: Path) -> bool:
        if not socket.exists():
            return False
        try:
            result = subprocess.run([TermdeckConfig.LSOF_BIN, "-t", str(socket)], capture_output=True,
                                    timeout=TermdeckConfig.SUBPROCESS_TIMEOUT_SECONDS)
        except (subprocess.SubprocessError, OSError):
            return False
        return bool(result.stdout.strip())

    def _schedule_detection(self, ms: ManagedSession, delay: float) -> None:
        if ms.detect_kind is AgentKind.NONE:
            return
        if ms.detect_task is not None and not ms.detect_task.done():
            ms.detect_task.cancel()
        ms.detect_task = asyncio.create_task(self._detect_after(ms, delay))

    async def _detect_after(self, ms: ManagedSession, delay: float) -> None:
        await asyncio.sleep(delay)
        proc = ms.proc
        if proc is None or not proc.alive:
            return
        kind = ms.detect_kind
        socket = self._dtach_socket(ms.record.session_id)
        found = await self._tracker.session_id_from_open_files(kind, socket)
        recent_input = (time.monotonic() - ms.last_input_monotonic) < TermdeckConfig.AGENT_DIR_CLAIM_INPUT_WINDOW_SECONDS
        dir_found = self._tracker.absorb_and_find_new_session_file(kind, Path(ms.record.cwd), ms.detect_baseline,
                                                                   self._claimed_agent_ids(ms),
                                                                   claim_allowed=found is None and recent_input)
        if found is None:
            found = dir_found
        if found is not None and found != ms.record.agent_session_id:
            ms.record.agent_session_id = found
            self._persist()
            self._broadcast_control(ms, {WsMessageFields.TYPE: WsMessageFields.AGENT_SESSION,
                                         WsMessageFields.AGENT_SESSION_ID: found})

    def _claimed_agent_ids(self, exclude: ManagedSession) -> set[str]:
        return {ms.record.agent_session_id for ms in self._sessions.values()
                if ms is not exclude and ms.record.agent_session_id is not None}

    def _append_collapsing_repaints(self, ms: ManagedSession, data: bytes) -> None:
        """TUI agents repaint their status area ~10x/s inside synchronized-update markers; storing every frame
        burns the scrollback in minutes and adds nothing (each frame fully redraws the same region). Consecutive
        whole-frame repaints therefore replace the previous stored frame instead of appending."""
        is_repaint_frame = data.startswith(TermdeckConfig.SYNC_UPDATE_START) and \
            data.rstrip(b"\r\n").endswith(TermdeckConfig.SYNC_UPDATE_END)
        if is_repaint_frame and ms.last_repaint_offset is not None and ms.last_repaint_offset <= len(ms.buffer):
            del ms.buffer[ms.last_repaint_offset:]
        ms.last_repaint_offset = len(ms.buffer) if is_repaint_frame else None
        ms.buffer.extend(data)
        overflow = len(ms.buffer) - TermdeckConfig.SCROLLBACK_BYTES
        if overflow > 0:
            del ms.buffer[:overflow]
            if ms.last_repaint_offset is not None:
                ms.last_repaint_offset = max(0, ms.last_repaint_offset - overflow)

    def _answer_and_strip_color_queries(self, ms: ManagedSession, data: bytes) -> bytes:
        data = ms.osc_query_carry + data
        ms.osc_query_carry = b""
        for query, response in TermdeckConfig.OSC_COLOR_QUERY_RESPONSES:
            if query in data:
                data = data.replace(query, b"")
                if ms.proc is not None:
                    ms.proc.write(response)
        tail_keep = 0
        for query, _ in TermdeckConfig.OSC_COLOR_QUERY_RESPONSES:
            for length in range(1, min(len(query), TermdeckConfig.OSC_QUERY_CARRY_MAX, len(data)) + 1):
                if length < len(query) and data.endswith(query[:length]):
                    tail_keep = max(tail_keep, length)
        if tail_keep:
            ms.osc_query_carry = data[-tail_keep:]
            data = data[:-tail_keep]
        return data

    def _handle_output(self, ms: ManagedSession, data: bytes) -> None:
        data = self._answer_and_strip_color_queries(ms, data)
        if not data:
            return
        self._append_collapsing_repaints(ms, data)
        cli_title, ms.title_carry = OscTitleParser.extract_latest_title(ms.title_carry, data)
        if cli_title is not None and cli_title.strip():
            ms.cli_title = cli_title.strip()
        for queue in list(ms.client_queues):
            queue.put_nowait(data)

    def _recover_title_from_buffer(self, ms: ManagedSession) -> None:
        if ms.cli_title is not None:
            return
        if not ms.title_recovered_from_buffer:
            ms.title_recovered_from_buffer = True
            if ms.buffer:
                cli_title = OscTitleParser.extract_latest_title_from_buffer(bytes(ms.buffer))
                if cli_title is not None and cli_title.strip():
                    ms.cli_title = cli_title.strip()
        if ms.cli_title is None and ms.record.agent_kind == AgentKind.CODEX:
            ms.cli_title = self._tracker.codex_thread_name(ms.record.agent_session_id)

    def _handle_exit(self, ms: ManagedSession, proc: PtyProcess, exit_code: int) -> None:
        if ms.proc is not proc:
            return
        ms.proc = None
        ms.exit_code = exit_code
        self._broadcast_control(ms, {WsMessageFields.TYPE: WsMessageFields.EXIT, WsMessageFields.CODE: exit_code})

    def _broadcast_control(self, ms: ManagedSession, payload: dict[str, object]) -> None:
        for queue in list(ms.client_queues):
            queue.put_nowait(payload)

    def has_session(self, session_id: str) -> bool:
        return session_id in self._sessions

    def attach_client(self, session_id: str) -> tuple[bytes, asyncio.Queue]:
        ms = self._sessions[session_id]
        queue: asyncio.Queue = asyncio.Queue()
        ms.client_queues.add(queue)
        return bytes(ms.buffer), queue

    def detach_client(self, session_id: str, queue: asyncio.Queue) -> None:
        ms = self._sessions.get(session_id)
        if ms is not None:
            ms.client_queues.discard(queue)

    def write_input(self, session_id: str, text: str) -> None:
        ms = self._sessions[session_id]
        if ms.proc is not None:
            ms.proc.write(text.encode())
        ms.last_input_monotonic = time.monotonic()
        if ms.detect_kind is not AgentKind.NONE:
            self._schedule_detection(ms, TermdeckConfig.AGENT_DETECT_INPUT_DEBOUNCE_SECONDS)
        ms.draft_tracker.feed(text)
        new_draft = ms.draft_tracker.draft
        if new_draft != ms.record.draft:
            ms.record.draft = new_draft
            self._schedule_draft_persist()

    def _schedule_draft_persist(self) -> None:
        if self._draft_persist_task is None or self._draft_persist_task.done():
            self._draft_persist_task = asyncio.create_task(self._persist_after_debounce())

    async def _persist_after_debounce(self) -> None:
        await asyncio.sleep(TermdeckConfig.DRAFT_PERSIST_DEBOUNCE_SECONDS)
        self._persist()

    async def _replay_draft_into_respawn(self, ms: ManagedSession, proc: PtyProcess) -> None:
        is_agent = ms.record.agent_kind != AgentKind.NONE.value
        delay = TermdeckConfig.DRAFT_REPLAY_DELAY_AGENT_SECONDS if is_agent else TermdeckConfig.DRAFT_REPLAY_DELAY_SHELL_SECONDS
        await asyncio.sleep(delay)
        if ms.proc is not proc or not proc.alive or not ms.record.draft:
            return
        proc.write(TermdeckConfig.BRACKETED_PASTE_START + ms.record.draft.encode() + TermdeckConfig.BRACKETED_PASTE_END)

    def resize(self, session_id: str, cols: int, rows: int) -> None:
        ms = self._sessions[session_id]
        ms.cols, ms.rows = cols, rows
        if ms.proc is not None:
            ms.proc.resize(cols, rows)

    async def restart_session(self, session_id: str) -> None:
        ms = self._sessions[session_id]
        if ms.detect_task is not None:
            ms.detect_task.cancel()
        await self._terminate_proc(ms)
        self._spawn(ms, resume=True)

    def rename_session(self, session_id: str, title: str) -> None:
        ms = self._sessions[session_id]
        ms.record.title = title.strip() or ms.record.title
        ms.record.title_user_set = True
        self._persist()

    async def delete_session(self, session_id: str) -> None:
        ms = self._sessions.pop(session_id)
        if ms.detect_task is not None:
            ms.detect_task.cancel()
        await self._terminate_proc(ms)
        self._broadcast_control(ms, {WsMessageFields.TYPE: WsMessageFields.DELETED})
        if not ms.record.title_user_set and ms.cli_title:
            ms.record.title = ms.cli_title
        self._closed_store.push(ms.record, TimeUtil.now_est_naive_iso())
        self._persist()

    def list_closed_sessions(self, project: str | None) -> list[dict[str, str | bool | None]]:
        items = self._closed_store.load_all()
        if project is None:
            return items
        return [item for item in items if item["project"] == project]

    def reopen_closed_session(self, session_id: str) -> ManagedSession:
        record = self._closed_store.pop(session_id)
        if record is None:
            raise KeyError(session_id)
        ms = ManagedSession(record)
        self._sessions[record.session_id] = ms
        self._spawn(ms, resume=True)
        self._persist()
        return ms

    def purge_closed_session(self, session_id: str) -> None:
        self._closed_store.remove(session_id)

    def _dtach_socket(self, session_id: str) -> Path:
        TermdeckConfig.DTACH_DIR.mkdir(parents=True, exist_ok=True)
        return TermdeckConfig.DTACH_DIR / f"{session_id}{TermdeckConfig.DTACH_SOCKET_SUFFIX}"

    def session_dtach_sockets(self) -> dict[str, str]:
        return {sid: str(self._dtach_socket(sid)) for sid, ms in self._sessions.items()
                if ms.proc is not None and ms.proc.alive}

    async def _kill_dtach_session(self, session_id: str) -> None:
        tree_pids = await ProcTreeUtil.tree_pids_for_socket(str(self._dtach_socket(session_id)))
        for signal_number in (signal.SIGTERM, signal.SIGKILL):
            alive = [pid for pid in tree_pids if self._pid_alive(pid)]
            if not alive:
                return
            for pid in alive:
                self._signal_pid(pid, signal_number)
            for _ in range(TermdeckConfig.KILL_GRACE_POLLS):
                if not any(self._pid_alive(pid) for pid in alive):
                    return
                await asyncio.sleep(TermdeckConfig.KILL_GRACE_POLL_SECONDS)

    @staticmethod
    def _pid_alive(pid: int) -> bool:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    @staticmethod
    def _signal_pid(pid: int, signal_number: int) -> None:
        try:
            os.kill(pid, signal_number)
        except ProcessLookupError:
            pass

    async def _terminate_proc(self, ms: ManagedSession) -> None:
        proc = ms.proc
        if proc is None:
            return
        await self._kill_dtach_session(ms.record.session_id)
        proc.terminate()
        for _ in range(TermdeckConfig.KILL_GRACE_POLLS):
            if proc.finished:
                return
            await asyncio.sleep(TermdeckConfig.KILL_GRACE_POLL_SECONDS)
        proc.kill()
        for _ in range(TermdeckConfig.KILL_GRACE_POLLS):
            if proc.finished:
                return
            await asyncio.sleep(TermdeckConfig.KILL_GRACE_POLL_SECONDS)

    def terminate_all(self) -> None:
        self._persist()
        TermdeckConfig.SCROLLBACK_DIR.mkdir(parents=True, exist_ok=True)
        for ms in self._sessions.values():
            if ms.detect_task is not None:
                ms.detect_task.cancel()
            if ms.proc is not None:
                ms.proc.terminate()
            if ms.buffer:
                target = TermdeckConfig.SCROLLBACK_DIR / f"{ms.record.session_id}{TermdeckConfig.SCROLLBACK_SUFFIX}"
                target.write_bytes(bytes(ms.buffer))

    def list_sessions(self, project: str | None) -> list[dict[str, object]]:
        return [self.session_summary(ms) for ms in self._sessions.values()
                if project is None or ms.record.project == project]

    def session_summary(self, ms: ManagedSession) -> dict[str, object]:
        self._recover_title_from_buffer(ms)
        summary: dict[str, object] = dict(ms.record.to_dict())
        summary[ApiFields.RUNNING] = ms.running
        summary[ApiFields.EXIT_CODE] = ms.exit_code
        summary[ApiFields.CLI_TITLE] = ms.cli_title
        return summary

    def session_summary_by_id(self, session_id: str) -> dict[str, object]:
        return self.session_summary(self._sessions[session_id])

    def session_history_source(self, session_id: str) -> tuple[str, str, str | None]:
        record = self._sessions[session_id].record
        return record.agent_kind, record.cwd, record.agent_session_id

    def _persist(self) -> None:
        self._store.save_all([ms.record for ms in self._sessions.values()])
