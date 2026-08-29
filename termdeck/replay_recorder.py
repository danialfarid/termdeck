import asyncio
import os
import re
import uuid
from pathlib import Path

from termdeck import agents
from termdeck.config import TermdeckConfig


class ReplayRecorder:
    """Records terminal output for replay and keeps it durable across restarts.

    Two recordings exist per session: the durable scrollback buffer (shell sessions), and the
    raw pty recording for agents whose AgentCli sets records_raw_replay — replayed on reconnect
    so an attach reproduces exactly what a continuously connected client saw, titles collapsed
    at record time. Checkpoints are activity-driven appends (no periodic sweep, no shutdown
    hook): every write is conclusive on its own, and a single armed flush covers all sessions.

    Formerly the claude_raw_replay_* block inside TerminalSessionManager; the historical
    "claude" flavor survives only in the on-disk suffix and the ws protocol parameter.
    """

    SCROLLBACK_KIND = "scrollback"
    RAW_KIND = "raw-replay"
    TITLE_PREFIXES = (b"\x1b]0;", b"\x1b]1;", b"\x1b]2;")
    BEL = b"\x07"
    ST = b"\x1b\\"
    CLEAR = b"\x1b[2J"
    HOME = b"\x1b[H"
    ERASE_LINE = b"\x1b[2K"
    # Cursor jump that marks a CLI about to redraw its whole rendered output, rather than repaint
    # its status rows (see _preserve_screen_before_erase).
    FULL_REDRAW_JUMP = re.compile(rb"\x1b\[(\d*)A")
    # The unbroken run of control sequences a redraw makes before it writes any text. Its erase-line
    # count is how far up the redraw actually reaches, which is what has to be scrolled clear.
    CONTROL_RUN = re.compile(rb"(?:\x1b\[[0-9;?]*[A-Za-z])*")
    # Scrolled just clear of the erase, a line sits on the last row it can still reach.
    SCROLL_CLEARANCE_ROWS = 2
    CURSOR_DOWN = b"\x1b[1B"
    CLEAR_ROW = ERASE_LINE + CURSOR_DOWN
    OSC_TITLE_SEQUENCE = re.compile(rb"\x1b\][012];[^\x07\x1b]*(?:\x07|\x1b\\)")

    def __init__(self, manager) -> None:
        self._manager = manager
        self.enabled = True
        self.full_replay_enabled = True
        self._total_bytes = 0
        self._debounce_task: asyncio.Task[None] | None = None

    def stop(self) -> None:
        if self._debounce_task is not None:
            self._debounce_task.cancel()
            self._debounce_task = None

    # -- storage paths -----------------------------------------------------

    @staticmethod
    def raw_path(session_id: str) -> Path:
        return TermdeckConfig.SCROLLBACK_DIR / f"{session_id}{TermdeckConfig.RAW_REPLAY_SUFFIX}"

    @staticmethod
    def scrollback_path(session_id: str) -> Path:
        return TermdeckConfig.SCROLLBACK_DIR / f"{session_id}{TermdeckConfig.SCROLLBACK_SUFFIX}"

    # -- checkpoint files --------------------------------------------------

    @staticmethod
    def _write_checkpoint_atomically(target: Path, payload: bytes) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_bytes(payload)
            temporary.replace(target)
        finally:
            if temporary.exists():
                temporary.unlink()

    @staticmethod
    def _append_checkpoint_bytes(target: Path, payload: bytes) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("ab") as checkpoint_file:
            checkpoint_file.write(payload)
            checkpoint_file.flush()
            os.fsync(checkpoint_file.fileno())

    @staticmethod
    def _read_checkpoint_tail(target: Path, byte_limit: int) -> tuple[bytes, bool]:
        target_bytes = target.stat().st_size
        with target.open("rb") as checkpoint_file:
            if target_bytes > byte_limit:
                checkpoint_file.seek(-byte_limit, os.SEEK_END)
            return checkpoint_file.read(), target_bytes > byte_limit

    def restore_saved_buffers(self, ms) -> None:
        """Load a session's checkpointed recordings at startup."""
        agent = agents.agent_cli(ms.record.agent_kind)
        saved = self.scrollback_path(ms.record.session_id)
        if not agent.is_agent and saved.exists():
            replay, requires_compaction = self._read_checkpoint_tail(saved, TermdeckConfig.SCROLLBACK_BYTES)
            ms.buffer.extend(replay)
            if requires_compaction:
                ms.scrollback_compaction_generation += 1
        if self.enabled and agent.records_raw_replay:
            raw = self.raw_path(ms.record.session_id)
            if raw.exists():
                replay, requires_compaction = self._read_checkpoint_tail(raw, TermdeckConfig.RAW_REPLAY_SESSION_BYTES)
                ms.raw_replay_buffer.extend(replay)
                self._total_bytes += len(replay)
                if requires_compaction:
                    ms.raw_replay_compaction_generation += 1
            self.seed_from_durable_buffer(ms)

    # -- checkpoint scheduling ---------------------------------------------

    @staticmethod
    def _snapshot(ms, replay_kind: str, target: Path, full_payload: bytes,
                  pending: bytearray, byte_limit: int, compaction_generation: int,
                  checkpoint_compaction_generation: int) -> tuple | None:
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

    def _pending_snapshots(self, active_only: bool) -> list[tuple]:
        snapshots: list[tuple] = []
        for ms in self._manager._sessions.values():
            if active_only and not ms.running:
                continue
            agent = agents.agent_cli(ms.record.agent_kind)
            if not agent.is_agent and ms.buffer:
                snapshot = self._snapshot(
                    ms, self.SCROLLBACK_KIND, self.scrollback_path(ms.record.session_id), bytes(ms.buffer),
                    ms.scrollback_checkpoint_pending, TermdeckConfig.SCROLLBACK_BYTES,
                    ms.scrollback_compaction_generation, ms.scrollback_checkpoint_compaction_generation)
                if snapshot is not None:
                    snapshots.append(snapshot)
            if self.enabled and agent.records_raw_replay and ms.raw_replay_buffer:
                snapshot = self._snapshot(
                    ms, self.RAW_KIND, self.raw_path(ms.record.session_id),
                    self.raw_bytes(ms), ms.raw_replay_checkpoint_pending,
                    TermdeckConfig.RAW_REPLAY_SESSION_BYTES, ms.raw_replay_compaction_generation,
                    ms.raw_replay_checkpoint_compaction_generation)
                if snapshot is not None:
                    snapshots.append(snapshot)
        return snapshots

    @classmethod
    def _record_checkpoint_success(cls, ms, replay_kind: str, compaction_generation: int,
                                   pending_payload: bytes, replaced: bool) -> None:
        if replay_kind == cls.SCROLLBACK_KIND:
            pending = ms.scrollback_checkpoint_pending
            if bytes(pending[:len(pending_payload)]) == pending_payload:
                del pending[:len(pending_payload)]
            if replaced and ms.scrollback_compaction_generation == compaction_generation:
                ms.scrollback_checkpoint_compaction_generation = compaction_generation
            return
        pending = ms.raw_replay_checkpoint_pending
        if bytes(pending[:len(pending_payload)]) == pending_payload:
            del pending[:len(pending_payload)]
        if replaced and ms.raw_replay_compaction_generation == compaction_generation:
            ms.raw_replay_checkpoint_compaction_generation = compaction_generation

    async def _checkpoint_active(self) -> int:
        """Write every running session's pending replay bytes. Returns how many writes succeeded."""
        written = 0
        for ms, replay_kind, compaction_generation, target, payload, pending_payload, replace in \
                self._pending_snapshots(True):
            try:
                writer = self._write_checkpoint_atomically if replace else self._append_checkpoint_bytes
                await asyncio.to_thread(writer, target, payload)
            except OSError as checkpoint_error:
                print(f"termdeck replay checkpoint failed for {ms.record.session_id}: {checkpoint_error}", flush=True)
                continue
            self._record_checkpoint_success(
                ms, replay_kind, compaction_generation, pending_payload, replace)
            written += 1
        return written

    def schedule_checkpoint(self, ms) -> None:
        """Write this session's replay shortly after the activity that changed it.

        This is the only thing that makes a replay durable, so it has to be conclusive on its own: there
        is no periodic sweep behind it and no shutdown hook to catch a straggler.
        """
        if not ms.running:
            return
        self._arm()

    def _arm(self) -> None:
        """Start the one pending flush, if there isn't one already.

        Deliberately a trailing throttle rather than a resetting debounce: a continuously streaming
        session would keep pushing a resetting timer out forever and never be written at all. One armed
        flush covers every session and every event in its window, so the write rate is capped by the
        window however much output arrives, and each write appends only the bytes since the last one.
        """
        task = self._debounce_task
        if task is not None and not task.done():
            return
        # The manager's background loop is unset until start_background_tasks runs; fall back to
        # whatever loop is actually running so output handled before then (a spawn banner) is not
        # left unwritten.
        loop = self._manager._background_loop
        if loop is None or not loop.is_running():
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                return
        self._debounce_task = loop.create_task(self._flush_after_debounce())

    async def _flush_after_debounce(self) -> None:
        await asyncio.sleep(TermdeckConfig.REPLAY_CHECKPOINT_DEBOUNCE_SECONDS)
        written = await self._checkpoint_active()
        # Output that arrived while the flush itself was running was not scheduled, because this task was
        # still pending -- and there is nothing behind this to sweep it up later. Re-arm so the writes
        # converge instead of waiting on the next keystroke. Only after progress: if every write just
        # failed (a full disk), pending stays pending and re-arming would spin on the error once a second.
        if written and self._pending_snapshots(True):
            self._debounce_task = None
            self._arm()

    # -- raw recording -----------------------------------------------------

    @classmethod
    def _partial_title_prefix_length(cls, data: bytes) -> int:
        partial_length = 0
        for prefix in cls.TITLE_PREFIXES:
            for length in range(1, len(prefix)):
                if data.endswith(prefix[:length]):
                    partial_length = max(partial_length, length)
        return partial_length

    @classmethod
    def _collapse_titles(cls, ms, data: bytes) -> bytes:
        combined = ms.raw_replay_title_carry + data
        ms.raw_replay_title_carry = b""
        output = bytearray()
        position = 0
        while position < len(combined):
            title_starts = [combined.find(prefix, position) for prefix in cls.TITLE_PREFIXES]
            title_starts = [title_start for title_start in title_starts if title_start >= 0]
            if not title_starts:
                partial_length = cls._partial_title_prefix_length(combined[position:])
                content_end = len(combined) - partial_length
                output.extend(combined[position:content_end])
                if partial_length:
                    ms.raw_replay_title_carry = combined[content_end:]
                break
            title_start = min(title_starts)
            output.extend(combined[position:title_start])
            bel_index = combined.find(cls.BEL, title_start + 4)
            st_index = combined.find(cls.ST, title_start + 4)
            title_end_candidates = []
            if bel_index >= 0:
                title_end_candidates.append(bel_index + len(cls.BEL))
            if st_index >= 0:
                title_end_candidates.append(st_index + len(cls.ST))
            if not title_end_candidates:
                ms.raw_replay_title_carry = combined[title_start:]
                break
            title_end = min(title_end_candidates)
            ms.raw_replay_last_title = combined[title_start:title_end]
            position = title_end
        return bytes(output)

    @classmethod
    def _trim_front(cls, replay_buffer: bytearray, minimum_bytes: int, boot_boundary_only: bool = False) -> int:
        if minimum_bytes <= 0 or not replay_buffer:
            return 0
        minimum_bytes = min(minimum_bytes, len(replay_buffer))
        if boot_boundary_only:
            # A fullscreen TUI diff-paints from its boot onward and never issues a full clear, so a
            # sync-update frame is NOT a safe cut: everything painted before it would be missing from
            # the replayed screen. The only self-contained restart of such a stream is a respawn's
            # fresh boot, so cut there even when that trims far more than asked; with no respawn in
            # the buffer, cut the minimum and accept the broken replay over unbounded memory.
            divider = replay_buffer.find(TermdeckConfig.RESPAWN_DIVIDER.encode(), minimum_bytes)
            remove_bytes = divider if divider >= 0 else minimum_bytes
            del replay_buffer[:remove_bytes]
            return remove_bytes
        search_end = min(len(replay_buffer), minimum_bytes + 1_000_000)
        boundaries = [replay_buffer.find(TermdeckConfig.SYNC_UPDATE_START, minimum_bytes, search_end),
                      replay_buffer.find(cls.CLEAR, minimum_bytes, search_end)]
        boundaries = [boundary for boundary in boundaries if boundary >= 0]
        remove_bytes = min(boundaries) if boundaries else minimum_bytes
        del replay_buffer[:remove_bytes]
        return remove_bytes

    def enforce_total_limit(self) -> None:
        overflow = self._total_bytes - TermdeckConfig.RAW_REPLAY_TOTAL_BYTES
        if overflow <= 0:
            return
        candidates = sorted((ms for ms in self._manager._sessions.values() if ms.raw_replay_buffer),
                            key=lambda candidate: candidate.last_activity_at)
        for candidate in candidates:
            if overflow <= 0:
                break
            removed = self._trim_front(candidate.raw_replay_buffer, overflow,
                                       boot_boundary_only=agents.agent_cli(candidate.record.agent_kind).fullscreen_tui)
            self._total_bytes -= removed
            overflow -= removed
            if removed:
                candidate.raw_replay_compaction_generation += 1

    @classmethod
    def _preserve_screen_before_erase(cls, data: bytes) -> bytes:
        """Scroll the screen into scrollback before a CLI erases it, in the RECORDING only.

        A CLI that redraws its whole rendered output walks the cursor far up and erases line by line
        on the way (measured on a real compaction: one ESC[112A, then 238 ESC[2K). Replayed, that
        erase runs again and the conversation it covered is gone from the replay too. Scrolling the
        screen out first moves those lines into scrollback, where an erase cannot reach them, so a
        reattaching client can still scroll back to them.

        A normal status repaint moves at most ~18 rows, so only the much larger jump is treated as a
        full redraw. The live stream is untouched: this rewrites what is stored, never what a client
        is currently watching. Costs a little accuracy in the replayed screen -- the CLI redraws
        incrementally, assuming cells it did not rewrite still hold their old text, and those cells
        are blank once the screen has scrolled -- which the next repaint corrects.

        How far to scroll is set by the erase, not by the jump: the two disagree (one measured
        compaction jumped 112 rows and then erased 119), and scrolling the smaller of them leaves the
        rows in between still reachable, which is the top of the conversation.
        """
        minimum = TermdeckConfig.REPLAY_PRESERVE_ERASE_MIN_ROWS
        if not minimum:
            return data
        out = bytearray()
        position = 0
        for match in cls.FULL_REDRAW_JUMP.finditer(data):
            rows = int(match.group(1) or 1)
            if rows < minimum:
                continue
            control_run = cls.CONTROL_RUN.match(data, match.start())
            erased = data.count(cls.ERASE_LINE, match.start(), control_run.end()) if control_run else 0
            out.extend(data[position:match.start()])
            # Save the cursor, drop to the last row so every newline scrolls rather than just moving
            # down, push the screen into scrollback, then put the cursor back for the CLI's own bytes.
            depth = max(rows, erased) + cls.SCROLL_CLEARANCE_ROWS
            out.extend(b"\x1b7\x1b[9999;1H" + b"\n" * depth + b"\x1b8")
            position = match.start()
        out.extend(data[position:])
        return bytes(out)

    def record_output(self, ms, data: bytes) -> None:
        if not self.enabled or not agents.agent_cli(ms.record.agent_kind).records_raw_replay:
            return
        filtered = self._preserve_screen_before_erase(self._collapse_titles(ms, data))
        if not filtered:
            return
        previous_bytes = len(ms.raw_replay_buffer)
        ms.raw_replay_buffer.extend(filtered)
        ms.raw_replay_checkpoint_pending.extend(filtered)
        session_overflow = len(ms.raw_replay_buffer) - TermdeckConfig.RAW_REPLAY_SESSION_BYTES
        if session_overflow > 0:
            self._trim_front(ms.raw_replay_buffer, session_overflow,
                             boot_boundary_only=agents.agent_cli(ms.record.agent_kind).fullscreen_tui)
            ms.raw_replay_compaction_generation += 1
        self._total_bytes += len(ms.raw_replay_buffer) - previous_bytes
        self.enforce_total_limit()
        self.schedule_checkpoint(ms)

    def seed_from_durable_buffer(self, ms) -> None:
        if not agents.agent_cli(ms.record.agent_kind).records_raw_replay or ms.raw_replay_buffer or not ms.buffer:
            return
        replay = self.replay_bytes(ms)[-TermdeckConfig.RAW_REPLAY_SESSION_BYTES:]
        ms.raw_replay_buffer.extend(replay)
        self._total_bytes += len(replay)
        ms.raw_replay_compaction_generation += 1

    def discard(self, ms) -> None:
        self._total_bytes = max(0, self._total_bytes - len(ms.raw_replay_buffer))
        ms.raw_replay_buffer.clear()
        ms.raw_replay_title_carry = b""
        ms.raw_replay_last_title = b""
        ms.raw_replay_checkpoint_pending.clear()
        ms.raw_replay_compaction_generation += 1

    # -- replay serving ----------------------------------------------------

    # A TUI clears the screen and redraws it as two separate writes. Recording can stop between them
    # -- a server restart is the common way -- and then the recording's last act is the erase, with
    # the redraw never captured. Replaying that faithfully hands the client a blank screen: measured
    # on a live session whose recording ended with ESC[H ESC[J, every attach showed the conversation
    # cut mid tool-call with no composer, and no repaint recovered it because a TUI that is idle (or
    # wedged) sends nothing. Dropping the orphaned erase shows the last frame that WAS captured.
    #
    # Only the last few bytes are examined, never the whole recording: raw_bytes runs for every
    # session on every output-driven checkpoint, and matching this pattern against a multi-megabyte
    # buffer measured at 57ms per call -- enough blocking event-loop work to make typing lag.
    TRAILING_WIPE_SCAN_BYTES = 256
    # Repeated, because each attach that provokes a redraw can append another orphaned erase.
    TRAILING_WIPE = re.compile(rb"(?:(?:\x1b\[[0-9;]*[Hf])?\x1b\[[0-2]?J[\s\x00]*)+$")

    @classmethod
    def _without_trailing_wipe(cls, data: bytes) -> bytes:
        if not data:
            return data
        tail = data[-cls.TRAILING_WIPE_SCAN_BYTES:]
        removed = len(tail) - len(cls.TRAILING_WIPE.sub(b"", tail))
        return data[:len(data) - removed] if removed else data

    @classmethod
    def raw_bytes(cls, ms) -> bytes:
        return cls._without_trailing_wipe(bytes(ms.raw_replay_buffer)) + ms.raw_replay_last_title

    @classmethod
    def _clear_frame_rows(cls, frame: bytes) -> int:
        if not frame.startswith(cls.HOME):
            return 0
        body = frame[len(cls.HOME):]
        row_bytes = len(cls.CLEAR_ROW)
        if not body or len(body) % row_bytes:
            return 0
        rows = len(body) // row_bytes
        return rows if rows >= 2 and body == cls.CLEAR_ROW * rows else 0

    @classmethod
    def _screen_frames(cls, ms) -> list[bytes]:
        replay = bytes(ms.raw_replay_buffer)
        if not replay:
            return []
        replay_start = 0
        for divider in (TermdeckConfig.RESPAWN_DIVIDER.encode(), TermdeckConfig.REATTACH_DIVIDER.encode()):
            divider_position = replay.rfind(divider)
            if divider_position >= replay_start:
                replay_start = divider_position + len(divider)
        home_positions: list[int] = []
        home_position = replay.find(cls.HOME, replay_start)
        while home_position >= 0:
            home_positions.append(home_position)
            home_position = replay.find(cls.HOME, home_position + len(cls.HOME))
        frames: list[bytes] = []
        for content_index in range(1, len(home_positions)):
            clear_start = home_positions[content_index - 1]
            content_start = home_positions[content_index]
            if not cls._clear_frame_rows(replay[clear_start:content_start]):
                continue
            content_end = home_positions[content_index + 1] if content_index + 1 < len(home_positions) else len(replay)
            content = replay[content_start:content_end]
            if len(content) > len(cls.HOME):
                frames.append(content)
        return frames

    def latest_screen(self, ms) -> bytes:
        frames = self._screen_frames(ms)
        return (self._without_trailing_wipe(frames[-1]) + ms.raw_replay_last_title) if frames else b""

    def full_screen(self, ms) -> bytes:
        frames = self._screen_frames(ms)
        if not frames:
            return b""
        longest_frame = max(frames, key=lambda frame: len(self._manager._searchable_terminal_text(frame).splitlines()))
        return longest_frame + ms.raw_replay_last_title

    def replay_bytes(self, ms) -> bytes:
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
        data = self._without_trailing_wipe(bytes(ms.buffer))
        last = None
        for match in self.OSC_TITLE_SEQUENCE.finditer(data):
            last = match.group(0)
        if last is None:
            return data
        return self.OSC_TITLE_SEQUENCE.sub(b"", data) + last

    def clear_for_restart(self, ms) -> None:
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
        ms.raw_replay_title_carry = b""
        ms.screen_lives_only_in_stripped_sync_frames = False
        ms.last_repaint_offset = None
        ms.output_missed_while_detached = False
        ms.cold_attach_repaint_done = False
        if ms.screen_repaint_task is not None and not ms.screen_repaint_task.done():
            ms.screen_repaint_task.cancel()
        ms.screen_repaint_task = None
