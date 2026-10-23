import asyncio
from types import SimpleNamespace
from unittest.mock import patch

from termdeck.agents.codex import CodexCli
from termdeck.models import PromptOutcome
from tests.test_api_prompt_input_gate import GateHarness


class AutomaticCommandDraftTest(GateHarness):
    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        self.session.proc = SimpleNamespace(alive=True, write=lambda data: None)
        self.session.record.agent_session_id = "codex-session"
        self.settle.set()

    async def test_rename_restores_the_original_draft(self) -> None:
        self.manager.write_input("s1", "my unfinished question")
        await CodexCli().send_rename(self.manager, self.session, "new title")
        self.assertEqual(self.session.record.draft, "my unfinished question")
        self.assertFalse(self.session.prompt_going_in)
        self.assertFalse(self.session.prompt_submit_lock.locked())
        self.assertIn("/rename new title", ''.join(self.writes))

    async def test_typing_during_rename_follows_restored_draft(self) -> None:
        self.manager.write_input("s1", "unfinished")
        self.settle.clear()
        rename = asyncio.create_task(CodexCli().send_rename(self.manager, self.session, "new title"))
        await self.first_enter_sent.wait()
        self.manager.write_user_input("s1", " plus typing")
        self.assertNotIn(" plus typing", self.writes)
        self.settle.set()
        await rename
        self.assertEqual(self.session.record.draft, "unfinished plus typing")

    async def test_incoming_prompt_waits_for_rename_to_finish(self) -> None:
        self.manager.write_input("s1", "draft")
        self.settle.clear()
        rename = asyncio.create_task(CodexCli().send_rename(self.manager, self.session, "renamed"))
        await self.first_enter_sent.wait()
        prompt = asyncio.create_task(self.manager.submit_prompt("s1", "incoming", True))
        await asyncio.sleep(0)
        self.assertNotIn("incoming", ''.join(self.writes))
        self.landed = True
        self.settle.set()
        await rename
        await prompt
        self.assertEqual(self.session.record.draft, "draft")

    async def test_goal_editor_receives_no_automatic_input(self) -> None:
        self.manager.write_input("s1", "unfinished goal")
        self.writes.clear()
        self.session.raw_replay_buffer = bytearray(
            "\x1b[2J\x1b[H  Edit goal\r\n› unfinished goal\r\n  enter submit · esc back".encode())
        result = await self.manager.submit_prompt("s1", "incoming agent message", True)
        with self.assertRaisesRegex(RuntimeError, "goal editor"):
            await CodexCli().send_rename(self.manager, self.session, "new title")
        self.assertEqual(result.outcome, PromptOutcome.FAILED)
        self.assertEqual(self.writes, [])
        self.assertEqual(self.session.record.draft, "unfinished goal")

    async def test_model_selection_restores_draft(self) -> None:
        self.manager.write_input("s1", "my unfinished question")
        with patch.object(self.manager, "ensure_session_running", return_value=self.session), \
                patch.object(self.manager, "_processing_state", return_value=False), \
                patch.object(self.manager, "_write_agent_menu_input"):
            await self.manager.change_codex_model("s1", 1, "medium")
        self.assertEqual(self.session.record.draft, "my unfinished question")
        self.assertFalse(self.session.prompt_going_in)
