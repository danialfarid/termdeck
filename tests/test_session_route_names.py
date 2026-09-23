"""One noun for a terminal, and calls named after what they answer.

A terminal is a session, so making one lived under `terminals` while everything else about it lived
under `sessions` -- and the call reporting how a session is doing was named `task`, competing with the
call that starts one. The names people already use keep working, answered by the same handlers.
"""

import re
import unittest
from pathlib import Path

from termdeck.config import TermdeckConfig

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


class SessionRouteNamesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.routes = registrations()

    def handler(self, path: str, method: str) -> str:
        self.assertIn((path, method), self.routes, path)
        return self.routes[(path, method)]

    def test_making_a_session_lives_under_sessions(self) -> None:
        self.assertEqual(self.handler("/api/sessions/task", "POST"), "_run_terminal_task")
        self.assertEqual(self.handler("/api/sessions/batch", "POST"), "_launch_terminal_batch")

    def test_how_a_session_is_doing_is_its_status(self) -> None:
        self.assertEqual(self.handler("/api/sessions/{session_id}/status", "GET"), "_session_status")

    def test_what_it_answered_is_its_last_turns(self) -> None:
        self.assertEqual(self.handler("/api/sessions/{session_id}/last-turns", "GET"), "_session_last_turns")

    def test_the_older_names_answer_with_the_same_handlers(self) -> None:
        # Scripts, and agent instructions written months ago, and anything copied out of either.
        for path, method, handler in (
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
        for name in ("api.md", "agents-termdeck-api.md"):
            text = (DOCS / name).read_text()
            self.assertIn("/api/sessions/task", text, name)
            self.assertNotIn("/api/terminals/task", text, name)
            self.assertNotIn("/api/terminals/batch", text, name)
            self.assertNotIn("task-result", text, name)
            self.assertNotIn("{session_id}/task`", text, name)


if __name__ == "__main__":
    unittest.main()
