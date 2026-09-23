"""A name too wide for the sidebar says what it is when you rest on it.

Terminal names and group names are cut off at an ellipsis, and nothing said the rest: the row carried
what it could be clicked for, or nothing at all, so a terminal whose name differed only past the cut
could not be told from its neighbour without opening it.
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
const scenario = JSON.parse(process.env.TERMDECK_TOOLTIP_SCENARIO);
const element = (className) => ({ className, title: "", children: [],
  classList: { contains: () => false, toggle() {} },
  closest: () => null,
  replaceChildren(...nodes) { this.children = nodes; },
  appendChild(node) { this.children.push(node); },
  setAttribute() {}, get dataset() { return this._data || (this._data = {}); } });
globalThis.document = { createElement: () => element("") };
const title = element("session-title");
const app = {
  terminalSearchText: "",
  appendTerminalSearchHighlightedText() {},
  __METHODS__
};
app.setSessionTitleText(title, scenario.name);
process.stdout.write(JSON.stringify({ title: title.title }));
"""


class TerminalNameTooltipTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__", method_source(source, "setSessionTitleText(title, text)"))

    def tooltip(self, name: str) -> str:
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_TOOLTIP_SCENARIO": json.dumps({"name": name})})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)["title"]

    def test_the_whole_name_is_on_the_row(self) -> None:
        name = "cpcv-sector-investigate-long-horizon"

        self.assertEqual(self.tooltip(name), name)

    def test_a_terminal_with_no_name_says_nothing(self) -> None:
        self.assertEqual(self.tooltip(""), "")


class GroupNameTooltipTest(unittest.TestCase):
    """The group label already said what clicking it does; the name it is hiding comes first."""

    def setUp(self) -> None:
        self.rendered = (STATIC / "app_search_git.js").read_text()
        self.refreshed = (STATIC / "app.js").read_text()

    def test_the_group_name_leads_the_hover_when_the_row_is_drawn(self) -> None:
        line = re.search(r"label\.title = `\$\{group\.name\}[^`]*`", self.rendered)

        self.assertIsNotNone(line, "the group name is no longer part of its hover")
        self.assertIn("Click to collapse/expand", line.group(0))

    def test_it_is_still_there_after_a_member_changes(self) -> None:
        # This runs on every status change; rewriting the hover without the name would drop it again.
        line = re.search(r"label\.title = `\$\{name\?\.textContent \|\| \"\"\}[^`]*`", self.refreshed)

        self.assertIsNotNone(line, "the refreshed group hover lost the name")


if __name__ == "__main__":
    unittest.main()
