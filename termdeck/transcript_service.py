import asyncio
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from termdeck import agents
from termdeck.agents.base import AgentCli
from termdeck.platform_paths import PlatformPaths
from termdeck.transcript_turns import TurnBuilder

if PlatformPaths.IS_MACOS:
    from watchdog.observers.kqueue import KqueueObserver
else:
    KqueueObserver = None


@dataclass
class _TranscriptState:
    path: Path
    agent: AgentCli
    raw_turns: list[dict[str, object]] = field(default_factory=list)
    turns: list[dict[str, object]] = field(default_factory=list)
    offset: int = 0
    carry: bytes = b""
    inode: int | None = None
    revision: int = 0
    update_log: list[dict[str, object]] = field(default_factory=list)
    last_user_at: float | None = None
    last_access: float = 0.0


class _TranscriptFileHandler(FileSystemEventHandler):
    def __init__(self, callback):
        super().__init__()
        self._callback = callback

    def _emit(self, path: str) -> None:
        candidate = Path(path)
        if candidate.suffix == ".jsonl":
            self._callback(candidate)

    def on_created(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._emit(event.src_path)

    def on_modified(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._emit(event.src_path)

    def on_deleted(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._emit(event.src_path)

    def on_moved(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._emit(event.src_path)
            self._emit(event.dest_path)


class TranscriptService:
    """Reads an agent session's own on-disk log (codex rollout / claude project jsonl) into a clean conversation
    transcript. This is the complete, durable record — independent of what the CLI's resume redraw restores on
    screen — so the history view can show the full thread even when codex only repaints the last page."""

    MAX_TURNS = 4000
    MAX_RAW_TURNS = 16000
    HISTORY_PAGE_TURNS = 160
    HISTORY_PAGE_INITIAL_BYTES = 512 * 1024
    HISTORY_PAGE_MAX_BYTES = 8 * 1024 * 1024
    STATE_RELOAD_MAX_BYTES = 64 * 1024 * 1024
    _TRANSCRIPT_CACHE_MAX_SESSIONS = 80

    def __init__(self) -> None:
        self._states: dict[Path, _TranscriptState] = {}
        self._subscribers: dict[Path, set[asyncio.Queue]] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._observer: Observer | None = None
        self._codex_leaf_observer = None
        self._file_change_listeners: list[Callable[[Path], None]] = []

    def add_file_change_listener(self, listener: Callable[[Path], None]) -> None:
        self._file_change_listeners.append(listener)

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        if self._observer is not None:
            return
        self._loop = loop
        observer = Observer()
        handler = _TranscriptFileHandler(self._on_file_change_from_thread)
        # An agent tree with its own TranscriptActivityWatcher is skipped: its
        # events are forwarded here by the session manager, and macOS FSEvents must not register
        # the same recursive watch twice.
        watch_roots = [agent.sessions_root for agent in agents.AGENT_CLIS.values()
                       if agent.is_agent and agent.sessions_root is not None and not agent.has_own_transcript_watcher]
        for root in watch_roots:
            if root.is_dir():
                observer.schedule(handler, str(root), recursive=True)
        observer.start()
        self._observer = observer
        # The recursive observer is useful for discovering new rollout files,
        # but macOS FSEvents can omit appends to a JSONL file that Codex keeps
        # open. Watch the existing leaf directories with kqueue as well so
        # active Markdown sessions receive each append promptly. This is
        # event-driven: it does not poll files or rescan the transcript tree.
        if KqueueObserver is not None and any(root.is_dir() for root in watch_roots):
            leaf_observer = KqueueObserver()
            leaf_dirs: set[Path] = set()
            for root in watch_roots:
                if root.is_dir():
                    leaf_dirs.update(path.parent for path in root.rglob("*.jsonl"))
            for leaf in sorted(leaf_dirs):
                leaf_observer.schedule(handler, str(leaf), recursive=False)
            if leaf_dirs:
                leaf_observer.start()
                self._codex_leaf_observer = leaf_observer

    # Bounded on the stop() call itself, not just the join. An observer that will not come down blocks
    # here forever, and this runs inside the app's shutdown: measured with SIGTERM, the server logged
    # "Waiting for application shutdown", released its port, and then lived on indefinitely holding its
    # memory -- so `kill <pid>` produced an orphan rather than a stopped server, and the state-recovery
    # restart (which signals itself with SIGTERM) could never come back up. These watchers hold nothing
    # that has to be flushed, so abandoning a stuck one costs nothing: the process is on its way out, and
    # a daemon thread does not hold it back.
    def stop(self) -> None:
        observer, self._observer = self._observer, None
        leaf_observer, self._codex_leaf_observer = self._codex_leaf_observer, None
        for watcher in (leaf_observer, observer):
            if watcher is None:
                continue
            closer = threading.Thread(target=self._close_observer, args=(watcher,), daemon=True)
            closer.start()
            closer.join(timeout=2)
        self._loop = None
        self._subscribers.clear()

    @staticmethod
    def _close_observer(watcher) -> None:
        try:
            watcher.stop()
            watcher.join(timeout=2)
        except Exception:
            pass

    def subscribe(self, agent_kind: str, cwd: str, agent_session_id: str | None) -> tuple[Path | None, list[dict[str, object]], int, asyncio.Queue]:
        path = self.source_path(agent_kind, cwd, agent_session_id)
        queue: asyncio.Queue = asyncio.Queue()
        if path is None:
            return None, [], 0, queue
        # Do not build the large live cache on the websocket's first request.
        # The server primes a bounded tail before sending the initial snapshot;
        # this registration must stay cheap so the browser can start loading
        # without waiting for a potentially huge JSONL file.
        agents.agent_cli(agent_kind)
        state = self._states.get(path)
        if state is not None:
            self._refresh_state(state)
        self._touch_state(path)
        self._subscribers.setdefault(path, set()).add(queue)
        self._prune_state_cache()
        return path, state.turns if state else [], state.revision if state else 0, queue

    def prime_subscription(self, agent_kind: str, path: Path | None) -> int:
        """Initialize a new live subscription from a bounded tail only.

        A subscription is registered before this runs, so appends that happen
        during priming are either included by the tail read or remain queued as
        live updates. The old full-state reload is still available for history
        search/other callers, but is no longer on the initial Markdown path.
        """
        if path is None:
            return 0
        agent = agents.agent_cli(agent_kind)
        state = self._states.get(path)
        if state is None or state.agent is not agent:
            state = _TranscriptState(path=path, agent=agent)
            self._states[path] = state
            self._reload_state(state, max_bytes=self.HISTORY_PAGE_MAX_BYTES)
        else:
            self._refresh_state(state)
        self._touch_state(path)
        self._prune_state_cache()
        return state.revision

    def updates_since(self, path: Path | None, revision: int) -> list[dict[str, object]] | None:
        if path is None:
            return [] if revision == 0 else None
        state = self._states.get(path)
        if state is None or revision == state.revision:
            return []
        if revision > state.revision or not state.update_log:
            return None
        updates = [item for item in state.update_log if int(item.get("revision", 0)) > revision]
        expected = revision + 1
        if not updates or int(updates[0].get("revision", 0)) != expected:
            return None
        if any(int(item.get("revision", 0)) != expected + index for index, item in enumerate(updates)):
            return None
        return updates

    def unsubscribe(self, path: Path | None, queue: asyncio.Queue) -> None:
        if path is None:
            return
        subscribers = self._subscribers.get(path)
        if subscribers is None:
            return
        subscribers.discard(queue)
        if not subscribers:
            self._subscribers.pop(path, None)
            self._prune_state_cache()

    def source_path(self, agent_kind: str, cwd: str, agent_session_id: str | None) -> Path | None:
        if not agent_session_id:
            return None
        return agents.agent_cli(agent_kind).transcript_path(Path(cwd) if cwd else None, agent_session_id)

    def last_user_timestamp(self, agent_kind: str, cwd: str, agent_session_id: str | None) -> float | None:
        path = self.source_path(agent_kind, cwd, agent_session_id)
        if path is None:
            return None
        self._transcript_for_path(agents.agent_cli(agent_kind), path)
        state = self._states.get(path)
        return state.last_user_at if state else None

    def transcript_for(self, agent_kind: str, cwd: str, agent_session_id: str | None) -> list[dict[str, object]]:
        path = self.source_path(agent_kind, cwd, agent_session_id)
        result = self._transcript_for_path(agents.agent_cli(agent_kind), path) if path else []
        if path is not None:
            self._touch_state(path)
            self._prune_state_cache()
        return result

    def history_page(self, agent_kind: str, cwd: str, agent_session_id: str | None,
                    before: int | None = None, limit: int = HISTORY_PAGE_TURNS) -> dict[str, object]:
        """Read one bounded page from the end of a durable JSONL transcript.

        ``before`` is a byte offset at a line boundary. Appending to JSONL does
        not change older offsets, so the cursor remains valid while an agent is
        producing more output. The page is parsed only from a bounded tail
        window, not from the beginning of the session.
        """
        path = self.source_path(agent_kind, cwd, agent_session_id)
        if path is None:
            return {"turns": [], "before": None, "has_more": False}
        agent = agents.agent_cli(agent_kind)
        self._touch_state(path)
        self._prune_state_cache()
        try:
            size = path.stat().st_size
        except (FileNotFoundError, OSError):
            return {"turns": [], "before": None, "has_more": False}
        if before is not None and int(before) > size:
            return {"turns": [], "before": None, "has_more": False, "reset": True}
        end_byte = size if before is None else max(0, int(before))
        limit = max(20, min(int(limit), self.HISTORY_PAGE_TURNS))
        window_bytes = self.HISTORY_PAGE_INITIAL_BYTES
        records: list[tuple[int, bytes]] = []
        parsed_records: list[tuple[int, list[dict[str, object]]]] = []
        while True:
            _, records = self._read_history_window(path, end_byte, window_bytes)
            parsed_records = []
            for offset, raw_line in records:
                parsed = agent.parse_transcript_lines([raw_line.decode(errors="replace")])
                if parsed:
                    parsed_records.append((offset, parsed))
            total_turns = sum(len(turns) for _, turns in parsed_records)
            if total_turns >= limit or not records or records[0][0] == 0 or window_bytes >= self.HISTORY_PAGE_MAX_BYTES:
                break
            window_bytes = min(window_bytes * 2, self.HISTORY_PAGE_MAX_BYTES)
        if not parsed_records:
            return {"turns": [], "before": records[0][0] if records and records[0][0] > 0 else None,
                    "has_more": bool(records and records[0][0] > 0)}

        first_record = len(parsed_records) - 1
        collected = 0
        for index in range(len(parsed_records) - 1, -1, -1):
            collected += len(parsed_records[index][1])
            first_record = index
            if collected >= limit:
                break
        page_start = parsed_records[first_record][0]
        page_lines = [raw for offset, raw in records if offset >= page_start]
        turns = TurnBuilder.collapse_thinking_events(
            agent.parse_transcript_lines([line.decode(errors="replace") for line in page_lines]))
        next_before = page_start if page_start > 0 else None
        return {"turns": turns, "before": next_before, "has_more": next_before is not None,
                "file_size": size}

    @staticmethod
    def _read_history_window(path: Path, end_byte: int, max_bytes: int) -> tuple[int, list[tuple[int, bytes]]]:
        start_byte = max(0, end_byte - max_bytes)
        try:
            with path.open("rb") as source:
                if start_byte > 0:
                    source.seek(start_byte - 1)
                    previous = source.read(1)
                    source.seek(start_byte)
                else:
                    previous = b"\n"
                data = source.read(max(0, end_byte - start_byte))
        except OSError:
            return end_byte, []
        if start_byte > 0 and previous not in (b"\n", b"\r"):
            boundary = data.find(b"\n")
            if boundary < 0:
                return end_byte, []
            start_byte += boundary + 1
            data = data[boundary + 1:]
        records: list[tuple[int, bytes]] = []
        offset = start_byte
        for raw_line in data.splitlines(keepends=True):
            if not raw_line.endswith((b"\n", b"\r")):
                break
            records.append((offset, raw_line.rstrip(b"\r\n")))
            offset += len(raw_line)
        return start_byte, records

    def _transcript_for_path(self, agent: AgentCli, path: Path) -> list[dict[str, object]]:
        state = self._states.get(path)
        if state is None or state.agent is not agent:
            state = _TranscriptState(path=path, agent=agent)
            self._states[path] = state
            self._reload_state(state)
        else:
            self._refresh_state(state)
        self._touch_state(path)
        self._prune_state_cache()
        return state.turns

    def _touch_state(self, path: Path) -> None:
        if path not in self._states:
            return
        state = self._states[path]
        self._states[path] = self._states.pop(path)
        state.last_access = time.time()

    def _prune_state_cache(self) -> None:
        if len(self._states) <= self._TRANSCRIPT_CACHE_MAX_SESSIONS:
            return
        paths = list(self._states.keys())
        for path in paths:
            if len(self._states) <= self._TRANSCRIPT_CACHE_MAX_SESSIONS:
                break
            if path in self._subscribers:
                continue
            self._states.pop(path)

    def _on_file_change_from_thread(self, path: Path) -> None:
        for listener in self._file_change_listeners:
            listener(path)
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._refresh_changed_path, path)

    def notify_file_change(self, path: Path) -> None:
        self._on_file_change_from_thread(path)

    def _refresh_changed_path(self, path: Path) -> None:
        state = self._states.get(path)
        if state is None:
            return
        previous = state.turns
        self._refresh_state(state)
        if state.turns == previous:
            return
        # The browser keeps only the newest bounded live window. Older pages
        # are fetched separately by byte cursor, so every live update can
        # replace that tail without invalidating the older-page positions.
        payload = {"type": "transcript_update", "revision": state.revision,
                   "replace_from": 0, "windowed": True,
                   "turns": state.turns[-self.HISTORY_PAGE_TURNS:]}
        state.update_log.append(payload)
        del state.update_log[:-128]
        for queue in list(self._subscribers.get(path, ())):
            queue.put_nowait(payload)

    def _reload_state(self, state: _TranscriptState, max_bytes: int | None = None) -> None:
        try:
            stat = state.path.stat()
        except (FileNotFoundError, OSError):
            state.raw_turns = []
            state.turns = []
            state.offset = 0
            state.carry = b""
            state.inode = None
            state.revision += 1
            state.update_log.clear()
            state.last_user_at = None
            return
        reload_limit = max_bytes or self.STATE_RELOAD_MAX_BYTES
        window_bytes = self.HISTORY_PAGE_INITIAL_BYTES
        complete: list[bytes] = []
        carry = b""
        offset = stat.st_size
        while True:
            _, complete, carry, offset = self._read_recent_transcript_lines(state.path, stat.st_size, window_bytes)
            parsed_count = len(state.agent.parse_transcript_lines([line.decode(errors="replace") for line in complete]))
            if parsed_count >= self.MAX_RAW_TURNS or offset == 0 or window_bytes >= reload_limit:
                break
            window_bytes = min(window_bytes * 2, reload_limit)
        lines = [line.decode(errors="replace") for line in complete]
        state.last_user_at = self._latest_user_timestamp(state.agent, lines)
        state.raw_turns = self._trim_recent_raw_turns(state.agent.parse_transcript_lines(lines))
        state.turns = self._trim_display_turns(TurnBuilder.collapse_thinking_events(state.raw_turns))
        state.offset = offset
        state.carry = carry
        state.inode = getattr(stat, "st_ino", None)
        state.revision += 1
        state.update_log.clear()

    @staticmethod
    def _read_recent_transcript_lines(path: Path, end_byte: int, max_bytes: int) -> tuple[int, list[bytes], bytes, int]:
        start_byte = max(0, end_byte - max_bytes)
        try:
            with path.open("rb") as source:
                if start_byte > 0:
                    source.seek(start_byte - 1)
                    previous = source.read(1)
                    source.seek(start_byte)
                else:
                    previous = b"\n"
                data = source.read(max(0, end_byte - start_byte))
        except OSError:
            return end_byte, [], b"", end_byte
        if start_byte > 0 and previous not in (b"\n", b"\r"):
            boundary = data.find(b"\n")
            if boundary < 0:
                return end_byte, [], data, end_byte
            start_byte += boundary + 1
            data = data[boundary + 1:]
        complete: list[bytes] = []
        carry = b""
        consumed = 0
        for raw_line in data.splitlines(keepends=True):
            if raw_line.endswith((b"\n", b"\r")):
                complete.append(raw_line.rstrip(b"\r\n"))
                consumed += len(raw_line)
            else:
                carry = raw_line
                break
        return start_byte, complete, carry, start_byte + consumed

    def _refresh_state(self, state: _TranscriptState) -> None:
        try:
            stat = state.path.stat()
        except (FileNotFoundError, OSError):
            if state.turns:
                self._reload_state(state)
            return
        inode = getattr(stat, "st_ino", None)
        if state.inode != inode or stat.st_size < state.offset:
            self._reload_state(state)
            return
        if stat.st_size == state.offset:
            return
        try:
            with state.path.open("rb") as stream:
                stream.seek(state.offset + len(state.carry))
                data = state.carry + stream.read()
                new_offset = stream.tell()
        except OSError:
            return
        chunks = data.splitlines(keepends=True)
        complete: list[bytes] = []
        carry = b""
        for chunk in chunks:
            if chunk.endswith((b"\n", b"\r")):
                complete.append(chunk.rstrip(b"\r\n"))
            else:
                carry = chunk
        if not complete:
            state.carry = data
            return
        lines = [line.decode(errors="replace") for line in complete]
        latest_user_at = self._latest_user_timestamp(state.agent, lines)
        if latest_user_at is not None:
            state.last_user_at = latest_user_at
        state.raw_turns.extend(state.agent.parse_transcript_lines(lines))
        state.raw_turns = self._trim_recent_raw_turns(state.raw_turns)
        state.turns = self._trim_display_turns(TurnBuilder.collapse_thinking_events(state.raw_turns))
        state.carry = carry
        state.offset = new_offset - len(carry)
        state.inode = inode
        state.revision += 1

    @staticmethod
    def _latest_user_timestamp(agent: AgentCli, lines: Iterable[str]) -> float | None:
        latest: float | None = None
        for line in lines:
            payload = TurnBuilder.loads(line)
            if payload is None:
                continue
            timestamp = agent.user_payload_timestamp(payload)
            if timestamp is None:
                continue
            latest = timestamp if latest is None else max(latest, timestamp)
        return latest

    def _trim_recent_raw_turns(self, turns: list[dict[str, object]]) -> list[dict[str, object]]:
        """Bound memory while preserving the newest transcript events.

        The terminal is live and always shows the newest output. Keeping the
        oldest raw events here caused Markdown to stop before the current
        conversation once a long Codex rollout crossed the limit.
        """
        if len(turns) <= self.MAX_RAW_TURNS:
            return turns
        return turns[-self.MAX_RAW_TURNS:]

    def _trim_display_turns(self, turns: list[dict[str, object]]) -> list[dict[str, object]]:
        if len(turns) <= self.MAX_TURNS:
            return turns
        return turns[-self.MAX_TURNS:]

