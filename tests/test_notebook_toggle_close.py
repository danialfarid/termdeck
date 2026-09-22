"""Pressing the Notes button closes the notebook.

A press outside the notebook closes it, and the button that opens it is not outside it -- the button
does the closing itself. The outside check knew two of the four buttons, so on a phone, where the one
in use is the mobile button, the press closed the notebook and the button's own handler opened it
again: it could not be closed at all.
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
const present = new Set(JSON.parse(process.env.TERMDECK_TOGGLE_SCENARIO));
const app = {
  $: (id) => (present.has(id) ? { id } : null),
  __METHODS__
};
process.stdout.write(JSON.stringify(app.notebookToggleElements().map((element) => element.id)));
"""

TOGGLE_IDS = ["notebook-toggle", "history-notebook-toggle", "file-tabs-notebook", "mobile-notebook-toggle",
              "notebook-head-toggle"]


class NotebookToggleElementsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__", method_source(source, "notebookToggleElements()"))

    def toggles(self, present: list[str]) -> list[str]:
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_TOGGLE_SCENARIO": json.dumps(present)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_every_button_that_opens_the_notebook_is_one(self) -> None:
        self.assertEqual(self.toggles(TOGGLE_IDS), TOGGLE_IDS)

    def test_the_mobile_button_is_among_them(self) -> None:
        # The one the phone actually uses, and the one the outside check used to be missing.
        self.assertEqual(self.toggles(["mobile-notebook-toggle"]), ["mobile-notebook-toggle"])

    def test_a_button_this_page_does_not_have_is_skipped(self) -> None:
        self.assertEqual(self.toggles([]), [])


class OutsidePressTest(unittest.TestCase):
    """The document-level check is an inline listener; what it must not do is keep its own list."""

    def setUp(self) -> None:
        self.source = (STATIC / "app.js").read_text()
        match = re.search(r"const notebookPanel = this\.\$\(\"notebook-panel\"\);(.{0,600}?)\n      \}",
                          self.source, re.S)
        self.assertIsNotNone(match, "the notebook branch of the document press handler moved")
        self.branch = match.group(1)

    def test_the_outside_check_asks_for_the_buttons(self) -> None:
        self.assertIn("notebookToggleElements()", self.branch)

    def test_it_does_not_keep_a_list_of_its_own(self) -> None:
        # A second list is how two of the four buttons came to be missing from this check.
        named = [toggle for toggle in TOGGLE_IDS if f'"{toggle}"' in self.branch]

        self.assertEqual(named, [])

    def test_a_press_outside_still_closes_the_notebook(self) -> None:
        self.assertIn("setNotebookOpen(false", self.branch)


class NoCloseButtonTest(unittest.TestCase):
    """Pressing Notes again is the way out, so there is no × to press instead."""

    def setUp(self) -> None:
        static = Path(__file__).resolve().parent.parent / "termdeck" / "static"
        self.html = (static / "index.html").read_text()
        self.css = (static / "style.css").read_text()
        self.js = (static / "app_markdown_files.js").read_text()

    def test_the_notebook_has_no_close_button(self) -> None:
        self.assertNotIn('id="notebook-close"', self.html)
        self.assertNotIn("notebook-close\"", self.js)

    def test_the_panel_carries_a_notes_button_of_its_own(self) -> None:
        # In the head, in line with the head's other buttons, in whichever mode the deck is in.
        self.assertIn('id="notebook-head-toggle"', self.html)
        actions = re.search(r'<span id="notebook-actions">(.*?)\n    </span>', self.html, re.S).group(1)

        self.assertIn("notebook-head-toggle", actions)

    def test_the_button_outside_stands_down_while_the_notebook_is_open(self) -> None:
        # It sits in a different place in each mode, and behind the panel in some of them, which is
        # what made it look misaligned in one mode and swallowed in the other.
        hidden_while_open = [selectors for selectors, body in re.findall(r"([^{}]+)\{([^{}]*)\}", self.css)
                             if "body.notebook-open" in selectors and "display: none" in body]
        self.assertTrue(hidden_while_open, "the rule standing the outside buttons down is gone")
        stood_down = " ".join(hidden_while_open)

        for toggle in ("#notebook-toggle", "#history-notebook-toggle", "#file-tabs-notebook", "#mobile-notebook-toggle"):
            self.assertIn(toggle, stood_down)
        # The one in the head is the one that stays: hiding it would leave no way back out.
        self.assertNotIn("#notebook-head-toggle", stood_down)

    def test_the_head_keeps_no_gap_for_a_button_that_is_not_there(self) -> None:
        # The Notes button is inside the head now, so the head needs no corner kept clear for it.
        padding = re.search(r"#notebook-head\s*\{[^}]*padding:\s*\d+px\s+(\d+)px", self.css)

        self.assertLessEqual(int(padding.group(1)), 16)


if __name__ == "__main__":
    unittest.main()
