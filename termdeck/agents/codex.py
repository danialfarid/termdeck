import collections
import json
import re
import shlex
import time
from datetime import timedelta
from pathlib import Path
from typing import Iterable

from termdeck.agents.base import UUID_RE, AgentCli, AgentSessionState
from termdeck.transcript_turns import TurnBuilder
from termdeck.util import TimeUtil


class CodexSessionState(AgentSessionState):
    def __init__(self) -> None:
        self.transcript_active = False
        self.activity_checked_monotonic = 0.0
        self.activity_signature: tuple[int | None, int, int] | None = None
        self.pending_rename: str | None = None
        self.pending_rename_deadline = 0.0


class CodexCli(AgentCli):
    kind = "codex"
    executable = "codex"
    label = "Codex"

    sessions_root = Path.home() / ".codex" / "sessions"
    SESSION_INDEX_FILE = Path.home() / ".codex" / "session_index.jsonl"
    NO_ALT_SCREEN_FLAG = "--no-alt-screen"
    DAY_DIR_LOOKAROUND_DAYS = (-1, 0, 1)
    history_indexed = True

    supports_resume = True
    supports_fork = True
    canonical_resume_command = True
    records_raw_replay = True
    has_prompt_queue = True
    supports_agent_rename = True
    accepts_session_ref = True

    base_flags = (NO_ALT_SCREEN_FLAG,)
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
    icon_svg = ('<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M22.2819 '
                '9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 '
                '0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 '
                '5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6'
                '.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-'
                '.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582'
                'a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 '
                '4.504 0 0 1-4.4945 4.4944zM3.5988 18.304a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 '
                '4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L'
                '9.74 19.9502a4.4992 4.4992 0 0 1-6.1412-1.6462zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-'
                '1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-'
                '.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5968 3.8558L13.1038 8.364 '
                '15.1192 7.2a.0757.075 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-'
                '5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 '
                '0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 '
                '0 0 1 6.6802 4.66zm-12.6413 4.1347-2.0201-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a'
                '4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805-4.783 2.7582a.7948.7948 0 0 0-.3927.6813z'
                'M9.4041 10.4976l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z"/></svg>')

    REASONING_EFFORTS = frozenset({"low", "medium", "high", "xhigh"})
    ROLLOUT_UUID_RE = re.compile(
        r"rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$")
    subagent_file_marker = b'"source":{"subagent"'

    def __init__(self) -> None:
        # One instance per kind in the registry, so these are process-wide caches with the same
        # lifetime the transcript-reading ones had on the tracker.
        # A rollout path never changes once the session exists; cache the rglob hit.
        self._rollout_paths: dict[str, Path] = {}
        self._thread_names: dict[str, str] = {}
        self._session_title_cache: collections.OrderedDict[str, str] = collections.OrderedDict()
        self._index_mtime_ns: int | None = None

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
        resolved = self.session_id_for_reference(session_ref)
        if resolved is None:
            raise ValueError(f"no saved Codex session found with ID or name: {session_ref}")
        return ("resume", resolved)

    def resume_command(self, original_command: str, agent_session_id: str) -> str:
        parts = self.command_parts(original_command)
        if not parts:
            return f"{self.executable} {self.NO_ALT_SCREEN_FLAG} resume {agent_session_id}"
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
            for path in self.sessions_root.rglob(f"rollout-*-{agent_session_id}.jsonl"):
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
        days = [today + timedelta(days=offset) for offset in CodexCli.DAY_DIR_LOOKAROUND_DAYS]
        return [CodexCli.sessions_root / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}"
                for day in days]

    def owns_transcript_path(self, path: Path) -> bool:
        root = self.sessions_root
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

    def usage_from_payload(self, payload: dict[str, object]) -> dict[str, int | None] | None:
        body = payload.get("payload")
        if not isinstance(body, dict) or body.get("type") != "token_count":
            return None
        info = body.get("info")
        if not isinstance(info, dict):
            return None
        last = info.get("last_token_usage")
        total = info.get("total_token_usage")
        def count(source: object, key: str) -> int:
            value = source.get(key) if isinstance(source, dict) else None
            return int(value) if isinstance(value, (int, float)) else 0
        window = info.get("model_context_window")
        return {
            # Codex's input_tokens already include the cached portion.
            "context_tokens": count(last, "input_tokens"),
            "output_tokens": count(last, "output_tokens"),
            "context_window": int(window) if isinstance(window, (int, float)) else None,
            "total_tokens": count(total, "total_tokens") or None,
        }

    # -- session index / transcript reading ---------------------------------
    #
    # Codex's thread index and rollout event shapes are known only here; the shared tracker asks
    # the adapter rather than parsing either itself.

    ACTIVITY_TAIL_BYTES = 8 * 1024 * 1024
    TITLE_CACHE_SIZE = 120

    def thread_name(self, agent_session_id: str | None) -> str | None:
        if not agent_session_id:
            return None
        path = self.SESSION_INDEX_FILE
        try:
            mtime_ns = path.stat().st_mtime_ns
        except OSError:
            return None
        if mtime_ns != self._index_mtime_ns:
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
            self._thread_names = names
            self._index_mtime_ns = mtime_ns
        return self._thread_names.get(agent_session_id)

    def _cache_session_title(self, agent_session_id: str, title: str) -> str:
        self._session_title_cache[agent_session_id] = title
        while len(self._session_title_cache) > self.TITLE_CACHE_SIZE:
            self._session_title_cache.popitem(last=False)
        return title

    def stored_session_title(self, agent_session_id: str | None) -> str | None:
        """Return the saved Codex thread name, with a rollout-derived fallback for older sessions."""
        if not agent_session_id:
            return None
        cached = self._session_title_cache.get(agent_session_id)
        if cached is not None:
            self._session_title_cache.move_to_end(agent_session_id)
            return cached
        title = self.thread_name(agent_session_id)
        if title:
            return self._cache_session_title(agent_session_id, title)
        needle = f"-{agent_session_id}.jsonl"
        try:
            path = next(self.sessions_root.rglob(f"rollout-*{needle}"), None)
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
                        return self._cache_session_title(agent_session_id, str(payload["thread_name"]).strip())
                    if first_prompt is None and payload.get("type") == "user_message":
                        first_prompt = str(payload.get("message", "")).strip()
        except OSError:
            return None
        if not first_prompt:
            return None
        markdown_match = re.search(r"(?:^|[/\s])([A-Za-z0-9][A-Za-z0-9_.-]*\.md)\b", first_prompt)
        if markdown_match:
            return self._cache_session_title(agent_session_id, Path(markdown_match.group(1)).stem)
        compact = re.sub(r"\s+", " ", first_prompt)
        return self._cache_session_title(agent_session_id, compact[:56].rstrip() + ("…" if len(compact) > 56 else ""))

    def session_is_active(self, agent_session_id: str | None) -> bool:
        if not agent_session_id:
            return False
        path = self.transcript_path(None, agent_session_id)
        if path is None:
            return False
        try:
            with path.open("rb") as handle:
                handle.seek(0, 2)
                handle.seek(max(0, handle.tell() - self.ACTIVITY_TAIL_BYTES))
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

    def session_id_for_reference(self, reference: str) -> str | None:
        """Resolve a Codex UUID or saved thread name to the UUID accepted by resume."""
        reference = reference.strip()
        if not reference:
            return None
        try:
            mtime_ns = self.SESSION_INDEX_FILE.stat().st_mtime_ns
        except OSError:
            return None
        if mtime_ns != self._index_mtime_ns:
            self.thread_name("__refresh__")
        if UUID_RE.fullmatch(reference):
            if reference in self._thread_names:
                return reference
            try:
                return reference if next(self.sessions_root.rglob(f"rollout-*{reference}.jsonl"), None) else None
            except OSError:
                return None
        matches = [session_id for session_id, name in self._thread_names.items() if name == reference]
        return matches[-1] if matches else None

    # -- activity / processing ---------------------------------------------

    ACTIVITY_FALLBACK_CHECK_SECONDS = 1.0

    def new_session_state(self) -> CodexSessionState:
        return CodexSessionState()

    def is_processing(self, ms) -> bool:
        return bool(ms.processing or ms.agent_state.transcript_active)

    def activity_signature(self, manager, ms) -> tuple[int | None, int, int] | None:
        if not ms.record.agent_session_id:
            return None
        path = self.transcript_path(None, ms.record.agent_session_id)
        if path is None:
            return None
        try:
            stat = path.stat()
        except OSError:
            return None
        return getattr(stat, "st_ino", None), stat.st_size, stat.st_mtime_ns

    def refresh_persisted_activity(self, manager, ms) -> None:
        ms.agent_state.transcript_active = self.session_is_active(ms.record.agent_session_id)
        ms.agent_state.activity_signature = self.activity_signature(manager, ms)

    def refresh_activity_for_status(self, manager, ms) -> None:
        # Fallback poll: FSEvents can drop appends to a rollout Codex keeps open, so a signature
        # change observed at status time re-derives the active flag from the transcript tail.
        if not ms.running or not ms.agent_state.transcript_active or not ms.record.agent_session_id:
            return
        now = time.monotonic()
        if now - ms.agent_state.activity_checked_monotonic < self.ACTIVITY_FALLBACK_CHECK_SECONDS:
            return
        ms.agent_state.activity_checked_monotonic = now
        signature = self.activity_signature(manager, ms)
        if signature is None or signature == ms.agent_state.activity_signature:
            return
        ms.agent_state.activity_signature = signature
        ms.agent_state.transcript_active = self.session_is_active(ms.record.agent_session_id)
        manager._sync_processing_started(ms)

    def on_transcript_event(self, manager, ms, path: Path) -> None:
        if not path.name.endswith(f"-{ms.record.agent_session_id}.jsonl"):
            return
        previous = manager._processing_state(ms)
        ms.agent_state.transcript_active = self.session_is_active(ms.record.agent_session_id)
        ms.agent_state.activity_signature = self.activity_signature(manager, ms)
        if manager._processing_state(ms) != previous:
            manager._broadcast_status(ms)

    def session_title(self, tracker, cwd: Path, agent_session_id: str | None) -> str | None:
        return self.stored_session_title(agent_session_id)

    # -- input / rename / detection ----------------------------------------

    def pre_write_input(self, manager, ms, text: str, draft_before: str) -> None:
        if "\r" not in text and "\n" not in text:
            return
        command = self.submitted_command(text, draft_before)
        if command.lower().startswith("/rename") and (len(command) == 7 or command[7].isspace()):
            candidate = command[7:].strip()
            if candidate:
                ms.agent_state.pending_rename = candidate
                ms.agent_state.pending_rename_deadline = time.monotonic() + 30.0
        submitted = text in {"\r", "\n"} and bool(command) and not command.startswith("/")
        if submitted and not ms.agent_state.transcript_active:
            ms.agent_state.transcript_active = True
            ms.agent_state.activity_signature = self.activity_signature(manager, ms)
            ms.agent_state.activity_checked_monotonic = time.monotonic()
            manager._broadcast_status(ms)

    def on_api_prompt_submitted(self, manager, ms, queue: bool) -> None:
        if not queue:
            ms.agent_state.transcript_active = True
            manager._broadcast_status(ms)

    def _before_send_rename(self, ms, title: str) -> None:
        ms.agent_state.pending_rename = title
        ms.agent_state.pending_rename_deadline = time.monotonic() + 30.0

    def reconcile_rename(self, manager, ms, previous_title: str | None) -> bool:
        """Persist a Codex `/rename` after its durable index and OSC title agree.

        The terminal confirmation text is presentation output and is not parsed.
        A pending command supplies the expected name; the OSC transition also
        lets us recover a rename that was entered before this listener existed.
        """
        if not ms.record.agent_session_id:
            return False
        candidate = self.thread_name(ms.record.agent_session_id)
        if not candidate:
            return False
        live_title = manager._display_title(ms.cli_title)
        old_live_title = manager._display_title(previous_title)
        expected = ms.agent_state.pending_rename
        expected_matches = bool(expected and candidate == expected and live_title == expected)
        transition_matches = bool(old_live_title and live_title and old_live_title != live_title and
                                  candidate == live_title and ms.record.title == old_live_title)
        if not expected_matches and not transition_matches:
            if ms.agent_state.pending_rename and time.monotonic() >= ms.agent_state.pending_rename_deadline:
                ms.agent_state.pending_rename = None
            return False
        ms.agent_state.pending_rename = None
        if ms.record.title == candidate:
            return False
        ms.record.title = candidate
        ms.record.title_user_set = True
        manager._persist()
        return True

    def on_agent_session_bound(self, manager, ms) -> None:
        if ms.cli_title is None:
            ms.cli_title = self.stored_session_title(ms.record.agent_session_id)
        ms.agent_state.transcript_active = self.session_is_active(ms.record.agent_session_id)
        ms.agent_state.activity_signature = self.activity_signature(manager, ms)

    def _ensure_searchable_scrollback(self, parts: list[str]) -> list[str]:
        # The alternate screen keeps output out of scrollback; TermDeck needs it searchable.
        if self.NO_ALT_SCREEN_FLAG in parts:
            return parts
        command_index = next((index for index, token in enumerate(parts)
                              if Path(token).name == self.executable), None)
        if command_index is None:
            return parts
        return [*parts[:command_index + 1], self.NO_ALT_SCREEN_FLAG, *parts[command_index + 1:]]
