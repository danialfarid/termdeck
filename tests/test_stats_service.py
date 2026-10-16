"""A resource sample that times out takes its ps down with it.

The sample gives up on ps after SUBPROCESS_TIMEOUT_SECONDS. It used to just give up: the abandoned ps sat
blocked writing a pipe nobody read, for good. On a machine too busy to answer within the timeout that
meant one more stuck ps every few seconds -- twelve of them in one 20-minute stretch.
"""

import asyncio
import os
import shutil
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from termdeck.config import TermdeckConfig
from termdeck.stats_service import ResourceStatsService


class ResourceStatsTimeoutTest(unittest.TestCase):
    def test_a_timed_out_ps_is_killed_not_left_blocked(self) -> None:
        scratch = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, scratch, True)
        # Stands in for a ps that has not finished when the sample gives up on it.
        fake_ps = scratch / "ps"
        fake_ps.write_text("#!/bin/sh\necho 1 1 1 0.0 partial\nexec /bin/sleep 60\n")
        fake_ps.chmod(fake_ps.stat().st_mode | stat.S_IXUSR)
        # The process as it was started, not a pid the script writes: on a busy machine the sample can
        # give up before the script has run a line.
        started: list[asyncio.subprocess.Process] = []
        spawn = asyncio.create_subprocess_exec

        async def recorded(*args, **kwargs):
            process = await spawn(*args, **kwargs)
            started.append(process)
            return process

        with patch.object(TermdeckConfig, "PS_BIN", str(fake_ps)), \
                patch.object(TermdeckConfig, "SUBPROCESS_TIMEOUT_SECONDS", 0.3), \
                patch("termdeck.stats_service.asyncio.create_subprocess_exec", recorded):
            with self.assertRaises(TimeoutError):
                asyncio.run(asyncio.wait_for(ResourceStatsService().sample({}), timeout=10))
        self.assertIsNotNone(started[0].returncode)
        with self.assertRaises(ProcessLookupError):
            os.kill(started[0].pid, 0)


if __name__ == "__main__":
    unittest.main()
