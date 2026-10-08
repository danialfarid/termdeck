"""A Codex or Muse pane with a hole in it is rebuilt from the recording.

Now and then a switch to a busy Codex or Muse terminal showed the conversation, then pages of blank
rows, then the live tail. The agent's recording replays without the hole, so the page's rebuild is
what went wrong; the repair is to rebuild from the recording. What decides that is how many blank
rows sit between content -- never the blank rows under the last line, which a pane taller than the
agent drawing in it always has.

The measurement is lifted out of the shipped client and run under node against a stub buffer.
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
const scenario = JSON.parse(process.env.TERMDECK_HOLE_SCENARIO);
const lines = scenario.lines;
const app = { __METHODS__ };
const view = { term: { rows: scenario.rows, buffer: { active: {
  baseY: scenario.baseY, length: lines.length,
  getLine: (row) => (row >= 0 && row < lines.length ? { translateToString: () => lines[row] } : undefined),
} } } };
process.stdout.write(JSON.stringify(app.terminalBlankHoleRows(view)));
"""


class BlankHoleRowsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_settings_ui.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__", method_source(source, "terminalBlankHoleRows(view)"))

    def hole(self, lines: list[str], base_y: int, rows: int) -> int:
        scenario = {"lines": lines, "baseY": base_y, "rows": rows}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_HOLE_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_the_hole_a_switch_left(self) -> None:
        # Measured: older conversation, 193 blank rows, then the live tail, starting in the history
        # just above the screen.
        lines = ["older conversation"] * 40 + [""] * 193 + ["• Explored", "• Ran tail -12", "› composer"] + [""] * 21
        self.assertEqual(self.hole(lines, base_y=45, rows=221), 193)

    def test_the_blank_rows_under_the_last_line_are_not_a_hole(self) -> None:
        # A 221-row pane over a 200-row agent always ends in blank rows.
        lines = ["history"] * 100 + ["› composer"] + [""] * 120
        self.assertEqual(self.hole(lines, base_y=0, rows=221), 0)

    def test_blank_rows_above_everything_are_not_a_hole(self) -> None:
        # A fresh session's screen starts empty above its first line; nothing is missing there.
        lines = [""] * 150 + ["banner", "› composer"] + [""] * 69
        self.assertEqual(self.hole(lines, base_y=0, rows=221), 0)

    def test_ordinary_spacing_between_paragraphs(self) -> None:
        lines = (["paragraph"] * 3 + [""] * 2) * 30 + ["› composer"]
        self.assertEqual(self.hole(lines, base_y=0, rows=221), 2)

    def test_history_far_above_the_screen_is_not_searched(self) -> None:
        # Only a screen's worth of history above the screen is looked at; an old gap deep in the
        # scrollback is not the pane being broken now.
        lines = ["old"] * 10 + [""] * 300 + ["history"] * 500 + ["› composer"]
        self.assertEqual(self.hole(lines, base_y=600, rows=200), 0)


class WiredInTest(unittest.TestCase):
    def test_only_the_inline_agents_rebuild(self) -> None:
        app_js = (STATIC / "app.js").read_text()
        behaviors = re.search(r"const AGENT_CLIENT_BEHAVIORS = \{(.*?)\n\};", app_js, re.S).group(1)
        for kind, expected in (("codex", True), ("muse", True), ("claude", False)):
            block = re.search(rf"\n  {kind}: \{{(.*?)\n  \}},", behaviors, re.S).group(1)
            with self.subTest(agent=kind):
                self.assertEqual("rebuildOnBlankHole: true" in block, expected)

    def test_checked_on_every_switch_and_after_every_replay(self) -> None:
        self.assertIn("this.scheduleTerminalHoleCheck(view);", (STATIC / "app_markdown_files.js").read_text())
        self.assertIn("this.scheduleTerminalHoleCheck(view);", (STATIC / "app_terminal.js").read_text())


if __name__ == "__main__":
    unittest.main()
