import unittest

from termdeck.config import TermdeckConfig
from termdeck.replay_recorder import ReplayRecorder


class PreserveScreenBeforeEraseTest(unittest.TestCase):
    """The scroll-ahead is switched off in config; these pin its behaviour for anyone turning it on."""

    def setUp(self) -> None:
        self._original = TermdeckConfig.REPLAY_PRESERVE_ERASE_MIN_ROWS
        TermdeckConfig.REPLAY_PRESERVE_ERASE_MIN_ROWS = 20

    def tearDown(self) -> None:
        TermdeckConfig.REPLAY_PRESERVE_ERASE_MIN_ROWS = self._original

    def test_switched_off_by_default(self):
        # Shipped off: an upward jump does not identify the redraw worth scrolling for.
        self.assertEqual(self._original, 0)

    def test_full_redraw_scrolls_the_screen_out_first(self):
        # The byte shape of a real compaction: jump far up, then erase line by line walking back.
        data = b"\x1b[112A\x1b[?25h\x1b[?25l\x1b[112B" + b"\x1b[2K\x1b[1A" * 20
        out = ReplayRecorder._preserve_screen_before_erase(data)
        self.assertTrue(out.startswith(b"\x1b7\x1b[9999;1H"))
        self.assertEqual(out.count(b"\n"), 114)  # the jump, plus clearance
        self.assertIn(b"\x1b8" + data, out)

    def test_scroll_clears_the_erase_when_it_reaches_past_the_jump(self):
        # A redraw erases further than it jumped, and the rows in between are the ones worth
        # keeping -- scrolling only as far as the jump leaves them under the erase.
        data = b"\x1b[112A\x1b[112B" + b"\x1b[2K\x1b[1A" * 119
        out = ReplayRecorder._preserve_screen_before_erase(data)
        self.assertEqual(out.count(b"\n"), 121)

    def test_scroll_ignores_erases_from_a_later_frame(self):
        # Only the control run belongs to this redraw; text ends it, and what follows is its own.
        data = b"\x1b[112A" + b"\x1b[2K\x1b[1A" * 5 + b"some drawn text" + b"\x1b[2K" * 400
        out = ReplayRecorder._preserve_screen_before_erase(data)
        self.assertEqual(out.count(b"\n"), 114)

    def test_status_repaint_is_left_alone(self):
        # Every jump a normal status repaint makes is far below the threshold.
        for rows in (1, 4, 7, 8, 18):
            data = f"\x1b[{rows}A".encode() + b"\x1b[2K" + b"redraw"
            self.assertEqual(ReplayRecorder._preserve_screen_before_erase(data), data)

    def test_plain_output_is_untouched(self):
        data = b"just some output\r\nand another line\r\n"
        self.assertEqual(ReplayRecorder._preserve_screen_before_erase(data), data)

    def test_several_redraws_each_get_their_own_scroll(self):
        data = b"\x1b[112A" + b"x" + b"\x1b[102A"
        out = ReplayRecorder._preserve_screen_before_erase(data)
        self.assertEqual(out.count(b"\x1b7\x1b[9999;1H"), 2)
        self.assertEqual(out.count(b"\n"), (112 + 2) + (102 + 2))

    def test_bare_cursor_up_counts_as_one_row(self):
        # ESC[A with no parameter means one row, which must not read as zero and slip through.
        self.assertEqual(ReplayRecorder._preserve_screen_before_erase(b"\x1b[A"), b"\x1b[A")

    def test_switch_off_restores_the_old_recording_exactly(self):
        data = b"\x1b[112A" + b"\x1b[2K" * 5
        TermdeckConfig.REPLAY_PRESERVE_ERASE_MIN_ROWS = 0
        self.assertEqual(ReplayRecorder._preserve_screen_before_erase(data), data)


if __name__ == "__main__":
    unittest.main()
