import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from termdeck.settings_store import UiSettingsStore


class SharedLoadTest(unittest.TestCase):
    def test_settings_are_parsed_again_only_when_the_file_changes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = UiSettingsStore(Path(directory) / "settings.json")
            store.save({"capacity_retry": False})
            self.assertEqual(store.load_shared(), {"capacity_retry": False})
            with patch("termdeck.settings_store.json.loads", side_effect=AssertionError("parsed again")):
                self.assertEqual(store.load_shared(), {"capacity_retry": False})
            store.save({"capacity_retry": True, "padding": "longer"})
            self.assertEqual(store.load_shared()["capacity_retry"], True)
            self.assertEqual(json.loads((Path(directory) / "settings.json").read_text())["capacity_retry"], True)


if __name__ == "__main__":
    unittest.main()
