"""The pty reader thread's color-query answers.

A newborn agent CLI asks for the terminal's colors in its first milliseconds and gives up well
under a second later, painting its composer without a panel for life. The answers therefore go
out on the reader thread the moment the bytes arrive -- never waiting behind loop-blocking
handler work -- and the queries never reach the recorded stream.
"""

import os
import unittest

from termdeck.config import TermdeckConfig
from termdeck.pty_process import PtyProcess


QUERIES = [query for query, _ in TermdeckConfig.OSC_COLOR_QUERY_RESPONSES]
ANSWERS = [answer for _, answer in TermdeckConfig.OSC_COLOR_QUERY_RESPONSES]


class PtyColorQueryTest(unittest.TestCase):
    def _reader(self) -> tuple[PtyProcess, int]:
        proc = PtyProcess.__new__(PtyProcess)
        read_fd, write_fd = os.pipe()
        proc._master_fd = write_fd
        proc._query_carry = b""
        self.addCleanup(os.close, read_fd)
        self.addCleanup(os.close, write_fd)
        return proc, read_fd

    def _answers(self, read_fd: int) -> bytes:
        return os.read(read_fd, 65536)

    def test_queries_are_answered_at_once_and_stripped(self) -> None:
        proc, read_fd = self._reader()
        stripped = proc._answer_color_queries(b"hello" + QUERIES[0] + b"world" + QUERIES[2])
        self.assertEqual(stripped, b"helloworld")
        self.assertEqual(self._answers(read_fd), ANSWERS[0] + ANSWERS[2])

    def test_a_query_split_across_reads_is_held_then_answered(self) -> None:
        proc, read_fd = self._reader()
        query = QUERIES[1]
        first, second = query[:3], query[3:]
        self.assertEqual(proc._answer_color_queries(b"ab" + first), b"ab")
        # Nothing answered yet: the partial query is carried, not passed on.
        import select
        self.assertEqual(select.select([read_fd], [], [], 0.1)[0], [])
        self.assertEqual(proc._answer_color_queries(second + b"!"), b"!")
        self.assertEqual(self._answers(read_fd), ANSWERS[1])

    def test_ordinary_output_passes_through_untouched(self) -> None:
        proc, read_fd = self._reader()
        body = b"\x1b[1;1H\x1b[Kplain output\r\n"
        self.assertEqual(proc._answer_color_queries(body), body)
        import select
        self.assertEqual(select.select([read_fd], [], [], 0.1)[0], [])


if __name__ == "__main__":
    unittest.main()
