"""A prompt sent through the API reports what became of it: confirmed, failed, or unconfirmed.

An agent sending a prompt was told it had been submitted whatever happened. Codex offering to update
at startup threw the pasted prompt away and took its Enter as "Update now", which ended the terminal;
Claude in a folder it did not trust took the Enter as "No, exit". The caller was told the prompt went
in and waited for an answer that was never coming. Now nothing is typed while such a dialog is up, a
terminal that exits before taking the prompt is reported, and the confirmation reads the record each
agent writes the moment a prompt is submitted -- the transcript holds a mid-turn prompt back until the
agent's next step, so going by it alone called most prompts sent to a busy agent unconfirmed.

Only "failed" means it is safe to send again. "Unconfirmed" went in and may well have arrived;
sending it again would give the agent the same prompt twice.
"""

import asyncio
import json
import shutil
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from termdeck.agents.claude import ClaudeCli
from termdeck.agents.codex import CodexCli
from termdeck.models import PromptDelivery, PromptOutcome
from termdeck.server import RunTerminalTaskRequest, SubmitPromptRequest, TermdeckServer
from tests.test_api_prompt_input_gate import GateHarness

# The frame codex 0.159.3 drew over its composer at startup, as a terminal here recorded it -- after
# which the Enter that followed a prompt's paste ran `brew upgrade` and the session was gone. Answered,
# the dialog clears the screen.
COMPOSER = ("\x1b[1;1H\x1b[J\x1b[2;1H  >_ OpenAI Codex (v0.159.3)\x1b[3;1H     ~/workspace/stock"
            "\x1b[5;1H  Forking session…\x1b[7;1H› Ask Codex to do anything")
UPDATE_OFFER = (
    "\x1b[?2026h\x1b[1;1H\x1b[J\x1b[?25l\x1b[1;2H\x1b[0m\x1b[48;2;39;41;44m\x1b[K\x1b[1;1H \x1b[2;1H  "
    "\x1b[1mUpdate available\x1b[22m\x1b[2m\x1b[2m · 0.159.3 → 0.160.0\x1b[3;1H\x1b[22m  "
    "\x1b[2mRelease notes: \x1b[4m\x1b]8;;https://github.com/openai/codex/releases/latest\x07"
    "https://github.com/openai/codex/releases/latest\x1b]8;;\x07\x1b[4;1H\x1b[24m\x1b[22m \x1b[5;1H"
    "\x1b[1m\x1b[38;2;0;0;46;48;2;99;168;248m› 1. Update now (runs `brew upgrade --cask codex`)"
    "\x1b[6;1H\x1b[22m\x1b[39;48;2;39;41;44m  2. Skip\x1b[7;1H  3. Skip until next version\x1b[8;1H "
    "\x1b[9;1H  \x1b[1menter\x1b[22m continue · \x1b[1mesc\x1b[22m skip\x1b[10;1H\x1b[22m "
    "\x1b[39m\x1b[49m\x1b[0m\x1b[?2026l")
ANSWERED = "\x1b[1;1H\x1b[J"
TRUST_QUESTION = ("Do you trust the files in this folder?\r\n\r\n"
                  "❯ 1. Yes, I trust this folder\r\n"
                  "  2. No, exit\r\n\r\n"
                  "Enter to confirm · Esc to cancel\r\n")


def on_screen(text: str, rows: int = 40):
    return SimpleNamespace(raw_replay_buffer=bytearray(text.encode()), buffer=bytearray(),
                           record=SimpleNamespace(cols=100, rows=rows))


class BlockingDialogTest(unittest.TestCase):
    def test_codex_offering_to_update(self) -> None:
        for rows in (50, 1000):
            with self.subTest(rows=rows):
                self.assertIn("update", CodexCli().prompt_blocked_by(on_screen(COMPOSER + UPDATE_OFFER, rows)))

    def test_codex_before_the_offer_comes_up(self) -> None:
        self.assertEqual(CodexCli().prompt_blocked_by(on_screen(COMPOSER)), "")

    def test_codex_once_the_offer_is_answered(self) -> None:
        self.assertEqual(CodexCli().prompt_blocked_by(on_screen(COMPOSER + UPDATE_OFFER + ANSWERED + COMPOSER)), "")

    def test_claude_asking_to_trust_the_folder(self) -> None:
        self.assertIn("trust", ClaudeCli().prompt_blocked_by(on_screen(TRUST_QUESTION)))

    def test_a_dialog_scrolled_far_above_is_not_in_the_way(self) -> None:
        # Still in the terminal's history, a screenful above where the agent is now.
        later = "".join(f"line {n} of the conversation since\r\n" for n in range(60))

        self.assertEqual(ClaudeCli().prompt_blocked_by(on_screen(TRUST_QUESTION + later, rows=200)), "")

    def test_codex_talking_about_an_update_is_not_the_dialog(self) -> None:
        screen = on_screen("• The log says Update available for the daemon.\r\n› \r\n")

        self.assertEqual(CodexCli().prompt_blocked_by(screen), "")


class CodexPromptHistoryTest(unittest.TestCase):
    """Codex adds a message to its prompt history as it is submitted, with the thread and the second."""

    def setUp(self) -> None:
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, True)
        self.history = Path(directory) / "history.jsonl"
        patcher = patch.object(CodexCli, "PROMPT_HISTORY_FILE", self.history)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.sent_at = 1_791_300_000.4
        self.ms = SimpleNamespace(record=SimpleNamespace(agent_session_id="thread-1"))
        # The threads other terminals here are on.
        self.manager = SimpleNamespace(agent_session_ids_in_use=lambda except_session=None: {"thread-2"})

    def write(self, *entries: dict) -> None:
        self.history.write_text("".join(json.dumps(entry) + "\n" for entry in entries))

    def taken(self, text: str = "Run the checks\nand report") -> bool:
        return CodexCli().prompt_taken(self.manager, self.ms, text, self.sent_at)

    def test_the_submit_is_there(self) -> None:
        self.write({"session_id": "thread-1", "ts": 1_791_300_001, "text": "Run the checks\nand report"})

        self.assertTrue(self.taken())

    def test_taken_in_the_second_it_was_sent(self) -> None:
        self.write({"session_id": "thread-1", "ts": 1_791_300_000, "text": "Run the checks\nand report"})

        self.assertTrue(self.taken())

    def test_the_same_words_to_another_thread_are_not(self) -> None:
        # A batch sends one prompt to many terminals.
        self.write({"session_id": "thread-2", "ts": 1_791_300_001, "text": "Run the checks\nand report"})

        self.assertFalse(self.taken())

    def test_the_same_words_sent_before_are_not(self) -> None:
        # Even a second before: the batch's previous terminal, a moment ago.
        self.write({"session_id": "thread-1", "ts": 1_791_299_999, "text": "Run the checks\nand report"})

        self.assertFalse(self.taken())

    def test_a_new_terminal_on_a_thread_not_written_down_yet(self) -> None:
        # Codex writes a new thread only with its first message, so the terminal is tied to none yet.
        self.ms.record.agent_session_id = None
        self.write({"session_id": "thread-new", "ts": 1_791_300_001, "text": "Run the checks\nand report"})

        self.assertTrue(self.taken())

    def test_a_new_terminal_is_not_confirmed_by_another_terminal_thread(self) -> None:
        self.ms.record.agent_session_id = None
        self.write({"session_id": "thread-2", "ts": 1_791_300_001, "text": "Run the checks\nand report"})

        self.assertFalse(self.taken())

    def test_no_history_file(self) -> None:
        self.assertFalse(self.taken())


class ClaudeQueuedPromptTest(unittest.TestCase):
    """Claude records a prompt sent while it works as queued, at once."""

    def setUp(self) -> None:
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, True)
        self.transcript = Path(directory) / "session.jsonl"
        patcher = patch.object(ClaudeCli, "transcript_path", lambda self_, cwd, session_id: self.transcript)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.sent_at = datetime(2026, 10, 6, 13, 16, 51, tzinfo=timezone.utc).timestamp()
        self.ms = SimpleNamespace(record=SimpleNamespace(agent_session_id="e31e6e7a", cwd="/tmp"))

    def write(self, operation: str, stamp: str, content: str = "Reply with exactly SECOND-PROMPT") -> None:
        self.transcript.write_text(json.dumps({"type": "queue-operation", "operation": operation,
                                               "timestamp": stamp, "content": content}) + "\n")

    def taken(self) -> bool:
        return ClaudeCli().prompt_taken(None, self.ms, "Reply with exactly SECOND-PROMPT", self.sent_at)

    def test_queued_after_it_was_sent(self) -> None:
        self.write("enqueue", "2026-10-06T13:16:52.085Z")

        self.assertTrue(self.taken())

    def test_queued_before_it_was_sent(self) -> None:
        self.write("enqueue", "2026-10-06T13:10:00.000Z")

        self.assertFalse(self.taken())

    def test_taken_off_the_queue_is_not_a_submit(self) -> None:
        self.write("remove", "2026-10-06T13:16:52.085Z")

        self.assertFalse(self.taken())

    def test_something_else_queued(self) -> None:
        self.write("enqueue", "2026-10-06T13:16:52.085Z", content="<task-notification>done</task-notification>")

        self.assertFalse(self.taken())


class OutcomeTest(GateHarness):
    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        self.settle.set()

    async def submit(self) -> PromptDelivery:
        return await self.manager.submit_prompt("s1", "from the other agent", True, False)

    async def test_nothing_is_typed_while_a_dialog_is_up(self) -> None:
        with patch.object(CodexCli, "prompt_blocked_by", lambda self_, ms: "Codex is asking whether to update"):
            delivery = await self.submit()

        self.assertEqual(delivery.outcome, PromptOutcome.FAILED)
        self.assertFalse(delivery.submitted)
        self.assertIn("update", delivery.detail)
        self.assertEqual(self.writes, [])

    async def test_a_dialog_that_came_up_during_the_paste_gets_no_enter(self) -> None:
        self.manager.write_input("s1", "half a thought")
        self.writes.clear()
        answers = iter(["", "Codex is asking whether to update"])

        with patch.object(CodexCli, "prompt_blocked_by", lambda self_, ms: next(answers)):
            delivery = await self.submit()

        self.assertEqual(delivery.outcome, PromptOutcome.FAILED)
        self.assertNotIn("\r", self.writes)
        self.assertEqual(self.session.record.draft, "half a thought")

    async def test_a_terminal_that_exits_instead_of_taking_it(self) -> None:
        async def exit_after_enter() -> None:
            while "\r" not in self.writes:
                await asyncio.sleep(0.005)
            self.session.detached_live = False

        exiting = asyncio.create_task(exit_after_enter())
        delivery = await self.submit()
        await exiting

        self.assertEqual(delivery.outcome, PromptOutcome.FAILED)
        self.assertIn("exited", delivery.detail)

    async def test_recorded_by_the_agent(self) -> None:
        with patch.object(CodexCli, "prompt_taken", lambda *a: True):
            delivery = await self.submit()

        self.assertEqual(delivery, PromptDelivery(False, PromptOutcome.CONFIRMED))
        self.assertEqual(self.writes.count("\r"), 1)

    async def test_never_seen(self) -> None:
        delivery = await self.submit()

        self.assertEqual(delivery.outcome, PromptOutcome.UNCONFIRMED)
        self.assertTrue(delivery.submitted)

    async def test_queued_is_unconfirmed_and_says_so(self) -> None:
        delivery = await self.manager.submit_prompt("s1", "from the other agent", True, True)

        self.assertEqual((delivery.queued, delivery.outcome), (True, PromptOutcome.UNCONFIRMED))


class ApiReportTest(unittest.IsolatedAsyncioTestCase):
    def server_answering(self, delivery: PromptDelivery) -> TermdeckServer:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.has_session.return_value = True
        server.manager.session_summary_by_id.return_value = {"session_id": "s1"}
        server.manager.submit_prompt = AsyncMock(return_value=delivery)
        return server

    async def test_a_prompt_that_did_not_go_in(self) -> None:
        server = self.server_answering(PromptDelivery(False, PromptOutcome.FAILED, "the terminal exited"))

        response = await server._submit_prompt("s1", SubmitPromptRequest(text="go"))

        self.assertIs(response["prompt_submitted"], False)
        self.assertEqual((response["delivery"], response["delivery_detail"]), ("failed", "the terminal exited"))
        # Nothing is coming to wait for.
        self.assertNotIn("since", response)

    async def test_a_prompt_that_went_in_unseen_still_counts_as_submitted(self) -> None:
        server = self.server_answering(PromptDelivery(False, PromptOutcome.UNCONFIRMED, "not recorded"))

        response = await server._submit_prompt("s1", SubmitPromptRequest(text="go"))

        self.assertIs(response["prompt_submitted"], True)
        self.assertEqual(response["delivery"], "unconfirmed")
        self.assertIn("since", response)

    async def test_a_new_terminal_whose_prompt_did_not_go_in(self) -> None:
        server = self.server_answering(PromptDelivery(False, PromptOutcome.FAILED, "Codex is asking whether to update"))
        child = MagicMock()
        child.record.session_id = "child-01"
        child.record.project = "stock"
        child.record.worktree_id = "root"
        server.manager.create_session.return_value = child
        server.manager.registry.root_for.return_value = "/tmp"
        server.manager.command_for_new_session.return_value = "codex"
        server.manager.session_summary.return_value = {"session_id": "child-01"}
        server.manager.session_summary_by_id.return_value = {"session_id": "origin", "cwd": "/tmp", "project": "stock"}
        server._schedule_task_result_delivery = MagicMock()
        for method in ("_broadcast_project_state_snapshot", "_place_session_after",
                       "_raise_if_model_dependency_missing"):
            patcher = patch.object(TermdeckServer, method, lambda *a, **k: None)
            patcher.start()
            self.addCleanup(patcher.stop)

        response = await server._run_terminal_task(RunTerminalTaskRequest(prompt="go", cwd="/tmp", project="stock"))

        self.assertIs(response["prompt_submitted"], False)
        self.assertEqual(response["session_id"], "child-01")
        server._schedule_task_result_delivery.assert_not_called()


if __name__ == "__main__":
    unittest.main()
