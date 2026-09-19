"""An unread badge on the terminal the user is looking at has to clear.

Unread is project state, so the badge arrives from elsewhere as well as from this window: another
window, a phone, or this window's own marking from while it was in the background. The terminal it names
can be the one already selected -- and nothing cleared that. Selecting a terminal is what clears its
badge, and the terminal was already selected, so clicking it did nothing.

The client has no JS harness; as in test_terminal_cycle_order, the methods are lifted out of the shipped
source and run under node against stubs.
"""

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from tests.test_terminal_cycle_order import method_source

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"
METHODS = ("clearUnreadForSelection(previousId, id)", "refreshUnreadSessionsFromState()",
           "markActiveSessionRead()", "unreadSessionIdsForCurrentWorktreeView()")

HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_UNREAD_SCENARIO);
const ALL_WORKTREES_ID = "all";
// The page's own read state, which decides whether a finished turn counts as watched.
global.document = { hidden: scenario.hidden === true, hasFocus: () => scenario.focused !== false };

const app = {
  projectSlug: "stock",
  worktreeId: "root",
  activeId: scenario.activeId,
  unreadSessions: new Set(scenario.unread),
  processingStates: new Map(),
  viewedCompletedSessions: new Set(),
  persisted: [],
  settings: { project_state: { stock: { unread_sessions: scenario.stateUnread } } },

  session(id) { return scenario.sessions.includes(id) ? { session_id: id } : null; },
  getProjectState() { return this.settings.project_state.stock; },
  updateUnreadIndicator() {},
  persistUnreadSessionDelta(ids, unread) { this.persisted.push({ ids, unread }); },
  __METHODS__
};

if (scenario.call === "select") app.clearUnreadForSelection(scenario.previousId, scenario.id);
else app.refreshUnreadSessionsFromState();
process.stdout.write(JSON.stringify({ unread: [...app.unreadSessions], persisted: app.persisted }));
"""


class UnreadClearingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = "\n".join((STATIC / name).read_text() for name in ("app.js", "app_markdown_files.js"))
        cls.harness = HARNESS.replace("__METHODS__",
                                      "\n  ".join(method_source(source, name) for name in METHODS))

    def run_scenario(self, **scenario):
        scenario.setdefault("sessions", ["a", "b"])
        scenario.setdefault("unread", [])
        scenario.setdefault("stateUnread", [])
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_UNREAD_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def select(self, **scenario):
        return self.run_scenario(call="select", **scenario)

    def refresh(self, **scenario):
        return self.run_scenario(call="refresh", **scenario)

    def test_selecting_the_terminal_already_selected_clears_its_badge(self) -> None:
        # The report: the badge landed on the active terminal and clicking its row did nothing.
        result = self.select(activeId="a", previousId="a", id="a", unread=["a"])

        self.assertEqual(result["unread"], [])
        self.assertEqual(result["persisted"], [{"ids": ["a"], "unread": False}])

    def test_switching_terminals_clears_both(self) -> None:
        result = self.select(activeId="a", previousId="a", id="b", unread=["a", "b"])

        self.assertEqual(result["unread"], [])
        self.assertEqual(result["persisted"], [{"ids": ["a", "b"], "unread": False}])

    def test_selecting_a_terminal_with_no_badge_writes_nothing(self) -> None:
        # Every selection would otherwise queue a project-state write.
        result = self.select(activeId="a", previousId="a", id="a", unread=[])

        self.assertEqual(result["persisted"], [])

    def test_a_badge_arriving_for_the_terminal_on_screen_is_cleared(self) -> None:
        # The badge is in project state -- written by another window, a phone, or this window while it
        # was in the background -- and names the terminal this window is showing.
        result = self.refresh(activeId="a", stateUnread=["a", "b"])

        self.assertEqual(result["unread"], ["b"])
        self.assertEqual(result["persisted"], [{"ids": ["a"], "unread": False}])

    def test_a_badge_for_another_terminal_survives(self) -> None:
        result = self.refresh(activeId="a", stateUnread=["b"])

        self.assertEqual(result["unread"], ["b"])
        self.assertEqual(result["persisted"], [])

    def test_a_window_in_the_background_keeps_the_badge(self) -> None:
        # This is the whole point of the badge: nobody is reading that window, so the finished turn has
        # not been seen and the badge has to still be there when they come back.
        result = self.refresh(activeId="a", stateUnread=["a"], hidden=True)

        self.assertEqual(result["unread"], ["a"])
        self.assertEqual(result["persisted"], [])

    def test_a_window_behind_another_app_keeps_the_badge(self) -> None:
        # Visible but not focused: on screen, and not being read.
        result = self.refresh(activeId="a", stateUnread=["a"], focused=False)

        self.assertEqual(result["unread"], ["a"])
        self.assertEqual(result["persisted"], [])

    def test_a_badge_for_a_terminal_that_is_gone_is_left_to_the_stale_sweep(self) -> None:
        result = self.refresh(activeId="closed-one", stateUnread=["closed-one"])

        self.assertEqual(result["unread"], ["closed-one"])
        self.assertEqual(result["persisted"], [])


if __name__ == "__main__":
    unittest.main()
