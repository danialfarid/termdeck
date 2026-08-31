import unittest

from termdeck.compaction_rescue import REPLAY_LINE_COUNT, build_rescue_payload, extract_nonblank_lines, extract_recent_bytes, strip_ansi

# The exact byte shape of one claude status repaint, taken from a recorded session (same
# capture repaint_filter.py's own tests use).
STATUS_REPAINT = (b"\x1b[4B\r\x1b[8A\x1b[38;2;147;165;255m\xe2\x9c\xbb\x1b[39m"
                  b"\r\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\x1b[2C\x1b[4A\x1b[?25h\x1b[?25l\x1b[2D")


class ExtractNonblankLinesTest(unittest.TestCase):
    def test_returns_the_lines_the_terminal_showed(self) -> None:
        self.assertEqual(extract_nonblank_lines(b"line one\r\nline two\r\n"), ["line one", "line two"])

    def test_limits_to_the_most_recent_lines(self) -> None:
        lines = [f"line {i}" for i in range(REPLAY_LINE_COUNT + 50)]

        result = extract_nonblank_lines(extract_recent_bytes(("\r\n".join(lines) + "\r\n").encode()))

        self.assertEqual(len(result), REPLAY_LINE_COUNT)
        self.assertEqual(result, lines[-REPLAY_LINE_COUNT:])

    def test_preserves_top_to_bottom_order(self) -> None:
        self.assertEqual(extract_nonblank_lines(b"alpha\r\nbeta\r\ngamma\r\n"), ["alpha", "beta", "gamma"])

    def test_blank_lines_are_dropped(self) -> None:
        self.assertEqual(extract_nonblank_lines(b"alpha\r\n\r\n\r\nbeta\r\n"), ["alpha", "beta"])

    def test_empty_input_yields_nothing(self) -> None:
        self.assertEqual(extract_nonblank_lines(b""), [])

    def test_status_bar_repaint_noise_is_dropped(self) -> None:
        # Regression: the spinner's own churn (repeated many times a second for the whole
        # compaction wait) used to fill most of the REPLAY_LINE_COUNT budget with scattered
        # fragments, crowding out real content further back -- confirmed live, a user's own
        # prompt fell out of the window entirely on a session whose spinner ran long enough.
        data = b"my question\r\n" + STATUS_REPAINT * 30

        self.assertEqual(extract_nonblank_lines(data), ["my question"])

    def test_real_content_around_the_noise_survives(self) -> None:
        data = b"before\r\n" + STATUS_REPAINT * 5 + b"after\r\n"

        self.assertEqual(extract_nonblank_lines(data), ["before", "after"])


class StripAnsiTest(unittest.TestCase):
    def test_strips_csi_and_osc_sequences(self) -> None:
        data = b"\x1b[38;2;1;2;3mcolored\x1b[39m\x1b]0;a title\x07 text"

        self.assertEqual(strip_ansi(data), "colored text")


class BuildRescuePayloadTest(unittest.TestCase):
    def test_payload_contains_divider_and_lines(self) -> None:
        payload = build_rescue_payload(b"recovered one\r\nrecovered two", divider="-- recovered --")

        text = payload.decode()
        self.assertIn("-- recovered --", text)
        self.assertIn("recovered one\r\nrecovered two", text)

    def test_payload_does_not_pad_with_blank_lines(self) -> None:
        # A compaction has already finished and settled by the time this runs -- nothing is
        # about to erase anything, so there is no reason to force a scroll the way the
        # PreCompact-armed carry payload does. Regression coverage for a real live bug: this
        # padding once flooded a session with hundreds of blank rows on every rescue.
        payload = build_rescue_payload(b"one line", divider="-- recovered --")

        self.assertNotIn(b"\x1b[9999", payload)
        self.assertEqual(payload.count(b"\r\n"), 3)


if __name__ == "__main__":
    unittest.main()
