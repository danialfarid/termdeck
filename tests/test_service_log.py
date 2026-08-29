import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


# Runs as the supervisor does: stdout redirected into a file with O_APPEND, which is what makes an
# in-place trim safe. The child trims its own log and then writes, so the assertions see both halves.
CHILD_PROGRAM = """
import sys
from termdeck.service_log import ServiceLogTrimmer

dropped = ServiceLogTrimmer(int(sys.argv[1]), int(sys.argv[2]), 900.0).trim_if_oversized()
print(f"AFTER-TRIM dropped={dropped}")
"""


class ServiceLogTrimmerTest(unittest.TestCase):
    def _run_child(self, log: Path, maximum_bytes: int, keep_bytes: int) -> None:
        descriptor = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND)
        try:
            subprocess.run([sys.executable, "-c", CHILD_PROGRAM, str(maximum_bytes), str(keep_bytes)],
                           cwd=Path(__file__).resolve().parent.parent, stdout=descriptor,
                           stderr=subprocess.DEVNULL, check=True)
        finally:
            os.close(descriptor)

    def test_oversized_log_is_cut_back_to_its_tail_and_keeps_appending(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "termdeck.log"
            log.write_text("".join(f"line {number:06d}\n" for number in range(100_000)))
            original_size = log.stat().st_size

            self._run_child(log, maximum_bytes=200_000, keep_bytes=50_000)

            trimmed = log.read_text()
            self.assertLess(log.stat().st_size, 200_000)
            self.assertNotIn("line 000000", trimmed)          # the head is what gets dropped
            self.assertIn("line 099999", trimmed)             # the tail is what anyone reads
            self.assertTrue(trimmed.startswith("line "))      # the cut lands on a line boundary
            # The write that follows the trim has to land at the new end of file. Without O_APPEND it
            # would resume at the old offset, leaving a NUL-filled hole where the dropped head was — so
            # the appended line must account for the file's length exactly, with nothing in between.
            dropped = int(trimmed.rsplit("dropped=", 1)[1])
            appended = f"AFTER-TRIM dropped={dropped}\n"
            self.assertTrue(trimmed.endswith(appended))
            self.assertEqual(dropped, original_size - (len(trimmed) - len(appended)))
            self.assertNotIn("\x00", trimmed)

    def test_log_under_the_ceiling_is_left_alone(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "termdeck.log"
            log.write_text("small\n")

            self._run_child(log, maximum_bytes=5_000_000, keep_bytes=2_000_000)

            self.assertTrue(log.read_text().startswith("small\n"))
            self.assertIn("dropped=0", log.read_text())

    def test_no_path_when_stdout_is_not_a_regular_file(self) -> None:
        # A foreground `termdeck` logs to a terminal or a pipe; there is nothing to trim then.
        result = subprocess.run(
            [sys.executable, "-c",
             "from termdeck.service_log import ServiceLogTrimmer;"
             "print(ServiceLogTrimmer.redirected_log_path())"],
            cwd=Path(__file__).resolve().parent.parent, capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.strip(), "None")
