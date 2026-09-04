import unittest
from unittest.mock import patch

from termdeck.session_manager import ManagedSession, TerminalSessionManager
from tests.test_terminal_lifecycle import record


class CompletionStampTest(unittest.TestCase):
    """The server stamps when a turn ends so a page that missed the working→idle edge can still tell."""

    def session(self) -> ManagedSession:
        return ManagedSession(record())

    def sync(self, ms: ManagedSession, processing: bool) -> None:
        TerminalSessionManager._sync_processing_started(None, ms, processing)

    def test_a_turn_that_was_seen_to_start_stamps_when_it_ends(self) -> None:
        ms = self.session()
        with patch("termdeck.session_manager.time.time", return_value=100.0):
            self.sync(ms, True)
        self.assertIsNone(ms.last_completed_at)

        with patch("termdeck.session_manager.time.time", return_value=160.0):
            self.sync(ms, False)

        self.assertEqual(ms.last_completed_at, 160.0)
        self.assertIsNone(ms.processing_started_at)

    def test_idle_reports_without_a_run_do_not_stamp(self) -> None:
        ms = self.session()
        self.sync(ms, False)
        self.sync(ms, False)
        self.assertIsNone(ms.last_completed_at)

    def test_a_reset_that_clears_the_run_directly_is_not_a_finished_turn(self) -> None:
        ms = self.session()
        self.sync(ms, True)
        ms.processing_started_at = None          # what restart and kill do
        self.sync(ms, False)
        self.assertIsNone(ms.last_completed_at)

    def test_the_stamp_travels_with_the_session_summary_and_status(self) -> None:
        ms = self.session()
        ms.last_completed_at = 42.0
        manager = TerminalSessionManager.__new__(TerminalSessionManager)
        manager.notifier = None
        with patch.object(TerminalSessionManager, "_refresh_session_activity", lambda self, ms: None), \
             patch.object(TerminalSessionManager, "_sync_processing_started", lambda self, ms, processing=None: False), \
             patch("termdeck.session_manager.agents.agent_cli") as agent_cli:
            agent_cli.return_value.refresh_activity_for_status = lambda manager, ms: None
            agent_cli.return_value.activity_detail = lambda ms: None
            self.assertEqual(manager.session_summary(ms)["last_completed_at"], 42.0)
            self.assertEqual(manager._status_payload(ms)["last_completed_at"], 42.0)


if __name__ == "__main__":
    unittest.main()
