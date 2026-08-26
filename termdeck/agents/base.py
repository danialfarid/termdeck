import datetime as dt
import re
import shlex
from pathlib import Path
from typing import Iterable

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _coerce_timestamp(value: object) -> float | None:
    try:
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError, OverflowError):
        return None
    return None


class AgentCli:
    """Everything TermDeck knows about one agent CLI, in one class.

    Adapters are stateless singletons registered in termdeck.agents.AGENT_CLIS; orchestration
    code (session manager, transcript service, history index, server) stays generic and asks
    the adapter for per-CLI facts. Adding a new agent CLI means subclassing this and adding
    the instance to the registry — see docs/agent-cli-api.md.
    """

    # -- identity ---------------------------------------------------------
    kind = "none"                       # serialized in SessionRecord.agent_kind
    executable = ""                     # binary name; also the command-detection token
    label = ""                          # display name in the UI
    model_aliases: tuple[str, ...] = () # extra names accepted in the create-session model field
    is_agent = True                     # False only for the shell null object

    # -- capabilities -----------------------------------------------------
    supports_resume = False             # a dead terminal can respawn onto its old agent session
    supports_fork = False               # an agent session can be forked into a new terminal
    fork_tracks_parent = False          # forked records remember the parent agent session id
    canonical_resume_command = False    # the saved command is kept rewritten as a resume of the bound session
    records_raw_replay = False          # raw pty output is recorded and replayed on reconnect
    has_prompt_queue = False            # Tab queues the composer draft instead of completing

    # -- command lifecycle ------------------------------------------------
    base_flags: tuple[str, ...] = ()    # always-on flags injected right after the executable
    # Permission vocabulary (canonical names plus accepted aliases) -> CLI flags.
    permission_flags: dict[str, tuple[str, ...]] = {"default": ()}
    # (value, label) pairs the client UI offers when creating a session.
    ui_permission_options: tuple[tuple[str, str], ...] = (("default", "Default"),)
    # Tokens removed when swapping a saved command's permission: standalone switches, and
    # flags that consume the following token as their value.
    permission_switch_flags: tuple[str, ...] = ()
    permission_value_flags: tuple[str, ...] = ()

    # -- client presentation ---------------------------------------------
    prompt_marker = ""                  # composer-row marker used to locate the input line

    def normalized_permission_flags(self, permission: str) -> tuple[str, ...]:
        requested = (permission or "").strip().lower() or "default"
        flags = self.permission_flags.get(requested)
        if flags is None:
            raise ValueError(f"unknown {self.kind} permission: {permission}")
        return flags

    def model_arguments(self, model_name: str) -> tuple[str, ...]:
        return ("--model", model_name)

    def new_session_resume_arguments(self, session_ref: str, tracker) -> tuple[str, ...]:
        raise ValueError(f"{self.kind} terminal currently supports new sessions only")

    def build_command(self, permission: str, model_name: str, session_ref: str, tracker) -> str:
        parts = [self.executable, *self.base_flags, *self.normalized_permission_flags(permission)]
        if model_name:
            parts.extend(self.model_arguments(model_name))
        if session_ref:
            parts.extend(self.new_session_resume_arguments(session_ref, tracker))
        return shlex.join(parts)

    def resume_command(self, original_command: str, agent_session_id: str) -> str:
        return original_command

    def fork_command(self, original_command: str, agent_session_id: str, session_name: str = "") -> str:
        return original_command

    def set_permission(self, command: str, permission: str) -> str:
        """Swap the permission flags on a saved command, keeping everything else in place."""
        flags = self.normalized_permission_flags(permission)
        parts = self.command_parts(command)
        command_index = next((index for index, token in enumerate(parts)
                              if Path(token).name == self.executable), None)
        if command_index is None:
            return command
        tail: list[str] = []
        skip_next = False
        for token in parts[command_index + 1:]:
            if skip_next:
                skip_next = False
                continue
            if token in self.permission_value_flags:
                skip_next = True
                continue
            if token in self.permission_switch_flags:
                continue
            tail.append(token)
        return shlex.join([*parts[:command_index + 1], *flags, *tail])

    # -- transcript store --------------------------------------------------
    # Head marker identifying a subagent/sidechain transcript file (b"" = the CLI has none).
    subagent_file_marker: bytes = b""

    def transcript_path(self, cwd: Path | None, agent_session_id: str) -> Path | None:
        """The CLI's own on-disk transcript for one session, or None if it does not exist."""
        return None

    def candidate_session_files(self, cwd: Path) -> list[tuple[Path, str]]:
        """(transcript path, session id) pairs a new session in cwd could bind to."""
        return []

    def owns_transcript_path(self, path: Path) -> bool:
        return False

    def session_id_from_path(self, path: Path) -> str | None:
        return None

    # -- transcript parsing ------------------------------------------------
    def parse_transcript_lines(self, lines: Iterable[str]) -> list[dict[str, object]]:
        """Raw jsonl transcript lines -> turn dicts (see TurnBuilder)."""
        return []

    def is_user_payload(self, payload: dict[str, object]) -> bool:
        return False

    def user_payload_timestamp(self, payload: dict[str, object]) -> float | None:
        """Epoch timestamp of a user payload, when the line carries one."""
        if not self.is_user_payload(payload):
            return None
        return _coerce_timestamp(payload.get("timestamp"))

    def payload_text(self, payload: dict[str, object]) -> str:
        return ""

    def conversation_payload_text(self, payload: dict[str, object]) -> str:
        return ""

    def is_conversation_payload(self, payload: dict[str, object]) -> bool:
        return False

    def title_from_payload(self, payload: dict[str, object]) -> str:
        return ""

    def cwd_from_payload(self, path: Path, payload: dict[str, object]) -> str:
        return str(payload.get("cwd", ""))

    def client_descriptor(self) -> dict[str, object]:
        return {"kind": self.kind, "label": self.label, "is_agent": self.is_agent,
                "permissions": [{"value": value, "label": label} for value, label in self.ui_permission_options],
                "prompt_marker": self.prompt_marker,
                "supports_resume": self.supports_resume, "supports_fork": self.supports_fork,
                "records_raw_replay": self.records_raw_replay, "has_prompt_queue": self.has_prompt_queue}

    @staticmethod
    def command_parts(command: str) -> list[str]:
        try:
            return shlex.split(command)
        except ValueError:
            return command.split()

    @staticmethod
    def strip_flag_with_value(parts: list[str], flag: str) -> list[str]:
        cleaned: list[str] = []
        skip_next = False
        for token in parts:
            if skip_next:
                skip_next = False
                continue
            if token == flag:
                skip_next = True
            else:
                cleaned.append(token)
        return cleaned


class ShellCli(AgentCli):
    """Null object for plain shell terminals: agent machinery become no-ops."""

    kind = "none"
    label = "Shell"
    is_agent = False
    ui_permission_options = (("default", "Shell permissions"),)

    def model_arguments(self, model_name: str) -> tuple[str, ...]:
        raise ValueError("model_name is only supported for agent terminals")

    def new_session_resume_arguments(self, session_ref: str, tracker) -> tuple[str, ...]:
        raise ValueError("a shell terminal cannot resume an agent session")

    def build_command(self, permission: str, model_name: str, session_ref: str, tracker) -> str:
        if session_ref:
            raise ValueError("a shell terminal cannot resume an agent session")
        if model_name:
            raise ValueError("model_name is only supported for agent terminals")
        self.normalized_permission_flags(permission)
        return ""
