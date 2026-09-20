"""A shortcut that is also a text field's own editing gesture stands down while one has focus.

Undo is the case that bit: Meta+Z is bound to "undo terminal composer edit", and the dispatcher claims a
bound shortcut before it looks at what has focus. Pressed in the description drawer -- or any field of
the app's own -- it sent an undo keystroke to the terminal while the field kept every character, so undo
did nothing where it was pressed.

The client has no JS harness; as in test_terminal_cycle_order the method is lifted out of the shipped
source and run under node against stubs.
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
const scenario = JSON.parse(process.env.TERMDECK_SHORTCUT_SCENARIO);
__TEXT_EDITING_ACTIONS__
// Another set the dispatcher consults, and not what is under test here.
const FILE_HISTORY_SHORTCUT_ACTIONS = new Set();
const ran = [];
const event = {
  type: "keydown", key: "z", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
  defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true; },
  stopPropagation() {},
  target: { tagName: scenario.tagName, closest: (selector) => (scenario.inTerminal && selector === ".xterm" ? {} : null) },
};
const app = {
  vscodeMode: false,
  fileHistoryActiveComparison: { isDiff: true },
  eventToBinding() { return "Meta+z"; },
  bindingMap() { return { "Meta+z": scenario.actionId }; },
  isTypingTarget(e) { return e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT" || !!e.target.closest(".xterm"); },
  readSelectionActionState() { return true; },
  isRecentTerminalsShortcut() { return false; },
  focusFileContentSearch() {},
  cycleView() {},
  runAction(actionId) { ran.push(actionId); },
  __METHODS__
};
process.stdout.write(JSON.stringify({ claimed: app.tryAppShortcut(event),
                                      prevented: event.defaultPrevented, ran }));
"""


class TextEditingShortcutTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        app_js = (STATIC / "app.js").read_text()
        actions = re.search(r"const TEXT_EDITING_ACTIONS = new Set\(\[[^\]]*\]\);", app_js)
        assert actions, "the set of text-editing shortcuts was not found"
        cls.harness = (HARNESS
                       .replace("__TEXT_EDITING_ACTIONS__", actions.group(0))
                       .replace("__METHODS__",
                                method_source((STATIC / "app_misc_ui.js").read_text(), "tryAppShortcut(e)")))

    def press(self, action_id: str, tag_name: str = "TEXTAREA", in_terminal: bool = False):
        scenario = {"actionId": action_id, "tagName": tag_name, "inTerminal": in_terminal}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_SHORTCUT_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_undo_is_left_to_the_field_being_typed_in(self) -> None:
        result = self.press("undo-terminal-edit")

        self.assertIs(result["claimed"], False)
        self.assertIs(result["prevented"], False, "the browser's own undo was cancelled")
        self.assertEqual(result["ran"], [])

    def test_the_same_goes_for_a_single_line_field(self) -> None:
        self.assertIs(self.press("undo-terminal-edit", tag_name="INPUT")["claimed"], False)

    def test_undo_in_the_terminal_is_still_the_terminal_s(self) -> None:
        # Where the shortcut was meant to work: xterm has no undo stack of its own, which is why the
        # keystroke is forwarded to the agent's composer.
        result = self.press("undo-terminal-edit", tag_name="DIV", in_terminal=True)

        self.assertIs(result["claimed"], True)
        self.assertEqual(result["ran"], ["undo-terminal-edit"])

    def test_and_with_nothing_focused_it_is_still_the_terminal_s(self) -> None:
        self.assertIs(self.press("undo-terminal-edit", tag_name="DIV")["claimed"], True)

    def test_an_ordinary_shortcut_still_works_while_typing(self) -> None:
        # The guard is for gestures the field itself owns. Switching terminals, scrolling, opening a
        # dialog are not, and they have always worked from a composer.
        result = self.press("next-terminal")

        self.assertIs(result["claimed"], True)
        self.assertEqual(result["ran"], ["next-terminal"])


if __name__ == "__main__":
    unittest.main()
