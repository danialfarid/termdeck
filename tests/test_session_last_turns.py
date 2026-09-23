"""The answers an agent gave, however many of them are wanted.

There was one call for the latest answer and another for pages of raw transcript, and neither could
say "the last five things this agent actually said": a page of ten turns is mostly thinking, commands
and their output, so asking for ten of those can come back with one answer in it.
"""

import asyncio
import unittest
from unittest.mock import MagicMock

from fastapi import HTTPException

from termdeck.config import TermdeckConfig
from termdeck.server import TermdeckServer


def turn(text: str, role: str = "assistant", final: bool = True) -> dict[str, object]:
    return {"role": role, "text": text, "final": final} if role == "assistant" else {"role": role, "text": text}


def thinking(text: str = "...") -> dict[str, object]:
    return {"role": "event", "kind": "thinking", "text": text}


def server(pages: list[dict[str, object]], running: bool = False, exit_code: int | None = 0) -> TermdeckServer:
    instance = TermdeckServer.__new__(TermdeckServer)
    instance.manager = MagicMock()
    instance.manager.has_session.return_value = True
    instance.manager.session_summary_by_id.return_value = {"running": running, "exit_code": exit_code}
    instance.manager.session_history_source.return_value = ("codex", "/tmp", "session-xyz")
    instance.transcripts = MagicMock()
    # Pages come back newest first as the reader walks backwards through the transcript.
    instance.transcripts.history_page.side_effect = list(pages)
    return instance


def page(turns: list[dict[str, object]], before: int | None = None) -> dict[str, object]:
    return {"turns": turns, "before": before, "has_more": before is not None}


def last_turns(instance: TermdeckServer, **query: object) -> dict[str, object]:
    return asyncio.run(instance._session_last_turns("task-01", **query))


class LastTurnsTest(unittest.TestCase):
    def test_one_answer_by_default(self) -> None:
        instance = server([page([turn("older"), turn("what was asked", role="user"), turn("done")])])

        result = last_turns(instance)

        self.assertEqual([item["text"] for item in result["turns"]], ["done"])

    def test_several_answers_oldest_first(self) -> None:
        # Oldest first, so reading the list is reading the conversation in order.
        instance = server([page([turn("first"), thinking(), turn("second"), turn("third")])])

        result = last_turns(instance, limit=3)

        self.assertEqual([item["text"] for item in result["turns"]], ["first", "second", "third"])

    def test_the_prompts_and_the_work_in_between_are_left_out(self) -> None:
        instance = server([page([turn("asked", role="user"), thinking(), turn("answered")])])

        result = last_turns(instance, limit=5)

        self.assertEqual([item["role"] for item in result["turns"]], ["assistant"])

    def test_it_reads_further_back_until_it_has_enough(self) -> None:
        # A page of transcript can hold a single answer; asking for three reads back for three.
        instance = server([page([thinking(), turn("third")], before=300),
                           page([thinking(), turn("second")], before=200),
                           page([turn("first")])])

        result = last_turns(instance, limit=3)

        self.assertEqual([item["text"] for item in result["turns"]], ["first", "second", "third"])
        self.assertEqual(instance.transcripts.history_page.call_count, 3)

    def test_a_transcript_with_fewer_answers_gives_what_it_has(self) -> None:
        instance = server([page([turn("only one")])])

        result = last_turns(instance, limit=10)

        self.assertEqual([item["text"] for item in result["turns"]], ["only one"])

    def test_it_stops_reading_once_it_has_enough(self) -> None:
        instance = server([page([turn("second"), turn("third")], before=100), page([turn("first")])])

        last_turns(instance, limit=2)

        self.assertEqual(instance.transcripts.history_page.call_count, 1)

    def test_only_finished_answers_when_asked(self) -> None:
        # What an agent says on its way through the work is an answer to nothing; a caller waiting on
        # a result wants the one it ended the turn with.
        instance = server([page([turn("working on it", final=False), turn("here is the result")])])

        result = last_turns(instance, limit=5, final=True)

        self.assertEqual([item["text"] for item in result["turns"]], ["here is the result"])

    def test_the_running_state_comes_with_them(self) -> None:
        instance = server([page([turn("still going")])], running=True, exit_code=None)

        self.assertEqual(last_turns(instance)["status"], "running")

    def test_a_terminal_that_failed_says_so(self) -> None:
        instance = server([page([turn("crashed")])], exit_code=1)

        self.assertEqual(last_turns(instance)["status"], "error")

    def test_asking_for_none_is_refused(self) -> None:
        instance = server([page([turn("done")])])

        with self.assertRaises(HTTPException) as raised:
            last_turns(instance, limit=0)

        self.assertEqual(raised.exception.status_code, 422)

    def test_a_huge_limit_is_capped(self) -> None:
        # The cap bounds how far back one call reads; the whole transcript has its own calls.
        instance = server([page([turn(str(index)) for index in range(200)])])

        result = last_turns(instance, limit=10_000)

        self.assertEqual(len(result["turns"]), TermdeckConfig.LAST_TURNS_MAX)

    def test_the_walk_backwards_is_bounded(self) -> None:
        # A transcript with no answers in it at all must not be read from end to beginning.
        instance = server([page([thinking()], before=index) for index in range(100, 0, -1)])

        result = last_turns(instance, limit=5)

        self.assertEqual(result["turns"], [])
        self.assertEqual(instance.transcripts.history_page.call_count, TermdeckConfig.LAST_TURNS_MAX_PAGES)


class OneCallForAnswersTest(unittest.TestCase):
    """The calls it replaces are gone: two names for one answer is what made it worth unifying."""

    def test_the_single_turn_calls_are_gone(self) -> None:
        self.assertFalse(hasattr(TermdeckConfig, "API_SESSION_LAST_TURN_ROUTE"))
        self.assertFalse(hasattr(TermdeckConfig, "API_SESSION_TASK_RESULT_ROUTE"))
        self.assertFalse(hasattr(TermdeckServer, "_task_result"))

    def test_the_route_is_registered_under_its_own_name(self) -> None:
        self.assertEqual(TermdeckConfig.API_SESSION_LAST_TURNS_ROUTE, "/api/sessions/{session_id}/last_turns")


if __name__ == "__main__":
    unittest.main()
