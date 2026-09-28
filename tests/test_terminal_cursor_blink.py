"""The terminal cursor never blinks.

An agent whose composer redraws itself while it works walks the cursor across the line and back on
every redraw; a blinking cursor on top of that is what reads as the composer flickering. Blinking
used to be a setting, default on; it is now removed entirely and the cursor is always steady.
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


class TerminalCursorNeverBlinksTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.settings_js = (STATIC / "app_settings_ui.js").read_text()
        cls.terminal_js = (STATIC / "app_terminal.js").read_text()
        cls.app_js = (STATIC / "app.js").read_text()

    def test_the_server_has_no_blink_setting(self) -> None:
        self.assertNotIn("terminal_cursor_blink", UiSettings.model_fields)

    def test_settings_saved_with_the_old_switch_still_load(self) -> None:
        # Stored settings files keep the removed key; it is ignored, not an error, and a
        # subsequent save drops it.
        settings = UiSettings(**{"terminal_cursor_blink": True})
        self.assertNotIn("terminal_cursor_blink", settings.model_dump())

    def test_the_client_has_no_blink_setting_either(self) -> None:
        for source in (self.app_js, self.settings_js, self.terminal_js):
            self.assertNotIn("terminal_cursor_blink", source)
        for source in (self.settings_js, self.terminal_js):
            self.assertNotIn("terminalCursorBlinkEnabled", source)

    def test_there_is_no_switch_for_it(self) -> None:
        self.assertNotIn("Terminal cursor blink", self.settings_js)

    def test_a_new_terminal_is_built_without_blink(self) -> None:
        constructor = re.search(r"new Terminal\(\{(.*?)\n    \}\)", self.terminal_js, re.S)
        self.assertIsNotNone(constructor, "the Terminal constructor call was not found")
        self.assertIn("cursorBlink: false", constructor.group(1))

    def test_terminals_already_open_are_held_without_blink(self) -> None:
        loop = re.search(r"for \(const view of this\.views\.values\(\)\) \{(.*?)\n    \}", self.settings_js, re.S)
        self.assertIsNotNone(loop, "applySettings no longer walks the open terminals")
        self.assertIn("view.term.options.cursorBlink = false", loop.group(1))


HANDLER_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_DECSCUSR_SCENARIO);
const term = {
  options: { cursorBlink: scenario.startBlink, cursorStyle: "block" },
  parser: { registerCsiHandler(id, handler) { term.__id = id; term.__handler = handler; } },
};
const app = { __METHODS__ };
app.holdCursorBlinkOff(term);
const handled = term.__handler([scenario.decscusr]);
process.stdout.write(JSON.stringify({ id: term.__id, handled, options: term.options }));
"""


class CursorBlinkSurvivesTheAppsOwnRequestTest(unittest.TestCase):
    """A TUI asks for its own cursor with DECSCUSR (CSI Ps SP q), and xterm obeys by writing both the
    shape and the blink out of that one parameter. Codex asks for a blinking one on every repaint, which
    would turn the blink straight back on.

    Taking that sequence keeps the shape it asked for and drops only the blink.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_settings_ui.js").read_text()
        cls.harness = HANDLER_HARNESS.replace("__METHODS__", method_source(source, "holdCursorBlinkOff(term)"))

    def decscusr(self, parameter: int, start_blink: bool = True):
        scenario = {"decscusr": parameter, "startBlink": start_blink}
        done = subprocess.run(
            [self.node, "-e", self.harness],
            capture_output=True,
            text=True,
            check=False,
            env={**os.environ, "TERMDECK_DECSCUSR_SCENARIO": json.dumps(scenario)},
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_it_listens_for_the_cursor_style_sequence(self) -> None:
        # CSI Ps SP q: the space is what separates it from every other CSI ending in q.
        self.assertEqual(self.decscusr(5)["id"], {"intermediates": " ", "final": "q"})

    def test_a_blinking_cursor_asked_for_is_always_refused(self) -> None:
        for parameter in (0, 1, 2, 3, 4, 5, 6):
            with self.subTest(parameter=parameter):
                result = self.decscusr(parameter)

                self.assertIs(result["options"]["cursorBlink"], False)
                self.assertIs(result["handled"], True)

    def test_the_shape_it_asked_for_is_still_honored(self) -> None:
        # Blinking bar: the blink goes, the bar stays. Dropping the sequence whole would leave codex's
        # composer drawing a block where it asked for a bar.
        self.assertEqual(self.decscusr(5)["options"]["cursorStyle"], "bar")
        self.assertEqual(self.decscusr(6)["options"]["cursorStyle"], "bar")
        self.assertEqual(self.decscusr(3)["options"]["cursorStyle"], "underline")
        self.assertEqual(self.decscusr(4)["options"]["cursorStyle"], "underline")
        self.assertEqual(self.decscusr(1)["options"]["cursorStyle"], "block")
        self.assertEqual(self.decscusr(2)["options"]["cursorStyle"], "block")

    def test_a_missing_parameter_is_a_block(self) -> None:
        self.assertEqual(self.decscusr(0)["options"]["cursorStyle"], "block")


if __name__ == "__main__":
    unittest.main()
