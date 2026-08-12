import asyncio
import hashlib
import json
import time
from pathlib import Path

from termdeck.util import TimeUtil


class StateBackupManager:
    """Maintains bounded snapshots of TermDeck's critical JSON state and exposes explicit recovery choices."""

    BACKUP_DIRECTORY_NAME = "backups"
    RECOVERY_DIRECTORY_NAME = "recovery"
    MANIFEST_FILE_NAME = "manifest.json"
    SNAPSHOT_PREFIX = "snapshot-"
    SUSPICIOUS_MINIMUM_REFERENCED_SESSIONS = 8
    SUSPICIOUS_SESSION_COVERAGE = 0.25
    STATE_FILE_ROOT_TYPES: dict[str, type] = {
        "sessions.json": list,
        "settings.json": dict,
        "projects.json": dict,
        "closed_sessions.json": list,
    }

    def __init__(self, data_directory: Path, maximum_bytes: int, interval_seconds: float,
                 prewrite_interval_seconds: float = 300.0) -> None:
        self._data_directory = data_directory
        self._backup_directory = data_directory / self.BACKUP_DIRECTORY_NAME
        self._maximum_bytes = maximum_bytes
        self._interval_seconds = interval_seconds
        self._prewrite_interval_seconds = prewrite_interval_seconds
        self._last_snapshot_fingerprint: str | None = None
        self._last_prewrite_monotonic = 0.0

    async def run_periodic_snapshots(self) -> None:
        while True:
            await asyncio.sleep(self._interval_seconds)
            await asyncio.to_thread(self.create_snapshot, "hourly", True)

    def before_state_write(self, state_file: Path) -> Path | None:
        if state_file.name not in self.STATE_FILE_ROOT_TYPES:
            return None
        now = time.monotonic()
        if now - self._last_prewrite_monotonic < self._prewrite_interval_seconds:
            return None
        snapshot = self.create_snapshot("before-write")
        if snapshot is not None:
            self._last_prewrite_monotonic = now
        return snapshot

    def create_snapshot(self, reason: str, force: bool = False) -> Path | None:
        valid_files = self._read_valid_state_files()
        if not valid_files:
            return None
        fingerprint = self._fingerprint(valid_files)
        if not force and fingerprint == self._last_snapshot_fingerprint:
            return None
        self._backup_directory.mkdir(parents=True, exist_ok=True)
        snapshot_name = f"{self.SNAPSHOT_PREFIX}{time.time_ns()}-{self._safe_reason(reason)}"
        temporary_directory = self._backup_directory / f".{snapshot_name}.tmp"
        snapshot_directory = self._backup_directory / snapshot_name
        temporary_directory.mkdir()
        try:
            for file_name, contents in valid_files.items():
                (temporary_directory / file_name).write_bytes(contents)
            manifest = {"created_at_est": TimeUtil.now_est_naive_iso(), "reason": reason,
                        "files": {file_name: len(contents) for file_name, contents in valid_files.items()}}
            (temporary_directory / self.MANIFEST_FILE_NAME).write_text(json.dumps(manifest, indent=2))
            temporary_directory.replace(snapshot_directory)
        except OSError:
            self._remove_directory(temporary_directory)
            raise
        self._last_snapshot_fingerprint = fingerprint
        self._prune_snapshots()
        return snapshot_directory

    def recovery_status(self) -> dict[str, object]:
        issues = self._state_file_issues()
        return {"required": bool(issues), "issues": issues, "snapshots": self._snapshot_summaries()}

    def restore_snapshot(self, snapshot_name: str) -> list[Path]:
        snapshot_directory = next((path for path in self._snapshot_directories() if path.name == snapshot_name), None)
        if snapshot_directory is None:
            raise ValueError(f"unknown state backup snapshot: {snapshot_name}")
        backup_files: dict[str, bytes] = {}
        for file_name, expected_type in self.STATE_FILE_ROOT_TYPES.items():
            backup_file = snapshot_directory / file_name
            contents = self._read_valid_state_file(backup_file, expected_type)
            if contents is None:
                raise ValueError(f"snapshot is incomplete or invalid: {snapshot_name}")
            backup_files[file_name] = contents
        restored: list[Path] = []
        for file_name in self.STATE_FILE_ROOT_TYPES:
            state_file = self._data_directory / file_name
            self._preserve_state_file(state_file, "before-manual-restore")
            temporary_file = state_file.with_name(f".{state_file.name}-{time.time_ns()}.restore.tmp")
            temporary_file.write_bytes(backup_files[file_name])
            temporary_file.replace(state_file)
            restored.append(state_file)
        self._prune_snapshots()
        return restored

    def _state_file_issues(self) -> list[dict[str, str]]:
        issues: list[dict[str, str]] = []
        for state_file_name, expected_type in self.STATE_FILE_ROOT_TYPES.items():
            state_file = self._data_directory / state_file_name
            if self._valid_state_file(state_file, expected_type):
                continue
            if not state_file.exists() and self._latest_valid_backup_file(state_file_name, expected_type) is None:
                continue
            issues.append({"file": state_file_name, "kind": "missing" if not state_file.exists() else "invalid",
                           "detail": "missing state file" if not state_file.exists() else "invalid JSON or top-level shape"})
        issues.extend({"file": file_name, "kind": "suspicious", "detail": "current state omits most sessions referenced by settings"}
                      for file_name in sorted(self._suspicious_state_file_names()) if not any(
                          issue["file"] == file_name for issue in issues))
        return issues

    def _suspicious_state_file_names(self) -> set[str]:
        sessions_payload = self._read_json_payload(self._data_directory / "sessions.json", list)
        settings_payload = self._read_json_payload(self._data_directory / "settings.json", dict)
        if sessions_payload is None or settings_payload is None:
            return set()
        session_ids = self._session_ids(sessions_payload)
        referenced_session_ids = self._referenced_session_ids(settings_payload)
        suspicious: set[str] = set()
        if len(referenced_session_ids) >= self.SUSPICIOUS_MINIMUM_REFERENCED_SESSIONS and \
                (len(session_ids) < len(referenced_session_ids) * self.SUSPICIOUS_SESSION_COVERAGE or
                 len(session_ids & referenced_session_ids) < len(referenced_session_ids) * self.SUSPICIOUS_SESSION_COVERAGE):
            if self._latest_valid_backup_file("sessions.json", list) is not None:
                suspicious.add("sessions.json")
        if session_ids and len(referenced_session_ids) < \
                len(session_ids) * self.SUSPICIOUS_SESSION_COVERAGE:
            if self._latest_valid_backup_file("settings.json", dict) is not None:
                suspicious.add("settings.json")
        projects_payload = self._read_json_payload(self._data_directory / "projects.json", dict)
        if projects_payload == {}:
            if self._latest_valid_backup_file("projects.json", dict) is not None:
                suspicious.add("projects.json")
        return suspicious

    def _read_valid_state_files(self) -> dict[str, bytes]:
        valid_files: dict[str, bytes] = {}
        for file_name, expected_type in self.STATE_FILE_ROOT_TYPES.items():
            contents = self._read_valid_state_file(self._data_directory / file_name, expected_type)
            if contents is not None:
                valid_files[file_name] = contents
        return valid_files

    @staticmethod
    def _read_valid_state_file(state_file: Path, expected_type: type) -> bytes | None:
        if not state_file.is_file():
            return None
        try:
            contents = state_file.read_bytes()
            payload = json.loads(contents)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return None
        return contents if isinstance(payload, expected_type) else None

    @classmethod
    def _read_json_payload(cls, state_file: Path, expected_type: type) -> object | None:
        contents = cls._read_valid_state_file(state_file, expected_type)
        return json.loads(contents) if contents is not None else None

    @staticmethod
    def _session_ids(payload: list[object]) -> set[str]:
        return {str(item["session_id"]) for item in payload if isinstance(item, dict) and item.get("session_id")}

    @staticmethod
    def _referenced_session_ids(payload: dict[str, object]) -> set[str]:
        project_state = payload.get("project_state")
        if not isinstance(project_state, dict):
            return set()
        session_ids: set[str] = set()
        for state in project_state.values():
            if not isinstance(state, dict):
                continue
            session_order = state.get("session_order")
            if isinstance(session_order, list):
                session_ids.update(str(session_id) for session_id in session_order if session_id)
            terminal_layout = state.get("terminal_layout")
            if isinstance(terminal_layout, list):
                session_ids.update(str(item)[8:] for item in terminal_layout
                                   if isinstance(item, str) and item.startswith("session:"))
        return session_ids

    @classmethod
    def _valid_state_file(cls, state_file: Path, expected_type: type) -> bool:
        return cls._read_valid_state_file(state_file, expected_type) is not None

    def _latest_valid_backup_file(self, file_name: str, expected_type: type) -> Path | None:
        for snapshot_directory in reversed(self._snapshot_directories()):
            backup_file = snapshot_directory / file_name
            if self._valid_state_file(backup_file, expected_type):
                return backup_file
        return None

    def _snapshot_summaries(self) -> list[dict[str, object]]:
        summaries: list[dict[str, object]] = []
        for snapshot_directory in reversed(self._snapshot_directories()):
            manifest_file = snapshot_directory / self.MANIFEST_FILE_NAME
            try:
                manifest = json.loads(manifest_file.read_text())
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(manifest, dict):
                continue
            summaries.append({"name": snapshot_directory.name, "created_at_est": str(manifest.get("created_at_est", "")),
                              "reason": str(manifest.get("reason", "")), "size_bytes": self._directory_size(snapshot_directory),
                              "files": sorted(str(file_name) for file_name in (manifest.get("files") or {}))})
        return summaries

    def _preserve_state_file(self, state_file: Path, reason: str) -> None:
        if not state_file.is_file():
            return
        recovery_directory = self._backup_directory / self.RECOVERY_DIRECTORY_NAME
        recovery_directory.mkdir(parents=True, exist_ok=True)
        target = recovery_directory / f"{state_file.name}-{time.time_ns()}.{reason}"
        target.write_bytes(state_file.read_bytes())

    def _snapshot_directories(self) -> list[Path]:
        if not self._backup_directory.is_dir():
            return []
        return sorted((path for path in self._backup_directory.iterdir()
                       if path.is_dir() and path.name.startswith(self.SNAPSHOT_PREFIX)),
                      key=lambda path: path.stat().st_mtime_ns)

    def _prune_snapshots(self) -> None:
        snapshots = self._snapshot_directories()
        total_bytes = self._directory_size(self._backup_directory)
        while total_bytes > self._maximum_bytes and len(snapshots) > 1:
            oldest = snapshots.pop(0)
            total_bytes -= self._directory_size(oldest)
            self._remove_directory(oldest)
        recovery_files = sorted((path for path in (self._backup_directory / self.RECOVERY_DIRECTORY_NAME).glob("*")
                                 if path.is_file()), key=lambda path: path.stat().st_mtime_ns)
        while total_bytes > self._maximum_bytes and recovery_files:
            oldest = recovery_files.pop(0)
            total_bytes -= oldest.stat().st_size
            oldest.unlink()

    @staticmethod
    def _directory_size(directory: Path) -> int:
        return sum(path.stat().st_size for path in directory.rglob("*") if path.is_file())

    @staticmethod
    def _fingerprint(files: dict[str, bytes]) -> str:
        digest = hashlib.sha256()
        for file_name in sorted(files):
            digest.update(file_name.encode())
            digest.update(files[file_name])
        return digest.hexdigest()

    @staticmethod
    def _safe_reason(reason: str) -> str:
        return "".join(character if character.isalnum() or character in "-_" else "-" for character in reason)

    @classmethod
    def _remove_directory(cls, directory: Path) -> None:
        if not directory.exists():
            return
        for child in directory.iterdir():
            if child.is_dir():
                cls._remove_directory(child)
            else:
                child.unlink()
        directory.rmdir()
