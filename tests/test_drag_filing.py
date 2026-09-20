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
import re
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


PLACEMENT_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_PLACEMENT_SCENARIO);
const calls = [];
const app = {
  sessions: scenario.sessions,
  session(id) { return this.sessions.find((s) => s.session_id === id) || null; },
  setSpawnedParent(ids, parentId) { calls.push({ filed: ids, under: parentId }); return Promise.resolve(); },
  repositionSelectedSessions(ids, anchorId, after) { calls.push({ moved: ids, after: anchorId, below: after }); },
  __METHODS__
};
app.placeCreatedSessionByAnchor(scenario.createdId, scenario.anchorId)
  .then(() => process.stdout.write(JSON.stringify({ calls })));
"""


class NewTerminalPlacementTest(unittest.TestCase):
    """Where a terminal created from another one goes.

    A terminal filed under another is not drawn from the layout -- its row lives in the stack under its
    parent -- so moving the new one after it in the layout put it wherever that position fell on screen,
    past the whole stack. Asking a spawned agent for another one dropped the new terminal below the agent
    that spawned IT.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_settings_ui.js").read_text()
        cls.harness = PLACEMENT_HARNESS.replace(
            "__METHODS__", method_source(source, "async placeCreatedSessionByAnchor(createdSessionId, anchorSessionId)"))

    def place(self, anchor_id, created_id="fresh"):
        sessions = SESSIONS + [{"session_id": "fresh", "title": "new one", "spawned_by_session_id": None}]
        scenario = {"sessions": sessions, "anchorId": anchor_id, "createdId": created_id}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_PLACEMENT_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)["calls"]

    def test_one_asked_from_a_filed_terminal_is_filed_under_it(self) -> None:
        self.assertEqual(self.place("child"), [{"filed": ["fresh"], "under": "child"}])

    def test_one_asked_from_a_terminal_in_the_list_still_lands_below_it(self) -> None:
        # "New terminal after this" says after, and at the top level after is a place the layout has.
        self.assertEqual(self.place("loner"), [{"moved": ["fresh"], "after": "loner", "below": True}])

    def test_it_nests_under_a_terminal_that_is_itself_nested(self) -> None:
        self.assertEqual(self.place("grandchild"), [{"filed": ["fresh"], "under": "grandchild"}])

    def test_an_anchor_that_is_gone_places_nothing(self) -> None:
        self.assertEqual(self.place("closed-since"), [])

    def test_a_terminal_that_never_arrived_places_nothing(self) -> None:
        self.assertEqual(self.place("child", created_id="never-created"), [])


if __name__ == "__main__":
    unittest.main()


REVEAL_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_REVEAL_SCENARIO);
const stored = [];
global.localStorage = { setItem: (key, value) => stored.push(JSON.parse(value)) };
const EXPANDED_AGENT_STACKS_KEY = "termdeck.expanded_agent_stacks";
const app = {
  sessions: scenario.sessions,
  expandedAgentStacks: new Set(scenario.expanded),
  session(id) { return this.sessions.find((s) => s.session_id === id) || null; },
  __METHODS__
};
const opened = app.openAgentStacksAbove(scenario.sessionId);
process.stdout.write(JSON.stringify({ opened, expanded: [...app.expandedAgentStacks], stored }));
"""


class RevealOpensTheStacksAboveTest(unittest.TestCase):
    """A terminal filed under another has no row at all while that stack is shut.

    Revealing the active terminal in the sidebar looked for its row and gave up quietly when there was
    none, so opening a spawned agent -- by its link, by a shortcut, by anything that selects it -- left
    the sidebar showing no sign of the terminal the deck had just switched to.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_search_git.js").read_text()
        cls.harness = REVEAL_HARNESS.replace("__METHODS__", "\n  ".join(
            method_source(source, name) for name in
            ("persistExpandedAgentStacks()", "openAgentStacksAbove(sessionId)")))

    def reveal(self, session_id, expanded=()):
        scenario = {"sessions": SESSIONS, "sessionId": session_id, "expanded": list(expanded)}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_REVEAL_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_the_stack_holding_it_is_opened(self) -> None:
        result = self.reveal("child")

        self.assertIs(result["opened"], True)
        self.assertEqual(result["expanded"], ["parent"])

    def test_every_stack_above_a_nested_one_is_opened(self) -> None:
        # Opening only the terminal's own parent leaves that parent with no row either.
        result = self.reveal("grandchild")

        self.assertEqual(sorted(result["expanded"]), ["child", "parent"])

    def test_a_terminal_in_the_list_opens_nothing(self) -> None:
        result = self.reveal("loner")

        self.assertIs(result["opened"], False)
        self.assertEqual(result["stored"], [])

    def test_stacks_already_open_are_left_alone(self) -> None:
        # Nothing to do, and nothing to write: this runs on every reveal.
        result = self.reveal("child", expanded=["parent"])

        self.assertIs(result["opened"], False)
        self.assertEqual(result["stored"], [])

    def test_what_was_opened_is_remembered(self) -> None:
        self.assertEqual(self.reveal("child")["stored"], [["parent"]])

    def test_parentage_that_loops_does_not_hang_the_walk(self) -> None:
        # Editable by hand and reloaded from disk, so a loop can already be there.
        scenario = {"sessions": [{"session_id": "a", "title": "a", "spawned_by_session_id": "b"},
                                 {"session_id": "b", "title": "b", "spawned_by_session_id": "a"}],
                    "sessionId": "a", "expanded": []}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              timeout=10,
                              env={**os.environ, "TERMDECK_REVEAL_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        # It walks up once and stops on the terminal it started from, rather than going round for good.
        self.assertEqual(json.loads(done.stdout)["expanded"], ["b"])


PLACEMENT_CHOICE_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_PLACEMENT_CHOICE_SCENARIO);
const app = {
  activeId: scenario.activeId,
  modalAfterSessionId: scenario.afterSessionId,
  modalGroupId: scenario.groupId,
  modalTopLevel: scenario.topLevel,
  sessions: scenario.sessions,
  session(id) { return this.sessions.find((s) => s.session_id === id) || null; },
};
// The one expression out of createSessionFromModal that decides where a new terminal lands. It reads
// `this`, so it runs against the app rather than at the top level.
const targetGroupId = app.modalGroupId;
const requestedAfterSessionId = app.modalAfterSessionId;
const topLevel = app.modalTopLevel === true;
const anchorSessionId = (function () {
__ANCHOR__
  return anchorSessionId;
}).call(app);
process.stdout.write(JSON.stringify({ anchorSessionId, targetGroupId }));
"""


class NewTerminalAnchorTest(unittest.TestCase):
    """What the new-terminal dialog does with the terminal that happens to be selected.

    Opened from a group's own + or from a row's "New terminal after this", the dialog has been told
    where to put it. Opened from the + at the top of the list, it has not -- and it used to fall back to
    the selected terminal anyway, so a terminal asked for at the top landed in whatever group that one
    was in, or filed under the agent that spawned it.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_settings_ui.js").read_text()
        anchor = re.search(r"    const anchorSessionId = topLevel \? null\n(?:.*\n){2}", source)
        assert anchor, "the placement expression was not found"
        cls.harness = PLACEMENT_CHOICE_HARNESS.replace("__ANCHOR__", anchor.group(0))

    def anchor_for(self, top_level=False, after=None, group=None, active="child"):
        scenario = {"sessions": SESSIONS, "activeId": active, "afterSessionId": after,
                    "groupId": group, "topLevel": top_level}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_PLACEMENT_CHOICE_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_the_plus_at_the_top_anchors_to_nothing(self) -> None:
        result = self.anchor_for(top_level=True)

        self.assertIsNone(result["anchorSessionId"])
        self.assertIsNone(result["targetGroupId"])

    def test_it_ignores_the_selected_terminal_even_when_there_is_one(self) -> None:
        self.assertIsNone(self.anchor_for(top_level=True, active="loner")["anchorSessionId"])

    def test_new_terminal_after_this_still_lands_after_that_one(self) -> None:
        self.assertEqual(self.anchor_for(after="loner")["anchorSessionId"], "loner")

    def test_without_being_told_it_still_follows_the_selection(self) -> None:
        # The dialog opened from elsewhere with no instruction keeps landing beside what is in focus.
        self.assertEqual(self.anchor_for()["anchorSessionId"], "child")

    def test_a_group_takes_precedence_over_the_selection(self) -> None:
        self.assertIsNone(self.anchor_for(group="group-1")["anchorSessionId"])
