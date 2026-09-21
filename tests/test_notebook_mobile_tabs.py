"""The notebook's tab row on a phone.

Tabs that may shrink are tabs with nothing readable on them: six notes squeezed into the width of one
and the titles ran together. The × on a tab moves that note to the Trash, which is a mis-tap away from
the tab's own target, and "Copied" spells out an icon that already says it.
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
MOBILE_MEDIA = "@media (max-width: 900px), (hover: none) and (pointer: coarse) {"

MENU_HARNESS = """
const menu = { textContent: "x", items: [] };
const positioned = [];
const app = {
  $: (id) => (id === "context-menu" ? menu : null),
  addContextItem: (target, label, handler, icon) => { target.items.push({ label, enabled: !!handler, icon }); },
  positionContextMenu: (target, x, y) => positioned.push({ x, y }),
  createNotebookNote() { menu.items.push("created"); },
  closeNotebookNote(noteId) { menu.items.push({ trashed: noteId }); },
  __METHODS__
};
let prevented = 0;
app.openNotebookTabContextMenu({ preventDefault: () => { prevented += 1; }, stopPropagation() {},
  clientX: 30, clientY: 90 }, { note_id: "note-7", text: "hi" });
const trash = menu.items.find((item) => item.label === "Move to Trash");
process.stdout.write(JSON.stringify({ items: menu.items, positioned, prevented,
  target: app.contextMenuTarget, cleared: menu.textContent === "" }));
"""


def mobile_block() -> str:
    source = (STATIC / "style.css").read_text()
    start = source.index(MOBILE_MEDIA)
    depth = 0
    for index in range(start, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start:index]
    raise AssertionError("mobile media query is never closed")


def rule(block: str, selector: str) -> str:
    match = re.search(rf"(?m)^\s*{re.escape(selector)}\s*\{{([^}}]*)\}}", block)
    return match.group(1) if match else ""


class MobileTabRowStyleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.block = mobile_block()
        cls.full = (STATIC / "style.css").read_text()

    def test_a_tab_keeps_a_width_it_can_be_read_at(self) -> None:
        # Six characters of the title: enough to tell two notes apart and to hit, and no wider than
        # the name needs.
        self.assertIn("flex: none", rule(self.block, ".notebook-tab"))
        self.assertRegex(rule(self.block, ".notebook-tab-label"), r"min-width:\s*6ch")

    def test_the_head_keeps_its_width_for_its_own_buttons(self) -> None:
        # The Notes button is one of them now, so no corner is kept clear for a button outside.
        padding = re.search(r"padding:\s*\d+px\s+(\d+)px", rule(self.block, "#notebook-head"))

        self.assertLessEqual(int(padding.group(1)), 16)

    def test_the_row_scrolls_rather_than_squeezing(self) -> None:
        # Tabs that no longer shrink have to go somewhere; the row was already set up to scroll.
        self.assertRegex(self.full, r"#notebook-tabs\s*\{[^}]*overflow-x:\s*auto")

    def test_the_trash_button_is_not_on_a_tab(self) -> None:
        # Named through the row: the codicon class the button also carries is a stronger selector
        # than a plain class of ours, and a rule that loses leaves the × on screen.
        self.assertIn("display: none", rule(self.block, "#notebook-tabs .notebook-tab-close"))

    def test_the_trash_button_stays_on_a_desktop(self) -> None:
        self.assertNotIn("display: none", rule(self.full.split(MOBILE_MEDIA)[0], ".notebook-tab-close"))

    def test_copied_shows_its_icon_without_the_word(self) -> None:
        self.assertIn("display: none", rule(self.block, ".notebook-copies-label"))
        self.assertNotIn("display: none", rule(self.block, ".notebook-copies-icon"))


class NotebookTabMenuTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = MENU_HARNESS.replace(
            "__METHODS__", method_source(source, "openNotebookTabContextMenu(event, note)"))
        done = subprocess.run([cls.node, "-e", cls.harness], capture_output=True, text=True, check=False,
                              env={**os.environ})
        if done.returncode != 0:
            raise AssertionError(done.stderr)
        cls.result = json.loads(done.stdout)

    def test_the_menu_offers_the_trash_the_tab_no_longer_shows(self) -> None:
        # Hiding the × must not take the note with it: holding the tab is how one is thrown away.
        labels = [item["label"] for item in self.result["items"] if isinstance(item, dict)]

        self.assertEqual(labels, ["New note", "Move to Trash"])

    def test_it_opens_where_the_finger_is(self) -> None:
        self.assertEqual(self.result["positioned"], [{"x": 30, "y": 90}])

    def test_it_is_about_the_tab_that_was_held(self) -> None:
        self.assertEqual(self.result["target"], {"type": "notebook-tab", "key": "note-7"})


if __name__ == "__main__":
    unittest.main()
