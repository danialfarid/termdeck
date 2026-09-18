import unittest
from types import SimpleNamespace
from unittest.mock import patch

from termdeck.models import SessionRecord
from termdeck.session_manager import TerminalSessionManager


def record(session_id: str, **overrides) -> SessionRecord:
    fields = dict(session_id=session_id, title=session_id, title_user_set=False, command="codex",
                  cwd="/tmp", agent_kind="codex", agent_session_id=None, created_at_est="2026-09-18 10:00:00",
                  draft="", project="stock")
    fields.update(overrides)
    return SessionRecord(**fields)


class SpawnedByRecordTest(unittest.TestCase):
    """A spawned agent is filed under the terminal that asked for it, so that link has to outlive the
    request that created it -- the sidebar draws the stack long after the task API has returned."""

    def test_the_link_survives_a_round_trip_through_storage(self) -> None:
        # Sessions are reloaded from JSON on every restart, so a field that does not survive to_dict and
        # back is a stack that quietly flattens the next time the deck starts.
        original = record("child", spawned_by_session_id="parent")

        restored = SessionRecord.from_dict(original.to_dict())

        self.assertEqual(restored.spawned_by_session_id, "parent")

    def test_a_record_written_before_the_field_existed_still_loads(self) -> None:
        payload = record("old").to_dict()
        del payload["spawned_by_session_id"]

        self.assertIsNone(SessionRecord.from_dict(payload).spawned_by_session_id)

    def test_it_is_distinct_from_the_agent_fork_parent(self) -> None:
        # fork_parent_agent_session_id is the AGENT's own session that a fork continues. This is
        # TermDeck's terminal that issued the request. Conflating them would file a forked terminal
        # under a session id the sidebar has never heard of.
        spawned = record("child", spawned_by_session_id="deck-parent",
                         fork_parent_agent_session_id="agent-uuid")

        self.assertNotEqual(spawned.spawned_by_session_id, spawned.fork_parent_agent_session_id)


class SetSpawnedByTest(unittest.TestCase):
    def setUp(self) -> None:
        self.manager = TerminalSessionManager.__new__(TerminalSessionManager)
        self.manager._sessions = {name: SimpleNamespace(record=record(name)) for name in ("parent", "child")}
        for method in ("_persist", "_broadcast_status"):
            patcher = patch.object(TerminalSessionManager, method, lambda *a, **k: None)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_it_records_the_parent(self) -> None:
        self.manager.set_spawned_by("child", "parent")

        self.assertEqual(self.manager._sessions["child"].record.spawned_by_session_id, "parent")

    def test_a_terminal_cannot_be_its_own_parent(self) -> None:
        # The sidebar walks from child to parent to place a row. A self-reference is a stack that
        # contains itself, which cannot be drawn.
        self.manager.set_spawned_by("child", "child")

        self.assertIsNone(self.manager._sessions["child"].record.spawned_by_session_id)

    def test_a_parent_the_deck_does_not_have_is_ignored(self) -> None:
        # Otherwise the child is filed under a row that will never be rendered, and disappears.
        self.manager.set_spawned_by("child", "closed-long-ago")

        self.assertIsNone(self.manager._sessions["child"].record.spawned_by_session_id)


if __name__ == "__main__":
    unittest.main()
