import hashlib
import sqlite3
import threading
from contextlib import closing
from datetime import datetime
from pathlib import Path

from termdeck.config import TermdeckConfig
from termdeck.util import TimeUtil


class FileHistoryService:
    def __init__(self, database_path: Path, max_versions_per_file: int | None = None) -> None:
        self._database_path = database_path
        # Notes keep fewer versions than files: they are written on a timer while someone types, and a
        # note nobody has opened for a month should not be holding a hundred of them.
        self._max_versions_per_file = max_versions_per_file or TermdeckConfig.FILE_HISTORY_MAX_VERSIONS_PER_FILE
        self._lock = threading.RLock()
        self._database_path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as database, database:
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
            "SELECT version_id, content, content_hash, source, captured_at_est FROM file_history "
            "WHERE root = ? AND path = ? ORDER BY version_id DESC LIMIT 1", (root, path)
        ).fetchone()

    @staticmethod
    def _is_recent_manual_snapshot(latest: sqlite3.Row, captured_at_est: str) -> bool:
        if str(latest["source"]) != "manual":
            return False
        latest_time = datetime.fromisoformat(str(latest["captured_at_est"]))
        current_time = datetime.fromisoformat(captured_at_est)
        return (current_time - latest_time).total_seconds() < TermdeckConfig.FILE_HISTORY_COALESCE_SECONDS

    @staticmethod
    def _continues(previous: str, content: str) -> bool:
        """Whether this version carries on from the one before it, rather than replacing it.

        Versions written seconds apart are folded together, because someone typing produces one every
        fraction of a second and nobody wants to scroll through them. But a write that replaces the
        text wholesale -- restoring an earlier version, pasting over everything -- is not that, and
        folding it destroyed the version it replaced seconds after it was recorded.

        Only forward: text that grows is someone typing on. Text that shrinks is a restore or a
        deletion, and the longer version it replaces is exactly what someone would come here for --
        allowing it in both directions let a restore eat the writing it replaced. Backspacing leaves
        a version behind as the price, and fifty of them are kept.
        """
        return content.startswith(previous)

    def _trim(self, database: sqlite3.Connection, root: str, path: str) -> None:
        database.execute(
            "DELETE FROM file_history WHERE version_id IN ("
            "SELECT version_id FROM file_history WHERE root = ? AND path = ? "
            "ORDER BY version_id DESC LIMIT -1 OFFSET ?)",
            (root, path, self._max_versions_per_file),
        )
        while True:
            total = database.execute("SELECT COALESCE(SUM(byte_size), 0) FROM file_history WHERE root = ?", (root,)).fetchone()[0]
            if total <= TermdeckConfig.FILE_HISTORY_MAX_BYTES_PER_ROOT:
                return
            oldest = database.execute("SELECT version_id FROM file_history WHERE root = ? ORDER BY version_id LIMIT 1", (root,)).fetchone()
            if oldest is None:
                return
            database.execute("DELETE FROM file_history WHERE version_id = ?", (oldest[0],))

    def record_snapshot(self, root: str, path: str, content: str, source: str) -> int:
        canonical_root = self._canonical_root(root)
        canonical_path = self._canonical_path(path)
        content_hash = self._content_hash(content)
        captured_at_est = TimeUtil.now_est_naive().isoformat(sep=" ")
        with self._lock, closing(self._connect()) as database, database:
            latest = self._latest(database, canonical_root, canonical_path)
            if latest is not None and latest["content_hash"] == content_hash:
                return int(latest["version_id"])
            if (latest is not None and source == "manual" and self._is_recent_manual_snapshot(latest, captured_at_est)
                    and self._continues(str(latest["content"]), content)):
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
        with self._lock, closing(self._connect()) as database, database:
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
        with self._lock, closing(self._connect()) as database, database:
            rows = database.execute(
                "SELECT version_id, source, captured_at_est, byte_size FROM file_history "
                "WHERE root = ? AND path = ? ORDER BY version_id DESC",
                (canonical_root, canonical_path),
            ).fetchall()
        return [{"version_id": int(row["version_id"]), "source": str(row["source"]),
                 "captured_at_est": str(row["captured_at_est"]), "byte_size": int(row["byte_size"])} for row in rows]

    def get_version(self, version_id: int) -> dict[str, object] | None:
        with self._lock, closing(self._connect()) as database, database:
            row = database.execute(
                "SELECT version_id, root, path, content, source, captured_at_est, byte_size "
                "FROM file_history WHERE version_id = ?", (version_id,)
            ).fetchone()
        if row is None:
            return None
        return {"version_id": int(row["version_id"]), "root": str(row["root"]), "path": str(row["path"]),
                "content": str(row["content"]), "source": str(row["source"]),
                "captured_at_est": str(row["captured_at_est"]), "byte_size": int(row["byte_size"])}

    def retained_file_rows(self, root: str) -> list[sqlite3.Row]:
        canonical_root = self._canonical_root(root)
        root_prefix = canonical_root.rstrip("/") + "/"
        with self._lock, closing(self._connect()) as database, database:
            return database.execute(
                "WITH retained_files AS ("
                "SELECT root, path, MAX(version_id) AS latest_version_id, COUNT(*) AS version_count "
                "FROM file_history WHERE root = ? OR substr(root, 1, ?) = ? OR substr(path, 1, ?) = ? "
                "OR instr(path, '..') > 0 GROUP BY root, path) "
                "SELECT retained_files.*, version.captured_at_est FROM retained_files "
                "JOIN file_history AS version ON version.version_id = retained_files.latest_version_id "
                "ORDER BY retained_files.latest_version_id DESC",
                (canonical_root, len(root_prefix), root_prefix, len(root_prefix), root_prefix),
            ).fetchall()

    def list_files(self, root: str, query: str = "", offset: int = 0, limit: int = 50) -> dict[str, object]:
        return self.retained_file_page(root, self.retained_file_rows(root), query, offset, limit)

    @classmethod
    def retained_file_page(cls, root: str, rows: list[sqlite3.Row], query: str, offset: int,
                           limit: int) -> dict[str, object]:
        canonical_root = cls._canonical_root(root)
        limit = max(1, min(limit, 100))
        offset = max(0, offset)
        matched = 0
        files: list[dict[str, object]] = []
        has_more = False
        for row in rows:
            target = (Path(str(row["root"])) / str(row["path"])).resolve()
            if not target.is_relative_to(canonical_root):
                continue
            relative_path = target.relative_to(canonical_root).as_posix()
            if query.strip().casefold() not in relative_path.casefold():
                continue
            matched += 1
            if matched <= offset:
                continue
            if len(files) == limit:
                has_more = True
                break
            files.append({"root": str(row["root"]), "path": str(row["path"]), "relative_path": relative_path,
                          "latest_version_id": int(row["latest_version_id"]), "version_count": int(row["version_count"]),
                          "captured_at_est": str(row["captured_at_est"]), "missing": not target.is_file()})
        return {"root": canonical_root, "files": files, "has_more": has_more,
                "next_offset": offset + len(files)}

    def version_belongs_to_file(self, version_id: int, root: str, path: str) -> bool:
        version = self.get_version(version_id)
        return version is not None and version["root"] == self._canonical_root(root) and \
            version["path"] == self._canonical_path(path)
