"""A finger on a tab has not chosen anything yet.

The row scrolls sideways, and opening the note under the finger the moment it lands meant every reach
for a tab further along opened two or three notes on the way. A tap opens one, a swipe scrolls past
it, and a hold offers the Trash.
"""

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from tests.test_terminal_cycle_order import method_source

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"

HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_GESTURE_SCENARIO);
const MOBILE_SIDEBAR_CONTEXT_LONG_PRESS_MS = 500;
const MOBILE_SIDEBAR_CONTEXT_MOVE_TOLERANCE = 12;
const opened = [];
const menus = [];
const listeners = new Map();
const prevented = [];
let timer = null;
global.window = {
  setTimeout: (fn) => { timer = fn; return 1; },
  clearTimeout: () => { timer = null; },
};
const row = {
  addEventListener: (type, handler) => listeners.set(type, handler),
};
const tab = {
  dataset: { noteId: "note-2" },
  closest: (selector) => (selector.includes("data-note-id") ? tab : null),
};
const app = {
  $: () => row,
  notebookProjectState: () => ({ notebook_notes: [{ note_id: "note-2", text: "" }] }),
  selectNotebookNote: (noteId) => { opened.push(noteId); },
  openNotebookTabContextMenu: (event, note) => { menus.push(note.note_id); },
  __METHODS__
};
app.installNotebookTabGestures();

const event = (type, over = {}) => ({
  target: tab, button: 0, pointerId: 5, pointerType: scenario.pointerType || "touch",
  clientX: 20, clientY: 10, detail: 1,
  preventDefault: () => prevented.push(type), stopPropagation() {},
  ...over,
});
const fire = (type, over) => listeners.get(type)?.(event(type, over));

for (const step of scenario.steps) {
  if (step === "hold") { if (timer) timer(); continue; }
  fire(step.type, step.over || {});
}
process.stdout.write(JSON.stringify({ opened, menus, prevented }));
"""


class NotebookTabGestureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__", method_source(source, "installNotebookTabGestures()"))

    def gesture(self, steps: list, pointer_type: str = "touch") -> dict:
        scenario = {"steps": steps, "pointerType": pointer_type}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_GESTURE_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_a_tap_opens_the_note(self) -> None:
        result = self.gesture([{"type": "pointerdown"}, {"type": "pointerup"}])

        self.assertEqual(result["opened"], ["note-2"])

    def test_the_note_is_not_opened_while_the_finger_is_still_down(self) -> None:
        result = self.gesture([{"type": "pointerdown"}])

        self.assertEqual(result["opened"], [])

    def test_a_swipe_scrolls_past_the_tab_it_started_on(self) -> None:
        result = self.gesture([{"type": "pointerdown"},
                               {"type": "pointermove", "over": {"clientX": 90}},
                               {"type": "pointerup", "over": {"clientX": 90}}])

        self.assertEqual(result["opened"], [])

    def test_nothing_is_prevented_on_the_way_down_or_the_row_would_not_scroll(self) -> None:
        result = self.gesture([{"type": "pointerdown"}])

        self.assertEqual(result["prevented"], [])

    def test_a_small_wobble_is_still_a_tap(self) -> None:
        result = self.gesture([{"type": "pointerdown"},
                               {"type": "pointermove", "over": {"clientX": 24}},
                               {"type": "pointerup", "over": {"clientX": 24}}])

        self.assertEqual(result["opened"], ["note-2"])

    def test_a_hold_offers_the_menu_and_opens_no_note(self) -> None:
        result = self.gesture([{"type": "pointerdown"}, "hold", {"type": "pointerup"}])

        self.assertEqual(result["menus"], ["note-2"])
        self.assertEqual(result["opened"], [])

    def test_a_cancelled_touch_opens_nothing(self) -> None:
        result = self.gesture([{"type": "pointerdown"}, {"type": "pointercancel"}, {"type": "pointerup"}])

        self.assertEqual(result["opened"], [])

    def test_a_mouse_acts_on_the_press(self) -> None:
        # There is no gesture to tell apart with a pointer, and waiting for the release would make the
        # tabs feel slower than every other tab strip in the deck.
        result = self.gesture([{"type": "pointerdown"}], pointer_type="mouse")

        self.assertEqual(result["opened"], ["note-2"])
        self.assertEqual(result["prevented"], ["pointerdown"])


if __name__ == "__main__":
    unittest.main()
