import json
import shlex
import sqlite3
import time
from pathlib import Path

from termdeck.agents.base import AgentCli, OutputActivityState
from termdeck.util import TimeUtil


class OpencodeSessionState(OutputActivityState):
    def __init__(self) -> None:
        super().__init__()
        self.database_active = False
        self.database_refresh_after = 0.0


class OpencodeCli(AgentCli):
    """opencode — a TUI agent whose sessions live in a sqlite database, not files.

    Everything file-shaped in the base API stays unimplemented (there is no transcript file
    to tail or index); sessions, titles, and token usage come from read-only queries against
    ~/.local/share/opencode/opencode.db, and session detection uses the query-based fallback
    hook instead of file scanning. Resume is `opencode -s <id>`, fork adds `--fork`.
    """

    kind = "opencode"
    executable = "opencode"
    label = "OpenCode"

    DB_PATH = Path.home() / ".local" / "share" / "opencode" / "opencode.db"
    # A fresh session row appears within moments of the TUI starting; only claim rows born
    # around this terminal's own lifetime so a concurrent opencode elsewhere is never adopted.
    DETECTION_CLAIM_WINDOW_SECONDS = 15 * 60
    DATABASE_ACTIVITY_REFRESH_SECONDS = 1.0

    supports_resume = True
    supports_fork = True
    canonical_resume_command = True
    accepts_session_ref = True
    records_raw_replay = True
    fullscreen_tui = True
    # Titles name the session ("OC | <title>"), never a spinner; the TUI animates continuously
    # while generating and is silent at rest (measured), so output flow is the working signal.
    processing_from_output = True
    activity_source = "session-database+terminal-output"
    attention_output_markers = ("allow once", "allow always", "permission required", "request permission")
    model_placeholder = "provider/model, for example openrouter/anthropic/claude-sonnet-4"
    model_help = "OpenRouter is built into OpenCode; connect it once with /connect, then use openrouter/model IDs."
    transcript_commands = (("/models", "Choose a provider and model"), ("/connect", "Configure a model provider"),
                           ("/sessions", "Switch OpenCode sessions"), ("/compact", "Compact conversation context"))

    permission_flags = {"default": (), "auto": ("--auto",), "full-access": ("--auto",)}
    ui_permission_options = (("default", "Default (confirm actions)"), ("auto", "Auto-approve"))
    permission_switch_flags = ("--auto",)

    prompt_marker = "┃"
    # Terminal frame with opencode's block cursor.
    icon_svg = ('<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="19" height="16" '
                'rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="6.5" y="8.5" '
                'width="5" height="7" fill="currentColor"/><path d="M14 15.5h3.5" stroke="currentColor" '
                'stroke-width="2" stroke-linecap="round"/></svg>')

    def new_session_state(self) -> OpencodeSessionState:
        return OpencodeSessionState()

    def _query(self, sql: str, parameters: tuple = ()) -> list[tuple]:
        if not self.DB_PATH.exists():
            return []
        try:
            with sqlite3.connect(f"file:{self.DB_PATH}?mode=ro", uri=True, timeout=0.5) as connection:
                return connection.execute(sql, parameters).fetchall()
        except (sqlite3.Error, OSError):
            return []

    # -- command lifecycle -------------------------------------------------

    def model_arguments(self, model_name: str) -> tuple[str, ...]:
        return ("-m", model_name)

    def new_session_resume_arguments(self, session_ref: str, tracker) -> tuple[str, ...]:
        return ("-s", session_ref)

    def resume_command(self, original_command: str, agent_session_id: str) -> str:
        cleaned = self.strip_session_arguments(self.command_parts(original_command))
        if not cleaned:
            cleaned = [self.executable]
        cleaned.extend(("-s", agent_session_id))
        return shlex.join(cleaned)

    def fork_command(self, original_command: str, agent_session_id: str, session_name: str = "") -> str:
        cleaned = self.strip_session_arguments(self.command_parts(original_command))
        if not cleaned:
            cleaned = [self.executable]
        cleaned.extend(("-s", agent_session_id, "--fork"))
        return shlex.join(cleaned)

    def strip_session_arguments(self, parts: list[str]) -> list[str]:
        cleaned: list[str] = []
        skip_next = False
        for token in parts:
            if skip_next:
                skip_next = False
                continue
            if token in {"-s", "--session"}:
                skip_next = True
                continue
            if token in {"-c", "--continue", "--fork"} or token.startswith("--session="):
                continue
            cleaned.append(token)
        return cleaned

    # -- session detection / titles / usage --------------------------------

    def detection_fallback_session_id(self, manager, ms, claimed: set[str]) -> str | None:
        created_at = TimeUtil.est_naive_iso_timestamp(ms.record.created_at_est)
        horizon_ms = int(max(created_at, time.time() - self.DETECTION_CLAIM_WINDOW_SECONDS) * 1000)
        rows = self._query(
            "SELECT id FROM session WHERE directory = ? AND parent_id IS NULL AND time_created >= ? "
            "ORDER BY time_created DESC LIMIT 8",
            (ms.record.cwd, horizon_ms))
        for (session_id,) in rows:
            if session_id not in claimed:
                return session_id
        return None

    def session_title(self, tracker, cwd: Path, agent_session_id: str | None) -> str | None:
        if not agent_session_id:
            return None
        rows = self._query("SELECT title FROM session WHERE id = ?", (agent_session_id,))
        title = rows[0][0] if rows else None
        return str(title).strip() or None if title else None

    def latest_usage(self, cwd: Path | None, agent_session_id: str | None) -> dict[str, int | None] | None:
        if not agent_session_id:
            return None
        rows = self._query(
            "SELECT tokens_input, tokens_output, tokens_cache_read, tokens_cache_write "
            "FROM session WHERE id = ?", (agent_session_id,))
        if not rows:
            return None
        tokens_input, tokens_output, cache_read, cache_write = (int(value or 0) for value in rows[0])
        if not (tokens_input or tokens_output):
            return None
        return {"context_tokens": tokens_input + cache_read + cache_write,
                "output_tokens": tokens_output,
                "context_window": None,
                "total_tokens": tokens_input + cache_read + cache_write + tokens_output}

    def is_processing(self, ms) -> bool:
        return bool(ms.processing or ms.agent_state.database_active or self.output_activity_remaining(ms) > 0.0)

    def refresh_persisted_activity(self, manager, ms) -> None:
        self._refresh_database_activity(ms, True)

    def refresh_activity_for_status(self, manager, ms) -> None:
        self._refresh_database_activity(ms, False)

    def activity_detail(self, ms) -> dict[str, object] | None:
        return {"main": True} if self.is_processing(ms) else None

    def _refresh_database_activity(self, ms, force: bool) -> None:
        now = time.monotonic()
        if not force and now < ms.agent_state.database_refresh_after:
            return
        ms.agent_state.database_refresh_after = now + self.DATABASE_ACTIVITY_REFRESH_SECONDS
        session_id = ms.record.agent_session_id
        ms.agent_state.database_active = self._database_session_is_active(session_id) if session_id else False

    def _database_session_is_active(self, session_id: str) -> bool:
        rows = self._query("SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1",
                           (session_id,))
        if not rows:
            return False
        try:
            payload = json.loads(rows[0][0])
        except (json.JSONDecodeError, TypeError):
            return False
        if not isinstance(payload, dict):
            return False
        role = str(payload.get("role") or "")
        if role == "user":
            return True
        timing = payload.get("time")
        return role == "assistant" and isinstance(timing, dict) and timing.get("completed") is None
