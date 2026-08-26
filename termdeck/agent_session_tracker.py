import asyncio
import collections
import json
import re
import shlex
from pathlib import Path

from termdeck import agents
from termdeck.config import TermdeckConfig
from termdeck.proc_tree import ProcTreeUtil


class AgentSessionTracker:
    """Resolves which claude/codex CLI session a terminal is CURRENTLY on. Open process files are authoritative.
    New files are claimable only after local input. An existing Claude file is claimable only when it changed after
    this terminal submitted a prompt and no other terminal owns it, which supports in-process resume switches without
    attributing unrelated concurrent Claude activity in the same cwd."""

    _UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    _LSOF_PATH_LINE_PREFIX = "n"
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
        return agents.agent_cli("codex").transcript_path(None, session_id)

    def session_activity_timestamp(self, kind: str, cwd: Path, session_id: str | None) -> float:
        if not session_id:
            return 0.0
        path = agents.agent_cli(kind).transcript_path(cwd, session_id)
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

    def _is_subagent_session_file(self, kind: str, path: Path) -> bool:
        cached = self._subagent_file_cache.get(path)
        if cached is not None:
            return cached
        marker = agents.agent_cli(kind).subagent_file_marker
        if not marker:
            return False
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

    def claude_project_dir(self, cwd: Path) -> Path:
        return agents.agent_cli("claude").project_dir(cwd)

    @staticmethod
    def agy_session_transcript(session_id: str, prefer_full: bool = True) -> Path | None:
        return agents.agent_cli("agy").transcript_path(None, session_id)

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
                # isCompactSummary is the transcript Claude writes for itself after /compact ("This
                # session is being continued from a previous conversation..."). It is a user event with
                # real prose, so without this it reads as a freshly submitted prompt and the session
                # shows as working forever once a compact finishes.
                if event.get("isMeta") or event.get("isCompactSummary") or \
                        AgentSessionTracker._claude_user_event_is_local_command(message) or \
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
        for path, session_id in self._candidate_session_files("claude", cwd):
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

    def snapshot_session_files(self, kind: str, cwd: Path) -> set[Path]:
        return {path for path, _ in self._candidate_session_files(kind, cwd)}

    async def session_id_from_open_files(self, kind: str, socket_path: Path) -> str | None:
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
        for path, session_id in self._candidate_session_files("claude", cwd):
            if session_id in claimed_ids:
                continue
            try:
                mtime = path.stat().st_mtime
            except OSError:
                continue
            if mtime >= after_timestamp:
                candidates.append((mtime, session_id))
        return max(candidates, default=(0.0, None))[1]

    @staticmethod
    def _session_id_for_path(kind: str, path: Path) -> str | None:
        return agents.agent_cli(kind).session_id_from_path(path)

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

    def absorb_and_find_new_session_file(self, kind: str, cwd: Path, baseline: set[Path],
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

    @staticmethod
    def _candidate_session_files(kind: str, cwd: Path) -> list[tuple[Path, str]]:
        return agents.agent_cli(kind).candidate_session_files(cwd)

    @staticmethod
    def _command_parts(command: str) -> list[str]:
        try:
            return shlex.split(command)
        except ValueError:
            return command.split()

