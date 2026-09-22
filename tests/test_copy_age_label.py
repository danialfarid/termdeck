"""How old a copy is: one unit, and the whole date and time on the stamp itself.

A copy sits in a narrow column beside the text it was taken from, where "2h 14m ago" is three words
competing with the first words of the copy -- which are how anyone finds the one they want. The stamp
says "2h", and resting on it says exactly when.
"""

import json
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

from tests.test_terminal_cycle_order import method_source

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"

HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_COPY_AGE_SCENARIO);
const app = { __METHODS__ };
process.stdout.write(JSON.stringify(app.copyAgeLabel(Date.now() - scenario.ageMs)));
"""


class CopyAgeLabelTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__", method_source(source, "copyAgeLabel(timestampMs)"))

    def label(self, age_ms: int) -> dict:
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_COPY_AGE_SCENARIO": json.dumps({"ageMs": age_ms})})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_minutes(self) -> None:
        self.assertEqual(self.label(2 * 60000)["short"], "2m")

    def test_hours(self) -> None:
        self.assertEqual(self.label(4 * 3600000)["short"], "4h")

    def test_days(self) -> None:
        self.assertEqual(self.label(2 * 86400000)["short"], "2d")

    def test_one_unit_only(self) -> None:
        # "1d 6h" is what wrapped the column; the exact time is on the stamp for anyone who needs it.
        self.assertEqual(self.label(30 * 3600000)["short"], "1d")
        self.assertEqual(self.label(74 * 60000)["short"], "1h")

    def test_a_copy_just_made(self) -> None:
        self.assertEqual(self.label(3000)["short"], "now")

    def test_resting_on_it_says_exactly_when(self) -> None:
        exact = self.label(4 * 3600000)["exact"]

        self.assertTrue(exact)
        self.assertNotEqual(exact, "4h")

    def test_a_copy_with_no_time_has_no_stamp(self) -> None:
        # Copies saved before there were stamps: nothing to say, so nothing is shown.
        done = subprocess.run([self.node, "-e", self.harness.replace("Date.now() - scenario.ageMs", "0")],
                              capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_COPY_AGE_SCENARIO": json.dumps({"ageMs": 0})})
        self.assertEqual(done.returncode, 0, done.stderr)

        self.assertEqual(json.loads(done.stdout), {"short": "", "exact": ""})


class StampsCarryTheExactTimeTest(unittest.TestCase):
    """Both places a copy is shown: the notebook's copied-text view and the ⌘⇧V picker."""

    def setUp(self) -> None:
        self.source = (STATIC / "app_markdown_files.js").read_text()

    def body(self, name: str) -> str:
        return re.search(rf"\n  {name}\(\) \{{(.*?)\n  \}},", self.source, re.S).group(1)

    def test_the_picker_stamp_is_short_and_says_exactly_when_on_hover(self) -> None:
        body = self.body("renderSelectionCopyHistory")

        self.assertIn("this.copyAgeLabel(entry.copied_at_ms)", body)
        self.assertIn("stamp.textContent = when.short", body)
        self.assertIn("stamp.title = when.exact", body)

    def test_the_notebook_copies_stamp_does_the_same(self) -> None:
        body = self.body("renderNotebookRecentCopies")

        self.assertIn("this.copyAgeLabel(entry.copied_at_ms)", body)
        self.assertIn("stamp.textContent = when.short", body)
        self.assertIn("stamp.title = when.exact", body)


if __name__ == "__main__":
    unittest.main()
