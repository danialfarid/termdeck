"""The eye keeps the terminal a showing agent was spawned under.

With the eye on, a quiet parent was hidden while its busy child still showed. The child then had nothing
to sit under, so it was drawn on its own at the top of the list, outside the parent's group -- it looked
moved, and the parent looked gone.
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
const scenario = JSON.parse(process.env.TERMDECK_EYE_SCENARIO);
const active = new Set(scenario.active);
const app = {
  isActiveTerminal: (session) => active.has(session.session_id),
  __METHODS__
};
const sessions = scenario.sessions.map(([id, parent]) => ({ session_id: id, spawned_by_session_id: parent }));
process.stdout.write(JSON.stringify(app.activeTerminalsWithParents(sessions).map((s) => s.session_id)));
"""


class EyeFilterParentsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__", method_source(source, "activeTerminalsWithParents(sessions)"))

    def shown(self, sessions, active):
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_EYE_SCENARIO": json.dumps(
                                  {"sessions": sessions, "active": active})})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_a_busy_child_keeps_its_quiet_parent(self) -> None:
        sessions = [["parent", None], ["busy", "parent"], ["quiet", "parent"]]
        self.assertEqual(self.shown(sessions, ["busy"]), ["parent", "busy"])

    def test_the_whole_chain_above_is_kept(self) -> None:
        sessions = [["root", None], ["middle", "root"], ["leaf", "middle"], ["other", None]]
        self.assertEqual(self.shown(sessions, ["leaf"]), ["root", "middle", "leaf"])

    def test_a_quiet_parent_with_quiet_children_stays_hidden(self) -> None:
        sessions = [["parent", None], ["child", "parent"], ["busy", None]]
        self.assertEqual(self.shown(sessions, ["busy"]), ["busy"])

    def test_a_parent_missing_from_the_list_is_not_conjured(self) -> None:
        self.assertEqual(self.shown([["child", "elsewhere"]], ["child"]), ["child"])

    def test_a_loop_of_parentage_ends(self) -> None:
        sessions = [["a", "b"], ["b", "a"], ["c", None]]
        self.assertEqual(self.shown(sessions, ["a"]), ["a", "b"])


if __name__ == "__main__":
    unittest.main()
