import io
import json
import re
import zipfile
import zlib
from dataclasses import dataclass

from termdeck.config import TermdeckConfig
from termdeck.util import TimeUtil


@dataclass(frozen=True)
class ProjectBundleSession:
    source_session_id: str
    source_worktree_id: str
    archive: bytes


@dataclass(frozen=True)
class ImportedProjectBundle:
    project_name: str
    worktrees: list[dict[str, object]]
    project_states: dict[str, dict[str, object]]
    sessions: list[ProjectBundleSession]


class ProjectBundleService:
    FORMAT = "termdeck-project"
    FORMAT_VERSION = 1
    MANIFEST_NAME = "manifest.json"
    PROJECT_NAME = "project.json"
    STATE_NAME = "project-state.json"
    README_NAME = "README.txt"
    SESSION_DIRECTORY = "sessions/"
    SESSION_ENTRY_PATTERN = re.compile(r"sessions/[0-9]{3}-[0-9a-f]{12}\.termdeck-session")
    SESSION_ID_PATTERN = re.compile(r"[0-9a-f]{12}")

    def build(self, termdeck_version: str, project_name: str, worktrees: list[dict[str, object]],
              project_states: dict[str, dict[str, object]], sessions: list[ProjectBundleSession],
              archive_label: str = "") -> tuple[str, bytes]:
        if not project_name.strip():
            raise ValueError("project name is required")
        if len(sessions) > TermdeckConfig.PROJECT_BUNDLE_MAX_SESSIONS:
            raise ValueError("project has too many sessions to export")
        manifest_sessions: list[dict[str, str]] = []
        entries: list[tuple[str, bytes]] = []
        for index, session in enumerate(sessions, start=1):
            if not self.SESSION_ID_PATTERN.fullmatch(session.source_session_id):
                raise ValueError("project export has an invalid session id")
            if len(session.archive) > TermdeckConfig.SESSION_BUNDLE_MAX_BYTES:
                raise ValueError("project export has an oversized session archive")
            archive_name = f"{self.SESSION_DIRECTORY}{index:03d}-{session.source_session_id}.termdeck-session"
            manifest_sessions.append({"source_session_id": session.source_session_id,
                                      "source_worktree_id": session.source_worktree_id or "root",
                                      "archive": archive_name})
            entries.append((archive_name, session.archive))
        manifest = {"format": self.FORMAT, "format_version": self.FORMAT_VERSION, "termdeck_version": termdeck_version,
                    "exported_at_est": TimeUtil.now_est_naive_iso(), "session_count": len(entries),
                    "sessions": manifest_sessions}
        project = {"name": project_name, "worktrees": worktrees}
        archive_buffer = io.BytesIO()
        with zipfile.ZipFile(archive_buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(self.MANIFEST_NAME, json.dumps(manifest, indent=2, sort_keys=True) + "\n")
            archive.writestr(self.PROJECT_NAME, json.dumps(project, indent=2, sort_keys=True) + "\n")
            archive.writestr(self.STATE_NAME, json.dumps(project_states, indent=2, sort_keys=True) + "\n")
            for archive_name, payload in entries:
                archive.writestr(archive_name, payload)
            archive.writestr(self.README_NAME, self._readme())
        payload = archive_buffer.getvalue()
        if len(payload) > TermdeckConfig.PROJECT_BUNDLE_MAX_BYTES:
            raise ValueError("project archive exceeds the 512 MB limit")
        safe_name = re.sub(r"[^0-9A-Za-z._-]+", "-", archive_label or project_name).strip("-.")[:60] or "sessions"
        return f"{safe_name}.termdeck-project", payload

    @staticmethod
    def archive_format(archive_bytes: bytes) -> str:
        if not archive_bytes or len(archive_bytes) > TermdeckConfig.PROJECT_BUNDLE_MAX_BYTES:
            raise ValueError("TermDeck archive is empty or exceeds the 512 MB limit")
        try:
            with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
                manifest_info = archive.getinfo(ProjectBundleService.MANIFEST_NAME)
                if manifest_info.file_size > 1_000_000:
                    raise ValueError("TermDeck archive manifest is too large")
                manifest = json.loads(archive.read(ProjectBundleService.MANIFEST_NAME).decode())
        except (zipfile.BadZipFile, KeyError, json.JSONDecodeError, UnicodeDecodeError,
                NotImplementedError, RuntimeError, EOFError, zlib.error) as error:
            raise ValueError("invalid TermDeck archive") from error
        archive_format = manifest.get("format") if isinstance(manifest, dict) else None
        if archive_format not in {ProjectBundleService.FORMAT, "termdeck-session"}:
            raise ValueError("unsupported TermDeck archive format")
        return str(archive_format)

    def read(self, archive_bytes: bytes) -> ImportedProjectBundle:
        if not archive_bytes or len(archive_bytes) > TermdeckConfig.PROJECT_BUNDLE_MAX_BYTES:
            raise ValueError("project archive is empty or exceeds the 512 MB limit")
        try:
            with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
                manifest = self._read_json_object(archive, self.MANIFEST_NAME)
                project = self._read_json_object(archive, self.PROJECT_NAME)
                project_states = self._read_json_object(archive, self.STATE_NAME)
                sessions = self._read_sessions(archive, manifest)
        except (zipfile.BadZipFile, KeyError, json.JSONDecodeError, UnicodeDecodeError,
                NotImplementedError, RuntimeError, EOFError, zlib.error) as error:
            raise ValueError("invalid TermDeck project archive") from error
        if manifest.get("format") != self.FORMAT or manifest.get("format_version") != self.FORMAT_VERSION:
            raise ValueError("unsupported TermDeck project archive format")
        project_name = project.get("name")
        worktrees = project.get("worktrees")
        if not isinstance(project_name, str) or not project_name.strip():
            raise ValueError("project archive has an invalid project name")
        if not isinstance(worktrees, list) or not all(isinstance(item, dict) for item in worktrees):
            raise ValueError("project archive has invalid worktrees")
        self._validate_project_states(project_states)
        return ImportedProjectBundle(project_name, [dict(item) for item in worktrees], project_states, sessions)

    def _read_sessions(self, archive: zipfile.ZipFile, manifest: dict[str, object]) -> list[ProjectBundleSession]:
        raw_sessions = manifest.get("sessions")
        if not isinstance(raw_sessions, list) or len(raw_sessions) > TermdeckConfig.PROJECT_BUNDLE_MAX_SESSIONS:
            raise ValueError("project archive has an invalid session list")
        if manifest.get("session_count") != len(raw_sessions):
            raise ValueError("project archive has an invalid session count")
        expected_entries = {self.MANIFEST_NAME, self.PROJECT_NAME, self.STATE_NAME, self.README_NAME}
        sessions: list[ProjectBundleSession] = []
        total_size = 0
        for item in raw_sessions:
            if not isinstance(item, dict):
                raise ValueError("project archive has an invalid session entry")
            source_session_id = item.get("source_session_id")
            source_worktree_id = item.get("source_worktree_id")
            archive_name = item.get("archive")
            if not isinstance(source_session_id, str) or not self.SESSION_ID_PATTERN.fullmatch(source_session_id) or \
                    not isinstance(source_worktree_id, str) or not isinstance(archive_name, str) or \
                    not self.SESSION_ENTRY_PATTERN.fullmatch(archive_name) or archive_name in expected_entries or \
                    any(session.source_session_id == source_session_id for session in sessions):
                raise ValueError("project archive has an invalid session entry")
            expected_entries.add(archive_name)
            info = archive.getinfo(archive_name)
            if info.file_size > TermdeckConfig.SESSION_BUNDLE_MAX_BYTES:
                raise ValueError("project archive has an oversized session entry")
            total_size += info.file_size
            if total_size > TermdeckConfig.PROJECT_BUNDLE_MAX_BYTES:
                raise ValueError("project archive contents exceed the 512 MB limit")
            sessions.append(ProjectBundleSession(source_session_id, source_worktree_id or "root", archive.read(archive_name)))
        actual_entries = {item.filename for item in archive.infolist()}
        if actual_entries != expected_entries or len(actual_entries) != len(archive.infolist()):
            raise ValueError("project archive has unexpected or duplicate entries")
        return sessions

    @staticmethod
    def _read_json_object(archive: zipfile.ZipFile, name: str) -> dict[str, object]:
        payload = json.loads(archive.read(name).decode())
        if not isinstance(payload, dict):
            raise ValueError(f"{name} must contain an object")
        return payload

    @staticmethod
    def _validate_project_states(project_states: dict[str, object]) -> None:
        if len(project_states) > TermdeckConfig.PROJECT_BUNDLE_MAX_WORKTREES or \
                not all(isinstance(key, str) and isinstance(value, dict) for key, value in project_states.items()):
            raise ValueError("project archive has invalid layout state")

    @staticmethod
    def _readme() -> str:
        return (
            "This is a TermDeck project archive. It contains TermDeck sessions, conversation exports, replay history,\n"
            "and the saved deck layout for a project. It does not contain project source files or Git worktrees.\n"
            "Importing creates dormant tabs. Opening a tab may run or resume its saved command, so import only trusted archives.\n"
        )
