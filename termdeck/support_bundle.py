import io
import json
import platform
import re
import shlex
import sys
import zipfile
from pathlib import Path

from termdeck.util import TimeUtil


class SupportBundleBuilder:
    """Builds a bounded issue-report archive without terminal text, prompts, source files, or credentials."""

    LOG_TAIL_MAX_BYTES = 1_000_000
    RECORDING_TAIL_MAX_BYTES = 4_000_000
    SAFE_SETTING_KEYS = (
        "bottom_font_size", "code_font_size", "diff_font_size", "file_tab_max_visible", "file_tab_order",
        "files_panel_width", "files_tab_font_size", "history_mode", "hide_dot_folders", "hide_excluded",
        "inline_size_controls", "lsp_enabled", "recent_terminal_hours", "search_scope", "show_git_status",
        "show_mtime", "show_stats", "show_terminal_age", "show_terminal_icons", "side_full", "side_split",
        "sidebar_font_size", "sidebar_width", "system_font_size", "tall_webgl", "terminal_font_size",
        "terminal_icon_size", "theme", "transcript_first_surface", "tree_font_size", "ui_font_size", "word_wrap",
    )
    UUID_PATTERN = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,36}\b")
    EMAIL_PATTERN = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
    URL_QUERY_PATTERN = re.compile(r"(https?://[^\s?]+)\?[^\s]+")
    AUTHORIZATION_PATTERN = re.compile(
        r"(?i)([\"']?authorization[\"']?\s*[:=]\s*)(?:\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\r\n,;}]+)")
    COOKIE_PATTERN = re.compile(
        r"(?i)([\"']?cookie[\"']?\s*[:=]\s*)(?:\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\r\n]+)")
    SECRET_PATTERN = re.compile(
        r"(?i)([\"']?(?:token|secret|password|api[-_]?key)[\"']?\s*[:=]\s*)(?:\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s,;}]+)")

    def __init__(self, data_dir: Path, service_log_path: Path, home_directory: Path | None = None) -> None:
        self.data_dir = data_dir
        self.service_log_path = service_log_path
        self.home_directory = home_directory or Path.home()

    def build(self, version: str, server_instance_id: str, settings: dict[str, object],
              sessions: list[dict[str, object]], dependencies: list[dict[str, object]],
              process_report: dict[str, object], lsp_status: dict[str, object],
              remote_status: dict[str, object], project_count: int) -> bytes:
        generated_at_est = TimeUtil.now_est_naive_iso()
        payloads: dict[str, object] = {
            "manifest.json": {
                "format": 1, "generated_at_est": generated_at_est, "termdeck_version": version,
                "server_instance": server_instance_id[:12], "project_count": project_count,
                "runtime": {"python": sys.version.split()[0], "os": platform.system(),
                            "os_release": platform.release(), "machine": platform.machine()},
                "privacy": "Terminal output, prompts, source files, project paths, titles, and credentials are omitted.",
            },
            "environment.json": self._safe_dependencies(dependencies),
            "settings.json": self._safe_settings(settings),
            "sessions.json": self._safe_sessions(sessions),
            "terminal-processes.json": self._safe_process_report(process_report),
            "language-servers.json": self._safe_lsp_status(lsp_status),
            "remote-access.json": self._safe_remote_status(remote_status),
        }
        archive_buffer = io.BytesIO()
        with zipfile.ZipFile(archive_buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, payload in payloads.items():
                archive.writestr(name, json.dumps(payload, indent=2, sort_keys=True, default=str) + "\n")
            log_tail = self._read_tail(self.service_log_path, self.LOG_TAIL_MAX_BYTES)
            if log_tail:
                archive.writestr("termdeck.log", self._redact_text(log_tail))
            recording = self._latest_diagnostics_recording()
            if recording is not None:
                archive.writestr("browser-diagnostics.jsonl",
                                 self._redact_text(self._read_tail(recording, self.RECORDING_TAIL_MAX_BYTES)))
        return archive_buffer.getvalue()

    def _safe_settings(self, settings: dict[str, object]) -> dict[str, object]:
        return {key: settings[key] for key in self.SAFE_SETTING_KEYS if key in settings}

    def _safe_dependencies(self, dependencies: list[dict[str, object]]) -> list[dict[str, object]]:
        safe: list[dict[str, object]] = []
        for dependency in dependencies:
            safe.append({key: dependency.get(key) for key in
                         ("program", "is_present", "is_required", "used_for", "install_hint")})
        return safe

    def _safe_sessions(self, sessions: list[dict[str, object]]) -> list[dict[str, object]]:
        project_numbers: dict[str, int] = {}
        safe: list[dict[str, object]] = []
        for index, session in enumerate(sessions, 1):
            project = str(session.get("project") or "")
            if project not in project_numbers:
                project_numbers[project] = len(project_numbers) + 1
            safe.append({
                "session": index, "project": project_numbers[project], "agent_kind": session.get("agent_kind"),
                "running": session.get("running"), "dormant": session.get("dormant"),
                "detached": session.get("detached"), "processing": session.get("processing"),
                "needs_attention": session.get("needs_attention"), "exit_code": session.get("exit_code"),
                "created_at_est": session.get("created_at_est"), "last_activity_at": session.get("last_activity_at"),
                "cols": session.get("cols"), "rows": session.get("rows"),
                "worktree": str(session.get("worktree_id") or "root") != "root",
            })
        return safe

    def _safe_process_report(self, process_report: dict[str, object]) -> dict[str, object]:
        safe_sockets: list[dict[str, object]] = []
        sockets = process_report.get("sockets")
        if isinstance(sockets, list):
            for index, socket in enumerate(sockets, 1):
                if not isinstance(socket, dict):
                    continue
                processes = socket.get("processes") if isinstance(socket.get("processes"), list) else []
                safe_sockets.append({
                    "session": index, "known_session": socket.get("known_session"), "live": socket.get("live"),
                    "attached": socket.get("attached"), "detached": socket.get("detached"),
                    "processes": [self._safe_process(process) for process in processes if isinstance(process, dict)],
                })
        return {"summary": process_report.get("summary", {}), "sessions": safe_sockets}

    def _safe_process(self, process: dict[str, object]) -> dict[str, object]:
        command = str(process.get("command") or "")
        try:
            executable = Path(shlex.split(command)[0]).name if command else ""
        except ValueError:
            executable = Path(command.split(maxsplit=1)[0]).name if command else ""
        return {key: process.get(key) for key in
                ("pid", "ppid", "state", "cpu_percent", "rss_kb", "elapsed")} | {"executable": executable}

    def _safe_lsp_status(self, lsp_status: dict[str, object]) -> dict[str, object]:
        servers = lsp_status.get("servers") if isinstance(lsp_status.get("servers"), list) else []
        active = lsp_status.get("active") if isinstance(lsp_status.get("active"), list) else []
        return {
            "enabled": lsp_status.get("enabled"),
            "servers": [{key: server.get(key) for key in ("key", "name", "languages", "available", "source", "version")}
                        for server in servers if isinstance(server, dict)],
            "active": [{"server": item.get("server"), "running": item.get("running")}
                       for item in active if isinstance(item, dict)],
        }

    def _safe_remote_status(self, remote_status: dict[str, object]) -> dict[str, object]:
        return {"state": remote_status.get("state"), "configured": bool(remote_status.get("relay_url")),
                "public_url_configured": bool(remote_status.get("public_url")), "has_error": bool(remote_status.get("error")),
                "direct_authentication": bool(remote_status.get("direct_authentication")),
                "read_only": bool(remote_status.get("read_only"))}

    def _latest_diagnostics_recording(self) -> Path | None:
        diagnostics_directory = self.data_dir / "diagnostics"
        if not diagnostics_directory.is_dir():
            return None
        recordings = [path for path in diagnostics_directory.iterdir() if path.is_file() and path.suffix == ".jsonl"]
        return max(recordings, key=lambda path: path.stat().st_mtime) if recordings else None

    @staticmethod
    def _read_tail(path: Path, maximum_bytes: int) -> str:
        try:
            with path.open("rb") as source:
                source.seek(0, 2)
                size = source.tell()
                source.seek(max(0, size - maximum_bytes))
                if size > maximum_bytes:
                    source.readline()
                return source.read().decode(errors="replace")
        except OSError:
            return ""

    def _redact_text(self, text: str) -> str:
        redacted = text.replace(str(self.home_directory), "~")
        redacted = self.UUID_PATTERN.sub("<session>", redacted)
        redacted = self.EMAIL_PATTERN.sub("<email>", redacted)
        redacted = self.URL_QUERY_PATTERN.sub(r"\1?<redacted>", redacted)
        redacted = self.AUTHORIZATION_PATTERN.sub(r"\1<redacted>", redacted)
        redacted = self.COOKIE_PATTERN.sub(r"\1<redacted>", redacted)
        return self.SECRET_PATTERN.sub(r"\1<redacted>", redacted)
