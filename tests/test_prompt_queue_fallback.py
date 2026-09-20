"""Queueing a prompt is Tab, and Tab only queues for an agent whose composer does that.

A prompt submitted through the API while the agent is busy is queued rather than sent. For an agent with
no queue -- claude -- Tab does nothing: the prompt stayed in the composer, typed but unsent, with the
draft cleared and nothing watching for it to land, and the caller was told it had been queued.
"""

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from termdeck import agents
from termdeck.models import SessionRecord
from termdeck.session_manager import TerminalSessionManager


def record(session_id: str, agent_kind: str) -> SessionRecord:
    return SessionRecord(session_id=session_id, title=session_id, title_user_set=False,
                         command=agent_kind, cwd="/tmp", agent_kind=agent_kind, agent_session_id="agent-1",
                         created_at_est="2026-09-20 10:00:00", draft="", project="stock")


class PromptQueueFallbackTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.manager = TerminalSessionManager.__new__(TerminalSessionManager)
        self.written: list[str] = []
        self.manager._sessions = {}
        for kind in ("claude", "codex"):
            self.manager._sessions[kind] = SimpleNamespace(record=record(kind, kind), draft_tracker=None)
        # Each adapter marks its own activity when a prompt is submitted, over a good deal of live
        # session state. What is under test is which key is sent, so that hook is stubbed out.
        for agent in (agents.agent_cli("claude"), agents.agent_cli("codex")):
            patcher = patch.object(type(agent), "on_api_prompt_submitted", lambda *a, **k: None)
            patcher.start()
            self.addCleanup(patcher.stop)
        for method in ("_persist", "_broadcast_control", "_schedule_draft_persist"):
            patcher = patch.object(TerminalSessionManager, method, lambda *a, **k: None)
            patcher.start()
            self.addCleanup(patcher.stop)
        for method in ("_wait_for_prompt_ready", "_wait_for_paste_to_settle"):
            patcher = patch.object(TerminalSessionManager, method, AsyncMock())
            patcher.start()
            self.addCleanup(patcher.stop)
        self.confirm = AsyncMock()
        confirm = patch.object(TerminalSessionManager, "_press_enter_until_prompt_lands", self.confirm)
        confirm.start()
        self.addCleanup(confirm.stop)
        write = patch.object(TerminalSessionManager, "write_input",
                             lambda self_, session_id, payload: self.written.append(payload))
        write.start()
        self.addCleanup(write.stop)

    async def submit(self, kind: str, queue: bool) -> bool:
        self.written.clear()
        return await self.manager.submit_prompt(kind, "run the checks", False, queue)

    def last_key(self) -> str:
        return self.written[-1]

    async def test_a_busy_agent_with_no_queue_is_submitted_to(self) -> None:
        # Enter, not Tab: claude takes a message mid-turn, and Tab is not how it is given one.
        queued = await self.submit("claude", queue=True)

        self.assertEqual(self.last_key(), "\r")
        self.assertIs(queued, False)

    async def test_and_the_prompt_is_then_watched_until_it_lands(self) -> None:
        # The queue path skips the confirmation, so a prompt wrongly treated as queued was also the one
        # nothing checked up on.
        await self.submit("claude", queue=True)

        self.confirm.assert_awaited_once()

    async def test_an_agent_with_a_queue_still_queues(self) -> None:
        queued = await self.submit("codex", queue=True)

        self.assertEqual(self.last_key(), "\t")
        self.assertIs(queued, True)

    async def test_an_ordinary_submission_is_unaffected(self) -> None:
        for kind in ("claude", "codex"):
            with self.subTest(kind=kind):
                queued = await self.submit(kind, queue=False)

                self.assertEqual(self.last_key(), "\r")
                self.assertIs(queued, False)

    async def test_the_draft_is_only_cleared_where_the_agent_took_it(self) -> None:
        # Clearing it for a prompt that was not queued loses the text TermDeck was holding on behalf of a
        # composer that still has it.
        self.manager._sessions["claude"].record.draft = "half a thought"
        await self.submit("claude", queue=True)

        self.assertEqual(self.manager._sessions["claude"].record.draft, "half a thought")


if __name__ == "__main__":
    unittest.main()
