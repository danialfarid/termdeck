"""On a phone, a held sidebar row is picked up, not asked for its menu.

The hold used to open the context menu, which every row already offers on its ⋯ button, and nothing on a
phone could reorder terminals or act on several at once. Now a hold on a terminal picks it, taps pick
more, and moving the held finger carries what is picked to where it lifts. A group has no ⋯, so letting
go of a held group still opens its menu. The pin that keeps the sidebar open through choosing a
terminal is back as well.
"""

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from tests.test_terminal_cycle_order import method_source

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"

HOLD_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_HOLD_SCENARIO);
const MOBILE_SIDEBAR_CONTEXT_LONG_PRESS_MS = 500;
const MOBILE_SIDEBAR_CONTEXT_MOVE_TOLERANCE = 12;
let timer = null;
global.window = {
  setTimeout: (fn) => { timer = fn; return 1; },
  clearTimeout: () => { timer = null; },
};
const listeners = new Map();
const classes = new Set();
const element = {
  draggable: true,
  classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
  addEventListener: (type, handler) => listeners.set(type, handler),
};
const log = { menus: [], picked: [], drags: [], moves: [], finished: [] };
const app = {
  mobileSidebarDrag: null,
  touchMobileLayoutEnabled: () => true,
  session: (id) => ({ session_id: id }),
  setInteractionWorktreeFromElement() {},
  addMobileSidebarSelection(id) { log.picked.push(id); },
  startMobileSidebarDrag(source, x, y) { log.drags.push([x, y]); this.mobileSidebarDrag = {}; return true; },
  moveMobileSidebarDrag(x, y) { log.moves.push([x, y]); },
  finishMobileSidebarDrag(drop) {
    if (this.mobileSidebarDrag) log.finished.push(drop);
    this.mobileSidebarDrag = null;
  },
  __METHODS__
};
app.installMobileSidebarHold(element, scenario.group
  ? { openMenuAt: (x, y) => log.menus.push([x, y]) } : { sessionId: "s1" });

const prevented = [];
const stopped = [];
const draggableWhileDown = [];
const target = { closest: (selector) => (scenario.onButton && selector === "button" ? {} : null) };
for (const step of scenario.steps) {
  if (step === "hold") {
    const fire = timer;
    timer = null;
    fire?.();
    continue;
  }
  const [type, x = 20, y = 10] = step;
  const touch = { identifier: 7, clientX: x, clientY: y };
  const lifted = type === "touchend" || type === "touchcancel";
  listeners.get(type)?.({
    type, target, touches: lifted ? [] : [touch], changedTouches: [touch],
    preventDefault: () => prevented.push(type), stopImmediatePropagation: () => stopped.push(type),
  });
  if (type === "touchstart") draggableWhileDown.push(element.draggable);
}
process.stdout.write(JSON.stringify({ ...log, prevented, stopped, draggableWhileDown, draggable: element.draggable }));
"""

SELECTION_HARNESS = """
const steps = JSON.parse(process.env.TERMDECK_SELECTION_STEPS);
const bodyClasses = new Set();
global.document = { body: { classList: { toggle: (name, on) => (on ? bodyClasses.add(name) : bodyClasses.delete(name)) } } };
const count = { textContent: "" };
const app = {
  mobileSidebarSelecting: false,
  sidebarSelectedSessionIds: new Set(["open"]),
  sidebarSelectedFileKeys: new Set(),
  sidebarSelectionAnchorId: "open",
  activeId: "open",
  activeFileKey: null,
  $: (id) => (id === "mobile-sidebar-selection-count" ? count : null),
  applySidebarFileSelectionStyles() {},
  applySidebarSelectionStyles() {},
  __METHODS__
};
const seen = [];
for (const [action, id] of steps) {
  if (action === "hold") app.addMobileSidebarSelection(id);
  else if (action === "tap") app.toggleMobileSidebarSelection(id);
  else app.endMobileSidebarSelection();
  seen.push({ picking: app.mobileSidebarSelecting, selected: [...app.sidebarSelectedSessionIds].sort(),
    bar: bodyClasses.has("mobile-sidebar-selecting"), count: count.textContent });
}
process.stdout.write(JSON.stringify(seen));
"""

PIN_HARNESS = """
const pinned = JSON.parse(process.env.TERMDECK_PINNED);
const folds = [];
const app = {
  mobileSidebarPinned: pinned,
  touchMobileLayoutEnabled: () => true,
  setMobileSidebarCollapsed(collapsed) { folds.push(collapsed); },
  __METHODS__
};
app.collapseMobileSidebarAfterSelection();
process.stdout.write(JSON.stringify(folds));
"""


def node_or_skip() -> str:
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("node is not installed")
    return node


def run(node: str, harness: str, env: dict[str, str]):
    done = subprocess.run([node, "-e", harness], capture_output=True, text=True, check=False,
                          env={**os.environ, **env})
    if done.returncode != 0:
        raise AssertionError(done.stderr)
    return json.loads(done.stdout)


class TerminalRowHoldTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = node_or_skip()
        source = (STATIC / "app_search_git.js").read_text()
        cls.harness = HOLD_HARNESS.replace("__METHODS__", method_source(source, "installMobileSidebarHold(element, { sessionId = null, openMenuAt = null } = {})"))

    def gesture(self, steps: list, group: bool = False, on_button: bool = False) -> dict:
        scenario = {"steps": steps, "group": group, "onButton": on_button}
        return run(self.node, self.harness, {"TERMDECK_HOLD_SCENARIO": json.dumps(scenario)})

    def test_a_hold_picks_the_terminal_and_opens_no_menu(self) -> None:
        result = self.gesture([["touchstart"], "hold", ["touchend"]])

        self.assertEqual(result["picked"], ["s1"])
        self.assertEqual(result["menus"], [])
        self.assertEqual(result["drags"], [])
        self.assertIn("touchend", result["prevented"])

    def test_a_tap_is_left_to_the_row(self) -> None:
        result = self.gesture([["touchstart"], ["touchend"], ["click"]])

        self.assertEqual(result["picked"], [])
        self.assertEqual(result["prevented"], [])
        self.assertEqual(result["stopped"], [])

    def test_the_click_after_a_hold_is_swallowed(self) -> None:
        result = self.gesture([["touchstart"], "hold", ["touchend"], ["click"]])

        self.assertIn("click", result["stopped"])

    def test_a_swipe_before_the_hold_scrolls_the_list(self) -> None:
        result = self.gesture([["touchstart"], ["touchmove", 20, 40], "hold", ["touchend", 20, 40]])

        self.assertEqual(result["picked"], [])
        self.assertNotIn("touchmove", result["prevented"])

    def test_moving_after_the_hold_carries_the_rows_and_does_not_scroll(self) -> None:
        result = self.gesture([["touchstart"], "hold", ["touchmove", 20, 40], ["touchmove", 20, 80], ["touchend", 20, 80]])

        self.assertEqual(result["drags"], [[20, 40]])
        self.assertEqual(result["moves"], [[20, 80]])
        self.assertEqual(result["finished"], [True])
        self.assertEqual(result["prevented"].count("touchmove"), 2)

    def test_a_wobble_after_the_hold_is_not_a_drag_but_does_not_scroll(self) -> None:
        result = self.gesture([["touchstart"], "hold", ["touchmove", 24, 12], ["touchend", 24, 12]])

        self.assertEqual(result["drags"], [])
        self.assertIn("touchmove", result["prevented"])
        self.assertEqual(result["picked"], ["s1"])

    def test_a_cancelled_touch_drops_nothing(self) -> None:
        result = self.gesture([["touchstart"], "hold", ["touchmove", 20, 60], ["touchcancel"]])

        self.assertEqual(result["finished"], [False])

    def test_the_browser_cannot_start_its_own_drag_under_the_finger(self) -> None:
        result = self.gesture([["touchstart"], "hold", ["touchend"]])

        self.assertEqual(result["draggableWhileDown"], [False])
        self.assertTrue(result["draggable"])

    def test_the_phones_own_long_press_is_answered_by_the_hold(self) -> None:
        # Its menu and word selection are not what a hold on a row means here.
        result = self.gesture([["touchstart"], ["contextmenu"], ["touchend"]])

        self.assertEqual(result["picked"], ["s1"])
        self.assertIn("contextmenu", result["prevented"])
        self.assertIn("contextmenu", result["stopped"])

    def test_a_right_click_is_left_alone(self) -> None:
        result = self.gesture([["contextmenu"]])

        self.assertEqual(result["prevented"], [])
        self.assertEqual(result["picked"], [])

    def test_a_finger_on_the_rows_buttons_is_theirs(self) -> None:
        result = self.gesture([["touchstart"], "hold", ["touchend"]], on_button=True)

        self.assertEqual(result["picked"], [])
        self.assertEqual(result["prevented"], [])

    def test_letting_go_of_a_held_group_opens_its_menu(self) -> None:
        result = self.gesture([["touchstart", 30, 15], "hold", ["touchend", 30, 15]], group=True)

        self.assertEqual(result["menus"], [[30, 15]])
        self.assertEqual(result["picked"], [])

    def test_moving_a_held_group_carries_it_and_opens_no_menu(self) -> None:
        result = self.gesture([["touchstart"], "hold", ["touchmove", 20, 50], ["touchend", 20, 50]], group=True)

        self.assertEqual(result["drags"], [[20, 50]])
        self.assertEqual(result["menus"], [])
        self.assertEqual(result["finished"], [True])


class PickingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = node_or_skip()
        source = (STATIC / "app.js").read_text()
        methods = ["addMobileSidebarSelection(sessionId)", "toggleMobileSidebarSelection(sessionId)",
                   "endMobileSidebarSelection()", "syncMobileSidebarSelection()"]
        cls.harness = SELECTION_HARNESS.replace("__METHODS__", "\n  ".join(method_source(source, m) for m in methods))

    def steps(self, steps: list) -> list:
        return run(self.node, self.harness, {"TERMDECK_SELECTION_STEPS": json.dumps(steps)})

    def test_the_first_hold_starts_from_just_that_terminal(self) -> None:
        # Not added to the open terminal, which is "selected" only by being open.
        seen = self.steps([["hold", "a"]])

        self.assertEqual(seen[-1], {"picking": True, "selected": ["a"], "bar": True, "count": "1 selected"})

    def test_taps_add_and_drop_while_picking(self) -> None:
        seen = self.steps([["hold", "a"], ["tap", "b"], ["tap", "c"], ["tap", "b"]])

        self.assertEqual(seen[-1]["selected"], ["a", "c"])
        self.assertEqual(seen[-1]["count"], "2 selected")

    def test_dropping_the_last_one_ends_picking(self) -> None:
        seen = self.steps([["hold", "a"], ["tap", "a"]])

        self.assertEqual(seen[-1], {"picking": False, "selected": ["open"], "bar": False, "count": "1 selected"})

    def test_done_goes_back_to_the_open_terminal(self) -> None:
        seen = self.steps([["hold", "a"], ["tap", "b"], ["done", None]])

        self.assertFalse(seen[-1]["picking"])
        self.assertEqual(seen[-1]["selected"], ["open"])
        self.assertFalse(seen[-1]["bar"])


class SidebarPinTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = node_or_skip()
        source = (STATIC / "app.js").read_text()
        cls.harness = PIN_HARNESS.replace("__METHODS__", method_source(source, "collapseMobileSidebarAfterSelection()"))

    def folds(self, pinned: bool) -> list:
        return run(self.node, self.harness, {"TERMDECK_PINNED": json.dumps(pinned)})

    def test_choosing_a_terminal_folds_an_unpinned_sidebar(self) -> None:
        self.assertEqual(self.folds(False), [True])

    def test_a_pinned_sidebar_stays_open(self) -> None:
        self.assertEqual(self.folds(True), [])

    def test_the_pin_and_its_collapse_button_are_in_the_page(self) -> None:
        page = (STATIC / "index.html").read_text()

        for element_id in ("mobile-sidebar-pin", "mobile-sidebar-collapse", "mobile-sidebar-selection-done"):
            self.assertIn(f'id="{element_id}"', page)


if __name__ == "__main__":
    unittest.main()
