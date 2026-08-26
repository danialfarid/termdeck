import json
import re
from difflib import SequenceMatcher


class TurnBuilder:
    """Shapes agent transcript payloads into the turn dicts the Markdown view renders.

    Everything here is agent-agnostic; each AgentCli's parse_transcript_lines uses this
    toolkit to express its own on-disk format as turns.
    """

    ROLE_USER = "user"
    ROLE_ASSISTANT = "assistant"
    MAX_TEXT_CHARS = 20000
    MAX_THINKING_ITEM_CHARS = 1800
    MAX_THINKING_BLOCK_CHARS = 9000
    MODEL_NAME_RE = re.compile(r"\b(gpt-[a-z0-9.+-]+(?:-[a-z0-9.+-]+)*(?:\s+x(?:high|medium|low|standard|mini|turbo))?)\b", re.IGNORECASE)
    GENERIC_MODELS = {"codex", "claude", "none", "shell", "bash", "zsh", "sh"}

    @staticmethod
    def loads(line: str) -> dict[str, object] | None:
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            return None
        return value if isinstance(value, dict) else None

    @classmethod
    def turn(cls, role: str, text: str, kind: str = "message", title: str = "", expanded: bool = False,
             model: str | None = None) -> dict[str, object]:
        clean = text.strip()
        if len(clean) > cls.MAX_TEXT_CHARS:
            clean = clean[:cls.MAX_TEXT_CHARS] + "\n… (truncated)"
        turn: dict[str, object] = {"role": role, "text": clean}
        if model:
            turn["model"] = model
        if kind != "message":
            turn.update({"kind": kind, "title": title or kind.title(), "expanded": expanded})
        return turn

    @classmethod
    def tool_event(cls, name: str, value: object, role: str = "event", model: str | None = None) -> dict[str, object]:
        text = cls.format_value(value)
        kind = cls.tool_kind(name, text)
        diff, diff_files = cls.edit_diff_parts(name, value, text) if kind == "edit" else ([], [])
        if kind == "edit" and not diff and name.strip().lower() not in {"edit", "write", "notebookedit", "apply_patch"}:
            kind = "tool"
        title = "Code edit" if kind == "edit" else "Plan" if kind == "plan" else name or "Tool"
        turn = cls.turn(role, text, kind, title, expanded=kind == "edit", model=model)
        if diff:
            # The structured diff is what the Markdown view renders. Keeping
            # the original apply_patch wrapper as well duplicates a large
            # payload in every snapshot without adding visible information.
            turn["text"] = ""
            turn["diff"] = diff
        if diff_files:
            turn["diff_files"] = diff_files
        if kind == "plan":
            plan = cls.extract_plan(value, text)
            if plan:
                turn["plan"] = plan
        return turn

    @classmethod
    def extract_turn_model(
        cls,
        payload: dict[str, object] | list[object],
        seen: set[int] | None = None,
        strict: bool = False,
    ) -> str:
        if seen is None:
            seen = set()
        payload_id = id(payload)
        if payload_id in seen:
            return ""
        seen.add(payload_id)
        if isinstance(payload, dict):
            fallback = ""
            for key in ("model", "model_name", "modelName", "assistant_model", "model_slug", "modelid"):
                raw_value = payload.get(key)
                if not isinstance(raw_value, str):
                    continue
                explicit = cls.extract_gpt_model(raw_value)
                if explicit:
                    return explicit
                value = raw_value.strip().lower()
                if strict:
                    continue
                if not fallback and value and value not in cls.GENERIC_MODELS and value.startswith("gpt-"):
                    fallback = value
                if not fallback and value and value not in cls.GENERIC_MODELS:
                    fallback = value
            preferred = payload.get("payload") or payload.get("message") or payload.get("metadata")
            if isinstance(preferred, (dict, list)):
                model = cls.extract_turn_model(preferred, seen, strict)
                if model:
                    return model
            for value in payload.values():
                if isinstance(value, (dict, list)):
                    model = cls.extract_turn_model(value, seen, strict)
                    if model:
                        return model
            return fallback
        if isinstance(payload, list):
            for item in payload:
                if isinstance(item, (dict, list)):
                    model = cls.extract_turn_model(item, seen, strict)
                    if model:
                        return model
        return ""

    @classmethod
    def extract_gpt_model(cls, value: object) -> str:
        if not isinstance(value, str):
            return ""
        text = value.strip()
        if not text:
            return ""
        match = cls.MODEL_NAME_RE.search(text)
        return match.group(1) if match else ""

    @staticmethod
    def format_value(value: object) -> str:
        if isinstance(value, str):
            return value
        try:
            return json.dumps(value, ensure_ascii=False, indent=2)
        except (TypeError, ValueError):
            return str(value)

    @classmethod
    def format_result_value(cls, value: object) -> str:
        """Render Codex/Claude content blocks as their text, not wrapper JSON."""
        if isinstance(value, dict):
            block_type = value.get("type")
            text = value.get("text")
            if block_type in {"input_text", "output_text", "text"} and isinstance(text, str):
                return text
        if isinstance(value, list):
            text_parts = []
            for item in value:
                if isinstance(item, dict) and item.get("type") in {"input_text", "output_text", "text"}:
                    text = item.get("text")
                    if isinstance(text, str):
                        text_parts.append(text)
                elif isinstance(item, str):
                    text_parts.append(item)
            if text_parts:
                return "\n".join(text_parts)
        return cls.format_value(value)

    @staticmethod
    def tool_kind(name: str, text: str) -> str:
        lowered = f"{name}\n{text}".lower()
        if re.search(r"update_plan|enterplanmode|exitplanmode|taskcreate|taskupdate", lowered):
            return "plan"
        tool_name = name.strip().lower()
        if (
            tool_name in {"edit", "write", "notebookedit", "apply_patch"}
            or "*** begin patch" in lowered and "*** end patch" in lowered
        ):
            return "edit"
        return "tool"

    @classmethod
    def edit_diff_parts(cls, name: str, value: object, text: str) -> tuple[list[dict[str, str]], list[dict[str, object]]]:
        if isinstance(value, dict):
            old = value.get("old_string")
            new = value.get("new_string")
            if isinstance(new, str) and (isinstance(old, str) or name.lower() == "edit"):
                rows = cls.line_diff(old if isinstance(old, str) else "", new)
                path = cls.edit_file_path(value) or "edited file"
                return rows, [{"path": path, "diff": rows}]
            content = value.get("content")
            if isinstance(content, str) and name.lower() in {"write", "create"}:
                rows = cls.line_diff("", content)
                path = cls.edit_file_path(value) or "new file"
                return rows, [{"path": path, "diff": rows}]

        patch = cls.extract_patch(text)
        if not patch:
            return [], []
        files = cls.patch_diff_files(patch)
        return [line for file in files for line in file["diff"]], files

    @staticmethod
    def edit_file_path(value: dict[str, object]) -> str:
        for key in ("file_path", "path", "fileName", "filename", "file"):
            path = value.get(key)
            if isinstance(path, str) and path.strip():
                return path.strip()
        return ""

    @classmethod
    def patch_diff_files(cls, patch: str) -> list[dict[str, object]]:
        files: list[dict[str, object]] = []
        current: dict[str, object] | None = None

        def finish() -> None:
            if current is not None and current["diff"]:
                files.append(current)

        for line in patch.splitlines():
            if line.startswith(("*** Update File:", "*** Add File:", "*** Delete File:")):
                finish()
                current = {"path": line.split(":", 1)[1].strip(), "diff": []}
                continue
            if line.startswith("*** End Patch"):
                finish()
                current = None
                continue
            if line.startswith(("*** Begin Patch", "***", "@@", "+++", "---")):
                continue
            if current is None:
                current = {"path": "edited file", "diff": []}
            rows = current["diff"]
            if line.startswith("+"):
                rows.append({"kind": "add", "prefix": "+", "text": line[1:]})
            elif line.startswith("-"):
                rows.append({"kind": "remove", "prefix": "−", "text": line[1:]})
            elif line.startswith(" "):
                rows.append({"kind": "context", "prefix": " ", "text": line[1:]})
        finish()
        return files

    @staticmethod
    def extract_patch(text: str) -> str:
        marker = text.find("*** Begin Patch")
        if marker < 0:
            return ""
        # Codex commonly wraps an apply_patch payload in a JavaScript string.
        # Decode that string so escaped \n sequences become real diff lines.
        assignment = text.rfind("const patch =", 0, marker)
        if assignment >= 0:
            quote = text.find('"', assignment)
            if quote >= 0:
                try:
                    decoded, _ = json.JSONDecoder().raw_decode(text[quote:])
                    if isinstance(decoded, str) and "*** Begin Patch" in decoded:
                        return decoded
                except (json.JSONDecodeError, TypeError):
                    pass
        return text[marker:].replace("\\n", "\n")

    @staticmethod
    def line_diff(old: str, new: str) -> list[dict[str, str]]:
        old_lines = old.splitlines()
        new_lines = new.splitlines()
        rows: list[dict[str, str]] = []
        matcher = SequenceMatcher(a=old_lines, b=new_lines, autojunk=False)
        for tag, old_start, old_end, new_start, new_end in matcher.get_opcodes():
            if tag == "equal":
                rows.extend({"kind": "context", "prefix": " ", "text": line} for line in old_lines[old_start:old_end])
            elif tag in ("delete", "replace"):
                rows.extend({"kind": "remove", "prefix": "−", "text": line} for line in old_lines[old_start:old_end])
                if tag == "replace":
                    rows.extend({"kind": "add", "prefix": "+", "text": line} for line in new_lines[new_start:new_end])
            elif tag == "insert":
                rows.extend({"kind": "add", "prefix": "+", "text": line} for line in new_lines[new_start:new_end])
        return rows

    @staticmethod
    def extract_plan(value: object, text: str) -> list[dict[str, str]]:
        candidates: object = value.get("plan") if isinstance(value, dict) else None
        if isinstance(candidates, list):
            steps = []
            for item in candidates:
                if isinstance(item, dict) and item.get("step"):
                    steps.append({"step": str(item["step"]), "status": str(item.get("status") or "pending")})
            if steps:
                return steps

        # Codex's update_plan call is often embedded in a JavaScript snippet,
        # so its object keys/strings are not valid JSON. Extract the useful
        # step/status pairs without exposing the implementation wrapper.
        steps = []
        pattern = re.compile(
            r"\{\s*[\"']?(?:step|content)[\"']?\s*:\s*(['\"])(.*?)\1\s*,\s*[\"']?status[\"']?\s*:\s*(['\"])(.*?)\3",
            re.DOTALL,
        )
        for match in pattern.finditer(text):
            steps.append({"step": match.group(2), "status": match.group(4)})
        return steps

    @staticmethod
    def join_text(content: object, text_keys: tuple[str, ...]) -> str:
        if not isinstance(content, list):
            return ""
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") in text_keys:
                parts.append(str(block.get("text", "")))
        return "\n".join(parts)

    @classmethod
    def content_text(cls, value: object) -> str:
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, (int, float, bool)):
            return str(value)
        if isinstance(value, list):
            return "\n".join(text for item in value if (text := cls.content_text(item)))
        if isinstance(value, dict):
            for key in ("text", "content", "message", "input", "output", "result"):
                if key in value:
                    text = cls.content_text(value[key])
                    if text:
                        return text
            return json.dumps(value, ensure_ascii=False)
        return ""

    @classmethod
    def conversation_content_text(cls, value: object) -> str:
        """Only user/assistant prose — thinking and tool blocks excluded."""
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, list):
            parts: list[str] = []
            for item in value:
                if isinstance(item, dict) and item.get("type") in ("thinking", "tool_use", "tool_result"):
                    continue
                text = cls.conversation_content_text(item)
                if text:
                    parts.append(text)
            return "\n".join(parts)
        if isinstance(value, dict):
            item_type = value.get("type")
            if item_type in ("thinking", "tool_use", "tool_result"):
                return ""
            if item_type in ("text", "input_text", "output_text") and "text" in value:
                return cls.conversation_content_text(value["text"])
            for key in ("text", "content", "message"):
                if key in value:
                    text = cls.conversation_content_text(value[key])
                    if text:
                        return text
        return ""

    @classmethod
    def collapse_thinking_events(cls, turns: list[dict[str, object]]) -> list[dict[str, object]]:
        collapsed: list[dict[str, object]] = []
        index = 0
        while index < len(turns):
            turn = turns[index]
            if turn.get("kind") not in {"tool", "result"}:
                collapsed.append(turn)
                index += 1
                continue
            start = index
            raw_items: list[dict[str, str]] = []
            while index < len(turns) and turns[index].get("kind") in {"tool", "result"}:
                item = turns[index]
                raw_items.append({
                    "kind": str(item.get("kind") or "tool"),
                    "title": str(item.get("title") or "Tool"),
                    "text": str(item.get("text") or ""),
                })
                index += 1
            # Keep an unfinished tool at the end inside the thinking block so
            # the next result/tool append can grow and replace that same block
            # instead of creating a second disconnected event.
            if index - start < 2 and index < len(turns):
                collapsed.append(turn)
            else:
                # Keep the newest operation details and cap the block. The
                # full terminal transcript remains available in the terminal;
                # Markdown needs enough detail to inspect operations without
                # embedding megabytes of repeated command output in a live
                # snapshot.
                items: list[dict[str, str]] = []
                used = 0
                for item in reversed(raw_items):
                    text = item["text"]
                    limit = cls.MAX_THINKING_ITEM_CHARS
                    if len(text) > limit:
                        text = text[:400] + "\n… truncated …\n" + text[-(limit - 420):]
                    remaining = cls.MAX_THINKING_BLOCK_CHARS - used
                    if remaining <= 0:
                        break
                    item = dict(item)
                    item["text"] = text[:remaining]
                    items.append(item)
                    used += len(item["text"])
                items.reverse()
                collapsed.append({
                    "role": "event",
                    "text": "",
                    "kind": "thinking",
                    "title": f"Thinking · {len(raw_items)} operations",
                    "expanded": False,
                    "items": items,
                })
        return collapsed
