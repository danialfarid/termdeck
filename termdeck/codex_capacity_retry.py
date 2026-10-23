import asyncio
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from termdeck import agents

if TYPE_CHECKING:
    from termdeck.session_manager import ManagedSession, TerminalSessionManager


@dataclass(frozen=True)
class CapacityRetryCandidate:
    error_id: str
    command: str
    signature: tuple[int, int, int, int]


@dataclass
class CapacityRetryBackoff:
    attempts: int = 0
    last_error_id: str = ""
    pending_error_id: str = ""
    retry_at: float = 0.0
    progressing_since: float | None = None
    last_progress_check: float | None = None


@dataclass
class CapacityRetryWatch:
    last_output: float
    quiet_checks: int = 0
    parked: bool = False


class CodexCapacityRetry:
    SETTING = "codex_capacity_retry"
    CHECK_SECONDS = 15
    INITIAL_DELAY_SECONDS = 180
    MAX_DELAY_SECONDS = 48 * 60 * 60
    PROGRESS_RESET_SECONDS = 15 * 60
    IDLE_SECONDS = 15
    TAIL_BYTES = 131072
    CAPACITY_MESSAGE = "Selected model is at capacity. Please try a different model."
    CAPACITY_CODE = "server_overloaded"
    RESUME_GOAL = "/goal resume"
    CONTINUE = "go"
    CANCEL_EVENTS = {"task_started", "turn_started", "user_message", "turn_aborted"}
    logger = logging.getLogger(__name__)

    def __init__(self, manager: "TerminalSessionManager") -> None:
        self.manager = manager
        self.task: asyncio.Task[None] | None = None
        self.backoffs: dict[str, CapacityRetryBackoff] = {}
        self.checked_signatures: dict[str, tuple[Path, tuple[int, int, int, int]]] = {}
        self.watches: dict[str, CapacityRetryWatch] = {}

    def start(self) -> None:
        self.task = asyncio.create_task(self.run())

    def stop(self) -> None:
        if self.task is not None:
            self.task.cancel()
            self.task = None

    @staticmethod
    def latest_session_activity(session: "ManagedSession") -> float:
        return max(session.last_output_monotonic, session.last_typing_monotonic,
                   session.last_agent_submit_monotonic)

    @staticmethod
    def signature(path: Path) -> tuple[int, int, int, int]:
        stat = path.stat()
        return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns

    @classmethod
    def read_candidate(cls, path: Path) -> CapacityRetryCandidate | None:
        signature = cls.signature(path)
        with path.open("rb") as stream:
            offset = max(0, signature[2] - cls.TAIL_BYTES)
            stream.seek(offset)
            if offset:
                stream.readline()
            data = stream.read(cls.TAIL_BYTES)
        if not data.endswith(b"\n"):
            return None
        error_id = ""
        goal_status = ""
        for line in data.splitlines():
            record = json.loads(line)
            payload = record.get("payload", {})
            kind = payload.get("type")
            if record.get("type") == "response_item" and payload.get("role") == "user":
                error_id = ""
            if record.get("type") != "event_msg":
                continue
            if kind in cls.CANCEL_EVENTS:
                error_id = ""
            elif kind == "thread_goal_updated":
                goal_status = (payload.get("goal") or {}).get("status", "")
                if error_id:
                    error_id = ""
            elif kind == "task_complete":
                error = payload.get("error") or {}
                matches = error.get("codex_error_info") == cls.CAPACITY_CODE and error.get("message") == cls.CAPACITY_MESSAGE
                error_id = str(payload.get("turn_id") or record.get("timestamp") or "") if matches else ""
        if not error_id or goal_status in {"paused", "blocked", "complete", "budget_limited", "usage_limited"}:
            return None
        command = cls.RESUME_GOAL if goal_status == "active" else cls.CONTINUE
        return CapacityRetryCandidate(error_id, command, signature)

    def eligible(self, session: "ManagedSession") -> bool:
        return bool(
            self.manager._ui_setting(self.SETTING, False)
            and session.record.agent_kind == "codex"
            and session.running
            and session.record.agent_session_id
            and not session.attention_required
            and not session.record.draft.strip()
            and not session.prompt_going_in
            and not self.manager._processing_state(session)
            and time.monotonic() - max(session.last_typing_monotonic, session.last_agent_submit_monotonic,
                                       session.last_output_monotonic) >= self.IDLE_SECONDS
        )

    @classmethod
    def retry_delay(cls, attempts: int) -> float:
        return min(cls.MAX_DELAY_SECONDS, cls.INITIAL_DELAY_SECONDS * 2 ** min(attempts, 10))

    def observe_progress(self, session: "ManagedSession", now: float) -> None:
        state = self.backoffs.get(session.record.session_id)
        if state is None:
            return
        progressing = (self.manager._ui_setting(self.SETTING, False) and session.running
                       and not session.attention_required and self.manager._processing_state(session))
        if not progressing:
            state.progressing_since = None
            state.last_progress_check = None
            return
        if (state.progressing_since is None or state.last_progress_check is None
                or now - state.last_progress_check > self.CHECK_SECONDS * 3):
            state.progressing_since = now
        state.last_progress_check = now
        if now - state.progressing_since >= self.PROGRESS_RESET_SECONDS:
            state.attempts = 0
            state.pending_error_id = ""
            state.retry_at = 0.0

    async def retry_session(self, session: "ManagedSession") -> None:
        now = time.monotonic()
        self.observe_progress(session, now)
        session_id = session.record.session_id
        last_output = self.latest_session_activity(session)
        watch = self.watches.get(session_id)
        if watch is None:
            watch = CapacityRetryWatch(last_output)
            self.watches[session_id] = watch
        elif last_output > watch.last_output:
            watch.last_output = last_output
            watch.quiet_checks = 0
            watch.parked = False
            self.checked_signatures.pop(session_id, None)
        elif watch.parked:
            return
        if not self.eligible(session):
            return
        state = self.backoffs.get(session_id)
        if state is not None and state.pending_error_id and now < state.retry_at:
            return
        path = agents.agent_cli("codex").transcript_path(Path(session.record.cwd), session.record.agent_session_id)
        if path is None:
            return
        signature = self.signature(path)
        if self.checked_signatures.get(session_id) == (path, signature):
            watch.quiet_checks += 1
            watch.parked = watch.quiet_checks >= 2
            return
        typing_before = session.last_typing_monotonic
        candidate = await asyncio.to_thread(self.read_candidate, path)
        if candidate is None or (state is not None and candidate.error_id == state.last_error_id):
            self.checked_signatures[session_id] = (path, signature)
            watch.quiet_checks += 1
            watch.parked = watch.quiet_checks >= 2
            return
        watch.quiet_checks = 0
        watch.parked = False
        if state is None:
            state = CapacityRetryBackoff()
            self.backoffs[session_id] = state
        if candidate.error_id != state.pending_error_id:
            state.pending_error_id = candidate.error_id
            state.retry_at = now + self.retry_delay(state.attempts)
            return
        if session.prompt_submit_lock is None:
            session.prompt_submit_lock = asyncio.Lock()
        async with session.prompt_submit_lock:
            if (self.manager._sessions.get(session_id) is not session or not self.eligible(session)
                    or typing_before != session.last_typing_monotonic
                    or self.signature(path) != candidate.signature):
                return
            state.last_error_id = candidate.error_id
            state.pending_error_id = ""
            state.attempts += 1
            state.progressing_since = None
            state.last_progress_check = None
            result = await self.manager._submit_prompt_now(session, candidate.command, False, False, None)
            self.logger.info("Codex capacity retry %s: %s (%s)", session_id, candidate.command, result)

    async def run(self) -> None:
        while True:
            await asyncio.sleep(self.CHECK_SECONDS)
            if not self.manager._ui_setting(self.SETTING, False):
                for state in self.backoffs.values():
                    state.progressing_since = None
                    state.last_progress_check = None
                continue
            self.backoffs = {key: value for key, value in self.backoffs.items() if key in self.manager._sessions}
            self.checked_signatures = {key: value for key, value in self.checked_signatures.items()
                                       if key in self.manager._sessions}
            self.watches = {key: value for key, value in self.watches.items()
                            if key in self.manager._sessions}
            for session in list(self.manager._sessions.values()):
                try:
                    await self.retry_session(session)
                except (OSError, ValueError, KeyError) as error:
                    self.logger.warning("Codex capacity retry skipped %s: %s", session.record.session_id, error)
