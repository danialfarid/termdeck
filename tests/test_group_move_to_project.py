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
globalThis.fetch = async (url, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : null;
  sent.push({ url, method: options.method || "GET", body });
  // Reading the other project's groups: what is already there decides the id the group arrives under.
  const failing = scenario.failing || "";
  if (!options.method) {
    const readable = !(failing && url.includes(failing));
    return { ok: readable, status: readable ? 200 : 500,
      json: async () => ({ project: scenario.target, worktree_id: "root",
        terminal_groups: scenario.destinationGroups || [] }) };
  }
  const failed = failing && url.includes(failing) &&
    (!scenario.failingSession || url.includes(scenario.failingSession));
  if (failed && scenario.dropsConnection) throw new TypeError("Failed to fetch");
  return { ok: !failed, status: 500 };
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
  refresh: async () => {
    sent.push({ url: "refresh" });
    // What the deck learns on a refresh: whether the request that dropped had landed after all.
    for (const id of scenario.landedAnyway || []) {
      const session = scenario.sessions.find((s) => s.session_id === id);
      if (session) session.project = scenario.target;
    }
  },
  titlePresentation: (session) => ({ text: session?.session_id || "" }),
  removeTerminalGroup: (groupId) => { sent.push({ url: `remove-group ${groupId}` }); },
  newTerminalGroupId: () => "group-new",
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
                         "async freeTerminalGroupId(project, preferredId)")))

    def move(self, **scenario: object) -> dict:
        scenario = {"project": "stock", "target": "planner", "groups": [{"id": "group-1", "name": "reviewers"}],
                    **scenario}
        done = subprocess.run([self.node, "--input-type=module", "-e", self.harness],
                              capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_GROUP_MOVE_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def moves(self, result: dict) -> list[str]:
        return [r["url"].split("/")[3] for r in result["sent"] if r["url"].endswith("/project")]

    def created(self, result: dict) -> list[dict]:
        return [r for r in result["sent"] if "/api/terminal-groups" in r["url"] and r["method"] == "POST"]

    def test_every_terminal_in_the_group_goes(self) -> None:
        result = self.move(members=["one", "two"], sessions=[session("one"), session("two")])

        self.assertEqual(self.moves(result), ["one", "two"])
        self.assertTrue(all(r["body"]["project"] == "planner" for r in result["sent"]
                            if r["url"].endswith("/project")))

    def test_the_agents_they_spawned_go_with_them(self) -> None:
        # A spawned agent is drawn inside its parent's row, not the group's list, so moving the group
        # without it would leave it in a project its parent is no longer in.
        result = self.move(members=["one"],
                           sessions=[session("one"), session("child", parent="one"),
                                     session("grandchild", parent="child"), session("stranger")])

        self.assertEqual(self.moves(result), ["one", "child", "grandchild"])

    def test_the_group_is_made_again_on_the_other_side(self) -> None:
        result = self.move(members=["one", "two"], sessions=[session("one"), session("two")])
        created = self.created(result)

        self.assertEqual(len(created), 1)
        self.assertIn("project=planner", created[0]["url"])
        self.assertEqual(created[0]["body"]["name"], "reviewers")
        self.assertEqual(created[0]["body"]["session_ids"], ["one", "two"])
        self.assertEqual(created[0]["body"]["group_id"], "group-1")

    def test_the_terminals_move_before_the_group_is_made(self) -> None:
        # The other project cannot group terminals it does not have yet.
        result = self.move(members=["one"], sessions=[session("one")])
        urls = [r["url"] for r in result["sent"]]

        self.assertLess(urls.index("/api/sessions/one/project"),
                        next(index for index, url in enumerate(urls)
                             if "/api/terminal-groups" in url and "project=planner" in url
                             and result["sent"][index]["method"] == "POST"))

    def test_an_id_the_other_project_is_using_is_not_reused(self) -> None:
        # Moving a group leaves nothing behind here, but a group moved back can meet its own id; and
        # finding that out after the terminals have gone leaves them there ungrouped.
        result = self.move(members=["one"], sessions=[session("one")],
                           destinationGroups=[{"id": "group-1", "name": "something else"}])

        self.assertEqual(self.created(result)[0]["body"]["group_id"], "group-new")

    def test_the_id_is_settled_before_anything_moves(self) -> None:
        result = self.move(members=["one"], sessions=[session("one")])
        urls = [r["url"] for r in result["sent"]]

        self.assertLess(next(i for i, r in enumerate(result["sent"]) if r["method"] == "GET"),
                        urls.index("/api/sessions/one/project"))

    def test_a_destination_that_cannot_be_read_moves_nothing(self) -> None:
        result = self.move(members=["one"], sessions=[session("one")], failing="terminal-groups")

        self.assertEqual(self.moves(result), [])
        self.assertTrue(result["alerts"])

    def test_the_group_here_goes_once_everything_in_it_has(self) -> None:
        # Left behind, it is an empty group in this project and the id a move back would land on.
        result = self.move(members=["one"], sessions=[session("one")])

        self.assertIn("remove-group group-1", [r["url"] for r in result["sent"]])

    def test_a_half_move_says_what_went_and_keeps_the_rest(self) -> None:
        # All at once, the terminals that moved cannot be told from the ones that did not.
        result = self.move(members=["one", "two"], sessions=[session("one"), session("two")],
                           failing="/project", failingSession="/two/")

        self.assertEqual(self.moves(result), ["one", "two"])
        self.assertEqual(self.created(result)[0]["body"]["session_ids"], ["one"])
        self.assertNotIn("remove-group group-1", [r["url"] for r in result["sent"]])
        self.assertIn("two", result["alerts"][0])
        self.assertIn("moved 1 of 2", result["alerts"][0])

    def test_a_connection_lost_halfway_still_groups_what_went(self) -> None:
        # A request that never arrived and one that was refused leave the same question behind, and
        # throwing out of the move leaves the terminals that did go ungrouped and unmentioned.
        result = self.move(members=["one", "two"], sessions=[session("one"), session("two")],
                           failing="/project", failingSession="/two/", dropsConnection=True)

        self.assertEqual(self.created(result)[0]["body"]["session_ids"], ["one"])
        self.assertIn("moved 1 of 2", result["alerts"][0])

    def test_a_move_that_landed_after_the_connection_dropped_is_counted(self) -> None:
        # The answer never came back, so the deck asks again rather than assuming either way.
        result = self.move(members=["one", "two"], sessions=[session("one"), session("two")],
                           failing="/project", failingSession="/two/", dropsConnection=True,
                           landedAnyway=["two"])

        self.assertEqual(self.created(result)[0]["body"]["session_ids"], ["one", "two"])

    def test_nothing_moving_at_all_groups_nothing_there(self) -> None:
        result = self.move(members=["one"], sessions=[session("one")], failing="/project")

        self.assertEqual(self.created(result), [])
        self.assertTrue(result["alerts"])

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
