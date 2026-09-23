"""What an agent said back, and which prompt it said it to.

There was a call for the latest turn and another for pages of raw transcript, and neither could say
"the last five things this agent actually said" or "the thing it said to the prompt I just sent". A
page of transcript is mostly thinking, commands and their output, so ten entries can hold one
response; and a terminal that is open, an agent that has not started, and an agent waiting on a person
all look alike from outside, so the newest response can belong to the request before.
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
    """What every agent but Codex records: a response that says nothing about ending a turn."""
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


def response(instance: TermdeckServer, **query: object) -> dict[str, object]:
    return asyncio.run(instance._session_response("task-01", **query))


def final_response(instance: TermdeckServer, **query: object) -> dict[str, object]:
    return asyncio.run(instance._session_final_response("task-01", **query))


class ResponseTest(unittest.TestCase):
    def test_one_response_by_default(self) -> None:
        instance = server([page([turn("older"), turn("what was asked", role="user"), turn("done")])])

        self.assertEqual([item["text"] for item in response(instance)["responses"]], ["done"])

    def test_several_oldest_first(self) -> None:
        # Oldest first, so reading the list is reading the conversation in order.
        instance = server([page([turn("first"), thinking(), turn("second"), turn("third")])])

        result = response(instance, limit=3)

        self.assertEqual([item["text"] for item in result["responses"]], ["first", "second", "third"])

    def test_the_prompts_and_the_work_in_between_are_left_out(self) -> None:
        instance = server([page([turn("asked", role="user"), thinking(), turn("answered")])])

        self.assertEqual([item["role"] for item in response(instance, limit=5)["responses"]], ["assistant"])

    def test_what_an_agent_said_on_its_way_through_is_still_a_response(self) -> None:
        # `/response` is everything it said; leaving things out is what `/response/final` is for.
        instance = server([page([turn("I will check the config first", final=False), turn("here it is")])])

        result = response(instance, limit=5)

        self.assertEqual([item["text"] for item in result["responses"]],
                         ["I will check the config first", "here it is"])

    def test_it_reads_further_back_until_it_has_enough(self) -> None:
        # A page of transcript can hold a single response; asking for three reads back for three.
        instance = server([page([thinking(), turn("third")], before=300),
                           page([thinking(), turn("second")], before=200),
                           page([turn("first")])])

        result = response(instance, limit=3)

        self.assertEqual([item["text"] for item in result["responses"]], ["first", "second", "third"])
        self.assertEqual(instance.transcripts.history_page.call_count, 3)

    def test_a_transcript_with_fewer_gives_what_it_has(self) -> None:
        instance = server([page([turn("only one")])])

        self.assertEqual([item["text"] for item in response(instance, limit=10)["responses"]], ["only one"])

    def test_it_stops_reading_once_it_has_enough(self) -> None:
        instance = server([page([turn("second"), turn("third")], before=100), page([turn("first")])])

        response(instance, limit=2)

        self.assertEqual(instance.transcripts.history_page.call_count, 1)

    def test_the_running_state_comes_with_them(self) -> None:
        instance = server([page([turn("still going")])], running=True, exit_code=None)

        self.assertEqual(response(instance)["status"], "running")

    def test_it_says_whether_the_agent_is_still_working(self) -> None:
        instance = server([page([turn("working on it", final=False)])], running=True, exit_code=None)
        instance.manager.session_summary_by_id.return_value = {"running": True, "exit_code": None,
                                                               "processing": True}

        self.assertTrue(response(instance)["processing"])

    def test_a_terminal_that_failed_says_so(self) -> None:
        instance = server([page([turn("crashed")])], exit_code=1)

        self.assertEqual(response(instance)["status"], "error")

    def test_asking_for_none_is_refused(self) -> None:
        instance = server([page([turn("done")])])

        with self.assertRaises(HTTPException) as raised:
            response(instance, limit=0)

        self.assertEqual(raised.exception.status_code, 422)

    def test_a_huge_limit_is_capped(self) -> None:
        # The cap bounds how far back one call reads; the whole transcript has its own calls.
        instance = server([page([turn(str(index)) for index in range(200)])])

        self.assertEqual(len(response(instance, limit=10_000)["responses"]), TermdeckConfig.LAST_TURNS_MAX)

    def test_the_walk_backwards_is_bounded(self) -> None:
        # A transcript with nothing said in it at all must not be read from end to beginning.
        instance = server([page([thinking()], before=index) for index in range(100, 0, -1)])

        result = response(instance, limit=5)

        self.assertEqual(result["responses"], [])
        self.assertEqual(instance.transcripts.history_page.call_count, TermdeckConfig.LAST_TURNS_MAX_PAGES)


class FinalResponseTest(unittest.TestCase):
    """`/response/final` leaves out what an agent says on its way through the work."""

    def test_only_what_ended_a_turn(self) -> None:
        instance = server([page([turn("I will check the config first", final=False), turn("here it is")])])

        result = final_response(instance, limit=5)

        self.assertEqual([item["text"] for item in result["responses"]], ["here it is"])

    def test_an_agent_that_marks_nothing_still_has_responses(self) -> None:
        # Only Codex says which message ended a turn. Read as "not final", a Claude terminal had no
        # responses at all, and a caller waiting on one waited for ever.
        instance = server([page([unmarked("here it is")])])

        result = final_response(instance)

        self.assertEqual([item["text"] for item in result["responses"]], ["here it is"])

    def test_it_takes_the_same_parameters(self) -> None:
        instance = server([page([turn("older", at="2026-09-23T08:00:00Z"),
                                 turn("the prompt", role="user", at="2026-09-23T08:30:05Z"),
                                 turn("newer", at="2026-09-23T08:31:00Z")])])

        result = final_response(instance, limit=5, since="2026-09-23T08:30:00Z")

        self.assertEqual([item["text"] for item in result["responses"]], ["newer"])


class ResponseToThisPromptTest(unittest.TestCase):
    """`since` is what ties a response to a prompt. Nothing else does.

    An agent that has not started on a prompt is not processing, and one waiting on a person is not
    processing either -- so the newest response in the transcript can belong to the request before, and
    a caller polling for its own result reads it as the one it asked for.
    """

    def test_a_response_from_before_the_prompt_is_left_out(self) -> None:
        instance = server([page([turn("the previous response", at="2026-09-23T08:00:00Z"),
                                 turn("the prompt", role="user", at="2026-09-23T08:30:05Z")])])

        self.assertEqual(response(instance, since="2026-09-23T08:30:00Z")["responses"], [])

    def test_one_from_after_the_prompt_is_returned(self) -> None:
        instance = server([page([turn("the previous response", at="2026-09-23T08:00:00Z"),
                                 turn("the prompt", role="user", at="2026-09-23T08:30:05Z"),
                                 turn("the response to this one", at="2026-09-23T08:31:00Z")])])

        result = response(instance, since="2026-09-23T08:30:00Z", limit=5)

        self.assertEqual([item["text"] for item in result["responses"]], ["the response to this one"])

    def test_a_prompt_waiting_its_turn_has_no_response_yet(self) -> None:
        # The API queues a prompt sent while the agent is busy, and the one ahead of it can be answered
        # in between. That answer is before this prompt in the transcript, so it is not this prompt's.
        instance = server([page([turn("the prompt ahead", role="user", at="2026-09-23T08:29:00Z"),
                                 turn("its answer", at="2026-09-23T08:31:00Z")])])

        self.assertEqual(response(instance, since="2026-09-23T08:30:00Z", limit=5)["responses"], [])

    def test_two_prompts_waiting_at_once_are_told_apart(self) -> None:
        # Both were sent before either was recorded, so the instant alone picks whichever the
        # transcript took first -- the other one. What was said settles it.
        mark = TermdeckServer._prompt_mark("second thing")
        instance = server([page([turn("first thing", role="user", at="2026-09-23T08:31:00Z"),
                                 turn("answer to the first", at="2026-09-23T08:32:00Z"),
                                 turn("second thing", role="user", at="2026-09-23T08:33:00Z"),
                                 turn("answer to the second", at="2026-09-23T08:34:00Z")])])

        result = response(instance, since=f"2026-09-23T08:30:00Z~{mark}", limit=5)

        self.assertEqual([item["text"] for item in result["responses"]], ["answer to the second"])

    def test_what_came_after_the_next_prompt_is_that_prompts_answer(self) -> None:
        # Asked about one prompt, answered for that prompt. The conversation carries on afterwards, and
        # all of it is newer than the prompt asked about.
        mark = TermdeckServer._prompt_mark("first thing")
        instance = server([page([turn("first thing", role="user", at="2026-09-23T08:31:00Z"),
                                 turn("answer to the first", at="2026-09-23T08:32:00Z"),
                                 turn("second thing", role="user", at="2026-09-23T08:33:00Z"),
                                 turn("answer to the second", at="2026-09-23T08:34:00Z")])])

        result = response(instance, since=f"2026-09-23T08:30:00Z~{mark}", limit=5)

        self.assertEqual([item["text"] for item in result["responses"]], ["answer to the first"])

    def test_an_instant_with_no_prompt_named_keeps_everything_since(self) -> None:
        # Nothing names a prompt in a bare timestamp, so it means what it always meant.
        instance = server([page([turn("first thing", role="user", at="2026-09-23T08:31:00Z"),
                                 turn("answer to the first", at="2026-09-23T08:32:00Z"),
                                 turn("second thing", role="user", at="2026-09-23T08:33:00Z"),
                                 turn("answer to the second", at="2026-09-23T08:34:00Z")])])

        result = response(instance, since="2026-09-23T08:30:00Z", limit=5)

        self.assertEqual([item["text"] for item in result["responses"]],
                         ["answer to the first", "answer to the second"])

    def test_a_prompt_recorded_but_not_answered_yet_returns_nothing(self) -> None:
        mark = TermdeckServer._prompt_mark("second thing")
        instance = server([page([turn("first thing", role="user", at="2026-09-23T08:31:00Z"),
                                 turn("answer to the first", at="2026-09-23T08:32:00Z"),
                                 turn("second thing", role="user", at="2026-09-23T08:33:00Z")])])

        self.assertEqual(response(instance, since=f"2026-09-23T08:30:00Z~{mark}", limit=5)["responses"], [])

    def test_the_prompt_is_recognised_however_it_was_wrapped(self) -> None:
        # A prompt is pasted into a terminal; what comes back through the transcript is the same words
        # with the spacing the agent chose to record.
        mark = TermdeckServer._prompt_mark("review  the\nparser")
        instance = server([page([turn("review the parser", role="user", at="2026-09-23T08:31:00Z"),
                                 turn("done", at="2026-09-23T08:32:00Z")])])

        result = response(instance, since=f"2026-09-23T08:30:00Z~{mark}", limit=5)

        self.assertEqual([item["text"] for item in result["responses"]], ["done"])

    def test_the_earliest_prompt_after_the_instant_wins_across_pages(self) -> None:
        # The page holding the prompt can begin after it. Stopping at the first prompt on the newest
        # page skips the responses on the page before it.
        instance = server([page([turn("a later prompt", role="user", at="2026-09-23T08:40:00Z"),
                                 turn("its answer", at="2026-09-23T08:41:00Z")], before=100),
                           page([turn("my prompt", role="user", at="2026-09-23T08:31:00Z"),
                                 turn("my answer", at="2026-09-23T08:32:00Z")])])

        result = response(instance, since="2026-09-23T08:30:00Z", limit=5)

        self.assertEqual([item["text"] for item in result["responses"]],
                         ["my answer", "its answer"])

    def test_the_queued_prompt_gets_its_own_response_once_it_runs(self) -> None:
        instance = server([page([turn("the prompt ahead", role="user", at="2026-09-23T08:29:00Z"),
                                 turn("the answer ahead", at="2026-09-23T08:31:00Z"),
                                 turn("my prompt", role="user", at="2026-09-23T08:32:00Z"),
                                 turn("my answer", at="2026-09-23T08:33:00Z")])])

        result = response(instance, since="2026-09-23T08:30:00Z", limit=5)

        self.assertEqual([item["text"] for item in result["responses"]], ["my answer"])

    def test_a_transcript_without_the_prompt_yet_has_nothing_to_give(self) -> None:
        # Nothing has answered a prompt the transcript has not recorded. Everything here is newer than
        # the instant asked about and none of it is an answer to this prompt: the agent was still
        # finishing the request before, and the prompt is waiting in its composer.
        instance = server([page([turn("still on the last request", at="2026-09-23T08:31:00Z"),
                                 turn("and the answer to it", at="2026-09-23T08:32:00Z")])])

        self.assertEqual(response(instance, since="2026-09-23T08:30:00Z", limit=5)["responses"], [])

    def test_an_undated_response_is_no_proof_either(self) -> None:
        instance = server([page([turn("undated")])])

        self.assertEqual(response(instance, since="2026-09-23T08:30:00Z")["responses"], [])

    def test_a_time_with_no_zone_is_read_as_utc_like_the_stamps_are(self) -> None:
        instance = server([page([turn("the prompt", role="user", at="2026-09-23T08:30:05Z"),
                                 turn("after", at="2026-09-23T08:31:00Z")])])

        result = response(instance, since="2026-09-23T08:30:00")

        self.assertEqual([item["text"] for item in result["responses"]], ["after"])

    def test_reading_stops_once_the_pages_are_older_than_the_prompt(self) -> None:
        # Everything before the prompt is of no interest, so there is nothing to read further back for.
        instance = server([page([turn("older", at="2026-09-23T07:00:00Z")], before=100),
                           page([turn("older still", at="2026-09-23T06:00:00Z")], before=50)])

        result = response(instance, since="2026-09-23T08:30:00Z", limit=5)

        self.assertEqual(result["responses"], [])
        self.assertEqual(instance.transcripts.history_page.call_count, 1)

    def test_a_time_that_is_not_a_time_is_refused(self) -> None:
        instance = server([page([turn("done")])])

        with self.assertRaises(HTTPException) as raised:
            response(instance, since="yesterday")

        self.assertEqual(raised.exception.status_code, 422)

    def test_waiting_on_a_person_is_reported_rather_than_read_as_finished(self) -> None:
        instance = server([page([turn("previous", at="2026-09-23T08:00:00Z"),
                                 turn("the prompt", role="user", at="2026-09-23T08:30:05Z")])],
                          running=True, exit_code=None)
        instance.manager.session_summary_by_id.return_value = {"running": True, "exit_code": None,
                                                               "processing": False, "needs_attention": True}

        result = response(instance, since="2026-09-23T08:30:00Z")

        self.assertTrue(result["needs_attention"])
        self.assertEqual(result["responses"], [])

    def test_submitting_a_prompt_hands_back_the_instant_it_went_in(self) -> None:
        # Without it a caller has nothing to compare a response against, and the call that starts an
        # agent and the call that prompts one both have to give it.
        source = (Path(__file__).resolve().parent.parent / "termdeck" / "server.py").read_text()
        prompt_return = re.search(r'return \{"session": self\.manager[^}]*\}', source).group(0)

        self.assertIn('"since": since', prompt_return)
        self.assertIn('summary["since"] = since', source)
        # And it carries what was said, which is how two waiting prompts are told apart.
        self.assertIn("self._now_stamp(request.text)", source)
        self.assertIn("self._now_stamp(prompt)", source)
        # Taken before the prompt goes in: submitting waits for the terminal to confirm it, and an
        # answer can beat that, which a boundary taken afterwards would leave behind it.
        for path in (r"await self\.manager\.submit_prompt\(ms\.record\.session_id",
                     r"queued = await self\.manager\.submit_prompt\(session_id"):
            submit = re.search(path, source)
            stamp = source.rindex("since = self._now_stamp(", 0, submit.start())
            self.assertLess(stamp, submit.start())

    def test_the_stamp_needs_no_escaping_in_a_query_string(self) -> None:
        # A `+00:00` offset has to be escaped; a caller pasting back what it was given should not have
        # to know that. The shape is the one the transcripts stamp their own turns with.
        stamp = TermdeckServer._now_stamp()

        self.assertRegex(stamp, r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
        self.assertIsNotNone(TermdeckServer._parse_since(stamp))

    def test_the_session_state_is_read_after_the_transcript(self) -> None:
        # Read first, it can say an agent is working while the response it produced meanwhile is
        # already in hand -- which reads as one still to come.
        order: list[str] = []
        instance = server([page([turn("done")])])
        instance.transcripts.history_page.side_effect = lambda *args, **kwargs: (
            order.append("transcript"), {"turns": [turn("done")], "before": None, "has_more": False})[1]
        instance.manager.session_summary_by_id.side_effect = lambda *args: (
            order.append("summary"), {"running": False, "exit_code": 0})[1]

        response(instance)

        self.assertEqual(order, ["transcript", "summary"])


class OneCallForResponsesTest(unittest.TestCase):
    """Two calls are documented -- everything, and only what ended a turn. The rest are kept names."""

    def test_the_routes_are_named_after_what_they_answer(self) -> None:
        self.assertEqual(TermdeckConfig.API_SESSION_RESPONSE_ROUTE, "/api/sessions/{session_id}/response")
        self.assertEqual(TermdeckConfig.API_SESSION_FINAL_RESPONSE_ROUTE,
                         "/api/sessions/{session_id}/response/final")

    def test_the_names_they_replaced_still_answer(self) -> None:
        self.assertEqual(TermdeckConfig.API_SESSION_TASK_RESULT_ROUTE, "/api/sessions/{session_id}/task-result")
        self.assertEqual(TermdeckConfig.API_SESSION_LAST_TURN_ROUTE, "/api/sessions/{session_id}/last_turn")
        self.assertFalse(hasattr(TermdeckServer, "_task_result"))

    def test_no_route_of_this_server_uses_an_underscore_but_that_one(self) -> None:
        # Path parameters are named in code style; the path itself is hyphenated throughout.
        routes = [value for name, value in vars(TermdeckConfig).items()
                  if name.startswith("API_") and isinstance(value, str)]
        underscored = [route for route in routes if "_" in re.sub(r"\{[^}]*\}", "", route)]

        self.assertEqual(underscored, [TermdeckConfig.API_SESSION_LAST_TURN_ROUTE])

    def test_the_documentation_points_at_the_new_calls(self) -> None:
        docs = Path(__file__).resolve().parent.parent / "docs"
        for name in ("api.md", "agents-termdeck-api.md"):
            text = (docs / name).read_text()
            self.assertIn("/response", text, name)
            self.assertNotIn("last-turns", text, name)
            self.assertNotIn("/last_turn", text, name)
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

    def test_it_still_takes_the_flag_it_took(self) -> None:
        instance = server([page([turn("here it is"), turn("working on it", final=False)])])

        result = self.last_turn(instance, final=True)

        self.assertEqual(result["last_turn"]["text"], "here it is")


if __name__ == "__main__":
    unittest.main()
