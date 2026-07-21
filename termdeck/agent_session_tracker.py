import asyncio
import json
import re
from datetime import timedelta
from pathlib import Path

from termdeck.config import TermdeckConfig
from termdeck.models import AgentKind
from termdeck.proc_tree import ProcTreeUtil
from termdeck.util import TimeUtil


class AgentSessionTracker:
    """Resolves which claude/codex CLI session a terminal is CURRENTLY on. Two signals, in order of authority:
    (1) session files held open by the terminal's process group (lsof — exact attribution; catches picker-resumes
    and in-TUI session switches); (2) session files NEWLY CREATED since the terminal spawned (covers CLIs that
    only open their file briefly per turn, e.g. claude). Grown existing files are deliberately NOT claimed:
    concurrent external sessions in the same cwd (another claude in another app) grow their files constantly and
    would be hijacked; the caller additionally gates (2) on recent terminal input for the same reason."""

    _UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    _CODEX_ROLLOUT_UUID_RE = re.compile(
        r"rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$")
    _COMMAND_SPLIT_RE = re.compile(r"[\s;|&()]+")
    _LSOF_PATH_LINE_PREFIX = "n"
    _CODEX_SUBAGENT_MARKER = b'"source":{"subagent"'
    _CLAUDE_SIDECHAIN_MARKER = b'"isSidechain":true'
    _SUBAGENT_SNIFF_BYTES = 2048

    def __init__(self) -> None:
        self._subagent_file_cache: dict[Path, bool] = {}
        self._codex_thread_names: dict[str, str] = {}
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
            return reference if reference in self._codex_thread_names else None
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
        if len(self._subagent_file_cache) > 2000:
            self._subagent_file_cache.clear()
        return is_subagent

    def detect_agent_kind(self, command: str) -> AgentKind:
        tokens = {Path(token).name for token in self._COMMAND_SPLIT_RE.split(command) if token}
        if AgentKind.CLAUDE.value in tokens:
            return AgentKind.CLAUDE
        if AgentKind.CODEX.value in tokens:
            return AgentKind.CODEX
        return AgentKind.NONE

    def claude_project_dir(self, cwd: Path) -> Path:
        munged = "".join(ch if ch.isalnum() else "-" for ch in str(cwd))
        return TermdeckConfig.CLAUDE_PROJECTS_DIR / munged

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

    def _session_id_for_path(self, kind: AgentKind, path: Path) -> str | None:
        if kind is AgentKind.CODEX and path.is_relative_to(TermdeckConfig.CODEX_SESSIONS_DIR):
            match = self._CODEX_ROLLOUT_UUID_RE.search(path.name)
            return match.group(1) if match else None
        if kind is AgentKind.CLAUDE and path.is_relative_to(TermdeckConfig.CLAUDE_PROJECTS_DIR):
            return path.stem if self._UUID_RE.match(path.stem) else None
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
        return []

    @staticmethod
    def _codex_recent_day_dirs() -> list[Path]:
        today = TimeUtil.today_est()
        days = [today + timedelta(days=offset) for offset in TermdeckConfig.CODEX_DAY_DIR_LOOKAROUND_DAYS]
        return [TermdeckConfig.CODEX_SESSIONS_DIR / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}"
                for day in days]

    def build_resume_command(self, kind: AgentKind, original_command: str, agent_session_id: str) -> str:
        if kind is AgentKind.CLAUDE:
            return f"{original_command} {TermdeckConfig.CLAUDE_RESUME_FLAG} {agent_session_id}"
        if kind is AgentKind.CODEX:
            return TermdeckConfig.CODEX_RESUME_TEMPLATE.format(agent_session_id=agent_session_id)
        return original_command

    def build_fork_command(self, kind: AgentKind, original_command: str, agent_session_id: str) -> str:
        if kind is AgentKind.CLAUDE:
            return f"{original_command} {TermdeckConfig.CLAUDE_RESUME_FLAG} {agent_session_id} {TermdeckConfig.CLAUDE_FORK_FLAG}"
        if kind is AgentKind.CODEX:
            return TermdeckConfig.CODEX_FORK_TEMPLATE.format(agent_session_id=agent_session_id)
        return original_command
