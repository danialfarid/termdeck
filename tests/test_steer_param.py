"""A prompt sent through the API always steers.

It is submitted now, even mid-turn, and the agent changes direction. The steer flag that could ask
for it to wait behind the current turn instead -- and queue, the name that flag had before -- are
gone. A caller still sending either is not refused; the field is ignored and the prompt steers.
"""

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from termdeck.models import PromptDelivery, PromptOutcome
from termdeck.server import (BatchTerminalSpec, BatchTerminalsRequest, CreateSessionRequest,
                             RunTerminalTaskRequest, SubmitPromptRequest, TermdeckServer)


class NoSteerFieldTest(unittest.TestCase):
    def test_no_request_offers_steer_or_queue(self) -> None:
        for model in (SubmitPromptRequest, CreateSessionRequest, RunTerminalTaskRequest,
                      BatchTerminalSpec, BatchTerminalsRequest):
            self.assertNotIn("steer", model.model_fields, model.__name__)
            self.assertNotIn("queue", model.model_fields, model.__name__)


class SubmitPromptSteersTest(unittest.TestCase):
    def submit(self, processing: bool, **fields: object) -> tuple[object, ...]:
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
        return submit.await_args.args

    def test_a_prompt_is_submitted_not_queued(self) -> None:
        # Nothing after bracketed: the manager's queue flag is left at its default, submit now.
        self.assertEqual(self.submit(False), ("s1", "go", True))

    def test_a_busy_session_is_steered(self) -> None:
        self.assertEqual(self.submit(True), ("s1", "go", True))

    def test_an_old_caller_asking_to_queue_still_steers(self) -> None:
        self.assertEqual(self.submit(True, steer=False), ("s1", "go", True))
        self.assertEqual(self.submit(True, queue=True), ("s1", "go", True))


if __name__ == "__main__":
    unittest.main()
