from datetime import date, datetime
from zoneinfo import ZoneInfo


class OscTitleParser:
    """Extracts the latest OSC 0/1/2 window-title escape sequence from a terminal byte stream, tolerating
    sequences split across read chunks via a carry buffer returned to the caller."""

    OSC_PREFIX = b"\x1b]"
    ESC = b"\x1b"
    BEL = b"\x07"
    ST = b"\x1b\\"
    PARAM_SEP = b";"
    TITLE_PARAMS = (b"0", b"1", b"2")
    CARRY_MAX = 4096

    @staticmethod
    def extract_latest_title(carry: bytes, data: bytes) -> tuple[str | None, bytes]:
        stream = carry + data
        title: str | None = None
        pos = 0
        while True:
            start = stream.find(OscTitleParser.OSC_PREFIX, pos)
            if start == -1:
                trailing_esc = stream[-1:] if stream.endswith(OscTitleParser.ESC) else b""
                return title, trailing_esc
            body_start = start + len(OscTitleParser.OSC_PREFIX)
            bel_end = stream.find(OscTitleParser.BEL, body_start)
            st_end = stream.find(OscTitleParser.ST, body_start)
            ends = [end for end in (bel_end, st_end) if end != -1]
            if not ends:
                return title, stream[start:][-OscTitleParser.CARRY_MAX:]
            end = min(ends)
            body = stream[body_start:end]
            sep = body.find(OscTitleParser.PARAM_SEP)
            if sep != -1 and body[:sep] in OscTitleParser.TITLE_PARAMS:
                title = body[sep + 1:].decode("utf-8", errors="replace")
            pos = end + 1


class TimeUtil:
    """EST-naive timestamps for stored records (house convention: persisted datetimes are EST naive)."""

    EST_ZONE = ZoneInfo("America/New_York")

    @staticmethod
    def now_est_naive() -> datetime:
        return datetime.now(TimeUtil.EST_ZONE).replace(tzinfo=None)

    @staticmethod
    def now_est_naive_iso() -> str:
        return TimeUtil.now_est_naive().isoformat(sep=" ", timespec="seconds")

    @staticmethod
    def today_est() -> date:
        return TimeUtil.now_est_naive().date()
