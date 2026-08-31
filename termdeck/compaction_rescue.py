"""Replay the terminal's own recent content after a compaction redraw, verbatim.

Two different things happen to on-screen content when Claude Code compacts: real overflow
scrolling relocates it into scrollback (still there, nothing to do), and the redraw's own
in-place erase-and-rewrite genuinely destroys whatever is under it. Rather than try to detect
which lines specifically fell into the second case -- diffing against a redraw's own output
turned out to have real false-positive and false-negative edges (a typed prompt the composer
echoes with column jumps instead of literal spaces reads as "missing" under substring
matching whether or not it actually is; tool output that IS the answer to what was asked lives
in the transcript under a different role than assistant text, and filtering by role can miss
it) -- this just takes the last several pages of what the terminal actually displayed and
replays them unconditionally. Costs some duplication for whatever did survive; guarantees
nothing recently on screen is silently gone. Pure terminal byte handling over the recording
TermDeck already keeps (ms.raw_replay_buffer / the .claude-replay.bin file) -- no transcript,
no server-side terminal emulation.

The replay stays as BYTES, not extracted text. That recording is the same one TermDeck already
replays verbatim to rebuild a terminal on attach, so it is known to render correctly as-is;
only the motions that would walk back up over the live screen are removed. An earlier version
stripped every escape and re-emitted plain text, which destroyed the spacing -- Claude places
words with absolute column jumps rather than literal spaces -- and put "/debugEnabledebug
logging..." on a real user's screen.

The snapshot is taken when a compaction STARTS rather than when it finishes (see
TerminalSessionManager._detect_compaction_marker): at that point the buffer still holds the
conversation intact, so there is nothing to reconstruct and no boundary to find. Waiting until
the end and slicing the buffer backwards past the redraw was the earlier approach, and it
depended on recognising the finished-announcement text -- which Claude Code writes contiguously
only the FIRST time. Every later compaction in a session re-renders it column-positioned
("Conversation\\x1b[16Gcompacted"), so a literal match silently stopped firing after a
session's first compaction, which is exactly what a user hit repeatedly.
"""

import re

ANSI_RE = re.compile(rb"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]")

# The status bar's own walk-cursor-down-then-up redraw (see repaint_filter.py, which targets
# the same shape to stop it wasting scrollback instead of to remove it): two or more newlines
# walking through blank space, then a cursor-up proving the walk was a return rather than real
# progress. Real content is never followed by this -- content does not print a run of blank
# lines and immediately jump back up over them.
_WALK_AND_RETURN_RE = re.compile(rb"(?:\r?\n){2,}(?:\x1b\[[0-9;]*[CDG]|\x1b\[\?25[hl])*\x1b\[[0-9]*A")

# How many of the most recent lines before a compaction's own redraw to replay -- "the last
# few pages" at a rough terminal-page height, not an exact accounting of what the redraw did
# or did not touch.
REPLAY_LINE_COUNT = 200


def strip_ansi(data: bytes) -> str:
    return ANSI_RE.sub(b"", data).decode("utf-8", errors="replace")


def _strip_status_frames(data: bytes) -> bytes:
    """Remove status-bar walk-and-return redraw frames, chrome fragment included, keeping
    everything else.

    A first attempt tried to match the chrome fragment (a spinner glyph, its color codes, a
    bare \\r) in the same regex as the walk-and-return itself, and got the boundary wrong in
    both directions -- interspersed escape sequences it did not anticipate left the fragment
    behind, and a greedy match across consecutive frames misaligned the next one's own escape
    sequences, leaving raw \\x1b bytes in the output (both caught by tests, not live). This
    finds only the well-defined, already-proven walk-and-return span, then uses the nearest
    PRECEDING real newline as the chrome boundary: everything after it and before the span is
    this frame's fragment, whatever bytes it contains, dropped without needing to describe its
    shape at all.
    """
    keep = bytearray()
    cursor = 0
    for match in _WALK_AND_RETURN_RE.finditer(data):
        if match.start() < cursor:
            continue  # inside a frame whose own walk-and-return already consumed this span
        preceding_newline = data.rfind(b"\n", cursor, match.start())
        chrome_start = preceding_newline + 1 if preceding_newline >= 0 else cursor
        keep.extend(data[cursor:chrome_start])
        cursor = match.end()
    keep.extend(data[cursor:])
    return bytes(keep)


def extract_nonblank_lines(data: bytes) -> list[str]:
    """Non-blank lines of real content, with status-bar chrome frames dropped first.

    Text only, for tests and inspection -- NOT for replaying: see extract_recent_bytes for why
    stripping the escapes is exactly what a replay must not do.
    """
    clean = _strip_status_frames(data)
    return [line for line in (raw.strip() for raw in strip_ansi(clean).replace("\r", "").split("\n")) if line]


# Sequences that could move the cursor off the line being appended, or erase what is already
# on screen. Everything else is passed through untouched -- crucially the SGR colors and the
# horizontal moves (CSI G/C/D), which is HOW Claude spaces its output: it jumps to an absolute
# column rather than emitting runs of literal spaces. Dropping those (as an earlier version
# did, by stripping all escapes and re-emitting plain text) is what ran the words together
# into "/debugEnabledebuglogging..." -- reported live as "random characters everywhere".
_UNSAFE_MOTION_RE = re.compile(
    rb"\x1b\[[0-9;]*[ABEFHJdfSTr]"      # vertical moves, absolute position, erase display, scroll
    rb"|\x1b\[\?1049[hl]"                # alternate screen
    rb"|\x1b\[\?25[hl]"                  # cursor visibility (the live screen owns this)
    rb"|\x1b[78]"                        # save / restore cursor
)


# A row of the slash-command menu the composer pops open while a command is being typed --
# two spaces, the command, then its description. /compact is itself typed that way, so at the
# moment a compaction starts the menu is the most recent thing on screen: ~130 rows, redrawn on
# every keystroke, which is more than the whole replay budget. It is a transient popup rather
# than conversation, and Claude erases it on submit, so it is dropped instead of replayed.
# A row of that menu, as it looks with the escapes removed. The indentation and the gap before
# each description are column jumps rather than literal spaces, so neither survives stripping --
# only the leading command name does, which is what this matches.
_MENU_ROW_RE = re.compile(r"^\s*/[a-z0-9][a-z0-9-]{1,30}(?:\s|$)")


def _menu_start_index(lines: list[bytes]) -> int | None:
    """Where the trailing command menu begins, or None if there is not one.

    Cut wholesale from the first row to the end rather than filtered row by row: a row's
    description wraps onto continuation rows whose indentation is also column jumps, so they
    are indistinguishable from ordinary text once the escapes are gone, and dropping only the
    rows that ARE identifiable would leave their descriptions behind as orphaned prose.
    """
    for index, line in enumerate(lines):
        if _MENU_ROW_RE.match(strip_ansi(line).replace("\r", "")):
            return index
    return None


def extract_recent_bytes(data: bytes) -> bytes:
    """The last REPLAY_LINE_COUNT lines of the recording, as REPLAYABLE bytes.

    Kept as bytes on purpose. TermDeck already replays this same recording verbatim to rebuild
    a terminal on attach, so the bytes are known to render correctly -- the only reason they
    cannot be appended as-is is that they also carry motions that would walk back up over the
    live screen and erase it. So the escapes are not stripped, only the unsafe motions are
    (see _UNSAFE_MOTION_RE), leaving colors and column positioning intact so the replayed lines
    land spaced exactly as they originally appeared.

    Called at the moment a compaction STARTS, when the buffer still holds the conversation
    exactly as it was -- so there is no redraw to find a boundary against, and no need to
    reason about which bytes the redraw is about to overwrite.
    """
    clean = _strip_status_frames(data)
    lines = clean.rstrip(b"\r\n").split(b"\n")[-REPLAY_LINE_COUNT:]
    # The menu is the newest thing on screen when a compaction starts (/compact is typed into
    # it), so it is cut only from the tail of the budget -- searching the whole slice would
    # throw away conversation that merely happens to mention a slash command earlier on.
    menu_start = _menu_start_index(lines[len(lines) // 2:])
    if menu_start is not None:
        lines = lines[:len(lines) // 2 + menu_start]
    recent = b"\n".join(lines)
    return _UNSAFE_MOTION_RE.sub(b"", recent).lstrip(b"\r\n")


def build_rescue_payload(replay_bytes: bytes, divider: str) -> bytes:
    """A divider plus the replayed bytes, appended where the cursor already is.

    No \\x1b[9999;1H-and-pad-to-`rows` scroll-forcing: that trick belongs to
    session_manager's own compaction-carry payload, which races an erase that has not
    happened yet and must relocate currently-visible content before it does. This runs after
    a compaction has already finished and settled -- nothing is about to erase anything -- so
    forcing a full-height scroll would only flood the screen with blank rows for no benefit
    (confirmed live: this was the actual cause of a real "empty lines" report, not a timing
    bug in when the rescue fires).
    """
    return f"\r\n{divider}\r\n".encode() + replay_bytes + b"\x1b[0m\r\n"
