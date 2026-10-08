"""While a prompt is being pasted and sent, the person's typing waits; at no other time does it.

A prompt from the API and the person typing share one composer, and their keystrokes interleaved: the
person's text landed inside the prompt's paste, an Enter meant for the prompt sent their half-typed
words, and in transcript mode -- whose draft is mirrored into the composer as pastes of its own --
the prompt was cleared away and never sent at all. Typing that arrives during the paste and its Enter
is held and written straight after, in order. Only typing: the terminal's own replies to the agent
(a cursor report it is waiting on) go through at once.
"""

import asyncio
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from termdeck.config import TermdeckConfig
from termdeck.file_history_service import FileHistoryService
from termdeck.session_manager import ManagedSession, TerminalSessionManager
from tests.test_prompt_submit_confirmation import submit_record

PASTE_END = TermdeckConfig.BRACKETED_PASTE_END.decode()


class GateHarness(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.manager = TerminalSessionManager()
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, True)
        self.manager.draft_history = FileHistoryService(Path(directory) / "draft-history.sqlite3", 50)
        saved = submit_record()
        saved.agent_kind = "codex"
        self.session = ManagedSession(saved)
        self.session.detached_live = True   # running, as far as the confirmation is concerned
        self.manager._sessions = {self.session.record.session_id: self.session}
        self.manager._schedule_draft_persist = lambda: None  # type: ignore[method-assign]
        self.manager._persist = lambda: None  # type: ignore[method-assign]
        self.manager.replay = SimpleNamespace(schedule_checkpoint=lambda ms: None)
        self.writes: list[str] = []
        self.settle = asyncio.Event()
        self.first_enter_sent = asyncio.Event()
        self.paste_end_sent = asyncio.Event()
        original_write = self.manager.write_input

        def recording_write(session_id: str, text: str) -> None:
            self.writes.append(text)
            if text == "\r":
                self.first_enter_sent.set()
            if text == PASTE_END:
                self.paste_end_sent.set()
            original_write(session_id, text)

        self.manager.write_input = recording_write  # type: ignore[method-assign]

        async def settle_when_told(manager, ms) -> None:
            await self.settle.wait()

        for target, value in (("_wait_for_paste_to_settle", settle_when_told),
                              ("_wait_for_prompt_ready", AsyncMock(return_value=None)),
                              ("_submit_source_exists", lambda self_, ms: True)):
            patcher = patch.object(TerminalSessionManager, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.manager._transcript_service = SimpleNamespace()
        self.landed = False
        transcript = patch.object(TerminalSessionManager, "_transcript_has_prompt", lambda self_, ms, text: self.landed)
        transcript.start()
        self.addCleanup(transcript.stop)
        timings = patch.multiple(TermdeckConfig, PROMPT_SUBMIT_CONFIRM_POLL_SECONDS=0.02,
                                 PROMPT_SUBMIT_CONFIRM_SECONDS=0.2)
        timings.start()
        self.addCleanup(timings.stop)

    async def send_while_typing(self, typed: list[str]) -> None:
        submit = asyncio.create_task(self.manager.submit_prompt("s1", "from the other agent", True, False))
        await asyncio.sleep(0.01)
        for text in typed:
            self.manager.write_user_input("s1", text)
        self.settle.set()
        await asyncio.sleep(0.03)
        self.landed = True
        await submit


class InputGateTest(GateHarness):
    async def test_typing_during_the_paste_waits_for_the_enter(self) -> None:
        await self.send_while_typing(["h", "i"])

        enter_at = self.writes.index("\r")
        typed_at = [i for i, text in enumerate(self.writes) if text in ("h", "i")]
        self.assertEqual(len(typed_at), 2)
        self.assertTrue(all(i > enter_at for i in typed_at), self.writes)

    async def test_held_typing_is_written_in_the_order_it_came(self) -> None:
        await self.send_while_typing(["a", "b", "c"])

        typed = [text for text in self.writes if text in ("a", "b", "c")]
        self.assertEqual(typed, ["a", "b", "c"])
        self.assertEqual(self.session.record.draft, "abc")

    async def test_the_terminal_answering_the_agent_is_not_held(self) -> None:
        # A cursor report the agent is waiting on; holding it would stall the agent mid-paste.
        await self.send_while_typing(["\x1b[12;1R"])

        self.assertLess(self.writes.index("\x1b[12;1R"), self.writes.index("\r"))

    async def test_typing_when_no_prompt_is_going_in_goes_straight_through(self) -> None:
        self.manager.write_user_input("s1", "x")

        self.assertEqual(self.writes, ["x"])

    async def test_a_second_prompt_waits_for_the_first(self) -> None:
        first = asyncio.create_task(self.manager.submit_prompt("s1", "first prompt", True, False))
        await asyncio.sleep(0.01)
        second = asyncio.create_task(self.manager.submit_prompt("s1", "second prompt", True, False))
        await asyncio.sleep(0.01)
        self.settle.set()
        self.landed = True
        await asyncio.gather(first, second)

        first_enter = self.writes.index("\r")
        second_paste = next(i for i, text in enumerate(self.writes) if "second prompt" in text)
        self.assertGreater(second_paste, first_enter)


class RetryEnterTest(GateHarness):
    """When the first Enter did not take, the retries must neither feed an open paste nor send the
    person's own words."""

    async def test_an_open_paste_is_closed_before_pressing_again(self) -> None:
        # A paste left open swallows every key after it, Enters included: the composer looked empty and
        # took nothing typed into it. Closing it first lets the next Enter send the prompt.
        submit = asyncio.create_task(self.manager.submit_prompt("s1", "from the other agent", True, False))
        self.settle.set()
        await asyncio.wait_for(self.first_enter_sent.wait(), 1)
        await asyncio.wait_for(self.paste_end_sent.wait(), 1)
        self.landed = True
        await submit

        first_enter = self.writes.index("\r")
        retries = self.writes[first_enter + 1:]
        self.assertIn(PASTE_END, retries)
        self.assertLess(retries.index(PASTE_END), retries.index("\r"))

    async def test_no_retry_enter_lands_on_what_the_person_typed(self) -> None:
        # Once the hold has run out the person's words are in the composer with the retries still
        # going; an Enter then would send them.
        with patch.object(TermdeckConfig, "PROMPT_SUBMIT_INPUT_HOLD_SECONDS", 0.03):
            submit = asyncio.create_task(self.manager.submit_prompt("s1", "from the other agent", True, False))
            await asyncio.sleep(0.01)
            self.settle.set()
            await asyncio.sleep(0.06)
            self.manager.write_user_input("s1", "my own words")
            await submit

        typed_at = self.writes.index("my own words")
        self.assertNotIn("\r", self.writes[typed_at:])


if __name__ == "__main__":
    unittest.main()
