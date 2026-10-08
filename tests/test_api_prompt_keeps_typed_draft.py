"""A prompt sent through the API puts back what the person had typed.

Delivering a prompt clears the composer first, so another agent messaging a terminal through the API
threw away whatever its person was in the middle of typing -- in the terminal, and in transcript mode,
which shows the same draft. What was there is held, the prompt goes in, and once it has landed the
held text is put back in the composer, never followed by an Enter.
"""

import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from termdeck.config import TermdeckConfig
from termdeck.file_history_service import FileHistoryService
from termdeck.session_manager import ManagedSession, PromptLanding, TerminalSessionManager
from tests.test_prompt_submit_confirmation import submit_record

PASTE_START = TermdeckConfig.BRACKETED_PASTE_START.decode()
PASTE_END = TermdeckConfig.BRACKETED_PASTE_END.decode()


class HeldDraftTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.manager = TerminalSessionManager()
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, True)
        self.manager.draft_history = FileHistoryService(Path(directory) / "draft-history.sqlite3", 50)
        self.session = ManagedSession(submit_record())
        self.manager._sessions = {self.session.record.session_id: self.session}
        self.manager._schedule_draft_persist = lambda: None  # type: ignore[method-assign]
        self.manager._persist = lambda: None  # type: ignore[method-assign]
        self.manager.replay = SimpleNamespace(schedule_checkpoint=lambda ms: None)
        self.writes: list[str] = []
        original_write = self.manager.write_input

        def recording_write(session_id: str, text: str) -> None:
            self.writes.append(text)
            original_write(session_id, text)

        self.manager.write_input = recording_write  # type: ignore[method-assign]
        self.press_enter = AsyncMock(return_value=PromptLanding.CONFIRMED)
        for target, value in ((("_press_enter_until_prompt_lands"), self.press_enter),
                              ("_submit_source_exists", lambda self_, ms: True),
                              ("_wait_for_paste_to_settle", AsyncMock(return_value=None)),
                              ("_wait_for_prompt_ready", AsyncMock(return_value=None))):
            patcher = patch.object(TerminalSessionManager, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def type_draft(self, text: str) -> None:
        self.manager.write_input(self.session.record.session_id, text)
        self.writes.clear()
        self.assertEqual(self.session.record.draft, text)

    async def test_what_was_typed_comes_back_after_the_prompt(self) -> None:
        self.type_draft("half a thought")

        await self.manager.submit_prompt("s1", "status from the other agent", True, False)

        self.assertEqual(self.session.record.draft, "half a thought")
        self.assertEqual(self.writes[-1], "\x15" + PASTE_START + "half a thought" + PASTE_END)

    async def test_it_comes_back_after_the_enter_that_sent_the_prompt(self) -> None:
        # Put back any earlier and the Enter that submits would send the person's text instead.
        self.type_draft("half a thought")

        await self.manager.submit_prompt("s1", "status from the other agent", True, False)

        submitted_at = self.writes.index("\r")
        restored_at = next(i for i, text in enumerate(self.writes) if "half a thought" in text)
        self.assertGreater(restored_at, submitted_at)

    async def test_nothing_presses_enter_on_it(self) -> None:
        self.type_draft("half a thought")

        await self.manager.submit_prompt("s1", "status from the other agent", True, False)

        restored_at = next(i for i, text in enumerate(self.writes) if "half a thought" in text)
        self.assertNotIn("\r", self.writes[restored_at:])
        self.assertNotIn("\r", self.writes[restored_at].removeprefix("\x15"))

    async def test_a_queued_prompt_gives_it_back_too(self) -> None:
        self.session.record.agent_kind = "codex"
        self.type_draft("half a thought")

        await self.manager.submit_prompt("s1", "status from the other agent", True, True)

        self.assertEqual(self.session.record.draft, "half a thought")

    async def test_a_multi_line_draft_goes_back_as_one_paste(self) -> None:
        # Typed newlines in a composer would each be an Enter if written back as keys.
        self.session.record.draft = "line one\nline two"
        self.session.draft_tracker = type(self.session.draft_tracker)("line one\nline two")

        await self.manager.submit_prompt("s1", "status", False, False)

        self.assertEqual(self.writes[-1], "\x15" + PASTE_START + "line one\nline two" + PASTE_END)

    async def test_typing_since_is_left_alone(self) -> None:
        self.type_draft("half a thought")

        async def typed_while_confirming(ms, text, **_):
            self.manager.write_input("s1", "new words")
            return PromptLanding.CONFIRMED

        self.press_enter.side_effect = typed_while_confirming

        await self.manager.submit_prompt("s1", "status from the other agent", True, False)

        self.assertEqual(self.session.record.draft, "new words")

    async def test_an_empty_composer_gets_nothing_written(self) -> None:
        await self.manager.submit_prompt("s1", "status from the other agent", True, False)

        self.assertEqual(self.writes[-1], "\r")
        self.assertEqual(self.session.record.draft, "")

    async def test_a_prompt_that_never_landed_keeps_its_place(self) -> None:
        # Still sitting in the composer: putting the person's text over it would lose the prompt.
        self.type_draft("half a thought")
        self.press_enter.return_value = PromptLanding.MISSING

        await self.manager.submit_prompt("s1", "status from the other agent", True, False)

        self.assertEqual(self.session.record.draft, "status from the other agent")

    async def test_an_unconfirmed_prompt_with_nothing_to_check_is_not_cleared_away(self) -> None:
        # Putting the person's text back clears the composer first, and a prompt that was never seen
        # to land may still be sitting in it.
        self.type_draft("half a thought")
        self.press_enter.return_value = PromptLanding.MISSING

        with patch.object(TerminalSessionManager, "_submit_source_exists", lambda self_, ms: False):
            await self.manager.submit_prompt("s1", "status from the other agent", True, False)

        self.assertFalse(any("half a thought" in text for text in self.writes))


if __name__ == "__main__":
    unittest.main()
