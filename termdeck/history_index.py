import json
import hashlib
import queue
import re
import shutil
import sqlite3
import threading
import time
from pathlib import Path

from termdeck import agents
from termdeck.agents.base import AgentCli
from termdeck.config import TermdeckConfig


class HistorySearchIndex:
    _CODEX_UUID_RE = re.compile(r"-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$")
    _MAX_RESULTS = 300
    _MAX_CONTEXT_LINES = 15
    _INDEX_VERSION = 7
    _CHUNK_LINES = 32
    # Sources evicted between size checks. Small enough that a run stops close to the keep threshold
    # rather than far below it, large enough not to re-measure after every single transcript.
    _EVICTION_BATCH = 25
    # Files scanned between size checks during the startup scan.
    _SCAN_ENFORCE_EVERY = 200

    def __init__(self, database_path: Path, settings_reader=None) -> None:
        self._database_path = database_path
        self._settings_reader = settings_reader
        self._pending_paths: queue.Queue[Path | None] = queue.Queue()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._ready = False
        self._full_pass_done = False
        self._degraded_reason = ""

    @property
    def degraded(self) -> str:
        """Why the index is not keeping up, or "" when it is.

        Search results are incomplete while this is set, and saying nothing leaves someone reading a
        half-indexed corpus with no hint that it is half-indexed.
        """
        return self._degraded_reason

    def size_limits(self) -> tuple[int, int]:
        """The cap and the level an eviction run stops at, in bytes.

        The cap is settable per machine (history_index_max_mb) because how much of the disk a search
        index deserves is a local judgement: a laptop and a workstation with a 24GB transcript corpus
        want different answers. Unset or 0 means the built-in default; a negative value means no
        ceiling at all, and is the only way to turn retention off.
        """
        limit = TermdeckConfig.HISTORY_INDEX_MAX_BYTES
        if self._settings_reader is not None:
            try:
                configured = int((self._settings_reader() or {}).get("history_index_max_mb", 0))
            except (TypeError, ValueError, AttributeError, OSError):
                configured = 0
            if configured:
                limit = configured * 1_000_000
        if limit <= 0:
            return 0, 0
        keep = max(limit - TermdeckConfig.HISTORY_INDEX_KEEP_MARGIN_BYTES, limit // 2)
        return limit, keep

    @property
    def indexing(self) -> bool:
        return not self._ready

    def start(self) -> None:
        if self._thread is not None:
            return
        self._initialize_database()
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name="termdeck-history-index", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        thread, self._thread = self._thread, None
        if thread is None:
            return
        self._stop_event.set()
        self._pending_paths.put(None)
        thread.join(timeout=2)

    def notify_file_changed(self, path: Path) -> None:
        if path.suffix == ".jsonl":
            self._pending_paths.put(path)

    def search(self, query: str, include_operations: bool = False) -> list[dict[str, object]]:
        expression = self._fts_expression(query)
        if not expression:
            return []
        grouped: dict[str, dict[str, object]] = {}
        fts_table = "history_fts" if include_operations else "history_fts_conversation"
        try:
            with self._connect(0.5) as database:
                rows = database.execute(
                    "SELECT d.source_path, d.agent_kind, d.agent_session_id, d.cwd, d.title, d.line_no, d.line_end, "
                    "d.byte_start, d.byte_end, s.mtime_ns "
                    f"FROM {fts_table} f JOIN history_documents d ON d.rowid = f.rowid "
                    "JOIN history_sources s ON s.source_path = d.source_path "
                    f"WHERE {fts_table} MATCH ? LIMIT ?",
                    (expression, self._MAX_RESULTS),
                ).fetchall()
        except sqlite3.OperationalError as search_error:
            if "locked" in str(search_error).lower():
                return []
            raise
        parent_metadata: dict[str, tuple[str, str]] = {}
        parent_paths = {
            str(self._parent_source_path(Path(row[0])))
            for row in rows
            if self._parent_source_path(Path(row[0])) is not None
        }
        if parent_paths:
            placeholders = ",".join("?" for _ in parent_paths)
            try:
                with self._connect(0.5) as database:
                    parent_metadata = {
                        source_path: (str(title), str(cwd))
                        for source_path, title, cwd in database.execute(
                            f"SELECT source_path, title, cwd FROM history_sources WHERE source_path IN ({placeholders})",
                            tuple(parent_paths),
                        ).fetchall()
                    }
            except sqlite3.OperationalError as search_error:
                if "locked" not in str(search_error).lower():
                    raise
        chunk_cache: dict[tuple[str, int, int], list[dict[str, object]]] = {}
        for source_path, agent_kind, session_id, cwd, title, line_no, _line_end, byte_start, byte_end, mtime_ns in rows:
            source = Path(source_path)
            cache_key = (source_path, int(byte_start), int(byte_end))
            if cache_key not in chunk_cache:
                chunk_cache[cache_key] = self._matching_document_lines(
                    source, int(byte_start), int(byte_end), int(line_no), query, include_operations)
            if not chunk_cache[cache_key]:
                continue
            parent_session_id = self._parent_session_id_for_source(source)
            parent_source = self._parent_source_path(source)
            parent_title, parent_cwd = parent_metadata.get(str(parent_source), (None, None)) if parent_source else (None, None)
            result = grouped.setdefault(source_path, {"source_path": source_path, "agent_kind": agent_kind,
                "agent_session_id": session_id, "cwd": cwd, "title": title, "count": 0, "matches": [],
                "is_subagent": parent_session_id is not None,
                "parent_agent_session_id": parent_session_id, "parent_title": parent_title,
                "parent_cwd": parent_cwd, "mtime_ns": int(mtime_ns)})
            result["count"] = int(result["count"]) + 1
            result_matches = result["matches"]
            if isinstance(result_matches, list) and len(result_matches) < 6:
                for match in chunk_cache[cache_key]:
                    if len(result_matches) >= 6:
                        break
                    if any(existing.get("line_no") == match.get("line_no") for existing in result_matches):
                        continue
                    result_matches.append(match)
        return sorted(grouped.values(), key=lambda item: (-int(item["mtime_ns"]), -int(item["count"]), str(item["title"])))

    @staticmethod
    def _parent_session_id_for_source(path: Path) -> str | None:
        """Return the parent Claude session for a sidechain transcript, if this is one."""
        try:
            subagents_index = path.parts.index("subagents")
        except ValueError:
            return None
        if subagents_index == 0:
            return None
        return path.parts[subagents_index - 1] or None

    @classmethod
    def _parent_source_path(cls, path: Path) -> Path | None:
        parent_session_id = cls._parent_session_id_for_source(path)
        if not parent_session_id:
            return None
        return path.parents[2] / f"{parent_session_id}.jsonl"

    @classmethod
    def _matching_document_lines(cls, path: Path, byte_start: int, byte_end: int,
                                 line_start: int, query: str, include_operations: bool) -> list[dict[str, object]]:
        terms = [term.casefold() for term in query.split()]
        if not terms:
            return []
        try:
            with path.open("rb") as source:
                source.seek(byte_start)
                raw_lines = source.read(max(0, byte_end - byte_start)).splitlines()
        except OSError:
            return []
        decoded: list[tuple[int, str, str | int | float | None]] = []
        for offset, raw in enumerate(raw_lines):
            raw_line = raw.decode(errors="replace")
            text = cls._line_text(path, raw_line, conversation_only=not include_operations)
            text = re.sub(r"\s+", " ", text).strip()
            if text:
                decoded.append((line_start + offset, text, cls._line_timestamp(raw_line)))
        matching = [(line_no, text, timestamp) for line_no, text, timestamp in decoded
                    if all(term in text.casefold() for term in terms)]
        return [{"line_no": line_no, "line_end": line_no, "text": cls._matching_text_excerpt(text, terms),
                 "timestamp": timestamp}
                for line_no, text, timestamp in matching[:6]]

    @staticmethod
    def _matching_text_excerpt(text: str, terms: list[str], max_chars: int = 280) -> str:
        folded = text.casefold()
        positions = [position for term in terms if (position := folded.find(term)) >= 0]
        if not positions or len(text) <= max_chars:
            return text
        match_start = min(positions)
        start = max(0, match_start - max_chars // 3)
        end = min(len(text), start + max_chars)
        start = max(0, end - max_chars)
        excerpt = text[start:end].strip()
        return f"{'…' if start else ''}{excerpt}{'…' if end < len(text) else ''}"

    @staticmethod
    def _line_timestamp(raw_line: str) -> str | int | float | None:
        try:
            payload = json.loads(raw_line)
        except json.JSONDecodeError:
            return None
        if not isinstance(payload, dict):
            return None
        timestamp = payload.get("timestamp")
        return timestamp if isinstance(timestamp, (str, int, float)) else None

    def context(self, source_path: str, line_no: int, radius: int = 4, query: str = "",
                include_operations: bool = False) -> dict[str, object]:
        path = Path(source_path).resolve()
        self._validate_source_path(path)
        radius = max(1, min(radius, self._MAX_CONTEXT_LINES // 2))
        with self._connect() as database:
            metadata = database.execute(
                "SELECT agent_kind, agent_session_id, cwd, title FROM history_sources WHERE source_path = ?",
                (str(path),),
            ).fetchone()
            chunk = database.execute(
                "SELECT line_no, line_end, byte_start, byte_end FROM history_documents "
                "WHERE source_path = ? AND scope = ? AND line_no <= ? AND line_end >= ? LIMIT 1",
                (str(path), "all" if include_operations else "conversation", int(line_no), int(line_no)),
            ).fetchone()
        if metadata is None:
            raise FileNotFoundError(source_path)
        if chunk is None:
            raise FileNotFoundError(f"history line {line_no} is no longer indexed")
        with path.open("rb") as source:
            source.seek(int(chunk[2]))
            raw_lines = source.read(int(chunk[3]) - int(chunk[2])).splitlines()
        decoded_lines = [(int(chunk[0]) + index,
                          self._line_text(path, raw.decode(errors="replace"), conversation_only=not include_operations),
                          self._line_timestamp(raw.decode(errors="replace")))
                         for index, raw in enumerate(raw_lines)]
        terms = [term.lower() for term in query.split()]
        target_index = next((index for index, (line, text, _) in enumerate(decoded_lines)
                             if line == int(line_no) and text), -1)
        if target_index < 0:
            target_index = next((index for index, (_, text, _) in enumerate(decoded_lines)
                                 if text and terms and all(term in text.lower() for term in terms)), 0)
        start_index = max(0, target_index - radius)
        end_index = min(len(decoded_lines), target_index + radius + 1)
        records = [{"line_no": line, "text": text, "timestamp": timestamp}
                   for line, text, timestamp in decoded_lines[start_index:end_index] if text]
        target_line = decoded_lines[target_index][0] if decoded_lines else int(line_no)
        return {"source_path": str(path), "agent_kind": metadata[0], "agent_session_id": metadata[1],
                "cwd": metadata[2], "title": metadata[3], "line_no": target_line, "lines": records}

    def _run(self) -> None:
        # All of this is on the index thread rather than in start(): converting an existing database to
        # incremental auto-vacuum costs one full VACUUM, and an index over its cap has an eviction to do.
        # Neither is something to make the server wait on before it binds its port.
        self._enable_incremental_vacuum()
        self._full_pass_done = self._attempt_full_pass()
        self._ready = True
        retry_after = time.monotonic() + TermdeckConfig.HISTORY_INDEX_RETRY_SECONDS
        while not self._stop_event.is_set():
            batch = self._drain_batch()
            if batch is None:
                return
            if batch:
                try:
                    # The watermark applies here too, not only to the full pass. A notification queued
                    # for a transcript eviction has just removed would otherwise index it straight back
                    # in -- the same churn the watermark exists to stop, arriving by the other door.
                    watermark = self.eviction_watermark()
                    for path in batch:
                        if self._stop_event.is_set():
                            return
                        self._sync_path(path, watermark)
                    self._enforce_size_limit()
                except (sqlite3.Error, OSError) as index_error:
                    # A failure here used to end the thread, so the first transcript to change after a
                    # full disk stopped all indexing AND all retention for the life of the process --
                    # with the deck still reporting itself ready. Retention is the thing that would have
                    # relieved the disk pressure, so it is exactly what must not be lost.
                    #
                    # Clearing _full_pass_done is what arms the retry. A deck whose startup pass had
                    # succeeded would otherwise never satisfy the retry condition below: it would record
                    # itself degraded, skip the transcript, and sit there degraded for the life of the
                    # process with retention never running again. The failure means the index is no
                    # longer known to be complete or under its cap, whatever was true at startup.
                    self._full_pass_done = False
                    self._record_degraded(index_error)
                    retry_after = min(retry_after,
                                      time.monotonic() + TermdeckConfig.HISTORY_INDEX_RETRY_SECONDS)
            # Retried on a clock rather than on the next file change: an idle deck would otherwise never
            # recover, and would never run retention again either.
            if not self._full_pass_done and time.monotonic() >= retry_after:
                self._full_pass_done = self._attempt_full_pass()
                retry_after = time.monotonic() + TermdeckConfig.HISTORY_INDEX_RETRY_SECONDS

    def _attempt_full_pass(self) -> bool:
        """Scan every transcript, drop the vanished ones, and bring the index back under its cap.

        Returns whether it got all the way through. A partial pass leaves the index usable but its size
        unbounded, so the caller retries rather than assuming this ran.
        """
        try:
            self._sync_all()
            self._prune_vanished_sources()
            self._enforce_size_limit()
        except (sqlite3.Error, OSError) as pass_error:
            self._record_degraded(pass_error)
            return False
        if self._degraded_reason:
            print("termdeck history index recovered", flush=True)
            self._degraded_reason = ""
        return True

    def _record_degraded(self, error: Exception) -> None:
        reason = str(error)
        if reason != self._degraded_reason:
            print(f"termdeck history index degraded: {reason} (retrying every "
                  f"{int(TermdeckConfig.HISTORY_INDEX_RETRY_SECONDS)}s)", flush=True)
        self._degraded_reason = reason

    def _drain_batch(self) -> set[Path] | None:
        """Collect the paths that changed over one debounce window.

        A streaming agent appends to its transcript continuously, and the observer reports every append.
        Indexing each one separately re-reads and rewrites the same file's tail dozens of times a minute.
        Collapsing a window into a set means one pass per file however many times it was touched. Returns
        None when the thread has been told to stop.
        """
        batch: set[Path] = set()
        deadline = time.monotonic() + TermdeckConfig.HISTORY_INDEX_DEBOUNCE_SECONDS
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return batch
            try:
                path = self._pending_paths.get(timeout=min(remaining, 0.5))
            except queue.Empty:
                if self._stop_event.is_set():
                    return None
                continue
            if path is None:
                return None
            batch.add(path)

    def _sync_all(self) -> None:
        # The scan exists for transcripts that changed while the server was down: the filesystem observer
        # only reports what happens while it is running. An unchanged file costs a stat and one indexed
        # lookup, so the scan is cheap; what it must not do is re-index what retention just evicted.
        watermark = self.eviction_watermark()
        scanned = 0
        for root in self._indexed_roots():
            if not root.is_dir():
                continue
            for path in root.rglob("*.jsonl"):
                if self._stop_event.is_set():
                    return
                self._sync_path(path, watermark)
                scanned += 1
                # Checked during the scan, not only after it, so a first index of a large corpus does
                # not run to the end before anything reclaims. The cap stays a soft one either way:
                # a batch can overshoot between checks, and the WAL is not counted.
                if scanned % self._SCAN_ENFORCE_EVERY == 0 and self._enforce_size_limit():
                    watermark = self.eviction_watermark()

    # -- retention ---------------------------------------------------------

    @staticmethod
    def _indexed_bytes(database: sqlite3.Connection) -> int:
        """Pages the index is actually using, which is what the cap is compared against.

        Pages in use, not file size: the file carries the WAL, so it is not the index's own footprint,
        and it does not shrink on delete anyway.

        Free pages are subtracted rather than counted. When the auto-vacuum conversion has been deferred
        -- a nearly-full disk, which is the case this must survive -- freed pages stay on the freelist
        and page_count alone never falls. Eviction would then delete every transcript in the index
        without the number it is watching ever moving. Subtracting the freelist makes deletion show up
        immediately, so eviction stops where it should and the disk catches up at the conversion.
        """
        page_count = int(database.execute("PRAGMA page_count").fetchone()[0])
        free_pages = int(database.execute("PRAGMA freelist_count").fetchone()[0])
        page_size = int(database.execute("PRAGMA page_size").fetchone()[0])
        return max(0, page_count - free_pages) * page_size

    @staticmethod
    def _reclaim_free_pages(database: sqlite3.Connection) -> None:
        remaining_pages = int(database.execute("PRAGMA freelist_count").fetchone()[0])
        while remaining_pages:
            database.execute("PRAGMA incremental_vacuum").fetchall()
            next_remaining_pages = int(database.execute("PRAGMA freelist_count").fetchone()[0])
            if next_remaining_pages >= remaining_pages:
                return
            remaining_pages = next_remaining_pages

    @staticmethod
    def _delete_sources(database: sqlite3.Connection, paths: list[str]) -> None:
        for path in paths:
            rows = database.execute("SELECT rowid FROM history_documents WHERE source_path = ?", (path,)).fetchall()
            database.executemany("DELETE FROM history_fts WHERE rowid = ?", rows)
            database.executemany("DELETE FROM history_fts_conversation WHERE rowid = ?", rows)
            database.executemany("DELETE FROM history_documents WHERE rowid = ?", rows)
            database.execute("DELETE FROM history_sources WHERE source_path = ?", (path,))

    def _meta(self, database: sqlite3.Connection, key: str) -> int:
        row = database.execute("SELECT value FROM history_meta WHERE key = ?", (key,)).fetchone()
        return int(row[0]) if row is not None else 0

    @staticmethod
    def _set_meta(database: sqlite3.Connection, key: str, value: int) -> None:
        database.execute("INSERT INTO history_meta(key, value) VALUES(?, ?) "
                         "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, str(value)))

    def eviction_watermark(self) -> int:
        """The mtime a transcript has to beat to be indexed.

        Without this, retention and the startup scan undo each other: eviction removes the oldest
        transcripts, the files themselves stay on disk (they are the agents' data, not ours), and the
        next scan indexes them straight back in -- over the cap again, evicting again, on every restart
        forever. The watermark records where the last eviction cut, so those files are passed over
        until something appends to them, which is exactly when they are worth indexing again.

        It is a retention boundary, not a per-file tombstone: any transcript older than the cut is
        passed over, including one that has never been indexed. That is the policy -- the index holds
        recent history. Raising the cap lets new history accumulate; it does not reach back and index
        what was already dropped, which would need a rebuild.
        """
        with self._connect() as database:
            return self._meta(database, "eviction_watermark_ns")

    def _prune_vanished_sources(self) -> int:
        """Drop transcripts that are no longer on disk.

        Nothing else removes them: a source's rows are only ever deleted to be rewritten by its own
        re-index, so a transcript the user deleted keeps its rows and its search hits forever.
        """
        with self._connect() as database:
            paths = [row[0] for row in database.execute("SELECT source_path FROM history_sources").fetchall()]
            missing = [path for path in paths if not Path(path).exists()]
            if not missing:
                return 0
            self._delete_sources(database, missing)
            database.commit()
            self._reclaim_free_pages(database)
        return len(missing)

    def _enforce_size_limit(self) -> int:
        """Evict the oldest transcripts until the index is back under the keep threshold.

        Oldest by the transcript's own mtime, so a long-idle session is given up before a live one. The
        eviction is the expensive half (measured ~125s to clear a third of a 3.5GB index) and the vacuum
        the cheap one, which is why this runs on the index thread and only after the cap is passed.
        """
        limit, keep = self.size_limits()
        if limit <= 0:
            return 0
        with self._connect() as database:
            if self._indexed_bytes(database) <= limit:
                return 0
            candidates = database.execute(
                "SELECT source_path, mtime_ns FROM history_sources ORDER BY mtime_ns ASC").fetchall()
            evicted = 0
            watermark = 0
            for batch_start in range(0, len(candidates), self._EVICTION_BATCH):
                window = candidates[batch_start:batch_start + self._EVICTION_BATCH]
                self._delete_sources(database, [row[0] for row in window])
                database.commit()
                evicted += len(window)
                watermark = max(watermark, max(int(row[1]) for row in window))
                # Freed pages only count toward the size once the vacuum hands them back.
                self._reclaim_free_pages(database)
                if self._indexed_bytes(database) <= keep or self._stop_event.is_set():
                    break
            if evicted:
                # Where this eviction cut, so the next scan does not index it all back in.
                self._set_meta(database, "eviction_watermark_ns", watermark)
                database.commit()
        print(f"termdeck history index over {limit // 1_000_000}MB: "
              f"evicted {evicted} of the oldest transcripts", flush=True)
        return evicted

    def _sync_path(self, path: Path, watermark: int = 0) -> None:
        path = path.resolve()
        try:
            self._validate_source_path(path)
            stat = path.stat()
        except (FileNotFoundError, OSError, ValueError):
            return
        with self._connect() as database:
            known = database.execute(
                "SELECT size, mtime_ns, agent_kind, agent_session_id, cwd, title "
                "FROM history_sources WHERE source_path = ?",
                (str(path),),
            ).fetchone()
            if known is not None and int(known[0]) == stat.st_size and int(known[1]) == stat.st_mtime_ns:
                return
            # Evicted by retention and untouched since. Indexing it back in is what the watermark exists
            # to prevent; an append lifts its mtime past the mark and it is picked up again here.
            if known is None and watermark and stat.st_mtime_ns <= watermark:
                return

            # Session JSONL files are append-only. Re-reading a whole active
            # session on every filesystem event made the index compete with
            # the agent itself. Rebuild the final chunk and scan only bytes
            # appended after it. A shrink/replace falls back to a full scan.
            incremental = False
            start_byte = 0
            start_line = 1
            metadata = None
            if known is not None and stat.st_size > int(known[0]):
                tail = database.execute(
                    "SELECT line_no, MIN(byte_start) FROM history_documents "
                    "WHERE source_path = ? AND line_no = ("
                    "SELECT MAX(line_no) FROM history_documents WHERE source_path = ?) "
                    "GROUP BY line_no",
                    (str(path), str(path)),
                ).fetchone()
                if tail is not None:
                    incremental = True
                    start_line = int(tail[0])
                    start_byte = int(tail[1])
                    metadata = (str(known[2]), str(known[3]), str(known[4]), str(known[5]))

            agent_kind, session_id, cwd, title, documents = self._read_source(
                path, start_byte=start_byte, start_line=start_line, metadata=metadata,
            )
            if incremental:
                old_rows = database.execute(
                    "SELECT rowid FROM history_documents WHERE source_path = ? AND line_no >= ?",
                    (str(path), start_line),
                ).fetchall()
            else:
                old_rows = database.execute("SELECT rowid FROM history_documents WHERE source_path = ?", (str(path),)).fetchall()
            database.executemany("DELETE FROM history_fts WHERE rowid = ?", old_rows)
            database.executemany("DELETE FROM history_fts_conversation WHERE rowid = ?", old_rows)
            database.executemany("DELETE FROM history_documents WHERE rowid = ?", old_rows)
            database.execute("DELETE FROM history_sources WHERE source_path = ?", (str(path),))
            document_rows = [(self._document_id(path, line_no, scope), str(path), agent_kind, session_id, cwd, title, scope,
                              line_no, line_end, byte_start, byte_end)
                             for line_no, line_end, byte_start, byte_end, scope, _ in documents]
            database.executemany(
                "INSERT INTO history_documents(rowid, source_path, agent_kind, agent_session_id, cwd, title, scope, line_no, line_end, byte_start, byte_end) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", document_rows,
            )
            database.executemany(
                "INSERT INTO history_fts(rowid, text) VALUES (?, ?)",
                ((row[0], text) for row, (_, _, _, _, _, text) in zip(document_rows, documents, strict=True)),
            )
            database.executemany(
                "INSERT INTO history_fts_conversation(rowid, text) VALUES (?, ?)",
                ((row[0], text) for row, (_, _, _, _, scope, text) in zip(document_rows, documents, strict=True) if scope == "conversation"),
            )
            database.execute(
                "INSERT INTO history_sources(source_path, agent_kind, agent_session_id, cwd, title, size, mtime_ns) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)", (str(path), agent_kind, session_id, cwd, title, stat.st_size, stat.st_mtime_ns),
            )

    def _read_source(
        self,
        path: Path,
        *,
        start_byte: int = 0,
        start_line: int = 1,
        metadata: tuple[str, str, str, str] | None = None,
    ) -> tuple[str, str, str, str, list[tuple[int, int, int, int, str, str]]]:
        if metadata is None:
            agent_kind = self._agent_for_path(path).kind
            session_match = self._CODEX_UUID_RE.search(path.name)
            session_id = session_match.group(1) if session_match else path.stem
            cwd = ""
            title = ""
        else:
            agent_kind, session_id, cwd, title = metadata
        agent = agents.agent_cli(agent_kind)
        first_prompt = ""
        documents: list[tuple[int, int, int, int, str, str]] = []
        chunk: list[tuple[int, str]] = []
        chunk_scope = ""
        chunk_start_byte = start_byte
        chunk_end_byte = 0
        try:
            with path.open("rb") as source:
                source.seek(start_byte)
                for line_no, raw_line in enumerate(source, start_line):
                    line_start_byte = source.tell() - len(raw_line)
                    line_end_byte = source.tell()
                    try:
                        payload = json.loads(raw_line.decode(errors="replace"))
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(payload, dict):
                        continue
                    cwd = cwd or agent.cwd_from_payload(path, payload)
                    title = agent.title_from_payload(payload) or title
                    text = agent.payload_text(payload)
                    if text:
                        scope = "conversation" if agent.is_conversation_payload(payload) else "all"
                        scoped_text = agent.conversation_payload_text(payload) if scope == "conversation" else text
                        if scope == "conversation" and not scoped_text:
                            scope = "all"
                            scoped_text = text
                        if not scoped_text:
                            continue
                        if not chunk or chunk_scope != scope:
                            if chunk:
                                documents.append((chunk[0][0], chunk[-1][0], chunk_start_byte, chunk_end_byte,
                                                  chunk_scope, "\n".join(item[1] for item in chunk)))
                            chunk = []
                            chunk_scope = scope
                        if not chunk:
                            chunk_start_byte = line_start_byte
                        chunk_end_byte = line_end_byte
                        chunk.append((line_no, scoped_text))
                        if len(chunk) >= self._CHUNK_LINES:
                            documents.append((chunk[0][0], chunk[-1][0], chunk_start_byte, chunk_end_byte,
                                               chunk_scope, "\n".join(item[1] for item in chunk)))
                            chunk = []
                        if not first_prompt and agent.is_user_payload(payload) and not self._is_boilerplate(text):
                            first_prompt = text
        except OSError:
            return agent_kind, session_id, cwd, title, []
        if chunk:
            documents.append((chunk[0][0], chunk[-1][0], chunk_start_byte, chunk_end_byte,
                              chunk_scope, "\n".join(item[1] for item in chunk)))
        if not title or title.startswith(("<user_instructions>", "<INSTRUCTIONS>", "# AGENTS.md")):
            compact = re.sub(r"\s+", " ", first_prompt).strip()
            title = compact[:56].rstrip() + ("…" if len(compact) > 56 else "") if compact else f"{agent_kind} · {Path(cwd).name or 'session'}"
        return agent_kind, session_id, cwd, title, documents

    def _initialize_database(self) -> None:
        with self._connect() as database:
            version = int(database.execute("PRAGMA user_version").fetchone()[0])
            if version != self._INDEX_VERSION:
                database.execute("DROP TABLE IF EXISTS history_fts")
                database.execute("DROP TABLE IF EXISTS history_fts_conversation")
                database.execute("DROP TABLE IF EXISTS history_documents")
                database.execute("DROP TABLE IF EXISTS history_sources")
                database.execute(f"PRAGMA user_version = {self._INDEX_VERSION}")
                database.commit()
                database.execute("VACUUM")
            database.execute("CREATE TABLE IF NOT EXISTS history_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            database.execute("CREATE TABLE IF NOT EXISTS history_sources (source_path TEXT PRIMARY KEY, agent_kind TEXT NOT NULL, agent_session_id TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL)")
            database.execute("CREATE TABLE IF NOT EXISTS history_documents (rowid INTEGER PRIMARY KEY, source_path TEXT NOT NULL, agent_kind TEXT NOT NULL, agent_session_id TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, scope TEXT NOT NULL, line_no INTEGER NOT NULL, line_end INTEGER NOT NULL, byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL)")
            database.execute("CREATE INDEX IF NOT EXISTS history_documents_source ON history_documents(source_path)")
            database.execute("CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(text, content='', contentless_delete=1, detail=none, tokenize='unicode61 remove_diacritics 2')")
            database.execute("CREATE VIRTUAL TABLE IF NOT EXISTS history_fts_conversation USING fts5(text, content='', contentless_delete=1, detail=none, tokenize='unicode61 remove_diacritics 2')")

    def _connect(self, timeout: float = 30) -> sqlite3.Connection:
        self._database_path.parent.mkdir(parents=True, exist_ok=True)
        database = sqlite3.connect(self._database_path, timeout=timeout)
        database.execute("PRAGMA journal_mode=WAL")
        database.execute("PRAGMA synchronous=NORMAL")
        return database

    def _enable_incremental_vacuum(self) -> bool:
        """Put the database in INCREMENTAL auto-vacuum mode, converting it once if it is not already.

        In the default NONE mode, deleted pages go to the freelist and the file never shrinks; the only
        way to hand them back is a full VACUUM. INCREMENTAL returns them in bounded steps instead.

        Converting an existing database costs one full VACUUM, which rewrites it and therefore needs
        room for a second copy. That is a bad thing to require on a nearly-full disk -- which is the
        exact situation this whole feature exists for, so the upgrade path has to survive it. The
        conversion is skipped when the space is not there and retried on a later start; a failure is
        reported and never propagates, because dying here would take retention and the indexer with it
        and leave the deck worse off than before the upgrade. Retention still works unconverted: it
        measures pages in use rather than file size, so eviction terminates and growth stops, and the
        space comes back when the conversion eventually succeeds.
        """
        try:
            with self._connect() as database:
                if int(database.execute("PRAGMA auto_vacuum").fetchone()[0]) == 2:
                    return True
                needed = self._database_path.stat().st_size * 2 if self._database_path.exists() else 0
                free = shutil.disk_usage(self._database_path.parent).free
                if needed and free < needed:
                    print(f"termdeck history index: deferring auto-vacuum conversion, it needs "
                          f"{needed // 1_000_000}MB free and there is {free // 1_000_000}MB. Retention "
                          f"still applies; space is reclaimed once this succeeds.", flush=True)
                    return False
                database.execute("PRAGMA auto_vacuum = INCREMENTAL")
                database.commit()
                database.execute("VACUUM")
                return True
        except (sqlite3.Error, OSError) as conversion_error:
            print(f"termdeck history index: auto-vacuum conversion failed ({conversion_error}); "
                  f"retention still applies and the conversion is retried on the next start", flush=True)
            return False

    @staticmethod
    def _document_id(path: Path, line_no: int, scope: str) -> int:
        digest = hashlib.blake2b(f"{path}:{line_no}:{scope}".encode(), digest_size=8).digest()
        return max(1, int.from_bytes(digest, "big") & 0x7FFFFFFFFFFFFFFF)

    @staticmethod
    def _fts_expression(query: str) -> str:
        terms = re.findall(r"[^\W_]+", query, re.UNICODE)
        return " AND ".join(terms)

    @classmethod
    def _validate_source_path(cls, path: Path) -> None:
        roots = tuple(root.resolve() for root in cls._indexed_roots())
        if not any(path.is_relative_to(root) for root in roots):
            raise ValueError("history source is outside the agent history directories")

    @staticmethod
    def _indexed_roots() -> tuple[Path, ...]:
        return tuple(agent.sessions_root for agent in agents.AGENT_CLIS.values()
                     if agent.history_indexed and agent.sessions_root is not None)

    @staticmethod
    def _agent_for_path(path: Path) -> AgentCli:
        # Only Claude and Codex trees are indexed; anything else in the roots reads as Codex,
        # matching the sources the scanner enqueues.
        return agents.agent_for_transcript_path(path) or agents.agent_cli("codex")

    @classmethod
    def _line_text(cls, path: Path, raw_line: str, conversation_only: bool = False) -> str:
        try:
            payload = json.loads(raw_line)
        except json.JSONDecodeError:
            return raw_line.strip()
        if not isinstance(payload, dict):
            return ""
        agent = cls._agent_for_path(path)
        if conversation_only:
            return agent.conversation_payload_text(payload)
        return agent.payload_text(payload) or raw_line.strip()

    @staticmethod
    def _is_boilerplate(text: str) -> bool:
        head = text.lstrip()[:80]
        return head.startswith(("<user_instructions>", "<INSTRUCTIONS>", "# AGENTS.md", "<environment_context>"))
