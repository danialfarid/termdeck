"""steer asks for a change of direction; queue is the name it had before.

Posting a prompt steers the agent by default: the prompt is submitted now and the agent changes
direction. steer:false queues it behind the current turn instead, where the agent has a queue.
The previous name, queue, is still honored -- steer wins when both are sent -- so scripts written
against it keep working; what is written down is steer.
"""

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from termdeck.models import PromptDelivery, PromptOutcome
from termdeck.server import SubmitPromptRequest, TermdeckServer, _steer_wanted


class SteerResolutionTest(unittest.TestCase):
    def test_unspecified_steers(self) -> None:
        self.assertTrue(_steer_wanted(None, None))

    def test_steer_is_taken_as_said(self) -> None:
        self.assertTrue(_steer_wanted(True, None))
        self.assertFalse(_steer_wanted(False, None))

    def test_legacy_queue_is_honored(self) -> None:
        self.assertFalse(_steer_wanted(None, True))
        self.assertTrue(_steer_wanted(None, False))

    def test_steer_wins_when_both_are_sent(self) -> None:
        self.assertTrue(_steer_wanted(True, True))
        self.assertFalse(_steer_wanted(False, False))

    def test_request_defaults_steer(self) -> None:
        request = SubmitPromptRequest(text="go")

        self.assertIsNone(request.steer)
        self.assertTrue(_steer_wanted(request.steer, request.queue))


class SubmitPromptSteerTest(unittest.TestCase):
    def submit(self, processing: bool, **fields: object) -> bool:
        server = TermdeckServer.__new__(TermdeckServer)
        submit = AsyncMock(return_value=PromptDelivery(False, PromptOutcome.CONFIRMED))
        server.manager = SimpleNamespace(
            has_session=lambda session_id: True,
            ensure_session_running=lambda session_id: None,
            session_summary_by_id=lambda session_id: {"processing": processing},
            submit_prompt=submit,
        )
        asyncio.run(server._submit_prompt(
            "s1", SubmitPromptRequest(text="go", **fields)))  # type: ignore[arg-type]
        return submit.await_args.args[3]

    def test_default_submits_now(self) -> None:
        self.assertFalse(self.submit(False))

    def test_steer_false_queues(self) -> None:
        self.assertTrue(self.submit(False, steer=False))

    def test_legacy_queue_true_queues(self) -> None:
        self.assertTrue(self.submit(False, queue=True))

    def test_steer_wins_over_legacy_queue(self) -> None:
        self.assertFalse(self.submit(False, steer=True, queue=True))

    def test_busy_session_still_steers_by_default(self) -> None:
        self.assertFalse(self.submit(True))

    def test_steer_false_queues_when_busy(self) -> None:
        self.assertTrue(self.submit(True, steer=False))
