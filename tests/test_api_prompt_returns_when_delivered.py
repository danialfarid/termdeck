"""A prompt from the terminal's own websocket is let go of once it has gone in.

Delivering a prompt ends in watching for the agent to record it, pressing Enter again until it does,
for up to fifteen seconds. The websocket that sends it also carries the person's typing, and waiting
there left their keys unread for all of that; `deliver_prompt` returns once the paste and its Enter
are in and the watching carries on by itself. The HTTP API waits for the outcome instead, which the
agent's own records now give in a second or two, and the browser waits long enough for one prompt
queued behind another -- before, it gave up at fifteen seconds and kept a message ("Send now") that
the server went on to deliver.
"""

import asyncio
import re
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from termdeck.config import TermdeckConfig
from termdeck.session_manager import TerminalSessionManager
from tests.test_api_prompt_input_gate import GateHarness

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"


class DeliveredPromptTest(GateHarness):
    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        self.settle.set()
        # Long enough that a call waiting on the confirmation could not come back in time.
        timings = patch.object(TermdeckConfig, "PROMPT_SUBMIT_CONFIRM_SECONDS", 5.0)
        timings.start()
        self.addCleanup(timings.stop)

    async def deliver(self, text: str = "from the other agent", queue: bool = False) -> bool:
        started = time.monotonic()
        queued = await self.manager.deliver_prompt("s1", text, True, queue)
        self.elapsed = time.monotonic() - started
        return queued

    async def finish_confirming(self) -> None:
        self.landed = True
        await asyncio.wait_for(asyncio.gather(*self.manager._prompt_confirmations), 2)

    async def test_it_comes_back_once_the_enter_is_in(self) -> None:
        await self.deliver()

        self.assertLess(self.elapsed, 1.0)
        self.assertIn("\r", self.writes)
        await self.finish_confirming()

    async def test_the_watching_carries_on_after_it(self) -> None:
        # The transcript has not shown the prompt yet, so Enter is pressed again after the reply.
        await self.deliver()
        pressed_by_then = self.writes.count("\r")
        await asyncio.sleep(0.1)

        self.assertGreater(self.writes.count("\r"), pressed_by_then)
        await self.finish_confirming()

    async def test_what_was_typed_still_comes_back_after_it_lands(self) -> None:
        self.manager.write_input("s1", "half a thought")
        self.writes.clear()

        await self.deliver()
        await self.finish_confirming()

        self.assertEqual(self.session.record.draft, "half a thought")

    async def test_the_next_prompt_still_waits_for_this_one(self) -> None:
        await self.deliver("first prompt")
        second = asyncio.create_task(self.deliver("second prompt"))
        await asyncio.sleep(0.1)

        self.assertFalse(any("second prompt" in text for text in self.writes))
        await self.finish_confirming()
        await asyncio.wait_for(second, 2)
        self.assertTrue(any("second prompt" in text for text in self.writes))
        await self.finish_confirming()

    async def test_queued_says_what_was_done(self) -> None:
        self.assertIs(await self.deliver(queue=True), True)
        self.assertIs(await self.deliver(queue=False), False)
        await self.finish_confirming()

    async def test_a_failure_before_it_went_in_is_raised(self) -> None:
        with patch.object(TerminalSessionManager, "_wait_for_prompt_ready",
                          AsyncMock(side_effect=ValueError("session is gone"))):
            with self.assertRaisesRegex(ValueError, "session is gone"):
                await self.deliver()

    async def test_nothing_is_left_behind_once_it_lands(self) -> None:
        await self.deliver()
        await self.finish_confirming()
        await asyncio.sleep(0)

        self.assertEqual(self.manager._prompt_confirmations, set())


class BrowserWaitTest(unittest.TestCase):
    """The browser waits out the longest the server can take before a prompt is in."""

    def test_it_outlasts_a_new_agent_and_a_prompt_ahead(self) -> None:
        source = (STATIC / "app.js").read_text()
        timeout_seconds = int(re.search(r"const PROMPT_SEND_TIMEOUT_MS = (\d+);", source).group(1)) / 1000
        # The prompt ahead holds the terminal until it has been confirmed or given up on.
        ahead = (TermdeckConfig.PROMPT_SUBMIT_SETTLE_MAX_SECONDS + TermdeckConfig.PROMPT_SUBMIT_CONFIRM_SECONDS
                 + TermdeckConfig.PROMPT_SUBMIT_CONFIRM_POLL_SECONDS)
        own = (TermdeckConfig.PROMPT_AGENT_READY_TIMEOUT_SECONDS + TermdeckConfig.PROMPT_AGENT_STARTUP_DELAY_SECONDS
               + TermdeckConfig.PROMPT_SUBMIT_SETTLE_MAX_SECONDS)
        self.assertGreater(timeout_seconds, ahead + own)

    def test_the_send_uses_it(self) -> None:
        source = (STATIC / "app_markdown_files.js").read_text()
        send = re.search(r"  async submitHistoryPromptViaApi\(view, text, options = \{\}\) \{(.*?)\n  \},", source, re.S)

        self.assertIn("controller.abort(), PROMPT_SEND_TIMEOUT_MS)", send.group(1))


if __name__ == "__main__":
    unittest.main()
