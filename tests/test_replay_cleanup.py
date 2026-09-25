import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from termdeck.config import TermdeckConfig
from termdeck.replay_recorder import ReplayRecorder


class FakeManager:
    def __init__(self, live_ids: list[str], closed_ids: list[str] | None = None) -> None:
        self._sessions = {session_id: object() for session_id in live_ids}
        self._closed_store = SimpleNamespace(
            load_all=lambda: [{"session_id": session_id} for session_id in (closed_ids or [])])


def managed_session(session_id: str, agent_kind: str):
    return SimpleNamespace(
        record=SimpleNamespace(session_id=session_id, agent_kind=agent_kind),
        raw_replay_buffer=bytearray(b"recorded"),
        raw_replay_title_carry=b"",
        raw_replay_last_title=b"",
        raw_replay_checkpoint_pending=bytearray(),
        raw_replay_compaction_generation=0,
    )


class ReplayCleanupTest(unittest.TestCase):
    """Recordings on disk must not outlive the sessions that own them.

    The leak this covers left 1,143 of 1,227 files here with no owner: every Codex and Opencode
    recording ever made, plus every shell scrollback, because the delete-time unlink was written as if
    Claude were the only agent that records one.
    """

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.scrollback = Path(self.directory.name)
        patched = patch.object(TermdeckConfig, "SCROLLBACK_DIR", self.scrollback)
        patched.start()
        self.addCleanup(patched.stop)

    def _recorder(self, live_ids: list[str] | None = None,
                  closed_ids: list[str] | None = None) -> ReplayRecorder:
        return ReplayRecorder(FakeManager(live_ids or [], closed_ids))

    def _write_pair(self, session_id: str, legacy: bool = False) -> tuple[Path, Path]:
        suffix = TermdeckConfig.LEGACY_RAW_REPLAY_SUFFIX if legacy else TermdeckConfig.RAW_REPLAY_SUFFIX
        raw = self.scrollback / f"{session_id}{suffix}"
        shell = self.scrollback / f"{session_id}.bin"
        raw.write_bytes(b"raw recording")
        shell.write_bytes(b"shell scrollback")
        return raw, shell

    def test_closing_a_session_clears_its_buffer_and_leaves_the_file_to_the_sweep(self) -> None:
        # Disk deletion has one owner, the sweep. A close that races a kill would skip an unlink here
        # and strand the recording, and the sweep has to be able to find it regardless.
        raw, _ = self._write_pair("closing")
        session = managed_session("closing", "codex")

        asyncio.run(self._recorder().discard(session))

        self.assertEqual(bytes(session.raw_replay_buffer), b"")
        self.assertTrue(raw.exists())

    def test_the_sweep_collects_recordings_for_every_agent_kind_and_both_names(self) -> None:
        # The recording is written for any agent whose AgentCli sets records_raw_replay -- claude, codex
        # and opencode -- so a Claude-only cleanup stranded every Codex and Opencode recording.
        for kind in ("claude", "codex", "opencode", "none"):
            for legacy in (False, True):
                with self.subTest(kind=kind, legacy=legacy):
                    raw, shell = self._write_pair(f"session-{kind}-{legacy}", legacy=legacy)

                    self._recorder([])._remove_orphaned_replays()

                    self.assertFalse(raw.exists(), f"{kind} recording survived the sweep (legacy={legacy})")
                    self.assertFalse(shell.exists(), f"{kind} scrollback survived the sweep")


    def test_the_sweeper_removes_files_no_live_session_owns(self) -> None:
        live_raw, live_shell = self._write_pair("alive")
        dead_raw, dead_shell = self._write_pair("orphan")

        removed_files, removed_bytes = self._recorder(["alive"])._remove_orphaned_replays()

        self.assertEqual(removed_files, 2)
        self.assertGreater(removed_bytes, 0)
        self.assertTrue(live_raw.exists())
        self.assertTrue(live_shell.exists())
        self.assertFalse(dead_raw.exists())
        self.assertFalse(dead_shell.exists())

    def test_the_sweep_still_collects_files_beyond_the_closed_list_cap(self) -> None:
        # Closed sessions keep their files, but only while they hold a reopen entry: the closed list
        # is capped at CLOSED_HISTORY_MAX rows, and a session that scrolled off it owns nothing, so
        # anything the delete-time path missed is still collected rather than stranded for good.
        for ordinal in range(TermdeckConfig.CLOSED_HISTORY_MAX + 50):
            self._write_pair(f"gone{ordinal:04d}")

        removed_files, _ = self._recorder([])._remove_orphaned_replays()

        self.assertEqual(removed_files, (TermdeckConfig.CLOSED_HISTORY_MAX + 50) * 2)
        self.assertEqual(list(self.scrollback.iterdir()), [])

    def test_the_sweep_spares_recordings_of_reopenable_closed_sessions(self) -> None:
        # A closed terminal is still the deck's: reopening restores its recording, so the sweep
        # must not eat the file in between. Only sessions in NEITHER list are orphans — one that
        # scrolled off the capped closed list still loses its file.
        closed_raw, closed_shell = self._write_pair("closed")
        dead_raw, dead_shell = self._write_pair("orphan")

        removed_files, _ = self._recorder([], ["closed"])._remove_orphaned_replays()

        self.assertEqual(removed_files, 2)
        self.assertTrue(closed_raw.exists())
        self.assertTrue(closed_shell.exists())
        self.assertFalse(dead_raw.exists())
        self.assertFalse(dead_shell.exists())

    def test_in_flight_checkpoint_temporaries_are_left_alone(self) -> None:
        # Checkpoints are written to a hidden temporary and renamed into place. Deleting one mid-write
        # would corrupt the very recording the sweep is meant to be tidying up around.
        temporary = self.scrollback / ".alive.replay.bin.123.abc.tmp"
        temporary.write_bytes(b"half-written")

        self._recorder([])._remove_orphaned_replays()

        self.assertTrue(temporary.exists())

    def test_unrelated_files_and_directories_are_left_alone(self) -> None:
        nested = self.scrollback / "backup-preclean"
        nested.mkdir()
        (nested / "kept.replay.bin").write_bytes(b"hand-made backup")
        notes = self.scrollback / "notes.txt"
        notes.write_text("not a recording")

        self._recorder([])._remove_orphaned_replays()

        self.assertTrue(notes.exists())
        self.assertTrue((nested / "kept.replay.bin").exists())

    def test_a_missing_scrollback_directory_is_not_an_error(self) -> None:
        with patch.object(TermdeckConfig, "SCROLLBACK_DIR", self.scrollback / "does-not-exist"):
            self.assertEqual(self._recorder([])._remove_orphaned_replays(), (0, 0))

    def test_a_file_vanishing_mid_sweep_does_not_stop_the_rest(self) -> None:
        # A recording can disappear between the listing and the unlink, and that is the outcome the
        # sweep wanted anyway. One task owns this cleanup, so a raise here costs every later file too.
        self._write_pair("first")
        self._write_pair("second")
        real_unlink = Path.unlink
        calls = []

        def unlink_once_missing(self, *args, **kwargs):
            calls.append(self)
            if len(calls) == 1:
                raise FileNotFoundError(self)
            return real_unlink(self, *args, **kwargs)

        with patch.object(Path, "unlink", unlink_once_missing):
            removed_files, _ = self._recorder([])._remove_orphaned_replays()

        self.assertEqual(len(calls), 4)
        self.assertEqual(removed_files, 3)

    def test_an_unremovable_file_does_not_stop_the_rest(self) -> None:
        self._write_pair("blocked")
        self._write_pair("fine")
        real_unlink = Path.unlink

        def unlink_denied(self, *args, **kwargs):
            if "blocked" in self.name:
                raise PermissionError(self)
            return real_unlink(self, *args, **kwargs)

        with patch.object(Path, "unlink", unlink_denied):
            removed_files, _ = self._recorder([])._remove_orphaned_replays()

        self.assertEqual(removed_files, 2)
        self.assertTrue((self.scrollback / "blocked.replay.bin").exists())

    def test_legacy_named_orphans_are_swept_too(self) -> None:
        legacy_raw, legacy_shell = self._write_pair("old-build", legacy=True)

        self._recorder([])._remove_orphaned_replays()

        self.assertFalse(legacy_raw.exists())
        self.assertFalse(legacy_shell.exists())


class RawReplayNamingTest(unittest.TestCase):
    """The on-disk name dropped "claude" because the recording was never Claude's alone. Decks upgrading
    into that rename still have recordings under the old name, and must keep them."""

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        patched = patch.object(TermdeckConfig, "SCROLLBACK_DIR", Path(self.directory.name))
        patched.start()
        self.addCleanup(patched.stop)

    def test_a_new_recording_uses_the_agent_neutral_name(self) -> None:
        self.assertEqual(ReplayRecorder.raw_path("fresh").name, "fresh.replay.bin")

    def test_an_existing_legacy_recording_keeps_being_used(self) -> None:
        # Renaming files under a running deck buys nothing, and an upgrade must not look like every open
        # terminal lost its scrollback.
        legacy = Path(self.directory.name) / f"upgraded{TermdeckConfig.LEGACY_RAW_REPLAY_SUFFIX}"
        legacy.write_bytes(b"recorded before the rename")

        self.assertEqual(ReplayRecorder.raw_path("upgraded"), legacy)

    def test_the_sweep_recognises_both_names_and_nothing_else(self) -> None:
        self.assertEqual(ReplayRecorder._owning_session_id("s.replay.bin"), "s")
        self.assertEqual(ReplayRecorder._owning_session_id("s.claude-replay.bin"), "s")
        self.assertEqual(ReplayRecorder._owning_session_id("s.bin"), "s")
        # Anything the deck does not write is not the sweep's to delete: it runs unattended against a
        # directory a person can drop files into.
        # "my.backup.bin" is the one that matters: splitting on the first dot read it as session "my"
        # and deleted it. A session id cannot contain a dot, so matching the whole stem rejects it.
        for stranger in ("notes.txt", "my.backup.bin", "s.bin.bak", ".s.replay.bin.1.a.tmp",
                         "archive.tar.gz", "s.sqlite3"):
            self.assertEqual(ReplayRecorder._owning_session_id(stranger), "", stranger)


class PeriodicReplaySweepTest(unittest.IsolatedAsyncioTestCase):
    """Closing a terminal is where a recording normally goes, and startup catches what an older build
    left. The periodic sweep is for the deck that is simply never restarted."""

    async def test_the_sweep_runs_repeatedly_on_its_interval(self) -> None:
        # Bound to a stand-in rather than a real manager: constructing one starts the filesystem
        # observers over the whole home directory, which a unit test has no business doing. The counter
        # is a plain list because the sweep runs in a worker thread, where asyncio primitives are not
        # safe to touch.
        from termdeck.session_manager import TerminalSessionManager

        sweeps: list[int] = []

        async def sweep() -> tuple[int, int]:
            sweeps.append(1)
            return 0, 0

        deck = SimpleNamespace(replay=SimpleNamespace(sweep_orphaned_replays=sweep))
        with patch.object(TermdeckConfig, "REPLAY_SWEEP_INTERVAL_SECONDS", 0.01):
            task = asyncio.create_task(TerminalSessionManager._sweep_replays_periodically(deck))
            await asyncio.sleep(0.3)
            task.cancel()

        self.assertGreater(len(sweeps), 1, "the sweep must repeat, not run once")

    async def test_the_sweep_holds_the_checkpoint_lock_while_it_deletes(self) -> None:
        # The sweep and the checkpoint writer touch the same files. A sweep that unlinked a recording
        # between a writer's open and its rename would lose that write with nothing to show for it.
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        recorder = ReplayRecorder(FakeManager([]))
        held = []
        with patch.object(TermdeckConfig, "SCROLLBACK_DIR", Path(directory.name)), \
             patch.object(recorder, "_remove_orphaned_replays",
                          side_effect=lambda: (held.append(recorder._checkpoint_lock.locked()), (0, 0))[1]):
            await recorder.sweep_orphaned_replays()

        self.assertEqual(held, [True])

    async def test_a_failing_sweep_does_not_retire_the_only_cleanup_task(self) -> None:
        # This task is the only thing that deletes recordings. An exception escaping the loop retires it
        # for the life of the process, and on a deck that is never restarted that means never again.
        from termdeck.session_manager import TerminalSessionManager

        attempts: list[int] = []

        async def sweep() -> tuple[int, int]:
            attempts.append(1)
            if len(attempts) == 1:
                raise OSError("scrollback directory briefly unreadable")
            return 0, 0

        deck = SimpleNamespace(replay=SimpleNamespace(sweep_orphaned_replays=sweep))
        with patch.object(TermdeckConfig, "REPLAY_SWEEP_INTERVAL_SECONDS", 0.01):
            task = asyncio.create_task(TerminalSessionManager._sweep_replays_periodically(deck))
            await asyncio.sleep(0.3)
            running = not task.done()
            task.cancel()

        self.assertTrue(running, "the sweep loop died on one failed sweep")
        self.assertGreater(len(attempts), 1, "it never retried after the failure")

    async def test_cancellation_still_stops_the_loop(self) -> None:
        # The broad except must not swallow the shutdown signal along with the errors it is there for.
        from termdeck.session_manager import TerminalSessionManager

        async def sweep() -> tuple[int, int]:
            return 0, 0

        deck = SimpleNamespace(replay=SimpleNamespace(sweep_orphaned_replays=sweep))
        with patch.object(TermdeckConfig, "REPLAY_SWEEP_INTERVAL_SECONDS", 0.01):
            task = asyncio.create_task(TerminalSessionManager._sweep_replays_periodically(deck))
            await asyncio.sleep(0.05)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

    async def test_nothing_is_swept_before_the_first_interval_elapses(self) -> None:
        # The sweep waits rather than running as the deck boots: scanning the directory is work the
        # startup path should not be doing, which is the whole reason this owns cleanup on a timer.
        from termdeck.session_manager import TerminalSessionManager

        swept: list[int] = []

        async def sweep() -> tuple[int, int]:
            swept.append(1)
            return 0, 0

        deck = SimpleNamespace(replay=SimpleNamespace(sweep_orphaned_replays=sweep))
        with patch.object(TermdeckConfig, "REPLAY_SWEEP_INTERVAL_SECONDS", 30):
            task = asyncio.create_task(TerminalSessionManager._sweep_replays_periodically(deck))
            await asyncio.sleep(0.05)
            task.cancel()

        self.assertEqual(swept, [])


if __name__ == "__main__":
    unittest.main()
