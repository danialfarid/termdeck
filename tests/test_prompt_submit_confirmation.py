import asyncio
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from termdeck.config import TermdeckConfig
from termdeck.file_history_service import FileHistoryService
from termdeck.models import SessionRecord
from termdeck.session_manager import ManagedSession, TerminalSessionManager


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

    async def test_confirmation_is_reported(self) -> None:
        with patch.object(TerminalSessionManager, "_transcript_has_prompt", lambda *a: True):
            confirmed = await self.manager._press_enter_until_prompt_lands(managed(), "do the thing")

        self.assertTrue(confirmed)

    async def test_giving_up_is_reported(self) -> None:
        with patch.object(TerminalSessionManager, "_transcript_has_prompt", lambda *a: False):
            confirmed = await self.manager._press_enter_until_prompt_lands(managed(), "do the thing")

        self.assertFalse(confirmed)

    async def test_no_transcript_to_check_against_counts_as_landed(self) -> None:
        # A shell's Enter always lands, and without a transcript service there is nothing that could
        # ever confirm -- neither is an absorbed prompt.
        with patch.object(TerminalSessionManager, "_transcript_has_prompt", lambda *a: False):
            shell = await self.manager._press_enter_until_prompt_lands(managed(agent_kind="none"), "ls")
        self.manager._transcript_service = None
        with patch.object(TerminalSessionManager, "_transcript_has_prompt", lambda *a: False):
            serviceless = await self.manager._press_enter_until_prompt_lands(managed(), "do the thing")

        self.assertTrue(shell)
        self.assertTrue(serviceless)


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


def submit_record(session_id: str = "s1") -> SessionRecord:
    return SessionRecord(session_id=session_id, title="session", title_user_set=True, command="",
                         cwd="/tmp", agent_kind="none", agent_session_id=None,
                         created_at_est="2026-01-01T00:00:00", draft="", project="test")


class UnconfirmedSubmitRestoreTest(unittest.IsolatedAsyncioTestCase):
    """A prompt the transcript never confirms was never taken: the Enter was absorbed and the text is
    still sitting in the composer, while the tracker cleared on the first Enter. The draft is put
    back, so a restart replays what the composer holds instead of nothing."""

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
        self.press_enter = AsyncMock(return_value=True)
        patcher = patch.object(TerminalSessionManager, "_press_enter_until_prompt_lands", self.press_enter)
        patcher.start()
        self.addCleanup(patcher.stop)
        source = patch.object(TerminalSessionManager, "_submit_source_exists", lambda self_, ms: True)
        source.start()
        self.addCleanup(source.stop)

    async def test_unconfirmed_prompt_is_put_back_as_the_draft(self) -> None:
        self.press_enter.return_value = False

        await self.manager.submit_prompt("s1", "do the thing", False, False)

        self.assertEqual(self.session.record.draft, "do the thing")
        self.assertEqual(self.session.draft_tracker.draft, "do the thing")

    async def test_confirmed_prompt_stays_submitted(self) -> None:
        self.press_enter.return_value = True

        await self.manager.submit_prompt("s1", "do the thing", False, False)

        self.assertEqual(self.session.record.draft, "")

    async def test_typing_since_is_not_touched(self) -> None:
        # Someone typed while the confirmation was pending: their text is live, and the unconfirmed
        # prompt stays in the history rather than overwriting it.
        async def typed_while_confirming(ms, text):
            self.session.record.draft = "meanwhile"
            return False

        self.press_enter.side_effect = typed_while_confirming

        await self.manager.submit_prompt("s1", "do the thing", False, False)

        self.assertEqual(self.session.record.draft, "meanwhile")

    async def test_nothing_to_confirm_against_nothing_restored(self) -> None:
        self.press_enter.return_value = False
        with patch.object(TerminalSessionManager, "_submit_source_exists", lambda self_, ms: False):
            await self.manager.submit_prompt("s1", "do the thing", False, False)

        self.assertEqual(self.session.record.draft, "")


class SubmitSourceTest(unittest.TestCase):
    def test_no_service_no_source(self) -> None:
        manager = TerminalSessionManager.__new__(TerminalSessionManager)
        manager._transcript_service = None

        self.assertFalse(manager._submit_source_exists(SimpleNamespace(record=submit_record())))

    def test_unknown_session_no_source(self) -> None:
        manager = TerminalSessionManager.__new__(TerminalSessionManager)
        manager._transcript_service = SimpleNamespace(source_path=lambda *a: Path("/tmp/x.jsonl"))
        manager._sessions = {}

        self.assertFalse(manager._submit_source_exists(SimpleNamespace(record=submit_record())))

    def test_source_is_what_the_transcript_service_says(self) -> None:
        manager = TerminalSessionManager.__new__(TerminalSessionManager)
        manager._sessions = {"s1": SimpleNamespace(record=submit_record())}
        manager.session_history_source = lambda session_id: ("codex", "/tmp", "agent-1")

        manager._transcript_service = SimpleNamespace(source_path=lambda *a: None)
        self.assertFalse(manager._submit_source_exists(manager._sessions["s1"]))

        manager._transcript_service = SimpleNamespace(source_path=lambda *a: Path("/tmp/x.jsonl"))
        self.assertTrue(manager._submit_source_exists(manager._sessions["s1"]))


if __name__ == "__main__":
    unittest.main()
