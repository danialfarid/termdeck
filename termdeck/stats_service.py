import asyncio
import os

from termdeck.config import TermdeckConfig
from termdeck.proc_tree import ProcTreeUtil


class ResourceStatsService:
    """Samples rss/cpu for the app (server process tree) and for each terminal. With dtach the agent CLI runs
    under a daemonized master identified by its socket path in the command line, so per-terminal totals sum the
    process subtree seeded by whichever processes carry that socket path."""

    async def sample(self, session_sockets: dict[str, str]) -> dict[str, object]:
        proc = await asyncio.create_subprocess_exec(TermdeckConfig.PS_BIN, "-axo", "pid=,ppid=,rss=,pcpu=,command=",
                                                    stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.DEVNULL)
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=TermdeckConfig.SUBPROCESS_TIMEOUT_SECONDS)
        rows: list[tuple[int, int, int, float, str]] = []
        for line in stdout.decode().splitlines():
            parts = line.split(None, 4)
            if len(parts) == 5:
                rows.append((int(parts[0]), int(parts[1]), int(parts[2]), float(parts[3]), parts[4]))
        ppid_rows = [(pid, ppid) for pid, ppid, _, _, _ in rows]
        rss_by_pid = {pid: rss for pid, _, rss, _, _ in rows}
        cpu_by_pid = {pid: cpu for pid, _, _, cpu, _ in rows}
        server_pids = ProcTreeUtil.descendants(ppid_rows, [os.getpid()])
        app_rss = sum(rss_by_pid.get(pid, 0) for pid in server_pids)
        app_cpu = sum(cpu_by_pid.get(pid, 0.0) for pid in server_pids)
        sessions: dict[str, dict[str, object]] = {}
        for session_id, socket_path in session_sockets.items():
            seeds = [pid for pid, _, _, _, command in rows if socket_path in command]
            tree = ProcTreeUtil.descendants(ppid_rows, seeds) if seeds else set()
            sessions[session_id] = {"rss_kb": sum(rss_by_pid.get(pid, 0) for pid in tree),
                                    "cpu": round(sum(cpu_by_pid.get(pid, 0.0) for pid in tree), 1)}
        return {"app": {"rss_kb": app_rss, "cpu": round(app_cpu, 1)}, "sessions": sessions}
