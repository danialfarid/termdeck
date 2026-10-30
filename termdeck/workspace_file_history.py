import hashlib
import json
import re
import sqlite3
import threading
from contextlib import closing
from pathlib import Path

from termdeck.file_history_service import FileHistoryService
from termdeck.util import TimeUtil


class WorkspaceFileHistoryService:
    DATABASE_NAME = "file-history.sqlite3"
    WORKSPACE_METADATA_NAME = "workspace.json"
    MIGRATION_COMPLETE_NAME = ".migration-complete"
    VERSION_COLUMNS = "version_id, root, path, content, content_hash, byte_size, source, captured_at_est"

    def __init__(self, directory: Path, legacy_database: Path) -> None:
        self._directory = directory
        self._lock = threading.RLock()
        self._histories: dict[str, FileHistoryService] = {}
        directory.mkdir(parents=True, exist_ok=True)
        self._migrate_shared_database(legacy_database)

    def workspace_directory(self, root: str) -> Path:
        canonical_root = FileHistoryService._canonical_root(root)
        name = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(canonical_root).name).strip(".-")[:60] or "workspace"
        identity = hashlib.sha256(canonical_root.encode("utf-8")).hexdigest()[:12]
        return self._directory / f"{name}-{identity}"

    def _history_for_root(self, root: str, create: bool = False) -> FileHistoryService | None:
        canonical_root = FileHistoryService._canonical_root(root)
        directory = self.workspace_directory(canonical_root)
        database_path = directory / self.DATABASE_NAME
        with self._lock:
            if not database_path.exists() and not create:
                return None
            if canonical_root not in self._histories or not database_path.exists():
                directory.mkdir(parents=True, exist_ok=True)
                metadata_path = directory / self.WORKSPACE_METADATA_NAME
                if metadata_path.exists():
                    if json.loads(metadata_path.read_text(encoding="utf-8"))["root"] != canonical_root:
                        raise ValueError(f"file history folder belongs to another workspace: {directory}")
                else:
                    temporary_metadata = metadata_path.with_suffix(".tmp")
                    temporary_metadata.write_text(json.dumps({"root": canonical_root}, indent=2) + "\n", encoding="utf-8")
                    temporary_metadata.replace(metadata_path)
                self._histories[canonical_root] = FileHistoryService(database_path)
            return self._histories[canonical_root]

    def _writable_history(self, root: str) -> FileHistoryService:
        history = self._history_for_root(root, create=True)
        assert history is not None
        return history

    def _migrate_shared_database(self, legacy_database: Path) -> None:
        marker = self._directory / self.MIGRATION_COMPLETE_NAME
        if marker.exists():
            return
        if legacy_database.exists():
            with closing(sqlite3.connect(f"{legacy_database.resolve().as_uri()}?mode=ro", uri=True)) as source:
                source.execute("BEGIN")
                roots = source.execute("SELECT DISTINCT root FROM file_history ORDER BY root").fetchall()
                for (root,) in roots:
                    self._writable_history(root)
                    self._copy_and_verify_workspace(source, root)
            archive_name = f"{legacy_database.stem}.migrated-{TimeUtil.now_est_naive():%Y%m%d-%H%M%S-%f}.sqlite3"
            legacy_database.rename(legacy_database.with_name(archive_name))
        marker.write_text("Workspace folders are independent; deleted history is not imported again.\n", encoding="utf-8")

    def _copy_and_verify_workspace(self, source: sqlite3.Connection, root: str) -> None:
        database_path = self.workspace_directory(root) / self.DATABASE_NAME
        select = f"SELECT {self.VERSION_COLUMNS} FROM file_history WHERE root = ? ORDER BY version_id"
        with closing(sqlite3.connect(database_path)) as destination, destination:
            destination.executemany(
                f"INSERT OR REPLACE INTO file_history ({self.VERSION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                source.execute(select, (root,)),
            )
            for expected, copied in zip(source.execute(select, (root,)), destination.execute(select, (root,)), strict=True):
                if expected != copied:
                    raise ValueError(f"file history migration verification failed for {root}")

    def record_snapshot(self, root: str, path: str, content: str, source: str) -> int:
        return self._writable_history(root).record_snapshot(root, path, content, source)

    def observe_file(self, root: str, path: str, content: str) -> int:
        return self._writable_history(root).observe_file(root, path, content)

    def list_versions(self, root: str, path: str) -> list[dict[str, object]]:
        history = self._history_for_root(root)
        return history.list_versions(root, path) if history is not None else []

    def get_version(self, version_id: int, root: str) -> dict[str, object] | None:
        history = self._history_for_root(root)
        return history.get_version(version_id) if history is not None else None

    def version_belongs_to_file(self, version_id: int, root: str, path: str) -> bool:
        history = self._history_for_root(root)
        return history.version_belongs_to_file(version_id, root, path) if history is not None else False

    def list_files(self, root: str, query: str = "", offset: int = 0, limit: int = 50) -> dict[str, object]:
        rows: list[sqlite3.Row] = []
        for metadata in self._directory.glob(f"*/{self.WORKSPACE_METADATA_NAME}"):
            workspace_root = json.loads(metadata.read_text(encoding="utf-8"))["root"]
            history = self._history_for_root(workspace_root)
            if history is not None:
                rows.extend(history.retained_file_rows(root))
        rows.sort(key=lambda row: (str(row["captured_at_est"]), int(row["latest_version_id"])), reverse=True)
        return FileHistoryService.retained_file_page(root, rows, query, offset, limit)
