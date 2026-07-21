import json
import re
from pathlib import Path

from termdeck.config import TermdeckConfig
from termdeck.models import AgentKind


class TranscriptService:
    """Reads an agent session's own on-disk log (codex rollout / claude project jsonl) into a clean conversation
    transcript. This is the complete, durable record — independent of what the CLI's resume redraw restores on
    screen — so the history view can show the full thread even when codex only repaints the last page."""

    CODEX_ROLLOUT_PREFIX = "rollout-"
    JSONL_GLOB = "*.jsonl"
    ROLE_USER = "user"
    ROLE_ASSISTANT = "assistant"
    MAX_TURNS = 4000
    MAX_TEXT_CHARS = 20000

    def transcript_for(self, agent_kind: str, cwd: str, agent_session_id: str | None) -> list[dict[str, str]]:
        if not agent_session_id:
            return []
        kind = AgentKind(agent_kind)
        if kind is AgentKind.CODEX:
            path = self._find_codex_rollout(agent_session_id)
            return self._parse_codex(path) if path else []
        if kind is AgentKind.CLAUDE:
            path = self._claude_project_dir(Path(cwd)) / f"{agent_session_id}.jsonl"
            return self._parse_claude(path) if path.exists() else []
        return []

    def _claude_project_dir(self, cwd: Path) -> Path:
        munged = "".join(ch if ch.isalnum() else "-" for ch in str(cwd))
        return TermdeckConfig.CLAUDE_PROJECTS_DIR / munged

    def _find_codex_rollout(self, agent_session_id: str) -> Path | None:
        needle = f"-{agent_session_id}.jsonl"
        for path in TermdeckConfig.CODEX_SESSIONS_DIR.rglob(f"{self.CODEX_ROLLOUT_PREFIX}*{needle}"):
            return path
        return None

    def _turn(self, role: str, text: str, kind: str = "message", title: str = "", expanded: bool = False) -> dict[str, object]:
        clean = text.strip()
        if len(clean) > self.MAX_TEXT_CHARS:
            clean = clean[:self.MAX_TEXT_CHARS] + "\n… (truncated)"
        turn: dict[str, object] = {"role": role, "text": clean}
        if kind != "message":
            turn.update({"kind": kind, "title": title or kind.title(), "expanded": expanded})
        return turn

    def _tool_event(self, name: str, value: object, role: str = "event") -> dict[str, object]:
        text = self._format_value(value)
        kind = self._tool_kind(name, text)
        title = "Code edit" if kind == "edit" else "Plan" if kind == "plan" else name or "Tool"
        return self._turn(role, text, kind, title, expanded=kind == "edit")

    @staticmethod
    def _format_value(value: object) -> str:
        if isinstance(value, str):
            return value
        try:
            return json.dumps(value, ensure_ascii=False, indent=2)
        except (TypeError, ValueError):
            return str(value)

    @staticmethod
    def _tool_kind(name: str, text: str) -> str:
        lowered = f"{name}\n{text}".lower()
        if re.search(r"update_plan|enterplanmode|exitplanmode|taskcreate|taskupdate", lowered):
            return "plan"
        if re.search(r"apply_patch|old_string|new_string|notebookedit|\b(edit|write)\b", lowered):
            return "edit"
        return "tool"

    @staticmethod
    def _tool_call_id(payload: dict[str, object]) -> str:
        return str(payload.get("call_id") or payload.get("id") or "")

    def _parse_codex(self, path: Path) -> list[dict[str, object]]:
        turns: list[dict[str, object]] = []
        for line in path.read_text(errors="replace").splitlines():
            payload = self._loads(line)
            if payload is None:
                continue
            entry_type = payload.get("type")
            raw_body = payload.get("payload")
            body: dict[str, object] = raw_body if isinstance(raw_body, dict) else {}
            body_type = body.get("type")
            if entry_type == "event_msg" and body_type == "agent_message":
                turns.append(self._turn(self.ROLE_ASSISTANT, str(body.get("message", ""))))
            elif entry_type == "response_item" and body_type == "message" and body.get("role") == "user":
                text = self._join_text(body.get("content"), ("input_text", "text"))
                if text and not self._is_codex_boilerplate(text):
                    turns.append(self._turn(self.ROLE_USER, text))
            elif entry_type == "response_item" and body_type in ("custom_tool_call", "function_call"):
                name = str(body.get("name") or "tool")
                value = body.get("input") if body_type == "custom_tool_call" else body.get("arguments", "")
                turns.append(self._tool_event(name, value))
            elif entry_type == "response_item" and body_type in ("custom_tool_call_output", "function_call_output"):
                output = body.get("output", body.get("result", ""))
                turns.append(self._turn("event", self._format_value(output), "result", "Result"))
            if len(turns) >= self.MAX_TURNS:
                break
        return turns

    @staticmethod
    def _is_codex_boilerplate(text: str) -> bool:
        head = text.lstrip()[:40]
        return head.startswith("# AGENTS.md") or head.startswith("<INSTRUCTIONS>") or head.startswith("<environment_context>")

    def _parse_claude(self, path: Path) -> list[dict[str, object]]:
        turns: list[dict[str, object]] = []
        for line in path.read_text(errors="replace").splitlines():
            payload = self._loads(line)
            if payload is None or payload.get("type") not in (self.ROLE_USER, self.ROLE_ASSISTANT):
                continue
            message = payload.get("message")
            if not isinstance(message, dict):
                continue
            role = str(payload["type"])
            content = message.get("content")
            if isinstance(content, str):
                if content.strip():
                    turns.append(self._turn(role, content))
            elif isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    block_type = block.get("type")
                    if block_type == "text" and str(block.get("text", "")).strip():
                        turns.append(self._turn(role, str(block.get("text", ""))))
                    elif block_type == "tool_use":
                        turns.append(self._tool_event(str(block.get("name", "tool")), block.get("input", {})))
                    elif block_type == "tool_result":
                        result = block.get("content", block.get("output", ""))
                        turns.append(self._turn("event", self._format_value(result), "result", "Result"))
            if len(turns) >= self.MAX_TURNS:
                break
        return turns

    @staticmethod
    def _join_text(content: object, text_keys: tuple[str, ...]) -> str:
        if not isinstance(content, list):
            return ""
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") in text_keys:
                parts.append(str(block.get("text", "")))
        return "\n".join(parts)

    @staticmethod
    def _loads(line: str) -> dict[str, object] | None:
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            return None
        return value if isinstance(value, dict) else None
