"""A Codex thread kept in pages is read from the page codex is writing, back through the ones before.

Codex 0.162 keeps a thread's history in pages. Taken back to an earlier point, a thread goes on in a new
file -- `rollout-<started>-<thread>_<page>.jsonl` -- whose first line names where the history before it
ends: a file, by that file's own id, and a byte. The earlier file is not written again. TermDeck looked
only for `rollout-<started>-<thread>.jsonl`, so it kept reading the first file: nothing said after the
new page started appeared in the transcript, and every prompt sent since stayed "not sent".
"""

import asyncio
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import WebSocketDisconnect

from termdeck.agents.codex import CodexCli
from termdeck.config import TermdeckConfig
from termdeck.server import TermdeckServer
from termdeck.transcript_service import TranscriptService

THREAD = "01a12c0d-311f-77f0-8b99-faecc4eab79c"
PAGE = "01a131d6-30d8-7483-af10-9d50444eceb8"
PARENT = "01a1099e-b6ab-7851-bd06-f46ec1728171"
PARENT_PAGE = "01a12b39-5aa3-7590-88cd-403fb8cc0dbe"


def meta(thread: str, base: tuple[str, int] | None = None) -> str:
    payload: dict[str, object] = {"id": thread, "session_id": thread, "history_mode": "paginated"}
    if base is not None:
        payload["history_base"] = {"thread_id": base[0], "end_byte_offset": base[1], "end_ordinal_exclusive": 1}
    return json.dumps({"timestamp": "2026-10-12T20:00:00.000Z", "type": "session_meta", "payload": payload}) + "\n"


def said(role: str, text: str, stamp: str) -> str:
    kind = "input_text" if role == "user" else "output_text"
    return json.dumps({"timestamp": stamp, "type": "response_item",
                       "payload": {"type": "message", "role": role, "content": [{"type": kind, "text": text}]}}) + "\n"


class PagedThreadHarness(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, True)
        self.root = Path(directory) / "sessions"
        self.day_one = self.root / "2026" / "10" / "11"
        self.day_two = self.root / "2026" / "10" / "12"
        self.day_one.mkdir(parents=True)
        self.day_two.mkdir(parents=True)
        for target, value in (("sessions_root", self.root), ("ROLLOUT_PAGE_CHECK_SECONDS", 0.0)):
            patcher = patch.object(CodexCli, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        days = patch.object(CodexCli, "_recent_day_dirs", staticmethod(lambda: [self.day_one, self.day_two]))
        days.start()
        self.addCleanup(days.stop)
        self.codex = CodexCli()
        # The first file: the conversation up to where it was taken back, then what was set aside.
        kept = meta(THREAD) + said("user", "first question", "2026-10-11T18:00:00.000Z") + \
            said("assistant", "first answer", "2026-10-11T18:00:01.000Z")
        self.first = self.day_one / f"rollout-2026-10-11T13-40-24-{THREAD}.jsonl"
        self.first.write_text(kept + said("user", "set-aside question", "2026-10-12T18:10:00.000Z") +
                              said("assistant", "set-aside answer", "2026-10-12T18:10:01.000Z"))
        self.branch_at = len(kept.encode())

    def write_page(self, *lines: str) -> Path:
        page = self.day_two / f"rollout-2026-10-12T16-38-03-{THREAD}_{PAGE}.jsonl"
        page.write_text(meta(THREAD, (THREAD, self.branch_at)) + "".join(lines))
        return page

    def texts(self, page: dict) -> list[str]:
        return [str(turn.get("text")) for turn in page["turns"] if turn.get("role") in ("user", "assistant")]


class FindingThePageTest(PagedThreadHarness):
    def test_the_page_being_written_is_the_transcript(self) -> None:
        page = self.write_page(said("user", "after the page started", "2026-10-12T20:40:00.000Z"))

        self.assertEqual(self.codex.transcript_path(None, THREAD), page)

    def test_a_page_started_after_the_first_look_is_followed(self) -> None:
        self.assertEqual(self.codex.transcript_path(None, THREAD), self.first)
        page = self.write_page()

        self.assertEqual(self.codex.transcript_path(None, THREAD), page)

    def test_a_page_belongs_to_its_thread(self) -> None:
        page = self.write_page()

        self.assertEqual(self.codex.session_id_from_path(page), THREAD)
        self.assertEqual(self.codex.session_id_from_path(self.first), THREAD)

    def test_a_write_to_the_page_updates_the_terminal_activity(self) -> None:
        # Matched by a name ending in the thread id, a write to a later page -- which ends in its own id --
        # never reached the terminal's busy state.
        page = self.write_page()
        other = self.day_two / f"rollout-2026-10-12T16-38-03-{PARENT}_{PARENT_PAGE}.jsonl"
        other.write_text(meta(PARENT))
        ms = SimpleNamespace(record=SimpleNamespace(agent_session_id=THREAD),
                             agent_state=SimpleNamespace(transcript_active=False, activity_signature=None))
        manager = MagicMock()
        manager._tracker.codex_session_is_active.return_value = True

        with patch.object(CodexCli, "activity_signature", return_value="signature"):
            self.codex.on_transcript_event(manager, ms, other)
            self.assertFalse(ms.agent_state.transcript_active)
            self.codex.on_transcript_event(manager, ms, page)

        self.assertTrue(ms.agent_state.transcript_active)


class ReadingThroughThePagesTest(PagedThreadHarness):
    def test_the_history_runs_on_from_where_the_page_goes_on_from(self) -> None:
        page = self.write_page(said("user", "after the page started", "2026-10-12T20:40:00.000Z"),
                               said("assistant", "answered on the page", "2026-10-12T20:40:01.000Z"))

        self.assertEqual(self.codex.transcript_segments(page), [(self.first, self.branch_at), (page, None)])

    def test_what_was_set_aside_is_not_shown(self) -> None:
        self.write_page(said("user", "after the page started", "2026-10-12T20:40:00.000Z"),
                        said("assistant", "answered on the page", "2026-10-12T20:40:01.000Z"))

        page = TranscriptService().history_page("codex", "/tmp", THREAD, None, 40)

        self.assertEqual(self.texts(page), ["first question", "first answer", "after the page started",
                                            "answered on the page"])

    def test_paging_back_crosses_into_the_page_before(self) -> None:
        # The newest records alone fill the first page; the one before it comes from the earlier file.
        later = [said("user" if n % 2 == 0 else "assistant", f"later {n}", f"2026-10-12T20:{40 + n // 60:02d}:{n % 60:02d}.000Z")
                 for n in range(60)]
        self.write_page(*later)
        service = TranscriptService()

        newest = service.history_page("codex", "/tmp", THREAD, None, 20)
        cursor = newest["before"]
        older: list[str] = []
        while cursor is not None:
            back = service.history_page("codex", "/tmp", THREAD, cursor, 20)
            older = self.texts(back) + older
            cursor = back["before"]

        self.assertEqual(older[:2], ["first question", "first answer"])
        self.assertNotIn("set-aside question", older + self.texts(newest))

    def test_the_live_transcript_follows_what_is_written_to_the_page(self) -> None:
        page = self.write_page(said("user", "after the page started", "2026-10-12T20:40:00.000Z"))
        service = TranscriptService()
        service.prime_subscription("codex", page)

        with page.open("a") as handle:
            handle.write(said("assistant", "written just now", "2026-10-12T20:41:00.000Z"))
        turns = service.transcript_for("codex", "/tmp", THREAD)

        self.assertEqual([turn.get("text") for turn in turns if turn.get("role") == "assistant"][-1], "written just now")

    def test_a_fork_is_not_read_back_into_its_parent(self) -> None:
        # A fork names its parent's file the same way; that history is the parent's.
        parent_page = self.day_one / f"rollout-2026-10-11T09-49-01-{PARENT}_{PARENT_PAGE}.jsonl"
        parent_page.write_text(meta(PARENT) + said("user", "the parent's question", "2026-10-11T09:50:00.000Z"))
        self.first.write_text(meta(THREAD, (PARENT_PAGE, parent_page.stat().st_size)) +
                              said("user", "first question", "2026-10-11T18:00:00.000Z"))

        self.assertEqual(self.codex.transcript_segments(self.first), [(self.first, None)])

    def test_a_thread_in_one_file_is_read_as_before(self) -> None:
        self.assertEqual(self.codex.transcript_segments(self.first), [(self.first, None)])


class OpenTranscriptFollowsTest(unittest.IsolatedAsyncioTestCase):
    """An open transcript moves to the new page by itself; it was subscribed to the old one for good."""

    async def test_it_sends_the_new_page(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.has_session.return_value = True
        server.manager.session_history_source.return_value = ("codex", "/tmp", THREAD)
        old, new = Path("/sessions/old.jsonl"), Path("/sessions/new.jsonl")
        sources = iter([new])
        server.transcripts = MagicMock()
        server.transcripts.subscribe.side_effect = [(old, [], 1, asyncio.Queue()), (new, [], 1, asyncio.Queue())]
        server.transcripts.source_path.side_effect = lambda *a: next(sources, new)
        server.transcripts.prime_subscription.return_value = 2
        server.transcripts.history_page.side_effect = [
            {"turns": [{"role": "user", "text": "on the old page"}], "before": None, "has_more": False},
            {"turns": [{"role": "user", "text": "on the new page"}], "before": None, "has_more": False}]
        snapshots: list[list[dict]] = []

        async def snapshot(websocket, session_id, revision, turns, **_):
            snapshots.append(turns)
            if len(snapshots) == 2:
                raise WebSocketDisconnect()

        server._send_transcript_snapshot = snapshot
        websocket = MagicMock()
        websocket.accept = MagicMock(side_effect=lambda: asyncio.sleep(0))
        websocket.receive_text = MagicMock(side_effect=lambda: asyncio.sleep(0, result=json.dumps({"revision": 0})))
        websocket.send_text = MagicMock(side_effect=lambda text: asyncio.sleep(0))

        with patch.object(TermdeckConfig, "TRANSCRIPT_WS_SOURCE_CHECK_SECONDS", 0.01):
            await asyncio.wait_for(server._ws_transcript(websocket, "eeb198b3051e"), 2)

        self.assertEqual(snapshots[-1], [{"role": "user", "text": "on the new page"}])
        server.transcripts.unsubscribe.assert_any_call(old, unittest.mock.ANY)


if __name__ == "__main__":
    unittest.main()
