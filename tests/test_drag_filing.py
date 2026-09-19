"""Filing one terminal under another by holding the drag over the middle of its row.

The middle of a row already meant "hold here to group these two". Holding on past that offer now files
the dragged terminal under the one being hovered instead -- the same stack a spawned agent lands in.
Two stages on one spot rather than two places to aim at, so the second is found by anyone who holds a
moment too long on the first.

The client has no JS harness; as in test_terminal_cycle_order, the methods are lifted out of the shipped
source and run under node against stubs, with the drag's timers driven by hand.
"""

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from tests.test_terminal_cycle_order import method_source

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"
METHODS = ("canFileUnderSession(targetId, sourceSessionIds)", "fileUnderLabel(targetId)",
           "holdOverSessionRow(item, token, targetId, sourceToken, groupStageApplies)")

HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_DRAG_SCENARIO);
const SESSION_GROUP_HOVER_DELAY_MS = 700;
const SESSION_PARENT_HOVER_DELAY_MS = 1500;
const timers = [];
global.window = { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
                  clearTimeout: () => {} };
const landings = [];
const app = {
  sessions: scenario.sessions,
  dragItem: { type: "layout", token: scenario.sourceToken },
  session(id) { return this.sessions.find((s) => s.session_id === id) || null; },
  titlePresentation(session) { return { text: session.title }; },
  setDragLandingMode(item, mode, label) { landings.push({ mode, label }); },
  clearDragLandingIndicator() {},
  __METHODS__
};

const result = { canFile: app.canFileUnderSession(scenario.targetId, scenario.sourceSessionIds) };
if (scenario.hold) {
  app.holdOverSessionRow({}, scenario.token, scenario.targetId, scenario.sourceToken, scenario.groupStage);
  result.offered = landings.map((entry) => entry.label);
  result.delays = timers.map((timer) => timer.ms);
  // Every timer the hold set, in the order it set them: the drag stays still, so they all come due.
  for (const timer of timers) timer.fn();
  result.afterHolding = landings.map((entry) => entry.label);
  result.parentTarget = app.dragParentTargetKey || null;
  result.groupTarget = app.dragGroupTargetKey || null;
}
process.stdout.write(JSON.stringify(result));
"""

SESSIONS = [
    {"session_id": "parent", "title": "audit-wrapper", "spawned_by_session_id": None},
    {"session_id": "child", "title": "cl-news", "spawned_by_session_id": "parent"},
    {"session_id": "grandchild", "title": "cl-news-sub", "spawned_by_session_id": "child"},
    {"session_id": "loner", "title": "trade-live", "spawned_by_session_id": None},
]


class DragFilingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__",
                                      "\n  ".join(method_source(source, name) for name in METHODS))

    def run_scenario(self, target_id, source_ids, hold=False, group_stage=True):
        scenario = {"sessions": SESSIONS, "targetId": target_id, "sourceSessionIds": source_ids,
                    "token": f"session:{target_id}", "sourceToken": f"session:{source_ids[0]}",
                    "hold": hold, "groupStage": group_stage}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_DRAG_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_an_unrelated_terminal_can_be_filed_under_another(self) -> None:
        self.assertIs(self.run_scenario("parent", ["loner"])["canFile"], True)

    def test_a_terminal_cannot_be_filed_under_itself(self) -> None:
        self.assertIs(self.run_scenario("loner", ["loner"])["canFile"], False)

    def test_filing_it_where_it_already_is_offers_nothing(self) -> None:
        # Holding over the parent a terminal is already filed under should read as a plain move.
        self.assertIs(self.run_scenario("parent", ["child"])["canFile"], False)

    def test_a_terminal_cannot_be_filed_under_its_own_child(self) -> None:
        # A loop: the sidebar would draw a stack that contains itself.
        self.assertIs(self.run_scenario("child", ["parent"])["canFile"], False)

    def test_nor_under_a_child_further_down(self) -> None:
        self.assertIs(self.run_scenario("grandchild", ["parent"])["canFile"], False)

    def test_a_group_of_terminals_qualifies_if_any_of_them_moves(self) -> None:
        self.assertIs(self.run_scenario("parent", ["child", "loner"])["canFile"], True)

    def test_the_first_hold_still_offers_the_group(self) -> None:
        result = self.run_scenario("parent", ["loner"], hold=True)

        self.assertEqual(result["offered"][0], "hold to create group")
        self.assertIn("create group", result["afterHolding"])

    def test_holding_on_offers_to_file_it_under_that_terminal(self) -> None:
        result = self.run_scenario("parent", ["loner"], hold=True)

        self.assertEqual(result["afterHolding"][-1], "file under audit-wrapper")
        self.assertEqual(result["parentTarget"], "session:parent")

    def test_the_group_offer_is_withdrawn_when_the_second_stage_lands(self) -> None:
        # Both cannot be pending at the drop: the row would have to mean two things at once.
        result = self.run_scenario("parent", ["loner"], hold=True)

        self.assertIsNone(result["groupTarget"])

    def test_filing_is_offered_first_where_grouping_does_not_apply(self) -> None:
        # Either side already in a group: there is no group to make, so the middle offers only this, and
        # waiting out a stage that leads nowhere would be a dead second.
        result = self.run_scenario("parent", ["loner"], hold=True, group_stage=False)

        self.assertEqual(result["offered"][0], "hold to file under audit-wrapper")
        self.assertEqual(result["delays"], [700])

    def test_the_second_stage_waits_longer_than_the_first(self) -> None:
        # Otherwise the group offer could never be taken.
        self.assertEqual(self.run_scenario("parent", ["loner"], hold=True)["delays"], [700, 1500])


if __name__ == "__main__":
    unittest.main()
