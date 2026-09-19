"""The terminal's block cursor can stop blinking.

An agent whose composer redraws itself while it works walks the cursor across the line and back on
every redraw; a blinking cursor on top of that is what reads as the composer flickering. The blink was
hardcoded on, so there was nothing to turn off.

The setting is only useful if all four halves are wired: the field exists on the server, new terminals
read it, terminals already open follow a change, and there is something to click.
"""

import json
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

from tests.test_terminal_cycle_order import method_source
from termdeck.server import UiSettings

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"

HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_BLINK_SCENARIO);
const app = { settings: scenario.settings, __METHODS__ };
process.stdout.write(JSON.stringify({ blink: app.terminalCursorBlinkEnabled() }));
"""


class TerminalCursorBlinkSettingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        cls.settings_js = (STATIC / "app_settings_ui.js").read_text()
        cls.terminal_js = (STATIC / "app_terminal.js").read_text()
        cls.app_js = (STATIC / "app.js").read_text()
        cls.harness = HARNESS.replace(
            "__METHODS__", method_source(cls.settings_js, "terminalCursorBlinkEnabled()"))

    def blink_for(self, settings):
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ,
                                   "TERMDECK_BLINK_SCENARIO": json.dumps({"settings": settings})})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)["blink"]

    def test_the_server_keeps_the_blink_on_by_default(self) -> None:
        self.assertIs(UiSettings().terminal_cursor_blink, True)

    def test_settings_written_before_this_existed_still_blink(self) -> None:
        # Absent is not off: every terminal in every saved settings file predates the field.
        self.assertIs(self.blink_for({}), True)

    def test_turning_it_off_reads_as_off(self) -> None:
        self.assertIs(self.blink_for({"terminal_cursor_blink": False}), False)

    def test_turning_it_back_on_reads_as_on(self) -> None:
        self.assertIs(self.blink_for({"terminal_cursor_blink": True}), True)

    def test_a_new_terminal_is_built_with_the_setting(self) -> None:
        constructor = re.search(r"new Terminal\(\{(.*?)\n    \}\)", self.terminal_js, re.S)
        self.assertIsNotNone(constructor, "the Terminal constructor call was not found")
        self.assertIn("cursorBlink: this.terminalCursorBlinkEnabled()", constructor.group(1))

    def test_terminals_already_open_follow_a_change(self) -> None:
        # Otherwise the switch only takes effect on terminals opened afterwards, which reads as the
        # switch doing nothing.
        loop = re.search(r"for \(const view of this\.views\.values\(\)\) \{(.*?)\n    \}", self.settings_js, re.S)
        self.assertIsNotNone(loop, "applySettings no longer walks the open terminals")
        self.assertIn("cursorBlink", loop.group(1))

    def test_there_is_a_switch_for_it(self) -> None:
        self.assertIn('buildToggleRow("Terminal cursor blink"', self.settings_js)

    def test_the_client_default_matches_the_server(self) -> None:
        self.assertIn("terminal_cursor_blink: true", self.app_js)


if __name__ == "__main__":
    unittest.main()
