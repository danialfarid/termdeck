"""Making a group out of what is selected, when some of it is drawn inside something else.

A spawned agent is drawn under the agent that spawned it, wherever it is filed. Grouping one whose
parent stayed behind put it in the group by every record and left it on screen exactly where it was --
the group looked as though it had taken one terminal of the several that were selected. And a group
made from such a row landed at the end of the list, because that row's own token is nowhere in the
layout to land beside.
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
const scenario = JSON.parse(process.env.TERMDECK_SELECTION_SCENARIO);
const released = [];
const app = {
  session: (id) => scenario.sessions[id] || null,
  getProjectState: () => ({ session_groups: scenario.groups || {} }),
  setSpawnedParent: async (ids, parent) => { released.push({ ids, parent }); },
  __METHODS__
};
const answer = scenario.call === "anchor"
  ? app.layoutAnchorTokenFor(scenario.anchor)
  : await app.releaseSpawnedFromStacks(scenario.selected).then(() => released);
process.stdout.write(JSON.stringify(answer ?? null));
"""


def sessions(**parents: str) -> dict[str, dict[str, str]]:
    return {session_id: {"session_id": session_id, "spawned_by_session_id": parent}
            for session_id, parent in parents.items()}


class HarnessTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__", "\n  ".join(
            method_source(source, name) for name in
            ("layoutAnchorTokenFor(sessionId)", "async releaseSpawnedFromStacks(sessionIds)")))

    def run_scenario(self, **scenario: object) -> object:
        done = subprocess.run([self.node, "--input-type=module", "-e", self.harness],
                              capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_SELECTION_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)


class LayoutAnchorTest(HarnessTest):
    """Where a row is drawn, which is what the new group should appear beside."""

    def anchor(self, anchor: str, groups: dict | None = None, **parents: str) -> str:
        return self.run_scenario(call="anchor", anchor=anchor, groups=groups or {}, sessions=sessions(**parents))

    def test_a_row_of_its_own(self) -> None:
        self.assertEqual(self.anchor("one", one=""), "session:one")

    def test_a_row_in_a_group(self) -> None:
        self.assertEqual(self.anchor("one", {"one": "group-a"}, one=""), "group:group-a")

    def test_a_spawned_agent_is_drawn_inside_the_agent_that_spawned_it(self) -> None:
        # Its own token is nowhere in the layout, so a group made from it landed at the end.
        self.assertEqual(self.anchor("child", {}, parent="", child="parent"), "session:parent")

    def test_a_spawned_agent_whose_parent_is_in_a_group(self) -> None:
        self.assertEqual(self.anchor("child", {"parent": "group-a"}, parent="", child="parent"),
                         "group:group-a")

    def test_an_agent_several_deep(self) -> None:
        self.assertEqual(self.anchor("grandchild", {"parent": "group-a"},
                                     parent="", child="parent", grandchild="child"), "group:group-a")

    def test_parentage_that_loops_does_not_spin(self) -> None:
        # Parentage is editable by hand and reloaded from disk, so a loop can already be there.
        self.assertEqual(self.anchor("one", {}, one="two", two="one"), "session:one")


class ReleaseFromStacksTest(HarnessTest):
    """Filing an agent somewhere its parent is not is what stops it being that agent's child."""

    def released(self, selected: list[str], **parents: str) -> list[dict]:
        return self.run_scenario(call="release", selected=selected, sessions=sessions(**parents))

    def test_a_child_whose_parent_stays_behind_is_let_go(self) -> None:
        released = self.released(["child"], parent="", child="parent")

        self.assertEqual(released, [{"ids": ["child"], "parent": ""}])

    def test_a_child_moving_with_its_parent_stays_in_the_stack(self) -> None:
        # The whole stack is going into the group, and it should arrive looking like a stack.
        self.assertEqual(self.released(["parent", "child"], parent="", child="parent"), [])

    def test_terminals_in_no_stack_are_left_alone(self) -> None:
        self.assertEqual(self.released(["one", "two"], one="", two=""), [])

    def test_several_children_go_in_one_request(self) -> None:
        released = self.released(["one", "two"], parent="", one="parent", two="parent")

        self.assertEqual(released, [{"ids": ["one", "two"], "parent": ""}])


class WiredIntoTheGroupActionsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.source = (STATIC / "app.js").read_text()

    def body(self, name: str) -> str:
        return re.search(rf"\n  (?:async )?{name}\([^)]*\) \{{(.*?)\n  \}}", self.source, re.S).group(1)

    def escape_branch(self) -> str:
        # Only the branch that releases an agent from its stack, not the ordinary drop handling that
        # follows it -- which does its own grouping, and would answer for the branch under test.
        drop = re.search(r"item\.ondrop = \(event\) => \{(.*?)\n    \};", self.source, re.S).group(1)
        return re.search(r"if \(escaping\.length\) \{(.*?)\n        \}", drop, re.S).group(1)

    def test_making_a_group_lets_go_of_the_agents_it_takes(self) -> None:
        self.assertIn("releaseSpawnedFromStacks(ids)", self.body("createTerminalGroupFromSessions"))

    def test_moving_terminals_into_a_group_does_the_same(self) -> None:
        self.assertIn("releaseSpawnedFromStacks(sessionIds)", self.body("moveSelectedSessionsIntoGroup"))

    def test_where_the_group_lands_is_settled_before_anything_is_let_go(self) -> None:
        # Afterwards the row is no longer drawn where it was, and the answer would be the wrong place.
        body = self.body("createTerminalGroupFromSessions")

        self.assertLess(body.index("layoutAnchorTokenFor(anchorId)"), body.index("releaseSpawnedFromStacks(ids)"))

    def test_a_cancelled_naming_lets_go_of_nothing(self) -> None:
        # The dialog is how the group is asked for; cancelled, it asked for nothing, and an agent
        # pulled out of its stack anyway cannot be put back by cancelling.
        body = self.body("createTerminalGroupFromSessions")

        self.assertLess(body.index("if (!name || !name.trim()) return;"), body.index("releaseSpawnedFromStacks(ids)"))

    def test_an_agent_dropped_on_a_group_joins_it(self) -> None:
        # Released from its stack and then left where it was, it came out of the stack and joined
        # nothing. The drop still has to land.
        escape = self.escape_branch()

        self.assertIn("moveSelectedSessionsIntoGroup(sourceSessionIds, targetId)", escape)
        self.assertIn("repositionSelectedSessionsAroundLayoutToken(sourceSessionIds, token", escape)

    def test_a_stack_dragged_whole_is_not_taken_apart(self) -> None:
        drop = re.search(r"item\.ondrop = \(event\) => \{(.*?)\n    \};", self.source, re.S).group(1)
        escaping = re.search(r"const escaping = sourceSessionIds\.filter\((.*?)\}\);", drop, re.S).group(1)

        self.assertIn("!dragged.has(parentId)", escaping)


if __name__ == "__main__":
    unittest.main()
