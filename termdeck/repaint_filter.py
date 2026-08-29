"""Stop status-bar repaints from flooding scrollback with blank lines.

Agent CLIs redraw their bottom status block by walking the cursor down through it with literal
newlines and then moving straight back up. On the terminal's last row a newline SCROLLS, so every
such repaint evicts a real line of history and replaces it with a blank one -- the block looks
stationary only because the CLI redraws it after each scroll. Measured on a real claude compaction:
1,109 repaint frames emitted 8,764 lines, 7,655 of them blank, carrying just 104 distinct strings.
That is 44% of a 20,000-line browser scrollback consumed in seconds, which is why history vanishes
the moment a compaction runs rather than gradually as work continues.

A newline run immediately followed by a cursor-up is by definition a walk-and-return: the newlines
contribute no text, and their only lasting effect is the scroll. Rewriting the run as a cursor-down
moves the cursor to the same row and column without touching the scrollback, so the CLI's own redraw
lands exactly where it did before. Content output never matches, because content does not emit blank
lines and then immediately move back up over them.

The rewrite happens only when the cursor-up is present in the same pty read. Holding bytes back to
wait for it would stall the last line of any output that ends in a newline, which is most of it; a
repaint split across two reads is simply passed through as it is today.
"""

import re


class RepaintFilter:
    # A run of blank lines the cursor walks through, and the moves that may follow it without
    # changing the row -- horizontal positioning (C/D/G) and cursor show/hide -- before the
    # cursor-up that proves the run was a walk-and-return.
    WALK_AND_RETURN = re.compile(
        rb"((?:\r?\n)+)((?:\x1b\[[0-9;]*[CDG]|\x1b\[\?25[hl])*\x1b\[[0-9]*A)")
    # Below this a repaint costs less than the risk of rewriting it; observed frames walk 8.
    MIN_RUN_LINES = 2

    def __init__(self) -> None:
        self.collapsed_lines = 0

    def feed(self, data: bytes) -> bytes:
        """Return data with walk-and-return newline runs rewritten as cursor moves."""
        if b"\n" not in data:
            return data

        def rewrite(match: re.Match) -> bytes:
            lines = match.group(1).count(b"\n")
            if lines < self.MIN_RUN_LINES:
                return match.group(0)
            self.collapsed_lines += lines
            # \r preserves the column-0 semantics of the newlines; CSI B lands on the same row
            # without scrolling. The trailing cursor-up is passed through untouched.
            return b"\r\x1b[" + str(lines).encode() + b"B" + match.group(2)

        return self.WALK_AND_RETURN.sub(rewrite, data)
