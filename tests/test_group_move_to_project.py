"""Moving a whole group to another project, the way a single terminal moves.

A group was the one thing that could not go: its terminals had to be moved one at a time, and they
arrived scattered through the other project's list with the group left behind in this one.
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
const scenario = JSON.parse(process.env.TERMDECK_GROUP_MOVE_SCENARIO);
const sent = [];
const alerts = [];
globalThis.uiAlert = (text) => { alerts.push(text); };
globalThis.location = { set href(url) { sent.push({ url: `navigate ${url}` }); } };
globalThis.fetch = async (url, options) => {
  sent.push({ url, method: options.method, body: JSON.parse(options.body) });
  const failing = scenario.failing || "";
  return { ok: !(failing && url.includes(failing)), status: 500 };
};
const app = {
  projectSlug: scenario.project,
  vscodeMode: false,
  sessions: scenario.sessions,
  projects: [{ name: "stock" }, { name: "planner" }],
  session: (id) => scenario.sessions.find((s) => s.session_id === id) || null,
  terminalGroups: () => scenario.groups,
  groupSessionIds: () => scenario.members,
  getProjectState: () => ({ session_groups: {} }),
  sessionsForWorktree: () => scenario.sessions,
  stateWorktreeId: () => "root",
  refresh: async () => { sent.push({ url: "refresh" }); },
  __METHODS__
};
await app.moveTerminalGroupToProject("group-1", scenario.target);
process.stdout.write(JSON.stringify({ sent, alerts }));
"""


def session(session_id: str, parent: str = "", project: str = "stock") -> dict[str, str]:
    return {"session_id": session_id, "project": project, "spawned_by_session_id": parent}


class MoveGroupToProjectTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__", "\n  ".join(
            method_source(source, name).rstrip().rstrip(",") + ","
            for name in ("groupSessionIdsWithSpawned(groupId)",
                         "async moveTerminalGroupToProject(groupId, project)",
                         "async moveSelectedSessionsToProject(sessionIds, project, navigate = true)")))

    def move(self, **scenario: object) -> dict:
        scenario = {"project": "stock", "target": "planner", "groups": [{"id": "group-1", "name": "reviewers"}],
                    **scenario}
        done = subprocess.run([self.node, "--input-type=module", "-e", self.harness],
                              capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_GROUP_MOVE_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_every_terminal_in_the_group_goes(self) -> None:
        result = self.move(members=["one", "two"], sessions=[session("one"), session("two")])
        moves = [r["url"] for r in result["sent"] if r["url"].endswith("/project")]

        self.assertEqual(moves, ["/api/sessions/one/project", "/api/sessions/two/project"])
        self.assertTrue(all(r["body"]["project"] == "planner" for r in result["sent"]
                            if r["url"].endswith("/project")))

    def test_the_agents_they_spawned_go_with_them(self) -> None:
        # A spawned agent is drawn inside its parent's row, not the group's list, so moving the group
        # without it would leave it in a project its parent is no longer in.
        result = self.move(members=["one"],
                           sessions=[session("one"), session("child", parent="one"),
                                     session("grandchild", parent="child"), session("stranger")])
        moved = [r["url"].split("/")[3] for r in result["sent"] if r["url"].endswith("/project")]

        self.assertEqual(moved, ["one", "child", "grandchild"])

    def test_the_group_is_made_again_on_the_other_side(self) -> None:
        result = self.move(members=["one", "two"], sessions=[session("one"), session("two")])
        created = [r for r in result["sent"] if "/api/terminal-groups" in r["url"]]

        self.assertEqual(len(created), 1)
        self.assertIn("project=planner", created[0]["url"])
        self.assertEqual(created[0]["body"]["name"], "reviewers")
        self.assertEqual(created[0]["body"]["session_ids"], ["one", "two"])

    def test_the_terminals_move_before_the_group_is_made(self) -> None:
        # The other project cannot group terminals it does not have yet.
        result = self.move(members=["one"], sessions=[session("one")])
        urls = [r["url"] for r in result["sent"]]

        self.assertLess(urls.index("/api/sessions/one/project"),
                        next(index for index, url in enumerate(urls) if "/api/terminal-groups" in url))

    def test_terminals_that_did_not_move_are_not_grouped_elsewhere(self) -> None:
        result = self.move(members=["one"], sessions=[session("one")], failing="/project")

        self.assertFalse([r for r in result["sent"] if "/api/terminal-groups" in r["url"]])
        self.assertTrue(result["alerts"])

    def test_a_group_that_is_already_there_moves_nothing(self) -> None:
        result = self.move(members=["one"], sessions=[session("one", project="planner")])

        self.assertFalse([r for r in result["sent"] if r["url"].endswith("/project")])

    def test_an_empty_group_moves_nothing(self) -> None:
        result = self.move(members=[], sessions=[session("one")])

        self.assertEqual(result["sent"], [])


class OfferedWhereTheOtherMovesAreTest(unittest.TestCase):
    """The group's own menu, beside the moves a single terminal offers."""

    def setUp(self) -> None:
        self.source = (STATIC / "app.js").read_text()
        self.menu = re.search(r"openTerminalGroupContextMenu\(event, group\) \{(.*?)\n  \}", self.source, re.S).group(1)

    def test_the_group_menu_offers_the_move(self) -> None:
        self.assertIn("Move group to project…", self.menu)
        self.assertIn("moveTerminalGroupToProject(group.id, project.name)", self.menu)

    def test_it_lists_the_projects_this_one_is_not(self) -> None:
        self.assertIn("project.name !== this.projectSlug", self.menu)
        self.assertIn("No other registered projects", self.menu)

    def test_it_is_left_out_where_there_are_no_projects_to_move_between(self) -> None:
        self.assertIn("if (!this.vscodeMode)", self.menu)


if __name__ == "__main__":
    unittest.main()
