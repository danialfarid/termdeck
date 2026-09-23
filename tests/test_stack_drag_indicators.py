"""Dragging an agent around inside the stack it is already in says what the drop would do.

Over the stack it came from there was no indicator at all, over its parent's row it offered a move
that could not happen -- a spawned agent is drawn under its parent rather than from the layout -- and
over a sibling it offered to make a group of two agents that already share one. A drag with no
feedback reads as a deck that has stopped responding.
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
const scenario = JSON.parse(process.env.TERMDECK_STACK_DRAG_SCENARIO);
const app = {
  session: (id) => scenario.sessions[id] || null,
  __METHODS__
};
process.stdout.write(JSON.stringify(
  app.stackParentAlreadyHolding(scenario.target, scenario.dragged)));
"""


def sessions(**parents: str) -> dict[str, dict[str, str]]:
    return {session_id: {"session_id": session_id, "spawned_by_session_id": parent}
            for session_id, parent in parents.items()}


class StackParentAlreadyHoldingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app.js").read_text()
        cls.harness = HARNESS.replace(
            "__METHODS__", method_source(source, "stackParentAlreadyHolding(targetId, sourceSessionIds)"))

    def holding(self, target: str, dragged: list[str], **parents: str) -> str:
        scenario = {"target": target, "dragged": dragged, "sessions": sessions(**parents)}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_STACK_DRAG_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_a_child_over_its_own_parent(self) -> None:
        self.assertEqual(self.holding("parent", ["child"], parent="", child="parent"), "parent")

    def test_a_child_over_a_sibling(self) -> None:
        self.assertEqual(self.holding("sibling", ["child"], parent="", child="parent", sibling="parent"), "parent")

    def test_a_child_over_a_terminal_outside_the_stack(self) -> None:
        self.assertEqual(self.holding("stranger", ["child"], parent="", child="parent", stranger=""), "")

    def test_a_child_over_another_parents_child(self) -> None:
        # Filing it under the other parent is a real move, and the row should offer it.
        self.assertEqual(
            self.holding("cousin", ["child"], parent="", child="parent", other="", cousin="other"), "")

    def test_a_terminal_in_no_stack(self) -> None:
        self.assertEqual(self.holding("parent", ["loose"], parent="", loose=""), "")

    def test_several_children_of_one_parent(self) -> None:
        self.assertEqual(self.holding("parent", ["one", "two"], parent="", one="parent", two="parent"), "parent")

    def test_children_of_different_parents_are_not_settled(self) -> None:
        # Dropping them together does change something: they end up in one stack.
        self.assertEqual(
            self.holding("parent", ["one", "two"], parent="", other="", one="parent", two="other"), "")

    def test_nothing_dragged(self) -> None:
        self.assertEqual(self.holding("parent", [], parent=""), "")


class WiredIntoTheDragTest(unittest.TestCase):
    """Where the answer is used: the row under the pointer, and the stack around it."""

    def setUp(self) -> None:
        self.app = (STATIC / "app.js").read_text()
        self.sidebar = (STATIC / "app_search_git.js").read_text()

    def test_the_parents_row_says_the_agent_is_already_there(self) -> None:
        dragover = re.search(r"item\.ondragover = \(event\) => \{(.*?)\n    \};", self.app, re.S).group(1)

        self.assertIn("stackParentAlreadyHolding(targetId, sourceSessionIds)", dragover)
        self.assertIn("already under", dragover)

    def test_a_sibling_row_offers_a_reorder_rather_than_a_group(self) -> None:
        dragover = re.search(r"item\.ondragover = \(event\) => \{(.*?)\n    \};", self.app, re.S).group(1)
        hold_to_file = re.search(r"const holdToFile = ([^;]*);", dragover, re.S).group(1)
        hold_to_create = re.search(r"const holdToCreate = ([^;]*);", dragover, re.S).group(1)

        self.assertIn("!settledParentId", hold_to_file)
        self.assertIn("!settledParentId", hold_to_create)

    def test_dropping_on_the_parents_row_does_what_it_said(self) -> None:
        # Nothing: a spawned agent's row is drawn under its parent rather than from the layout, so
        # reordering it there changed the order underneath and left the list looking the same.
        drop = re.search(r"item\.ondrop = \(event\) => \{(.*?)\n    \};", self.app, re.S).group(1)
        settled = drop.index("stackParentAlreadyHolding(targetId, sourceSessionIds) === targetId")

        self.assertLess(settled, drop.index("repositionSelectedSessions"))

    def test_the_stack_it_came_from_says_so_too(self) -> None:
        # It has nothing to file, so it used to return without drawing anything at all.
        dragover = re.search(r"stack\.ondragover = \(event\) => \{(.*?)\n    \};", self.sidebar, re.S).group(1)

        self.assertIn("stackParentAlreadyHolding(parent.session_id", dragover)
        self.assertIn("already under", dragover)


if __name__ == "__main__":
    unittest.main()
