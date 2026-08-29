import unittest

from termdeck.config import TermdeckConfig
from termdeck.replay_recorder import ReplayRecorder


class PreserveScreenBeforeEraseTest(unittest.TestCase):
    """Switched off in config; these pin the behaviour for anyone turning it back on."""

    def setUp(self) -> None:
        self._original = TermdeckConfig.REPLAY_PRESERVE_ERASE_MIN_ROWS
        TermdeckConfig.REPLAY_PRESERVE_ERASE_MIN_ROWS = 20

    def tearDown(self) -> None:
        TermdeckConfig.REPLAY_PRESERVE_ERASE_MIN_ROWS = self._original

    def test_switched_off_by_default(self):
        # A cursor jump does not say which redraw is a compaction, so scrolling at each one fills the
        # replay with blank rows and blanks cells the CLI then declines to rewrite.
        self.assertEqual(self._original, 0)

    def test_full_redraw_scrolls_the_screen_out_first(self):
        # The byte shape of a real compaction: jump far up, then erase line by line walking back.
        data = b"\x1b[112A\x1b[?25h\x1b[?25l\x1b[112B" + b"\x1b[2K\x1b[1A" * 20
        out = ReplayRecorder._preserve_screen_before_erase(data)
        self.assertTrue(out.startswith(b"\x1b7\x1b[9999;1H"))
        self.assertEqual(out.count(b"\n"), 112)
        self.assertIn(b"\x1b8" + data, out)

    def test_scroll_depth_ignores_how_far_the_erase_reaches(self):
        # Sizing the scroll from the erase run instead buries the preserved history under blank
        # rows, because an ordinary repaint's erase run is long too.
        data = b"\x1b[112A\x1b[112B" + b"\x1b[2K\x1b[1A" * 400
        out = ReplayRecorder._preserve_screen_before_erase(data)
        self.assertEqual(out.count(b"\n"), 112)

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
        self.assertEqual(out.count(b"\n"), 112 + 102)

    def test_bare_cursor_up_counts_as_one_row(self):
        # ESC[A with no parameter means one row, which must not read as zero and slip through.
        self.assertEqual(ReplayRecorder._preserve_screen_before_erase(b"\x1b[A"), b"\x1b[A")

    def test_switch_off_restores_the_old_recording_exactly(self):
        data = b"\x1b[112A" + b"\x1b[2K" * 5
        TermdeckConfig.REPLAY_PRESERVE_ERASE_MIN_ROWS = 0
        self.assertEqual(ReplayRecorder._preserve_screen_before_erase(data), data)


if __name__ == "__main__":
    unittest.main()
