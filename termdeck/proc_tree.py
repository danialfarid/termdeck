import asyncio

from termdeck.config import TermdeckConfig


class ProcTreeUtil:
    """Resolves the live process tree behind a dtach socket. Because dtach daemonizes the master (holding the
    pty + the agent CLI) outside the server's process tree, the agent's pids can't be found from the server's
    child pid — they're found from the socket: lsof yields the master holding it, and a ppid walk expands to
    the shell + agent CLI descendants. Both halves are sampled machine-wide (see ProcTreeSnapshot), never
    one socket at a time."""

    @staticmethod
    async def _run(*argv: str) -> str:
        proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.DEVNULL)
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=TermdeckConfig.SUBPROCESS_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            proc.kill()
            return ""
        return stdout.decode()

    @staticmethod
    async def unix_socket_holders() -> dict[str, list[int]]:
        """Map every named unix socket on the machine to the pids holding it, in one lsof call.

        `-F pn` is lsof's machine-readable form: a `p<pid>` line opens a process, and each of its files
        follows as an `f<fd>` line plus (for a named socket) an `n<path>` line."""
        output = await ProcTreeUtil._run(TermdeckConfig.LSOF_BIN, "-U", "-Fpn")
        holders: dict[str, list[int]] = {}
        pid: int | None = None
        for line in output.splitlines():
            field, value = line[:1], line[1:]
            if field == "p":
                pid = int(value)
            elif field == "n" and pid is not None:
                holders.setdefault(value, []).append(pid)
        return holders

    @staticmethod
    def _child_map(ps_rows: list[tuple[int, int]]) -> dict[int, list[int]]:
        children: dict[int, list[int]] = {}
        for pid, ppid in ps_rows:
            children.setdefault(ppid, []).append(pid)
        return children

    @staticmethod
    def descendants(ps_rows: list[tuple[int, int]], roots: list[int]) -> set[int]:
        children = ProcTreeUtil._child_map(ps_rows)
        found = set(roots)
        frontier = list(roots)
        while frontier:
            pid = frontier.pop()
            for child in children.get(pid, []):
                if child not in found:
                    found.add(child)
                    frontier.append(child)
        return found

    @staticmethod
    async def process_table() -> list[dict[str, int | float | str]]:
        """One local-only snapshot of every process: pid/ppid drive the tree walks, the rest is reporting."""
        output = await ProcTreeUtil._run(TermdeckConfig.PS_BIN, "-axo",
                                         "pid=,ppid=,state=,pcpu=,rss=,etime=,command=")
        processes: list[dict[str, int | float | str]] = []
        for line in output.splitlines():
            parts = line.split(maxsplit=6)
            if len(parts) < 7:
                continue
            try:
                pid, ppid = int(parts[0]), int(parts[1])
                cpu, rss_kb = float(parts[3]), int(parts[4])
            except ValueError:
                continue
            processes.append({"pid": pid, "ppid": ppid, "state": parts[2], "cpu_percent": cpu,
                              "rss_kb": rss_kb, "elapsed": parts[5], "command": parts[6]})
        return processes


class ProcTreeSnapshot:
    """One machine-wide sample — every named unix socket's holders, plus the process table — answering for a
    whole sweep of sockets at once.

    lsof walks every process's open files however narrow the question is, so asking it about one socket costs
    what asking about all of them costs (~0.4s on a busy Mac). Resolving N sockets from one snapshot is
    therefore two subprocesses instead of 2N: startup's reconcile of ~90 saved sessions drops from ~57s of
    serialized `lsof` to ~0.2s, all of it in front of the port the browser is waiting on."""

    def __init__(self, socket_holders: dict[str, list[int]],
                 processes: list[dict[str, int | float | str]]) -> None:
        self._socket_holders = socket_holders
        self._processes = processes
        self._ppid_rows = [(int(process["pid"]), int(process["ppid"])) for process in processes]

    @staticmethod
    async def capture() -> "ProcTreeSnapshot":
        holders, processes = await asyncio.gather(ProcTreeUtil.unix_socket_holders(),
                                                  ProcTreeUtil.process_table())
        return ProcTreeSnapshot(holders, processes)

    @property
    def sampled_sockets(self) -> int:
        """How many named unix sockets the sample saw. Zero means lsof itself produced nothing — it timed
        out, or the binary is gone — and every socket looking unheld is then a failed probe, not a death."""
        return len(self._socket_holders)

    def tree_pids_for_socket(self, socket_path: str) -> set[int]:
        holders = self._socket_holders.get(socket_path)
        if not holders:
            return set()
        return ProcTreeUtil.descendants(self._ppid_rows, holders)

    def process_details(self, pids: set[int]) -> list[dict[str, int | float | str]]:
        """The sampled rows for one resolved dtach tree."""
        return sorted((process for process in self._processes if process["pid"] in pids),
                      key=lambda process: int(process["pid"]))
