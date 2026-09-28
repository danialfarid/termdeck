import sqlite3
import tempfile
import unittest
from pathlib import Path

from termdeck.history_index import HistorySearchIndex


class HistorySearchIndexTest(unittest.TestCase):
    def test_fts_expression_splits_underscored_file_names_into_supported_terms(self) -> None:
        self.assertEqual(HistorySearchIndex._fts_expression("task_runs_store.py"), "task AND runs AND store AND py")

    def test_underscored_search_does_not_use_unsupported_phrase_query(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "history.sqlite3"
            index = HistorySearchIndex(database_path)
            index._initialize_database()
            with sqlite3.connect(database_path) as database:
                database.execute(
                    "INSERT INTO history_documents(rowid, source_path, agent_kind, agent_session_id, cwd, title, scope, line_no, line_end, byte_start, byte_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (1, "/tmp/session.jsonl", "codex", "session", "/tmp", "session", "conversation", 1, 1, 0, 10),
                )
                database.execute(
                    "INSERT INTO history_sources(source_path, agent_kind, agent_session_id, cwd, title, size, mtime_ns) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    ("/tmp/session.jsonl", "codex", "session", "/tmp", "session", 10, 1),
                )
                database.execute(
                    "INSERT INTO history_fts_conversation(rowid, text) VALUES (?, ?)", (1, "task runs store py")
                )
                database.commit()
            expression = index._fts_expression("task_runs_store.py")
            with sqlite3.connect(database_path) as database:
                rows = database.execute(
                    "SELECT rowid FROM history_fts_conversation WHERE history_fts_conversation MATCH ?", (expression,)
                ).fetchall()
            self.assertEqual(rows, [(1,)])


class HistorySearchPopularTermTest(unittest.TestCase):
    """A popular term must surface every matching transcript.

    The row cap used to apply before grouping: 12k matching chunks collapsed to an arbitrary 300
    rows, so a session whose rows lost the cut vanished from results even though it matched --
    measured live with a filename spread across a whole project's transcripts, where the active
    session's own rows never survived. The cap now applies to transcripts, newest first.
    """

    def test_search_surfaces_a_match_buried_past_the_row_cap(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            filler_path = root / "filler.jsonl"
            filler_path.write_text("filler line mentioning alpha_beta_gamma.py here\n")
            target_path = root / "target.jsonl"
            target_path.write_text("see ALPHA_beta_GAMMA.py here\n")
            database_path = root / "history.sqlite3"
            index = HistorySearchIndex(database_path)
            index._initialize_database()
            filler_bytes = len("filler line mentioning alpha_beta_gamma.py here\n".encode())
            target_bytes = len("see alpha_beta_gamma.py here\n".encode())
            with sqlite3.connect(database_path) as database:
                database.execute(
                    "INSERT INTO history_sources(source_path, agent_kind, agent_session_id, cwd, title, size, mtime_ns)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (str(filler_path), "codex", "filler", str(root), "filler", filler_bytes, 100),
                )
                database.execute(
                    "INSERT INTO history_sources(source_path, agent_kind, agent_session_id, cwd, title, size, mtime_ns)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (str(target_path), "codex", "target", str(root), "target", target_bytes, 200),
                )
                for rowid in range(1, HistorySearchIndex._MAX_RESULTS + 1):
                    database.execute(
                        "INSERT INTO history_documents(rowid, source_path, agent_kind, agent_session_id, cwd, title,"
                        " scope, line_no, line_end, byte_start, byte_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (rowid, str(filler_path), "codex", "filler", str(root), "filler", "all", 1, 1, 0, filler_bytes),
                    )
                    database.execute(
                        "INSERT INTO history_fts(rowid, text) VALUES (?, ?)", (rowid, "alpha beta gamma py filler")
                    )
                database.execute(
                    "INSERT INTO history_documents(rowid, source_path, agent_kind, agent_session_id, cwd, title,"
                    " scope, line_no, line_end, byte_start, byte_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        HistorySearchIndex._MAX_RESULTS + 1,
                        str(target_path),
                        "codex",
                        "target",
                        str(root),
                        "target",
                        "all",
                        1,
                        1,
                        0,
                        target_bytes,
                    ),
                )
                database.execute(
                    "INSERT INTO history_fts(rowid, text) VALUES (?, ?)",
                    (HistorySearchIndex._MAX_RESULTS + 1, "alpha beta gamma py target"),
                )
                database.commit()
            results = index.search("alpha_beta_gamma.py", include_operations=True)
            by_source = {str(result["source_path"]): result for result in results}
            self.assertIn(str(target_path), by_source)
            self.assertIn(str(filler_path), by_source)
            self.assertIn("alpha_beta_gamma.py", by_source[str(target_path)]["matches"][0]["text"].casefold())


if __name__ == "__main__":
    unittest.main()
