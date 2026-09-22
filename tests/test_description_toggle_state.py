"""The description button reads as pressed while the drawer it opened is open.

It opens a drawer and closes it again, so it is a push button; without a held state it looked like
something that flashed and did nothing, and there was no way to tell from the bar whether the drawer
below was open.
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
const scenario = JSON.parse(process.env.TERMDECK_DESCRIPTION_SCENARIO);
const button = { classes: new Set(), attributes: {},
  classList: { toggle(name, on) { if (on) button.classes.add(name); else button.classes.delete(name); } },
  setAttribute(name, value) { button.attributes[name] = value; } };
const app = {
  $: (id) => (id === "session-description-toggle" ? button : null),
  __METHODS__
};
app.markSessionDescriptionToggle(scenario.open);
process.stdout.write(JSON.stringify({ classes: [...button.classes], attributes: button.attributes }));
"""


class PressedStateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_misc_ui.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__", method_source(source, "markSessionDescriptionToggle(open)"))

    def mark(self, open_drawer: bool) -> dict:
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_DESCRIPTION_SCENARIO": json.dumps({"open": open_drawer})})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_an_open_drawer_holds_the_button_down(self) -> None:
        result = self.mark(True)

        self.assertEqual(result["classes"], ["on"])
        self.assertEqual(result["attributes"]["aria-pressed"], "true")

    def test_a_closed_drawer_lets_it_go(self) -> None:
        result = self.mark(False)

        self.assertEqual(result["classes"], [])
        self.assertEqual(result["attributes"]["aria-pressed"], "false")


class WiredBothWaysTest(unittest.TestCase):
    """Whichever way the drawer opens or closes, the button follows it."""

    def setUp(self) -> None:
        self.js = (STATIC / "app_misc_ui.js").read_text()
        self.css = (STATIC / "style.css").read_text()

    def body(self, name: str) -> str:
        match = re.search(rf"\n  {name}\(.*?\) \{{(.*?)\n  \}},", self.js, re.S)
        self.assertIsNotNone(match, f"{name} moved")
        return match.group(1)

    def test_opening_the_drawer_presses_the_button(self) -> None:
        self.assertIn("markSessionDescriptionToggle(true)", self.body("openSessionDescriptionEditor"))

    def test_closing_it_releases_the_button(self) -> None:
        # Closing happens from the button, from a press outside the drawer, and from the deck itself
        # when the terminal it belongs to goes away -- all of them come through here.
        self.assertIn("markSessionDescriptionToggle(false)", self.body("closeSessionDescriptionEditor"))

    def test_the_held_button_is_painted_like_the_other_held_buttons(self) -> None:
        held = re.search(r"([^{}]*#session-description-toggle\.on[^{}]*)\{([^}]*)\}", self.css, re.S)
        self.assertIsNotNone(held, "the pressed style for the description button is gone")

        self.assertIn("var(--accent)", held.group(2))
        self.assertIn("#notebook-toggle.on", held.group(1), "the same rule as the deck's other push buttons")


if __name__ == "__main__":
    unittest.main()
