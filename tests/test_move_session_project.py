"""A terminal that changes project arrives in that project's root.

A worktree belongs to the project it was cut from, so its id means nothing in the project a terminal
moves to. Kept as it was, the terminal lands in a worktree that is not there: missing from the list of
the project it was moved into, and refused by anything that works on that project's terminals.
"""

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock

from termdeck.session_manager import TerminalSessionManager


def manager(project: str, worktree_id: str) -> tuple[TerminalSessionManager, SimpleNamespace]:
    instance = TerminalSessionManager.__new__(TerminalSessionManager)
    session = SimpleNamespace(record=SimpleNamespace(project=project, worktree_id=worktree_id,
                                                     session_id="abc123"))
    instance._sessions = {"abc123": session}
    instance.registry = MagicMock()
    instance.registry.root_for.return_value = "/Users/dan/workspace/other"
    instance._persist = MagicMock()
    instance._broadcast_status = MagicMock()
    return instance, session


class MoveSessionProjectTest(unittest.TestCase):
    def test_a_terminal_from_a_worktree_arrives_at_the_root(self) -> None:
        instance, session = manager("stock", "wt-feature")

        instance.move_session_to_project("abc123", "planner")

        self.assertEqual(session.record.project, "planner")
        self.assertEqual(session.record.worktree_id, "root")

    def test_a_terminal_already_at_a_root_stays_there(self) -> None:
        instance, session = manager("stock", "root")

        instance.move_session_to_project("abc123", "planner")

        self.assertEqual(session.record.worktree_id, "root")

    def test_moving_to_the_project_it_is_in_changes_nothing(self) -> None:
        instance, session = manager("stock", "wt-feature")

        instance.move_session_to_project("abc123", "stock")

        self.assertEqual(session.record.worktree_id, "wt-feature")
        instance._persist.assert_not_called()

    def test_an_unknown_project_is_refused(self) -> None:
        instance, session = manager("stock", "wt-feature")
        instance.registry.root_for.return_value = None

        with self.assertRaises(ValueError):
            instance.move_session_to_project("abc123", "nowhere")

        self.assertEqual(session.record.project, "stock")


if __name__ == "__main__":
    unittest.main()
