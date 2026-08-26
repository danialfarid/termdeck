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

from termdeck import agents
from termdeck.agent_session_tracker import AgentSessionTracker
from termdeck.claude_activity_watcher import ClaudeActivityWatcher
from termdeck.config import TermdeckConfig
from termdeck.proc_tree import ProcTreeUtil
from termdeck.draft_tracker import DraftInputTracker
from termdeck.models import ApiFields, SessionRecord, WsMessageFields
from termdeck.project_registry import ProjectRegistry
from termdeck.pty_process import PtyProcess
from termdeck.session_store import ClosedSessionStore, SessionStore
from termdeck.state_backup import StateBackupManager
from termdeck.util import OscTitleParser, TimeUtil
from termdeck.worktree_service import WorktreeMetadata


class ManagedSession:
    """Runtime state for one terminal: persisted record, live pty (if running), scrollback, attached client queues."""

    def __init__(self, record: SessionRecord) -> None:
        self.record = record
        self.proc: PtyProcess | None = None
        self.buffer = bytearray()
        self.client_queues: set[asyncio.Queue] = set()
        # Whether the pty produced output while nothing was attached to receive it. A reconnecting client
        # claiming have_buffer is only safe to trust when it missed nothing: a TUI paints at absolute
        # cursor positions, so landing new writes on a screen that skipped an update composites the two
        # into garbage rather than merely lagging behind.
        self.output_missed_while_detached = False
        self.processing_expiry_task: asyncio.Task | None = None
        self.exit_code: int | None = None
        self.lazy_start_pending = False
        # A dtach master can outlive the TermDeck server. It has no local
        # PtyProcess bridge until a browser/API client attaches again, but it
        # is still a real running terminal and must be counted for cleanup.
        self.detached_live = False
        self.detect_task: asyncio.Task | None = None
        self.detect_kind: str = "none"
        self.detect_baseline: set[Path] = set()
        self.cols = record.cols
        self.rows = record.rows
        self.cli_title: str | None = record.cli_title
        self.title_updated_monotonic = 0.0
        self.title_carry = b""
        self.title_recovered_from_buffer = False
        self.pending_agent_rename: str | None = None
        self.pending_agent_rename_deadline = 0.0
        self.agent_rename_task: asyncio.Task | None = None
        self.osc_query_carry = b""
        self.last_repaint_offset: int | None = None
        self.repaint_activity_suppressed_until_monotonic = 0.0
        self.scrollback_sync_carry = b""
        self.screen_lives_only_in_stripped_sync_frames = False
        self.claude_raw_replay_buffer = bytearray()
        self.claude_raw_replay_title_carry = b""
        self.claude_raw_replay_last_title = b""
        self.scrollback_checkpoint_pending = bytearray()
        self.scrollback_compaction_generation = 0
        self.scrollback_checkpoint_compaction_generation = 0
        self.claude_raw_replay_checkpoint_pending = bytearray()
        self.claude_raw_replay_compaction_generation = 0
        self.claude_raw_replay_checkpoint_compaction_generation = 0
        self.terminal_history_cleared_for_spawn = False
        # Whether attach_client has already treated a cold (no-strip-witnessed-yet) claude/codex attach as
        # needing a repaint. Scoped to a single occurrence per process lifetime so a burst of simultaneous
        # reconnects across every open tab at once (e.g. right after a server restart) doesn't also mean a
        # simultaneous pty resize nudge for every single one of them on every future reattach.
        self.cold_attach_repaint_done = False
        self.screen_repaint_task: asyncio.Task | None = None
        self.draft_tracker = DraftInputTracker(record.draft)
        self.detect_attempts = 0
        self.detect_deadline_monotonic = 0.0
        self.last_input_monotonic = 0.0
        self.last_agent_submit_monotonic = 0.0
        self.last_activity_at = record.last_activity_at
        self.last_activity_broadcast_monotonic = 0.0
        # Per-agent runtime state (activity flags, signatures, pending renames); shape is owned
        # by the AgentCli, None for plain shells.
        self.agent_state = agents.agent_cli(record.agent_kind).new_session_state()
        self.processing_started_at: float | None = None
        self.attention_required = False
        self.attention_text_carry = ""
        # Set once a Claude Code hook reports for this session. Hooks are an explicit signal from the
        # agent itself, so they supersede the terminal-text/title heuristics below, which only guess at
        # a permission prompt from rendered output and misfire on wrapped or partially repainted screens.
        self.attention_hook_driven = False
        self.output_path: Path | None = Path(record.output_path).expanduser() if record.output_path else None
        self.output_path_locked = False

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
        return self.title_has_processing_marker(self.cli_title) and \
            time.monotonic() - self.title_updated_monotonic < 3.0

    @staticmethod
    def title_has_processing_marker(value: str | None) -> bool:
        marker = value[:1] if value else ""
        return "\u2800" <= marker <= "\u28ff" or "○" <= marker <= "◗" or marker == "✳"

    @property
    def dormant(self) -> bool:
        return self.lazy_start_pending and not self.running


class TerminalSessionManager:
    SCROLLBACK_REPLAY_KIND = "scrollback"
    RAW_REPLAY_KIND = "raw-replay"
    CLAUDE_RAW_REPLAY_TITLE_PREFIXES = (b"\x1b]0;", b"\x1b]1;", b"\x1b]2;")
    CLAUDE_RAW_REPLAY_BEL = b"\x07"
    CLAUDE_RAW_REPLAY_ST = b"\x1b\\"
    CLAUDE_RAW_REPLAY_CLEAR = b"\x1b[2J"
    CLAUDE_RAW_REPLAY_HOME = b"\x1b[H"
    CLAUDE_RAW_REPLAY_ERASE_LINE = b"\x1b[2K"
    CLAUDE_RAW_REPLAY_CURSOR_DOWN = b"\x1b[1B"
    CLAUDE_RAW_REPLAY_CLEAR_ROW = CLAUDE_RAW_REPLAY_ERASE_LINE + CLAUDE_RAW_REPLAY_CURSOR_DOWN

    """Creates, respawns, and tears down terminal sessions; broadcasts pty output to attached websocket queues;
    persists session records and resolves claude/codex agent session ids so a server restart can resume them."""

    def __init__(self, backup_manager: StateBackupManager | None = None) -> None:
        self._store = SessionStore(TermdeckConfig.SESSIONS_FILE, backup_manager)
        self._closed_store = ClosedSessionStore(TermdeckConfig.CLOSED_SESSIONS_FILE, backup_manager)
        self.registry = ProjectRegistry(TermdeckConfig.PROJECTS_FILE, backup_manager)
        self._tracker = AgentSessionTracker()
        self._sessions: dict[str, ManagedSession] = {}
        self._status_queues: set[asyncio.Queue] = set()
        self._draft_persist_task: asyncio.Task | None = None
        self._replay_checkpoint_task: asyncio.Task[None] | None = None
        self._background_loop: asyncio.AbstractEventLoop | None = None
        self._agent_activity_refresh_handles: dict[Path, asyncio.TimerHandle] = {}
        self._claude_activity_confirmation_handles: dict[Path, asyncio.TimerHandle] = {}
        self._transcript_service = None
        self._history_index = None
        self._claude_raw_replay_enabled = True
        self._claude_full_raw_replay_enabled = True
        self._claude_raw_replay_total_bytes = 0
        self._claude_activity_watcher = ClaudeActivityWatcher(
            TermdeckConfig.CLAUDE_PROJECTS_DIR, self._on_claude_file_change_from_thread)

    def attach_transcript_service(self, service) -> None:
        self._transcript_service = service

    def attach_history_index(self, index) -> None:
        self._history_index = index

    def start_background_tasks(self) -> None:
        self._background_loop = asyncio.get_running_loop()
        self._claude_activity_watcher.start()
        if self._replay_checkpoint_task is None or self._replay_checkpoint_task.done():
            self._replay_checkpoint_task = asyncio.create_task(self._periodically_checkpoint_active_replays())

    def stop_background_tasks(self) -> None:
        self._claude_activity_watcher.stop()
        if self._replay_checkpoint_task is not None:
            self._replay_checkpoint_task.cancel()
            self._replay_checkpoint_task = None
        for handle in self._agent_activity_refresh_handles.values():
            handle.cancel()
        self._agent_activity_refresh_handles.clear()
        for handle in self._claude_activity_confirmation_handles.values():
            handle.cancel()
        self._claude_activity_confirmation_handles.clear()
        self._background_loop = None

    def _on_claude_file_change_from_thread(self, path: Path) -> None:
        if self._history_index is not None:
            self._history_index.notify_file_changed(path)
        if self._transcript_service is not None:
            self._transcript_service.notify_file_change(path)
        if self._background_loop is not None:
            self._background_loop.call_soon_threadsafe(self._process_claude_file_change, path)

    def _process_claude_file_change(self, path: Path) -> None:
        agents.agent_cli("claude").on_project_file_change(self, path)
        loop = self._background_loop
        if loop is None:
            return
        previous = self._claude_activity_confirmation_handles.pop(path, None)
        if previous is not None:
            previous.cancel()
        self._claude_activity_confirmation_handles[path] = loop.call_later(
            TermdeckConfig.AGENT_TRANSCRIPT_ACTIVITY_DEBOUNCE_SECONDS,
            self._confirm_claude_file_change, path)

    def _confirm_claude_file_change(self, path: Path) -> None:
        self._claude_activity_confirmation_handles.pop(path, None)
        agents.agent_cli("claude").on_project_file_change(self, path)

    @staticmethod
    def _claude_raw_replay_path(session_id: str) -> Path:
        return TermdeckConfig.SCROLLBACK_DIR / f"{session_id}{TermdeckConfig.CLAUDE_RAW_REPLAY_SUFFIX}"

    @staticmethod
    def _scrollback_path(session_id: str) -> Path:
        return TermdeckConfig.SCROLLBACK_DIR / f"{session_id}{TermdeckConfig.SCROLLBACK_SUFFIX}"

    @staticmethod
    def _write_replay_checkpoint_atomically(target: Path, payload: bytes) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_bytes(payload)
            temporary.replace(target)
        finally:
            if temporary.exists():
                temporary.unlink()

    @staticmethod
    def _append_replay_checkpoint_bytes(target: Path, payload: bytes) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("ab") as checkpoint_file:
            checkpoint_file.write(payload)
            checkpoint_file.flush()
            os.fsync(checkpoint_file.fileno())

    @staticmethod
    def _read_replay_checkpoint_tail(target: Path, byte_limit: int) -> tuple[bytes, bool]:
        target_bytes = target.stat().st_size
        with target.open("rb") as checkpoint_file:
            if target_bytes > byte_limit:
                checkpoint_file.seek(-byte_limit, os.SEEK_END)
            return checkpoint_file.read(), target_bytes > byte_limit

    @staticmethod
    def _replay_checkpoint_snapshot(ms: ManagedSession, replay_kind: str, target: Path, full_payload: bytes,
                                    pending: bytearray, byte_limit: int, compaction_generation: int,
                                    checkpoint_compaction_generation: int) -> tuple[ManagedSession, str, int, Path, bytes, bytes, bool] | None:
        if not pending and compaction_generation == checkpoint_compaction_generation and target.exists():
            return None
        pending_payload = bytes(pending)
        target_bytes = target.stat().st_size if target.exists() else 0
        replace = not target.exists() or compaction_generation != checkpoint_compaction_generation or \
            target_bytes + len(pending_payload) > byte_limit
        write_payload = full_payload if replace else pending_payload
        if not write_payload:
            return None
        return ms, replay_kind, compaction_generation, target, write_payload, pending_payload, replace

    def _pending_replay_checkpoint_snapshots(self, active_only: bool) -> list[tuple[ManagedSession, str, int, Path, bytes, bytes, bool]]:
        snapshots: list[tuple[ManagedSession, str, int, Path, bytes, bytes, bool]] = []
        for ms in self._sessions.values():
            if active_only and not ms.running:
                continue
            agent = agents.agent_cli(ms.record.agent_kind)
            if not agent.is_agent and ms.buffer:
                snapshot = self._replay_checkpoint_snapshot(
                    ms, self.SCROLLBACK_REPLAY_KIND, self._scrollback_path(ms.record.session_id), bytes(ms.buffer),
                    ms.scrollback_checkpoint_pending, TermdeckConfig.SCROLLBACK_BYTES,
                    ms.scrollback_compaction_generation, ms.scrollback_checkpoint_compaction_generation)
                if snapshot is not None:
                    snapshots.append(snapshot)
            if self._claude_raw_replay_enabled and agent.records_raw_replay and ms.claude_raw_replay_buffer:
                snapshot = self._replay_checkpoint_snapshot(
                    ms, self.RAW_REPLAY_KIND, self._claude_raw_replay_path(ms.record.session_id),
                    self._claude_raw_replay_bytes(ms), ms.claude_raw_replay_checkpoint_pending,
                    TermdeckConfig.CLAUDE_RAW_REPLAY_SESSION_BYTES, ms.claude_raw_replay_compaction_generation,
                    ms.claude_raw_replay_checkpoint_compaction_generation)
                if snapshot is not None:
                    snapshots.append(snapshot)
        return snapshots

    @staticmethod
    def _record_replay_checkpoint_success(ms: ManagedSession, replay_kind: str, compaction_generation: int,
                                          pending_payload: bytes, replaced: bool) -> None:
        if replay_kind == TerminalSessionManager.SCROLLBACK_REPLAY_KIND:
            pending = ms.scrollback_checkpoint_pending
            if bytes(pending[:len(pending_payload)]) == pending_payload:
                del pending[:len(pending_payload)]
            if replaced and ms.scrollback_compaction_generation == compaction_generation:
                ms.scrollback_checkpoint_compaction_generation = compaction_generation
            return
        pending = ms.claude_raw_replay_checkpoint_pending
        if bytes(pending[:len(pending_payload)]) == pending_payload:
            del pending[:len(pending_payload)]
        if replaced and ms.claude_raw_replay_compaction_generation == compaction_generation:
            ms.claude_raw_replay_checkpoint_compaction_generation = compaction_generation

    async def _checkpoint_active_replays(self) -> None:
        for ms, replay_kind, compaction_generation, target, payload, pending_payload, replace in \
                self._pending_replay_checkpoint_snapshots(True):
            try:
                writer = self._write_replay_checkpoint_atomically if replace else self._append_replay_checkpoint_bytes
                await asyncio.to_thread(writer, target, payload)
            except OSError as checkpoint_error:
                print(f"termdeck replay checkpoint failed for {ms.record.session_id}: {checkpoint_error}", flush=True)
                continue
            self._record_replay_checkpoint_success(
                ms, replay_kind, compaction_generation, pending_payload, replace)

    async def _periodically_checkpoint_active_replays(self) -> None:
        while True:
            await asyncio.sleep(TermdeckConfig.REPLAY_CHECKPOINT_INTERVAL_SECONDS)
            await self._checkpoint_active_replays()

    def _checkpoint_all_replays(self) -> None:
        for ms, replay_kind, compaction_generation, target, payload, pending_payload, replace in \
                self._pending_replay_checkpoint_snapshots(False):
            writer = self._write_replay_checkpoint_atomically if replace else self._append_replay_checkpoint_bytes
            writer(target, payload)
            self._record_replay_checkpoint_success(
                ms, replay_kind, compaction_generation, pending_payload, replace)

    @classmethod
    def _claude_raw_replay_partial_title_prefix_length(cls, data: bytes) -> int:
        partial_length = 0
        for prefix in cls.CLAUDE_RAW_REPLAY_TITLE_PREFIXES:
            for length in range(1, len(prefix)):
                if data.endswith(prefix[:length]):
                    partial_length = max(partial_length, length)
        return partial_length

    @classmethod
    def _collapse_claude_raw_replay_titles(cls, ms: ManagedSession, data: bytes) -> bytes:
        combined = ms.claude_raw_replay_title_carry + data
        ms.claude_raw_replay_title_carry = b""
        output = bytearray()
        position = 0
        while position < len(combined):
            title_starts = [combined.find(prefix, position) for prefix in cls.CLAUDE_RAW_REPLAY_TITLE_PREFIXES]
            title_starts = [title_start for title_start in title_starts if title_start >= 0]
            if not title_starts:
                partial_length = cls._claude_raw_replay_partial_title_prefix_length(combined[position:])
                content_end = len(combined) - partial_length
                output.extend(combined[position:content_end])
                if partial_length:
                    ms.claude_raw_replay_title_carry = combined[content_end:]
                break
            title_start = min(title_starts)
            output.extend(combined[position:title_start])
            bel_index = combined.find(cls.CLAUDE_RAW_REPLAY_BEL, title_start + 4)
            st_index = combined.find(cls.CLAUDE_RAW_REPLAY_ST, title_start + 4)
            title_end_candidates = []
            if bel_index >= 0:
                title_end_candidates.append(bel_index + len(cls.CLAUDE_RAW_REPLAY_BEL))
            if st_index >= 0:
                title_end_candidates.append(st_index + len(cls.CLAUDE_RAW_REPLAY_ST))
            if not title_end_candidates:
                ms.claude_raw_replay_title_carry = combined[title_start:]
                break
            title_end = min(title_end_candidates)
            ms.claude_raw_replay_last_title = combined[title_start:title_end]
            position = title_end
        return bytes(output)

    @classmethod
    def _trim_claude_raw_replay_front(cls, replay_buffer: bytearray, minimum_bytes: int) -> int:
        if minimum_bytes <= 0 or not replay_buffer:
            return 0
        minimum_bytes = min(minimum_bytes, len(replay_buffer))
        search_end = min(len(replay_buffer), minimum_bytes + 1_000_000)
        boundaries = [replay_buffer.find(TermdeckConfig.SYNC_UPDATE_START, minimum_bytes, search_end),
                      replay_buffer.find(cls.CLAUDE_RAW_REPLAY_CLEAR, minimum_bytes, search_end)]
        boundaries = [boundary for boundary in boundaries if boundary >= 0]
        remove_bytes = min(boundaries) if boundaries else minimum_bytes
        del replay_buffer[:remove_bytes]
        return remove_bytes

    def _enforce_claude_raw_replay_total_limit(self) -> None:
        overflow = self._claude_raw_replay_total_bytes - TermdeckConfig.CLAUDE_RAW_REPLAY_TOTAL_BYTES
        if overflow <= 0:
            return
        candidates = sorted((ms for ms in self._sessions.values() if ms.claude_raw_replay_buffer),
                            key=lambda candidate: candidate.last_activity_at)
        for candidate in candidates:
            if overflow <= 0:
                break
            removed = self._trim_claude_raw_replay_front(candidate.claude_raw_replay_buffer, overflow)
            self._claude_raw_replay_total_bytes -= removed
            overflow -= removed
            if removed:
                candidate.claude_raw_replay_compaction_generation += 1

    def _append_claude_raw_replay(self, ms: ManagedSession, data: bytes) -> None:
        if not self._claude_raw_replay_enabled or \
                not agents.agent_cli(ms.record.agent_kind).records_raw_replay:
            return
        filtered = self._collapse_claude_raw_replay_titles(ms, data)
        if not filtered:
            return
        previous_bytes = len(ms.claude_raw_replay_buffer)
        ms.claude_raw_replay_buffer.extend(filtered)
        ms.claude_raw_replay_checkpoint_pending.extend(filtered)
        session_overflow = len(ms.claude_raw_replay_buffer) - TermdeckConfig.CLAUDE_RAW_REPLAY_SESSION_BYTES
        if session_overflow > 0:
            self._trim_claude_raw_replay_front(ms.claude_raw_replay_buffer, session_overflow)
            ms.claude_raw_replay_compaction_generation += 1
        self._claude_raw_replay_total_bytes += len(ms.claude_raw_replay_buffer) - previous_bytes
        self._enforce_claude_raw_replay_total_limit()

    def _seed_claude_raw_replay_from_durable_buffer(self, ms: ManagedSession) -> None:
        if not agents.agent_cli(ms.record.agent_kind).records_raw_replay or ms.claude_raw_replay_buffer or not ms.buffer:
            return
        replay = self._replay_bytes(ms)[-TermdeckConfig.CLAUDE_RAW_REPLAY_SESSION_BYTES:]
        ms.claude_raw_replay_buffer.extend(replay)
        self._claude_raw_replay_total_bytes += len(replay)
        ms.claude_raw_replay_compaction_generation += 1

    def _discard_claude_raw_replay(self, ms: ManagedSession) -> None:
        self._claude_raw_replay_total_bytes = max(
            0, self._claude_raw_replay_total_bytes - len(ms.claude_raw_replay_buffer))
        ms.claude_raw_replay_buffer.clear()
        ms.claude_raw_replay_title_carry = b""
        ms.claude_raw_replay_last_title = b""
        ms.claude_raw_replay_checkpoint_pending.clear()
        ms.claude_raw_replay_compaction_generation += 1

    @staticmethod
    def _claude_raw_replay_bytes(ms: ManagedSession) -> bytes:
        return bytes(ms.claude_raw_replay_buffer) + ms.claude_raw_replay_last_title

    @classmethod
    def _claude_raw_replay_clear_frame_rows(cls, frame: bytes) -> int:
        if not frame.startswith(cls.CLAUDE_RAW_REPLAY_HOME):
            return 0
        body = frame[len(cls.CLAUDE_RAW_REPLAY_HOME):]
        row_bytes = len(cls.CLAUDE_RAW_REPLAY_CLEAR_ROW)
        if not body or len(body) % row_bytes:
            return 0
        rows = len(body) // row_bytes
        return rows if rows >= 2 and body == cls.CLAUDE_RAW_REPLAY_CLEAR_ROW * rows else 0

    @classmethod
    def _claude_raw_screen_replay_frames(cls, ms: ManagedSession) -> list[bytes]:
        replay = bytes(ms.claude_raw_replay_buffer)
        if not replay:
            return []
        replay_start = 0
        for divider in (TermdeckConfig.RESPAWN_DIVIDER.encode(), TermdeckConfig.REATTACH_DIVIDER.encode()):
            divider_position = replay.rfind(divider)
            if divider_position >= replay_start:
                replay_start = divider_position + len(divider)
        home_positions: list[int] = []
        home_position = replay.find(cls.CLAUDE_RAW_REPLAY_HOME, replay_start)
        while home_position >= 0:
            home_positions.append(home_position)
            home_position = replay.find(cls.CLAUDE_RAW_REPLAY_HOME,
                                        home_position + len(cls.CLAUDE_RAW_REPLAY_HOME))
        frames: list[bytes] = []
        for content_index in range(1, len(home_positions)):
            clear_start = home_positions[content_index - 1]
            content_start = home_positions[content_index]
            if not cls._claude_raw_replay_clear_frame_rows(replay[clear_start:content_start]):
                continue
            content_end = home_positions[content_index + 1] if content_index + 1 < len(home_positions) else len(replay)
            content = replay[content_start:content_end]
            if len(content) > len(cls.CLAUDE_RAW_REPLAY_HOME):
                frames.append(content)
        return frames

    @classmethod
    def _latest_claude_raw_screen_replay(cls, ms: ManagedSession) -> bytes:
        frames = cls._claude_raw_screen_replay_frames(ms)
        return (frames[-1] + ms.claude_raw_replay_last_title) if frames else b""

    @classmethod
    def _full_claude_raw_screen_replay(cls, ms: ManagedSession) -> bytes:
        frames = cls._claude_raw_screen_replay_frames(ms)
        if not frames:
            return b""
        longest_frame = max(frames, key=lambda frame: len(cls._searchable_terminal_text(frame).splitlines()))
        return longest_frame + ms.claude_raw_replay_last_title

    def _clear_claude_terminal_history_for_restart(self, ms: ManagedSession) -> None:
        # History survives the restart. This used to discard the raw recording and hard-reset every
        # surface, so a restarted claude's terminal began life with only whatever the resumed process
        # repainted -- days of scrollback gone from the tab and from every future replay. The recording
        # and durable buffer are kept; the spawn path's own divider mechanism then scrolls the old
        # screen into scrollback (see _spawn), the "restarted" rule lands between old and new, and the
        # resumed claude paints its fresh screen below. Only the parse carries and repaint bookkeeping
        # reset, since they describe the terminated process's stream.
        ms.title_carry = b""
        ms.osc_query_carry = b""
        ms.scrollback_sync_carry = b""
        ms.claude_raw_replay_title_carry = b""
        ms.screen_lives_only_in_stripped_sync_frames = False
        ms.last_repaint_offset = None
        ms.output_missed_while_detached = False
        ms.cold_attach_repaint_done = False
        if ms.screen_repaint_task is not None and not ms.screen_repaint_task.done():
            ms.screen_repaint_task.cancel()
        ms.screen_repaint_task = None

    async def startup_respawn_saved_sessions(self) -> None:
        for record in self._store.load_all():
            agent = agents.agent_cli(record.agent_kind)
            ms = ManagedSession(record)
            ms.attention_required = agent.transcript_requires_attention(self, ms)
            self._sessions[record.session_id] = ms
            ms.lazy_start_pending = True
            saved = self._scrollback_path(record.session_id)
            if not agent.is_agent and saved.exists():
                replay, requires_compaction = self._read_replay_checkpoint_tail(saved, TermdeckConfig.SCROLLBACK_BYTES)
                ms.buffer.extend(replay)
                if requires_compaction:
                    ms.scrollback_compaction_generation += 1
            if self._claude_raw_replay_enabled and agent.records_raw_replay:
                claude_replay_path = self._claude_raw_replay_path(record.session_id)
                if claude_replay_path.exists():
                    replay, requires_compaction = self._read_replay_checkpoint_tail(
                        claude_replay_path, TermdeckConfig.CLAUDE_RAW_REPLAY_SESSION_BYTES)
                    ms.claude_raw_replay_buffer.extend(replay)
                    self._claude_raw_replay_total_bytes += len(replay)
                    if requires_compaction:
                        ms.claude_raw_replay_compaction_generation += 1
                self._seed_claude_raw_replay_from_durable_buffer(ms)
        self._enforce_claude_raw_replay_total_limit()
        # Do not launch old terminals merely because the web server came up.
        # Reconcile their dtach sockets instead: live sockets remain running
        # and are attached lazily when opened; dead sockets are safe to clear.
        for ms in self._sessions.values():
            agent = agents.agent_cli(ms.record.agent_kind)
            await self._reconcile_session_socket(ms)
            await agent.reconcile_bindings(self, ms)
            self._canonicalize_agent_resume_command(ms.record)
            agent.reconcile_metadata(self, ms)
            self._refresh_session_activity(ms)
            if ms.detached_live and ms.record.agent_session_id:
                agent.refresh_persisted_activity(self, ms)
        self._persist()

    def create_session(self, command: str, cwd: str, title: str, project: str = "", output_path: str = "",
                       agent_rename: str | None = None, worktree: WorktreeMetadata | None = None,
                       worktree_id: str = "root") -> ManagedSession:
        clean_command = command.strip()
        cwd_path = Path(cwd).expanduser() if cwd.strip() else TermdeckConfig.DEFAULT_CWD
        if not cwd_path.is_dir():
            raise ValueError(f"cwd is not a directory: {cwd_path}")
        cleaned_output_path = output_path.strip() if output_path else ""
        if cleaned_output_path:
            expanded_output_path = Path(os.path.expandvars(cleaned_output_path)).expanduser()
            if not expanded_output_path.is_absolute():
                expanded_output_path = cwd_path / expanded_output_path
            cleaned_output_path = str(expanded_output_path.resolve())
        return self._create(clean_command, cwd_path, title, initial_command=None, agent_rename=agent_rename,
                            project=project, output_path=cleaned_output_path, worktree=worktree,
                            worktree_id=worktree_id)

    def command_for_new_session(self, model: str, permission: str, session_ref: str, model_name: str = "") -> str:
        raw_model = model.strip().strip("\"'").lower()
        kind = agents.resolve_model_alias(raw_model) or agents.CodexCli.kind
        try:
            agent = agents.agent_cli(kind)
        except ValueError:
            raise ValueError(f"unknown model: {model}") from None
        return agent.build_command(permission, model_name.strip(), session_ref.strip(), self._tracker)

    def _set_restart_permission(self, record: SessionRecord, permission: str) -> None:
        agent = agents.agent_cli(record.agent_kind)
        if not agent.is_agent:
            return
        record.command = agent.set_permission(record.command, permission)

    def _canonicalize_agent_resume_command(self, record: SessionRecord) -> None:
        if not record.agent_session_id:
            return
        agent = agents.agent_cli(record.agent_kind)
        if not agent.canonical_resume_command:
            return
        record.command = agent.resume_command(record.command, record.agent_session_id)

    def _set_agent_session_binding(self, ms: ManagedSession, agent_session_id: str) -> None:
        ms.record.agent_session_id = agent_session_id
        self._canonicalize_agent_resume_command(ms.record)

    def _create(self, clean_command: str, cwd_path: Path, title: str, initial_command: str | None,
                agent_rename: str | None = None, project: str | None = None,
                output_path: str = "", worktree: WorktreeMetadata | None = None,
                worktree_id: str = "root", fork_parent_agent_session_id: str | None = None) -> ManagedSession:
        agent = agents.detect_agent_cli(clean_command)
        project_name = project.strip() if project and project.strip() else self.registry.ensure_project_for_cwd(cwd_path)
        record = SessionRecord(session_id=uuid.uuid4().hex[:12], title=title.strip() or self._auto_title(clean_command, cwd_path),
                               title_user_set=bool(title.strip()), command=clean_command, cwd=str(cwd_path),
                               agent_kind=agent.kind, agent_session_id=None, created_at_est=TimeUtil.now_est_naive_iso(),
                               draft="", project=project_name, output_path=output_path.strip() or None,
                               worktree_path=worktree.path if worktree else None,
                               worktree_repository=worktree.repository if worktree else None,
                               worktree_branch=worktree.branch if worktree else None,
                               worktree_base_ref=worktree.base_ref if worktree else None,
                               worktree_base_commit=worktree.base_commit if worktree else None,
                               worktree_managed=worktree.managed if worktree else False,
                               worktree_id=worktree_id or (worktree.worktree_id if worktree else "root"),
                               fork_parent_agent_session_id=fork_parent_agent_session_id)
        ms = ManagedSession(record)
        if agent_rename and agent.supports_agent_rename:
            ms.pending_agent_rename = " ".join(agent_rename.splitlines()).strip()
        self._sessions[record.session_id] = ms
        self._spawn(ms, resume=False, initial_command=initial_command)
        self._persist()
        return ms

    def fork_session(self, session_id: str, title: str, worktree: WorktreeMetadata | None = None) -> ManagedSession:
        src = self._sessions[session_id].record
        agent = agents.agent_cli(src.agent_kind)
        if agent.is_agent and src.agent_session_id:
            initial = agent.fork_command(src.command, src.agent_session_id, title)
        else:
            initial = None
        source_worktree = worktree
        if source_worktree is None and src.worktree_path and src.worktree_repository and src.worktree_branch and src.worktree_base_ref and src.worktree_base_commit:
            source_worktree = WorktreeMetadata(src.worktree_path, src.worktree_repository, src.worktree_branch,
                                               src.worktree_base_ref, src.worktree_base_commit, src.worktree_managed,
                                               src.worktree_id)
        return self._create(src.command, Path(src.cwd), title, initial_command=initial,
                            agent_rename=title if agent.supports_fork else None, project=src.project,
                            worktree=source_worktree, worktree_id=source_worktree.worktree_id if source_worktree else src.worktree_id,
                            fork_parent_agent_session_id=src.agent_session_id if agent.fork_tracks_parent else None)

    @staticmethod
    def _auto_title(command: str, cwd: Path) -> str:
        head = Path(command.split()[0]).name if command else Path(TermdeckConfig.SHELL).name
        return f"{head} · {cwd.name}"

    def _spawn(self, ms: ManagedSession, resume: bool, initial_command: str | None = None,
               screen_repaint: bool = True, preserve_claude_raw_replay: bool = False) -> None:
        ms.lazy_start_pending = False
        agent = agents.agent_cli(ms.record.agent_kind)
        agent.before_spawn(self, ms)
        self._canonicalize_agent_resume_command(ms.record)
        socket = self._dtach_socket(ms.record.session_id)
        reattach = resume and self._dtach_socket_live(socket)
        ms.detached_live = reattach
        command = ms.record.command
        if initial_command is not None and not reattach:
            command = initial_command
        elif resume and not reattach and agent.is_agent and ms.record.agent_session_id:
            command = agent.resume_command(ms.record.command, ms.record.agent_session_id)
        baseline = self._tracker.snapshot_session_files(agent.kind, Path(ms.record.cwd)) if agent.is_agent else set()
        if reattach and screen_repaint:
            ms.repaint_activity_suppressed_until_monotonic = max(
                ms.repaint_activity_suppressed_until_monotonic,
                time.monotonic() + TermdeckConfig.SCREEN_REPAINT_REATTACH_DELAY_SECONDS +
                TermdeckConfig.SCREEN_REPAINT_ACTIVITY_SUPPRESSION_SECONDS,
            )
        skip_existing_history_separator = (reattach and preserve_claude_raw_replay) or \
            ms.terminal_history_cleared_for_spawn
        if ms.claude_raw_replay_buffer and not skip_existing_history_separator:
            # Preserves the old screen across the respawn: the divider prints below the content, the
            # cursor is sent to the terminal's OWN last row -- \x1b[9999;1H clamps to the bottom on
            # every client, whatever its height, where the server's pty row count says nothing about a
            # taller client terminal -- and newlines from there scroll content and divider into
            # scrollback before the resumed TUI's home-and-erase can wipe them. The pty's rows bound
            # how deep the TUI can have painted, so that many newlines always carries everything.
            divider = TermdeckConfig.REATTACH_DIVIDER if reattach else TermdeckConfig.RESPAWN_DIVIDER
            payload = "\r\n" + divider + "\x1b[9999;1H" + "\r\n" * (ms.rows + 4)
            self._handle_output(ms, payload.encode(), mark_activity=False)
        elif ms.buffer and not skip_existing_history_separator:
            divider = TermdeckConfig.REATTACH_DIVIDER if reattach else TermdeckConfig.RESPAWN_DIVIDER
            self._handle_output(ms, ("\r\n" * ms.rows + divider + "\r\n").encode(), mark_activity=False)
        elif not reattach:
            self._handle_output(ms, TermdeckConfig.SPAWN_BANNER_TEMPLATE.format(command=command or TermdeckConfig.SHELL).encode(),
                                mark_activity=False)
        ms.terminal_history_cleared_for_spawn = False
        ms.exit_code = None
        try:
            ms.proc = PtyProcess(command, Path(ms.record.cwd), ms.cols, ms.rows,
                                 functools.partial(self._handle_output, ms), functools.partial(self._handle_exit, ms),
                                 dtach_socket=socket,
                                 child_environment={
                                     TermdeckConfig.SESSION_ID_ENV_KEY: ms.record.session_id,
                                     TermdeckConfig.SESSION_NAME_ENV_KEY: ms.record.title,
                                     TermdeckConfig.SESSION_PROJECT_ENV_KEY: ms.record.project,
                                     TermdeckConfig.SESSION_CWD_ENV_KEY: ms.record.cwd,
                                 })
        except (FileNotFoundError, NotADirectoryError, PermissionError) as spawn_error:
            ms.detached_live = False
            ms.exit_code = TermdeckConfig.EXIT_CODE_SPAWN_FAILED
            self._handle_output(ms, TermdeckConfig.SPAWN_ERROR_TEMPLATE.format(error=spawn_error).encode())
            return
        if agent.is_agent:
            ms.detect_kind = agent.kind
            ms.detect_baseline = baseline
            ms.detect_deadline_monotonic = time.monotonic() + TermdeckConfig.AGENT_DETECT_STARTUP_TIMEOUT_SECONDS
            if ms.pending_agent_rename and agent.supports_agent_rename:
                ms.pending_agent_rename_deadline = time.monotonic() + 20.0
            agent.on_spawned(self, ms)
            self._schedule_detection(ms, TermdeckConfig.AGENT_DETECT_INITIAL_DELAY_SECONDS)
        if reattach and screen_repaint:
            self._schedule_screen_repaint(ms, TermdeckConfig.SCREEN_REPAINT_REATTACH_DELAY_SECONDS)
        elif resume and not reattach:
            restart_repaint_delay = agent.restart_screen_repaint_delay(self._claude_raw_replay_enabled)
            if restart_repaint_delay is not None:
                self._schedule_screen_repaint(ms, restart_repaint_delay)
        if resume and not reattach and ms.record.draft:
            asyncio.create_task(self._replay_draft_into_respawn(ms, ms.proc))

    def _schedule_screen_repaint(self, ms: ManagedSession, delay: float) -> None:
        if ms.proc is None or not ms.proc.alive:
            return
        if ms.screen_repaint_task is not None and not ms.screen_repaint_task.done():
            return
        ms.repaint_activity_suppressed_until_monotonic = max(
            ms.repaint_activity_suppressed_until_monotonic,
            time.monotonic() + delay + TermdeckConfig.SCREEN_REPAINT_ACTIVITY_SUPPRESSION_SECONDS,
        )
        ms.screen_repaint_task = asyncio.create_task(self._force_screen_repaint(ms, ms.proc, delay))

    async def _force_screen_repaint(self, ms: ManagedSession, proc: PtyProcess, delay: float) -> None:
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
        if ms.detect_kind == "none":
            return
        if ms.detect_task is not None and not ms.detect_task.done():
            ms.detect_task.cancel()
        ms.detect_attempts = 0
        ms.detect_task = asyncio.create_task(self._detect_after(ms, delay))

    async def _detect_after(self, ms: ManagedSession, delay: float) -> None:
        await asyncio.sleep(delay)
        if not ms.running:
            return
        agent = agents.agent_cli(ms.detect_kind)
        ms.detect_attempts += 1
        socket = self._dtach_socket(ms.record.session_id)
        claimed_agent_ids = self._claimed_agent_ids(ms)
        found = await self._tracker.session_id_from_open_files(agent.kind, socket)
        # A forked Codex process can briefly have both the parent and child
        # rollout files open.  Never bind this tab to an agent ID already
        # owned by another TermDeck session; let the new-file scan select the
        # unclaimed child instead.
        if found in claimed_agent_ids:
            found = None
        found = await agent.verify_detected_session_id(self, ms, found, socket)
        recent_input = (time.monotonic() - ms.last_input_monotonic) < TermdeckConfig.AGENT_DIR_CLAIM_INPUT_WINDOW_SECONDS
        claim_allowed = ms.record.agent_session_id is None and found is None and \
            (agent.detection_claims_new_files or recent_input or bool(ms.pending_agent_rename))
        dir_found = self._tracker.absorb_and_find_new_session_file(
            agent.kind, Path(ms.record.cwd), ms.detect_baseline, claimed_agent_ids, claim_allowed=claim_allowed)
        if found is None:
            found = dir_found
        if found is None:
            found = agent.detection_fallback_session_id(self, ms, claimed_agent_ids)
        if found is None:
            if agent.detection_should_retry(ms):
                ms.detect_task = asyncio.create_task(self._detect_after(ms, 1.0))
            return
        if found != ms.record.agent_session_id:
            ms.detect_deadline_monotonic = 0.0
            self._set_agent_session_binding(ms, found)
            agent.on_agent_session_bound(self, ms)
            if agent.supports_agent_rename and ms.pending_agent_rename:
                rename = ms.pending_agent_rename
                ms.pending_agent_rename = None
                ms.agent_rename_task = asyncio.create_task(agent.rename_after_fork(self, ms, rename))
            self._persist()
            self._broadcast_control(ms, {WsMessageFields.TYPE: WsMessageFields.AGENT_SESSION,
                                         WsMessageFields.AGENT_SESSION_ID: found})
            self._broadcast_status(ms)

    def _processing_state(self, ms: ManagedSession) -> bool:
        if ms.attention_required:
            return False
        return agents.agent_cli(ms.record.agent_kind).is_processing(ms)

    def _update_attention_from_title(self, ms: ManagedSession, title: str | None) -> bool:
        if ms.attention_hook_driven:
            return False
        return agents.agent_cli(ms.record.agent_kind).update_attention_from_title(self, ms, title)

    def _update_attention_from_output(self, ms: ManagedSession, data: bytes) -> bool:
        if ms.attention_hook_driven:
            return False
        return agents.agent_cli(ms.record.agent_kind).update_attention_from_output(self, ms, data)

    def apply_agent_attention_hook(self, agent_session_id: str, attention: bool) -> str | None:
        """Apply a Claude Code hook callback, returning the terminal id it matched or None.

        Hooks fire for every Claude Code session on the machine, including ones this server does not
        own, so an unknown agent session is a normal no-op rather than an error.
        """
        if not agent_session_id:
            return None
        for ms in self._sessions.values():
            if ms.record.agent_session_id != agent_session_id:
                continue
            changed = ms.attention_required != attention or not ms.attention_hook_driven
            ms.attention_hook_driven = True
            ms.attention_required = attention
            if not attention:
                ms.attention_text_carry = ""
            if changed:
                self._broadcast_status(ms)
            return ms.record.session_id
        return None

    def _refresh_session_activity(self, ms: ManagedSession) -> None:
        transcript_activity = self._tracker.session_activity_timestamp(ms.record.agent_kind,
                                                                        Path(ms.record.cwd), ms.record.agent_session_id)
        if transcript_activity <= ms.last_activity_at:
            return
        ms.last_activity_at = transcript_activity
        ms.record.last_activity_at = transcript_activity

    def notify_agent_transcript_changed(self, path: Path) -> None:
        if self._background_loop is not None:
            self._background_loop.call_soon_threadsafe(self._schedule_agent_activity_refresh, path)

    def _schedule_agent_activity_refresh(self, path: Path) -> None:
        if self._background_loop is None:
            return
        previous = self._agent_activity_refresh_handles.pop(path, None)
        if previous is not None:
            previous.cancel()
        self._agent_activity_refresh_handles[path] = self._background_loop.call_later(
            TermdeckConfig.AGENT_TRANSCRIPT_ACTIVITY_DEBOUNCE_SECONDS,
            self._run_agent_activity_refresh, path)

    def _run_agent_activity_refresh(self, path: Path) -> None:
        self._agent_activity_refresh_handles.pop(path, None)
        self._refresh_agent_transcript_activity(path)

    def _refresh_agent_transcript_activity(self, path: Path) -> None:
        for ms in self._sessions.values():
            if not ms.running or not ms.record.agent_session_id:
                continue
            agents.agent_cli(ms.record.agent_kind).on_transcript_event(self, ms, path)

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
        if ManagedSession.title_has_processing_marker(value):
            return value[1:].lstrip()
        return value

    def _status_payload(self, ms: ManagedSession) -> dict[str, object]:
        self._refresh_session_activity(ms)
        agents.agent_cli(ms.record.agent_kind).refresh_activity_for_status(self, ms)
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
            ApiFields.NEEDS_ATTENTION: ms.attention_required,
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

    def _broadcast_processing(self, ms: ManagedSession, processing: bool) -> None:
        self._broadcast_control(ms, {WsMessageFields.TYPE: WsMessageFields.PROCESSING,
                                     WsMessageFields.PROCESSING: processing})

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
        durable_scrollback = not agents.agent_cli(ms.record.agent_kind).is_agent
        if durable_scrollback:
            ms.scrollback_checkpoint_pending.extend(durable)
        overflow = len(ms.buffer) - TermdeckConfig.SCROLLBACK_BYTES
        if overflow > 0:
            del ms.buffer[:overflow]
            if durable_scrollback:
                ms.scrollback_compaction_generation += 1
            if ms.last_repaint_offset is not None:
                ms.last_repaint_offset = max(0, ms.last_repaint_offset - overflow)

    def _append_output_path(self, ms: ManagedSession, data: bytes) -> None:
        output_path = ms.output_path
        if output_path is None:
            return
        if ms.output_path_locked:
            return
        try:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with output_path.open("ab") as output_file:
                output_file.write(data)
        except OSError:
            ms.output_path_locked = True

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

    def _handle_output(self, ms: ManagedSession, data: bytes, mark_activity: bool = True) -> None:
        data = self._answer_and_strip_color_queries(ms, data)
        if not data:
            return
        if mark_activity and time.monotonic() >= ms.repaint_activity_suppressed_until_monotonic:
            ms.last_activity_at = time.time()
            ms.record.last_activity_at = ms.last_activity_at
        self._append_claude_raw_replay(ms, data)
        self._append_collapsing_repaints(ms, data)
        self._append_output_path(ms, data)
        previous_title = ms.cli_title
        previous_processing = self._processing_state(ms)
        cli_title, ms.title_carry = OscTitleParser.extract_latest_title(ms.title_carry, data)
        agent = agents.agent_cli(ms.record.agent_kind)
        title_renamed = False
        attention_changed = False
        if cli_title is not None and cli_title.strip():
            ms.cli_title = cli_title.strip()
            ms.title_updated_monotonic = time.monotonic()
            attention_changed = self._update_attention_from_title(ms, ms.cli_title)
            title_renamed = agent.reconcile_rename(self, ms, previous_title)
            agent.on_cli_title_updated(self, ms)
            self._schedule_processing_expiry(ms)
            current_processing = self._processing_state(ms)
            self._remember_cli_title(ms)
            if attention_changed or title_renamed or self._display_title(ms.cli_title) != self._display_title(previous_title) or current_processing != previous_processing:
                self._broadcast_status(ms)
        else:
            attention_changed = self._update_attention_from_output(ms, data)
            title_renamed = agent.reconcile_rename(self, ms, previous_title)
            if attention_changed or title_renamed:
                self._broadcast_status(ms)
        if ms.client_queues:
            for queue in list(ms.client_queues):
                queue.put_nowait(data)
        else:
            ms.output_missed_while_detached = True
        self._broadcast_activity_if_due(ms)

    def _recover_title_from_buffer(self, ms: ManagedSession) -> None:
        if ms.cli_title is not None:
            return
        if not ms.title_recovered_from_buffer:
            ms.title_recovered_from_buffer = True
            if ms.buffer:
                cli_title = OscTitleParser.extract_latest_title_from_buffer(bytes(ms.buffer))
                if cli_title is not None and cli_title.strip():
                    ms.cli_title = cli_title.strip()
        if ms.cli_title is None:
            ms.cli_title = agents.agent_cli(ms.record.agent_kind).session_title(
                self._tracker, Path(ms.record.cwd), ms.record.agent_session_id)
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
        terms = [token for token in normalized_query.split() if token]
        use_multi_term = (not regex) and len(terms) > 1
        term_patterns: list[re.Pattern[str]] = []
        best_match_weight = 40
        partial_match_weight = 12
        if use_multi_term:
            term_patterns = [re.compile(re.escape(term), flags) for term in terms]
        results: list[dict[str, object]] = []
        for ms in self._sessions.values():
            searchable = self._searchable_terminal_text(bytes(ms.buffer))
            line_starts = [0]
            line_starts.extend(index + 1 for index, character in enumerate(searchable) if character == "\n")
            lines = searchable.splitlines()
            match_count = 0
            snippets: list[dict[str, object]] = []
            snippet_lines: set[int] = set()
            line_scores: dict[int, int] = {}
            max_line_score = 0
            if use_multi_term:
                for line_number, raw_line in enumerate(lines, 1):
                    if not raw_line.strip():
                        continue
                    line_score = 0
                    term_hits = 0
                    for term_pattern in term_patterns:
                        term_matches = term_pattern.findall(raw_line)
                        if term_matches:
                            term_hits += 1
                            match_count += len(term_matches)
                            line_score += partial_match_weight
                    if term_hits == len(term_patterns):
                        line_score += best_match_weight
                    if line_score:
                        line_scores[line_number] = max(line_scores.get(line_number, 0), line_score)
                        if line_score > max_line_score:
                            max_line_score = line_score
            for match in pattern.finditer(searchable):
                line_number = bisect.bisect_right(line_starts, match.start())
                if line_number < 1 or line_number > len(lines):
                    continue
                if use_multi_term:
                    if line_number in snippet_lines:
                        continue
                    line_score = line_scores.get(line_number, 0) + best_match_weight
                    line_scores[line_number] = max(line_score, line_scores.get(line_number, 0))
                    if line_score > max_line_score:
                        max_line_score = line_score
                if line_number in snippet_lines:
                    continue
                match_count += 1
                snippet_lines.add(line_number)
                if len(snippets) >= TermdeckConfig.TERMINAL_SEARCH_MAX_SNIPPETS:
                    continue
                line = lines[line_number - 1].strip()
                if not line:
                    continue
                if len(line) > TermdeckConfig.TERMINAL_SEARCH_SNIPPET_CHARS:
                    line = line[:TermdeckConfig.TERMINAL_SEARCH_SNIPPET_CHARS - 1] + "…"
                snippets.append({"line": line_number, "text": line})
            if not match_count and not line_scores:
                continue
            if use_multi_term:
                ordered_lines = sorted(line_scores.items(), key=lambda item: (-item[1], item[0]))
                snippets = []
                snippet_lines.clear()
                for line_number, _ in ordered_lines:
                    if len(snippets) >= TermdeckConfig.TERMINAL_SEARCH_MAX_SNIPPETS:
                        break
                    if line_number > len(lines):
                        continue
                    line = lines[line_number - 1].strip()
                    if not line:
                        continue
                    snippet_lines.add(line_number)
                    snippet_text = line[:TermdeckConfig.TERMINAL_SEARCH_SNIPPET_CHARS - 1] + "…" \
                        if len(line) > TermdeckConfig.TERMINAL_SEARCH_SNIPPET_CHARS else line
                    snippets.append({"line": line_number, "text": snippet_text})
                if not snippets:
                    continue
                if match_count == 0:
                    match_count = len(line_scores)
            if not snippets:
                continue
            results.append({"session_id": ms.record.session_id, "title": ms.record.title,
                            "agent_kind": ms.record.agent_kind, "count": match_count, "snippets": snippets,
                            "relevance": max_line_score + match_count,
                            "last_activity_at": ms.last_activity_at})
        results.sort(key=lambda result: (-int(result.get("relevance", 0)), -float(result["last_activity_at"])))
        for result in results:
            if "relevance" in result:
                result.pop("relevance")
        return results

    @staticmethod
    def _searchable_terminal_text(data: bytes) -> str:
        text = data.decode("utf-8", errors="replace")
        text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)
        text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
        text = re.sub(r"\x1b[()][0-2A-Za-z]", "", text)
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        return "".join(character for character in text if character in "\n\t" or ord(character) >= 0x20)

    # A complete OSC 0/1/2 window-title sequence. The body excludes ESC so a match can never run across
    # the ST terminator or into a following escape.
    _OSC_TITLE_SEQUENCE = re.compile(rb"\x1b\][012];[^\x07\x1b]*(?:\x07|\x1b\\)")

    def _replay_bytes(self, ms: ManagedSession) -> bytes:
        """The durable buffer with title churn collapsed to the final title.

        A window title is screen state, not history: only the last one describes the terminal a client
        is attaching to, the same reasoning that keeps synchronized-update frames out of the durable
        buffer. A TUI spinner rewrites the title several times a second, and replaying every frame makes
        the client apply each one -- sidebar text, processing state, top bar -- inside the replay write.
        Measured on a long-lived training session: 49,777 title sequences were 99% of an 806KB replay
        and 5.9 of its 6 seconds of load, identically in both renderers. The buffer itself is left
        intact -- title recovery reads it -- and an unterminated title at the tail is left alone for the
        live stream to finish.
        """
        data = bytes(ms.buffer)
        last = None
        for match in self._OSC_TITLE_SEQUENCE.finditer(data):
            last = match.group(0)
        if last is None:
            return data
        return self._OSC_TITLE_SEQUENCE.sub(b"", data) + last

    def attach_client(self, session_id: str, screen_repaint: bool = True, have_buffer: bool = False,
                      repaint_preserved_buffer: bool = False, full_claude_raw_replay: bool = False) -> tuple[bytes, asyncio.Queue]:
        ms = self._sessions[session_id]
        self._recover_title_from_buffer(ms)
        preserve_client_buffer = have_buffer
        claude_raw_replay_active = self._claude_raw_replay_enabled and \
            agents.agent_cli(ms.record.agent_kind).records_raw_replay
        use_full_claude_raw_replay = self._claude_full_raw_replay_enabled and full_claude_raw_replay
        # Full means the ENTIRE recording, not the longest single screen frame: a frame is one repaint,
        # so serving only one showed at most a screenful of conversation on a fresh page -- "history is
        # very short" -- while megabytes of recorded session sat unused beside it. Replaying the whole
        # stream reproduces exactly what a continuously attached client saw, scrollback included, and
        # starts from a clean parser state instead of mid-stream at an arbitrary repaint (the garbled
        # first paint). Titles are already collapsed at record time, so the write is parse-bound only.
        claude_raw_replay = self._claude_raw_replay_bytes(ms) if claude_raw_replay_active and use_full_claude_raw_replay else \
            self._latest_claude_raw_screen_replay(ms) if claude_raw_replay_active else b""
        if use_full_claude_raw_replay and not self._searchable_terminal_text(claude_raw_replay).strip():
            claude_raw_replay = b""
        use_claude_raw_replay = bool(claude_raw_replay)
        # Output missed while detached does not make the client's scrollback worthless, only its bottom
        # screen wrong, so keep the buffer (resetting here would discard history the client still holds)
        # and force the repaint instead, which is what makes the visible screen authoritative again.
        client_buffer_is_stale = ms.output_missed_while_detached
        ms.output_missed_while_detached = False
        if ms.lazy_start_pending:
            self._spawn(ms, resume=True, screen_repaint=screen_repaint and not preserve_client_buffer and
                        not use_claude_raw_replay, preserve_claude_raw_replay=use_claude_raw_replay)
            self._broadcast_status(ms)
        queue: asyncio.Queue = asyncio.Queue()
        ms.client_queues.add(queue)
        if preserve_client_buffer:
            if client_buffer_is_stale or (screen_repaint and repaint_preserved_buffer) or \
                    (claude_raw_replay_active and not use_claude_raw_replay):
                self._schedule_screen_repaint(ms, TermdeckConfig.SCREEN_REPAINT_CLIENT_ATTACH_DELAY_SECONDS)
            return b"", queue
        replay = claude_raw_replay if use_claude_raw_replay else self._replay_bytes(ms)
        needs_repaint = not replay if use_claude_raw_replay else ms.screen_lives_only_in_stripped_sync_frames or not replay
        # A claude/codex session that has not produced output since the last server restart never gets a
        # chance to set screen_lives_only_in_stripped_sync_frames live, even though its durable buffer has
        # always been missing the actual screen (inherent to how these TUIs paint, not something that needs
        # to be witnessed). Cover exactly that first-attach-since-restart case, once, without turning every
        # later reattach of every agent session into an unconditional pty resize.
        if not use_claude_raw_replay and not needs_repaint and not ms.cold_attach_repaint_done and \
                agents.agent_cli(ms.record.agent_kind).records_raw_replay:
            needs_repaint = True
        ms.cold_attach_repaint_done = True
        if screen_repaint and needs_repaint:
            self._schedule_screen_repaint(ms, TermdeckConfig.SCREEN_REPAINT_CLIENT_ATTACH_DELAY_SECONDS)
        return replay, queue

    def detach_client(self, session_id: str, queue: asyncio.Queue) -> None:
        ms = self._sessions.get(session_id)
        if ms is not None:
            ms.client_queues.discard(queue)

    def write_input(self, session_id: str, text: str) -> None:
        ms = self._sessions[session_id]
        agent = agents.agent_cli(ms.record.agent_kind)
        attention_cleared = ms.attention_required or bool(ms.attention_text_carry)
        ms.attention_required = False
        ms.attention_text_carry = ""
        draft_before_input = ms.draft_tracker.draft
        agent.pre_write_input(self, ms, text, draft_before_input)
        if ms.proc is not None:
            ms.proc.write(text.encode())
        ms.last_input_monotonic = time.monotonic()
        ms.last_activity_at = time.time()
        ms.record.last_activity_at = ms.last_activity_at
        agent.post_write_input(self, ms, text)
        if attention_cleared:
            self._broadcast_status(ms)
        self._broadcast_activity_if_due(ms)
        if ms.detect_kind != "none":
            self._schedule_detection(ms, TermdeckConfig.AGENT_DETECT_INPUT_DEBOUNCE_SECONDS)
        ms.draft_tracker.feed(text)
        new_draft = ms.draft_tracker.draft
        # For a prompt-queueing CLI, Tab queues the current composer instead of submitting it.
        # DraftInputTracker intentionally treats Tab as layout/control input,
        # so clear the persisted draft explicitly or Markdown will resurrect
        # the already-queued prompt when the view changes.
        if text == "\t" and agent.has_prompt_queue:
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
        agents.agent_cli(ms.record.agent_kind).on_api_prompt_submitted(self, ms, queue)
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
        if not agents.agent_cli(ms.record.agent_kind).is_agent or not ms.running:
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
        is_agent = agents.agent_cli(ms.record.agent_kind).is_agent
        delay = TermdeckConfig.DRAFT_REPLAY_DELAY_AGENT_SECONDS if is_agent else TermdeckConfig.DRAFT_REPLAY_DELAY_SHELL_SECONDS
        await asyncio.sleep(delay)
        if ms.proc is not proc or not proc.alive or not ms.record.draft:
            return
        proc.write(TermdeckConfig.BRACKETED_PASTE_START + ms.record.draft.encode() + TermdeckConfig.BRACKETED_PASTE_END)

    def resize(self, session_id: str, cols: int, rows: int, force: bool = False) -> tuple[bool, int, int]:
        """Apply a client's terminal size, unless another client already owns it.

        A pty has one size, so with two browsers attached the last one to connect used to silently
        reshape the terminal for everyone -- the other window then wraps its lines at a width its screen
        does not have, and the agent's redraw lands on top of itself. Whoever is already attached keeps
        the size; a later client is told what the size actually is (see the return value) and can ask for
        it explicitly, which is what force is for.

        Returns (applied, cols, rows) where the returned size is the one now in effect.
        """
        ms = self._sessions[session_id]
        size_changed = (ms.record.cols, ms.record.rows) != (cols, rows)
        if size_changed and not force and len(ms.client_queues) > 1:
            return False, ms.record.cols, ms.record.rows
        ms.cols, ms.rows = cols, rows
        if size_changed and ms.proc is not None:
            ms.proc.resize(cols, rows)
        if size_changed:
            ms.record.cols, ms.record.rows = cols, rows
            self._persist()
        return True, cols, rows

    def request_screen_repaint(self, session_id: str) -> bool:
        ms = self._sessions[session_id]
        if ms.proc is None or not ms.proc.alive:
            return False
        self._schedule_screen_repaint(ms, 0)
        return ms.screen_repaint_task is not None

    async def restart_session(self, session_id: str, permission: str = "") -> None:
        ms = self._sessions[session_id]
        agent = agents.agent_cli(ms.record.agent_kind)
        if ms.detect_task is not None:
            ms.detect_task.cancel()
        if agent.is_agent and not ms.record.agent_session_id and \
                ms.exit_code is None and not ms.dormant:
            raise RuntimeError(f"agent session identity is still resolving; wait before restarting: {session_id}")
        self._canonicalize_agent_resume_command(ms.record)
        if not permission:
            permission = agent.restart_permission(self, ms)
        if permission:
            self._set_restart_permission(ms.record, permission)
        self._persist()
        if not await self._terminate_proc(ms):
            raise RuntimeError(f"could not stop dtach session before restart: {session_id}")
        if agent.records_raw_replay:
            self._clear_claude_terminal_history_for_restart(ms)
        self._spawn(ms, resume=True)

    def rename_session(self, session_id: str, title: str) -> None:
        ms = self._sessions[session_id]
        clean_title = " ".join(str(title or "").splitlines()).strip()
        if not clean_title:
            return
        ms.record.title = clean_title
        ms.record.title_user_set = True
        agent = agents.agent_cli(ms.record.agent_kind)
        if agent.supports_agent_rename:
            if ms.record.agent_session_id:
                if ms.agent_rename_task is not None and not ms.agent_rename_task.done():
                    ms.agent_rename_task.cancel()
                ms.agent_rename_task = asyncio.create_task(
                    agent.send_rename(self, ms, clean_title, clear_composer=True))
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

    async def delete_session(self, session_id: str, group_name: str = "") -> bool:
        ms = self._sessions[session_id]
        if ms.detect_task is not None:
            ms.detect_task.cancel()
        if not await self._terminate_proc(ms):
            return False
        self._discard_claude_raw_replay(ms)
        self._sessions.pop(session_id)
        self._broadcast_control(ms, {WsMessageFields.TYPE: WsMessageFields.DELETED})
        if not ms.record.title_user_set and ms.cli_title:
            ms.record.title = ms.cli_title
        self._closed_store.push(ms.record, TimeUtil.now_est_naive_iso(), group_name)
        self._persist()
        return True

    def mark_worktree_unmanaged(self, session_id: str) -> None:
        ms = self._sessions[session_id]
        ms.record.worktree_managed = False
        self._persist()
        self._broadcast_status(ms)

    async def stop_session_process_for_worktree(self, session_id: str) -> bool:
        return await self._terminate_proc(self._sessions[session_id])

    async def stop_session(self, session_id: str) -> bool:
        ms = self._sessions[session_id]
        if not ms.running:
            return True
        previous_activity_at = ms.last_activity_at
        ms.lazy_start_pending = True
        if ms.detect_task is not None:
            ms.detect_task.cancel()
        if not await self._terminate_proc(ms):
            ms.lazy_start_pending = False
            self._broadcast_status(ms)
            return False
        ms.proc = None
        ms.detached_live = False
        ms.exit_code = None
        ms.processing_started_at = None
        ms.agent_state = agents.agent_cli(ms.record.agent_kind).new_session_state()
        ms.last_activity_at = previous_activity_at
        ms.record.last_activity_at = previous_activity_at
        self._broadcast_status(ms)
        self._persist()
        return True

    async def remove_session_after_worktree_finish(self, session_id: str) -> bool:
        ms = self._sessions[session_id]
        if ms.detect_task is not None:
            ms.detect_task.cancel()
        if not await self._terminate_proc(ms):
            return False
        self._discard_claude_raw_replay(ms)
        self._sessions.pop(session_id)
        self._broadcast_control(ms, {WsMessageFields.TYPE: WsMessageFields.DELETED})
        self._persist()
        return True

    def list_closed_sessions(self, project: str | None, worktree_id: str | None = None) -> list[dict[str, str | bool | None]]:
        items = self._closed_store.load_all()
        filtered = items if project is None else [item for item in items if item["project"] == project]
        if worktree_id is None:
            return filtered
        return [item for item in filtered if str(item.get("worktree_id") or "root") == worktree_id]

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

    @staticmethod
    def _session_age_reference_timestamp(ms: ManagedSession) -> float:
        return max(ms.last_activity_at, TimeUtil.est_naive_iso_timestamp(ms.record.created_at_est))

    async def kill_stale_running_sessions(self, max_age_seconds: float) -> dict[str, object]:
        now = time.time()
        targets = [ms for ms in self._sessions.values() if ms.running and
                   now - self._session_age_reference_timestamp(ms) >= max_age_seconds]
        killed: list[str] = []
        failed: list[str] = []
        for ms in targets:
            ms.lazy_start_pending = True
            if ms.detect_task is not None:
                ms.detect_task.cancel()
            if not await self._terminate_proc(ms):
                failed.append(ms.record.session_id)
                self._broadcast_status(ms)
                continue
            ms.proc = None
            ms.detached_live = False
            ms.exit_code = None
            ms.processing_started_at = None
            ms.agent_state = agents.agent_cli(ms.record.agent_kind).new_session_state()
            killed.append(ms.record.session_id)
            self._broadcast_status(ms)
        self._persist()
        return {"killed": killed, "failed": failed, "threshold_seconds": max_age_seconds}

    def detach_for_shutdown(self) -> None:
        self._persist()
        self._checkpoint_all_replays()

    def list_sessions(self, project: str | None, worktree_id: str | None = None) -> list[dict[str, object]]:
        return [self.session_summary(ms) for ms in self._sessions.values()
                if (project is None or ms.record.project == project) and
                (worktree_id is None or ms.record.worktree_id == worktree_id)]

    def session_summary(self, ms: ManagedSession) -> dict[str, object]:
        self._refresh_session_activity(ms)
        agents.agent_cli(ms.record.agent_kind).refresh_activity_for_status(self, ms)
        processing = self._sync_processing_started(ms)
        summary: dict[str, object] = dict(ms.record.to_dict())
        summary[ApiFields.RUNNING] = ms.running
        summary[ApiFields.EXIT_CODE] = ms.exit_code
        summary[ApiFields.DORMANT] = ms.dormant
        summary[ApiFields.DETACHED] = ms.detached_live and not ms.attached
        summary[ApiFields.CLI_TITLE] = ms.cli_title
        summary["processing"] = processing
        summary[ApiFields.NEEDS_ATTENTION] = ms.attention_required
        summary["processing_since"] = ms.processing_started_at
        summary["last_activity_at"] = ms.last_activity_at
        return summary

    def session_summary_by_id(self, session_id: str) -> dict[str, object]:
        return self.session_summary(self._sessions[session_id])

    def session_history_source(self, session_id: str) -> tuple[str, str, str | None]:
        record = self._sessions[session_id].record
        transcript_session_id = record.agent_session_id or record.fork_parent_agent_session_id
        return record.agent_kind, record.cwd, transcript_session_id

    def session_draft(self, session_id: str) -> str:
        return self._sessions[session_id].record.draft

    def _persist(self) -> None:
        self._store.save_all([ms.record for ms in self._sessions.values()])
