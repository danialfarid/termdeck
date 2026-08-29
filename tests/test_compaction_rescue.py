import unittest

from termdeck.compaction_rescue import build_rescue_payload, find_missing_lines, strip_ansi

MARKER = "Conversation compacted"

# A run of erase-and-up pairs then a bigger jump, matching a real capture's shape: the
# redraw erases line by line on its way up, then jumps once more to where it prints its
# own announcement.
ERASE_RUN = b"\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[115A"


class FindMissingLinesTest(unittest.TestCase):
    def test_erased_line_is_reported_missing(self) -> None:
        # "line one" reappears after the marker (the redraw rewrote it); "line two" never
        # does, so only it comes back as missing.
        data = b"line one\r\nline two\r\n" + ERASE_RUN + b"line one\r\n" + MARKER.encode() + b"\r\n"

        missing = find_missing_lines(["line one", "line two"], data, MARKER)

        self.assertEqual(missing, ["line two"])

    def test_line_reprinted_verbatim_is_not_reported_missing(self) -> None:
        data = b"important context\r\n" + ERASE_RUN + b"important context\r\n" + MARKER.encode() + b"\r\n"

        self.assertEqual(find_missing_lines(["important context"], data, MARKER), [])

    def test_rewrapped_line_is_not_reported_missing(self) -> None:
        # Same words, re-wrapped with an extra newline the terminal inserted -- not the
        # kind of difference that should count as "gone".
        data = b"one\r\n" + ERASE_RUN + b"a long line\r\nthat wrapped\r\n" + MARKER.encode() + b"\r\n"

        self.assertEqual(find_missing_lines(["a long line that wrapped"], data, MARKER), [])

    def test_short_candidates_are_skipped(self) -> None:
        # Too collision-prone to trust a substring match on either side, so it is never
        # even considered rather than risk a false rescue either way.
        data = b"47\r\n" + ERASE_RUN + MARKER.encode() + b"\r\n"

        self.assertEqual(find_missing_lines(["47"], data, MARKER), [])

    def test_no_marker_in_data_returns_nothing(self) -> None:
        data = b"some ordinary output\r\nwith no compaction in it\r\n"

        self.assertEqual(find_missing_lines(["some ordinary output"], data, MARKER), [])

    def test_blank_marker_text_returns_nothing(self) -> None:
        data = b"line one\r\n" + MARKER.encode() + b"\r\n"

        self.assertEqual(find_missing_lines(["line one"], data, ""), [])

    def test_preserves_candidate_order(self) -> None:
        data = b"alpha beta gamma\r\ndelta epsilon zeta\r\n" + ERASE_RUN + MARKER.encode() + b"\r\n"

        self.assertEqual(find_missing_lines(["alpha beta gamma", "delta epsilon zeta"], data, MARKER),
                         ["alpha beta gamma", "delta epsilon zeta"])

    def test_candidate_before_the_redraw_is_not_confused_with_survival(self) -> None:
        # The candidate's own original, pre-erasure occurrence sits earlier in this same
        # append-only recording. Only what the redraw itself writes should count as survival.
        data = b"line two\r\n" + ERASE_RUN + MARKER.encode() + b"\r\n"

        self.assertEqual(find_missing_lines(["line two"], data, MARKER), ["line two"])


class StripAnsiTest(unittest.TestCase):
    def test_strips_csi_and_osc_sequences(self) -> None:
        data = b"\x1b[38;2;1;2;3mcolored\x1b[39m\x1b]0;a title\x07 text"

        self.assertEqual(strip_ansi(data), "colored text")


class BuildRescuePayloadTest(unittest.TestCase):
    def test_payload_contains_divider_and_lines(self) -> None:
        payload = build_rescue_payload(["recovered one", "recovered two"], divider="-- recovered --")

        text = payload.decode()
        self.assertIn("-- recovered --", text)
        self.assertIn("recovered one\r\nrecovered two", text)

    def test_payload_does_not_pad_with_blank_lines(self) -> None:
        # A compaction has already finished and settled by the time this runs -- nothing is
        # about to erase anything, so there is no reason to force a scroll the way the
        # PreCompact-armed carry payload does. Regression coverage for a real live bug: this
        # padding once flooded a session with hundreds of blank rows on every rescue.
        payload = build_rescue_payload(["one line"], divider="-- recovered --")

        self.assertNotIn(b"\x1b[9999", payload)
        self.assertEqual(payload.count(b"\r\n"), 3)


if __name__ == "__main__":
    unittest.main()
