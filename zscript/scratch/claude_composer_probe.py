import errno
import asyncio
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import termios
import time
from types import SimpleNamespace

import pyte

from termdeck.agents.claude import ClaudeCli


class ClaudeComposerProbe:
    def __init__(self) -> None:
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 80, 0, 0))
        self.screen = pyte.Screen(80, 40)
        self.stream = pyte.ByteStream(self.screen)
        self.proc = subprocess.Popen(["claude", "--model", "haiku"], stdin=slave, stdout=slave, stderr=slave,
                                     start_new_session=True, env={**os.environ, "TERM": "xterm-256color"})
        os.close(slave)

    def drain(self, seconds: float = 0.6) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if not select.select([self.master], [], [], min(0.1, deadline - time.monotonic()))[0]:
                continue
            try:
                data = os.read(self.master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    return
                raise
            if not data:
                return
            self.stream.feed(data)
            if b"\x1b[6n" in data:
                os.write(self.master, f"\x1b[{self.screen.cursor.y + 1};{self.screen.cursor.x + 1}R".encode())

    def send(self, text: str) -> None:
        os.write(self.master, text.encode())
        self.drain()

    def paste(self, text: str) -> str:
        return "\x1b[200~" + text + "\x1b[201~"

    def write_input(self, session_id: str, text: str) -> None:
        os.write(self.master, text.encode())

    async def _wait_for_paste_to_settle(self, session: SimpleNamespace) -> None:
        self.drain(0.15)

    def composer(self) -> str:
        lines = self.screen.display
        start = next(i for i, line in enumerate(lines) if line.startswith("❯"))
        end = next(i for i in range(start + 1, len(lines)) if lines[i].startswith("────"))
        return " ".join(" ".join([lines[start][2:], *lines[start + 1:end]]).split())

    def run(self) -> None:
        self.drain(3)
        long_draft = "FIRST_SENTINEL " + "word " * 40 + "LAST_SENTINEL"
        for name, draft, cursor in [("wrapped-end", long_draft, ""), ("wrapped-middle", long_draft, "\x1b[A"),
                                    ("multiline", "FIRST_SENTINEL\nsecond line\nLAST_SENTINEL", "\x1b[A"),
                                    ("unicode", "FIRST_SENTINEL " + "漢字 " * 30 + "LAST_SENTINEL", "")]:
            self.send("\x03")
            self.send(self.paste(draft))
            if cursor:
                self.send(cursor)
            assert self.composer() == " ".join(draft.split()), (name, self.composer())
            session = SimpleNamespace(cols=80, record=SimpleNamespace(session_id="probe"))
            started = time.monotonic()
            asyncio.run(ClaudeCli().prepare_composer_clear(self, session, draft))
            self.send(self.paste("INCOMING_ONLY"))
            assert self.composer() == "INCOMING_ONLY", (name, self.composer())
            self.send("\x03")
            self.send(self.paste(draft))
            assert self.composer() == " ".join(draft.split()), (name, self.composer())
            print(name, "PASS: only incoming text; original draft restored once", round(time.monotonic() - started, 2), flush=True)

    def close(self) -> None:
        os.killpg(self.proc.pid, signal.SIGTERM)
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(self.proc.pid, signal.SIGKILL)
            self.proc.wait()
        os.close(self.master)


if __name__ == "__main__":
    probe = ClaudeComposerProbe()
    try:
        probe.run()
    finally:
        probe.close()
