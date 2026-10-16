"""Appends to transcripts an agent keeps open are followed by one thread, however many directories hold them.

FSEvents reports a file when it is first written and then not again until it is closed, and Codex writes
its rollout through one handle for the whole session, so the deck also watches transcript files with
kqueue. That watch was watchdog's KqueueObserver over every directory holding a transcript: one thread
per directory, and Muse gives every session a directory of its own. At ~800 of them the threads starved
the server's event loop whenever the machine was busy -- the deck stopped answering for 40 minutes and
every watchdog restart spent another 12 minutes stuck coming up.
"""

import asyncio
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from termdeck import agents
from termdeck.agents.codex import CodexCli
from termdeck.platform_paths import PlatformPaths
from termdeck.transcript_service import TranscriptService, _TranscriptAppendWatch

THREAD = "01a13879-ddc8-7cb2-b650-0b6b7f1c2d3e"


def said(role: str, text: str, stamp: str) -> str:
    kind = "input_text" if role == "user" else "output_text"
    return json.dumps({"timestamp": stamp, "type": "response_item",
                       "payload": {"type": "message", "role": role, "content": [{"type": kind, "text": text}]}}) + "\n"


@unittest.skipUnless(PlatformPaths.IS_MACOS, "the kqueue append watch is macOS only")
class TranscriptAppendWatchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        self.changes: list[Path] = []
        self.changed = threading.Condition()

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def on_change(self, path: Path) -> None:
        with self.changed:
            self.changes.append(path)
            self.changed.notify_all()

    def wait_for_changes(self, path: Path, count: int) -> int:
        deadline = time.monotonic() + 5
        with self.changed:
            while self.changes.count(path) < count and time.monotonic() < deadline:
                self.changed.wait(0.05)
            return self.changes.count(path)

    def transcript(self, name: str, age_days: float = 0) -> Path:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"type": "session_meta"}\n')
        if age_days:
            stamp = time.time() - age_days * 86400
            os.utime(path, (stamp, stamp))
        return path

    def started(self) -> _TranscriptAppendWatch:
        watch = _TranscriptAppendWatch([self.root], self.on_change)
        watch.start()
        self.addCleanup(lambda: (watch.stop(), watch.join(timeout=3)))
        self.assertTrue(watch._scanned.wait(5))
        return watch

    def test_one_thread_for_many_session_directories(self) -> None:
        for index in range(60):
            self.transcript(f"2026/10/14/session-{index}/session.jsonl")
        before = threading.active_count()
        watch = self.started()
        self.assertEqual(threading.active_count() - before, 1)
        self.assertEqual(watch.watched_count(), 60)

    def test_each_append_through_one_open_handle_is_reported(self) -> None:
        path = self.transcript("2026/10/14/rollout-a.jsonl")
        self.started()
        with path.open("a") as handle:
            for index in range(3):
                handle.write(f'{{"n": {index}}}\n')
                handle.flush()
                self.assertGreaterEqual(self.wait_for_changes(path, index + 1), index + 1)

    def test_a_transcript_outside_the_startup_window_is_watched_once_asked_for(self) -> None:
        old = self.transcript("2026/09/01/rollout-old.jsonl", age_days=30)
        watch = self.started()
        self.assertEqual(watch.watched_count(), 0)
        watch.watch(old)
        with old.open("a") as handle:
            handle.write('{"n": 1}\n')
        self.assertEqual(self.wait_for_changes(old, 1), 1)

    def test_only_transcripts_under_its_roots_are_watched(self) -> None:
        watch = self.started()
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside, True)
        (outside / "elsewhere.jsonl").write_text("{}\n")
        notes = self.transcript("2026/10/14/notes.txt")
        watch.watch(outside / "elsewhere.jsonl")
        watch.watch(notes)
        self.assertEqual(watch.watched_count(), 0)

    def test_a_deleted_transcript_is_dropped(self) -> None:
        path = self.transcript("2026/10/14/rollout-gone.jsonl")
        watch = self.started()
        self.assertEqual(watch.watched_count(), 1)
        path.unlink()
        self.assertEqual(self.wait_for_changes(path, 1), 1)
        deadline = time.monotonic() + 5
        while watch.watched_count() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(watch.watched_count(), 0)

    def test_stop_closes_every_descriptor(self) -> None:
        self.transcript("2026/10/14/rollout-b.jsonl")
        watch = self.started()
        descriptors = list(watch._path_by_fd)
        watch.stop()
        watch.join(timeout=3)
        self.assertFalse(watch._thread.is_alive())
        for descriptor in descriptors:
            with self.assertRaises(OSError):
                os.fstat(descriptor)


class LiveCodexTranscriptTest(unittest.TestCase):
    def test_every_append_through_a_kept_open_rollout_reaches_the_open_transcript(self) -> None:
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, directory, True)
        day = directory / "sessions" / "2026" / "10" / "14"
        day.mkdir(parents=True)
        rollout = day / f"rollout-2026-10-14T01-00-00-{THREAD}.jsonl"
        rollout.write_text(json.dumps({"type": "session_meta", "payload": {"id": THREAD}}) + "\n" +
                           said("user", "a question", "2026-10-14T05:00:00.000Z"))
        # Only this scratch tree is watched, not the agents' real stores.
        for agent in agents.AGENT_CLIS.values():
            if agent.sessions_root is not None:
                root = directory / "sessions" if agent.kind == "codex" else None
                patcher = patch.object(type(agent), "sessions_root", root)
                patcher.start()
                self.addCleanup(patcher.stop)
        for target, value in (("ROLLOUT_PAGE_CHECK_SECONDS", 0.0),
                              ("_recent_day_dirs", staticmethod(lambda: [day]))):
            patcher = patch.object(CodexCli, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

        async def scenario() -> list[str]:
            service = TranscriptService()
            service.start(asyncio.get_running_loop())
            seen: list[str] = []
            try:
                path, _, _, queue = service.subscribe("codex", "/tmp", THREAD)
                await asyncio.to_thread(service.prime_subscription, "codex", path)
                if service._append_watch is not None:
                    await asyncio.to_thread(service._append_watch._scanned.wait, 5)
                # Codex keeps one handle open for the whole session.
                with rollout.open("a") as handle:
                    for index in range(3):
                        reply = f"reply {index}"
                        handle.write(said("assistant", reply, f"2026-10-14T05:00:0{index + 1}.000Z"))
                        handle.flush()
                        deadline = time.monotonic() + 5
                        while reply not in seen and time.monotonic() < deadline:
                            try:
                                update = await asyncio.wait_for(queue.get(), deadline - time.monotonic())
                            except TimeoutError:
                                break
                            seen.extend(str(turn.get("text")) for turn in update["turns"])
            finally:
                service.stop()
            return seen

        seen = asyncio.run(scenario())
        self.assertIn("reply 0", seen)
        self.assertIn("reply 1", seen)
        self.assertIn("reply 2", seen)


if __name__ == "__main__":
    unittest.main()
