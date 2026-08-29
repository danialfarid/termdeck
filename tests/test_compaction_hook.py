import unittest
from unittest.mock import MagicMock

from termdeck.config import TermdeckConfig
from termdeck.session_manager import TerminalSessionManager


class ApplyAgentCompactionHookTest(unittest.TestCase):
    def setUp(self) -> None:
        self.manager = TerminalSessionManager.__new__(TerminalSessionManager)
        self.written: list[bytes] = []
        self.manager._handle_output = lambda ms, data, mark_activity=True: self.written.append(data)
        self.ms = MagicMock()
        self.ms.record.agent_session_id = "agent-1"
        self.ms.record.session_id = "term-1"
        self.ms.rows = 40
        self.ms.raw_replay_buffer = bytearray(b"recorded")
        self.ms.buffer = bytearray()
        self.manager._sessions = {"term-1": self.ms}

    def test_carries_the_screen_into_scrollback(self):
        self.assertEqual(self.manager.apply_agent_compaction_hook("agent-1"), "term-1")
        payload = b"".join(self.written).decode()
        self.assertIn(TermdeckConfig.COMPACT_DIVIDER, payload)
        # Sent to the client's own last row, so what follows scrolls instead of moving the cursor.
        self.assertIn("\x1b[9999;1H", payload)
        self.assertEqual(payload.count("\r\n"), self.ms.rows + 5)

    def test_a_session_this_server_does_not_own_is_a_no_op(self):
        self.assertIsNone(self.manager.apply_agent_compaction_hook("someone-elses-session"))
        self.assertEqual(self.written, [])

    def test_missing_session_id_is_a_no_op(self):
        self.assertIsNone(self.manager.apply_agent_compaction_hook(""))
        self.assertEqual(self.written, [])

    def test_a_terminal_with_nothing_recorded_is_left_alone(self):
        # Nothing has been drawn yet, so there is no screen worth carrying anywhere.
        self.ms.raw_replay_buffer = bytearray()
        self.ms.buffer = bytearray()
        self.assertEqual(self.manager.apply_agent_compaction_hook("agent-1"), "term-1")
        self.assertEqual(self.written, [])


if __name__ == "__main__":
    unittest.main()
