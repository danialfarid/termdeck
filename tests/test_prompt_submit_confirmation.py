import asyncio
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from termdeck.config import TermdeckConfig
from termdeck.session_manager import TerminalSessionManager


def managed(session_id: str = "s1", agent_kind: str = "claude"):
    return SimpleNamespace(
        record=SimpleNamespace(session_id=session_id, agent_kind=agent_kind, draft=""),
        running=True, last_output_monotonic=0.0)


class PasteSettleTest(unittest.IsolatedAsyncioTestCase):
    """Enter only submits a pasted prompt once the TUI has consumed the paste. A flat delay guesses how
    far behind the TUI is; a terminal streaming tens of thousands of tokens is much further behind than
    an idle one, and the Enter is absorbed."""

    def setUp(self) -> None:
        self.manager = TerminalSessionManager.__new__(TerminalSessionManager)

    async def test_it_waits_for_the_terminal_to_stop_talking(self) -> None:
        ms = managed()
        ms.last_output_monotonic = time.monotonic()

        async def keep_talking() -> None:
            # Output for a while, then silence: the wait must outlast the noise.
            for _ in range(6):
                await asyncio.sleep(0.02)
                ms.last_output_monotonic = time.monotonic()

        with patch.object(TermdeckConfig, "PROMPT_SUBMIT_KEY_DELAY_SECONDS", 0.01), \
             patch.object(TermdeckConfig, "PROMPT_SUBMIT_SETTLE_QUIET_SECONDS", 0.05), \
             patch.object(TermdeckConfig, "PROMPT_SUBMIT_SETTLE_MAX_SECONDS", 2.0):
            started = time.monotonic()
            noise = asyncio.create_task(keep_talking())
            await self.manager._wait_for_paste_to_settle(ms)
            waited = time.monotonic() - started
            await noise

        self.assertGreater(waited, 0.1, "returned while the terminal was still producing output")

    async def test_a_quiet_terminal_is_not_waited_on(self) -> None:
        ms = managed()
        ms.last_output_monotonic = time.monotonic() - 5

        with patch.object(TermdeckConfig, "PROMPT_SUBMIT_KEY_DELAY_SECONDS", 0.01), \
             patch.object(TermdeckConfig, "PROMPT_SUBMIT_SETTLE_QUIET_SECONDS", 0.05), \
             patch.object(TermdeckConfig, "PROMPT_SUBMIT_SETTLE_MAX_SECONDS", 2.0):
            started = time.monotonic()
            await self.manager._wait_for_paste_to_settle(ms)

        self.assertLess(time.monotonic() - started, 0.5)

    async def test_a_terminal_that_never_stops_still_gets_its_enter(self) -> None:
        # An agent streaming a long answer never goes quiet. Waiting forever would mean never submitting.
        ms = managed()

        async def never_stop() -> None:
            while True:
                ms.last_output_monotonic = time.monotonic()
                await asyncio.sleep(0.01)

        with patch.object(TermdeckConfig, "PROMPT_SUBMIT_KEY_DELAY_SECONDS", 0.01), \
             patch.object(TermdeckConfig, "PROMPT_SUBMIT_SETTLE_QUIET_SECONDS", 0.05), \
             patch.object(TermdeckConfig, "PROMPT_SUBMIT_SETTLE_MAX_SECONDS", 0.3):
            noise = asyncio.create_task(never_stop())
            started = time.monotonic()
            await self.manager._wait_for_paste_to_settle(ms)
            waited = time.monotonic() - started
            noise.cancel()

        self.assertLess(waited, 2.0, "the cap did not release a terminal that never goes quiet")


class EnterUntilConfirmedTest(unittest.IsolatedAsyncioTestCase):
    """An absorbed Enter leaves the prompt in the composer looking sent, and nothing notices. The
    transcript is the authority on whether the agent actually has it."""

    def setUp(self) -> None:
        self.manager = TerminalSessionManager.__new__(TerminalSessionManager)
        self.manager._transcript_service = object()
        self.presses: list[str] = []
        self.manager.write_input = lambda session_id, text: self.presses.append(text)
        for name in ("PROMPT_SUBMIT_CONFIRM_POLL_SECONDS", "PROMPT_SUBMIT_CONFIRM_SECONDS"):
            patcher = patch.object(TermdeckConfig, name, 0.02 if "POLL" in name else 0.3)
            patcher.start()
            self.addCleanup(patcher.stop)

    async def test_it_stops_as_soon_as_the_prompt_lands(self) -> None:
        seen = {"checks": 0}

        def landed(self_, ms, text):
            seen["checks"] += 1
            return seen["checks"] >= 2

        with patch.object(TerminalSessionManager, "_transcript_has_prompt", landed):
            await self.manager._press_enter_until_prompt_lands(managed(), "do the thing")

        self.assertEqual(self.presses, ["\r"], "kept pressing after the prompt was confirmed")

    async def test_it_keeps_pressing_while_the_prompt_is_missing(self) -> None:
        with patch.object(TerminalSessionManager, "_transcript_has_prompt", lambda *a: False):
            await self.manager._press_enter_until_prompt_lands(managed(), "do the thing")

        self.assertGreater(len(self.presses), 1, "one absorbed Enter was never retried")

    async def test_it_gives_up_at_the_deadline(self) -> None:
        # A terminal that is never going to take it must not be hammered forever.
        with patch.object(TerminalSessionManager, "_transcript_has_prompt", lambda *a: False):
            started = time.monotonic()
            await self.manager._press_enter_until_prompt_lands(managed(), "do the thing")

        self.assertLess(time.monotonic() - started, 3.0)

    async def test_a_terminal_that_stopped_is_left_alone(self) -> None:
        ms = managed()
        ms.running = False

        with patch.object(TerminalSessionManager, "_transcript_has_prompt", lambda *a: False):
            await self.manager._press_enter_until_prompt_lands(ms, "do the thing")

        self.assertEqual(self.presses, [])

    async def test_a_plain_shell_is_not_chased(self) -> None:
        # A shell has no transcript to confirm against, so there is nothing to wait for and every extra
        # Enter would be a blank command at its prompt.
        with patch.object(TerminalSessionManager, "_transcript_has_prompt", lambda *a: False):
            await self.manager._press_enter_until_prompt_lands(managed(agent_kind="none"), "ls")

        self.assertEqual(self.presses, [])


class TranscriptMatchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.manager = TerminalSessionManager.__new__(TerminalSessionManager)
        self.page = {"turns": []}
        self.manager._transcript_service = SimpleNamespace(history_page=lambda *a, **k: self.page)
        self.manager.session_history_source = lambda session_id: ("claude", "/tmp", "agent-1")

    def test_a_user_turn_carrying_the_prompt_confirms_it(self) -> None:
        self.page = {"turns": [{"role": "user", "text": "Review the diff and report back"}]}

        self.assertTrue(self.manager._transcript_has_prompt(managed(), "Review the diff and report back"))

    def test_the_agent_repeating_the_prompt_does_not_confirm_it(self) -> None:
        # Only a user turn means the agent received it. An assistant quoting it back proves nothing.
        self.page = {"turns": [{"role": "assistant", "text": "Review the diff and report back"}]}

        self.assertFalse(self.manager._transcript_has_prompt(managed(), "Review the diff and report back"))

    def test_only_the_first_line_has_to_match(self) -> None:
        # A long pasted prompt is reformatted by the agent; its opening line is what survives.
        self.page = {"turns": [{"role": "user", "text": "Summarize this\nand some other rendering"}]}

        self.assertTrue(self.manager._transcript_has_prompt(managed(), "Summarize this\nline two\nline three"))

    def test_an_unreadable_transcript_is_not_a_confirmation(self) -> None:
        # Failing to read must not look like success, or a prompt that never landed is called delivered.
        self.manager._transcript_service = SimpleNamespace(
            history_page=lambda *a, **k: (_ for _ in ()).throw(OSError("transcript gone")))

        self.assertFalse(self.manager._transcript_has_prompt(managed(), "anything"))


if __name__ == "__main__":
    unittest.main()
