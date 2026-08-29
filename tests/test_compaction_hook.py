import time
import unittest
from unittest.mock import MagicMock

from termdeck.config import TermdeckConfig
from termdeck.session_manager import TerminalSessionManager

# The redraw a compaction makes: up over everything it has drawn, then erase line by line.
COMPACTION_REDRAW = b"\x1b[112A\x1b[?25h\x1b[?25l\x1b[112B" + b"\x1b[2K\x1b[1A" * 40
# What an ordinary status repaint moves.
STATUS_REPAINT = b"\x1b[8A\x1b[2Kworking\x1b[8B"


class CompactionHookTest(unittest.TestCase):
    def setUp(self) -> None:
        self.manager = TerminalSessionManager.__new__(TerminalSessionManager)
        self.ms = MagicMock()
        self.ms.record.agent_session_id = "agent-1"
        self.ms.record.session_id = "term-1"
        self.ms.rows = 40
        self.ms.raw_replay_buffer = bytearray(b"recorded")
        self.ms.buffer = bytearray()
        self.ms.compaction_armed_until = 0.0
        self.manager._sessions = {"term-1": self.ms}

    def carry(self, data: bytes) -> bytes:
        return self.manager._carry_screen_before_compaction_redraw(self.ms, data)

    def test_hook_arms_without_touching_the_screen(self):
        # Scrolling at hook time would throw the screen away while it is still being read.
        self.assertEqual(self.manager.apply_agent_compaction_hook("agent-1"), "term-1")
        self.assertGreater(self.ms.compaction_armed_until, time.monotonic())
        self.assertEqual(self.carry(STATUS_REPAINT), STATUS_REPAINT)

    def test_the_redraw_is_found_behind_the_spinner_repaints_it_arrives_with(self):
        # A pty read carries the compaction spinner's own small repaints ahead of the redraw, so
        # taking the first jump in the chunk finds one far too small and rescues nothing.
        self.manager.apply_agent_compaction_hook("agent-1")
        out = self.carry(b"\x1b[4A\x1b[2K\x1b[4B\x1b[8A\x1b[2K\x1b[8B" + COMPACTION_REDRAW)
        self.assertIn(TermdeckConfig.COMPACT_DIVIDER.encode(), out)
        self.assertLess(out.index(b"\x1b[9999;1H"), out.index(b"\x1b[112A"))
        # The spinner repaints ahead of it are still delivered untouched, and first.
        self.assertTrue(out.startswith(b"\x1b[4A\x1b[2K\x1b[4B"))

    def test_armed_redraw_carries_the_screen_first(self):
        self.manager.apply_agent_compaction_hook("agent-1")
        out = self.carry(COMPACTION_REDRAW)
        self.assertIn(TermdeckConfig.COMPACT_DIVIDER.encode(), out)
        self.assertIn(b"\x1b[9999;1H", out)
        self.assertEqual(out.count(b"\r\n"), self.ms.rows + 5)
        # The rescue is spliced in ahead of the redraw, which itself arrives intact.
        self.assertLess(out.index(b"\x1b[9999;1H"), out.index(b"\x1b[112A"))
        self.assertTrue(out.endswith(COMPACTION_REDRAW))

    def test_it_fires_once_per_compaction(self):
        self.manager.apply_agent_compaction_hook("agent-1")
        self.assertNotEqual(self.carry(COMPACTION_REDRAW), COMPACTION_REDRAW)
        self.assertEqual(self.carry(COMPACTION_REDRAW), COMPACTION_REDRAW)

    def test_an_unarmed_redraw_is_left_alone(self):
        # Over a thousand jumps this size happen per 24MB outside a compaction.
        self.assertEqual(self.carry(COMPACTION_REDRAW), COMPACTION_REDRAW)

    def test_the_arm_expires(self):
        self.manager.apply_agent_compaction_hook("agent-1")
        self.ms.compaction_armed_until = time.monotonic() - 1
        self.assertEqual(self.carry(COMPACTION_REDRAW), COMPACTION_REDRAW)

    def test_a_session_this_server_does_not_own_is_a_no_op(self):
        self.assertIsNone(self.manager.apply_agent_compaction_hook("someone-elses-session"))
        self.assertEqual(self.ms.compaction_armed_until, 0.0)

    def test_missing_session_id_is_a_no_op(self):
        self.assertIsNone(self.manager.apply_agent_compaction_hook(""))
        self.assertEqual(self.ms.compaction_armed_until, 0.0)

    def test_fallback_carries_the_screen_when_the_redraw_never_arrives(self):
        # The redraw is a race the hook loses about half the time, so waiting forever loses the
        # conversation; the bounded wait costs an early scroll instead.
        written: list[bytes] = []
        self.manager._handle_output = lambda ms, data, mark_activity=True: written.append(data)
        self.manager.apply_agent_compaction_hook("agent-1")
        self.manager._carry_screen_if_still_armed(self.ms)
        self.assertIn(TermdeckConfig.COMPACT_DIVIDER.encode(), b"".join(written))
        self.assertEqual(self.ms.compaction_armed_until, 0.0)

    def test_fallback_does_nothing_once_the_redraw_has_been_handled(self):
        written: list[bytes] = []
        self.manager._handle_output = lambda ms, data, mark_activity=True: written.append(data)
        self.manager.apply_agent_compaction_hook("agent-1")
        self.carry(COMPACTION_REDRAW)          # the redraw won the race
        self.manager._carry_screen_if_still_armed(self.ms)
        self.assertEqual(written, [])          # so the fallback must not scroll a second time

    def test_a_terminal_with_nothing_drawn_yet_is_left_alone(self):
        self.ms.raw_replay_buffer = bytearray()
        self.ms.buffer = bytearray()
        self.manager.apply_agent_compaction_hook("agent-1")
        self.assertEqual(self.carry(COMPACTION_REDRAW), COMPACTION_REDRAW)


if __name__ == "__main__":
    unittest.main()
