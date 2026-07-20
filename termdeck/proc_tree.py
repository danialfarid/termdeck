import asyncio

from termdeck.config import TermdeckConfig


class ProcTreeUtil:
    """Resolves the live process tree behind a dtach socket. Because dtach daemonizes the master (holding the
    pty + the agent CLI) outside the server's process tree, the agent's pids can't be found from the server's
    child pid — they're found from the socket: `lsof -t <sock>` yields the master, and a ppid walk expands to
    the shell + agent CLI descendants."""

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
    async def socket_holder_pids(socket_path: str) -> list[int]:
        output = await ProcTreeUtil._run(TermdeckConfig.LSOF_BIN, "-t", socket_path)
        return [int(token) for token in output.split()]

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
    async def ppid_rows() -> list[tuple[int, int]]:
        output = await ProcTreeUtil._run(TermdeckConfig.PS_BIN, "-axo", "pid=,ppid=")
        rows: list[tuple[int, int]] = []
        for line in output.splitlines():
            parts = line.split()
            if len(parts) == 2:
                rows.append((int(parts[0]), int(parts[1])))
        return rows

    @staticmethod
    async def tree_pids_for_socket(socket_path: str) -> set[int]:
        holders = await ProcTreeUtil.socket_holder_pids(socket_path)
        if not holders:
            return set()
        return ProcTreeUtil.descendants(await ProcTreeUtil.ppid_rows(), holders)
