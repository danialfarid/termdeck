"""One noun for a terminal, and calls named after what they answer.

A terminal is a session, so making one lived under `terminals` while everything else about it lived
under `sessions` -- and the call reporting how a session is doing was named `task`, competing with the
call that starts one. The names people already use keep working, answered by the same handlers.
"""

import asyncio
import re
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

from fastapi import HTTPException

from termdeck.config import TermdeckConfig
from termdeck.server import CreateSessionRequest, RunTerminalTaskRequest, TermdeckServer

SERVER = Path(__file__).resolve().parent.parent / "termdeck" / "server.py"
DOCS = Path(__file__).resolve().parent.parent / "docs"


def registrations() -> dict[tuple[str, str], str]:
    """Every route the server registers, as {(path, method): handler}."""
    source = SERVER.read_text()
    found: dict[tuple[str, str], str] = {}
    for verb, constant, handler in re.findall(
            r"app\.(get|post|put|patch|delete)\(TermdeckConfig\.(\w+)[^)]*\)\(self\.(\w+)\)", source):
        found[(getattr(TermdeckConfig, constant), verb.upper())] = handler
    return found


class OneCreatorTest(unittest.TestCase):
    """Making a terminal and starting it on something are one call, because they were one thought."""

    def server(self) -> TermdeckServer:
        instance = TermdeckServer.__new__(TermdeckServer)
        instance._run_terminal_task = AsyncMock(return_value={"session_id": "abc123"})
        instance.manager = MagicMock()
        instance.manager.create_session.side_effect = ValueError("create path reached")
        return instance

    def test_a_prompt_starts_the_terminal_it_makes(self) -> None:
        instance = self.server()

        asyncio.run(instance._create_session(CreateSessionRequest(
            title="reviewer", model="codex", prompt="review this", origin_session="parent-1")))
        sent = instance._run_terminal_task.await_args.args[0]

        self.assertIsInstance(sent, RunTerminalTaskRequest)
        self.assertEqual(sent.prompt, "review this")
        self.assertEqual(sent.title, "reviewer")
        self.assertEqual(sent.origin_session, "parent-1")

    def test_without_a_prompt_it_only_makes_the_terminal(self) -> None:
        instance = self.server()

        # The create path is reached instead, which this stub refuses so it goes no further.
        with self.assertRaises(HTTPException):
            asyncio.run(instance._create_session(CreateSessionRequest(title="plain", model="codex")))

        instance._run_terminal_task.assert_not_awaited()


class SessionRouteNamesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.routes = registrations()

    def handler(self, path: str, method: str) -> str:
        self.assertIn((path, method), self.routes, path)
        return self.routes[(path, method)]

    def test_making_a_session_is_one_call(self) -> None:
        # A prompt is a field of it rather than a route of its own: the task call added nothing else.
        self.assertEqual(self.handler("/api/sessions", "POST"), "_create_session")
        self.assertEqual(self.handler("/api/sessions/batch", "POST"), "_launch_terminal_batch")

    def test_how_a_session_is_doing_is_its_status(self) -> None:
        self.assertEqual(self.handler("/api/sessions/{session_id}/status", "GET"), "_session_status")

    def test_what_it_said_back_is_its_response(self) -> None:
        self.assertEqual(self.handler("/api/sessions/{session_id}/response", "GET"), "_session_response")
        self.assertEqual(self.handler("/api/sessions/{session_id}/response/final", "GET"),
                         "_session_final_response")

    def test_the_older_names_answer_with_the_same_handlers(self) -> None:
        # Scripts, and agent instructions written months ago, and anything copied out of either.
        for path, method, handler in (
                ("/api/sessions/task", "POST", "_run_terminal_task"),
                ("/api/terminals/task", "POST", "_run_terminal_task"),
                ("/api/terminals/batch", "POST", "_launch_terminal_batch"),
                ("/api/terminals/task/{session_id}/prompt", "POST", "_follow_up_task_prompt"),
                ("/api/sessions/{session_id}/task", "GET", "_session_status"),
                ("/api/sessions/{session_id}/task-result", "GET", "_session_last_turn"),
                ("/api/sessions/{session_id}/last_turn", "GET", "_session_last_turn")):
            self.assertEqual(self.handler(path, method), handler, path)

    def test_the_fleet_calls_stay_where_they_are(self) -> None:
        # These are about the machinery every terminal runs on, not about one session.
        for path in ("/api/terminals/processes", "/api/terminals/kill-all", "/api/terminals/kill-stale",
                     "/api/terminals/reclaim-orphans"):
            self.assertTrue(any(route == path for route, _ in self.routes), path)

    def test_the_documented_names_are_the_new_ones(self) -> None:
        # The kept names answer, and are named nowhere: what is written down is what to write against.
        for name in ("api.md", "agents-termdeck-api.md"):
            text = (DOCS / name).read_text()
            self.assertIn("POST /api/sessions", text, name)
            self.assertIn("/response", text, name)
            self.assertNotIn("/api/sessions/task", text, name)
            self.assertNotIn("/api/terminals/task", text, name)
            self.assertNotIn("/api/terminals/batch", text, name)
            self.assertNotIn("task-result", text, name)
            self.assertNotIn("{session_id}/task`", text, name)


if __name__ == "__main__":
    unittest.main()
