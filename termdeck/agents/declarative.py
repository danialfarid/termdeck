import asyncio
import json
import shlex
import time
from pathlib import Path
from typing import Iterable

from termdeck.agents.base import AgentCli, OutputActivityState
from termdeck.agents.profile_schema import AgentProfile
from termdeck.config import TermdeckConfig
from termdeck.transcript_turns import TurnBuilder


class DeclarativeAgentState(OutputActivityState):
    def __init__(self) -> None:
        super().__init__()
        self.transcript_active = False


class DeclarativeAgentCli(AgentCli):
    """A validated local JSON profile mapped onto the same AgentCli hooks as built-in adapters."""

    TRANSCRIPT_TAIL_BYTES = 512 * 1024
    TRANSCRIPT_DISCOVERY_MAX_FILES = 10_000

    def __init__(self, profile: AgentProfile) -> None:
        self.profile = profile
        self.kind = profile.kind
        self.executable = profile.executable
        self.label = profile.label
        self.model_aliases = profile.aliases
        self.base_flags = profile.base_arguments
        self.permission_flags = {item.value: item.arguments for item in profile.permissions}
        self.ui_permission_options = tuple((item.value, item.label) for item in profile.permissions)
        self.permission_switch_flags = tuple(dict.fromkeys(
            argument for item in profile.permissions for argument in item.arguments
            if argument.startswith("-") and argument not in self._permission_value_flags(profile)))
        self.permission_value_flags = self._permission_value_flags(profile)
        self.supports_resume = profile.sessionless or bool(profile.resume_arguments)
        self.supports_fork = bool(profile.fork_arguments)
        self.fork_tracks_parent = self.supports_fork
        self.canonical_resume_command = profile.canonical_resume_command
        self.records_raw_replay = profile.records_raw_replay
        self.has_prompt_queue = profile.has_prompt_queue
        self.supports_agent_rename = bool(profile.rename_input)
        self.accepts_session_ref = bool(profile.resume_arguments)
        self.sessionless = profile.sessionless
        self.fullscreen_tui = profile.fullscreen_tui
        self.sessions_root = profile.transcript.root if profile.transcript else None
        self.history_indexed = profile.history_indexed and self.sessions_root is not None
        self.processing_from_output = profile.activity.strategy == "terminal-output"
        self.OUTPUT_ACTIVITY_KEEPALIVE_SECONDS = profile.activity.keepalive_seconds
        self.activity_source = profile.activity.strategy
        self.attention_output_markers = profile.attention_markers
        self.icon_svg = profile.icon_svg
        self.install_hint = profile.install_hint
        self.prompt_marker = profile.prompt_marker
        self.model_placeholder = profile.model_placeholder
        self.model_help = profile.model_help

    @staticmethod
    def _permission_value_flags(profile: AgentProfile) -> tuple[str, ...]:
        flags: list[str] = []
        for item in profile.permissions:
            for index, argument in enumerate(item.arguments[:-1]):
                if argument.startswith("-") and not item.arguments[index + 1].startswith("-"):
                    flags.append(argument)
        return tuple(dict.fromkeys(flags))

    def model_arguments(self, model_name: str) -> tuple[str, ...]:
        if not self.profile.model_arguments:
            raise ValueError(f"{self.kind} profile does not accept a model name")
        return self._render_arguments(self.profile.model_arguments, model=model_name)

    def set_model(self, command: str, model_name: str) -> str:
        clean_model_name = model_name.strip()
        if not clean_model_name:
            raise ValueError("model name cannot be empty")
        parts = self.command_parts(command)
        command_index = next((index for index, token in enumerate(parts)
                              if Path(token).name == self.executable), None)
        if command_index is None:
            raise ValueError(f"saved command does not contain {self.executable}")
        value_flags = self._model_value_flags()
        assignment_prefixes = self._model_assignment_prefixes()
        tail: list[str] = []
        skip_next = False
        for token in parts[command_index + 1:]:
            if skip_next:
                skip_next = False
                continue
            if token in value_flags:
                skip_next = True
                continue
            if any(token.startswith(prefix) for prefix in assignment_prefixes):
                continue
            tail.append(token)
        return shlex.join([*parts[:command_index + 1], *self.model_arguments(clean_model_name), *tail])

    def _model_value_flags(self) -> tuple[str, ...]:
        arguments = self.profile.model_arguments
        return tuple(arguments[index - 1] for index, token in enumerate(arguments)
                     if token == "{model}" and index > 0 and arguments[index - 1].startswith("-"))

    def _model_assignment_prefixes(self) -> tuple[str, ...]:
        return tuple(token.split("{model}", 1)[0] for token in self.profile.model_arguments
                     if "{model}" in token and token != "{model}")

    def new_session_resume_arguments(self, session_ref: str, tracker) -> tuple[str, ...]:
        if not self.profile.resume_arguments:
            return super().new_session_resume_arguments(session_ref, tracker)
        return self._render_arguments(self.profile.resume_arguments, session_id=session_ref)

    def resume_command(self, original_command: str, agent_session_id: str) -> str:
        if self.sessionless:
            return original_command
        parts = self._without_session_arguments(self.command_parts(original_command))
        if not parts:
            parts = [self.executable, *self.base_flags]
        return shlex.join([*parts, *self._render_arguments(self.profile.resume_arguments,
                                                           session_id=agent_session_id)])

    def fork_command(self, original_command: str, agent_session_id: str, session_name: str = "") -> str:
        if not self.profile.fork_arguments:
            return original_command
        parts = self._without_session_arguments(self.command_parts(original_command))
        if not parts:
            parts = [self.executable, *self.base_flags]
        arguments = self._render_arguments(self.profile.fork_arguments, session_id=agent_session_id,
                                           title=" ".join(session_name.splitlines()).strip())
        return shlex.join([*parts, *arguments])

    def _without_session_arguments(self, parts: list[str]) -> list[str]:
        cleaned: list[str] = []
        skip_next = False
        for token in parts:
            if skip_next:
                skip_next = False
                continue
            if token in self.profile.session_value_flags:
                skip_next = True
                continue
            if token in self.profile.session_switch_flags:
                continue
            if any(token.startswith(f"{flag}=") for flag in self.profile.session_value_flags):
                continue
            cleaned.append(token)
        return cleaned

    async def send_rename(self, manager, ms, title: str, *, ready_delay: float = 0.0,
                          clear_composer: bool = True) -> None:
        clean_title = " ".join(str(title or "").splitlines()).strip()
        if not clean_title or not self.profile.rename_input:
            return
        if ready_delay > 0:
            await asyncio.sleep(ready_delay)
        if ms.proc is None or not ms.proc.alive or not ms.record.agent_session_id:
            return
        command = self.profile.rename_input.format(title=clean_title)
        payload = ((b"\x15" if clear_composer else b"") + TermdeckConfig.BRACKETED_PASTE_START +
                   command.encode() + TermdeckConfig.BRACKETED_PASTE_END).decode()
        manager.write_input(ms.record.session_id, payload)
        await asyncio.sleep(TermdeckConfig.FORK_RENAME_SUBMIT_DELAY_SECONDS)
        manager.write_input(ms.record.session_id, "\r")

    def transcript_path(self, cwd: Path | None, agent_session_id: str) -> Path | None:
        transcript = self.profile.transcript
        if transcript is None:
            return None
        relative = Path(transcript.path_template.format(session_id=agent_session_id))
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError(f"{self.kind} transcript path must stay inside its root")
        root = transcript.root.resolve()
        candidate = (root / relative).resolve()
        if not candidate.is_relative_to(root):
            raise ValueError(f"{self.kind} transcript path must stay inside its root")
        return candidate if candidate.is_file() else None

    def candidate_session_files(self, cwd: Path) -> list[tuple[Path, str]]:
        transcript = self.profile.transcript
        if transcript is None or not transcript.root.is_dir():
            return []
        candidates: list[tuple[Path, str]] = []
        for index, path in enumerate(transcript.root.glob(transcript.file_glob)):
            if index >= self.TRANSCRIPT_DISCOVERY_MAX_FILES:
                break
            session_id = self.session_id_from_path(path)
            if path.is_file() and session_id:
                candidates.append((path, session_id))
        return candidates

    def owns_transcript_path(self, path: Path) -> bool:
        transcript = self.profile.transcript
        if transcript is None:
            return False
        try:
            return path.resolve().is_relative_to(transcript.root.resolve())
        except OSError:
            return False

    def session_id_from_path(self, path: Path) -> str | None:
        transcript = self.profile.transcript
        if transcript is None or not self.owns_transcript_path(path):
            return None
        relative = path.resolve().relative_to(transcript.root.resolve()).as_posix()
        match = transcript.session_id_regex.search(relative)
        return match.group("session_id") if match else None

    def parse_transcript_lines(self, lines: Iterable[str]) -> list[dict[str, object]]:
        transcript = self.profile.transcript
        if transcript is None:
            return []
        turns: list[dict[str, object]] = []
        for line in lines:
            payload = TurnBuilder.loads(line)
            if payload is None:
                continue
            role = self._payload_role(payload)
            text = self._payload_text(payload)
            if not text:
                continue
            timestamp = self._value_at(payload, transcript.timestamp_path)
            model_value = self._value_at(payload, transcript.model_path)
            model = str(model_value).strip() if isinstance(model_value, str) else None
            if role in transcript.user_roles:
                turns.append(TurnBuilder.turn(TurnBuilder.ROLE_USER, text, model=model, timestamp=timestamp))
            elif role in transcript.assistant_roles:
                turns.append(TurnBuilder.turn(TurnBuilder.ROLE_ASSISTANT, text, model=model, timestamp=timestamp))
            elif role in transcript.thinking_roles:
                turns.append(TurnBuilder.turn("event", text, "thinking", "Thinking", model=model,
                                              timestamp=timestamp))
            elif role in transcript.event_roles:
                turns.append(TurnBuilder.turn("event", text, "result", role.title(), model=model,
                                              timestamp=timestamp))
        return TurnBuilder.collapse_thinking_events(turns)

    def is_user_payload(self, payload: dict[str, object]) -> bool:
        transcript = self.profile.transcript
        return transcript is not None and self._payload_role(payload) in transcript.user_roles

    def payload_text(self, payload: dict[str, object]) -> str:
        return self._payload_text(payload)

    def conversation_payload_text(self, payload: dict[str, object]) -> str:
        transcript = self.profile.transcript
        if transcript is None:
            return ""
        role = self._payload_role(payload)
        return self._payload_text(payload) if role in transcript.user_roles | transcript.assistant_roles else ""

    def is_conversation_payload(self, payload: dict[str, object]) -> bool:
        return bool(self.conversation_payload_text(payload))

    def title_from_payload(self, payload: dict[str, object]) -> str:
        transcript = self.profile.transcript
        return self._string_at(payload, transcript.title_path) if transcript else ""

    def cwd_from_payload(self, path: Path, payload: dict[str, object]) -> str:
        transcript = self.profile.transcript
        return self._string_at(payload, transcript.cwd_path) if transcript else ""

    def session_title(self, tracker, cwd: Path, agent_session_id: str | None) -> str | None:
        if not agent_session_id:
            return None
        path = self.transcript_path(cwd, agent_session_id)
        for payload in reversed(self._tail_payloads(path)):
            title = self.title_from_payload(payload)
            if title:
                return title
        return None

    def new_session_state(self) -> DeclarativeAgentState | None:
        if self.profile.activity.strategy in {"terminal-output", "jsonl-event"}:
            return DeclarativeAgentState()
        return None

    def is_processing(self, ms) -> bool:
        transcript_active = bool(ms.agent_state and getattr(ms.agent_state, "transcript_active", False))
        return bool(super().is_processing(ms) or transcript_active)

    def refresh_persisted_activity(self, manager, ms) -> None:
        self._refresh_transcript_activity(ms)

    def on_transcript_event(self, manager, ms, path: Path) -> None:
        if self.profile.activity.strategy != "jsonl-event" or \
                self.session_id_from_path(path) != ms.record.agent_session_id:
            return
        previous = manager._processing_state(ms)
        self._refresh_transcript_activity(ms)
        title_changed = self._sync_transcript_title(manager, ms)
        if manager._processing_state(ms) != previous or title_changed:
            manager._sync_processing_started(ms)
            manager._broadcast_status(ms)

    def activity_detail(self, ms) -> dict[str, object] | None:
        return {"main": True} if self.is_processing(ms) else None

    def pre_write_input(self, manager, ms, text: str, draft_before: str) -> None:
        super().pre_write_input(manager, ms, text, draft_before)
        if self.profile.activity.strategy != "jsonl-event" or not ms.agent_state:
            return
        if self.interrupt_input in text:
            if ms.agent_state.transcript_active:
                ms.agent_state.transcript_active = False
                manager._sync_processing_started(ms)
                manager._broadcast_status(ms)
            return
        if not ("\r" in text or "\n" in text):
            return
        command = self.submitted_command(text, draft_before)
        if command and not command.startswith("/") and not ms.agent_state.transcript_active:
            ms.agent_state.transcript_active = True
            manager._sync_processing_started(ms)
            manager._broadcast_status(ms)

    def on_api_prompt_submitted(self, manager, ms, queue: bool) -> None:
        if self.profile.activity.strategy == "jsonl-event" and not queue and ms.agent_state:
            ms.agent_state.transcript_active = True
            manager._sync_processing_started(ms)
            manager._broadcast_status(ms)

    def client_descriptor(self) -> dict[str, object]:
        descriptor = super().client_descriptor()
        descriptor["declarative"] = True
        return descriptor

    def _refresh_transcript_activity(self, ms) -> None:
        if self.profile.activity.strategy != "jsonl-event" or not ms.agent_state or \
                not ms.record.agent_session_id:
            return
        path = self.transcript_path(Path(ms.record.cwd), ms.record.agent_session_id)
        active = False
        for payload in reversed(self._tail_payloads(path)):
            raw_value = self._value_at(payload, self.profile.activity.event_path)
            value = str(raw_value).strip().lower() if raw_value is not None else ""
            if value in self.profile.activity.active_values:
                active = True
                break
            if value in self.profile.activity.idle_values:
                break
        ms.agent_state.transcript_active = active

    def _sync_transcript_title(self, manager, ms) -> bool:
        title = self.session_title(manager._tracker, Path(ms.record.cwd), ms.record.agent_session_id)
        if not title or title == manager._display_title(ms.cli_title) and title == ms.record.title:
            return False
        ms.cli_title = title
        ms.title_updated_monotonic = time.monotonic()
        ms.record.title = title
        ms.record.title_user_set = True
        manager._remember_cli_title(ms)
        manager._persist()
        return True

    def _tail_payloads(self, path: Path | None) -> list[dict[str, object]]:
        if path is None:
            return []
        try:
            with path.open("rb") as handle:
                handle.seek(0, 2)
                handle.seek(max(0, handle.tell() - self.TRANSCRIPT_TAIL_BYTES))
                lines = handle.read().decode(errors="replace").splitlines()
        except OSError:
            return []
        return [payload for line in lines if (payload := TurnBuilder.loads(line)) is not None]

    def _payload_role(self, payload: dict[str, object]) -> str:
        transcript = self.profile.transcript
        raw_role = self._value_at(payload, transcript.role_path) if transcript else ""
        return str(raw_role).strip().lower() if raw_role is not None else ""

    def _payload_text(self, payload: dict[str, object]) -> str:
        transcript = self.profile.transcript
        return self._display_text(self._value_at(payload, transcript.content_path)) if transcript else ""

    def _string_at(self, payload: dict[str, object], path: str) -> str:
        value = self._value_at(payload, path)
        return value.strip() if isinstance(value, str) else ""

    @staticmethod
    def _value_at(payload: object, path: str) -> object:
        value = payload
        for part in (item for item in path.split(".") if item):
            if isinstance(value, dict):
                value = value.get(part)
            elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
                value = value[int(part)]
            else:
                return None
        return value

    @classmethod
    def _display_text(cls, value: object) -> str:
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, list):
            return "\n".join(filter(None, (cls._display_text(item) for item in value))).strip()
        if isinstance(value, dict):
            for key in ("text", "content", "message"):
                if key in value:
                    return cls._display_text(value[key])
            return json.dumps(value, ensure_ascii=False)
        return str(value).strip() if value is not None else ""

    @staticmethod
    def _render_arguments(arguments: tuple[str, ...], **values: str) -> tuple[str, ...]:
        rendered = tuple(argument.format_map(values) for argument in arguments)
        return tuple(argument for argument in rendered if argument)
