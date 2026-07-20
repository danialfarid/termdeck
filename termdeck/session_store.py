import json
from pathlib import Path

from termdeck.config import TermdeckConfig
from termdeck.models import SessionRecord


class ClosedSessionStore:
    """History of closed terminals (most recent first, capped) kept so they can be reopened later with their
    recorded command, cwd, and agent session id."""

    TMP_SUFFIX = ".tmp"
    CLOSED_AT_FIELD = "closed_at_est"
    SESSION_ID_FIELD = "session_id"

    def __init__(self, closed_file: Path) -> None:
        self._closed_file = closed_file

    def load_all(self) -> list[dict[str, str | bool | None]]:
        if not self._closed_file.exists():
            return []
        return json.loads(self._closed_file.read_text())

    def _save(self, items: list[dict[str, str | bool | None]]) -> None:
        self._closed_file.parent.mkdir(parents=True, exist_ok=True)
        tmp_file = self._closed_file.with_suffix(self.TMP_SUFFIX)
        tmp_file.write_text(json.dumps(items, indent=2))
        tmp_file.replace(self._closed_file)

    def push(self, record: SessionRecord, closed_at_est: str) -> None:
        items = [item for item in self.load_all() if item[self.SESSION_ID_FIELD] != record.session_id]
        items.insert(0, {**record.to_dict(), self.CLOSED_AT_FIELD: closed_at_est})
        self._save(items[:TermdeckConfig.CLOSED_HISTORY_MAX])

    def pop(self, session_id: str) -> SessionRecord | None:
        items = self.load_all()
        remaining = [item for item in items if item[self.SESSION_ID_FIELD] != session_id]
        if len(remaining) == len(items):
            return None
        self._save(remaining)
        target = next(item for item in items if item[self.SESSION_ID_FIELD] == session_id)
        return SessionRecord.from_dict({key: value for key, value in target.items() if key != self.CLOSED_AT_FIELD})

    def remove(self, session_id: str) -> None:
        self._save([item for item in self.load_all() if item[self.SESSION_ID_FIELD] != session_id])


class SessionStore:
    """JSON-file persistence for SessionRecords: loaded once at server start, rewritten atomically on each change."""

    TMP_SUFFIX = ".tmp"

    def __init__(self, sessions_file: Path) -> None:
        self._sessions_file = sessions_file

    def load_all(self) -> list[SessionRecord]:
        if not self._sessions_file.exists():
            return []
        payload = json.loads(self._sessions_file.read_text())
        return [SessionRecord.from_dict(item) for item in payload]

    def save_all(self, records: list[SessionRecord]) -> None:
        self._sessions_file.parent.mkdir(parents=True, exist_ok=True)
        tmp_file = self._sessions_file.with_suffix(self.TMP_SUFFIX)
        tmp_file.write_text(json.dumps([record.to_dict() for record in records], indent=2))
        tmp_file.replace(self._sessions_file)
