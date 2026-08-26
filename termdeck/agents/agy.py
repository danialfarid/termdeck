import shlex
from pathlib import Path
from typing import Iterable

from termdeck.agents.base import UUID_RE, AgentCli
from termdeck.config import TermdeckConfig
from termdeck.transcript_turns import TurnBuilder


class AgyCli(AgentCli):
    kind = "agy"
    executable = "agy"
    label = "AGY"
    model_aliases = ("agd", "agy-cli", "agycli", "gemini", "antigravity", "antigravity-cli", "antigravitycli")

    # Restarted terminals resume via --conversation; attaching to an EXISTING agy session from
    # the create dialog is unsupported (new_session_resume_arguments raises), as is forking.
    supports_resume = True

    permission_flags = {
        "default": (),
        "full-access": ("--dangerously-skip-permissions",),
    }
    ui_permissions = ("default", "full-access")
    permission_switch_flags = ("--dangerously-skip-permissions",)

    def resume_command(self, original_command: str, agent_session_id: str) -> str:
        cleaned = self.strip_session_arguments(self.command_parts(original_command))
        if not cleaned:
            cleaned = [self.executable]
        cleaned.extend((TermdeckConfig.AGY_CONVERSATION_FLAG, agent_session_id))
        return shlex.join(cleaned)

    def strip_session_arguments(self, parts: list[str]) -> list[str]:
        cleaned: list[str] = []
        skip_next = False
        for token in parts:
            if skip_next:
                skip_next = False
                continue
            if token == TermdeckConfig.AGY_CONVERSATION_FLAG:
                skip_next = True
                continue
            if token.startswith(f"{TermdeckConfig.AGY_CONVERSATION_FLAG}=") or token in {"-c", "--continue"}:
                continue
            cleaned.append(token)
        return cleaned

    @staticmethod
    def session_dir(agent_session_id: str) -> Path:
        return TermdeckConfig.AGY_SESSIONS_DIR / agent_session_id

    def transcript_path(self, cwd: Path | None, agent_session_id: str) -> Path | None:
        directory = self.session_dir(agent_session_id) / ".system_generated" / "logs"
        full_transcript = directory / "transcript_full.jsonl"
        live_transcript = directory / "transcript.jsonl"
        if full_transcript.is_file():
            return full_transcript
        return live_transcript if live_transcript.is_file() else None

    def candidate_session_files(self, cwd: Path) -> list[tuple[Path, str]]:
        if not TermdeckConfig.AGY_SESSIONS_DIR.is_dir():
            return []
        pairs: list[tuple[Path, str]] = []
        for entry in TermdeckConfig.AGY_SESSIONS_DIR.iterdir():
            if not entry.is_dir() or not UUID_RE.fullmatch(entry.name):
                continue
            path = self.transcript_path(cwd, entry.name)
            if path is not None:
                pairs.append((path, entry.name))
        return pairs

    def owns_transcript_path(self, path: Path) -> bool:
        root = TermdeckConfig.AGY_SESSIONS_DIR
        return path.is_relative_to(root) or path.is_relative_to(root.resolve())

    def session_id_from_path(self, path: Path) -> str | None:
        for root in (TermdeckConfig.AGY_SESSIONS_DIR, TermdeckConfig.AGY_SESSIONS_DIR.resolve()):
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
