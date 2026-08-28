import asyncio
import json
import os
import re
import shlex
import time
from pathlib import Path
from typing import Iterable

from termdeck.agents.base import UUID_RE, AgentCli, AgentSessionState
from termdeck.config import TermdeckConfig
from termdeck.proc_tree import ProcTreeSnapshot
from termdeck.transcript_turns import TurnBuilder
from termdeck.util import TimeUtil


class ClaudeSessionState(AgentSessionState):
    def __init__(self) -> None:
        self.subagent_states: dict[Path, bool] = {}
        self.activity_signatures: dict[Path, tuple[int, int, int]] = {}
        self.subagents_active = False
        self.main_active = False
        self.background_tasks: dict[str, str] = {}  # task id -> output file path
        self.monitor_tasks: dict[str, str] = {}     # monitor task id -> output file path
        self.background_scan_offset = 0             # transcript bytes already scanned


class ClaudeCli(AgentCli):
    kind = "claude"
    executable = "claude"
    label = "Claude"

    sessions_root = Path.home() / ".claude" / "projects"
    RESUME_FLAG = "--resume"
    FORK_FLAG = "--fork-session"
    NAME_FLAG = "--name"
    RESTART_REPAINT_DELAY_SECONDS = 1.5
    history_indexed = True
    # ClaudeActivityWatcher already watches the projects tree recursively; registering the same
    # root with the transcript service's FSEvents observer would double-register it on macOS.
    has_own_transcript_watcher = True

    # Measured: with the conversation inside the screen, /compact erased it and the buffer stayed
    # pinned at the screen height; once the conversation outgrew the screen the same compact left it
    # alone and the buffer grew. 40 keeps a redraw's reach to roughly what a normal terminal allows.
    # Set to 0 to hand claude the tall terminal again.
    max_terminal_rows = 40

    supports_resume = True
    supports_fork = True
    fork_tracks_parent = True
    canonical_resume_command = True
    records_raw_replay = True
    supports_agent_rename = True
    accepts_session_ref = True

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
    icon_svg = ('<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1.25c.42 0 '
                '.76.34.76.76v4.08l3.53-2.04a.76.76 0 1 1 .76 1.31L9.52 7.4l3.53 2.04a.76.76 0 1 1-.76 '
                '1.31L8.76 8.72v4.08a.76.76 0 0 1-1.52 0V8.72l-3.53 2.04a.76.76 0 1 1-.76-1.31L6.48 7.4 '
                '2.95 5.36a.76.76 0 1 1 .76-1.31l3.53 2.04V2.01c0-.42.34-.76.76-.76Z"/></svg>')

    subagent_file_marker = b'"isSidechain":true'

    def new_session_resume_arguments(self, session_ref: str, tracker) -> tuple[str, ...]:
        return (self.RESUME_FLAG, session_ref)

    def project_dir(self, cwd: Path) -> Path:
        munged = "".join(ch if ch.isalnum() else "-" for ch in str(cwd))
        return self.sessions_root / munged

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
        root = self.sessions_root
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

    def usage_from_payload(self, payload: dict[str, object]) -> dict[str, int | None] | None:
        if payload.get("type") != "assistant":
            return None
        message = payload.get("message")
        usage = message.get("usage") if isinstance(message, dict) else None
        if not isinstance(usage, dict):
            return None
        def count(key: str) -> int:
            value = usage.get(key)
            return int(value) if isinstance(value, (int, float)) else 0
        return {
            # The prompt side of the newest request is the live context: fresh input plus
            # everything served from or written to the prompt cache.
            "context_tokens": count("input_tokens") + count("cache_creation_input_tokens") +
                              count("cache_read_input_tokens"),
            "output_tokens": count("output_tokens"),
            "context_window": None,
            "total_tokens": None,
        }

    # -- activity / processing ---------------------------------------------

    def new_session_state(self) -> ClaudeSessionState:
        return ClaudeSessionState()

    def is_processing(self, ms) -> bool:
        if ms.record.agent_session_id:
            # ms.processing (a spinner in the OSC title, refreshed within the last few seconds) is ORed in
            # because Claude does work that writes nothing to the transcript: /compact spins for the whole
            # compaction and only appends once it finishes, so transcript-only detection reports the tab as
            # idle throughout. An idle Claude stops rewriting its title, so the freshness window keeps this
            # from latching on.
            return not ms.record.claude_interrupted and \
                (ms.agent_state.main_active or ms.agent_state.subagents_active or ms.processing)
        return bool(ms.processing or ms.agent_state.main_active or ms.agent_state.subagents_active)

    def refresh_persisted_activity(self, manager, ms) -> None:
        self.initialize_subagent_state(manager, ms)

    def activity_detail(self, ms) -> dict[str, object] | None:
        if not ms.record.agent_session_id:
            return None
        state = ms.agent_state
        return {"main": bool(state.main_active and not ms.record.claude_interrupted),
                "subagents": sum(1 for active in state.subagent_states.values() if active),
                "background_jobs": len(state.background_tasks),
                "monitors": len(state.monitor_tasks)}

    _BACKGROUND_LAUNCH_PREFIX = "Command running in background with ID:"
    _BACKGROUND_LAUNCH_RE = re.compile(r"Command running in background with ID: (\w+)")
    _BACKGROUND_OUTPUT_RE = re.compile(r"Output is being written to: (\S+\.output)")
    _MONITOR_LAUNCH_PREFIX = "Monitor started (task "
    _MONITOR_LAUNCH_RE = re.compile(r"Monitor started \(task (\w+)")
    _TASK_NOTIFICATION_ID_RE = re.compile(r"<task-id>([\w-]+)</task-id>")

    def scan_background_tasks(self, state, parent: Path) -> bool:
        """Track claude's backgrounded shell tasks from the parent transcript; returns True on change.

        Launch tool_results and completion task-notifications both land in the main transcript,
        so the transcript watcher's own change events keep this current without polling. Only
        bytes appended since the previous scan are read; offset 0 (or a shrunk file) means a
        full reconstruction, where each surviving task is verified against its output file --
        the harness appends "[exited with code N]" there, which catches every task that ended
        while nobody was watching (server downtime, killed CLI)."""
        try:
            size = parent.stat().st_size
        except OSError:
            changed = bool(state.background_tasks or state.monitor_tasks)
            state.background_tasks = {}
            state.monitor_tasks = {}
            state.background_scan_offset = 0
            return changed
        full_scan = state.background_scan_offset == 0 or state.background_scan_offset > size
        offset = 0 if full_scan else state.background_scan_offset
        before = (dict(state.background_tasks), dict(state.monitor_tasks))
        tasks: dict[str, str] = {} if full_scan else dict(state.background_tasks)
        monitors: dict[str, str] = {} if full_scan else dict(state.monitor_tasks)
        try:
            with parent.open("rb") as fh:
                fh.seek(offset)
                data = fh.read()
        except OSError:
            return False
        if data and not data.endswith(b"\n"):
            # A line caught mid-write stays unscanned until its newline lands.
            data = data[:data.rfind(b"\n") + 1]
        state.background_scan_offset = offset + len(data)
        known_before_scan = set(tasks) | set(monitors)
        for raw in data.split(b"\n"):
            if b"Command running in background with ID" in raw:
                self._record_background_launch(raw, tasks)
            if b"Monitor started (task " in raw:
                self._record_monitor_launch(raw, monitors, parent)
            if b"<task-notification>" in raw:
                self._remove_notified_background_tasks(raw, tasks, monitors)
            # TaskStop kills a task without a completion notification; its tool_use lives in
            # an assistant event.
            if b'"TaskStop"' in raw:
                self._drop_stopped_background_task(raw, tasks, monitors)
        # The transcript alone under-reports endings (a kill leaves no notification, and
        # compaction can drop one), so every task tracked before this scan is re-verified
        # against its output file. A task first seen in this incremental scan is exempt:
        # its output file may not exist yet.
        def still_running(task_id: str, output: str) -> bool:
            if not full_scan and task_id not in known_before_scan:
                return True
            return bool(output) and not self._background_task_finished(Path(output))
        state.background_tasks = {task_id: output for task_id, output in tasks.items()
                                  if still_running(task_id, output)}
        state.monitor_tasks = {task_id: output for task_id, output in monitors.items()
                               if still_running(task_id, output)}
        return (state.background_tasks, state.monitor_tasks) != before

    @staticmethod
    def _user_event_content(raw: bytes):
        """message.content of a user-type transcript event, or None for anything else."""
        try:
            event = json.loads(raw)
        except ValueError:
            return None
        if not isinstance(event, dict) or event.get("type") != "user":
            return None
        return (event.get("message") or {}).get("content")

    def _record_background_launch(self, raw: bytes, tasks: dict[str, str]) -> None:
        # Only a tool_result whose text STARTS with the launch phrase counts -- the same words
        # quoted in conversation text (echoed output, summaries) must not resurrect a task.
        content = self._user_event_content(raw)
        for part in content if isinstance(content, list) else []:
            if not isinstance(part, dict) or part.get("type") != "tool_result":
                continue
            text = part.get("content")
            if isinstance(text, list):
                text = " ".join(p.get("text", "") for p in text if isinstance(p, dict))
            if not isinstance(text, str) or not text.startswith(self._BACKGROUND_LAUNCH_PREFIX):
                continue
            match = self._BACKGROUND_LAUNCH_RE.search(text)
            output = self._BACKGROUND_OUTPUT_RE.search(text)
            if match:
                tasks[match.group(1)] = output.group(1) if output else ""

    def _record_monitor_launch(self, raw: bytes, monitors: dict[str, str], parent: Path) -> None:
        # The Monitor launch result names no output file; its path follows the task-output
        # convention (same tasks dir every other task of this agent session uses), derived
        # from the transcript path's project dir + session id.
        content = self._user_event_content(raw)
        for part in content if isinstance(content, list) else []:
            if not isinstance(part, dict) or part.get("type") != "tool_result":
                continue
            text = part.get("content")
            if isinstance(text, list):
                text = " ".join(p.get("text", "") for p in text if isinstance(p, dict))
            if not isinstance(text, str) or not text.startswith(self._MONITOR_LAUNCH_PREFIX):
                continue
            match = self._MONITOR_LAUNCH_RE.search(text)
            if match:
                monitors[match.group(1)] = str(self._task_output_path(parent, match.group(1)))

    @staticmethod
    def _task_output_path(parent: Path, task_id: str) -> Path:
        return (Path("/tmp") / f"claude-{os.getuid()}"
                / parent.parent.name / parent.stem / "tasks" / f"{task_id}.output")

    def _remove_notified_background_tasks(self, raw: bytes, tasks: dict[str, str],
                                          monitors: dict[str, str]) -> None:
        # Notifications land as queue-operation events (top-level content) and again as user
        # events on delivery. Only a terminal notification carries a <status> tag -- a Monitor
        # event notification reuses the same task-id without one and must not end the task.
        try:
            event = json.loads(raw)
        except ValueError:
            return
        if not isinstance(event, dict):
            return
        if event.get("type") == "queue-operation":
            content = event.get("content")
        elif event.get("type") == "user":
            content = (event.get("message") or {}).get("content")
        else:
            return
        if isinstance(content, list):
            content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
        if not isinstance(content, str) or "<task-notification>" not in content or "<status>" not in content:
            return
        for task_id in self._TASK_NOTIFICATION_ID_RE.findall(content):
            tasks.pop(task_id, None)
            monitors.pop(task_id, None)

    def _drop_stopped_background_task(self, raw: bytes, tasks: dict[str, str],
                                      monitors: dict[str, str]) -> None:
        try:
            event = json.loads(raw)
        except ValueError:
            return
        if not isinstance(event, dict) or event.get("type") != "assistant":
            return
        content = (event.get("message") or {}).get("content")
        for part in content if isinstance(content, list) else []:
            if isinstance(part, dict) and part.get("type") == "tool_use" and part.get("name") == "TaskStop":
                task_id = (part.get("input") or {}).get("task_id")
                if isinstance(task_id, str):
                    tasks.pop(task_id, None)
                    monitors.pop(task_id, None)

    @staticmethod
    def _background_task_finished(output: Path) -> bool:
        try:
            with output.open("rb") as fh:
                fh.seek(max(0, output.stat().st_size - 256))
                tail = fh.read()
        except OSError:
            return True  # output file cleaned up -> the task is long gone
        return b"[exited with code" in tail or b"[killed]" in tail

    def initialize_subagent_state(self, manager, ms) -> None:
        if not ms.record.agent_session_id:
            return
        tracker = manager._tracker
        parent = tracker.claude_project_dir(Path(ms.record.cwd)) / f"{ms.record.agent_session_id}.jsonl"
        ms.agent_state.main_active = not ms.record.claude_interrupted and parent.is_file() and tracker.claude_session_is_active(parent)
        states = tracker.claude_subagent_states(Path(ms.record.cwd), ms.record.agent_session_id)
        ms.agent_state.subagent_states = states
        ms.agent_state.subagents_active = not ms.record.claude_interrupted and any(states.values())
        ms.agent_state.activity_signatures = self._activity_signatures(parent, set(states))
        ms.agent_state.background_scan_offset = 0
        self.scan_background_tasks(ms.agent_state, parent)

    @staticmethod
    def _file_signature(path: Path) -> tuple[int, int, int] | None:
        try:
            stat = path.stat()
        except OSError:
            return None
        return getattr(stat, "st_ino", 0), stat.st_size, stat.st_mtime_ns

    def _activity_signatures(self, parent: Path, subagents: set[Path]) -> dict[Path, tuple[int, int, int]]:
        signatures: dict[Path, tuple[int, int, int]] = {}
        for path in {parent, *subagents}:
            signature = self._file_signature(path)
            if signature is not None:
                signatures[path] = signature
        return signatures

    def refresh_activity_for_status(self, manager, ms) -> None:
        if not ms.record.agent_session_id:
            return
        tracker = manager._tracker
        project_dir = tracker.claude_project_dir(Path(ms.record.cwd))
        parent = project_dir / f"{ms.record.agent_session_id}.jsonl"
        subagent_dir = project_dir / ms.record.agent_session_id / "subagents"
        try:
            subagents = set(subagent_dir.glob("*.jsonl"))
        except OSError:
            subagents = set()
        signatures = self._activity_signatures(parent, subagents)
        if signatures == ms.agent_state.activity_signatures:
            return
        ms.agent_state.main_active = not ms.record.claude_interrupted and parent.is_file() and tracker.claude_session_is_active(parent)
        ms.agent_state.subagent_states = tracker.claude_subagent_states(Path(ms.record.cwd), ms.record.agent_session_id)
        ms.agent_state.subagents_active = not ms.record.claude_interrupted and any(ms.agent_state.subagent_states.values())
        ms.agent_state.activity_signatures = self._activity_signatures(parent, set(ms.agent_state.subagent_states))
        self.scan_background_tasks(ms.agent_state, parent)

    def on_project_file_change(self, manager, path: Path) -> None:
        """Update the parent or subagent state that generated a filesystem event under the projects tree."""
        tracker = manager._tracker
        for ms in manager._sessions.values():
            if ms.record.agent_kind != self.kind or not ms.record.agent_session_id:
                continue
            parent = tracker.claude_project_dir(Path(ms.record.cwd)) / f"{ms.record.agent_session_id}.jsonl"
            subagents = tracker.claude_project_dir(Path(ms.record.cwd)) / ms.record.agent_session_id / "subagents"
            is_parent = path == parent
            try:
                is_subagent = path.is_relative_to(subagents)
                if not is_parent and not is_subagent:
                    continue
            except ValueError:
                continue
            previous_processing = manager._processing_state(ms)
            title_changed = False
            attention_changed = False
            background_changed = False
            if is_parent:
                ms.agent_state.main_active = not ms.record.claude_interrupted and path.is_file() and tracker.claude_session_is_active(path)
                title_changed = self.sync_explicit_title(manager, ms)
                attention_changed = self._refresh_attention_from_transcript(manager, ms)
                background_changed = self.scan_background_tasks(ms.agent_state, path)
            elif path.is_file():
                ms.agent_state.subagent_states[path] = tracker.claude_subagent_is_active(path)
            else:
                ms.agent_state.subagent_states.pop(path, None)
            ms.agent_state.subagents_active = not ms.record.claude_interrupted and any(ms.agent_state.subagent_states.values())
            ms.agent_state.activity_signatures = self._activity_signatures(parent, set(ms.agent_state.subagent_states))
            current_processing = manager._processing_state(ms)
            if current_processing != previous_processing:
                manager._broadcast_processing(ms, current_processing)
            if current_processing != previous_processing or title_changed or attention_changed or background_changed:
                manager._broadcast_status(ms)

    # -- bindings / titles -------------------------------------------------

    async def reconcile_bindings(self, manager, ms, proc_tree) -> None:
        self._reconcile_live_binding(manager, ms, proc_tree)
        self.reconcile_stale_binding(manager, ms)

    def _reconcile_live_binding(self, manager, ms, proc_tree) -> bool:
        if not ms.detached_live:
            return False
        tracker = manager._tracker
        candidate = tracker.claude_resume_session_id_from_process_arguments(
            manager._dtach_socket(ms.record.session_id), proc_tree)
        if not candidate or candidate == ms.record.agent_session_id or candidate in manager._claimed_agent_ids(ms):
            return False
        cwd = Path(ms.record.cwd)
        candidate_activity = tracker.session_activity_timestamp(self.kind, cwd, candidate)
        current_activity = tracker.session_activity_timestamp(self.kind, cwd, ms.record.agent_session_id)
        if candidate_activity <= current_activity:
            return False
        manager._set_agent_session_binding(ms, candidate)
        self.initialize_subagent_state(manager, ms)
        return True

    def reconcile_stale_binding(self, manager, ms) -> bool:
        if not ms.record.agent_session_id or not ms.cli_title:
            return False
        tracker = manager._tracker
        cwd = Path(ms.record.cwd)
        current_path = tracker.claude_project_dir(cwd) / f"{ms.record.agent_session_id}.jsonl"
        try:
            current_mtime = current_path.stat().st_mtime
        except OSError:
            current_mtime = 0.0
        created_at = TimeUtil.est_naive_iso_timestamp(ms.record.created_at_est)
        live_title = manager._display_title(ms.cli_title)
        current_explicit_title = tracker.claude_explicit_session_title(cwd, ms.record.agent_session_id)
        normalized_live_title = tracker._normalized_claude_title(live_title)
        normalized_record_title = tracker._normalized_claude_title(ms.record.title)
        normalized_current_title = tracker._normalized_claude_title(current_explicit_title)
        renamed_title_points_to_another_transcript = ms.record.title_user_set and normalized_live_title and \
            normalized_record_title == normalized_live_title and normalized_current_title != normalized_live_title
        if current_mtime >= created_at and not renamed_title_points_to_another_transcript:
            return False
        replacement = tracker.claude_session_id_for_explicit_title(
            cwd, live_title, created_at, manager._claimed_agent_ids(ms))
        if replacement is None or replacement == ms.record.agent_session_id:
            return False
        manager._set_agent_session_binding(ms, replacement)
        self.initialize_subagent_state(manager, ms)
        manager._persist()
        return True

    def reconcile_metadata(self, manager, ms) -> None:
        self.sync_explicit_title(manager, ms)

    def sync_explicit_title(self, manager, ms) -> bool:
        if not ms.record.agent_session_id:
            return False
        explicit_title = manager._tracker.claude_explicit_session_title(Path(ms.record.cwd), ms.record.agent_session_id)
        if not explicit_title or (manager._display_title(ms.cli_title) == explicit_title and ms.record.title == explicit_title):
            return False
        ms.cli_title = explicit_title
        ms.title_updated_monotonic = time.monotonic()
        ms.record.title = explicit_title
        ms.record.title_user_set = True
        manager._remember_cli_title(ms)
        manager._persist()
        return True

    def on_cli_title_updated(self, manager, ms) -> None:
        self.reconcile_stale_binding(manager, ms)
        if ms.record.agent_session_id is None:
            manager._schedule_detection(ms, 0.1)

    def session_title(self, tracker, cwd: Path, agent_session_id: str | None) -> str | None:
        return tracker.claude_session_title(cwd, agent_session_id)

    # -- input / rename / spawn / detection --------------------------------

    def pre_write_input(self, manager, ms, text: str, draft_before: str) -> None:
        # Escape cancels a Claude turn exactly as Ctrl-C does, and it is the key people actually use.
        # Only Ctrl-C counted before, so a cancelled prompt left the tab spinning forever: the last
        # transcript event is the user's prompt with nothing after it, Claude writes no interruption
        # marker when it never began answering, and the activity scan reads a trailing user prompt as
        # work in progress. Measured on a live session stuck "processing" with an idle CLI.
        # A bare Escape only -- "\x1b[" prefixes are arrow keys and the like, not a cancel.
        interrupted = "\x03" in text or text == "\x1b"
        submitted = False
        if "\r" in text or "\n" in text:
            command = self.submitted_command(text, draft_before)
            submitted = text in {"\r", "\n"} and bool(command)
        previous_processing = manager._processing_state(ms)
        if interrupted:
            ms.record.claude_interrupted = True
            ms.agent_state.main_active = False
            ms.agent_state.subagents_active = False
            ms.agent_state.subagent_states = {}
        elif submitted:
            ms.record.claude_interrupted = False
            ms.agent_state.main_active = True
            ms.last_agent_submit_monotonic = time.monotonic()
        current_processing = manager._processing_state(ms)
        if current_processing != previous_processing:
            manager._sync_processing_started(ms, current_processing)
            manager._broadcast_status(ms)
        if interrupted or submitted:
            manager._persist()

    async def rename_after_fork(self, manager, ms, title: str) -> None:
        await self.send_rename(manager, ms, title,
                               ready_delay=TermdeckConfig.FORK_RENAME_READY_DELAY_SECONDS,
                               clear_composer=True)
        await self._wait_for_session_title(manager, ms, title)

    async def _wait_for_session_title(self, manager, ms, expected_title: str) -> None:
        normalized_title = " ".join(str(expected_title or "").splitlines()).strip()
        tracker = manager._tracker
        for _ in range(20):
            await asyncio.sleep(0.5)
            tracker.invalidate_claude_session_title(Path(ms.record.cwd), ms.record.agent_session_id)
            actual_title = tracker.claude_session_title(Path(ms.record.cwd), ms.record.agent_session_id)
            if actual_title != normalized_title:
                continue
            if ms.cli_title != actual_title:
                ms.cli_title = actual_title
                ms.title_updated_monotonic = time.monotonic()
                manager._remember_cli_title(ms)
                manager._broadcast_status(ms)
            return

    def before_spawn(self, manager, ms) -> None:
        self.reconcile_stale_binding(manager, ms)

    def on_spawned(self, manager, ms) -> None:
        if ms.record.agent_session_id:
            self.initialize_subagent_state(manager, ms)

    def restart_screen_repaint_delay(self, raw_replay_enabled: bool) -> float | None:
        return self.RESTART_REPAINT_DELAY_SECONDS if raw_replay_enabled else None

    def restart_permission(self, manager, ms) -> str:
        return manager._tracker.claude_session_permission_mode(
            Path(ms.record.cwd), ms.record.agent_session_id) or ""

    async def verify_detected_session_id(self, manager, ms, found: str | None, socket: Path) -> str | None:
        # A concurrent Claude in the same cwd can hold this terminal's rollout open; trust a
        # different id than the current binding only when the process arguments confirm it.
        existing = ms.record.agent_session_id
        if existing and found not in {None, existing}:
            resumed = manager._tracker.claude_resume_session_id_from_process_arguments(
                socket, await ProcTreeSnapshot.capture())
            if resumed != found:
                return None
        return found

    def detection_fallback_session_id(self, manager, ms, claimed: set[str]) -> str | None:
        if ms.record.agent_session_id is not None or ms.last_agent_submit_monotonic <= 0:
            return None
        elapsed = time.monotonic() - ms.last_agent_submit_monotonic
        if elapsed >= TermdeckConfig.AGENT_DIR_CLAIM_INPUT_WINDOW_SECONDS:
            return None
        submitted_at = time.time() - elapsed
        return manager._tracker.claude_session_id_from_recent_file_activity(
            Path(ms.record.cwd), submitted_at, claimed)

    def on_agent_session_bound(self, manager, ms) -> None:
        self.initialize_subagent_state(manager, ms)
        if ms.cli_title is None:
            ms.cli_title = manager._tracker.claude_session_title(Path(ms.record.cwd), ms.record.agent_session_id)

    # -- attention ---------------------------------------------------------

    ATTENTION_TEXT_CARRY_CHARS = 4096
    # Matched against text with ALL whitespace removed. Claude lays these boxes out with cursor-movement
    # escapes rather than literal spaces, so once the escapes are stripped the words run together --
    # measured on a live prompt, the footer arrives as "entertoselect·↑/↓tonavigate·esctocancel" and a
    # spaced marker like "esc to cancel" cannot match it. Squashing both sides matches either rendering.
    #
    # A group is an AND; the groups are an OR. Two prompts wait on the user and neither is the other:
    # the plan/permission approval ends in "tab to amend", while a question (AskUserQuestion) offers a
    # numbered list ending in "enter to select". Requiring the amend marker for everything is why a tab
    # sitting on a question never raised its attention badge.
    ATTENTION_MARKER_GROUPS = (("esctocancel", "tabtoamend"), ("entertoselect", "esctocancel"))
    # Long enough to swallow the repaint a keystroke causes, short enough that a question appearing a
    # moment after the user submits still lights up. Keyed on real keystrokes (see
    # TerminalSessionManager.user_recently_typed); an earlier version keyed on all terminal input,
    # which never went quiet and suppressed the badge entirely.
    ATTENTION_TYPING_QUIET_SECONDS = 1.0
    ATTENTION_TITLE_MARKERS = ("request permission", "waiting for permission", "permission required", "needs input")

    def title_requires_attention(self, title: str | None) -> bool:
        if not title:
            return False
        normalized = re.sub(r"\s+", " ", title).strip().lower()
        return any(marker in normalized for marker in self.ATTENTION_TITLE_MARKERS)

    def transcript_requires_attention(self, manager, ms) -> bool:
        if not ms.record.agent_session_id:
            return False
        title, has_pending_tool = manager._tracker.claude_attention_state(Path(ms.record.cwd), ms.record.agent_session_id)
        return has_pending_tool and self.title_requires_attention(title)

    def update_attention_from_title(self, manager, ms, title: str | None) -> bool:
        if not self.title_requires_attention(title) or ms.attention_required:
            return False
        if not self.transcript_requires_attention(manager, ms):
            return False
        ms.attention_required = True
        return True

    def _refresh_attention_from_transcript(self, manager, ms) -> bool:
        if ms.attention_hook_driven or not ms.record.agent_session_id:
            return False
        title, has_pending_tool = manager._tracker.claude_attention_state(Path(ms.record.cwd), ms.record.agent_session_id)
        requires_attention = has_pending_tool and self.title_requires_attention(title)
        if ms.attention_required == requires_attention:
            return False
        ms.attention_required = requires_attention
        if not requires_attention:
            ms.attention_text_carry = ""
        return True

    def update_attention_from_output(self, manager, ms, data: bytes) -> bool:
        text = manager._searchable_terminal_text(data)
        if not text:
            return False
        # Whitespace removed rather than collapsed -- see ATTENTION_MARKER_GROUPS for why. The carry is
        # kept in the same squashed form so a marker split across two writes still joins up.
        carry = ms.attention_text_carry
        normalized = re.sub(r"\s+", "", f"{carry}{text}").lower()
        ms.attention_text_carry = normalized[-self.ATTENTION_TEXT_CARRY_CHARS:]
        if ms.attention_required:
            return False
        # A prompt stays on the screen after it is answered or cancelled, and every repaint re-sends it.
        # Matching anywhere in the carry therefore re-arms attention forever: keystroke clears it (see
        # write_input), the repaint that keystroke causes re-arms it, and the badge restarts its
        # animation on every character typed. Requiring the match to REACH INTO this write means an
        # inherited copy alone cannot re-arm it, while a marker split across two writes still joins.
        boundary = len(carry)
        if not any(all(marker in normalized for marker in group) and
                   any(normalized.rfind(marker) + len(marker) > boundary for marker in group)
                   for group in self.ATTENTION_MARKER_GROUPS):
            return False
        # Nor while the user is typing into that very prompt: they are looking straight at it, and a
        # badge that lights up between keystrokes is pure noise.
        if manager.user_recently_typed(ms, self.ATTENTION_TYPING_QUIET_SECONDS):
            return False
        ms.attention_required = True
        return True

    def resume_command(self, original_command: str, agent_session_id: str) -> str:
        cleaned = self.strip_flag_with_value(self.command_parts(original_command),
                                             self.RESUME_FLAG)
        if not cleaned:
            cleaned = [self.executable]
        return f"{shlex.join(cleaned)} {self.RESUME_FLAG} {agent_session_id}"

    def fork_command(self, original_command: str, agent_session_id: str, session_name: str = "") -> str:
        cleaned = self.strip_flag_with_value(self.command_parts(original_command),
                                             self.RESUME_FLAG)
        cleaned = self.strip_flag_with_value(cleaned, self.NAME_FLAG)
        if not cleaned:
            cleaned = [self.executable]
        cleaned.extend((self.RESUME_FLAG, agent_session_id, self.FORK_FLAG))
        if session_name.strip():
            cleaned.extend((self.NAME_FLAG, " ".join(session_name.splitlines()).strip()))
        return shlex.join(cleaned)
