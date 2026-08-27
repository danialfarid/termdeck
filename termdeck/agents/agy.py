import shlex
import time
from pathlib import Path
from typing import Iterable

from termdeck.agents.base import UUID_RE, AgentCli, AgentSessionState
from termdeck.config import TermdeckConfig
from termdeck.transcript_turns import TurnBuilder


class AgySessionState(AgentSessionState):
    def __init__(self) -> None:
        self.transcript_active = False
        self.transcript_active_until = 0.0


class AgyCli(AgentCli):
    kind = "agy"
    executable = "agy"
    label = "AGY"

    sessions_root = Path.home() / ".gemini" / "antigravity-cli" / "brain"
    CONVERSATION_FLAG = "--conversation"
    ACTIVITY_KEEPALIVE_SECONDS = 20.0
    RESTART_REPAINT_DELAY_SECONDS = 0.35
    # "gemini" stays an antigravity alias: Google's gemini-cli refuses sign-in on this account
    # ("migrate to the Antigravity suite"), so the model field keeps meaning the working CLI.
    # The GeminiCli adapter is reached by running `gemini` directly or via model "gemini-cli".
    model_aliases = ("agd", "agy-cli", "agycli", "gemini", "antigravity", "antigravity-cli", "antigravitycli")

    # Restarted terminals resume via --conversation; attaching to an EXISTING agy session from
    # the create dialog is unsupported (new_session_resume_arguments raises), as is forking.
    supports_resume = True
    detection_claims_new_files = True

    permission_flags = {
        "default": (),
        "full-access": ("--dangerously-skip-permissions",),
    }
    ui_permission_options = (("default", "Default"), ("full-access", "Full access"))
    permission_switch_flags = ("--dangerously-skip-permissions",)

    def resume_command(self, original_command: str, agent_session_id: str) -> str:
        cleaned = self.strip_session_arguments(self.command_parts(original_command))
        if not cleaned:
            cleaned = [self.executable]
        cleaned.extend((self.CONVERSATION_FLAG, agent_session_id))
        return shlex.join(cleaned)

    def strip_session_arguments(self, parts: list[str]) -> list[str]:
        cleaned: list[str] = []
        skip_next = False
        for token in parts:
            if skip_next:
                skip_next = False
                continue
            if token == self.CONVERSATION_FLAG:
                skip_next = True
                continue
            if token.startswith(f"{self.CONVERSATION_FLAG}=") or token in {"-c", "--continue"}:
                continue
            cleaned.append(token)
        return cleaned

    @staticmethod
    def session_dir(agent_session_id: str) -> Path:
        return AgyCli.sessions_root / agent_session_id

    def transcript_path(self, cwd: Path | None, agent_session_id: str) -> Path | None:
        directory = self.session_dir(agent_session_id) / ".system_generated" / "logs"
        full_transcript = directory / "transcript_full.jsonl"
        live_transcript = directory / "transcript.jsonl"
        if full_transcript.is_file():
            return full_transcript
        return live_transcript if live_transcript.is_file() else None

    def candidate_session_files(self, cwd: Path) -> list[tuple[Path, str]]:
        if not AgyCli.sessions_root.is_dir():
            return []
        pairs: list[tuple[Path, str]] = []
        for entry in AgyCli.sessions_root.iterdir():
            if not entry.is_dir() or not UUID_RE.fullmatch(entry.name):
                continue
            path = self.transcript_path(cwd, entry.name)
            if path is not None:
                pairs.append((path, entry.name))
        return pairs

    def owns_transcript_path(self, path: Path) -> bool:
        root = AgyCli.sessions_root
        return path.is_relative_to(root) or path.is_relative_to(root.resolve())

    def session_id_from_path(self, path: Path) -> str | None:
        for root in (AgyCli.sessions_root, AgyCli.sessions_root.resolve()):
            try:
                relative = path.relative_to(root)
            except ValueError:
                continue
            if not relative.parts:
                return None
            session_id = relative.parts[0]
            return session_id if UUID_RE.fullmatch(session_id) else None
        return None

    def parse_transcript_lines(self, lines: Iterable[str]) -> list[dict[str, object]]:
        turns: list[dict[str, object]] = []
        for line in lines:
            payload = TurnBuilder.loads(line)
            if payload is None:
                continue
            event_type = str(payload.get("type") or "")
            content = payload.get("content")
            tool_calls = payload.get("tool_calls")
            model = TurnBuilder.extract_turn_model(payload)
            if self.is_user_payload(payload) and isinstance(content, str):
                text = self._wrap_text(content)
                if text:
                    turns.append(TurnBuilder.turn(TurnBuilder.ROLE_USER, text, model=model))
                continue
            if isinstance(tool_calls, list) and tool_calls:
                for call in tool_calls:
                    if isinstance(call, dict):
                        name = str(call.get("name") or "tool")
                        arguments = call.get("arguments", call.get("input", ""))
                    else:
                        name = str(call)
                        arguments = {}
                    turns.append(TurnBuilder.tool_event(name, arguments, role="event", model=model))
                continue
            thinking = payload.get("thinking")
            if isinstance(thinking, str) and thinking.strip():
                turns.append(TurnBuilder.turn("event", self._wrap_text(thinking), "thinking",
                                              f"{self._turn_title(event_type)} Thinking", model=model))
            if isinstance(content, str):
                text = self._wrap_text(content)
                if not text:
                    continue
                if event_type in {"CONVERSATION_HISTORY", "CHECKPOINT", "SYSTEM"}:
                    turns.append(TurnBuilder.turn("event", text, kind="result", title=self._turn_title(event_type), model=model))
                else:
                    turns.append(TurnBuilder.turn(TurnBuilder.ROLE_ASSISTANT, text, model=model))
            elif thinking:
                turns.append(TurnBuilder.turn("event", "", kind="result", title=self._turn_title(event_type), model=model))
        return TurnBuilder.collapse_thinking_events(turns)

    def is_user_payload(self, payload: dict[str, object]) -> bool:
        return payload.get("type") == "USER_INPUT" or str(payload.get("source") or "") == "USER_EXPLICIT"

    @staticmethod
    def _wrap_text(text: str) -> str:
        wrapped = text.strip()
        if not wrapped.startswith(("<USER_REQUEST>", "<AGENT_RESPONSE>")):
            return wrapped
        end = wrapped.find(">", 0)
        if end < 0:
            return wrapped
        return wrapped[end + 1:].strip()

    @staticmethod
    def _turn_title(event_type: str) -> str:
        return event_type.replace("_", " ").title()

    # -- activity / processing ---------------------------------------------

    def new_session_state(self) -> AgySessionState:
        return AgySessionState()

    def is_processing(self, ms) -> bool:
        return bool(ms.processing or ms.agent_state.transcript_active)

    def refresh_persisted_activity(self, manager, ms) -> None:
        ms.agent_state.transcript_active = manager._tracker.agy_session_is_active(ms.record.agent_session_id)
        if ms.agent_state.transcript_active:
            ms.agent_state.transcript_active_until = time.monotonic() + self.ACTIVITY_KEEPALIVE_SECONDS

    def refresh_transcript_activity(self, ms, active: bool, observed_at: float | None = None) -> None:
        now = time.monotonic() if observed_at is None else observed_at
        if active:
            ms.agent_state.transcript_active = True
            ms.agent_state.transcript_active_until = now + self.ACTIVITY_KEEPALIVE_SECONDS
            return
        if ms.agent_state.transcript_active and now < ms.agent_state.transcript_active_until:
            ms.agent_state.transcript_active_until = now + self.ACTIVITY_KEEPALIVE_SECONDS
            return
        ms.agent_state.transcript_active = False
        ms.agent_state.transcript_active_until = 0.0

    def refresh_activity_for_status(self, manager, ms) -> None:
        if not ms.agent_state.transcript_active:
            return
        if time.monotonic() < ms.agent_state.transcript_active_until:
            return
        ms.agent_state.transcript_active = False
        ms.agent_state.transcript_active_until = 0.0

    def on_transcript_event(self, manager, ms, path: Path) -> None:
        if self.session_id_from_path(path) != ms.record.agent_session_id:
            return
        previous = manager._processing_state(ms)
        active = manager._tracker._agy_session_is_active(path)
        self.refresh_transcript_activity(ms, active, time.monotonic())
        if manager._processing_state(ms) != previous:
            manager._broadcast_status(ms)

    def reconcile_metadata(self, manager, ms) -> None:
        # AGY session-id detection commonly outlasts the startup window; retry it for a
        # detached-live terminal that still has no binding.
        if not ms.detached_live or ms.record.agent_session_id:
            return
        ms.detect_kind = self.kind
        ms.detect_baseline = manager._tracker.snapshot_session_files(self.kind, Path(ms.record.cwd))
        manager._schedule_detection(ms, TermdeckConfig.AGENT_DETECT_INITIAL_DELAY_SECONDS)

    def pre_write_input(self, manager, ms, text: str, draft_before: str) -> None:
        if "\r" in text or "\n" in text:
            self.refresh_transcript_activity(ms, True)

    def post_write_input(self, manager, ms, text: str) -> None:
        if "\r" in text or "\n" in text:
            manager._broadcast_status(ms)

    def restart_screen_repaint_delay(self, raw_replay_enabled: bool) -> float | None:
        return self.RESTART_REPAINT_DELAY_SECONDS

    def detection_should_retry(self, ms) -> bool:
        return ms.detect_attempts < 20

    def on_agent_session_bound(self, manager, ms) -> None:
        ms.agent_state.transcript_active = manager._tracker.agy_session_is_active(ms.record.agent_session_id)
