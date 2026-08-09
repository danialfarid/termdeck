import hashlib
import sqlite3
import threading
from datetime import datetime
from pathlib import Path

from termdeck.config import TermdeckConfig
from termdeck.util import TimeUtil


class FileHistoryService:
    def __init__(self, database_path: Path) -> None:
        self._database_path = database_path
        self._lock = threading.RLock()
        self._database_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as database:
            database.executescript(
                "CREATE TABLE IF NOT EXISTS file_history ("
                "version_id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "root TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL,"
                "content_hash TEXT NOT NULL, byte_size INTEGER NOT NULL,"
                "source TEXT NOT NULL, captured_at_est TEXT NOT NULL"
                ");"
                "CREATE INDEX IF NOT EXISTS file_history_path_index "
                "ON file_history(root, path, version_id DESC);"
            )

    def _connect(self) -> sqlite3.Connection:
        database = sqlite3.connect(self._database_path)
        database.row_factory = sqlite3.Row
        return database

    @staticmethod
    def _canonical_root(root: str) -> str:
        return str(Path(root).expanduser().resolve())

    @staticmethod
    def _canonical_path(path: str) -> str:
        return Path(path).as_posix()

    @staticmethod
    def _content_hash(content: str) -> str:
        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    def _latest(self, database: sqlite3.Connection, root: str, path: str) -> sqlite3.Row | None:
        return database.execute(
            "SELECT version_id, content_hash, source, captured_at_est FROM file_history WHERE root = ? AND path = ? "
            "ORDER BY version_id DESC LIMIT 1", (root, path)
        ).fetchone()

    @staticmethod
    def _is_recent_manual_snapshot(latest: sqlite3.Row, captured_at_est: str) -> bool:
        if str(latest["source"]) != "manual":
            return False
        latest_time = datetime.fromisoformat(str(latest["captured_at_est"]))
        current_time = datetime.fromisoformat(captured_at_est)
        return (current_time - latest_time).total_seconds() < TermdeckConfig.FILE_HISTORY_COALESCE_SECONDS

    def _trim(self, database: sqlite3.Connection, root: str, path: str) -> None:
        database.execute(
            "DELETE FROM file_history WHERE version_id IN ("
            "SELECT version_id FROM file_history WHERE root = ? AND path = ? "
            "ORDER BY version_id DESC LIMIT -1 OFFSET ?)",
            (root, path, TermdeckConfig.FILE_HISTORY_MAX_VERSIONS_PER_FILE),
        )
        while True:
            total = database.execute("SELECT COALESCE(SUM(byte_size), 0) FROM file_history").fetchone()[0]
            if total <= TermdeckConfig.FILE_HISTORY_MAX_BYTES:
                return
            oldest = database.execute("SELECT version_id FROM file_history ORDER BY version_id LIMIT 1").fetchone()
            if oldest is None:
                return
            database.execute("DELETE FROM file_history WHERE version_id = ?", (oldest[0],))

    def record_snapshot(self, root: str, path: str, content: str, source: str) -> int:
        canonical_root = self._canonical_root(root)
        canonical_path = self._canonical_path(path)
        content_hash = self._content_hash(content)
        captured_at_est = TimeUtil.now_est_naive().isoformat(sep=" ")
        with self._lock, self._connect() as database:
            latest = self._latest(database, canonical_root, canonical_path)
            if latest is not None and latest["content_hash"] == content_hash:
                return int(latest["version_id"])
            if latest is not None and source == "manual" and self._is_recent_manual_snapshot(latest, captured_at_est):
                database.execute(
                    "UPDATE file_history SET content = ?, content_hash = ?, byte_size = ?, captured_at_est = ? "
                    "WHERE version_id = ?",
                    (content, content_hash, len(content.encode("utf-8")), captured_at_est, int(latest["version_id"])),
                )
                self._trim(database, canonical_root, canonical_path)
                return int(latest["version_id"])
            cursor = database.execute(
                "INSERT INTO file_history(root, path, content, content_hash, byte_size, source, captured_at_est) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (canonical_root, canonical_path, content, content_hash, len(content.encode("utf-8")), source,
                 captured_at_est),
            )
            self._trim(database, canonical_root, canonical_path)
            return int(cursor.lastrowid)

    def observe_file(self, root: str, path: str, content: str) -> int:
        with self._lock, self._connect() as database:
            canonical_root = self._canonical_root(root)
            canonical_path = self._canonical_path(path)
            latest = self._latest(database, canonical_root, canonical_path)
            if latest is not None and latest["content_hash"] == self._content_hash(content):
                return int(latest["version_id"])
        return self.record_snapshot(root, path, content, "external" if latest is not None else "opened")

    def record_write(self, root: str, path: str, previous_content: str, content: str) -> int:
        self.observe_file(root, path, previous_content)
        return self.record_snapshot(root, path, content, "manual")

    def list_versions(self, root: str, path: str) -> list[dict[str, object]]:
        canonical_root = self._canonical_root(root)
        canonical_path = self._canonical_path(path)
        with self._lock, self._connect() as database:
            rows = database.execute(
                "SELECT version_id, source, captured_at_est, byte_size FROM file_history "
                "WHERE root = ? AND path = ? ORDER BY version_id DESC",
                (canonical_root, canonical_path),
            ).fetchall()
        return [{"version_id": int(row["version_id"]), "source": str(row["source"]),
                 "captured_at_est": str(row["captured_at_est"]), "byte_size": int(row["byte_size"])} for row in rows]

    def get_version(self, version_id: int) -> dict[str, object] | None:
        with self._lock, self._connect() as database:
            row = database.execute(
                "SELECT version_id, root, path, content, source, captured_at_est, byte_size "
                "FROM file_history WHERE version_id = ?", (version_id,)
            ).fetchone()
        if row is None:
            return None
        return {"version_id": int(row["version_id"]), "root": str(row["root"]), "path": str(row["path"]),
                "content": str(row["content"]), "source": str(row["source"]),
                "captured_at_est": str(row["captured_at_est"]), "byte_size": int(row["byte_size"])}

    def version_belongs_to_file(self, version_id: int, root: str, path: str) -> bool:
        version = self.get_version(version_id)
        return version is not None and version["root"] == self._canonical_root(root) and \
            version["path"] == self._canonical_path(path)
