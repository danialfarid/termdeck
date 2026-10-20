import asyncio
import fcntl
import functools
import os
import pty
import selectors
import signal
import struct
import subprocess
import termios
import threading
from collections.abc import Callable, Mapping
from pathlib import Path

from termdeck.config import TermdeckConfig


class PtyProcess:
    """One shell command attached to a real pty. Output is pumped through the running event loop into on_output;
    on_exit fires once (with this PtyProcess and the exit code) after pty EOF. The owner handles scrollback,
    attached clients, and respawn policy."""

    def __init__(self, command: str, cwd: Path, cols: int, rows: int, on_output: Callable[[bytes], None],
                 on_exit: Callable[["PtyProcess", int], None], dtach_socket: Path | None = None,
                 child_environment: Mapping[str, str] | None = None) -> None:
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
                                          env=self._build_child_env(child_environment),
                                          preexec_fn=functools.partial(os.login_tty, slave_fd),
                                          pass_fds=(slave_fd,), close_fds=True)
        except (OSError, ValueError):
            os.close(master_fd)
            os.close(slave_fd)
            raise
        os.close(slave_fd)
        # The read side lives on its own thread, not on the event loop: a newborn agent CLI asks
        # for the terminal's colors in its first milliseconds and gives up well under a second
        # later, painting its composer without a panel for life. Loop-blocking work after a spawn
        # (summaries, broadcasts) used to hold the answers past that deadline. Reading here means
        # the answers go out the moment the bytes arrive, whatever the loop is doing; the stripped
        # output still reaches on_output on the loop, in order.
        self._query_carry = b""
        self._reader_thread = threading.Thread(target=self._pump_output_thread,
                                               name=f"termdeck-pty-{master_fd}", daemon=True)
        self._reader_thread.start()

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
    def _build_child_env(child_environment: Mapping[str, str] | None = None) -> dict[str, str]:
        env = {key: value for key, value in os.environ.items() if not key.startswith(TermdeckConfig.SCRUBBED_ENV_PREFIX)}
        env[TermdeckConfig.TERM_ENV_KEY] = TermdeckConfig.TERM_ENV_VALUE
        env[TermdeckConfig.COLORTERM_ENV_KEY] = TermdeckConfig.COLORTERM_ENV_VALUE
        env.setdefault(TermdeckConfig.LANG_ENV_KEY, TermdeckConfig.LANG_ENV_VALUE)
        if child_environment:
            env.update(child_environment)
        return env

    def _pump_output_thread(self) -> None:
        selector = selectors.DefaultSelector()
        try:
            selector.register(self._master_fd, selectors.EVENT_READ)
        except (OSError, ValueError):
            self._loop.call_soon_threadsafe(self._finish)
            return
        while not self._closed:
            try:
                ready = selector.select(timeout=1.0)
            except (OSError, ValueError):
                break
            if self._closed or not ready:
                continue
            try:
                data = os.read(self._master_fd, TermdeckConfig.PTY_READ_CHUNK)
            except BlockingIOError:
                continue
            except OSError:
                break
            if not data:
                break
            data = self._answer_color_queries(data)
            if data:
                self._loop.call_soon_threadsafe(self._on_output, data)
        selector.close()
        if not self._closed:
            self._loop.call_soon_threadsafe(self._finish)

    def _answer_color_queries(self, data: bytes) -> bytes:
        """Answer OSC 10/11 color queries at once, and strip them from the stream.

        Runs on the reader thread: only this thread touches _query_carry, and each answer is one
        small os.write, which cannot interleave with the loop thread's input writes mid-sequence.
        """
        data = self._query_carry + data
        self._query_carry = b""
        for query, response in TermdeckConfig.OSC_COLOR_QUERY_RESPONSES:
            if query in data:
                data = data.replace(query, b"")
                try:
                    os.write(self._master_fd, response)
                except OSError:
                    pass
        tail_keep = 0
        for query, _ in TermdeckConfig.OSC_COLOR_QUERY_RESPONSES:
            for length in range(1, min(len(query), TermdeckConfig.OSC_QUERY_CARRY_MAX, len(data)) + 1):
                if length < len(query) and data.endswith(query[:length]):
                    tail_keep = max(tail_keep, length)
        if tail_keep:
            self._query_carry = data[-tail_keep:]
            data = data[:-tail_keep]
        return data

    def _finish(self) -> None:
        if self._closed:
            return
        self._closed = True
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
