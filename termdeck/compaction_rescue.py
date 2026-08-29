"""Recover conversation lines a compaction redraw erased instead of just scrolled.

Two different things happen to on-screen content when Claude Code compacts: real overflow
scrolling relocates it into scrollback (still there, nothing to do), and the redraw's own
in-place erase-and-rewrite genuinely destroys whatever is under it. This module targets the
second case only, using the recording TermDeck already keeps (ms.raw_replay_buffer / the
.claude-replay.bin file) to check for it -- no new buffering, no server-side terminal
emulation. The recording is append-only, so a destroyed line's original bytes are still
sitting in it; what makes it destroyed is that nothing in the redraw's own output writes
that text again. Checking presence in the redraw's own bytes (not the whole recording, which
trivially contains everything ever written) is what makes that check mean something.

Candidates -- the lines to check -- are the caller's job, not this module's: an earlier
version extracted them from the raw recording itself (the text between escape sequences),
and it produced garbage on real captures. The composer echoes a typed prompt word-by-word
with absolute column jumps (\\x1b[<N>G per word) for its own wrap layout, and joining the
text between those jumps mashes adjacent words together with no space -- "any tools. In
your" became "anytools.Inyour" became, once nothing matched, unreadable fragments reported
as "missing". The transcript (see agents/claude.py's parse_transcript_lines) has no such
artifacts -- it is the message text as authored, not as column-positioned -- so the caller
should source candidates from there.
"""

import re

ANSI_RE = re.compile(rb"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]")
_WHITESPACE_RE = re.compile(r"\s+")

# Candidates shorter than this (after whitespace normalization) are skipped: a single digit
# or short token is too likely to turn up somewhere in the redraw's own chrome by coincidence
# (a row/column number, a token count) to trust a plain substring match against it either way.
CANDIDATE_MIN_CHARS = 4


def strip_ansi(data: bytes) -> str:
    return ANSI_RE.sub(b"", data).decode("utf-8", errors="replace")


def _normalize(text: str) -> str:
    # Collapses whatever whitespace differences the terminal's own wrapping introduces
    # (extra newlines, run-together spaces) so a line that survived intact but re-wrapped
    # differently is not reported as missing over formatting alone.
    return _WHITESPACE_RE.sub(" ", text).strip()


def find_marker_offset(data: bytes, marker_text: str) -> int | None:
    if not marker_text:
        return None
    index = data.rfind(marker_text.encode("utf-8", errors="ignore"))
    return index if index >= 0 else None


def _redraw_start_offset(data: bytes, marker_offset: int) -> int:
    """Where the trailing run of pure escape-code/whitespace bytes before the marker begins.

    Not a fixed lookback: a fixed byte margin is either too small to cover a longer erase
    run, or -- on a short recording -- large enough to spill backward past it into content
    the redraw never touched, which would make every candidate look "found" trivially. This
    walks the actual escape sequences instead, so the boundary is wherever real (non-
    whitespace) text last appears before the start of the LAST escape run leading into the
    marker. Deliberately not the last content before the marker itself: text sitting between
    that final escape run and the marker is the redraw's own new output (it just printed
    something, then announced itself), not surviving pre-compaction content -- treating it as
    a candidate instead of search text would compare it against itself and call it missing.
    """
    cursor = 0
    last_content_end = 0
    for match in ANSI_RE.finditer(data, 0, marker_offset):
        if data[cursor:match.start()].strip(b"\r\n"):
            last_content_end = match.start()
        cursor = match.end()
    return last_content_end


def find_missing_lines(candidates: list[str], data: bytes, marker_text: str) -> list[str]:
    """Which of `candidates` (recent pre-compaction transcript lines) never reappear in the
    compaction's own redraw output.

    Returns them in the order given. Empty if the marker cannot be found in `data` at all --
    including when the caller passed a marker that never made it into the terminal output,
    which is deliberately treated as "nothing to rescue" rather than guessed at.
    """
    marker_offset = find_marker_offset(data, marker_text)
    if marker_offset is None:
        return []
    redraw_start = _redraw_start_offset(data, marker_offset)
    post_text = _normalize(strip_ansi(data[redraw_start:]))
    missing = []
    for line in candidates:
        normalized = _normalize(line)
        if len(normalized) >= CANDIDATE_MIN_CHARS and normalized not in post_text:
            missing.append(line)
    return missing


def build_rescue_payload(missing_lines: list[str], rows: int, divider: str) -> bytes:
    """A divider plus the recovered lines, pushed into true scrollback.

    \\x1b[9999;1H clamps to the client's own last row whatever its height, so the newlines
    that follow always scroll rather than merely moving the cursor down within existing
    blank space -- same trick session_manager's own compaction-carry payload uses.
    """
    body = "\r\n".join(missing_lines)
    return (f"\r\n{divider}\r\n{body}\r\n" + "\x1b[9999;1H" + "\r\n" * (rows + 4)).encode()
