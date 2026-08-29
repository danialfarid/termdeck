import unittest

from termdeck.repaint_filter import RepaintFilter


# The exact byte shape of one claude status repaint, taken from a recorded session.
REPAINT_FRAME = (b"\x1b[4B\r\x1b[8A\x1b[38;2;147;165;255m\xe2\x9c\xbb\x1b[39m"
                 b"\r\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\x1b[2C\x1b[4A\x1b[?25h\x1b[?25l\x1b[2D")


class RepaintFilterTest(unittest.TestCase):
    def test_walk_and_return_becomes_cursor_move(self):
        out = RepaintFilter().feed(REPAINT_FRAME)
        self.assertNotIn(b"\n", out)
        self.assertIn(b"\x1b[8B", out)
        # Everything that is not the walk survives untouched.
        self.assertIn(b"\x1b[38;2;147;165;255m\xe2\x9c\xbb\x1b[39m", out)
        self.assertTrue(out.endswith(b"\x1b[2C\x1b[4A\x1b[?25h\x1b[?25l\x1b[2D"))

    def test_counts_lines_it_saved(self):
        f = RepaintFilter()
        for _ in range(10):
            f.feed(REPAINT_FRAME)
        self.assertEqual(f.collapsed_lines, 80)

    def test_real_output_is_untouched(self):
        # Newlines that are not followed by a cursor-up are content and must survive verbatim.
        content = b"line one\r\nline two\r\nline three\r\n"
        self.assertEqual(RepaintFilter().feed(content), content)

    def test_blank_lines_before_more_content_are_untouched(self):
        content = b"paragraph\r\n\r\n\r\nnext paragraph\r\n"
        self.assertEqual(RepaintFilter().feed(content), content)

    def test_single_newline_before_cursor_up_is_left_alone(self):
        # One line is below the rewrite threshold: not worth touching.
        data = b"x\r\n\x1b[1A"
        self.assertEqual(RepaintFilter().feed(data), data)

    def test_split_across_chunks_passes_through_unchanged(self):
        # A repaint straddling two pty reads is left exactly as it arrives: no rewrite, no loss,
        # and above all no byte held back waiting for a cursor-up that may never come.
        f = RepaintFilter()
        pieces = [REPAINT_FRAME[i:i + 7] for i in range(0, len(REPAINT_FRAME), 7)]
        out = b"".join(f.feed(p) for p in pieces)
        self.assertEqual(out, REPAINT_FRAME)

    def test_never_holds_bytes_back(self):
        # Every chunk must come out whole and immediately, or a prompt printed with no trailing
        # output would sit invisible until the next write.
        for payload in [b"hi\r\n", b"\r\n\r\n", b"$ ", b"text\r\n\r\n"]:
            self.assertEqual(RepaintFilter().feed(payload), payload)

    def test_content_then_repaint_keeps_both(self):
        data = b"real output line\r\n" + REPAINT_FRAME
        out = RepaintFilter().feed(data)
        self.assertTrue(out.startswith(b"real output line\r\n"))
        self.assertIn(b"\x1b[8B", out)


if __name__ == "__main__":
    unittest.main()
