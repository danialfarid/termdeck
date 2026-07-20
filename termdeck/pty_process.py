import asyncio
import fcntl
import functools
import os
import pty
import signal
import struct
import subprocess
import termios
from collections.abc import Callable
from pathlib import Path

from termdeck.config import TermdeckConfig


class PtyProcess:
    """One shell command attached to a real pty. Output is pumped through the running event loop into on_output;
    on_exit fires once (with this PtyProcess and the exit code) after pty EOF. The owner handles scrollback,
    attached clients, and respawn policy."""

    def __init__(self, command: str, cwd: Path, cols: int, rows: int, on_output: Callable[[bytes], None],
                 on_exit: Callable[["PtyProcess", int], None], dtach_socket: Path | None = None) -> None:
        self._on_output = on_output
        self._on_exit = on_exit
        self._loop = asyncio.get_running_loop()
        self._closed = False
        self._pending_input = bytearray()
        self._writer_registered = False
        master_fd, slave_fd = pty.openpty()
        self._master_fd = master_fd
        try:
            os.set_blocking(master_fd, False)
            self._set_winsize(cols, rows)
            self._proc = subprocess.Popen(self._build_argv(command, dtach_socket), cwd=str(cwd),
                                          env=self._build_child_env(),
                                          preexec_fn=functools.partial(os.login_tty, slave_fd),
                                          pass_fds=(slave_fd,), close_fds=True)
        except (OSError, ValueError):
            os.close(master_fd)
            os.close(slave_fd)
            raise
        os.close(slave_fd)
        self._loop.add_reader(master_fd, self._pump_master_output)

    @property
    def pid(self) -> int:
        return self._proc.pid

    @property
    def alive(self) -> bool:
        return not self._closed and self._proc.poll() is None

    @property
    def finished(self) -> bool:
        return self._closed

    @staticmethod
    def _build_argv(command: str, dtach_socket: Path | None) -> list[str]:
        if command:
            inner = [TermdeckConfig.SHELL, *TermdeckConfig.SHELL_COMMAND_ARGS, command]
        else:
            inner = [TermdeckConfig.SHELL, *TermdeckConfig.SHELL_INTERACTIVE_ARGS]
        if dtach_socket is None:
            return inner
        return [TermdeckConfig.DTACH_BIN, "-A", str(dtach_socket), *TermdeckConfig.DTACH_ARGS, *inner]

    @staticmethod
    def _build_child_env() -> dict[str, str]:
        env = {key: value for key, value in os.environ.items() if not key.startswith(TermdeckConfig.SCRUBBED_ENV_PREFIX)}
        env[TermdeckConfig.TERM_ENV_KEY] = TermdeckConfig.TERM_ENV_VALUE
        env[TermdeckConfig.COLORTERM_ENV_KEY] = TermdeckConfig.COLORTERM_ENV_VALUE
        env.setdefault(TermdeckConfig.LANG_ENV_KEY, TermdeckConfig.LANG_ENV_VALUE)
        return env

    def _pump_master_output(self) -> None:
        try:
            data = os.read(self._master_fd, TermdeckConfig.PTY_READ_CHUNK)
        except BlockingIOError:
            return
        except OSError:
            self._finish()
            return
        if not data:
            self._finish()
            return
        self._on_output(data)

    def _finish(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._loop.remove_reader(self._master_fd)
        if self._writer_registered:
            self._loop.remove_writer(self._master_fd)
            self._writer_registered = False
        os.close(self._master_fd)
        exit_code = self._proc.wait()
        self._on_exit(self, exit_code)

    def write(self, data: bytes) -> None:
        if self._closed or not data:
            return
        self._pending_input.extend(data)
        self._flush_pending_input()

    def _flush_pending_input(self) -> None:
        while self._pending_input and not self._closed:
            try:
                written = os.write(self._master_fd, self._pending_input)
            except BlockingIOError:
                if not self._writer_registered:
                    self._loop.add_writer(self._master_fd, self._flush_pending_input)
                    self._writer_registered = True
                return
            except OSError:
                self._finish()
                return
            if written <= 0:
                return
            del self._pending_input[:written]
        if not self._pending_input and self._writer_registered:
            self._loop.remove_writer(self._master_fd)
            self._writer_registered = False

    def resize(self, cols: int, rows: int) -> None:
        if not self._closed:
            self._set_winsize(cols, rows)

    def _set_winsize(self, cols: int, rows: int) -> None:
        fcntl.ioctl(self._master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def terminate(self) -> None:
        if self._proc.poll() is None:
            os.killpg(self._proc.pid, signal.SIGHUP)

    def kill(self) -> None:
        if self._proc.poll() is None:
            os.killpg(self._proc.pid, signal.SIGKILL)
