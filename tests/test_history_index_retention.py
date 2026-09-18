import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from termdeck.config import TermdeckConfig
from termdeck.history_index import HistorySearchIndex


class HistoryIndexRetentionTest(unittest.TestCase):
    """The index is a full-text layer over a corpus termdeck does not own and cannot prune, so the only
    thing keeping it off the disk is its own ceiling."""

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.index = HistorySearchIndex(self.root / "history-index.sqlite3")
        self.index._initialize_database()
        # start() leaves this to the index thread so the server does not wait on a VACUUM to boot.
        self.index._enable_incremental_vacuum()
        # Scan and validate against this fixture, not the machine's real transcript trees -- those are
        # thousands of files and tens of GB, and a scan test that walks them never finishes.
        roots = patch.object(HistorySearchIndex, "_indexed_roots", staticmethod(lambda: (self.root,)))
        roots.start()
        self.addCleanup(roots.stop)

    def _add_source(self, name: str, mtime_ns: int, documents: int = 40, exists: bool = True,
                    index: HistorySearchIndex | None = None) -> Path:
        index = index if index is not None else self.index
        path = self.root / name
        if exists:
            path.write_text("{}\n")
        with index._connect() as database:
            database.execute(
                "INSERT INTO history_sources(source_path, agent_kind, agent_session_id, cwd, title, size, mtime_ns) "
                "VALUES (?, 'codex', 'sid', '/tmp', 'title', 1, ?)", (str(path), mtime_ns))
            for line_no in range(documents):
                rowid = abs(hash((name, line_no))) % (2 ** 62)
                database.execute(
                    "INSERT INTO history_documents(rowid, source_path, agent_kind, agent_session_id, cwd, title, "
                    "scope, line_no, line_end, byte_start, byte_end) "
                    "VALUES (?, ?, 'codex', 'sid', '/tmp', 'title', 'conversation', ?, ?, 0, 1)",
                    (rowid, str(path), line_no, line_no))
                database.execute("INSERT INTO history_fts(rowid, text) VALUES (?, ?)",
                                 (rowid, f"searchable text for {name} line {line_no} " + "padding " * 200))
                database.execute("INSERT INTO history_fts_conversation(rowid, text) VALUES (?, ?)",
                                 (rowid, f"searchable text for {name} line {line_no} " + "padding " * 200))
            database.commit()
        return path

    def _sources(self) -> set[str]:
        with self.index._connect() as database:
            return {row[0] for row in database.execute("SELECT source_path FROM history_sources").fetchall()}

    def _size(self) -> int:
        with self.index._connect() as database:
            return self.index._indexed_bytes(database)

    def test_incremental_vacuum_is_enabled_so_deletes_can_return_space(self) -> None:
        # In the default NONE mode the file only ever grows: freed pages sit on the freelist and the one
        # way to hand them back is a full VACUUM, which needs room for a second copy of the database.
        with self.index._connect() as database:
            self.assertEqual(int(database.execute("PRAGMA auto_vacuum").fetchone()[0]), 2)

    def test_converting_an_existing_none_mode_database_is_idempotent(self) -> None:
        self.index._enable_incremental_vacuum()
        with self.index._connect() as database:
            self.assertEqual(int(database.execute("PRAGMA auto_vacuum").fetchone()[0]), 2)

    def _legacy_index(self) -> HistorySearchIndex:
        """An index in NONE auto-vacuum mode with data in it: what every deck upgrades from."""
        legacy = HistorySearchIndex(self.root / "legacy.sqlite3")
        legacy._initialize_database()
        with legacy._connect() as database:
            database.execute(
                "INSERT INTO history_sources(source_path, agent_kind, agent_session_id, cwd, title, size, mtime_ns) "
                "VALUES ('/tmp/a.jsonl', 'codex', 'sid', '/tmp', 'title', 1, 1)")
            database.commit()
        return legacy

    def test_a_conversion_that_cannot_fit_on_disk_is_deferred_not_fatal(self) -> None:
        # The conversion is a full VACUUM, so it needs room for a second copy of the database -- on a
        # nearly-full disk, which is the exact situation this feature exists for. Failing hard here
        # would take retention and the indexer down with it and leave the deck worse off than before.
        legacy = self._legacy_index()
        with patch("termdeck.history_index.shutil.disk_usage",
                   return_value=SimpleNamespace(total=0, used=0, free=1)):
            self.assertFalse(legacy._enable_incremental_vacuum())

        with legacy._connect() as database:
            self.assertEqual(int(database.execute("PRAGMA auto_vacuum").fetchone()[0]), 0)
            self.assertEqual(database.execute("SELECT COUNT(*) FROM history_sources").fetchone()[0], 1)

    def test_a_failing_conversion_is_reported_not_raised(self) -> None:
        legacy = self._legacy_index()
        with patch.object(HistorySearchIndex, "_connect", side_effect=sqlite3.OperationalError("disk I/O error")):
            self.assertFalse(legacy._enable_incremental_vacuum())

    def test_retention_still_terminates_when_the_conversion_was_deferred(self) -> None:
        # Unconverted, freed pages stay on the freelist and page_count never falls. Measuring pages in
        # use is what stops eviction from deleting every transcript while the number it watches sits
        # still -- the index shrinks logically now and on disk at the next successful conversion.
        unconverted = HistorySearchIndex(self.root / "unconverted.sqlite3")
        unconverted._initialize_database()
        for ordinal in range(12):
            self._add_source(f"u{ordinal:02d}.jsonl", mtime_ns=(ordinal + 1) * 1_000, index=unconverted)
        with unconverted._connect() as database:
            self.assertEqual(int(database.execute("PRAGMA auto_vacuum").fetchone()[0]), 0)
            size = unconverted._indexed_bytes(database)

        with patch.object(unconverted, "size_limits", lambda: (size - 1, int(size * 0.6))), \
             patch.object(HistorySearchIndex, "_EVICTION_BATCH", 1):
            evicted = unconverted._enforce_size_limit()

        with unconverted._connect() as database:
            survivors = database.execute("SELECT COUNT(*) FROM history_sources").fetchone()[0]
        self.assertGreater(evicted, 0)
        self.assertGreater(survivors, 0, "eviction cleared the whole index because size never moved")

    def test_an_existing_database_created_without_auto_vacuum_is_converted(self) -> None:
        # The real case, and the one a fresh database does not exercise: every index built before this
        # shipped is in NONE mode with data already in it. Setting the pragma alone does nothing there
        # -- the mode only changes when a VACUUM rewrites the file.
        legacy = HistorySearchIndex(self.root / "legacy.sqlite3")
        legacy._initialize_database()
        with legacy._connect() as database:
            self.assertEqual(int(database.execute("PRAGMA auto_vacuum").fetchone()[0]), 0)
            database.execute(
                "INSERT INTO history_sources(source_path, agent_kind, agent_session_id, cwd, title, size, mtime_ns) "
                "VALUES ('/tmp/a.jsonl', 'codex', 'sid', '/tmp', 'title', 1, 1)")
            database.commit()

        legacy._enable_incremental_vacuum()

        with legacy._connect() as database:
            self.assertEqual(int(database.execute("PRAGMA auto_vacuum").fetchone()[0]), 2)
            self.assertEqual(database.execute("SELECT COUNT(*) FROM history_sources").fetchone()[0], 1,
                             "the conversion must not lose indexed rows")

    def test_sources_whose_file_is_gone_are_pruned(self) -> None:
        # Nothing else removes these: a source's rows are only deleted to be rewritten by its own
        # re-index, so a deleted transcript keeps its rows and its search hits forever.
        kept = self._add_source("alive.jsonl", 2_000)
        gone = self._add_source("deleted.jsonl", 1_000)
        gone.unlink()

        self.assertEqual(self.index._prune_vanished_sources(), 1)

        self.assertEqual(self._sources(), {str(kept)})

    def test_an_index_under_the_cap_is_left_alone(self) -> None:
        self._add_source("a.jsonl", 1_000)

        self.assertEqual(self.index._enforce_size_limit(), 0)

        self.assertEqual(len(self._sources()), 1)

    def test_passing_the_cap_evicts_oldest_first_down_to_the_keep_threshold(self) -> None:
        for ordinal in range(12):
            self._add_source(f"s{ordinal:02d}.jsonl", mtime_ns=(ordinal + 1) * 1_000)
        size = self._size()
        # A cap just under the current size, with a keep level below it, is the real shape: evict until
        # back under keep, not merely under the cap.
        with patch.object(self.index, "size_limits", lambda: (size - 1, int(size * 0.6))), \
             patch.object(HistorySearchIndex, "_EVICTION_BATCH", 1):
            evicted = self.index._enforce_size_limit()

        self.assertGreater(evicted, 0)
        survivors = self._sources()
        self.assertLess(len(survivors), 12)
        # Oldest mtime goes first, so the survivors must be a suffix of the ordering.
        oldest = str(self.root / "s00.jsonl")
        newest = str(self.root / "s11.jsonl")
        self.assertNotIn(oldest, survivors)
        self.assertIn(newest, survivors)

    def test_eviction_actually_returns_space_rather_than_only_deleting_rows(self) -> None:
        # The failure this guards: rows go, page_count does not, and the index never gets smaller.
        for ordinal in range(12):
            self._add_source(f"s{ordinal:02d}.jsonl", mtime_ns=(ordinal + 1) * 1_000)
        before = self._size()
        with patch.object(self.index, "size_limits", lambda: (before - 1, int(before * 0.5))), \
             patch.object(HistorySearchIndex, "_EVICTION_BATCH", 1):
            self.index._enforce_size_limit()

        self.assertLess(self._size(), before)

    def test_reclaim_returns_every_free_page_not_just_the_first(self) -> None:
        # PRAGMA incremental_vacuum frees one page per step of the statement, and sqlite3 only steps a
        # statement as its rows are consumed. Without draining the cursor this returns a single page and
        # leaves the rest on the freelist, so an index over its cap would crawl back under one page at a
        # time and effectively never recover.
        for ordinal in range(12):
            self._add_source(f"s{ordinal:02d}.jsonl", mtime_ns=(ordinal + 1) * 1_000)
        with self.index._connect() as database:
            paths = [row[0] for row in database.execute("SELECT source_path FROM history_sources").fetchall()]
            self.index._delete_sources(database, paths[:8])
            database.commit()
            freed = int(database.execute("PRAGMA freelist_count").fetchone()[0])
            self.assertGreater(freed, 1, "fixture did not free enough pages to tell the two apart")

            self.index._reclaim_free_pages(database)

            self.assertEqual(int(database.execute("PRAGMA freelist_count").fetchone()[0]), 0)

    def test_the_cap_defaults_to_config_and_keeps_a_margin_under_it(self) -> None:
        limit, keep = self.index.size_limits()

        self.assertEqual(limit, TermdeckConfig.HISTORY_INDEX_MAX_BYTES)
        self.assertEqual(keep, limit - TermdeckConfig.HISTORY_INDEX_KEEP_MARGIN_BYTES)

    def test_a_setting_overrides_the_cap(self) -> None:
        self.index._settings_reader = lambda: {"history_index_max_mb": 1_500}

        self.assertEqual(self.index.size_limits()[0], 1_500_000_000)

    def test_an_unset_or_unreadable_setting_falls_back_to_the_default(self) -> None:
        for reader in (lambda: {}, lambda: {"history_index_max_mb": 0},
                       lambda: {"history_index_max_mb": "nonsense"},
                       lambda: (_ for _ in ()).throw(OSError("settings file gone"))):
            with self.subTest(reader=reader):
                self.index._settings_reader = reader
                self.assertEqual(self.index.size_limits()[0], TermdeckConfig.HISTORY_INDEX_MAX_BYTES)

    def test_a_small_cap_still_leaves_a_sane_keep_level(self) -> None:
        # The margin is a flat 500MB, so a cap smaller than that must not produce a negative keep level
        # -- which would evict every transcript in the index on the first run.
        self.index._settings_reader = lambda: {"history_index_max_mb": 100}
        limit, keep = self.index.size_limits()

        self.assertGreater(keep, 0)
        self.assertLessEqual(keep, limit)

    def test_a_negative_setting_turns_the_ceiling_off(self) -> None:
        # Through the real setting, not by mocking size_limits: mocking the thing under test was how a
        # contradiction between this contract and the code went unnoticed -- 0 and -1 both quietly meant
        # "use the default", so there was no way to switch retention off at all.
        self._add_source("a.jsonl", 1_000)
        self.index._settings_reader = lambda: {"history_index_max_mb": -1}

        self.assertEqual(self.index.size_limits(), (0, 0))
        self.assertEqual(self.index._enforce_size_limit(), 0)
        self.assertEqual(len(self._sources()), 1)

    def test_eviction_records_where_it_cut(self) -> None:
        for ordinal in range(12):
            self._add_source(f"s{ordinal:02d}.jsonl", mtime_ns=(ordinal + 1) * 1_000)
        size = self._size()
        limits = (size - 1, int(size * 0.6))
        with patch.object(self.index, "size_limits", lambda: limits), \
             patch.object(HistorySearchIndex, "_EVICTION_BATCH", 1):
            self.index._enforce_size_limit()

            self.assertGreater(self.index.eviction_watermark(), 0)

    def _mark_evicted_at(self, mtime_ns: int) -> None:
        with self.index._connect() as database:
            self.index._set_meta(database, "eviction_watermark_ns", mtime_ns)
            database.commit()

    def test_an_evicted_transcript_is_not_indexed_straight_back_in(self) -> None:
        # The churn this prevents: eviction removes the oldest transcripts, their files stay on disk
        # because they are the agents' data and not ours, and the next startup scan re-indexes them --
        # over the cap again, evicting again, on every restart for good.
        evicted = self.root / "old.jsonl"
        evicted.write_text('{"type":"user","message":{"content":"hello"}}\n')
        self._mark_evicted_at(evicted.stat().st_mtime_ns)

        self.index._sync_all()

        self.assertEqual(self._sources(), set())

    def test_appending_to_an_evicted_transcript_brings_it_back(self) -> None:
        # The watermark must not be a permanent blacklist: a session resumed months later is worth
        # indexing again, and its mtime rising past the mark is exactly that signal.
        path = self.root / "resumed.jsonl"
        path.write_text('{"type":"user","message":{"content":"hello"}}\n')
        self._mark_evicted_at(path.stat().st_mtime_ns - 1)

        self.index._sync_all()

        self.assertIn(str(path.resolve()), self._sources())

    def test_the_watermark_survives_a_cap_change(self) -> None:
        # It is a retention boundary, not a per-cap one. Raising the ceiling lets new history accumulate;
        # reaching back for history already dropped would need a rebuild, which is not on offer here.
        self._mark_evicted_at(9_999)
        self.index._settings_reader = lambda: {"history_index_max_mb": 4_000}

        self.assertEqual(self.index.eviction_watermark(), 9_999)


class HistoryIndexWorkerResilienceTest(unittest.TestCase):
    """The indexer is a single long-lived thread. Anything that escapes its loop stops indexing AND
    retention for the life of the process, while the deck goes on reporting itself ready -- and
    retention is the thing that would have relieved the disk pressure that caused the failure."""

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.index = HistorySearchIndex(self.root / "history-index.sqlite3")
        self.index._initialize_database()
        roots = patch.object(HistorySearchIndex, "_indexed_roots", staticmethod(lambda: (self.root,)))
        roots.start()
        self.addCleanup(roots.stop)

    def _run_worker_until_idle(self, ticks: int = 6) -> None:
        """Drive _run through a bounded number of debounce windows, then stop it."""
        windows = {"left": ticks}
        real_drain = HistorySearchIndex._drain_batch

        def drain(index_self):
            if windows["left"] <= 0:
                return None
            windows["left"] -= 1
            return real_drain(index_self)

        with patch.object(TermdeckConfig, "HISTORY_INDEX_DEBOUNCE_SECONDS", 0.01), \
             patch.object(HistorySearchIndex, "_drain_batch", drain):
            self.index._run()

    def test_the_worker_survives_a_failing_startup_and_a_failing_event_then_recovers(self) -> None:
        # The exact sequence: storage fails during the startup pass, fails again on the first changed
        # transcript, then becomes writable. Indexing and retention must both resume without waiting
        # for another file change, and without a server restart.
        transcript = self.root / "a.jsonl"
        transcript.write_text('{"type":"user","message":{"content":"hello"}}\n')
        failures = {"left": 2}
        # Captured before patching: resolving these inside the patched functions would find the patches
        # themselves and recurse.
        real_sync_all = HistorySearchIndex._sync_all
        real_sync_path = HistorySearchIndex._sync_path

        def failing_sync_all(index_self):
            if failures["left"] > 0:
                failures["left"] -= 1
                raise sqlite3.OperationalError("database or disk is full")
            return real_sync_all(index_self)

        def failing_sync_path(index_self, path, watermark=0):
            if failures["left"] > 0:
                failures["left"] -= 1
                raise sqlite3.OperationalError("database or disk is full")
            return real_sync_path(index_self, path, watermark)

        self.index.notify_file_changed(transcript)
        with patch.object(TermdeckConfig, "HISTORY_INDEX_RETRY_SECONDS", 0), \
             patch.object(HistorySearchIndex, "_sync_all", failing_sync_all), \
             patch.object(HistorySearchIndex, "_sync_path", failing_sync_path):
            self._run_worker_until_idle()

        with self.index._connect() as database:
            indexed = database.execute("SELECT COUNT(*) FROM history_sources").fetchone()[0]
        self.assertEqual(failures["left"], 0, "the worker stopped retrying")
        self.assertEqual(indexed, 1, "indexing never resumed after storage recovered")
        self.assertEqual(self.index.degraded, "", "still reporting degraded after recovery")

    def test_a_failure_after_a_clean_startup_still_recovers(self) -> None:
        # The startup pass succeeding is what makes this case its own: the worker believes the index is
        # complete and under its cap, so nothing re-arms the retry when a later event fails. It would
        # record itself degraded and stay that way for the life of the process, with retention never
        # running again -- only now the disk pressure that caused the failure has nothing relieving it.
        transcript = self.root / "c.jsonl"
        real_sync_path = HistorySearchIndex._sync_path
        failures = {"left": 1}
        windows = {"left": 6}

        def failing_sync_path(index_self, path, watermark=0):
            if failures["left"] > 0:
                failures["left"] -= 1
                raise sqlite3.OperationalError("database or disk is full")
            return real_sync_path(index_self, path, watermark)

        def drain(index_self):
            # The transcript appears only once the startup pass is behind us, so the clean startup is
            # real and this transcript can only arrive through the event path.
            if windows["left"] <= 0:
                return None
            windows["left"] -= 1
            if not transcript.exists():
                transcript.write_text('{"type":"user","message":{"content":"hello"}}\n')
                return {transcript}
            return set()

        with patch.object(TermdeckConfig, "HISTORY_INDEX_RETRY_SECONDS", 0), \
             patch.object(HistorySearchIndex, "_sync_path", failing_sync_path), \
             patch.object(HistorySearchIndex, "_drain_batch", drain):
            self.index._run()

        self.assertTrue(self.index._full_pass_done or self.index.degraded == "")

        with self.index._connect() as database:
            indexed = database.execute("SELECT COUNT(*) FROM history_sources").fetchone()[0]
        self.assertEqual(failures["left"], 0)
        self.assertEqual(indexed, 1, "the transcript was never picked up after the failure")
        self.assertEqual(self.index.degraded, "", "still degraded after storage recovered")

    def test_a_failing_event_does_not_end_the_worker(self) -> None:
        transcript = self.root / "b.jsonl"
        transcript.write_text('{"type":"user","message":{"content":"hi"}}\n')
        self.index.notify_file_changed(transcript)
        with patch.object(HistorySearchIndex, "_sync_path",
                          lambda *a, **k: (_ for _ in ()).throw(OSError("disk I/O error"))), \
             patch.object(HistorySearchIndex, "_sync_all", lambda self: None):
            self._run_worker_until_idle(ticks=3)

        # Reaching here at all is the assertion: _run returned by running out of windows, not by raising.
        self.assertNotEqual(self.index.degraded, "")

    def test_retention_is_retried_without_another_file_change(self) -> None:
        # An idle deck must still recover. Retention is what relieves the disk pressure, so waiting for
        # a transcript to change before trying again is waiting for the wrong thing.
        attempts = []
        with patch.object(TermdeckConfig, "HISTORY_INDEX_RETRY_SECONDS", 0), \
             patch.object(HistorySearchIndex, "_sync_all",
                          lambda self: attempts.append(1) or (_ for _ in ()).throw(OSError("disk full"))):
            self._run_worker_until_idle(ticks=4)

        self.assertGreater(len(attempts), 1, "the full pass was never retried")


class HistoryIndexDebounceTest(unittest.TestCase):
    """A streaming agent's transcript is appended to continuously and the observer reports every append."""

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.index = HistorySearchIndex(Path(self.directory.name) / "history-index.sqlite3")

    def test_repeated_changes_to_one_file_collapse_into_a_single_pass(self) -> None:
        path = Path(self.directory.name) / "a.jsonl"
        for _ in range(50):
            self.index.notify_file_changed(path)

        with patch.object(TermdeckConfig, "HISTORY_INDEX_DEBOUNCE_SECONDS", 0.05):
            batch = self.index._drain_batch()

        self.assertEqual(batch, {path})

    def test_one_window_carries_every_file_that_changed_in_it(self) -> None:
        # Distinct paths, so this fails against a loop that takes one path per pass rather than batching
        # a window -- which set-deduplication of a single repeated path cannot tell apart.
        paths = {Path(self.directory.name) / f"s{ordinal}.jsonl" for ordinal in range(8)}
        for path in paths:
            self.index.notify_file_changed(path)

        with patch.object(TermdeckConfig, "HISTORY_INDEX_DEBOUNCE_SECONDS", 0.2):
            batch = self.index._drain_batch()

        self.assertEqual(batch, paths)

    def test_a_stop_request_ends_the_batch_immediately(self) -> None:
        self.index.notify_file_changed(Path(self.directory.name) / "a.jsonl")
        self.index._pending_paths.put(None)

        with patch.object(TermdeckConfig, "HISTORY_INDEX_DEBOUNCE_SECONDS", 30):
            started = time.monotonic()
            batch = self.index._drain_batch()

        self.assertIsNone(batch)
        self.assertLess(time.monotonic() - started, 5)

    def test_non_transcript_files_are_never_queued(self) -> None:
        self.index.notify_file_changed(Path(self.directory.name) / "notes.txt")

        with patch.object(TermdeckConfig, "HISTORY_INDEX_DEBOUNCE_SECONDS", 0.05):
            self.assertEqual(self.index._drain_batch(), set())


if __name__ == "__main__":
    unittest.main()
