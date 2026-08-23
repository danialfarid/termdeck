import asyncio
import collections
import json
import re
import shlex
from datetime import timedelta
from pathlib import Path

from termdeck.config import TermdeckConfig
from termdeck.models import AgentKind
from termdeck.proc_tree import ProcTreeUtil
from termdeck.util import TimeUtil


class AgentSessionTracker:
    """Resolves which claude/codex CLI session a terminal is CURRENTLY on. Open process files are authoritative.
    New files are claimable only after local input. An existing Claude file is claimable only when it changed after
    this terminal submitted a prompt and no other terminal owns it, which supports in-process resume switches without
    attributing unrelated concurrent Claude activity in the same cwd."""

    _UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    _CODEX_ROLLOUT_UUID_RE = re.compile(
        r"rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$")
    _COMMAND_SPLIT_RE = re.compile(r"[\s;|&()]+")
    _LSOF_PATH_LINE_PREFIX = "n"
    _CODEX_SUBAGENT_MARKER = b'"source":{"subagent"'
    _CLAUDE_SIDECHAIN_MARKER = b'"isSidechain":true'
    _SUBAGENT_SNIFF_BYTES = 2048
    _SUBAGENT_TAIL_BYTES = 256 * 1024
    _AGY_ACTIVITY_TAIL_BYTES = 256 * 1024
    _CODEX_ACTIVITY_TAIL_BYTES = 8 * 1024 * 1024
    _CLAUDE_PERMISSION_TAIL_BYTES = 256 * 1024
    _CLAUDE_PERMISSION_MODES = {"acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"}
    _CLAUDE_INTERRUPT_TEXT_PREFIX = "[Request interrupted by user"
    _CLAUDE_LOCAL_COMMAND_MARKERS = ("<command-name>", "<local-command-")
    _CLI_TITLE_CACHE_SIZE = 120
    _SUBAGENT_FILE_CACHE_SIZE = 2000

    def __init__(self) -> None:
        self._subagent_file_cache: dict[Path, bool] = {}
        self._codex_thread_names: dict[str, str] = {}
        self._codex_session_title_cache: collections.OrderedDict[str, str] = collections.OrderedDict()
        self._claude_session_title_cache: collections.OrderedDict[tuple[str, str], str] = collections.OrderedDict()
        self._codex_index_mtime_ns: int | None = None

    def codex_thread_name(self, session_id: str | None) -> str | None:
        if not session_id:
            return None
        path = TermdeckConfig.CODEX_SESSION_INDEX_FILE
        try:
            mtime_ns = path.stat().st_mtime_ns
        except OSError:
            return None
        if mtime_ns != self._codex_index_mtime_ns:
            names: dict[str, str] = {}
            try:
                for line in path.read_text(errors="replace").splitlines():
                    try:
                        payload = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    thread_id = payload.get("id")
                    thread_name = payload.get("thread_name")
                    if isinstance(thread_id, str) and isinstance(thread_name, str) and thread_name.strip():
                        names[thread_id] = thread_name.strip()
            except OSError:
                return None
            self._codex_thread_names = names
            self._codex_index_mtime_ns = mtime_ns
        return self._codex_thread_names.get(session_id)

    def codex_session_title(self, session_id: str | None) -> str | None:
        """Return the saved Codex thread name, with a rollout-derived fallback for older sessions."""
        if not session_id:
            return None
        cached = self._codex_session_title_cache.get(session_id)
        if cached is not None:
            self._codex_session_title_cache.move_to_end(session_id)
            return cached
        title = self.codex_thread_name(session_id)
        if title:
            self._codex_session_title_cache[session_id] = title
            while len(self._codex_session_title_cache) > self._CLI_TITLE_CACHE_SIZE:
                self._codex_session_title_cache.popitem(last=False)
            return title
        needle = f"-{session_id}.jsonl"
        try:
            path = next(TermdeckConfig.CODEX_SESSIONS_DIR.rglob(f"rollout-*{needle}"), None)
        except OSError:
            return None
        if path is None:
            return None
        first_prompt = None
        try:
            with path.open(errors="replace") as handle:
                for line in handle:
                    try:
                        payload = json.loads(line).get("payload", {})
                    except json.JSONDecodeError:
                        continue
                    if payload.get("type") == "thread_name_updated" and str(payload.get("thread_name", "")).strip():
                        title = str(payload["thread_name"]).strip()
                        self._codex_session_title_cache[session_id] = title
                        return title
                    if first_prompt is None and payload.get("type") == "user_message":
                        first_prompt = str(payload.get("message", "")).strip()
        except OSError:
            return None
        if not first_prompt:
            return None
        markdown_match = re.search(r"(?:^|[/\s])([A-Za-z0-9][A-Za-z0-9_.-]*\.md)\b", first_prompt)
        if markdown_match:
            title = Path(markdown_match.group(1)).stem
            self._codex_session_title_cache[session_id] = title
            while len(self._codex_session_title_cache) > self._CLI_TITLE_CACHE_SIZE:
                self._codex_session_title_cache.popitem(last=False)
            return title
        compact = re.sub(r"\s+", " ", first_prompt)
        title = compact[:56].rstrip() + ("…" if len(compact) > 56 else "")
        self._codex_session_title_cache[session_id] = title
        while len(self._codex_session_title_cache) > self._CLI_TITLE_CACHE_SIZE:
            self._codex_session_title_cache.popitem(last=False)
        return title

    def codex_session_is_active(self, session_id: str | None) -> bool:
        if not session_id:
            return False
        path = self.codex_session_path(session_id)
        if path is None:
            return False
        try:
            with path.open("rb") as handle:
                handle.seek(0, 2)
                handle.seek(max(0, handle.tell() - self._CODEX_ACTIVITY_TAIL_BYTES))
                lines = handle.read().decode(errors="replace").splitlines()
        except OSError:
            return False
        state: bool | None = None
        for line in lines:
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if payload.get("type") != "event_msg":
                continue
            event_type = (payload.get("payload") or {}).get("type")
            if event_type == "task_started":
                state = True
            elif event_type in {"task_complete", "turn_aborted"}:
                state = False
        return bool(state)

    def codex_session_path(self, session_id: str | None) -> Path | None:
        if not session_id:
            return None
        try:
            return next(TermdeckConfig.CODEX_SESSIONS_DIR.rglob(f"rollout-*{session_id}.jsonl"), None)
        except OSError:
            return None

    def session_activity_timestamp(self, kind: AgentKind, cwd: Path, session_id: str | None) -> float:
        if not session_id:
            return 0.0
        if kind is AgentKind.CODEX:
            path = self.codex_session_path(session_id)
        elif kind is AgentKind.CLAUDE:
            path = self.claude_project_dir(cwd) / f"{session_id}.jsonl"
        elif kind is AgentKind.AGY:
            path = self.agy_session_transcript(session_id)
        else:
            return 0.0
        if path is None:
            return 0.0
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0

    def claude_session_title(self, cwd: Path, session_id: str | None) -> str | None:
        """Read Claude's durable aiTitle when the terminal has not emitted its OSC title yet."""
        if not session_id:
            return None
        cache_key = (str(cwd), session_id)
        path = self.claude_project_dir(cwd) / f"{session_id}.jsonl"
        explicit_title = self._claude_explicit_session_title(path)
        if explicit_title:
            self._claude_session_title_cache[cache_key] = explicit_title
            self._claude_session_title_cache.move_to_end(cache_key)
            return explicit_title
        cached = self._claude_session_title_cache.get(cache_key)
        if cached is not None:
            self._claude_session_title_cache.move_to_end(cache_key)
            return cached
        ai_title = None
        explicit_title = None
        try:
            with path.open(errors="replace") as handle:
                for line in handle:
                    try:
                        payload = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if payload.get("type") == "ai-title" and str(payload.get("aiTitle", "")).strip():
                        ai_title = str(payload["aiTitle"]).strip()
                    elif payload.get("type") == "custom-title" and str(payload.get("customTitle", "")).strip():
                        explicit_title = str(payload["customTitle"]).strip()
                    elif payload.get("type") == "agent-name" and str(payload.get("agentName", "")).strip():
                        explicit_title = str(payload["agentName"]).strip()
        except OSError:
            return None
        title = explicit_title or ai_title
        if title is not None:
            self._claude_session_title_cache[cache_key] = title
            while len(self._claude_session_title_cache) > self._CLI_TITLE_CACHE_SIZE:
                self._claude_session_title_cache.popitem(last=False)
        return title

    def invalidate_claude_session_title(self, cwd: Path, session_id: str | None) -> None:
        if session_id:
            self._claude_session_title_cache.pop((str(cwd), session_id), None)

    def claude_explicit_session_title(self, cwd: Path, session_id: str | None) -> str | None:
        if not session_id:
            return None
        return self._claude_explicit_session_title(self.claude_project_dir(cwd) / f"{session_id}.jsonl")

    def claude_ai_title(self, cwd: Path, session_id: str | None) -> str | None:
        if not session_id:
            return None
        return self._claude_attention_state_from_path(self.claude_project_dir(cwd) / f"{session_id}.jsonl")[0]

    def claude_attention_state(self, cwd: Path, session_id: str | None) -> tuple[str | None, bool]:
        if not session_id:
            return None, False
        return self._claude_attention_state_from_path(self.claude_project_dir(cwd) / f"{session_id}.jsonl")

    def claude_session_permission_mode(self, cwd: Path, session_id: str | None) -> str | None:
        if not session_id:
            return None
        path = self.claude_project_dir(cwd) / f"{session_id}.jsonl"
        try:
            with path.open("rb") as handle:
                handle.seek(0, 2)
                handle.seek(max(0, handle.tell() - self._CLAUDE_PERMISSION_TAIL_BYTES))
                lines = handle.read().decode(errors="replace").splitlines()
        except OSError:
            return None
        for line in reversed(lines):
            try:
                mode = json.loads(line).get("permissionMode")
            except json.JSONDecodeError:
                continue
            if mode in self._CLAUDE_PERMISSION_MODES:
                return mode
        return None

    def codex_session_id_for_reference(self, reference: str) -> str | None:
        """Resolve a Codex UUID or saved thread name to the UUID accepted by resume."""
        reference = reference.strip()
        if not reference:
            return None
        path = TermdeckConfig.CODEX_SESSION_INDEX_FILE
        try:
            mtime_ns = path.stat().st_mtime_ns
        except OSError:
            return None
        if mtime_ns != self._codex_index_mtime_ns:
            self.codex_thread_name("__refresh__")
        if self._UUID_RE.fullmatch(reference):
            if reference in self._codex_thread_names:
                return reference
            try:
                return reference if next(TermdeckConfig.CODEX_SESSIONS_DIR.rglob(f"rollout-*{reference}.jsonl"), None) else None
            except OSError:
                return None
        matches = [session_id for session_id, name in self._codex_thread_names.items() if name == reference]
        return matches[-1] if matches else None

    def _is_subagent_session_file(self, kind: AgentKind, path: Path) -> bool:
        cached = self._subagent_file_cache.get(path)
        if cached is not None:
            return cached
        marker = self._CODEX_SUBAGENT_MARKER if kind is AgentKind.CODEX else self._CLAUDE_SIDECHAIN_MARKER
        try:
            with path.open("rb") as handle:
                head = handle.read(self._SUBAGENT_SNIFF_BYTES)
        except (FileNotFoundError, OSError):
            return False
        is_subagent = marker in head
        self._subagent_file_cache[path] = is_subagent
        if len(self._subagent_file_cache) > self._SUBAGENT_FILE_CACHE_SIZE:
            self._subagent_file_cache.clear()
        return is_subagent

    def detect_agent_kind(self, command: str) -> AgentKind:
        tokens = {Path(token).name for token in self._COMMAND_SPLIT_RE.split(command) if token}
        if AgentKind.CLAUDE.value in tokens:
            return AgentKind.CLAUDE
        if AgentKind.CODEX.value in tokens:
            return AgentKind.CODEX
        if AgentKind.AGY.value in tokens:
            return AgentKind.AGY
        return AgentKind.NONE

    def claude_project_dir(self, cwd: Path) -> Path:
        munged = "".join(ch if ch.isalnum() else "-" for ch in str(cwd))
        return TermdeckConfig.CLAUDE_PROJECTS_DIR / munged

    @staticmethod
    def agy_session_dir(session_id: str) -> Path:
        return TermdeckConfig.AGY_SESSIONS_DIR / session_id

    @staticmethod
    def agy_session_transcript(session_id: str, prefer_full: bool = True) -> Path | None:
        directory = TermdeckConfig.AGY_SESSIONS_DIR / session_id / ".system_generated" / "logs"
        full_transcript = directory / "transcript_full.jsonl"
        live_transcript = directory / "transcript.jsonl"
        if prefer_full and full_transcript.is_file():
            return full_transcript
        return live_transcript if live_transcript.is_file() else full_transcript if full_transcript.is_file() else None

    @staticmethod
    def _agy_session_id_from_path(path: Path) -> str | None:
        try:
            relative = path.relative_to(TermdeckConfig.AGY_SESSIONS_DIR)
        except ValueError:
            return None
        if not relative.parts:
            return None
        session_id = relative.parts[0]
        return session_id if AgentSessionTracker._UUID_RE.fullmatch(session_id) else None

    @staticmethod
    def _title_words(title: str | None) -> set[str]:
        if not title:
            return set()
        return {word for word in re.split(r"[^a-z0-9]+", title.lower()) if len(word) > 1}

    def _claude_parent_for_title(self, cwd: Path, cli_title: str | None) -> Path | None:
        project_dir = self.claude_project_dir(cwd)
        target_words = self._title_words(cli_title)
        candidates: list[tuple[int, float, Path]] = []
        try:
            paths = project_dir.glob("*.jsonl")
        except OSError:
            return None
        for path in paths:
            try:
                with path.open(errors="replace") as handle:
                    ai_title = next((json.loads(line).get("aiTitle") for line in handle
                                     if '"type":"ai-title"' in line), None)
                score = len(target_words & self._title_words(ai_title))
                if score:
                    candidates.append((score, path.stat().st_mtime, path))
            except (OSError, json.JSONDecodeError):
                continue
        return max(candidates, key=lambda item: (item[0], item[1]))[2] if candidates else None

    @staticmethod
    def _claude_user_event_is_interruption(message: dict) -> bool:
        """Whether a trailing user event is Claude's own ESC record rather than a submitted prompt.

        Claude appends "[Request interrupted by user]" as a user-role event when work is cancelled, so a
        newest-event-is-user test would otherwise read a stopped session as permanently working.
        """
        content = message.get("content")
        if isinstance(content, str):
            texts = [content]
        else:
            texts = [part.get("text") or "" for part in content or [] if isinstance(part, dict)]
        prefix = AgentSessionTracker._CLAUDE_INTERRUPT_TEXT_PREFIX
        return any(text.strip().startswith(prefix) for text in texts)

    @staticmethod
    def _claude_user_event_is_local_command(message: dict) -> bool:
        content = message.get("content")
        if isinstance(content, str):
            texts = [content]
        else:
            texts = [part.get("text") or "" for part in content or [] if isinstance(part, dict)]
        return any(text.strip().startswith("/") or any(marker in text for marker in AgentSessionTracker._CLAUDE_LOCAL_COMMAND_MARKERS)
                   for text in texts)

    @staticmethod
    def _claude_user_event_is_non_prompt_metadata(message: dict) -> bool:
        content = message.get("content")
        if isinstance(content, str):
            texts = [content]
            blocks = []
        else:
            blocks = [part for part in content or [] if isinstance(part, dict)]
            texts = [part.get("text") or "" for part in blocks]
        if any(part.get("type") == "tool_result" for part in blocks):
            return True
        if not any(text.strip() for text in texts):
            return True
        return any(text.lstrip().startswith("<system-reminder>") for text in texts)

    @staticmethod
    def _claude_subagent_is_active(path: Path) -> bool:
        """Infer active work from the last meaningful Claude subagent event."""
        try:
            with path.open("rb") as handle:
                handle.seek(0, 2)
                size = handle.tell()
                handle.seek(max(0, size - AgentSessionTracker._SUBAGENT_TAIL_BYTES))
                raw = handle.read()
            lines = raw.decode(errors="replace").splitlines()
        except OSError:
            return False
        for line in reversed(lines):
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = event.get("message") or {}
            if event.get("type") == "user":
                if event.get("isMeta") or AgentSessionTracker._claude_user_event_is_local_command(message) or \
                        AgentSessionTracker._claude_user_event_is_non_prompt_metadata(message):
                    continue
                if AgentSessionTracker._claude_user_event_is_interruption(message):
                    return False
                return True
            if event.get("type") != "assistant" or message.get("type") != "message":
                continue
            content = message.get("content") or []
            if any(part.get("type") in {"tool_use", "thinking"} for part in content if isinstance(part, dict)):
                return True
            if any(part.get("type") == "text" for part in content if isinstance(part, dict)):
                return False
        return False

    def claude_has_active_subagents(self, cwd: Path, cli_title: str | None) -> bool:
        parent = self._claude_parent_for_title(cwd, cli_title)
        if parent is None:
            return False
        subagents = parent.with_name(parent.stem) / "subagents"
        try:
            return any(self._claude_subagent_is_active(path) for path in subagents.glob("*.jsonl"))
        except OSError:
            return False

    def claude_subagent_states(self, cwd: Path, session_id: str) -> dict[Path, bool]:
        subagents = self.claude_project_dir(cwd) / session_id / "subagents"
        try:
            return {path: self.claude_subagent_is_active(path) for path in subagents.glob("*.jsonl")}
        except OSError:
            return {}

    def claude_subagent_is_active(self, path: Path) -> bool:
        return self._claude_subagent_is_active(path)

    def claude_session_is_active(self, path: Path) -> bool:
        """Infer whether the latest event in a Claude parent transcript is still working."""
        return self._claude_subagent_is_active(path)

    def agy_session_is_active(self, session_id: str | None) -> bool:
        if not session_id:
            return False
        path = self.agy_session_transcript(session_id, prefer_full=True)
        if path is None:
            return False
        return self._agy_session_is_active(path)

    @staticmethod
    def _agy_session_is_active(path: Path) -> bool:
        try:
            size = path.stat().st_size
        except OSError:
            return False
        if not size:
            return False
        start = max(0, size - AgentSessionTracker._AGY_ACTIVITY_TAIL_BYTES)
        try:
            with path.open("rb") as handle:
                if start > 0:
                    handle.seek(start - 1)
                    previous = handle.read(1)
                    handle.seek(start)
                else:
                    previous = b"\n"
                raw = handle.read()
        except OSError:
            return False
        if start > 0 and previous not in (b"\n", b"\r"):
            boundary = raw.find(b"\n")
            if boundary < 0:
                return False
            raw = raw[boundary + 1:]
        for raw_line in reversed(raw.splitlines()):
            try:
                payload = json.loads(raw_line.decode(errors="replace"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if not isinstance(payload, dict):
                continue
            event_type = str(payload.get("type") or "").upper()
            status = str(payload.get("status") or "").upper()
            if status in {"DONE", "COMPLETED", "ERROR", "FAILED", "INTERRUPTED", "CANCELLED", "CANCELED", "TIMEOUT", "TIME_EXCEEDED"}:
                return False
            if status in {"IN_PROGRESS", "WORKING", "PROCESSING", "RUNNING"}:
                return True
            if event_type == "USER_INPUT":
                return True
            if str(payload.get("source") or "") == "USER_EXPLICIT":
                return True
            thinking = payload.get("thinking")
            if isinstance(thinking, str) and thinking.strip():
                return True
            tool_calls = payload.get("tool_calls")
            if isinstance(tool_calls, list) and tool_calls:
                return True
            content = payload.get("content")
            if isinstance(content, str) and content.strip():
                if event_type in {"CONVERSATION_HISTORY", "CHECKPOINT", "SYSTEM", "ASSISTANT_RESPONSE", "RESPONSE"}:
                    return False
                if event_type in {"PLANNER_RESPONSE", "VIEW_FILE", "GREP_SEARCH", "RUN_COMMAND", "RUN", "PLAN", "MODEL_RESPONSE"}:
                    return True
                return False
        return False

    def claude_session_id_for_title(self, cwd: Path, cli_title: str | None) -> str | None:
        parent = self._claude_parent_for_title(cwd, cli_title)
        return parent.stem if parent else None

    def claude_session_id_for_explicit_title(self, cwd: Path, title: str | None, after_timestamp: float,
                                             claimed_ids: set[str]) -> str | None:
        normalized_title = self._normalized_claude_title(title)
        if not normalized_title:
            return None
        candidates: list[tuple[float, str]] = []
        for path, session_id in self._candidate_session_files(AgentKind.CLAUDE, cwd):
            if session_id in claimed_ids:
                continue
            try:
                mtime = path.stat().st_mtime
            except OSError:
                continue
            if mtime < after_timestamp or self._normalized_claude_title(self._claude_explicit_session_title(path)) != normalized_title:
                continue
            candidates.append((mtime, session_id))
        return max(candidates, default=(0.0, None))[1]

    @staticmethod
    def _normalized_claude_title(value: str | None) -> str:
        return " ".join(str(value or "").split()).casefold()

    @staticmethod
    def _claude_explicit_session_title(path: Path) -> str | None:
        try:
            with path.open("rb") as handle:
                handle.seek(0, 2)
                handle.seek(max(0, handle.tell() - AgentSessionTracker._SUBAGENT_TAIL_BYTES))
                lines = handle.read().decode(errors="replace").splitlines()
        except OSError:
            return None
        for line in reversed(lines):
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "custom-title":
                title = event.get("customTitle")
            elif event.get("type") == "agent-name":
                title = event.get("agentName")
            else:
                continue
            if isinstance(title, str) and title.strip():
                return title.strip()
        return None

    @staticmethod
    def _claude_attention_state_from_path(path: Path) -> tuple[str | None, bool]:
        try:
            with path.open("rb") as handle:
                handle.seek(0, 2)
                handle.seek(max(0, handle.tell() - AgentSessionTracker._SUBAGENT_TAIL_BYTES))
                lines = handle.read().decode(errors="replace").splitlines()
        except OSError:
            return None, False
        ai_title = None
        ai_title_sequence = -1
        latest_tool_result_sequence = -1
        pending_tool_sequences: dict[str, int] = {}
        for sequence, line in enumerate(lines):
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            event_type = event.get("type")
            if event_type == "ai-title":
                title = event.get("aiTitle")
                if isinstance(title, str) and title.strip():
                    ai_title = title.strip()
                    ai_title_sequence = sequence
                continue
            message = event.get("message") or {}
            content = message.get("content") if isinstance(message, dict) else None
            if not isinstance(content, list):
                continue
            if event_type == "assistant":
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_use" and isinstance(block.get("id"), str):
                        pending_tool_sequences[block["id"]] = sequence
            elif event_type == "user":
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_result" and isinstance(block.get("tool_use_id"), str):
                        pending_tool_sequences.pop(block["tool_use_id"], None)
                        latest_tool_result_sequence = sequence
        has_current_pending_tool = ai_title_sequence > latest_tool_result_sequence and any(
            sequence > ai_title_sequence for sequence in pending_tool_sequences.values())
        return ai_title, has_current_pending_tool

    def snapshot_session_files(self, kind: AgentKind, cwd: Path) -> set[Path]:
        return {path for path, _ in self._candidate_session_files(kind, cwd)}

    async def session_id_from_open_files(self, kind: AgentKind, socket_path: Path) -> str | None:
        tree_pids = await ProcTreeUtil.tree_pids_for_socket(str(socket_path))
        pids = ",".join(str(pid) for pid in tree_pids)
        if not pids:
            return None
        lsof_output = await self._run_capture(TermdeckConfig.LSOF_BIN, "-a", "-p", pids, "-Fn")
        best_mtime, best_id = 0.0, None
        for line in lsof_output.splitlines():
            if not line.startswith(self._LSOF_PATH_LINE_PREFIX):
                continue
            path = Path(line[1:])
            session_id = self._session_id_for_path(kind, path)
            if session_id is None or self._is_subagent_session_file(kind, path):
                continue
            try:
                mtime = path.stat().st_mtime
            except FileNotFoundError:
                continue
            if mtime >= best_mtime:
                best_mtime, best_id = mtime, session_id
        return best_id

    async def claude_resume_session_id_from_process_arguments(self, socket_path: Path) -> str | None:
        tree_pids = await ProcTreeUtil.tree_pids_for_socket(str(socket_path))
        found: set[str] = set()
        for process in await ProcTreeUtil.process_details(tree_pids):
            parts = self._command_parts(str(process["command"]))
            for index, part in enumerate(parts):
                candidate = parts[index + 1] if part == TermdeckConfig.CLAUDE_RESUME_FLAG and index + 1 < len(parts) else \
                    part.removeprefix(f"{TermdeckConfig.CLAUDE_RESUME_FLAG}=") if part.startswith(f"{TermdeckConfig.CLAUDE_RESUME_FLAG}=") else ""
                if self._UUID_RE.fullmatch(candidate):
                    found.add(candidate)
        return next(iter(found)) if len(found) == 1 else None

    def claude_session_id_from_recent_file_activity(self, cwd: Path, after_timestamp: float,
                                                     claimed_ids: set[str]) -> str | None:
        candidates: list[tuple[float, str]] = []
        for path, session_id in self._candidate_session_files(AgentKind.CLAUDE, cwd):
            if session_id in claimed_ids:
                continue
            try:
                mtime = path.stat().st_mtime
            except OSError:
                continue
            if mtime >= after_timestamp:
                candidates.append((mtime, session_id))
        return max(candidates, default=(0.0, None))[1]

    def _session_id_for_path(self, kind: AgentKind, path: Path) -> str | None:
        if kind is AgentKind.CODEX and path.is_relative_to(TermdeckConfig.CODEX_SESSIONS_DIR):
            match = self._CODEX_ROLLOUT_UUID_RE.search(path.name)
            return match.group(1) if match else None
        if kind is AgentKind.CLAUDE and path.is_relative_to(TermdeckConfig.CLAUDE_PROJECTS_DIR):
            return path.stem if self._UUID_RE.match(path.stem) else None
        if kind is AgentKind.AGY and path.is_relative_to(TermdeckConfig.AGY_SESSIONS_DIR):
            return self._agy_session_id_from_path(path)
        return None

    @staticmethod
    async def _run_capture(*argv: str) -> str:
        proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.DEVNULL)
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=TermdeckConfig.SUBPROCESS_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            proc.kill()
            return ""
        return stdout.decode()

    def absorb_and_find_new_session_file(self, kind: AgentKind, cwd: Path, baseline: set[Path],
                                         claimed_ids: set[str], claim_allowed: bool) -> str | None:
        new_candidates: list[tuple[Path, str]] = []
        for path, session_id in self._candidate_session_files(kind, cwd):
            if path not in baseline and session_id not in claimed_ids and not self._is_subagent_session_file(kind, path):
                new_candidates.append((path, session_id))
            baseline.add(path)
        if not claim_allowed or not new_candidates:
            return None
        return max(new_candidates, key=self._candidate_mtime)[1]

    @staticmethod
    def _candidate_mtime(candidate: tuple[Path, str]) -> float:
        try:
            return candidate[0].stat().st_mtime
        except FileNotFoundError:
            return 0.0

    def _candidate_session_files(self, kind: AgentKind, cwd: Path) -> list[tuple[Path, str]]:
        if kind is AgentKind.CLAUDE:
            project_dir = self.claude_project_dir(cwd)
            if not project_dir.is_dir():
                return []
            return [(path, path.stem) for path in project_dir.glob(TermdeckConfig.JSONL_GLOB)
                    if self._UUID_RE.match(path.stem)]
        if kind is AgentKind.CODEX:
            pairs: list[tuple[Path, str]] = []
            for day_dir in self._codex_recent_day_dirs():
                if not day_dir.is_dir():
                    continue
                for path in day_dir.glob(TermdeckConfig.JSONL_GLOB):
                    match = self._CODEX_ROLLOUT_UUID_RE.search(path.name)
                    if match:
                        pairs.append((path, match.group(1)))
            return pairs
        if kind is AgentKind.AGY and TermdeckConfig.AGY_SESSIONS_DIR.is_dir():
            pairs: list[tuple[Path, str]] = []
            for entry in TermdeckConfig.AGY_SESSIONS_DIR.iterdir():
                if not entry.is_dir() or not self._UUID_RE.fullmatch(entry.name):
                    continue
                path = self.agy_session_transcript(entry.name, prefer_full=True)
                if path is not None:
                    pairs.append((path, entry.name))
            return pairs
        return []

    @staticmethod
    def _codex_recent_day_dirs() -> list[Path]:
        today = TimeUtil.today_est()
        days = [today + timedelta(days=offset) for offset in TermdeckConfig.CODEX_DAY_DIR_LOOKAROUND_DAYS]
        return [TermdeckConfig.CODEX_SESSIONS_DIR / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}"
                for day in days]

    def build_resume_command(self, kind: AgentKind, original_command: str, agent_session_id: str) -> str:
        if kind is AgentKind.CLAUDE:
            parts = self._command_parts(original_command)
            cleaned = self._strip_resume_flag(parts, TermdeckConfig.CLAUDE_RESUME_FLAG)
            if not cleaned:
                return f"claude {TermdeckConfig.CLAUDE_RESUME_FLAG} {agent_session_id}"
            return f"{shlex.join(cleaned)} {TermdeckConfig.CLAUDE_RESUME_FLAG} {agent_session_id}"
        if kind is AgentKind.CODEX:
            parts = self._command_parts(original_command)
            if not parts:
                return TermdeckConfig.CODEX_RESUME_TEMPLATE.format(agent_session_id=agent_session_id)
            cleaned = self._strip_codex_session_arguments(parts)
            cleaned = self._ensure_codex_searchable_scrollback(cleaned)
            return f"{shlex.join(cleaned)} resume {agent_session_id}"
        if kind is AgentKind.AGY:
            parts = self._command_parts(original_command)
            cleaned = self._strip_agy_session_arguments(parts)
            if not cleaned:
                cleaned = [AgentKind.AGY.value]
            cleaned.extend((TermdeckConfig.AGY_CONVERSATION_FLAG, agent_session_id))
            return shlex.join(cleaned)
        return original_command

    @staticmethod
    def _command_parts(command: str) -> list[str]:
        try:
            return shlex.split(command)
        except ValueError:
            return command.split()

    @staticmethod
    def _strip_resume_flag(parts: list[str], resume_flag: str) -> list[str]:
        cleaned: list[str] = []
        skip_next = False
        for token in parts:
            if skip_next:
                skip_next = False
                continue
            if token == resume_flag:
                skip_next = True
            else:
                cleaned.append(token)
        return cleaned

    @staticmethod
    def _strip_agy_session_arguments(parts: list[str]) -> list[str]:
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

    def _strip_positional_session_token(self, parts: list[str], command: str, subcommand: str) -> list[str]:
        cleaned: list[str] = []
        encountered_command = False
        skip_next = False
        for token in parts:
            if skip_next:
                skip_next = False
                continue
            if not encountered_command and Path(token).name == command:
                encountered_command = True
                cleaned.append(token)
                continue
            if token == subcommand and encountered_command:
                skip_next = True
                continue
            cleaned.append(token)
        return cleaned

    @staticmethod
    def _strip_codex_session_arguments(parts: list[str]) -> list[str]:
        cleaned: list[str] = []
        command_seen = False
        skip_session_id = False
        for token in parts:
            if skip_session_id:
                skip_session_id = False
                continue
            if not command_seen:
                cleaned.append(token)
                command_seen = Path(token).name == "codex"
                continue
            if token in {"fork", "resume"}:
                skip_session_id = True
                continue
            cleaned.append(token)
        return cleaned

    @staticmethod
    def _ensure_codex_searchable_scrollback(parts: list[str]) -> list[str]:
        if TermdeckConfig.CODEX_NO_ALT_SCREEN_FLAG in parts:
            return parts
        command_index = next((index for index, token in enumerate(parts) if Path(token).name == AgentKind.CODEX.value), None)
        if command_index is None:
            return parts
        return [*parts[:command_index + 1], TermdeckConfig.CODEX_NO_ALT_SCREEN_FLAG, *parts[command_index + 1:]]

    def build_fork_command(self, kind: AgentKind, original_command: str, agent_session_id: str,
                           session_name: str = "") -> str:
        if kind is AgentKind.CLAUDE:
            parts = self._command_parts(original_command)
            cleaned = self._strip_resume_flag(parts, TermdeckConfig.CLAUDE_RESUME_FLAG)
            cleaned = self._strip_resume_flag(cleaned, TermdeckConfig.CLAUDE_NAME_FLAG)
            if not cleaned:
                cleaned = ["claude"]
            cleaned.extend((TermdeckConfig.CLAUDE_RESUME_FLAG, agent_session_id, TermdeckConfig.CLAUDE_FORK_FLAG))
            if session_name.strip():
                cleaned.extend((TermdeckConfig.CLAUDE_NAME_FLAG, " ".join(session_name.splitlines()).strip()))
            return shlex.join(cleaned)
        if kind is AgentKind.CODEX:
            parts = self._command_parts(original_command)
            cleaned = self._strip_codex_session_arguments(parts) if parts else [AgentKind.CODEX.value]
            cleaned = self._ensure_codex_searchable_scrollback(cleaned)
            cleaned.extend(("fork", agent_session_id))
            return shlex.join(cleaned)
        return original_command
