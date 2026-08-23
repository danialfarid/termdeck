import json
import tempfile
import unittest
from pathlib import Path

from termdeck.state_backup import StateBackupManager


class StateBackupManagerTest(unittest.TestCase):
    def _write_state(self, root: Path, sessions: list[dict[str, str]]) -> None:
        payloads = {
            "sessions.json": sessions,
            "settings.json": {"project_state": {"stock": {"session_order": [item["session_id"] for item in sessions]}}},
            "projects.json": {"stock": "/tmp/stock"},
            "closed_sessions.json": [],
        }
        for name, payload in payloads.items():
            (root / name).write_text(json.dumps(payload))

    def test_before_write_keeps_previous_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._write_state(root, [{"session_id": "old"}])
            manager = StateBackupManager(root, 50_000_000, 3600.0)
            manager.create_snapshot("initial", True)
            manager.before_state_write(root / "sessions.json")
            (root / "sessions.json").write_text(json.dumps([{"session_id": "new"}]))

            snapshots = sorted((root / "backups").glob("snapshot-*"), key=lambda path: path.stat().st_mtime_ns)
            self.assertEqual(json.loads((snapshots[-1] / "sessions.json").read_text()), [{"session_id": "old"}])

    def test_invalid_state_file_requires_explicit_snapshot_selection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._write_state(root, [{"session_id": "keep"}])
            manager = StateBackupManager(root, 50_000_000, 3600.0)
            manager.create_snapshot("initial", True)
            (root / "sessions.json").write_text("[invalid")

            status = manager.recovery_status()

            self.assertTrue(status["required"])
            self.assertEqual((root / "sessions.json").read_text(), "[invalid")
            snapshot_name = status["snapshots"][0]["name"]
            recovered = manager.restore_snapshot(snapshot_name)
            self.assertEqual(recovered, [root / name for name in manager.STATE_FILE_ROOT_TYPES])
            self.assertEqual(json.loads((root / "sessions.json").read_text()), [{"session_id": "keep"}])
            self.assertEqual(len(list((root / "backups" / "recovery").glob("sessions.json-*.before-manual-restore"))), 1)

    def test_suspicious_session_truncation_requires_explicit_snapshot_selection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sessions = [{"session_id": f"session-{index}"} for index in range(8)]
            self._write_state(root, sessions)
            manager = StateBackupManager(root, 50_000_000, 3600.0)
            manager.create_snapshot("initial", True)
            (root / "sessions.json").write_text(json.dumps([{ "session_id": "test" }]))

            status = manager.recovery_status()

            self.assertTrue(status["required"])
            self.assertTrue(any(issue["kind"] == "suspicious" for issue in status["issues"]))
            snapshot_name = status["snapshots"][0]["name"]
            recovered = manager.restore_snapshot(snapshot_name)
            self.assertEqual(recovered, [root / name for name in manager.STATE_FILE_ROOT_TYPES])
            self.assertEqual(json.loads((root / "sessions.json").read_text()), sessions)
            self.assertEqual(len(list((root / "backups" / "recovery").glob("sessions.json-*.before-manual-restore"))), 1)

    def test_grouped_sessions_count_as_referenced_settings_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sessions = [{"session_id": f"session-{index}"} for index in range(4)]
            self._write_state(root, sessions)
            settings = {"project_state": {"demo": {
                "session_order": [],
                "terminal_layout": ["group:agents"],
                "session_groups": {item["session_id"]: "agents" for item in sessions},
            }}}
            (root / "settings.json").write_text(json.dumps(settings))
            manager = StateBackupManager(root, 50_000_000, 3600.0)
            manager.create_snapshot("grouped", True)

            self.assertFalse(manager.recovery_status()["required"])

    def test_snapshot_retention_removes_oldest_snapshots_over_cap(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._write_state(root, [{"session_id": "one"}])
            manager = StateBackupManager(root, 700, 3600.0)
            manager.create_snapshot("one", True)
            for session_id in ("two", "three", "four"):
                (root / "sessions.json").write_text(json.dumps([{"session_id": session_id}]))
                manager.create_snapshot(session_id, True)

            snapshots = list((root / "backups").glob("snapshot-*"))

            self.assertLessEqual(len(snapshots), 2)
            self.assertEqual(json.loads((max(snapshots, key=lambda path: path.stat().st_mtime_ns) / "sessions.json").read_text()),
                             [{"session_id": "four"}])


if __name__ == "__main__":
    unittest.main()
