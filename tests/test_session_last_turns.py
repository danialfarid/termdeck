"""The answers an agent gave, however many of them are wanted.

There was one call for the latest answer and another for pages of raw transcript, and neither could
say "the last five things this agent actually said": a page of ten turns is mostly thinking, commands
and their output, so asking for ten of those can come back with one answer in it.
"""

import asyncio
import re
import unittest
from pathlib import Path
from unittest.mock import MagicMock

from fastapi import HTTPException

from termdeck.config import TermdeckConfig
from termdeck.server import TermdeckServer


def turn(text: str, role: str = "assistant", final: bool = True, at: str = "") -> dict[str, object]:
    built: dict[str, object] = {"role": role, "text": text}
    if role == "assistant":
        built["final"] = final
    if at:
        built["timestamp"] = at
    return built


def unmarked(text: str, at: str = "") -> dict[str, object]:
    """What every agent but Codex records: an answer that says nothing about ending a turn."""
    built: dict[str, object] = {"role": "assistant", "text": text}
    if at:
        built["timestamp"] = at
    return built


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

    def test_it_says_whether_the_agent_is_still_working(self) -> None:
        # A terminal is running for as long as it is open, so `status` alone never says an answer has
        # arrived. This does: nothing being processed, and a finished answer in hand.
        instance = server([page([turn("here it is")])], running=True, exit_code=None)
        instance.manager.session_summary_by_id.return_value = {"running": True, "exit_code": None,
                                                               "processing": False}

        result = last_turns(instance, final=True)

        self.assertFalse(result["processing"])
        self.assertTrue(result["turns"][-1]["final"])

    def test_an_answer_from_an_agent_that_marks_nothing_still_counts_as_finished(self) -> None:
        # Only Codex says which message ended a turn. Reading silence as "not final" left a Claude
        # terminal with no answers at all, and a caller waiting on one waiting for ever.
        instance = server([page([unmarked("here it is")])])

        result = last_turns(instance, final=True)

        self.assertEqual([item["text"] for item in result["turns"]], ["here it is"])

    def test_an_agent_mid_turn_says_so(self) -> None:
        instance = server([page([turn("working on it", final=False)])], running=True, exit_code=None)
        instance.manager.session_summary_by_id.return_value = {"running": True, "exit_code": None,
                                                               "processing": True}

        self.assertTrue(last_turns(instance)["processing"])

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


class AnswersToThisPromptTest(unittest.TestCase):
    """`since` is what ties an answer to a prompt. Nothing else does.

    An agent that has not started on a prompt is not processing, and one waiting on a person is not
    processing either -- so the newest answer in the transcript can be the answer to the request
    before, and a caller polling for its own result reads it as the one it asked for.
    """

    def test_an_answer_from_before_the_prompt_is_left_out(self) -> None:
        instance = server([page([turn("the previous answer", at="2026-09-23T08:00:00Z")])])

        result = last_turns(instance, since="2026-09-23T08:30:00Z")

        self.assertEqual(result["turns"], [])

    def test_an_answer_from_after_it_is_returned(self) -> None:
        instance = server([page([turn("the previous answer", at="2026-09-23T08:00:00Z"),
                                 turn("the answer to this one", at="2026-09-23T08:31:00Z")])])

        result = last_turns(instance, since="2026-09-23T08:30:00Z", limit=5)

        self.assertEqual([item["text"] for item in result["turns"]], ["the answer to this one"])

    def test_an_answer_with_no_time_on_it_is_not_taken_as_new(self) -> None:
        # No stamp is no proof, and the whole point of asking is to rule out the old answer.
        instance = server([page([turn("undated")])])

        self.assertEqual(last_turns(instance, since="2026-09-23T08:30:00Z")["turns"], [])

    def test_a_local_time_is_read_as_utc_like_the_stamps_are(self) -> None:
        instance = server([page([turn("after", at="2026-09-23T08:31:00Z")])])

        result = last_turns(instance, since="2026-09-23T08:30:00")

        self.assertEqual([item["text"] for item in result["turns"]], ["after"])

    def test_reading_stops_once_the_pages_are_older_than_the_prompt(self) -> None:
        # Everything before the prompt is of no interest, so there is nothing to read further back for.
        instance = server([page([turn("older", at="2026-09-23T07:00:00Z")], before=100),
                           page([turn("older still", at="2026-09-23T06:00:00Z")], before=50)])

        result = last_turns(instance, since="2026-09-23T08:30:00Z", limit=5)

        self.assertEqual(result["turns"], [])
        self.assertEqual(instance.transcripts.history_page.call_count, 1)

    def test_a_time_that_is_not_a_time_is_refused(self) -> None:
        instance = server([page([turn("done")])])

        with self.assertRaises(HTTPException) as raised:
            last_turns(instance, since="yesterday")

        self.assertEqual(raised.exception.status_code, 422)

    def test_waiting_on_a_person_is_reported_rather_than_read_as_finished(self) -> None:
        instance = server([page([turn("previous", at="2026-09-23T08:00:00Z")])], running=True, exit_code=None)
        instance.manager.session_summary_by_id.return_value = {"running": True, "exit_code": None,
                                                               "processing": False, "needs_attention": True}

        result = last_turns(instance, since="2026-09-23T08:30:00Z")

        self.assertTrue(result["needs_attention"])
        self.assertEqual(result["turns"], [])

    def test_submitting_a_prompt_hands_back_the_instant_it_went_in(self) -> None:
        # Without it a caller has nothing to compare an answer against, and the call that starts an
        # agent and the call that prompts one both have to give it.
        source = (Path(__file__).resolve().parent.parent / "termdeck" / "server.py").read_text()
        prompt_return = re.search(r'return \{"session": self\.manager[^}]*\}', source).group(0)

        self.assertIn('"since": datetime.now(timezone.utc).isoformat()', prompt_return)
        self.assertIn('summary["since"] = datetime.now(timezone.utc).isoformat()', source)

    def test_the_session_state_is_read_after_the_transcript(self) -> None:
        # Read first, it can say an agent is working while the answer it produced meanwhile is already
        # in hand -- which reads as an answer still to come.
        order: list[str] = []
        instance = server([page([turn("done")])])
        instance.transcripts.history_page.side_effect = lambda *args, **kwargs: (
            order.append("transcript"), {"turns": [turn("done")], "before": None, "has_more": False})[1]
        instance.manager.session_summary_by_id.side_effect = lambda *args: (
            order.append("summary"), {"running": False, "exit_code": 0})[1]

        last_turns(instance)

        self.assertEqual(order, ["transcript", "summary"])


class OneCallForAnswersTest(unittest.TestCase):
    """One call is documented; the one it replaced still answers, in its own old shape."""

    def test_the_names_it_replaced_still_answer(self) -> None:
        # Kept for scripts written against them, in the shape they answered in.
        self.assertEqual(TermdeckConfig.API_SESSION_TASK_RESULT_ROUTE, "/api/sessions/{session_id}/task-result")
        self.assertFalse(hasattr(TermdeckServer, "_task_result"))

    def test_the_route_is_hyphenated_like_every_other_one(self) -> None:
        self.assertEqual(TermdeckConfig.API_SESSION_LAST_TURNS_ROUTE, "/api/sessions/{session_id}/last-turns")
        # The old call keeps the spelling it was written with; that is the whole point of keeping it.
        self.assertEqual(TermdeckConfig.API_SESSION_LAST_TURN_ROUTE, "/api/sessions/{session_id}/last_turn")

    def test_no_route_of_this_server_uses_an_underscore_but_that_one(self) -> None:
        # Path parameters are named in code style; the path itself is hyphenated throughout.
        routes = [value for name, value in vars(TermdeckConfig).items()
                  if name.startswith("API_") and isinstance(value, str)]
        underscored = [route for route in routes if "_" in re.sub(r"\{[^}]*\}", "", route)]

        self.assertEqual(underscored, [TermdeckConfig.API_SESSION_LAST_TURN_ROUTE])

    def test_the_documentation_points_at_the_one_call(self) -> None:
        # The old call is kept for scripts already written against it, not for new ones.
        docs = Path(__file__).resolve().parent.parent / "docs"
        for name in ("api.md", "agents-termdeck-api.md"):
            text = (docs / name).read_text()
            self.assertIn("last-turns", text, name)
            self.assertNotIn("/last_turn?", text, name)
            self.assertNotIn("/last_turn`", text, name)
            self.assertNotIn("task-result", text, name)


class OldCallKeepsWorkingTest(unittest.TestCase):
    """A script written against the call that was there before still gets its answer."""

    def last_turn(self, instance: TermdeckServer, **query: object) -> dict[str, object]:
        return asyncio.run(instance._session_last_turn("task-01", **query))

    def test_it_answers_in_the_shape_it_always_did(self) -> None:
        instance = server([page([turn("older"), turn("asked", role="user"), turn("done")])])

        result = self.last_turn(instance)

        self.assertEqual(result, {"session_id": "task-01", "status": "completed", "processing": False,
                                  "needs_attention": False,
                                  "last_turn": {"role": "assistant", "text": "done", "final": True}})

    def test_a_session_with_nothing_said_yet_reports_no_turn(self) -> None:
        instance = server([page([turn("asked", role="user"), thinking()])])

        self.assertIsNone(self.last_turn(instance)["last_turn"])

    def test_it_still_takes_the_finished_answers_only_flag(self) -> None:
        instance = server([page([turn("here it is"), turn("working on it", final=False)])])

        result = self.last_turn(instance, final=True)

        self.assertEqual(result["last_turn"]["text"], "here it is")


if __name__ == "__main__":
    unittest.main()
