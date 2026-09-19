"""Next/previous terminal steps through the sidebar in the order the sidebar is drawn in.

The client has no JS test harness, so this one runs the shipped source: the three methods are lifted
out of app_misc_ui.js verbatim and spliced into an object literal under node, against a stub sidebar.
That keeps the test honest -- it fails if the real methods change behaviour -- without pulling in the
whole client, which needs a browser to load at all.
"""

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"
METHODS = ("cycleTerminal(delta)", "cycleTerminalOrder()", "cycleTerminalAnchorId(ids)")

HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_CYCLE_SCENARIO);

// A stand-in for the sidebar that answers the selector rather than ignoring it: a row is returned only
// when it carries every class the selector asks for and, where the selector asks for it, a session id.
// Querying for something broader than the terminal rows would pull in the closed-terminal rows below
// them, which are not terminals anyone can cycle to.
function matches(row, selector) {
  const classes = selector.match(/\\.[a-z-]+/g) || [];
  if (!classes.every((cls) => row.cls === cls.slice(1))) return false;
  return !selector.includes("[data-session-id]") || Boolean(row.sessionId);
}

const list = {
  querySelectorAll(selector) {
    return scenario.rows.filter((row) => matches(row, selector))
      .map((row) => ({ dataset: { sessionId: row.sessionId } }));
  },
};

const app = {
  sessions: scenario.sessions,
  activeId: scenario.activeId,
  activated: null,
  $(id) { return id === "session-list" ? list : null; },
  session(id) { return this.sessions.find((s) => s.session_id === id) || null; },
  activate(id) { this.activated = id; },
  __METHODS__
};

app.cycleTerminal(scenario.delta);
process.stdout.write(JSON.stringify({ activated: app.activated }));
"""


def method_source(source: str, signature: str) -> str:
    start = source.index(f"\n  {signature} {{")
    depth = 0
    for index in range(start, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1].strip() + ","
    raise AssertionError(f"unbalanced braces reading {signature}")


class TerminalCycleOrderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_misc_ui.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__",
                                      "\n  ".join(method_source(source, name) for name in METHODS))

    def cycle(self, rows, sessions, active_id, delta=1):
        """rows: (class, session id) as the sidebar draws them. sessions: (id, parent id)."""
        scenario = {
            "rows": [{"cls": cls, "sessionId": session_id} for cls, session_id in rows],
            "sessions": [{"session_id": sid, "spawned_by_session_id": parent} for sid, parent in sessions],
            "activeId": active_id,
            "delta": delta,
        }
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_CYCLE_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)["activated"]

    def test_the_next_terminal_after_a_parent_is_its_first_open_child(self) -> None:
        # The whole point: a spawned agent is drawn under the agent that spawned it, but sits somewhere
        # else entirely in the session list. Cycling by the session list walked straight past the
        # children on screen to whatever the list had next.
        landed = self.cycle(
            rows=[("session-item", "parent"), ("session-item", "kid-a"), ("session-item", "kid-b"),
                  ("session-item", "other")],
            sessions=[("parent", ""), ("other", ""), ("kid-a", "parent"), ("kid-b", "parent")],
            active_id="parent")

        self.assertEqual(landed, "kid-a")

    def test_the_last_child_leads_on_to_the_row_under_the_stack(self) -> None:
        landed = self.cycle(
            rows=[("session-item", "parent"), ("session-item", "kid-a"), ("session-item", "kid-b"),
                  ("session-item", "other")],
            sessions=[("parent", ""), ("other", ""), ("kid-a", "parent"), ("kid-b", "parent")],
            active_id="kid-b")

        self.assertEqual(landed, "other")

    def test_a_collapsed_stack_is_stepped_over(self) -> None:
        # A collapsed stack draws no child rows at all, so cycling into one would select a terminal that
        # is not on screen.
        landed = self.cycle(
            rows=[("session-item", "parent"), ("session-item", "other")],
            sessions=[("parent", ""), ("other", ""), ("kid-a", "parent"), ("kid-b", "parent")],
            active_id="parent")

        self.assertEqual(landed, "other")

    def test_stepping_off_a_child_hidden_in_a_collapsed_stack_starts_from_its_parent(self) -> None:
        # The child can be active while its stack is shut -- collapsing does not deselect it. The parent
        # row is what is on screen in its place, so the step goes from there rather than to the top.
        landed = self.cycle(
            rows=[("session-item", "first"), ("session-item", "parent"), ("session-item", "other")],
            sessions=[("first", ""), ("parent", ""), ("other", ""), ("kid-a", "parent")],
            active_id="kid-a")

        self.assertEqual(landed, "other")

    def test_previous_walks_the_same_order_backwards(self) -> None:
        landed = self.cycle(
            rows=[("session-item", "parent"), ("session-item", "kid-a"), ("session-item", "other")],
            sessions=[("parent", ""), ("other", ""), ("kid-a", "parent")],
            active_id="other", delta=-1)

        self.assertEqual(landed, "kid-a")

    def test_it_wraps_at_the_end(self) -> None:
        landed = self.cycle(
            rows=[("session-item", "parent"), ("session-item", "kid-a")],
            sessions=[("parent", ""), ("kid-a", "parent")],
            active_id="kid-a")

        self.assertEqual(landed, "parent")

    def test_closed_terminal_rows_are_not_cycled_into(self) -> None:
        # The closed-terminals section is drawn in the same list. Those are not running terminals and
        # activating one is not what the shortcut means.
        landed = self.cycle(
            rows=[("session-item", "parent"), ("closed-item", "gone"), ("session-item", "other")],
            sessions=[("parent", ""), ("other", "")],
            active_id="parent")

        self.assertEqual(landed, "other")

    def test_a_row_for_a_terminal_the_client_no_longer_has_is_ignored(self) -> None:
        # The sidebar is rebuilt from the session list, but a status message can land between the two.
        landed = self.cycle(
            rows=[("session-item", "parent"), ("session-item", "stale"), ("session-item", "other")],
            sessions=[("parent", ""), ("other", "")],
            active_id="parent")

        self.assertEqual(landed, "other")

    def test_with_nothing_rendered_it_falls_back_to_the_session_list(self) -> None:
        # The shortcut works with the sidebar hidden, and before the first render there are no rows to
        # read an order off.
        landed = self.cycle(
            rows=[],
            sessions=[("parent", ""), ("other", "")],
            active_id="parent")

        self.assertEqual(landed, "other")


if __name__ == "__main__":
    unittest.main()
