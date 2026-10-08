"""Codex blinks its own question title, and both blink phases mean the same thing.

While a question sits unanswered codex alternates its terminal title between
"[ ! ] Action Required | ..." and "[ . ] Action Required | ..." about once a
second. The pending-question predicate is evaluated live on every status
build, so matching only the lit phase flaps needs_attention at the blink
rate -- and the sidebar bell flashes with it.
"""

import unittest
from types import SimpleNamespace

from termdeck.agents.codex import CodexCli


def session(title):
    return SimpleNamespace(running=True, cli_title=title)


class PendingQuestionTitleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.codex = CodexCli()

    def test_lit_blink_phase_is_a_pending_question(self) -> None:
        self.assertTrue(self.codex.has_pending_question(session("[ ! ] Action Required | ref-feat-build")))

    def test_dim_blink_phase_is_the_same_question(self) -> None:
        self.assertTrue(self.codex.has_pending_question(session("[ . ] Action Required | ref-feat-build")))

    def test_a_working_title_is_not_a_question(self) -> None:
        self.assertFalse(self.codex.has_pending_question(session("⠋ main")))

    def test_an_idle_title_is_not_a_question(self) -> None:
        self.assertFalse(self.codex.has_pending_question(session("ref-feat-etf-fix")))

    def test_a_dead_session_asks_nothing(self) -> None:
        ms = session("[ ! ] Action Required | ref-feat-build")
        ms.running = False
        self.assertFalse(self.codex.has_pending_question(ms))


if __name__ == "__main__":
    unittest.main()
