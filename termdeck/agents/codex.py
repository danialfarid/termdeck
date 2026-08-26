import re
import shlex
from datetime import timedelta
from pathlib import Path
from typing import Iterable

from termdeck.agents.base import AgentCli
from termdeck.config import TermdeckConfig
from termdeck.transcript_turns import TurnBuilder
from termdeck.util import TimeUtil


class CodexCli(AgentCli):
    kind = "codex"
    executable = "codex"
    label = "Codex"

    supports_resume = True
    supports_fork = True
    canonical_resume_command = True
    records_raw_replay = True
    has_prompt_queue = True

    base_flags = (TermdeckConfig.CODEX_NO_ALT_SCREEN_FLAG,)
    permission_flags = {
        "default": (),
        "read-only": ("--sandbox", "read-only"),
        "workspace-write": ("--sandbox", "workspace-write"),
        "full-access": ("--dangerously-bypass-approvals-and-sandbox",),
    }
    ui_permission_options = (("default", "Default (Codex config)"), ("read-only", "Read only"),
                             ("workspace-write", "Workspace write"), ("full-access", "Full access"))
    permission_switch_flags = ("--dangerously-bypass-approvals-and-sandbox",)
    permission_value_flags = ("--sandbox",)

    prompt_marker = "›"

    REASONING_EFFORTS = frozenset({"low", "medium", "high", "xhigh"})
    ROLLOUT_UUID_RE = re.compile(
        r"rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$")
    subagent_file_marker = b'"source":{"subagent"'

    def __init__(self) -> None:
        # A rollout path never changes once the session exists; cache the rglob hit.
        self._rollout_paths: dict[str, Path] = {}

    def model_arguments(self, model_name: str) -> tuple[str, ...]:
        # A trailing reasoning-effort word ("gpt-5.6-luna xhigh") becomes a -c override.
        parts = model_name.split()
        arguments: list[str] = []
        if len(parts) > 1 and parts[-1].lower() in self.REASONING_EFFORTS:
            arguments.extend(("-c", f'model_reasoning_effort="{parts[-1].lower()}"'))
            model_name = " ".join(parts[:-1])
        arguments.extend(("--model", model_name))
        return tuple(arguments)

    def new_session_resume_arguments(self, session_ref: str, tracker) -> tuple[str, ...]:
        resolved = tracker.codex_session_id_for_reference(session_ref)
        if resolved is None:
            raise ValueError(f"no saved Codex session found with ID or name: {session_ref}")
        return ("resume", resolved)

    def resume_command(self, original_command: str, agent_session_id: str) -> str:
        parts = self.command_parts(original_command)
        if not parts:
            return f"{self.executable} {TermdeckConfig.CODEX_NO_ALT_SCREEN_FLAG} resume {agent_session_id}"
        cleaned = self._ensure_searchable_scrollback(self.strip_session_arguments(parts))
        return f"{shlex.join(cleaned)} resume {agent_session_id}"

    def fork_command(self, original_command: str, agent_session_id: str, session_name: str = "") -> str:
        parts = self.command_parts(original_command)
        cleaned = self.strip_session_arguments(parts) if parts else [self.executable]
        cleaned = self._ensure_searchable_scrollback(cleaned)
        cleaned.extend(("fork", agent_session_id))
        return shlex.join(cleaned)

    def strip_session_arguments(self, parts: list[str]) -> list[str]:
        cleaned: list[str] = []
        command_seen = False
        skip_session_id = False
        for token in parts:
            if skip_session_id:
                skip_session_id = False
                continue
            if not command_seen:
                cleaned.append(token)
                command_seen = Path(token).name == self.executable
                continue
            if token in {"fork", "resume"}:
                skip_session_id = True
                continue
            cleaned.append(token)
        return cleaned

    def transcript_path(self, cwd: Path | None, agent_session_id: str) -> Path | None:
        cached = self._rollout_paths.get(agent_session_id)
        if cached is not None and cached.exists():
            return cached
        try:
            for path in TermdeckConfig.CODEX_SESSIONS_DIR.rglob(f"rollout-*-{agent_session_id}.jsonl"):
                self._rollout_paths[agent_session_id] = path
                return path
        except OSError:
            return None
        return None

    def candidate_session_files(self, cwd: Path) -> list[tuple[Path, str]]:
        pairs: list[tuple[Path, str]] = []
        for day_dir in self._recent_day_dirs():
            if not day_dir.is_dir():
                continue
            for path in day_dir.glob("*.jsonl"):
                match = self.ROLLOUT_UUID_RE.search(path.name)
                if match:
                    pairs.append((path, match.group(1)))
        return pairs

    @staticmethod
    def _recent_day_dirs() -> list[Path]:
        today = TimeUtil.today_est()
        days = [today + timedelta(days=offset) for offset in TermdeckConfig.CODEX_DAY_DIR_LOOKAROUND_DAYS]
        return [TermdeckConfig.CODEX_SESSIONS_DIR / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}"
                for day in days]

    def owns_transcript_path(self, path: Path) -> bool:
        root = TermdeckConfig.CODEX_SESSIONS_DIR
        return path.is_relative_to(root) or path.is_relative_to(root.resolve())

    def session_id_from_path(self, path: Path) -> str | None:
        if not self.owns_transcript_path(path):
            return None
        match = self.ROLLOUT_UUID_RE.search(path.name)
        return match.group(1) if match else None

    def parse_transcript_lines(self, lines: Iterable[str]) -> list[dict[str, object]]:
        turns: list[dict[str, object]] = []
        current_model = ""
        for line in lines:
            payload = TurnBuilder.loads(line)
            if payload is None:
                continue
            entry_type = payload.get("type")
            raw_body = payload.get("payload")
            body: dict[str, object] = raw_body if isinstance(raw_body, dict) else {}
            body_type = body.get("type")
            model = TurnBuilder.extract_turn_model(payload)
            if not model:
                model = TurnBuilder.extract_turn_model(body)
            if model:
                current_model = model
            model = current_model
            if entry_type == "event_msg" and body_type == "agent_message":
                candidate = TurnBuilder.turn(TurnBuilder.ROLE_ASSISTANT, str(body.get("message", "")), model=model)
                phase = str(body.get("phase", ""))
                if phase:
                    candidate["phase"] = phase
                    candidate["final"] = phase == "final_answer"
                self._append_message_turn(turns, candidate)
            elif entry_type == "event_msg" and body_type == "item_completed":
                item = body.get("item")
                if isinstance(item, dict) and item.get("type") == "AgentMessage":
                    text = TurnBuilder.join_text(item.get("content"), ("Text", "text", "output_text"))
                    candidate = TurnBuilder.turn(TurnBuilder.ROLE_ASSISTANT, text, model=model)
                    phase = str(item.get("phase", ""))
                    if phase:
                        candidate["phase"] = phase
                        candidate["final"] = phase == "final_answer"
                    self._append_message_turn(turns, candidate)
            elif entry_type == "response_item" and body_type == "message" and body.get("role") in ("user", "assistant"):
                text_keys = ("input_text", "text") if body.get("role") == "user" else ("output_text", "text")
                text = TurnBuilder.join_text(body.get("content"), text_keys)
                if text and not self._is_boilerplate(text):
                    candidate = TurnBuilder.turn(str(body["role"]), text, model=model)
                    if body.get("role") == "assistant":
                        phase = str(body.get("phase", ""))
                        if phase:
                            candidate["phase"] = phase
                            candidate["final"] = phase == "final_answer"
                        self._append_message_turn(turns, candidate)
                    elif not turns or turns[-1] != candidate:
                        turns.append(candidate)
            elif entry_type == "response_item" and body_type in ("custom_tool_call", "function_call"):
                name = str(body.get("name") or "tool")
                value = body.get("input") if body_type == "custom_tool_call" else body.get("arguments", "")
                turns.append(TurnBuilder.tool_event(name, value, model=model))
            elif entry_type == "response_item" and body_type in ("custom_tool_call_output", "function_call_output"):
                output = body.get("output", body.get("result", ""))
                turns.append(TurnBuilder.turn("event", TurnBuilder.format_result_value(output), "result", "Result", model=model))
        return turns

    @staticmethod
    def _append_message_turn(turns: list[dict[str, object]], candidate: dict[str, object]) -> None:
        if not candidate["text"]:
            return
        if turns and turns[-1].get("role") == candidate.get("role") and turns[-1].get("text") == candidate.get("text"):
            turns[-1] = candidate
            return
        turns.append(candidate)

    @staticmethod
    def _is_boilerplate(text: str) -> bool:
        head = text.lstrip()[:40]
        return head.startswith("# AGENTS.md") or head.startswith("<INSTRUCTIONS>") or head.startswith("<environment_context>")

    def is_user_payload(self, payload: dict[str, object]) -> bool:
        body = payload.get("payload")
        return isinstance(body, dict) and (
            (body.get("type") == "message" and body.get("role") == "user") or body.get("type") == "user_message"
        )

    def payload_text(self, payload: dict[str, object]) -> str:
        body = payload.get("payload")
        if not isinstance(body, dict):
            return ""
        body_type = body.get("type")
        if body_type == "agent_message":
            return str(body.get("message", ""))
        if body_type == "user_message":
            return TurnBuilder.content_text(body.get("message") or body.get("text"))
        if body_type == "message":
            return TurnBuilder.content_text(body.get("content"))
        if body_type in ("custom_tool_call", "function_call"):
            return TurnBuilder.content_text(body.get("input") or body.get("arguments"))
        if body_type in ("custom_tool_call_output", "function_call_output"):
            return TurnBuilder.content_text(body.get("output") or body.get("result"))
        return ""

    def conversation_payload_text(self, payload: dict[str, object]) -> str:
        body = payload.get("payload")
        if not isinstance(body, dict):
            return ""
        body_type = body.get("type")
        if body_type == "agent_message":
            return TurnBuilder.conversation_content_text(body.get("message"))
        if body_type == "user_message":
            return TurnBuilder.conversation_content_text(body.get("message") or body.get("text"))
        if body_type == "message" and body.get("role") in ("user", "assistant"):
            return TurnBuilder.conversation_content_text(body.get("content"))
        return ""

    def is_conversation_payload(self, payload: dict[str, object]) -> bool:
        body = payload.get("payload")
        if not isinstance(body, dict):
            return False
        body_type = body.get("type")
        return body_type in ("agent_message", "user_message") or (
            body_type == "message" and body.get("role") in ("user", "assistant")
        )

    def title_from_payload(self, payload: dict[str, object]) -> str:
        body = payload.get("payload")
        return str(body.get("thread_name", "")) if isinstance(body, dict) and body.get("type") == "thread_name_updated" else ""

    def cwd_from_payload(self, path: Path, payload: dict[str, object]) -> str:
        body = payload.get("payload")
        return str(body.get("cwd", "")) if isinstance(body, dict) else ""

    def _ensure_searchable_scrollback(self, parts: list[str]) -> list[str]:
        # The alternate screen keeps output out of scrollback; TermDeck needs it searchable.
        if TermdeckConfig.CODEX_NO_ALT_SCREEN_FLAG in parts:
            return parts
        command_index = next((index for index, token in enumerate(parts)
                              if Path(token).name == self.executable), None)
        if command_index is None:
            return parts
        return [*parts[:command_index + 1], TermdeckConfig.CODEX_NO_ALT_SCREEN_FLAG, *parts[command_index + 1:]]
