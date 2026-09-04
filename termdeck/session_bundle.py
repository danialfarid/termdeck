import io
import json
import math
import re
import zipfile
import zlib
from dataclasses import dataclass
from pathlib import Path

from termdeck.config import TermdeckConfig
from termdeck.util import TimeUtil


@dataclass(frozen=True)
class ImportedSessionBundle:
    session: dict[str, object]
    transcript: bytes
    replay_kind: str
    replay: bytes


class SessionBundleService:
    """Creates and validates portable, bounded TermDeck session archives."""

    FORMAT = "termdeck-session"
    FORMAT_VERSION = 1
    MANIFEST_NAME = "manifest.json"
    SESSION_NAME = "session.json"
    TRANSCRIPT_NAME = "transcript.jsonl"
    REPLAY_NAME = "terminal-replay.bin"
    README_NAME = "README.txt"
    SAFE_TITLE_PATTERN = re.compile(r"[^0-9A-Za-z._-]+")
    SESSION_FIELDS = (
        "title", "title_user_set", "command", "agent_kind", "agent_session_id", "created_at_est", "draft",
        "last_activity_at", "cols", "rows", "cli_title", "fork_parent_agent_session_id",
    )

    def __init__(self, imported_transcripts_directory: Path) -> None:
        self.imported_transcripts_directory = imported_transcripts_directory

    def build(self, termdeck_version: str, record: dict[str, object], project_root: Path,
              turns: list[dict[str, object]], replay_kind: str, replay: bytes) -> tuple[str, bytes]:
        transcript, transcript_truncated = self._bounded_transcript(turns)
        bounded_replay = replay[-TermdeckConfig.SESSION_BUNDLE_REPLAY_MAX_BYTES:]
        session = {key: record.get(key) for key in self.SESSION_FIELDS}
        session["cwd_relative"] = self._relative_working_directory(str(record.get("cwd") or ""), project_root)
        manifest = {
            "format": self.FORMAT, "format_version": self.FORMAT_VERSION,
            "termdeck_version": termdeck_version, "exported_at_est": TimeUtil.now_est_naive_iso(),
            "transcript_turns": transcript.count(b"\n"), "transcript_truncated": transcript_truncated,
            "replay_kind": replay_kind if bounded_replay else "none", "replay_bytes": len(bounded_replay),
        }
        archive_buffer = io.BytesIO()
        with zipfile.ZipFile(archive_buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(self.MANIFEST_NAME, json.dumps(manifest, indent=2, sort_keys=True) + "\n")
            archive.writestr(self.SESSION_NAME, json.dumps(session, indent=2, sort_keys=True) + "\n")
            if transcript:
                archive.writestr(self.TRANSCRIPT_NAME, transcript)
            if bounded_replay:
                archive.writestr(self.REPLAY_NAME, bounded_replay)
            archive.writestr(self.README_NAME, self._readme())
        title = self.SAFE_TITLE_PATTERN.sub("-", str(record.get("title") or "session")).strip("-.")[:60] or "session"
        return f"{title}.termdeck-session", archive_buffer.getvalue()

    def read(self, archive_bytes: bytes) -> ImportedSessionBundle:
        if not archive_bytes or len(archive_bytes) > TermdeckConfig.SESSION_BUNDLE_MAX_BYTES:
            raise ValueError("session archive is empty or exceeds the 64 MB limit")
        try:
            with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
                self._validate_entry_sizes(archive)
                manifest = self._read_json_object(archive, self.MANIFEST_NAME)
                session = self._read_json_object(archive, self.SESSION_NAME)
                if manifest.get("format") != self.FORMAT or manifest.get("format_version") != self.FORMAT_VERSION:
                    raise ValueError("unsupported TermDeck session archive format")
                self._validate_session(session)
                transcript = archive.read(self.TRANSCRIPT_NAME) if self.TRANSCRIPT_NAME in archive.namelist() else b""
                replay = archive.read(self.REPLAY_NAME) if self.REPLAY_NAME in archive.namelist() else b""
                replay_kind = str(manifest.get("replay_kind") or "none")
        except (zipfile.BadZipFile, KeyError, json.JSONDecodeError, UnicodeDecodeError,
                NotImplementedError, RuntimeError, EOFError, zlib.error) as error:
            raise ValueError("invalid TermDeck session archive") from error
        if replay_kind not in {"none", "scrollback", "raw-replay"}:
            raise ValueError("unsupported terminal replay type")
        self._validate_transcript(transcript)
        return ImportedSessionBundle(session, transcript, replay_kind, replay)

    def store_imported_transcript(self, session_id: str, transcript: bytes) -> str | None:
        if not transcript:
            return None
        if not re.fullmatch(r"[0-9a-f]{12}", session_id):
            raise ValueError("invalid imported session id")
        self.imported_transcripts_directory.mkdir(parents=True, exist_ok=True)
        target = self.imported_transcripts_directory / f"{session_id}.jsonl"
        temporary = target.with_suffix(".tmp")
        temporary.write_bytes(transcript)
        temporary.replace(target)
        return session_id

    def remove_imported_transcript(self, session_id: str) -> None:
        target = self.imported_transcripts_directory / f"{session_id}.jsonl"
        if target.is_file():
            target.unlink()

    @staticmethod
    def _relative_working_directory(cwd: str, project_root: Path) -> str:
        try:
            return str(Path(cwd).expanduser().resolve().relative_to(project_root.expanduser().resolve())) or "."
        except (ValueError, OSError):
            return "."

    @staticmethod
    def _bounded_transcript(turns: list[dict[str, object]]) -> tuple[bytes, bool]:
        lines: list[bytes] = []
        total = 0
        for turn in reversed(turns):
            line = (json.dumps(turn, separators=(",", ":"), ensure_ascii=False, default=str) + "\n").encode()
            if total + len(line) > TermdeckConfig.SESSION_BUNDLE_TRANSCRIPT_MAX_BYTES:
                return b"".join(reversed(lines)), True
            lines.append(line)
            total += len(line)
        return b"".join(reversed(lines)), False

    @staticmethod
    def _read_json_object(archive: zipfile.ZipFile, name: str) -> dict[str, object]:
        payload = json.loads(archive.read(name).decode())
        if not isinstance(payload, dict):
            raise ValueError(f"{name} must contain an object")
        return payload

    @staticmethod
    def _validate_entry_sizes(archive: zipfile.ZipFile) -> None:
        allowed = {SessionBundleService.MANIFEST_NAME, SessionBundleService.SESSION_NAME,
                   SessionBundleService.TRANSCRIPT_NAME, SessionBundleService.REPLAY_NAME,
                   SessionBundleService.README_NAME}
        entries = archive.infolist()
        if len(entries) > 32:
            raise ValueError("session archive has too many entries")
        seen: set[str] = set()
        total_size = 0
        for entry in entries:
            if entry.filename not in allowed:
                raise ValueError(f"unexpected archive entry: {entry.filename}")
            if entry.filename in seen:
                raise ValueError(f"duplicate archive entry: {entry.filename}")
            seen.add(entry.filename)
            limit = TermdeckConfig.SESSION_BUNDLE_REPLAY_MAX_BYTES if entry.filename == SessionBundleService.REPLAY_NAME \
                else TermdeckConfig.SESSION_BUNDLE_TRANSCRIPT_MAX_BYTES if entry.filename == SessionBundleService.TRANSCRIPT_NAME \
                else 1_000_000
            if entry.file_size > limit:
                raise ValueError(f"archive entry is too large: {entry.filename}")
            total_size += entry.file_size
        if total_size > TermdeckConfig.SESSION_BUNDLE_MAX_BYTES:
            raise ValueError("session archive contents exceed the 64 MB limit")

    @staticmethod
    def _validate_session(session: dict[str, object]) -> None:
        title = session.get("title")
        command = session.get("command")
        agent_kind = session.get("agent_kind")
        if not isinstance(title, str) or not title.strip() or len(title) > 500:
            raise ValueError("session archive has an invalid title")
        if not isinstance(command, str) or len(command) > 16_000:
            raise ValueError("session archive has an invalid command")
        if not isinstance(agent_kind, str) or not agent_kind or agent_kind == "termdeck-archive":
            raise ValueError("session archive has an invalid agent kind")
        for field in ("agent_session_id", "cli_title", "fork_parent_agent_session_id"):
            value = session.get(field)
            if value is not None and (not isinstance(value, str) or len(value) > 1_000):
                raise ValueError(f"session archive has an invalid {field}")
        draft = session.get("draft")
        if draft is not None and (not isinstance(draft, str) or len(draft) > 200_000):
            raise ValueError("session archive has an invalid draft")
        try:
            cols = int(session.get("cols") or TermdeckConfig.INITIAL_COLS)
            rows = int(session.get("rows") or TermdeckConfig.INITIAL_ROWS)
            activity_time = float(session.get("last_activity_at") or 0)
        except (TypeError, ValueError) as error:
            raise ValueError("session archive has invalid dimensions or activity time") from error
        if not math.isfinite(activity_time):
            raise ValueError("session archive has invalid dimensions or activity time")
        if not 1 <= cols <= 10_000 or not 1 <= rows <= 10_000:
            raise ValueError("session archive has invalid dimensions")
        cwd_relative = session.get("cwd_relative")
        if not isinstance(cwd_relative, str) or Path(cwd_relative).is_absolute() or ".." in Path(cwd_relative).parts:
            raise ValueError("session archive has an invalid working directory")

    @staticmethod
    def _validate_transcript(transcript: bytes) -> None:
        if len(transcript) > TermdeckConfig.SESSION_BUNDLE_TRANSCRIPT_MAX_BYTES:
            raise ValueError("session transcript exceeds the archive limit")
        for line in transcript.splitlines():
            try:
                turn = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError("session transcript is not valid JSONL") from error
            if not isinstance(turn, dict) or not isinstance(turn.get("role"), str) or \
                    not isinstance(turn.get("text"), str):
                raise ValueError("session transcript contains an invalid turn")

    @staticmethod
    def _readme() -> str:
        return (
            "This is a TermDeck session archive. Importing it creates a dormant tab and does not execute anything.\n"
            "Opening that tab may run or resume the command recorded in session.json. Import archives only from sources you trust.\n"
            "transcript.jsonl is a portable normalized conversation; terminal-replay.bin is optional display history.\n"
        )
