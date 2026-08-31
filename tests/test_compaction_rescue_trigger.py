import unittest
from unittest.mock import MagicMock

from termdeck.config import TermdeckConfig
from termdeck.session_manager import TerminalSessionManager

START = TermdeckConfig.COMPACTION_RESCUE_START_MARKER

# How Claude writes the finished announcement the FIRST time in a session, and how it writes
# it on every later one -- word-by-word with absolute column jumps, as measured in a real
# 4-compaction recording. Both must fire; matching only the first form is why the rescue
# silently stopped working after a session's first compaction.
DONE_FIRST = b"\xe2\x9c\xbb Conversation compacted (ctrl+o for history)"
DONE_REDRAWN = b"\xe2\x9c\xbb\x1b[3GConversation\x1b[16Gcompacted\x1b[26G(ctrl+o\x1b[34Gfor\x1b[38Ghistory)"


class CompactionRescueTriggerTest(unittest.TestCase):
    """_detect_compaction_marker watches live pty output directly -- no transcript file, no
    boundary counting, no staleness tracking needed. It only ever sees bytes freshly arriving
    from the pty, so there is no pre-existing history to ever mistake for something new."""

    def setUp(self) -> None:
        self._enabled = TermdeckConfig.COMPACTION_RESCUE_ENABLED
        TermdeckConfig.COMPACTION_RESCUE_ENABLED = True
        self.addCleanup(setattr, TermdeckConfig, "COMPACTION_RESCUE_ENABLED", self._enabled)
        self.manager = TerminalSessionManager.__new__(TerminalSessionManager)
        self.manager._handle_output = MagicMock()  # type: ignore[method-assign]
        self.ms = MagicMock()
        self.ms.compaction_marker_carry = b""
        self.ms.compaction_snapshot = None
        self.ms.raw_replay_buffer = bytearray()

    def feed(self, *chunks: bytes) -> None:
        # Detect first, then record -- the order _handle_output uses, so a chunk is not yet in
        # the buffer when it is being examined.
        for chunk in chunks:
            self.manager._detect_compaction_marker(self.ms, chunk)
            self.ms.raw_replay_buffer.extend(chunk)

    def payload(self) -> bytes:
        return self.manager._handle_output.call_args.args[1]

    def test_replays_the_conversation_once_a_compaction_finishes(self) -> None:
        self.feed(b"my question\r\nthe answer\r\n", START, DONE_FIRST)

        self.manager._handle_output.assert_called_once()
        self.assertIn(b"my question", self.payload())
        self.assertIn(b"the answer", self.payload())

    def test_redrawn_announcement_also_fires(self) -> None:
        # Every compaction after a session's first writes the announcement this way.
        self.feed(b"my question\r\n", START, DONE_REDRAWN)

        self.manager._handle_output.assert_called_once()
        self.assertIn(b"my question", self.payload())

    def test_nothing_fires_before_the_compaction_finishes(self) -> None:
        # The start marker alone must not touch the screen: the conversation is still on it.
        self.feed(b"my question\r\n", START)

        self.manager._handle_output.assert_not_called()

    def test_announcement_redraws_do_not_replay_again(self) -> None:
        # Claude redraws the finished announcement on every later repaint -- a dozen times in
        # one measured session. Only the first after a start has a snapshot waiting.
        self.feed(b"my question\r\n", START, DONE_FIRST)
        self.manager._handle_output.reset_mock()

        self.feed(DONE_REDRAWN, DONE_REDRAWN, DONE_REDRAWN)

        self.manager._handle_output.assert_not_called()

    def test_a_second_compaction_replays_again(self) -> None:
        self.feed(b"first question\r\n", START, DONE_FIRST)
        self.manager._handle_output.reset_mock()

        self.feed(b"second question\r\n", START, DONE_REDRAWN)

        self.manager._handle_output.assert_called_once()
        self.assertIn(b"second question", self.payload())

    def test_no_markers_never_fires(self) -> None:
        self.feed(b"ordinary output\r\nwith no compaction in it\r\n")

        self.manager._handle_output.assert_not_called()

    def test_markers_split_across_chunks_are_still_detected(self) -> None:
        # A pty read can end anywhere -- the carry buffer must bridge the split.
        self.feed(b"my question\r\n", START[:4], START[4:], DONE_REDRAWN[:20], DONE_REDRAWN[20:])

        self.manager._handle_output.assert_called_once()
        self.assertIn(b"my question", self.payload())

    def test_disabled_never_fires(self) -> None:
        TermdeckConfig.COMPACTION_RESCUE_ENABLED = False

        self.feed(b"my question\r\n", START, DONE_FIRST)

        self.manager._handle_output.assert_not_called()

    def test_nothing_on_screen_yet_replays_nothing(self) -> None:
        self.feed(START, DONE_FIRST)

        self.manager._handle_output.assert_not_called()


if __name__ == "__main__":
    unittest.main()
