import asyncio
import datetime as dt
import json
import re
import shlex
import time
from pathlib import Path
from typing import Iterable

from termdeck.config import TermdeckConfig

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class AgentSessionState:
    """Marker base for per-agent runtime state hung off ManagedSession.agent_state.

    Each AgentCli owns its state shape via new_session_state(); nothing here is persisted.
    """


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

    # -- transcript tree ---------------------------------------------------
    sessions_root: Path | None = None   # root of the CLI's on-disk transcript tree
    history_indexed = False             # the tree is scanned into the history search index
    has_own_transcript_watcher = False  # something else already watches the tree for changes

    # -- capabilities -----------------------------------------------------
    supports_resume = False             # a dead terminal can respawn onto its old agent session
    supports_fork = False               # an agent session can be forked into a new terminal
    fork_tracks_parent = False          # forked records remember the parent agent session id
    canonical_resume_command = False    # the saved command is kept rewritten as a resume of the bound session
    records_raw_replay = False          # raw pty output is recorded and replayed on reconnect
    has_prompt_queue = False            # Tab queues the composer draft instead of completing
    supports_agent_rename = False       # TermDeck can push its tab title into the CLI's own session name
    detection_claims_new_files = False  # new transcript files are claimable without recent local input
    accepts_session_ref = False         # the create dialog can attach to an existing session by id/name

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

    # -- token usage -------------------------------------------------------
    USAGE_TAIL_BYTES = 512 * 1024

    def usage_from_payload(self, payload: dict[str, object]) -> dict[str, int | None] | None:
        """Normalized token usage carried by one transcript line, or None.

        Keys: context_tokens (prompt side of the newest request — effectively the live context
        size), output_tokens (newest turn), context_window and total_tokens where the CLI
        reports them.
        """
        return None

    def latest_usage(self, cwd: Path | None, agent_session_id: str | None) -> dict[str, int | None] | None:
        """Newest usage report in the session transcript, from a bounded tail read."""
        if not agent_session_id:
            return None
        path = self.transcript_path(cwd, agent_session_id)
        if path is None:
            return None
        try:
            with path.open("rb") as handle:
                handle.seek(0, 2)
                handle.seek(max(0, handle.tell() - self.USAGE_TAIL_BYTES))
                lines = handle.read().decode(errors="replace").splitlines()
        except OSError:
            return None
        for line in reversed(lines):
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, dict):
                continue
            usage = self.usage_from_payload(payload)
            if usage is not None:
                return usage
        return None

    # -- activity / processing / attention ---------------------------------
    # These hooks receive the TerminalSessionManager ("manager") and a ManagedSession ("ms");
    # adapters may use the manager's broadcast/persist/tracker plumbing.

    def new_session_state(self) -> AgentSessionState | None:
        """Fresh runtime state for one session of this agent; None when the agent keeps none."""
        return None

    def is_processing(self, ms) -> bool:
        """Whether the agent behind this session is actively working (attention gate is the caller's)."""
        return bool(ms.processing)

    def refresh_persisted_activity(self, manager, ms) -> None:
        """Rebuild activity state for a session reconciled as detached-live with a bound agent id."""

    def refresh_activity_for_status(self, manager, ms) -> None:
        """Cheap freshness pass right before a status/summary payload is built."""

    def on_transcript_event(self, manager, ms, path: Path) -> None:
        """A watched transcript file changed; update this session's activity if the file is its own."""

    async def reconcile_bindings(self, manager, ms, proc_tree) -> None:
        """Re-derive the agent-session binding during the startup/periodic reconcile.

        `proc_tree` is the sweep's shared ProcTreeSnapshot: answer process questions from it rather than
        probing per session, since the whole sweep runs before the server starts listening."""

    def reconcile_metadata(self, manager, ms) -> None:
        """Post-binding reconcile step: titles, re-detection, anything not binding-critical."""

    def on_cli_title_updated(self, manager, ms) -> None:
        """The OSC title changed; adapters may re-check bindings or schedule detection."""

    def transcript_requires_attention(self, manager, ms) -> bool:
        return False

    def update_attention_from_title(self, manager, ms, title: str | None) -> bool:
        return False

    def update_attention_from_output(self, manager, ms, data: bytes) -> bool:
        return False

    def title_requires_attention(self, title: str | None) -> bool:
        return False

    def session_title(self, tracker, cwd: Path, agent_session_id: str | None) -> str | None:
        return None

    # -- input interpretation ----------------------------------------------

    def pre_write_input(self, manager, ms, text: str, draft_before: str) -> None:
        """Interpret user keystrokes headed to the pty (prompt submits, interrupts) before the write."""

    def post_write_input(self, manager, ms, text: str) -> None:
        """React after the keystrokes reached the pty."""

    def on_api_prompt_submitted(self, manager, ms, queue: bool) -> None:
        """A prompt is about to be pasted through the API/Markdown path."""

    @staticmethod
    def submitted_command(text: str, draft_before: str) -> str:
        command = draft_before.strip()
        if not command:
            command = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text).splitlines()[0].strip()
        return command.replace("\x1b[200~", "").replace("\x1b[201~", "").strip()

    # -- rename ------------------------------------------------------------

    async def send_rename(self, manager, ms, title: str, *, ready_delay: float = 0.0,
                          clear_composer: bool = True) -> None:
        """Send the CLI's own /rename command so tab title and agent session name converge."""
        title = " ".join(str(title or "").splitlines()).strip()
        if not title:
            return
        if ready_delay > 0:
            await asyncio.sleep(ready_delay)
        if ms.proc is None or not ms.proc.alive or not ms.record.agent_session_id:
            return
        self._before_send_rename(ms, title)
        command = f"/rename {title}"
        payload = ((b"\x15" if clear_composer else b"") +
                   TermdeckConfig.BRACKETED_PASTE_START + command.encode() +
                   TermdeckConfig.BRACKETED_PASTE_END).decode()
        manager.write_input(ms.record.session_id, payload)
        await asyncio.sleep(TermdeckConfig.FORK_RENAME_SUBMIT_DELAY_SECONDS)
        manager.write_input(ms.record.session_id, "\r")

    def _before_send_rename(self, ms, title: str) -> None:
        pass

    async def rename_after_fork(self, manager, ms, title: str) -> None:
        await self.send_rename(manager, ms, title,
                               ready_delay=TermdeckConfig.FORK_RENAME_READY_DELAY_SECONDS,
                               clear_composer=True)

    def reconcile_rename(self, manager, ms, previous_title: str | None) -> bool:
        """Persist a rename performed inside the CLI once its durable state confirms it."""
        return False

    # -- spawn / restart / detection ---------------------------------------

    def before_spawn(self, manager, ms) -> None:
        pass

    def on_spawned(self, manager, ms) -> None:
        pass

    def restart_screen_repaint_delay(self, raw_replay_enabled: bool) -> float | None:
        """Delay before nudging a repaint after a non-reattach resume, or None for no nudge."""
        return None

    def restart_permission(self, manager, ms) -> str:
        """Permission to re-apply on restart when the caller did not specify one."""
        return ""

    async def verify_detected_session_id(self, manager, ms, found: str | None, socket: Path) -> str | None:
        return found

    def detection_fallback_session_id(self, manager, ms, claimed: set[str]) -> str | None:
        return None

    def detection_should_retry(self, ms) -> bool:
        return time.monotonic() < ms.detect_deadline_monotonic

    def on_agent_session_bound(self, manager, ms) -> None:
        pass

    def client_descriptor(self) -> dict[str, object]:
        return {"kind": self.kind, "label": self.label, "is_agent": self.is_agent,
                "permissions": [{"value": value, "label": label} for value, label in self.ui_permission_options],
                "prompt_marker": self.prompt_marker,
                "supports_resume": self.supports_resume, "supports_fork": self.supports_fork,
                "accepts_session_ref": self.accepts_session_ref,
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
