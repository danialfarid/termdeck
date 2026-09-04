import asyncio
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx

from termdeck.update_check import UpdateCheckService


class UpdateCheckServiceTest(unittest.TestCase):
    def test_latest_release_is_cached_and_compared_semantically(self) -> None:
        with TemporaryDirectory() as directory:
            requests = 0

            def release_response(_request: httpx.Request) -> httpx.Response:
                nonlocal requests
                requests += 1
                return httpx.Response(200, json={"tag_name": "v0.11.0",
                                                  "html_url": "https://github.com/danialfarid/termdeck/releases/tag/v0.11.0",
                                                  "published_at": "2026-09-04T00:00:00Z"})

            service = UpdateCheckService(Path(directory) / "update.json", 86_400,
                                         transport=httpx.MockTransport(release_response))
            first = asyncio.run(service.status("0.10.9"))
            second = asyncio.run(service.status("0.11.0"))

            self.assertTrue(first["update_available"])
            self.assertFalse(second["update_available"])
            self.assertEqual(first["latest_version"], "0.11.0")
            self.assertEqual(requests, 1)

    def test_network_failure_returns_a_stale_cached_release(self) -> None:
        with TemporaryDirectory() as directory:
            cache = Path(directory) / "update.json"
            cache.write_text(json.dumps({"checked_at": 0, "checked_at_est": "old", "latest_version": "0.12.0",
                                         "release_url": "https://github.com/danialfarid/termdeck/releases/tag/v0.12.0"}))

            def failed_response(_request: httpx.Request) -> httpx.Response:
                return httpx.Response(503, text="unavailable")

            service = UpdateCheckService(cache, 1, transport=httpx.MockTransport(failed_response))
            status = asyncio.run(service.status("0.10.1"))

            self.assertTrue(status["update_available"])
            self.assertTrue(status["stale"])
            self.assertIn("503", status["error"])


if __name__ == "__main__":
    unittest.main()
