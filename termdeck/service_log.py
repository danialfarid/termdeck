import asyncio
import fcntl
import os
import stat
from pathlib import Path

from termdeck.platform_paths import PlatformPaths


class ServiceLogTrimmer:
    """Keeps the always-on service's log bounded.

    launchd and systemd redirect this process's stdout/stderr into that file before exec, so the server
    never learns its path from configuration — it reads it back off the descriptor, which also means a
    hand-written unit pointing somewhere else is still covered. Trimming rewrites the file in place with
    its tail, dropping the head: the supervisor's descriptors carry O_APPEND, so later writes land at the
    new end of file instead of punching a hole at the old offset. A line logged during the rewrite can be
    lost, which is the trade for not needing the supervisor to reopen anything."""

    _F_GETPATH = 50                                   # macOS fcntl; Linux reads the path out of /proc
    _PATH_BUFFER = bytes(1024)

    def __init__(self, maximum_bytes: int, keep_bytes: int, interval_seconds: float) -> None:
        self._maximum_bytes = maximum_bytes
        self._keep_bytes = keep_bytes
        self._interval_seconds = interval_seconds

    @classmethod
    def redirected_log_path(cls) -> Path | None:
        """The regular file stdout is redirected into, or None when it is a terminal, pipe or /dev/null."""
        for descriptor in (1, 2):
            try:
                if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                    continue
                if PlatformPaths.IS_MACOS:
                    resolved = fcntl.fcntl(descriptor, cls._F_GETPATH, cls._PATH_BUFFER)
                    return Path(os.fsdecode(resolved.split(b"\x00", 1)[0]))
                return Path(os.readlink(f"/proc/self/fd/{descriptor}"))
            except OSError:
                continue
        return None

    def trim_if_oversized(self) -> int:
        """Drop the oldest bytes once the log passes its ceiling. Returns how many were dropped."""
        path = self.redirected_log_path()
        if path is None:
            return 0
        size = path.stat().st_size
        if size <= self._maximum_bytes:
            return 0
        with path.open("r+b") as log:
            log.seek(size - self._keep_bytes)
            log.readline()                            # start the kept tail on a line boundary
            tail = log.read()
            log.seek(0)
            log.write(tail)
            log.truncate()
        return size - len(tail)

    async def run_periodic_trims(self) -> None:
        while True:
            await asyncio.sleep(self._interval_seconds)
            await asyncio.to_thread(self.trim_if_oversized)
