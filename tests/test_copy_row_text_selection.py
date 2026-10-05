"""Text in an expanded copy can be selected.

Every gesture that selects text ends in a click, and a click on a copy toggled it -- re-rendering the
row and dropping the selection -- so a drag across an expanded copy collapsed it, and the first click
of a double-click collapsed it before the second could pick the word. A copy is now opened or closed
only by a click that settles without having selected anything.
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
const scenario = JSON.parse(process.env.TERMDECK_COPY_SELECTION_SCENARIO);
const inside = { name: "inside" };
const outside = { name: "outside" };
const nodes = { inside, outside, none: null };
globalThis.window = {
  // A click in text leaves a caret: a collapsed selection that still has its one range.
  getSelection: () => (scenario.selection === null ? null : {
    isCollapsed: scenario.selection.collapsed,
    rangeCount: 1,
    anchorNode: nodes[scenario.selection.anchor],
    focusNode: nodes[scenario.selection.focus],
  }),
};
const row = { contains: (node) => node === inside };
const app = { __METHODS__ };
process.stdout.write(JSON.stringify(app.copyRowSelectingText(row)));
"""


class SelectingTextTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        cls.source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__", method_source(cls.source, "copyRowSelectingText(row)"))

    def selecting(self, selection: dict | None) -> bool:
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_COPY_SELECTION_SCENARIO": json.dumps({"selection": selection})})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_a_drag_that_selected_text_in_the_copy(self) -> None:
        self.assertTrue(self.selecting({"collapsed": False, "anchor": "inside", "focus": "inside"}))

    def test_a_selection_that_ends_in_the_copy(self) -> None:
        # Dragged in from outside the row and released over it.
        self.assertTrue(self.selecting({"collapsed": False, "anchor": "outside", "focus": "inside"}))

    def test_a_plain_click(self) -> None:
        # Pressing the button clears any selection, so a click that selected nothing finds it collapsed.
        self.assertFalse(self.selecting({"collapsed": True, "anchor": "inside", "focus": "inside"}))

    def test_text_selected_somewhere_else_on_the_page(self) -> None:
        self.assertFalse(self.selecting({"collapsed": False, "anchor": "outside", "focus": "outside"}))

    def test_no_selection_at_all(self) -> None:
        self.assertFalse(self.selecting(None))


class ClicksWaitTheirTurnTest(unittest.TestCase):
    """Both places a copy can be clicked go through the same settle-and-check step."""

    def setUp(self) -> None:
        source = (STATIC / "app_markdown_files.js").read_text()
        self.render = re.search(r"  renderNotebookRecentCopies\(\) \{(.*?)\n  \},", source, re.S).group(1)

    def test_neither_handler_toggles_straight_away(self) -> None:
        for handler in ("row.onclick", "content.onclick"):
            body = re.search(rf"{re.escape(handler)} = \(event\) => \{{(.*?)\n      \}};", self.render, re.S).group(1)
            with self.subTest(handler=handler):
                self.assertIn("clickToToggle(event)", body)
                self.assertNotIn("toggleExpanded()", body)

    def test_the_second_click_of_a_double_click_cancels_the_first(self) -> None:
        settle = re.search(r"const clickToToggle = \(event\) => \{(.*?)\n      \};", self.render, re.S).group(1)

        self.assertIn("clearTimeout(this.copyRowToggleTimer)", settle)
        self.assertRegex(settle, r"if \(event\.detail > 1\) return;")
        self.assertIn("if (!this.copyRowSelectingText(row)) toggleExpanded();", settle)


if __name__ == "__main__":
    unittest.main()
