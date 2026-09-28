"""DraftInputTracker must only track text the user typed, never the terminal's own replies.

A bare Escape keypress used to linger in the cross-chunk carry and glue onto the next input
chunk, so Esc followed by a focus-out report ("\\x1b" then "\\x1b[O") parsed as Alt+ESC plus
literal "[O" text -- a phantom draft that stuck the sidebar pen on with an empty composer.
"""

import unittest

from termdeck.draft_tracker import DraftInputTracker


def fed(*chunks: str) -> str:
    tracker = DraftInputTracker("")
    for chunk in chunks:
        tracker.feed(chunk)
    return tracker.draft


class DraftInputTrackerTest(unittest.TestCase):
    def test_escape_then_focus_report_leaves_no_draft(self) -> None:
        self.assertEqual(fed("\x1b", "\x1b[O"), "")

    def test_escape_then_text_keeps_the_text(self) -> None:
        self.assertEqual(fed("\x1b", "hi"), "hi")

    def test_escape_then_enter_submits(self) -> None:
        self.assertEqual(fed("ab", "\x1b", "\r"), "")

    def test_genuinely_split_csi_still_glues(self) -> None:
        self.assertEqual(fed("\x1b[", "O"), "")
        self.assertEqual(fed("\x1b", "[O"), "")

    def test_ss3_function_key_and_arrows_skipped(self) -> None:
        self.assertEqual(fed("\x1bOP"), "")
        self.assertEqual(fed("ab", "\x1bOA"), "ab")

    def test_split_ss3_still_glues(self) -> None:
        self.assertEqual(fed("\x1b", "OP"), "")

    def test_legacy_x10_mouse_report_skipped_whole_and_split(self) -> None:
        self.assertEqual(fed("\x1b[Ma##"), "")
        self.assertEqual(fed("\x1b[Ma", "##"), "")

    def test_sgr_mouse_report_skipped(self) -> None:
        self.assertEqual(fed("\x1b[<0;10;20M"), "")

    def test_plain_editing_contract(self) -> None:
        self.assertEqual(fed("ab", "\x7f", "c"), "ac")
        self.assertEqual(fed("ab", "\r"), "")
        self.assertEqual(fed("ab", "\x03"), "")
        self.assertEqual(fed("one two", "\x17"), "one ")
        self.assertEqual(fed("one two", "\x15"), "")
        self.assertEqual(fed("\x1b[200~a\rb\x1b[201~"), "a\nb")
