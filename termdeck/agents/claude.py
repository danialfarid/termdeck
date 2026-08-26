import shlex
from pathlib import Path
from typing import Iterable

from termdeck.agents.base import UUID_RE, AgentCli
from termdeck.config import TermdeckConfig
from termdeck.transcript_turns import TurnBuilder


class ClaudeCli(AgentCli):
    kind = "claude"
    executable = "claude"
    label = "Claude"

    supports_resume = True
    supports_fork = True
    fork_tracks_parent = True
    canonical_resume_command = True
    records_raw_replay = True

    permission_flags = {
        "default": (),
        "accept-edits": ("--permission-mode", "acceptEdits"),
        "acceptedits": ("--permission-mode", "acceptEdits"),
        "auto": ("--permission-mode", "auto"),
        "full-access": ("--dangerously-skip-permissions",),
        "bypasspermissions": ("--dangerously-skip-permissions",),
        "manual": ("--permission-mode", "manual"),
        "dontask": ("--permission-mode", "dontAsk"),
        "dont-ask": ("--permission-mode", "dontAsk"),
        "plan": ("--permission-mode", "plan"),
    }
    ui_permission_options = (("default", "Default (Claude config)"), ("accept-edits", "Accept edits"),
                             ("auto", "Auto"), ("full-access", "Full access"))
    permission_switch_flags = ("--dangerously-skip-permissions",)
    permission_value_flags = ("--permission-mode",)

    prompt_marker = "❯"

    subagent_file_marker = b'"isSidechain":true'

    def new_session_resume_arguments(self, session_ref: str, tracker) -> tuple[str, ...]:
        return (TermdeckConfig.CLAUDE_RESUME_FLAG, session_ref)

    def project_dir(self, cwd: Path) -> Path:
        munged = "".join(ch if ch.isalnum() else "-" for ch in str(cwd))
        return TermdeckConfig.CLAUDE_PROJECTS_DIR / munged

    def transcript_path(self, cwd: Path | None, agent_session_id: str) -> Path | None:
        if cwd is None:
            return None
        path = self.project_dir(cwd) / f"{agent_session_id}.jsonl"
        return path if path.exists() else None

    def candidate_session_files(self, cwd: Path) -> list[tuple[Path, str]]:
        project_dir = self.project_dir(cwd)
        if not project_dir.is_dir():
            return []
        return [(path, path.stem) for path in project_dir.glob("*.jsonl") if UUID_RE.match(path.stem)]

    def owns_transcript_path(self, path: Path) -> bool:
        root = TermdeckConfig.CLAUDE_PROJECTS_DIR
        return path.is_relative_to(root) or path.is_relative_to(root.resolve())

    def session_id_from_path(self, path: Path) -> str | None:
        if not self.owns_transcript_path(path):
            return None
        return path.stem if UUID_RE.match(path.stem) else None

    def parse_transcript_lines(self, lines: Iterable[str]) -> list[dict[str, object]]:
        turns: list[dict[str, object]] = []
        for line in lines:
            payload = TurnBuilder.loads(line)
            if payload is None or payload.get("type") not in (TurnBuilder.ROLE_USER, TurnBuilder.ROLE_ASSISTANT):
                continue
            message = payload.get("message")
            if not isinstance(message, dict):
                continue
            role = str(payload["type"])
            content = message.get("content")
            model = TurnBuilder.extract_turn_model(payload) or TurnBuilder.extract_turn_model(message)
            if isinstance(content, str):
                normalized_content = self._normalize_user_text(role, content)
                if normalized_content.strip():
                    turns.append(TurnBuilder.turn(role, normalized_content, model=model))
            elif isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    block_type = block.get("type")
                    if block_type == "text":
                        text = self._normalize_user_text(role, str(block.get("text", "")))
                        if text.strip():
                            turns.append(TurnBuilder.turn(role, text, model=model))
                    elif block_type == "tool_use":
                        turns.append(TurnBuilder.tool_event(str(block.get("name", "tool")), block.get("input", {}), model=model))
                    elif block_type == "tool_result":
                        result = block.get("content", block.get("output", ""))
                        turns.append(TurnBuilder.turn("event", TurnBuilder.format_result_value(result), "result", "Result", model=model))
        return turns

    @staticmethod
    def _normalize_user_text(role: str, text: str) -> str:
        # A queued prompt replayed into the composer starts with NAK; the transcript keeps it.
        return text.lstrip("\x15") if role == TurnBuilder.ROLE_USER else text

    def is_user_payload(self, payload: dict[str, object]) -> bool:
        return payload.get("type") == "user"

    def payload_text(self, payload: dict[str, object]) -> str:
        if payload.get("type") in ("user", "assistant"):
            message = payload.get("message")
            return TurnBuilder.content_text(message.get("content")) if isinstance(message, dict) else ""
        if payload.get("type") in ("tool_use", "tool_result"):
            return TurnBuilder.content_text(payload.get("input") or payload.get("content"))
        return ""

    def conversation_payload_text(self, payload: dict[str, object]) -> str:
        if payload.get("type") in ("user", "assistant"):
            message = payload.get("message")
            return TurnBuilder.conversation_content_text(message.get("content") if isinstance(message, dict) else message)
        return ""

    def is_conversation_payload(self, payload: dict[str, object]) -> bool:
        return payload.get("type") in ("user", "assistant")

    def title_from_payload(self, payload: dict[str, object]) -> str:
        return str(payload.get("aiTitle", "")) if payload.get("type") == "ai-title" else ""

    def resume_command(self, original_command: str, agent_session_id: str) -> str:
        cleaned = self.strip_flag_with_value(self.command_parts(original_command),
                                             TermdeckConfig.CLAUDE_RESUME_FLAG)
        if not cleaned:
            cleaned = [self.executable]
        return f"{shlex.join(cleaned)} {TermdeckConfig.CLAUDE_RESUME_FLAG} {agent_session_id}"

    def fork_command(self, original_command: str, agent_session_id: str, session_name: str = "") -> str:
        cleaned = self.strip_flag_with_value(self.command_parts(original_command),
                                             TermdeckConfig.CLAUDE_RESUME_FLAG)
        cleaned = self.strip_flag_with_value(cleaned, TermdeckConfig.CLAUDE_NAME_FLAG)
        if not cleaned:
            cleaned = [self.executable]
        cleaned.extend((TermdeckConfig.CLAUDE_RESUME_FLAG, agent_session_id, TermdeckConfig.CLAUDE_FORK_FLAG))
        if session_name.strip():
            cleaned.extend((TermdeckConfig.CLAUDE_NAME_FLAG, " ".join(session_name.splitlines()).strip()))
        return shlex.join(cleaned)
