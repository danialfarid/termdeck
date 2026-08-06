import asyncio
import bisect
import functools
import os
import re
import shlex
import signal
import subprocess
import time
import uuid
from pathlib import Path

from termdeck.agent_session_tracker import AgentSessionTracker
from termdeck.claude_activity_watcher import ClaudeActivityWatcher
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
        self.processing_expiry_task: asyncio.Task | None = None
        self.exit_code: int | None = None
        self.lazy_start_pending = False
        # A dtach master can outlive the TermDeck server. It has no local
        # PtyProcess bridge until a browser/API client attaches again, but it
        # is still a real running terminal and must be counted for cleanup.
        self.detached_live = False
        self.detect_task: asyncio.Task | None = None
        self.detect_kind: AgentKind = AgentKind.NONE
        self.detect_baseline: set[Path] = set()
        self.cols = record.cols
        self.rows = record.rows
        self.cli_title: str | None = record.cli_title
        self.title_updated_monotonic = 0.0
        self.title_carry = b""
        self.title_recovered_from_buffer = False
        self.pending_codex_rename: str | None = None
        self.pending_codex_rename_deadline = 0.0
        self.pending_agent_rename: str | None = None
        self.pending_agent_rename_deadline = 0.0
        self.agent_rename_task: asyncio.Task | None = None
        self.osc_query_carry = b""
        self.last_repaint_offset: int | None = None
        self.scrollback_sync_carry = b""
        self.screen_lives_only_in_stripped_sync_frames = False
        # Whether attach_client has already treated a cold (no-strip-witnessed-yet) claude/codex attach as
        # needing a repaint. Scoped to a single occurrence per process lifetime so a burst of simultaneous
        # reconnects across every open tab at once (e.g. right after a server restart) doesn't also mean a
        # simultaneous pty resize nudge for every single one of them on every future reattach.
        self.cold_attach_repaint_done = False
        self.screen_repaint_task: asyncio.Task | None = None
        self.draft_tracker = DraftInputTracker(record.draft)
        self.detect_attempts = 0
        self.last_input_monotonic = 0.0
        self.last_activity_at = 0.0
        self.last_activity_broadcast_monotonic = 0.0
        self.claude_subagent_states: dict[Path, bool] = {}
        self.claude_subagents_active = False
        self.claude_main_active = False
        self.codex_transcript_active = False
        self.agy_transcript_active = False
        self.agy_transcript_active_until = 0.0
        self.processing_started_at: float | None = None

    @property
    def running(self) -> bool:
        return self.detached_live or (self.proc is not None and self.proc.alive)

    @property
    def attached(self) -> bool:
        return self.proc is not None and self.proc.alive

    @property
    def processing(self) -> bool:
        if not self.cli_title or not self.title_updated_monotonic:
            return False
        marker = self.cli_title[:1]
        return ("\u2800" <= marker <= "\u28ff" or marker == "✳") and \
            time.monotonic() - self.title_updated_monotonic < 3.0

    @property
    def dormant(self) -> bool:
        return self.lazy_start_pending and not self.running


class TerminalSessionManager:
    """Creates, respawns, and tears down terminal sessions; broadcasts pty output to attached websocket queues;
    persists session records and resolves claude/codex agent session ids so a server restart can resume them."""

    def __init__(self) -> None:
        self._store = SessionStore(TermdeckConfig.SESSIONS_FILE)
        self._closed_store = ClosedSessionStore(TermdeckConfig.CLOSED_SESSIONS_FILE)
        self.registry = ProjectRegistry(TermdeckConfig.PROJECTS_FILE)
        self._tracker = AgentSessionTracker()
        self._sessions: dict[str, ManagedSession] = {}
        self._status_queues: set[asyncio.Queue] = set()
        self._draft_persist_task: asyncio.Task | None = None
        self._background_loop: asyncio.AbstractEventLoop | None = None
        self._transcript_service = None
        self._history_index = None
        self._claude_activity_watcher = ClaudeActivityWatcher(
            TermdeckConfig.CLAUDE_PROJECTS_DIR, self._on_claude_file_change_from_thread)

    def attach_transcript_service(self, service) -> None:
        self._transcript_service = service

    def attach_history_index(self, index) -> None:
        self._history_index = index

    def start_background_tasks(self) -> None:
        self._background_loop = asyncio.get_running_loop()
        self._claude_activity_watcher.start()

    def stop_background_tasks(self) -> None:
        self._claude_activity_watcher.stop()
        self._background_loop = None

    def _on_claude_file_change_from_thread(self, path: Path) -> None:
        if self._history_index is not None:
            self._history_index.notify_file_changed(path)
        if self._transcript_service is not None:
            self._transcript_service.notify_file_change(path)
        if self._background_loop is not None:
            self._background_loop.call_soon_threadsafe(self._on_claude_file_change, path)

    async def startup_respawn_saved_sessions(self) -> None:
        for record in self._store.load_all():
            ms = ManagedSession(record)
            self._sessions[record.session_id] = ms
            ms.lazy_start_pending = True
            saved = TermdeckConfig.SCROLLBACK_DIR / f"{record.session_id}{TermdeckConfig.SCROLLBACK_SUFFIX}"
            if saved.exists():
                ms.buffer.extend(saved.read_bytes()[-TermdeckConfig.SCROLLBACK_BYTES:])
                saved.unlink()
        # Do not launch old terminals merely because the web server came up.
        # Reconcile their dtach sockets instead: live sockets remain running
        # and are attached lazily when opened; dead sockets are safe to clear.
        for ms in self._sessions.values():
            await self._reconcile_session_socket(ms)
            self._refresh_persisted_agent_activity(ms)
            if ms.detached_live and ms.record.agent_kind == AgentKind.AGY.value and not ms.record.agent_session_id:
                kind = AgentKind(ms.record.agent_kind)
                ms.detect_kind = kind
                ms.detect_baseline = self._tracker.snapshot_session_files(kind, Path(ms.record.cwd))
                self._schedule_detection(ms, TermdeckConfig.AGENT_DETECT_INITIAL_DELAY_SECONDS)

    def _refresh_persisted_agent_activity(self, ms: ManagedSession) -> None:
        if not ms.detached_live or not ms.record.agent_session_id:
            return
        if ms.record.agent_kind == AgentKind.CODEX.value:
            ms.codex_transcript_active = self._tracker.codex_session_is_active(ms.record.agent_session_id)
        elif ms.record.agent_kind == AgentKind.CLAUDE.value:
            self._initialize_claude_subagent_state(ms)
        elif ms.record.agent_kind == AgentKind.AGY.value:
            ms.agy_transcript_active = self._tracker.agy_session_is_active(ms.record.agent_session_id)
            if ms.agy_transcript_active:
                ms.agy_transcript_active_until = time.monotonic() + TermdeckConfig.AGY_ACTIVITY_KEEPALIVE_SECONDS

    def create_session(self, command: str, cwd: str, title: str, project: str = "",
                       agent_rename: str | None = None) -> ManagedSession:
        clean_command = command.strip()
        cwd_path = Path(cwd).expanduser() if cwd.strip() else TermdeckConfig.DEFAULT_CWD
        if not cwd_path.is_dir():
            raise ValueError(f"cwd is not a directory: {cwd_path}")
        return self._create(clean_command, cwd_path, title, initial_command=None, agent_rename=agent_rename,
                            project=project)

    def command_for_new_session(self, model: str, permission: str, session_ref: str) -> str:
        raw_model = model.strip().strip("\"'").lower()
        normalized = {
            "agd": AgentKind.AGY.value,
            "agy-cli": AgentKind.AGY.value,
            "agycli": AgentKind.AGY.value,
            "gemini": AgentKind.AGY.value,
            "antigravity": AgentKind.AGY.value,
            "antigravity-cli": AgentKind.AGY.value,
            "antigravitycli": AgentKind.AGY.value,
        }.get(raw_model, raw_model)
        selected_model = normalized or AgentKind.CODEX.value
        selected_permission = permission.strip().lower() or "default"
        reference = session_ref.strip()
        if selected_model == AgentKind.AGY.value:
            permission_flags = {
                "default": (),
                "full-access": ("--dangerously-skip-permissions",),
            }
            if selected_permission not in permission_flags:
                raise ValueError(f"unknown agy permission: {permission}")
            if reference:
                raise ValueError("agy terminal currently supports new sessions only")
            return shlex.join(["agy", *permission_flags[selected_permission]])
        if selected_model == AgentKind.NONE.value:
            if reference:
                raise ValueError("a shell terminal cannot resume an agent session")
            return ""
        if selected_model == AgentKind.CODEX.value:
            permission_flags = {
                "default": (),
                "read-only": ("--sandbox", "read-only"),
                "workspace-write": ("--sandbox", "workspace-write"),
                "full-access": ("--dangerously-bypass-approvals-and-sandbox",),
            }
            if selected_permission not in permission_flags:
                raise ValueError(f"unknown codex permission: {permission}")
            parts = ["codex", *permission_flags[selected_permission]]
            if reference:
                resolved_reference = self._tracker.codex_session_id_for_reference(reference)
                if resolved_reference is None:
                    raise ValueError(f"no saved Codex session found with ID or name: {reference}")
                parts.extend(("resume", resolved_reference))
            return shlex.join(parts)
        if selected_model == AgentKind.CLAUDE.value:
            permission_flags = {
                "default": (),
                "accept-edits": ("--permission-mode", "acceptEdits"),
                "auto": ("--permission-mode", "auto"),
                "full-access": ("--dangerously-skip-permissions",),
            }
            if selected_permission not in permission_flags:
                raise ValueError(f"unknown claude permission: {permission}")
            parts = ["claude", *permission_flags[selected_permission]]
            if reference:
                parts.extend(("--resume", reference))
            return shlex.join(parts)
        raise ValueError(f"unknown model: {model}")

    @staticmethod
    def _command_parts(command: str) -> list[str]:
        try:
            return shlex.split(command)
        except ValueError:
            return command.split()

    @staticmethod
    def _permission_flags(kind: AgentKind, permission: str) -> tuple[str, ...] | None:
        requested = permission.strip().lower() or "default"
        if kind is AgentKind.CLAUDE:
            options = {
                "default": (),
                "accept-edits": ("--permission-mode", "acceptEdits"),
                "auto": ("--permission-mode", "auto"),
                "full-access": ("--dangerously-skip-permissions",),
            }
        elif kind is AgentKind.CODEX:
            options = {
                "default": (),
                "read-only": ("--sandbox", "read-only"),
                "workspace-write": ("--sandbox", "workspace-write"),
                "full-access": ("--dangerously-bypass-approvals-and-sandbox",),
            }
        elif kind is AgentKind.AGY:
            options = {
                "default": (),
                "full-access": ("--dangerously-skip-permissions",),
            }
        else:
            return () if requested == "default" else None
        return options.get(requested)

    def _set_restart_permission(self, record: SessionRecord, permission: str) -> None:
        kind = AgentKind(record.agent_kind)
        if kind is AgentKind.NONE:
            return
        normalized_permission = permission.strip().lower() or "default"
        flags = self._permission_flags(kind, normalized_permission)
        if flags is None:
            raise ValueError(f"unknown {record.agent_kind} permission: {permission}")
        permissions = list(flags)
        parts = self._command_parts(record.command)
        if not parts:
            return
        command_index = next((index for index, token in enumerate(parts) if Path(token).name == kind.value), None)
        if command_index is None:
            return
        preamble = parts[:command_index + 1]
        tail = parts[command_index + 1:]
        filtered = []
        skip_next = False
        for index, token in enumerate(tail):
            if skip_next:
                skip_next = False
                continue
            if token == "--permission-mode":
                skip_next = True
                continue
            if token in {"--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox"}:
                continue
            if token == "--sandbox" and index + 1 < len(tail) and tail[index + 1] in {"read-only", "workspace-write"}:
                skip_next = True
                continue
            filtered.append(token)
        updated = preamble + list(permissions) + filtered
        record.command = shlex.join(updated)

    def _create(self, clean_command: str, cwd_path: Path, title: str, initial_command: str | None,
                agent_rename: str | None = None, project: str | None = None) -> ManagedSession:
        kind = self._tracker.detect_agent_kind(clean_command)
        project_name = project.strip() if project and project.strip() else self.registry.ensure_project_for_cwd(cwd_path)
        record = SessionRecord(session_id=uuid.uuid4().hex[:12], title=title.strip() or self._auto_title(clean_command, cwd_path),
                               title_user_set=bool(title.strip()), command=clean_command, cwd=str(cwd_path),
                               agent_kind=kind.value, agent_session_id=None, created_at_est=TimeUtil.now_est_naive_iso(),
                               draft="", project=project_name)
        ms = ManagedSession(record)
        if agent_rename and kind is AgentKind.CODEX:
            ms.pending_agent_rename = " ".join(agent_rename.splitlines()).strip()
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
        return self._create(src.command, Path(src.cwd), title, initial_command=initial,
                            agent_rename=title, project=src.project)

    @staticmethod
    def _auto_title(command: str, cwd: Path) -> str:
        head = Path(command.split()[0]).name if command else Path(TermdeckConfig.SHELL).name
        return f"{head} · {cwd.name}"

    def _spawn(self, ms: ManagedSession, resume: bool, initial_command: str | None = None) -> None:
        ms.lazy_start_pending = False
        kind = AgentKind(ms.record.agent_kind)
        socket = self._dtach_socket(ms.record.session_id)
        reattach = resume and self._dtach_socket_live(socket)
        ms.detached_live = reattach
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
            ms.detached_live = False
            ms.exit_code = TermdeckConfig.EXIT_CODE_SPAWN_FAILED
            self._handle_output(ms, TermdeckConfig.SPAWN_ERROR_TEMPLATE.format(error=spawn_error).encode())
            return
        if kind is not AgentKind.NONE:
            ms.detect_kind = kind
            ms.detect_baseline = baseline
            if ms.pending_agent_rename and kind is AgentKind.CODEX:
                # Forked Codex sessions create their rollout file asynchronously.
                # Keep retrying detection briefly so the rename is sent to the
                # child session, never to the parent or the shell.
                ms.pending_agent_rename_deadline = time.monotonic() + 20.0
            if kind is AgentKind.CLAUDE and ms.record.agent_session_id:
                self._initialize_claude_subagent_state(ms)
            self._schedule_detection(ms, TermdeckConfig.AGENT_DETECT_INITIAL_DELAY_SECONDS)
        if reattach:
            self._schedule_screen_repaint(ms, TermdeckConfig.SCREEN_REPAINT_REATTACH_DELAY_SECONDS)
        if resume and not reattach and ms.record.draft:
            asyncio.create_task(self._replay_draft_into_respawn(ms, ms.proc))

    def _schedule_screen_repaint(self, ms: ManagedSession, delay: float) -> None:
        if ms.proc is None or not ms.proc.alive:
            return
        if ms.screen_repaint_task is not None and not ms.screen_repaint_task.done():
            return
        ms.screen_repaint_task = asyncio.create_task(self._force_screen_repaint(ms, ms.proc, delay))

    async def _force_screen_repaint(self, ms: ManagedSession, proc: PtyProcess, delay: float) -> None:
        """Make a full-screen TUI redraw itself by briefly changing the pty width.

        The replayed scrollback cannot reconstruct a Codex/Claude screen: those TUIs paint inside
        synchronized-update frames, which _durable_scrollback_bytes strips, so a freshly attached client
        would otherwise stare at an empty pane until the agent happens to emit new output. A pty only
        raises SIGWINCH when the size actually changes, so re-sending the current size is not enough.

        Deliberately unconditional on output volume: an earlier version bailed out if >= 256 bytes of
        anything arrived during the delay, reasoning that meant the screen already repainted on its own.
        That volume threshold cannot distinguish a genuine full-screen redraw from an actively-running
        session's own incidental chatter (status-area/spinner repaints alone run roughly 9KB/s) --
        trivially exceeding 256 bytes within this delay for any BUSY session, which bailed out almost
        every time specifically for the "running" tabs this was supposed to fix, while working fine for
        genuinely idle ones. A redundant nudge here is cheap: the CLI redraws itself in response to a
        real SIGWINCH exactly like it would for any legitimate resize, unlike the client-side equivalent
        (forceVisibleTerminalReflowViaResizeNudge in app.js) whose risk comes from xterm's OWN
        buffer-reflow logic, not from anything server-side.
        The restore reads the size again after the nudge, letting a client resize that landed meanwhile win.
        """
        await asyncio.sleep(delay)
        if ms.proc is not proc or not proc.alive:
            return
        cols, rows = max(2, ms.cols), max(2, ms.rows)
        nudge = cols - 1 if cols > TermdeckConfig.SCREEN_REPAINT_NUDGE_MIN_COLS else cols + 1
        proc.resize(nudge, rows)
        await asyncio.sleep(TermdeckConfig.SCREEN_REPAINT_NUDGE_HOLD_SECONDS)
        if ms.proc is proc and proc.alive:
            proc.resize(max(2, ms.cols), max(2, ms.rows))

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
        ms.detect_attempts = 0
        ms.detect_task = asyncio.create_task(self._detect_after(ms, delay))

    async def _detect_after(self, ms: ManagedSession, delay: float) -> None:
        await asyncio.sleep(delay)
        if not ms.running:
            return
        kind = ms.detect_kind
        ms.detect_attempts += 1
        socket = self._dtach_socket(ms.record.session_id)
        found = await self._tracker.session_id_from_open_files(kind, socket)
        if found is None and kind is AgentKind.CLAUDE:
            candidate = self._tracker.claude_session_id_for_title(Path(ms.record.cwd), ms.cli_title)
            if candidate not in self._claimed_agent_ids(ms):
                found = candidate
        recent_input = (time.monotonic() - ms.last_input_monotonic) < TermdeckConfig.AGENT_DIR_CLAIM_INPUT_WINDOW_SECONDS
        claim_allowed = found is None and (kind is AgentKind.AGY or recent_input or bool(ms.pending_agent_rename))
        dir_found = self._tracker.absorb_and_find_new_session_file(
            kind, Path(ms.record.cwd), ms.detect_baseline, self._claimed_agent_ids(ms), claim_allowed=claim_allowed)
        if found is None:
            found = dir_found
        if found is None:
            if kind is AgentKind.AGY and ms.detect_attempts < 20:
                ms.detect_task = asyncio.create_task(self._detect_after(ms, 1.0))
            elif ms.pending_agent_rename and time.monotonic() < ms.pending_agent_rename_deadline:
                ms.detect_task = asyncio.create_task(self._detect_after(ms, 1.0))
            return
        if found is not None and found != ms.record.agent_session_id:
            ms.record.agent_session_id = found
            if kind is AgentKind.CLAUDE:
                self._initialize_claude_subagent_state(ms)
                if ms.cli_title is None:
                    ms.cli_title = self._tracker.claude_session_title(Path(ms.record.cwd), found)
            elif kind is AgentKind.CODEX and ms.cli_title is None:
                ms.cli_title = self._tracker.codex_session_title(found)
            elif kind is AgentKind.AGY:
                ms.agy_transcript_active = self._tracker.agy_session_is_active(found)
            if kind is AgentKind.CODEX and ms.pending_agent_rename:
                rename = ms.pending_agent_rename
                ms.pending_agent_rename = None
                ms.agent_rename_task = asyncio.create_task(self._rename_forked_codex(ms, rename))
            self._persist()
            if kind is AgentKind.CODEX:
                ms.codex_transcript_active = self._tracker.codex_session_is_active(found)
            elif kind is AgentKind.AGY:
                ms.agy_transcript_active = self._tracker.agy_session_is_active(found)
            self._broadcast_control(ms, {WsMessageFields.TYPE: WsMessageFields.AGENT_SESSION,
                                         WsMessageFields.AGENT_SESSION_ID: found})
            self._broadcast_status(ms)

    async def _send_codex_rename_command(self, ms: ManagedSession, title: str, *,
                                         ready_delay: float = 0.0, clear_composer: bool = True) -> None:
        """Send Codex's own /rename command so TermDeck title and Codex thread title converge."""
        title = " ".join(str(title or "").splitlines()).strip()
        if not title:
            return
        if ready_delay > 0:
            await asyncio.sleep(ready_delay)
        if ms.proc is None or not ms.proc.alive or not ms.record.agent_session_id:
            return
        ms.pending_codex_rename = title
        ms.pending_codex_rename_deadline = time.monotonic() + 30.0
        command = f"/rename {title}"
        payload = ((b"\x15" if clear_composer else b"") +
                   TermdeckConfig.BRACKETED_PASTE_START + command.encode() +
                   TermdeckConfig.BRACKETED_PASTE_END).decode()
        self.write_input(ms.record.session_id, payload)
        await asyncio.sleep(TermdeckConfig.FORK_RENAME_SUBMIT_DELAY_SECONDS)
        self.write_input(ms.record.session_id, "\r")

    async def _rename_forked_codex(self, ms: ManagedSession, title: str) -> None:
        """Apply the requested TermDeck fork label to Codex's child thread."""
        # The rollout file can appear before the new Codex TUI has finished
        # initializing its composer. Sending immediately loses the first
        # characters and can leave a partial command in the composer.
        await self._send_codex_rename_command(
            ms, title,
            ready_delay=TermdeckConfig.FORK_RENAME_READY_DELAY_SECONDS,
            clear_composer=True,
        )

    def _initialize_claude_subagent_state(self, ms: ManagedSession) -> None:
        if ms.record.agent_kind != AgentKind.CLAUDE.value or not ms.record.agent_session_id:
            return
        parent = self._tracker.claude_project_dir(Path(ms.record.cwd)) / f"{ms.record.agent_session_id}.jsonl"
        ms.claude_main_active = parent.is_file() and self._tracker.claude_session_is_active(parent)
        states = self._tracker.claude_subagent_states(Path(ms.record.cwd), ms.record.agent_session_id)
        ms.claude_subagent_states = states
        ms.claude_subagents_active = any(states.values())

    def _processing_state(self, ms: ManagedSession) -> bool:
        return ms.processing or ms.codex_transcript_active or ms.agy_transcript_active or ms.claude_main_active or ms.claude_subagents_active

    def _refresh_agy_transcript_activity(self, ms: ManagedSession, active: bool, observed_at: float | None = None) -> None:
        now = time.monotonic() if observed_at is None else observed_at
        if active:
            ms.agy_transcript_active = True
            ms.agy_transcript_active_until = now + TermdeckConfig.AGY_ACTIVITY_KEEPALIVE_SECONDS
            return
        if ms.agy_transcript_active and now < ms.agy_transcript_active_until:
            ms.agy_transcript_active_until = now + TermdeckConfig.AGY_ACTIVITY_KEEPALIVE_SECONDS
            return
        ms.agy_transcript_active = False
        ms.agy_transcript_active_until = 0.0

    def _expire_agy_transcript_activity(self, ms: ManagedSession, observed_at: float | None = None) -> None:
        if ms.record.agent_kind != AgentKind.AGY.value or not ms.agy_transcript_active:
            return
        now = time.monotonic() if observed_at is None else observed_at
        if now < ms.agy_transcript_active_until:
            return
        ms.agy_transcript_active = False
        ms.agy_transcript_active_until = 0.0

    def notify_agent_transcript_changed(self, path: Path) -> None:
        if self._background_loop is not None:
            self._background_loop.call_soon_threadsafe(self._refresh_agent_transcript_activity, path)

    def _refresh_agent_transcript_activity(self, path: Path) -> None:
        for ms in self._sessions.values():
            if not ms.running or not ms.record.agent_session_id:
                continue
            if ms.record.agent_kind == AgentKind.CODEX.value:
                if not path.name.endswith(f"-{ms.record.agent_session_id}.jsonl"):
                    continue
                active = self._tracker.codex_session_is_active(ms.record.agent_session_id)
            elif ms.record.agent_kind == AgentKind.AGY.value:
                if self._tracker._agy_session_id_from_path(path) != ms.record.agent_session_id:
                    continue
                active = self._tracker._agy_session_is_active(path)
            else:
                continue
            previous = self._processing_state(ms)
            if ms.record.agent_kind == AgentKind.CODEX.value:
                ms.codex_transcript_active = active
            else:
                self._refresh_agy_transcript_activity(ms, active, time.monotonic())
            current = self._processing_state(ms)
            if current != previous:
                self._broadcast_status(ms)

    def _sync_processing_started(self, ms: ManagedSession, processing: bool | None = None) -> bool:
        current = self._processing_state(ms) if processing is None else processing
        if current and ms.processing_started_at is None:
            # The transcript can still contain the previous user turn while a
            # newly submitted prompt is waiting to enter the agent TUI. Using
            # that historical timestamp makes a fresh run appear to have
            # started minutes ago. This value represents the live processing
            # transition, so use the current wall clock instead.
            ms.processing_started_at = time.time()
        elif not current:
            ms.processing_started_at = None
        return current

    def _remember_cli_title(self, ms: ManagedSession) -> None:
        """Persist the spinner-free agent title so the sidebar can name this terminal without attaching."""
        display_title = self._display_title(ms.cli_title)
        if not display_title or display_title == ms.record.cli_title:
            return
        ms.record.cli_title = display_title
        self._persist()

    @staticmethod
    def _display_title(value: str | None) -> str | None:
        if value and ("\u2800" <= value[0] <= "\u28ff" or value[0] == "✳"):
            return value[1:].lstrip()
        return value

    def _status_payload(self, ms: ManagedSession) -> dict[str, object]:
        self._expire_agy_transcript_activity(ms)
        processing = self._sync_processing_started(ms)
        return {
            WsMessageFields.TYPE: WsMessageFields.SESSION_STATUS,
            WsMessageFields.SESSION_ID: ms.record.session_id,
            WsMessageFields.TITLE: ms.record.title,
            WsMessageFields.TITLE_USER_SET: ms.record.title_user_set,
            WsMessageFields.CLI_TITLE: ms.cli_title,
            WsMessageFields.AGENT_SESSION_ID: ms.record.agent_session_id,
            WsMessageFields.RUNNING: ms.running,
            WsMessageFields.EXIT_CODE: ms.exit_code,
            ApiFields.DORMANT: ms.dormant,
            ApiFields.DETACHED: ms.detached_live and not ms.attached,
            WsMessageFields.PROCESSING: processing,
            "processing_since": ms.processing_started_at,
            "last_activity_at": ms.last_activity_at,
        }

    def _broadcast_status(self, ms: ManagedSession) -> None:
        ms.last_activity_broadcast_monotonic = time.monotonic()
        payload = self._status_payload(ms)
        for queue in list(self._status_queues):
            queue.put_nowait(payload)

    def _broadcast_activity_if_due(self, ms: ManagedSession) -> None:
        if time.monotonic() - ms.last_activity_broadcast_monotonic >= 0.25:
            self._broadcast_status(ms)

    def status_snapshot(self) -> list[dict[str, object]]:
        return [self._status_payload(ms) for ms in self._sessions.values()]

    def attach_status_client(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue()
        self._status_queues.add(queue)
        return queue

    def detach_status_client(self, queue: asyncio.Queue) -> None:
        self._status_queues.discard(queue)

    def _schedule_processing_expiry(self, ms: ManagedSession) -> None:
        if ms.processing_expiry_task is not None and not ms.processing_expiry_task.done():
            return

        async def expire() -> None:
            try:
                while ms.running:
                    previous = self._processing_state(ms)
                    remaining = 3.05 - (time.monotonic() - ms.title_updated_monotonic)
                    if remaining > 0:
                        await asyncio.sleep(remaining)
                    if ms.processing:
                        continue
                    current = self._processing_state(ms)
                    if current != previous:
                        self._broadcast_control(ms, {WsMessageFields.TYPE: WsMessageFields.PROCESSING,
                                                      WsMessageFields.PROCESSING: current})
                        self._broadcast_status(ms)
                    return
            except asyncio.CancelledError:
                return

        ms.processing_expiry_task = asyncio.create_task(expire())

    def _on_claude_file_change(self, path: Path) -> None:
        """Update the Claude parent or subagent state that generated the filesystem event."""
        for ms in self._sessions.values():
            if ms.record.agent_kind != AgentKind.CLAUDE.value or not ms.record.agent_session_id:
                continue
            parent = self._tracker.claude_project_dir(Path(ms.record.cwd)) / f"{ms.record.agent_session_id}.jsonl"
            subagents = self._tracker.claude_project_dir(Path(ms.record.cwd)) / ms.record.agent_session_id / "subagents"
            is_parent = path == parent
            try:
                is_subagent = path.is_relative_to(subagents)
                if not is_parent and not is_subagent:
                    continue
            except ValueError:
                continue
            previous_processing = self._processing_state(ms)
            if is_parent:
                ms.claude_main_active = path.is_file() and self._tracker.claude_session_is_active(path)
            elif path.is_file():
                ms.claude_subagent_states[path] = self._tracker.claude_subagent_is_active(path)
            else:
                ms.claude_subagent_states.pop(path, None)
            ms.claude_subagents_active = any(ms.claude_subagent_states.values())
            current_processing = self._processing_state(ms)
            if current_processing != previous_processing:
                self._broadcast_control(ms, {WsMessageFields.TYPE: WsMessageFields.PROCESSING,
                                              WsMessageFields.PROCESSING: current_processing})
                self._broadcast_status(ms)

    def _claimed_agent_ids(self, exclude: ManagedSession) -> set[str]:
        return {ms.record.agent_session_id for ms in self._sessions.values()
                if ms is not exclude and ms.record.agent_session_id is not None}

    def _durable_scrollback_bytes(self, ms: ManagedSession, data: bytes) -> bytes:
        """Return bytes safe to persist/replay as scrollback.

        Codex/Claude TUI status/composer redraws are wrapped in synchronized-update
        markers. They are meant for the current screen, not durable terminal
        history: replaying those cursor-moving frames later can overwrite the
        previous prompt/answer rows even though the agent transcript is correct.
        Live clients still receive the raw frame from _handle_output; this only
        filters TermDeck's saved/replayed/searchable buffer.
        """
        if not data and not ms.scrollback_sync_carry:
            return b""
        start_marker = TermdeckConfig.SYNC_UPDATE_START
        end_marker = TermdeckConfig.SYNC_UPDATE_END
        data = ms.scrollback_sync_carry + data
        ms.scrollback_sync_carry = b""
        durable = bytearray()
        position = 0
        while position < len(data):
            start = data.find(start_marker, position)
            if start < 0:
                durable.extend(data[position:])
                break
            durable.extend(data[position:start])
            ms.screen_lives_only_in_stripped_sync_frames = True
            end = data.find(end_marker, start + len(start_marker))
            if end < 0:
                ms.scrollback_sync_carry = data[start:]
                break
            position = end + len(end_marker)
            while position < len(data) and data[position] in b"\r\n":
                position += 1
        return bytes(durable)

    def _append_collapsing_repaints(self, ms: ManagedSession, data: bytes) -> None:
        """Append durable terminal history after dropping screen-local TUI repaint frames."""
        durable = self._durable_scrollback_bytes(ms, data)
        if not durable:
            return
        ms.last_repaint_offset = None
        ms.buffer.extend(durable)
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
        ms.last_activity_at = time.time()
        self._append_collapsing_repaints(ms, data)
        previous_title = ms.cli_title
        previous_processing = self._processing_state(ms)
        cli_title, ms.title_carry = OscTitleParser.extract_latest_title(ms.title_carry, data)
        title_renamed = False
        if cli_title is not None and cli_title.strip():
            ms.cli_title = cli_title.strip()
            ms.title_updated_monotonic = time.monotonic()
            title_renamed = self._reconcile_codex_rename(ms, previous_title)
            self._schedule_processing_expiry(ms)
            if ms.record.agent_kind == AgentKind.CLAUDE.value and ms.record.agent_session_id is None:
                self._schedule_detection(ms, 0.1)
            current_processing = self._processing_state(ms)
            self._remember_cli_title(ms)
            if title_renamed or self._display_title(ms.cli_title) != self._display_title(previous_title) or current_processing != previous_processing:
                self._broadcast_status(ms)
        else:
            title_renamed = self._reconcile_codex_rename(ms, previous_title)
            if title_renamed:
                self._broadcast_status(ms)
        for queue in list(ms.client_queues):
            queue.put_nowait(data)
        self._broadcast_activity_if_due(ms)

    def _reconcile_codex_rename(self, ms: ManagedSession, previous_title: str | None) -> bool:
        """Persist a Codex `/rename` after its durable index and OSC title agree.

        The terminal confirmation text is presentation output and is not parsed.
        A pending command supplies the expected name; the OSC transition also
        lets us recover a rename that was entered before this listener existed.
        """
        if ms.record.agent_kind != AgentKind.CODEX.value or not ms.record.agent_session_id:
            return False
        candidate = self._tracker.codex_thread_name(ms.record.agent_session_id)
        if not candidate:
            return False
        live_title = self._display_title(ms.cli_title)
        old_live_title = self._display_title(previous_title)
        expected = ms.pending_codex_rename
        expected_matches = bool(expected and candidate == expected and live_title == expected)
        transition_matches = bool(old_live_title and live_title and old_live_title != live_title and
                                  candidate == live_title and ms.record.title == old_live_title)
        if not expected_matches and not transition_matches:
            if ms.pending_codex_rename and time.monotonic() >= ms.pending_codex_rename_deadline:
                ms.pending_codex_rename = None
            return False
        ms.pending_codex_rename = None
        if ms.record.title == candidate:
            return False
        ms.record.title = candidate
        ms.record.title_user_set = True
        self._persist()
        return True

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
            ms.cli_title = self._tracker.codex_session_title(ms.record.agent_session_id)
        if ms.cli_title is None and ms.record.agent_kind == AgentKind.CLAUDE:
            ms.cli_title = self._tracker.claude_session_title(Path(ms.record.cwd), ms.record.agent_session_id)
        self._remember_cli_title(ms)

    def _handle_exit(self, ms: ManagedSession, proc: PtyProcess, exit_code: int) -> None:
        if ms.proc is not proc:
            return
        ms.proc = None
        ms.detached_live = self._dtach_socket_live(self._dtach_socket(ms.record.session_id))
        ms.exit_code = exit_code
        if ms.processing_expiry_task is not None and not ms.processing_expiry_task.done():
            ms.processing_expiry_task.cancel()
        self._broadcast_control(ms, {WsMessageFields.TYPE: WsMessageFields.EXIT, WsMessageFields.CODE: exit_code,
                                     WsMessageFields.DORMANT: ms.dormant})
        self._broadcast_status(ms)

    def _broadcast_control(self, ms: ManagedSession, payload: dict[str, object]) -> None:
        for queue in list(ms.client_queues):
            queue.put_nowait(payload)

    def has_session(self, session_id: str) -> bool:
        return session_id in self._sessions

    def ensure_session_running(self, session_id: str) -> ManagedSession:
        """Start a lazy terminal before an API caller submits input to it."""
        ms = self._sessions[session_id]
        if ms.lazy_start_pending:
            self._spawn(ms, resume=True)
            self._broadcast_status(ms)
        if not ms.running:
            raise ValueError(f"terminal is not running: {session_id}")
        return ms

    def search_terminal_buffers(self, query: str, case_sensitive: bool = False, regex: bool = False) -> list[dict[str, object]]:
        normalized_query = query.strip()
        if not normalized_query:
            return []
        if len(normalized_query) > TermdeckConfig.TERMINAL_SEARCH_MAX_QUERY:
            raise ValueError(f"terminal search query is limited to {TermdeckConfig.TERMINAL_SEARCH_MAX_QUERY} characters")
        flags = 0 if case_sensitive else re.IGNORECASE
        pattern = re.compile(normalized_query if regex else re.escape(normalized_query), flags)
        results: list[dict[str, object]] = []
        for ms in self._sessions.values():
            searchable = self._searchable_terminal_text(bytes(ms.buffer))
            line_starts = [0]
            line_starts.extend(index + 1 for index, character in enumerate(searchable) if character == "\n")
            match_count = 0
            snippets: list[dict[str, object]] = []
            snippet_lines: set[int] = set()
            lines = searchable.splitlines()
            for match in pattern.finditer(searchable):
                match_count += 1
                line_number = bisect.bisect_right(line_starts, match.start())
                if line_number in snippet_lines:
                    continue
                snippet_lines.add(line_number)
                if len(snippets) >= TermdeckConfig.TERMINAL_SEARCH_MAX_SNIPPETS:
                    continue
                line = lines[line_number - 1].strip() if line_number <= len(lines) else ""
                if len(line) > TermdeckConfig.TERMINAL_SEARCH_SNIPPET_CHARS:
                    line = line[:TermdeckConfig.TERMINAL_SEARCH_SNIPPET_CHARS - 1] + "…"
                snippets.append({"line": line_number, "text": line})
            if not match_count:
                continue
            results.append({"session_id": ms.record.session_id, "title": ms.record.title,
                            "agent_kind": ms.record.agent_kind, "count": match_count, "snippets": snippets,
                            "last_activity_at": ms.last_activity_at})
        results.sort(key=lambda result: -float(result["last_activity_at"]))
        return results

    @staticmethod
    def _searchable_terminal_text(data: bytes) -> str:
        text = data.decode("utf-8", errors="replace")
        text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)
        text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
        text = re.sub(r"\x1b[()][0-2A-Za-z]", "", text)
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        return "".join(character for character in text if character in "\n\t" or ord(character) >= 0x20)

    def attach_client(self, session_id: str, screen_repaint: bool = True) -> tuple[bytes, asyncio.Queue]:
        ms = self._sessions[session_id]
        self._recover_title_from_buffer(ms)
        if ms.lazy_start_pending:
            self._spawn(ms, resume=True)
            self._broadcast_status(ms)
        queue: asyncio.Queue = asyncio.Queue()
        ms.client_queues.add(queue)
        needs_repaint = ms.screen_lives_only_in_stripped_sync_frames or not ms.buffer
        # A claude/codex session that has not produced output since the last server restart never gets a
        # chance to set screen_lives_only_in_stripped_sync_frames live, even though its durable buffer has
        # always been missing the actual screen (inherent to how these TUIs paint, not something that needs
        # to be witnessed). Cover exactly that first-attach-since-restart case, once, without turning every
        # later reattach of every agent session into an unconditional pty resize.
        if not needs_repaint and not ms.cold_attach_repaint_done and \
                ms.record.agent_kind in (AgentKind.CODEX.value, AgentKind.CLAUDE.value):
            needs_repaint = True
        ms.cold_attach_repaint_done = True
        if screen_repaint and needs_repaint:
            self._schedule_screen_repaint(ms, TermdeckConfig.SCREEN_REPAINT_CLIENT_ATTACH_DELAY_SECONDS)
        return bytes(ms.buffer), queue

    def detach_client(self, session_id: str, queue: asyncio.Queue) -> None:
        ms = self._sessions.get(session_id)
        if ms is not None:
            ms.client_queues.discard(queue)

    def write_input(self, session_id: str, text: str) -> None:
        ms = self._sessions[session_id]
        draft_before_input = ms.draft_tracker.draft
        if ms.record.agent_kind in (AgentKind.CODEX.value, AgentKind.CLAUDE.value) and ("\r" in text or "\n" in text):
            command = draft_before_input.strip()
            if not command:
                command = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text).splitlines()[0].strip()
            command = command.replace("\x1b[200~", "").replace("\x1b[201~", "").strip()
            if ms.record.agent_kind == AgentKind.CODEX.value and command.lower().startswith("/rename") and \
                    (len(command) == 7 or command[7].isspace()):
                candidate = command[7:].strip()
                if candidate:
                    ms.pending_codex_rename = candidate
                    ms.pending_codex_rename_deadline = time.monotonic() + 30.0
        if ms.record.agent_kind == AgentKind.AGY.value and ("\r" in text or "\n" in text):
            ms.agy_transcript_active = True
            ms.agy_transcript_active_until = time.monotonic() + TermdeckConfig.AGY_ACTIVITY_KEEPALIVE_SECONDS
        if ms.proc is not None:
            ms.proc.write(text.encode())
        ms.last_input_monotonic = time.monotonic()
        ms.last_activity_at = time.time()
        if ms.record.agent_kind == AgentKind.AGY.value and ("\r" in text or "\n" in text):
            self._broadcast_status(ms)
        self._broadcast_activity_if_due(ms)
        if ms.detect_kind is not AgentKind.NONE:
            self._schedule_detection(ms, TermdeckConfig.AGENT_DETECT_INPUT_DEBOUNCE_SECONDS)
        ms.draft_tracker.feed(text)
        new_draft = ms.draft_tracker.draft
        # In Codex, Tab queues the current composer instead of submitting it.
        # DraftInputTracker intentionally treats Tab as layout/control input,
        # so clear the persisted draft explicitly or Markdown will resurrect
        # the already-queued prompt when the view changes.
        if text == "\t" and ms.record.agent_kind == AgentKind.CODEX.value:
            new_draft = ""
            ms.draft_tracker = DraftInputTracker("")
        if new_draft != ms.record.draft:
            ms.record.draft = new_draft
            self._schedule_draft_persist()
            self._broadcast_control(ms, {WsMessageFields.TYPE: WsMessageFields.DRAFT, WsMessageFields.DRAFT: new_draft})

    def set_draft(self, session_id: str, draft: str) -> None:
        ms = self._sessions[session_id]
        normalized = str(draft or "")[:TermdeckConfig.DRAFT_MAX_CHARS]
        if normalized != ms.record.draft:
            ms.record.draft = normalized
            ms.draft_tracker = DraftInputTracker(normalized)
            self._schedule_draft_persist()
        # Always echo draft_sync, including when the value is unchanged. This
        # acknowledges the client update without racing the terminal websocket
        # or the periodic session refresh.
        self._broadcast_control(ms, {WsMessageFields.TYPE: WsMessageFields.DRAFT,
                                     WsMessageFields.DRAFT: normalized})

    async def submit_prompt(self, session_id: str, text: str, bracketed: bool, queue: bool = False) -> None:
        """Paste a Markdown prompt, then send Enter or Tab after the agent TUI has consumed it."""
        await self._wait_for_prompt_ready(self._sessions[session_id])
        normalized = str(text or "")[:TermdeckConfig.DRAFT_MAX_CHARS]
        ms = self._sessions[session_id]
        if ms.record.agent_kind == AgentKind.CODEX.value and not queue:
            ms.codex_transcript_active = True
            self._broadcast_status(ms)
        payload = "\x15"
        if normalized:
            if bracketed:
                payload += TermdeckConfig.BRACKETED_PASTE_START.decode() + normalized + TermdeckConfig.BRACKETED_PASTE_END.decode()
            else:
                payload += normalized
        self.write_input(session_id, payload)
        await asyncio.sleep(TermdeckConfig.PROMPT_SUBMIT_KEY_DELAY_SECONDS)
        self.write_input(session_id, "\t" if queue else "\r")
        if queue:
            ms.record.draft = ""
            ms.draft_tracker = DraftInputTracker("")
            self._schedule_draft_persist()
            self._broadcast_control(ms, {WsMessageFields.TYPE: WsMessageFields.DRAFT,
                                         WsMessageFields.DRAFT: ""})
        # A submitted prompt must not be resurrected from the debounce window
        # if the browser is refreshed immediately afterward.
        self._persist()
        self._broadcast_control(self._sessions[session_id], {WsMessageFields.TYPE: WsMessageFields.PROMPT_SUBMITTED})

    async def _wait_for_prompt_ready(self, ms: ManagedSession) -> None:
        """Avoid losing the first API/Markdown prompt while a new agent TUI boots.

        Named API-created Codex sessions also have a pending /rename. Wait for
        session detection and that rename to finish before writing the prompt,
        otherwise the two commands can race in the new composer.
        """
        if ms.record.agent_kind == AgentKind.NONE.value or not ms.running:
            return
        waiting_for_new_agent = ms.record.agent_session_id is None
        if ms.record.agent_session_id is None and ms.pending_agent_rename:
            deadline = time.monotonic() + TermdeckConfig.PROMPT_AGENT_READY_TIMEOUT_SECONDS
            while ms.running and ms.record.agent_session_id is None and time.monotonic() < deadline:
                await asyncio.sleep(0.1)
        rename_task = ms.agent_rename_task
        if rename_task is not None and not rename_task.done():
            try:
                await asyncio.shield(rename_task)
            except Exception:
                # A failed rename must not discard the caller's prompt.
                pass
        if waiting_for_new_agent:
            await asyncio.sleep(TermdeckConfig.PROMPT_AGENT_STARTUP_DELAY_SECONDS)

    async def edit_queued_prompt(self, session_id: str, index: int, queue: object, text: str,
                                 remove: bool, bracketed: bool) -> None:
        """Edit or remove a Codex queued prompt through Codex's own TUI queue controls.

        Codex exposes editing for the newest queued message only. To support an arbitrary
        Markdown row, pop the target and newer rows from the back, change the target, then
        re-queue the newer rows in their original order.
        """
        ms = self._sessions[session_id]
        texts = [str(value or "")[:TermdeckConfig.DRAFT_MAX_CHARS] for value in (queue if isinstance(queue, list) else [])]
        if index < 0 or index >= len(texts):
            self._broadcast_control(ms, {WsMessageFields.TYPE: WsMessageFields.QUEUE_MUTATION,
                                         WsMessageFields.OK: False,
                                         WsMessageFields.ERROR: "queued prompt is no longer available"})
            return

        replacement = str(text or "")[:TermdeckConfig.DRAFT_MAX_CHARS]
        resulting_queue = texts[:index] + ([] if remove or not replacement.strip() else [replacement]) + texts[index + 1:]
        try:
            # With TERM_PROGRAM intentionally absent, Codex detects this as an unknown terminal
            # and binds queued-message editing to Alt+Up (CSI 1;3 A).
            for _ in range(len(texts) - index):
                self.write_input(session_id, "\x1b[1;3A")
                await asyncio.sleep(TermdeckConfig.PROMPT_SUBMIT_KEY_DELAY_SECONDS)

            # Alt+Up restores the target into Codex's composer. Ctrl+U removes it from the
            # composer; a non-empty replacement is then queued with the normal Tab action.
            self.write_input(session_id, "\x15")
            await asyncio.sleep(TermdeckConfig.PROMPT_SUBMIT_KEY_DELAY_SECONDS)
            if not remove and replacement.strip():
                await self._queue_prompt_text(session_id, replacement, bracketed)

            # Rebuild only the messages newer than the edited row. Their order is preserved.
            for newer_text in texts[index + 1:]:
                await self._queue_prompt_text(session_id, newer_text, bracketed)

            ms.record.draft = ""
            ms.draft_tracker = DraftInputTracker("")
            self._schedule_draft_persist()
            self._persist()
            self._broadcast_control(ms, {WsMessageFields.TYPE: WsMessageFields.DRAFT,
                                         WsMessageFields.DRAFT: ""})
            self._broadcast_control(ms, {WsMessageFields.TYPE: WsMessageFields.QUEUE_MUTATION,
                                         WsMessageFields.OK: True,
                                         WsMessageFields.QUEUE: resulting_queue})
        except Exception as exc:
            self._broadcast_control(ms, {WsMessageFields.TYPE: WsMessageFields.QUEUE_MUTATION,
                                         WsMessageFields.OK: False,
                                         WsMessageFields.ERROR: str(exc)})

    async def _queue_prompt_text(self, session_id: str, text: str, bracketed: bool) -> None:
        normalized = str(text or "")[:TermdeckConfig.DRAFT_MAX_CHARS]
        payload = "\x15"
        if normalized:
            if bracketed:
                payload += TermdeckConfig.BRACKETED_PASTE_START.decode() + normalized + TermdeckConfig.BRACKETED_PASTE_END.decode()
            else:
                payload += normalized
        self.write_input(session_id, payload)
        await asyncio.sleep(TermdeckConfig.PROMPT_SUBMIT_KEY_DELAY_SECONDS)
        self.write_input(session_id, "\t")
        await asyncio.sleep(TermdeckConfig.PROMPT_SUBMIT_KEY_DELAY_SECONDS)

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
        size_changed = (ms.record.cols, ms.record.rows) != (cols, rows)
        ms.cols, ms.rows = cols, rows
        if ms.proc is not None:
            ms.proc.resize(cols, rows)
        if size_changed:
            ms.record.cols, ms.record.rows = cols, rows
            self._persist()

    async def restart_session(self, session_id: str, permission: str = "") -> None:
        ms = self._sessions[session_id]
        if ms.detect_task is not None:
            ms.detect_task.cancel()
        if permission:
            self._set_restart_permission(ms.record, permission)
            self._persist()
        if not await self._terminate_proc(ms):
            raise RuntimeError(f"could not stop dtach session before restart: {session_id}")
        self._spawn(ms, resume=True)

    def rename_session(self, session_id: str, title: str) -> None:
        ms = self._sessions[session_id]
        clean_title = " ".join(str(title or "").splitlines()).strip()
        if not clean_title:
            return
        ms.record.title = clean_title
        ms.record.title_user_set = True
        if ms.record.agent_kind == AgentKind.CODEX.value:
            if ms.record.agent_session_id:
                if ms.agent_rename_task is not None and not ms.agent_rename_task.done():
                    ms.agent_rename_task.cancel()
                ms.agent_rename_task = asyncio.create_task(
                    self._send_codex_rename_command(ms, clean_title, clear_composer=True)
                )
            else:
                ms.pending_agent_rename = clean_title
                ms.pending_agent_rename_deadline = time.monotonic() + 20.0
                self._schedule_detection(ms, 0.1)
        self._persist()
        self._broadcast_status(ms)

    def move_session_to_project(self, session_id: str, project: str) -> None:
        project_name = project.strip()
        if not project_name:
            raise ValueError("project is required")
        if self.registry.root_for(project_name) is None:
            raise ValueError(f"unknown project: {project_name}")
        ms = self._sessions[session_id]
        if ms.record.project == project_name:
            return
        ms.record.project = project_name
        self._persist()
        self._broadcast_status(ms)

    async def delete_session(self, session_id: str) -> bool:
        ms = self._sessions[session_id]
        if ms.detect_task is not None:
            ms.detect_task.cancel()
        if not await self._terminate_proc(ms):
            return False
        self._sessions.pop(session_id)
        self._broadcast_control(ms, {WsMessageFields.TYPE: WsMessageFields.DELETED})
        if not ms.record.title_user_set and ms.cli_title:
            ms.record.title = ms.cli_title
        self._closed_store.push(ms.record, TimeUtil.now_est_naive_iso())
        self._persist()
        return True

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
                if ms.running}

    def _dtach_socket_paths(self) -> list[Path]:
        if not TermdeckConfig.DTACH_DIR.exists():
            return []
        suffix = TermdeckConfig.DTACH_SOCKET_SUFFIX
        return sorted(path for path in TermdeckConfig.DTACH_DIR.iterdir()
                      if path.name.endswith(suffix) and path.name != suffix)

    @staticmethod
    def _socket_session_id(socket: Path) -> str:
        suffix = TermdeckConfig.DTACH_SOCKET_SUFFIX
        return socket.name.removesuffix(suffix)

    async def terminal_process_report(self) -> dict[str, object]:
        """Read-only inventory of every process reachable from TermDeck's dtach sockets."""
        entries: list[dict[str, object]] = []
        all_processes: list[dict[str, int | float | str]] = []
        for socket in self._dtach_socket_paths():
            session_id = self._socket_session_id(socket)
            ms = self._sessions.get(session_id)
            pids = await ProcTreeUtil.tree_pids_for_socket(str(socket))
            processes = await ProcTreeUtil.process_details(pids)
            if ms is not None:
                ms.detached_live = bool(pids)
            entries.append({
                "session_id": session_id,
                "known_session": ms is not None,
                "title": ms.record.title if ms is not None else None,
                "project": ms.record.project if ms is not None else None,
                "socket": str(socket),
                "live": bool(pids),
                "attached": bool(ms and ms.attached),
                "detached": bool(ms and ms.detached_live and not ms.attached),
                "processes": processes,
            })
            all_processes.extend(processes)
        zombie_count = sum(1 for process in all_processes if str(process["state"]).startswith("Z"))
        node_repl_count = sum(1 for process in all_processes if "cua_node/bin/node_repl" in str(process["command"]))
        return {
            "summary": {
                "sockets": len(entries),
                "live_sockets": sum(1 for entry in entries if entry["live"]),
                "detached_sessions": sum(1 for entry in entries if entry["detached"]),
                "orphan_sockets": sum(1 for entry in entries if not entry["known_session"]),
                "stale_sockets": sum(1 for entry in entries if not entry["live"]),
                "processes": len(all_processes),
                "node_repl_processes": node_repl_count,
                "zombie_processes": zombie_count,
            },
            "sockets": entries,
        }

    async def reclaim_orphan_dtach_sessions(self) -> dict[str, object]:
        """Explicitly reclaim only sockets that have no persisted TermDeck session record."""
        reclaimed: list[str] = []
        failed: list[str] = []
        for socket in self._dtach_socket_paths():
            session_id = self._socket_session_id(socket)
            if session_id in self._sessions:
                continue
            if await self._kill_dtach_socket(socket):
                reclaimed.append(session_id)
            else:
                failed.append(session_id)
        return {"reclaimed": reclaimed, "failed": failed, "report": await self.terminal_process_report()}

    async def _reconcile_session_socket(self, ms: ManagedSession) -> None:
        socket = self._dtach_socket(ms.record.session_id)
        ms.detached_live = bool(await ProcTreeUtil.tree_pids_for_socket(str(socket)))
        if not ms.detached_live:
            await self._remove_dead_dtach_socket(socket)

    async def _remove_dead_dtach_socket(self, socket: Path) -> bool:
        """Unlink a socket only after a fresh process-tree check proves it has no holder."""
        if await ProcTreeUtil.tree_pids_for_socket(str(socket)):
            return False
        try:
            socket.unlink()
        except FileNotFoundError:
            pass
        return True

    async def _kill_dtach_socket(self, socket: Path) -> bool:
        """Terminate one TermDeck-owned dtach tree and verify its socket is gone."""
        for signal_number in (signal.SIGTERM, signal.SIGKILL):
            tree_pids = await ProcTreeUtil.tree_pids_for_socket(str(socket))
            alive = [pid for pid in tree_pids if self._pid_alive(pid)]
            if not alive:
                return await self._remove_dead_dtach_socket(socket)
            for pid in alive:
                self._signal_pid(pid, signal_number)
            for _ in range(TermdeckConfig.KILL_GRACE_POLLS):
                if not await ProcTreeUtil.tree_pids_for_socket(str(socket)):
                    return await self._remove_dead_dtach_socket(socket)
                await asyncio.sleep(TermdeckConfig.KILL_GRACE_POLL_SECONDS)
        return await self._remove_dead_dtach_socket(socket)

    async def _kill_dtach_session(self, session_id: str) -> bool:
        return await self._kill_dtach_socket(self._dtach_socket(session_id))

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

    async def _terminate_proc(self, ms: ManagedSession) -> bool:
        socket_removed = await self._kill_dtach_session(ms.record.session_id)
        ms.detached_live = not socket_removed
        proc = ms.proc
        if proc is None:
            return socket_removed
        proc.terminate()
        for _ in range(TermdeckConfig.KILL_GRACE_POLLS):
            if proc.finished:
                return socket_removed
            await asyncio.sleep(TermdeckConfig.KILL_GRACE_POLL_SECONDS)
        proc.kill()
        for _ in range(TermdeckConfig.KILL_GRACE_POLLS):
            if proc.finished:
                return socket_removed
            await asyncio.sleep(TermdeckConfig.KILL_GRACE_POLL_SECONDS)
        # A removed socket is necessary but not sufficient when an attached
        # bridge somehow ignores both signals: keep the session record so the
        # operator can see and retry its cleanup rather than orphaning that
        # still-running local child process.
        return socket_removed and proc.finished

    async def kill_all_running_sessions(self) -> int:
        targets = [ms for ms in self._sessions.values() if ms.running]
        for ms in targets:
            ms.lazy_start_pending = True
            if ms.detect_task is not None:
                ms.detect_task.cancel()
        results = await asyncio.gather(*(self._terminate_proc(ms) for ms in targets), return_exceptions=True)
        killed = 0
        for ms, result in zip(targets, results, strict=True):
            if result is True:
                killed += 1
                ms.proc = None
                ms.detached_live = False
                ms.exit_code = None
                ms.processing_started_at = None
            self._broadcast_status(ms)
        self._persist()
        return killed

    def detach_for_shutdown(self) -> None:
        self._persist()
        TermdeckConfig.SCROLLBACK_DIR.mkdir(parents=True, exist_ok=True)
        for ms in self._sessions.values():
            if ms.buffer:
                target = TermdeckConfig.SCROLLBACK_DIR / f"{ms.record.session_id}{TermdeckConfig.SCROLLBACK_SUFFIX}"
                target.write_bytes(bytes(ms.buffer))

    def list_sessions(self, project: str | None) -> list[dict[str, object]]:
        return [self.session_summary(ms) for ms in self._sessions.values()
                if project is None or ms.record.project == project]

    def session_summary(self, ms: ManagedSession) -> dict[str, object]:
        processing = self._sync_processing_started(ms)
        summary: dict[str, object] = dict(ms.record.to_dict())
        summary[ApiFields.RUNNING] = ms.running
        summary[ApiFields.EXIT_CODE] = ms.exit_code
        summary[ApiFields.DORMANT] = ms.dormant
        summary[ApiFields.DETACHED] = ms.detached_live and not ms.attached
        summary[ApiFields.CLI_TITLE] = ms.cli_title
        summary["processing"] = processing
        summary["processing_since"] = ms.processing_started_at
        summary["last_activity_at"] = ms.last_activity_at
        return summary

    def session_summary_by_id(self, session_id: str) -> dict[str, object]:
        return self.session_summary(self._sessions[session_id])

    def session_history_source(self, session_id: str) -> tuple[str, str, str | None]:
        record = self._sessions[session_id].record
        return record.agent_kind, record.cwd, record.agent_session_id

    def session_draft(self, session_id: str) -> str:
        return self._sessions[session_id].record.draft

    def _persist(self) -> None:
        self._store.save_all([ms.record for ms in self._sessions.values()])
