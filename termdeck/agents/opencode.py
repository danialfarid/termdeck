import shlex
import sqlite3
import time
from pathlib import Path

from termdeck.agents.base import AgentCli
from termdeck.util import TimeUtil


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

    supports_resume = True
    supports_fork = True
    canonical_resume_command = True
    accepts_session_ref = True
    records_raw_replay = True
    fullscreen_tui = True

    prompt_marker = "┃"
    # Terminal frame with opencode's block cursor.
    icon_svg = ('<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="19" height="16" '
                'rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="6.5" y="8.5" '
                'width="5" height="7" fill="currentColor"/><path d="M14 15.5h3.5" stroke="currentColor" '
                'stroke-width="2" stroke-linecap="round"/></svg>')

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
