import asyncio
from pathlib import Path

from termdeck import agents
from termdeck.config import TermdeckConfig
from termdeck.proc_tree import ProcTreeSnapshot

class AgentSessionTracker:
    """Resolves which CLI session a terminal is CURRENTLY on, for any agent kind.

    Open process files are authoritative. New files are claimable only after local input, and an
    existing file is claimable only when it changed after this terminal submitted a prompt and no
    other terminal owns it, which supports in-process resume switches without attributing unrelated
    concurrent activity in the same cwd.

    Everything here is agent-agnostic: where an agent keeps its session files, what its transcripts
    mean, and how to read a title or activity out of them are all answered by the AgentCli adapter
    for that kind (see docs/agent-cli-api.md), never branched on here.
    """

    _LSOF_PATH_LINE_PREFIX = "n"
    _SUBAGENT_SNIFF_BYTES = 2048
    _SUBAGENT_FILE_CACHE_SIZE = 2000

    def __init__(self) -> None:
        self._subagent_file_cache: dict[Path, bool] = {}

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

    def snapshot_session_files(self, kind: str, cwd: Path) -> set[Path]:
        return {path for path, _ in self._candidate_session_files(kind, cwd)}

    async def session_id_from_open_files(self, kind: str, socket_path: Path) -> str | None:
        tree_pids = (await ProcTreeSnapshot.capture()).tree_pids_for_socket(str(socket_path))
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
