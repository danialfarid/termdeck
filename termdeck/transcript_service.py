import asyncio
import datetime as dt
import json
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer
try:
    from watchdog.observers.kqueue import KqueueObserver
except ImportError:  # pragma: no cover - unavailable outside macOS
    KqueueObserver = None

from termdeck.config import TermdeckConfig
from termdeck.models import AgentKind


@dataclass
class _TranscriptState:
    path: Path
    agent_kind: AgentKind
    raw_turns: list[dict[str, object]] = field(default_factory=list)
    turns: list[dict[str, object]] = field(default_factory=list)
    offset: int = 0
    carry: bytes = b""
    inode: int | None = None
    revision: int = 0
    update_log: list[dict[str, object]] = field(default_factory=list)
    last_user_at: float | None = None


class _TranscriptFileHandler(FileSystemEventHandler):
    def __init__(self, callback):
        super().__init__()
        self._callback = callback

    def _emit(self, path: str) -> None:
        candidate = Path(path)
        if candidate.suffix == ".jsonl":
            self._callback(candidate)

    def on_created(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._emit(event.src_path)

    def on_modified(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._emit(event.src_path)

    def on_deleted(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._emit(event.src_path)

    def on_moved(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._emit(event.src_path)
            self._emit(event.dest_path)


class TranscriptService:
    """Reads an agent session's own on-disk log (codex rollout / claude project jsonl) into a clean conversation
    transcript. This is the complete, durable record — independent of what the CLI's resume redraw restores on
    screen — so the history view can show the full thread even when codex only repaints the last page."""

    CODEX_ROLLOUT_PREFIX = "rollout-"
    JSONL_GLOB = "*.jsonl"
    ROLE_USER = "user"
    ROLE_ASSISTANT = "assistant"
    MAX_TURNS = 4000
    MAX_RAW_TURNS = 16000
    MAX_TEXT_CHARS = 20000
    MAX_THINKING_ITEM_CHARS = 1800
    MAX_THINKING_BLOCK_CHARS = 9000

    def __init__(self) -> None:
        self._states: dict[Path, _TranscriptState] = {}
        self._codex_paths: dict[str, Path] = {}
        self._subscribers: dict[Path, set[asyncio.Queue]] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._observer: Observer | None = None
        self._codex_leaf_observer = None

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        if self._observer is not None:
            return
        self._loop = loop
        observer = Observer()
        handler = _TranscriptFileHandler(self._on_file_change_from_thread)
        # Claude's tree is already watched by ClaudeActivityWatcher. Its events
        # are forwarded here by the session manager so macOS FSEvents does not
        # try to register the same recursive watch twice.
        for root in (TermdeckConfig.CODEX_SESSIONS_DIR,):
            if root.is_dir():
                observer.schedule(handler, str(root), recursive=True)
        observer.start()
        self._observer = observer
        # FSEvents is useful for discovering new rollout files, but on macOS
        # it can omit append/modify events for an already-open Codex JSONL.
        # kqueue watches the existing date directories directly and delivers
        # those changes without polling the files or scanning all sessions.
        if KqueueObserver is not None and TermdeckConfig.CODEX_SESSIONS_DIR.is_dir():
            leaf_observer = KqueueObserver()
            leaf_dirs = {path.parent for path in TermdeckConfig.CODEX_SESSIONS_DIR.rglob("*.jsonl")}
            for leaf in sorted(leaf_dirs):
                leaf_observer.schedule(handler, str(leaf), recursive=False)
            if leaf_dirs:
                leaf_observer.start()
                self._codex_leaf_observer = leaf_observer

    def stop(self) -> None:
        observer, self._observer = self._observer, None
        leaf_observer, self._codex_leaf_observer = self._codex_leaf_observer, None
        if leaf_observer is not None:
            leaf_observer.stop()
            leaf_observer.join(timeout=2)
        if observer is not None:
            observer.stop()
            observer.join(timeout=2)
        self._loop = None
        self._subscribers.clear()

    def subscribe(self, agent_kind: str, cwd: str, agent_session_id: str | None) -> tuple[Path | None, list[dict[str, object]], int, asyncio.Queue]:
        path = self.source_path(agent_kind, cwd, agent_session_id)
        queue: asyncio.Queue = asyncio.Queue()
        if path is None:
            return None, [], 0, queue
        turns = self._transcript_for_path(AgentKind(agent_kind), path)
        self._subscribers.setdefault(path, set()).add(queue)
        state = self._states.get(path)
        return path, turns, state.revision if state else 0, queue

    def updates_since(self, path: Path | None, revision: int) -> list[dict[str, object]] | None:
        if path is None:
            return [] if revision == 0 else None
        state = self._states.get(path)
        if state is None or revision == state.revision:
            return []
        if revision > state.revision or not state.update_log:
            return None
        updates = [item for item in state.update_log if int(item.get("revision", 0)) > revision]
        expected = revision + 1
        if not updates or int(updates[0].get("revision", 0)) != expected:
            return None
        if any(int(item.get("revision", 0)) != expected + index for index, item in enumerate(updates)):
            return None
        return updates

    def unsubscribe(self, path: Path | None, queue: asyncio.Queue) -> None:
        if path is None:
            return
        subscribers = self._subscribers.get(path)
        if subscribers is None:
            return
        subscribers.discard(queue)
        if not subscribers:
            self._subscribers.pop(path, None)

    def source_path(self, agent_kind: str, cwd: str, agent_session_id: str | None) -> Path | None:
        if not agent_session_id:
            return None
        kind = AgentKind(agent_kind)
        if kind is AgentKind.CODEX:
            return self._find_codex_rollout(agent_session_id)
        if kind is AgentKind.CLAUDE:
            path = self._claude_project_dir(Path(cwd)) / f"{agent_session_id}.jsonl"
            return path if path.exists() else None
        return None

    def last_user_timestamp(self, agent_kind: str, cwd: str, agent_session_id: str | None) -> float | None:
        path = self.source_path(agent_kind, cwd, agent_session_id)
        if path is None:
            return None
        self._transcript_for_path(AgentKind(agent_kind), path)
        state = self._states.get(path)
        return state.last_user_at if state else None

    def transcript_for(self, agent_kind: str, cwd: str, agent_session_id: str | None) -> list[dict[str, object]]:
        path = self.source_path(agent_kind, cwd, agent_session_id)
        return self._transcript_for_path(AgentKind(agent_kind), path) if path else []

    def _transcript_for_path(self, kind: AgentKind, path: Path) -> list[dict[str, object]]:
        state = self._states.get(path)
        if state is None or state.agent_kind is not kind:
            state = _TranscriptState(path=path, agent_kind=kind)
            self._states[path] = state
            self._reload_state(state)
        else:
            self._refresh_state(state)
        return state.turns

    def _on_file_change_from_thread(self, path: Path) -> None:
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._refresh_changed_path, path)

    def notify_file_change(self, path: Path) -> None:
        self._on_file_change_from_thread(path)

    def _refresh_changed_path(self, path: Path) -> None:
        state = self._states.get(path)
        if state is None:
            return
        previous = state.turns
        self._refresh_state(state)
        if state.turns == previous:
            return
        replace_from = 0
        while replace_from < len(previous) and replace_from < len(state.turns) and \
                previous[replace_from] == state.turns[replace_from]:
            replace_from += 1
        payload = {"type": "transcript_update", "revision": state.revision,
                   "replace_from": replace_from, "turns": state.turns[replace_from:]}
        state.update_log.append(payload)
        del state.update_log[:-128]
        for queue in list(self._subscribers.get(path, ())):
            queue.put_nowait(payload)

    def _reload_state(self, state: _TranscriptState) -> None:
        try:
            stat = state.path.stat()
            data = state.path.read_bytes()
        except (FileNotFoundError, OSError):
            state.raw_turns = []
            state.turns = []
            state.offset = 0
            state.carry = b""
            state.inode = None
            state.revision += 1
            state.update_log.clear()
            state.last_user_at = None
            return
        chunks = data.splitlines(keepends=True)
        complete: list[bytes] = []
        carry = b""
        for chunk in chunks:
            if chunk.endswith((b"\n", b"\r")):
                complete.append(chunk.rstrip(b"\r\n"))
            else:
                carry = chunk
        lines = [line.decode(errors="replace") for line in complete]
        state.last_user_at = self._latest_user_timestamp(state.agent_kind, lines)
        state.raw_turns = self._trim_recent_raw_turns(self._parse_lines(state.agent_kind, lines))
        state.turns = self._trim_display_turns(self._collapse_thinking_events(state.raw_turns))
        state.offset = len(data) - len(carry)
        state.carry = carry
        state.inode = getattr(stat, "st_ino", None)
        state.revision += 1
        state.update_log.clear()

    def _refresh_state(self, state: _TranscriptState) -> None:
        try:
            stat = state.path.stat()
        except (FileNotFoundError, OSError):
            if state.turns:
                self._reload_state(state)
            return
        inode = getattr(stat, "st_ino", None)
        if state.inode != inode or stat.st_size < state.offset:
            self._reload_state(state)
            return
        if stat.st_size == state.offset:
            return
        try:
            with state.path.open("rb") as stream:
                stream.seek(state.offset + len(state.carry))
                data = state.carry + stream.read()
                new_offset = stream.tell()
        except OSError:
            return
        chunks = data.splitlines(keepends=True)
        complete: list[bytes] = []
        carry = b""
        for chunk in chunks:
            if chunk.endswith((b"\n", b"\r")):
                complete.append(chunk.rstrip(b"\r\n"))
            else:
                carry = chunk
        if not complete:
            state.carry = data
            return
        lines = [line.decode(errors="replace") for line in complete]
        latest_user_at = self._latest_user_timestamp(state.agent_kind, lines)
        if latest_user_at is not None:
            state.last_user_at = latest_user_at
        state.raw_turns.extend(self._parse_lines(state.agent_kind, lines))
        state.raw_turns = self._trim_recent_raw_turns(state.raw_turns)
        state.turns = self._trim_display_turns(self._collapse_thinking_events(state.raw_turns))
        state.carry = carry
        state.offset = new_offset - len(carry)
        state.inode = inode
        state.revision += 1

    def _parse_lines(self, kind: AgentKind, lines: Iterable[str]) -> list[dict[str, object]]:
        return self._parse_codex_lines(lines) if kind is AgentKind.CODEX else self._parse_claude_lines(lines)

    def _latest_user_timestamp(self, kind: AgentKind, lines: Iterable[str]) -> float | None:
        latest: float | None = None
        for line in lines:
            payload = self._loads(line)
            if payload is None:
                continue
            is_user = False
            if kind is AgentKind.CODEX:
                body = payload.get("payload")
                is_user = isinstance(body, dict) and body.get("type") == "message" and body.get("role") == "user"
            elif kind is AgentKind.CLAUDE:
                is_user = payload.get("type") == self.ROLE_USER
            if not is_user:
                continue
            value = payload.get("timestamp")
            try:
                if isinstance(value, (int, float)):
                    timestamp = float(value)
                elif isinstance(value, str):
                    timestamp = dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
                else:
                    continue
            except (TypeError, ValueError, OverflowError):
                continue
            latest = timestamp if latest is None else max(latest, timestamp)
        return latest

    def _claude_project_dir(self, cwd: Path) -> Path:
        munged = "".join(ch if ch.isalnum() else "-" for ch in str(cwd))
        return TermdeckConfig.CLAUDE_PROJECTS_DIR / munged

    def _find_codex_rollout(self, agent_session_id: str) -> Path | None:
        cached = self._codex_paths.get(agent_session_id)
        if cached is not None and cached.exists():
            return cached
        needle = f"-{agent_session_id}.jsonl"
        for path in TermdeckConfig.CODEX_SESSIONS_DIR.rglob(f"{self.CODEX_ROLLOUT_PREFIX}*{needle}"):
            self._codex_paths[agent_session_id] = path
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
        diff, diff_files = self._edit_diff_parts(name, value, text) if kind == "edit" else ([], [])
        if kind == "edit" and not diff and name.strip().lower() not in {"edit", "write", "notebookedit", "apply_patch"}:
            kind = "tool"
        title = "Code edit" if kind == "edit" else "Plan" if kind == "plan" else name or "Tool"
        turn = self._turn(role, text, kind, title, expanded=kind == "edit")
        if diff:
            # The structured diff is what the Markdown view renders. Keeping
            # the original apply_patch wrapper as well duplicates a large
            # payload in every snapshot without adding visible information.
            turn["text"] = ""
            turn["diff"] = diff
        if diff_files:
            turn["diff_files"] = diff_files
        if kind == "plan":
            plan = self._extract_plan(value, text)
            if plan:
                turn["plan"] = plan
        return turn

    @staticmethod
    def _format_value(value: object) -> str:
        if isinstance(value, str):
            return value
        try:
            return json.dumps(value, ensure_ascii=False, indent=2)
        except (TypeError, ValueError):
            return str(value)

    @classmethod
    def _format_result_value(cls, value: object) -> str:
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
        return cls._format_value(value)

    @staticmethod
    def _tool_kind(name: str, text: str) -> str:
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
    def _edit_diff_parts(cls, name: str, value: object, text: str) -> tuple[list[dict[str, str]], list[dict[str, object]]]:
        if isinstance(value, dict):
            old = value.get("old_string")
            new = value.get("new_string")
            if isinstance(new, str) and (isinstance(old, str) or name.lower() == "edit"):
                rows = cls._line_diff(old if isinstance(old, str) else "", new)
                path = cls._edit_file_path(value) or "edited file"
                return rows, [{"path": path, "diff": rows}]
            content = value.get("content")
            if isinstance(content, str) and name.lower() in {"write", "create"}:
                rows = cls._line_diff("", content)
                path = cls._edit_file_path(value) or "new file"
                return rows, [{"path": path, "diff": rows}]

        patch = cls._extract_patch(text)
        if not patch:
            return [], []
        files = cls._patch_diff_files(patch)
        return [line for file in files for line in file["diff"]], files

    @classmethod
    def _edit_diff(cls, name: str, value: object, text: str) -> list[dict[str, str]]:
        diff, _ = cls._edit_diff_parts(name, value, text)
        return diff

    @staticmethod
    def _edit_file_path(value: dict[str, object]) -> str:
        for key in ("file_path", "path", "fileName", "filename", "file"):
            path = value.get(key)
            if isinstance(path, str) and path.strip():
                return path.strip()
        return ""

    @classmethod
    def _patch_diff_files(cls, patch: str) -> list[dict[str, object]]:
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
    def _legacy_patch_diff(patch: str) -> list[dict[str, str]]:
        rows: list[dict[str, str]] = []
        for line in patch.splitlines():
            if line.startswith(("***", "@@", "+ +++", "---")):
                continue
            if line.startswith("+++") or line.startswith("---"):
                continue
            if line.startswith("+"):
                rows.append({"kind": "add", "prefix": "+", "text": line[1:]})
            elif line.startswith("-"):
                rows.append({"kind": "remove", "prefix": "−", "text": line[1:]})
            elif line.startswith(" "):
                rows.append({"kind": "context", "prefix": " ", "text": line[1:]})
        return rows

    @staticmethod
    def _extract_patch(text: str) -> str:
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
    def _line_diff(old: str, new: str) -> list[dict[str, str]]:
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
    def _extract_plan(value: object, text: str) -> list[dict[str, str]]:
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
    def _tool_call_id(payload: dict[str, object]) -> str:
        return str(payload.get("call_id") or payload.get("id") or "")

    def _parse_codex(self, path: Path) -> list[dict[str, object]]:
        return self._collapse_thinking_events(self._parse_codex_lines(path.read_text(errors="replace").splitlines()))

    def _parse_codex_lines(self, lines: Iterable[str]) -> list[dict[str, object]]:
        turns: list[dict[str, object]] = []
        for line in lines:
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
                turns.append(self._turn("event", self._format_result_value(output), "result", "Result"))
        return turns

    def _trim_recent_raw_turns(self, turns: list[dict[str, object]]) -> list[dict[str, object]]:
        """Bound memory while preserving the newest transcript events.

        The terminal is live and always shows the newest output. Keeping the
        oldest raw events here caused Markdown to stop before the current
        conversation once a long Codex rollout crossed the limit.
        """
        if len(turns) <= self.MAX_RAW_TURNS:
            return turns
        return turns[-self.MAX_RAW_TURNS:]

    def _trim_display_turns(self, turns: list[dict[str, object]]) -> list[dict[str, object]]:
        if len(turns) <= self.MAX_TURNS:
            return turns
        return turns[-self.MAX_TURNS:]

    @staticmethod
    def _is_codex_boilerplate(text: str) -> bool:
        head = text.lstrip()[:40]
        return head.startswith("# AGENTS.md") or head.startswith("<INSTRUCTIONS>") or head.startswith("<environment_context>")

    def _parse_claude(self, path: Path) -> list[dict[str, object]]:
        return self._collapse_thinking_events(self._parse_claude_lines(path.read_text(errors="replace").splitlines()))

    def _parse_claude_lines(self, lines: Iterable[str]) -> list[dict[str, object]]:
        turns: list[dict[str, object]] = []
        for line in lines:
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
                        turns.append(self._turn("event", self._format_result_value(result), "result", "Result"))
        return turns

    @staticmethod
    def _collapse_thinking_events(turns: list[dict[str, object]]) -> list[dict[str, object]]:
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
                    limit = TranscriptService.MAX_THINKING_ITEM_CHARS
                    if len(text) > limit:
                        text = text[:400] + "\n… truncated …\n" + text[-(limit - 420):]
                    remaining = TranscriptService.MAX_THINKING_BLOCK_CHARS - used
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
