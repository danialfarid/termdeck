"""The project and worktree pickers list the last opened first.

Switching back and forth between two projects buried the other one wherever the server happened
to list it. Each picker now keeps its own most-recently-opened order per browser, with the
"All projects" / "All worktrees" rows still pinned at the top and never-visited entries keeping
their server order after the visited ones.

The client has no JS harness; as in test_terminal_cycle_order the methods are lifted out of the
shipped source and run under node against stubs.
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

RECENCY_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_PICKER_RECENCY_SCENARIO);
__CONSTS__
const store = { ...(scenario.stored || {}) };
global.localStorage = {
  getItem: (key) => (key in store ? store[key] : null),
  setItem: (key, value) => { store[key] = String(value); },
};
const app = {
  projectSlug: scenario.projectSlug || "",
  __METHODS__
};
const out = {};
if (scenario.record) {
  for (const [kind, value] of scenario.record) app.recordHeaderPickerVisit(kind, value);
  out.stored = { ...store };
}
if (scenario.sort) {
  out.order = app.sortHeaderPickerOptionsByRecency(
    scenario.sort.kind, scenario.sort.options).map((option) => option.value);
}
if (scenario.recent) out.recent = app.headerPickerRecentValues(scenario.recent);
process.stdout.write(JSON.stringify(out));
"""


def _picker_consts(source: str) -> str:
    # The storage keys are the contract: hardcoding them here would pass against the wrong keys,
    # so they are read out of the shipped source instead.
    keys = {}
    for name in ("HEADER_PICKER_RECENT_PROJECTS_KEY", "HEADER_PICKER_RECENT_WORKTREES_KEY_PREFIX",
                 "HEADER_PICKER_RECENT_MAX", "ALL_WORKTREES_ID"):
        match = re.search(rf"{name} = (\"[^\"]*\"|\d+);", source)
        if not match:
            raise AssertionError(f"{name} not found in shipped source")
        keys[name] = match.group(1)
    return "\n".join(f"const {name} = {value};" for name, value in keys.items())


class HeaderPickerRecencyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app.js").read_text()
        cls.harness = RECENCY_HARNESS.replace(
            "__CONSTS__", _picker_consts(source)).replace(
            "__METHODS__", "\n  ".join(
                method_source(source, name) for name in
                ("headerPickerRecentKey(kind)", "headerPickerRecentValues(kind)",
                 "recordHeaderPickerVisit(kind, value)",
                 "sortHeaderPickerOptionsByRecency(kind, options)")))

    def run_scenario(self, **scenario: object) -> dict:
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True,
                              check=False,
                              env={**os.environ, "TERMDECK_PICKER_RECENCY_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_a_visit_comes_back_first(self) -> None:
        result = self.run_scenario(record=[["project", "termdeck"]],
                                   recent="project", projectSlug="termdeck")

        self.assertEqual(result["recent"], ["termdeck"])

    def test_revisiting_moves_to_the_front_without_duplicating(self) -> None:
        result = self.run_scenario(
            record=[["project", "a"], ["project", "b"], ["project", "a"]],
            recent="project")

        self.assertEqual(result["recent"], ["a", "b"])

    def test_worktrees_are_remembered_per_project(self) -> None:
        result = self.run_scenario(
            record=[["worktree", "wt-1"]], recent="worktree", projectSlug="termdeck")

        self.assertEqual(result["recent"], ["wt-1"])
        self.assertEqual(len(result["stored"]), 1)
        self.assertIn("termdeck", next(iter(result["stored"])))

    def test_worktrees_without_a_project_have_no_memory(self) -> None:
        result = self.run_scenario(record=[["worktree", "wt-1"]], recent="worktree")

        self.assertEqual(result["recent"], [])

    def test_corrupt_memory_reads_as_empty(self) -> None:
        source = (STATIC / "app.js").read_text()
        key = re.search(r'HEADER_PICKER_RECENT_PROJECTS_KEY = ("[^"]*");', source).group(1)
        result = self.run_scenario(stored={json.loads(key): "not-json["}, recent="project")

        self.assertEqual(result["recent"], [])

    def test_sort_pins_all_first_then_recency_then_server_order(self) -> None:
        options = [{"value": "", "label": "All projects"},
                   {"value": "a", "label": "a"}, {"value": "b", "label": "b"},
                   {"value": "c", "label": "c"}]
        source = (STATIC / "app.js").read_text()
        key = re.search(r'HEADER_PICKER_RECENT_PROJECTS_KEY = ("[^"]*");', source).group(1)
        result = self.run_scenario(stored={json.loads(key): '["c", "a"]'},
                                   sort={"kind": "project", "options": options})

        self.assertEqual(result["order"], ["", "c", "a", "b"])

    def test_sort_pins_all_worktrees_first(self) -> None:
        source = (STATIC / "app.js").read_text()
        all_id = json.loads(re.search(r'ALL_WORKTREES_ID = ("[^"]*");', source).group(1))
        options = [{"value": all_id, "label": "All worktrees"},
                   {"value": "wt-1", "label": "wt-1"}, {"value": "wt-2", "label": "wt-2"}]
        key = re.search(r'HEADER_PICKER_RECENT_WORKTREES_KEY_PREFIX = ("[^"]*");', source).group(1)
        stored = {f"{json.loads(key)}termdeck": '["wt-2"]'}
        result = self.run_scenario(stored=stored, projectSlug="termdeck",
                                   sort={"kind": "worktree", "options": options})

        self.assertEqual(result["order"], [all_id, "wt-2", "wt-1"])


if __name__ == "__main__":
    unittest.main()
