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
                database.execute("INSERT INTO history_documents(rowid, source_path, agent_kind, agent_session_id, cwd, title, scope, line_no, line_end, byte_start, byte_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                                 (1, "/tmp/session.jsonl", "codex", "session", "/tmp", "session", "conversation", 1, 1, 0, 10))
                database.execute("INSERT INTO history_sources(source_path, agent_kind, agent_session_id, cwd, title, size, mtime_ns) VALUES (?, ?, ?, ?, ?, ?, ?)",
                                 ("/tmp/session.jsonl", "codex", "session", "/tmp", "session", 10, 1))
                database.execute("INSERT INTO history_fts_conversation(rowid, text) VALUES (?, ?)", (1, "task runs store py"))
                database.commit()
            expression = index._fts_expression("task_runs_store.py")
            with sqlite3.connect(database_path) as database:
                rows = database.execute(
                    "SELECT rowid FROM history_fts_conversation WHERE history_fts_conversation MATCH ?", (expression,)
                ).fetchall()
            self.assertEqual(rows, [(1,)])


if __name__ == "__main__":
    unittest.main()
