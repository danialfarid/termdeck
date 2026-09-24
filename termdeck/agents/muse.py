import os
import shlex
from datetime import timedelta
from pathlib import Path

from termdeck.agents.base import AgentCli, OutputActivityState
from termdeck.util import TimeUtil


class MuseCli(AgentCli):
    """muse — Meta's interactive terminal coding agent.

    Sessions are directories rather than files: the store is
    `<XDG_DATA_HOME | ~/.local/share>/muse/sessions/<yyyy>/<mm>/<dd>/<session>/session.jsonl`,
    so a session id is the name of the directory holding the log, and `muse resume <session-ref>`
    takes that id (or a session name).

    What the log holds is not described here, and nothing reads it yet: the format is not
    documented by `muse schema`, which exports the MSP wire surface rather than the session log,
    and there was no session on this machine to model it on. So the terminal binds to its session
    and resumes it, and the transcript view stays empty until the shape is known from a real log
    rather than guessed at.
    """

    kind = "muse"
    executable = "muse"
    label = "Muse"

    # A Path the transcript watcher reads directly, like every other agent's.
    _DATA_HOME = Path(os.environ["XDG_DATA_HOME"]) if os.environ.get("XDG_DATA_HOME") else Path.home() / ".local" / "share"
    sessions_root = _DATA_HOME / "muse" / "sessions"

    supports_resume = True
    canonical_resume_command = True
    accepts_session_ref = True
    records_raw_replay = True
    # The session log is not parsed, so what the terminal writes is the only activity signal.
    processing_from_output = True
    activity_source = "terminal-output"
    DAY_DIR_LOOKAROUND_DAYS = (-1, 0, 1)
    SESSION_LOG_NAME = "session.jsonl"

    install_hint = "Install Muse from Meta, then sign in with `muse login`."
    model_placeholder = "model id, optionally with a reasoning effort (for example high)"
    model_help = ("A trailing effort word becomes --reasoning-effort: "
                  "none, minimal, low, medium, high, xhigh, max or ultra.")
    transcript_commands = (("/help", "Show Muse commands"),)
    # The prompt muse opens an untrusted workspace with, and the one it asks a tool through; both wait
    # on a keypress, which is what the attention badge is for. Matched against lowercased output.
    attention_output_markers = ("do you trust this workspace?", "use up/down or 1/2, then enter")

    # Its own approval modes, plus the one switch that turns approval and the sandbox off together.
    permission_flags = {
        "default": (),
        "untrusted": ("--approval-mode", "untrusted"),
        "on-request": ("--approval-mode", "on-request"),
        "never": ("--approval-mode", "never"),
        "full-access": ("--yolo",),
    }
    ui_permission_options = (("default", "Default (approve on request)"), ("untrusted", "Untrusted"),
                             ("never", "Never ask"), ("full-access", "Full access (--yolo)"))
    permission_value_flags = ("--approval-mode",)
    permission_switch_flags = ("--yolo", "--disable-approval", "--disable-sandbox", "--trust-workspace")

    REASONING_EFFORTS = frozenset({"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"})

    # A lyre: the muse's instrument.
    icon_svg = ('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5c-1.2 3.4-1.2 8.6 0 12.6M18 '
                '3.5c1.2 3.4 1.2 8.6 0 12.6M6 4.6h12M9.4 5.2v11.2M14.6 5.2v11.2" fill="none" stroke='
                '"currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8 20.2h8" fill="none" '
                'stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>')

    def __init__(self) -> None:
        self._session_logs: dict[str, Path] = {}

    def new_session_state(self) -> OutputActivityState:
        return OutputActivityState()

    def model_arguments(self, model_name: str) -> tuple[str, ...]:
        # A trailing effort word ("some-model xhigh") is muse's --reasoning-effort, not part of the id.
        parts = model_name.split()
        arguments: list[str] = []
        if len(parts) > 1 and parts[-1].lower() in self.REASONING_EFFORTS:
            arguments.extend(("--reasoning-effort", parts[-1].lower()))
            model_name = " ".join(parts[:-1])
        arguments.extend(("--model", model_name))
        return tuple(arguments)

    def new_session_resume_arguments(self, session_ref: str, tracker) -> tuple[str, ...]:
        return ("resume", session_ref)

    def resume_command(self, original_command: str, agent_session_id: str) -> str:
        cleaned = self.strip_session_arguments(self.command_parts(original_command)) or [self.executable]
        cleaned.extend(("resume", agent_session_id))
        return shlex.join(cleaned)

    def fresh_session_command(self, original_command: str) -> str:
        cleaned = self.strip_session_arguments(self.command_parts(original_command)) or [self.executable]
        return shlex.join(cleaned)

    def strip_session_arguments(self, parts: list[str]) -> list[str]:
        cleaned: list[str] = []
        command_seen = False
        skip_session_ref = False
        for token in parts:
            if skip_session_ref:
                skip_session_ref = False
                continue
            if not command_seen:
                cleaned.append(token)
                command_seen = Path(token).name == self.executable
                continue
            if token == "resume":
                # `resume` is followed by a session ref, or by --last, which is one too.
                skip_session_ref = True
                continue
            cleaned.append(token)
        return cleaned

    # -- sessions on disk --------------------------------------------------

    def transcript_path(self, cwd: Path | None, agent_session_id: str) -> Path | None:
        # A session's directory never moves once it exists, so the search is done once per session.
        cached = self._session_logs.get(agent_session_id)
        if cached is not None and cached.exists():
            return cached
        try:
            for path in self.sessions_root.rglob(f"{agent_session_id}/{self.SESSION_LOG_NAME}"):
                self._session_logs[agent_session_id] = path
                return path
        except OSError:
            return None
        return None

    def candidate_session_files(self, cwd: Path) -> list[tuple[Path, str]]:
        pairs: list[tuple[Path, str]] = []
        for day_dir in self._recent_day_dirs():
            try:
                entries = list(day_dir.iterdir())
            except OSError:
                continue
            for session_dir in entries:
                log = session_dir / self.SESSION_LOG_NAME
                if log.exists():
                    pairs.append((log, session_dir.name))
        return pairs

    def owns_transcript_path(self, path: Path) -> bool:
        root = self.sessions_root
        try:
            return path.is_relative_to(root) or path.is_relative_to(root.resolve())
        except OSError:
            return False

    def session_id_from_path(self, path: Path) -> str | None:
        if path.name != self.SESSION_LOG_NAME or not self.owns_transcript_path(path):
            return None
        return path.parent.name or None

    @classmethod
    def _recent_day_dirs(cls) -> list[Path]:
        today = TimeUtil.today_est()
        root = cls.sessions_root
        return [root / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}"
                for day in (today + timedelta(days=offset) for offset in cls.DAY_DIR_LOOKAROUND_DAYS)]
