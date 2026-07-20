from termdeck.config import TermdeckConfig


class DraftInputTracker:
    """Reconstructs the unsubmitted input a user has typed into a terminal from its raw keystroke stream, so a
    server restart can re-inject the draft into the respawned CLI. Printable chars append; backspace pops;
    Enter/Ctrl-C clear (submitted or cancelled); Ctrl-U kills the current line, Ctrl-W / ESC-DEL kill a word;
    shift+enter (ESC CR) becomes a newline; CR inside a bracketed paste is a pasted newline, not a submit;
    all other escape sequences (arrows, function keys) are skipped."""

    ESC = "\x1b"
    CSI_OPENER = "["
    OSC_OPENER = "]"
    DCS_OPENER = "P"
    BEL = "\x07"
    ST = "\x1b\\"
    CSI_FINAL_MIN = 0x40
    CSI_FINAL_MAX = 0x7E
    BACKSPACE = "\x7f"
    CTRL_C = "\x03"
    CTRL_KILL_LINE = "\x15"
    CTRL_KILL_WORD = "\x17"
    ENTER_CHARS = ("\r", "\n")
    PASTE_START_SEQ = "\x1b[200~"
    PASTE_END_SEQ = "\x1b[201~"
    PRINTABLE_MIN = " "
    WORD_BOUNDARY_CHARS = (" ", "\n")

    def __init__(self, initial_draft: str) -> None:
        self._chars: list[str] = list(initial_draft)
        self._escape_pending = ""
        self._in_paste = False

    @property
    def draft(self) -> str:
        return "".join(self._chars)

    def feed(self, text: str) -> None:
        stream = self._escape_pending + text
        self._escape_pending = ""
        i = 0
        while i < len(stream):
            ch = stream[i]
            if ch == self.ESC:
                consumed = self._consume_escape(stream, i)
                if consumed == 0:
                    self._escape_pending = stream[i:]
                    return
                i += consumed
                continue
            if ch in self.ENTER_CHARS:
                if self._in_paste:
                    self._chars.append("\n")
                else:
                    self._chars.clear()
            elif ch == self.CTRL_C:
                self._chars.clear()
            elif ch == self.BACKSPACE:
                if self._chars:
                    self._chars.pop()
            elif ch == self.CTRL_KILL_LINE:
                self._pop_current_line()
            elif ch == self.CTRL_KILL_WORD:
                self._pop_word()
            elif ch >= self.PRINTABLE_MIN and len(self._chars) < TermdeckConfig.DRAFT_MAX_CHARS:
                self._chars.append(ch)
            i += 1

    def _pop_word(self) -> None:
        while self._chars and self._chars[-1] == " ":
            self._chars.pop()
        while self._chars and self._chars[-1] not in self.WORD_BOUNDARY_CHARS:
            self._chars.pop()

    def _pop_current_line(self) -> None:
        while self._chars and self._chars[-1] != "\n":
            self._chars.pop()

    def _consume_escape(self, stream: str, start: int) -> int:
        if start + 1 >= len(stream):
            return 0
        following = stream[start + 1]
        if following == "\r":
            self._chars.append("\n")
            return 2
        if following == self.BACKSPACE:
            self._pop_word()
            return 2
        if following in (self.OSC_OPENER, self.DCS_OPENER):
            bel_end = stream.find(self.BEL, start + 2)
            st_end = stream.find(self.ST, start + 2)
            ends = [(end, terminator_len) for end, terminator_len in ((bel_end, 1), (st_end, 2)) if end != -1]
            if not ends:
                return 0
            end, terminator_len = min(ends)
            return end + terminator_len - start
        if following != self.CSI_OPENER:
            return 2
        j = start + 2
        while j < len(stream):
            if self.CSI_FINAL_MIN <= ord(stream[j]) <= self.CSI_FINAL_MAX:
                sequence = stream[start:j + 1]
                if sequence == self.PASTE_START_SEQ:
                    self._in_paste = True
                elif sequence == self.PASTE_END_SEQ:
                    self._in_paste = False
                return j - start + 1
            j += 1
        return 0
