import asyncio
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from termdeck.config import TermdeckConfig
from termdeck.server import TermdeckServer


class DiagnosticsRecordingTest(unittest.TestCase):
    def test_recording_never_exceeds_configured_size_cap(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        with TemporaryDirectory() as directory, \
                patch.object(TermdeckConfig, "DATA_DIR", Path(directory)), \
                patch.object(TermdeckConfig, "DIAGNOSTICS_MAX_BYTES", 64):
            result = asyncio.run(server._record_diagnostics(
                {"id": "bounded", "events": [{"payload": "x" * 40}, {"payload": "second"}]}))
            path = Path(directory) / "diagnostics" / "bounded.jsonl"

            self.assertTrue(result["ok"])
            self.assertTrue(result["full"])
            self.assertLessEqual(path.stat().st_size, 64)


if __name__ == "__main__":
    unittest.main()
