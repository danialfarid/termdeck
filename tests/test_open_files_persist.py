"""A window writes the files it opened and the files it closed, and nothing else.

Two decks open on the same project each kept their own list of open files and wrote the whole thing
back, so whichever saved last decided what was open: files opened in the other window were closed
again, and came back missing after a reload.
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
const scenario = JSON.parse(process.env.TERMDECK_OPEN_FILES_SCENARIO);
const sent = [];
let failing = scenario.failUntil || 0;
globalThis.fetch = async (url, options) => {
  sent.push({ url, method: options.method, body: JSON.parse(options.body) });
  if (failing > 0) { failing -= 1; return { ok: false, status: 500 }; }
  return { ok: true, status: 200 };
};
const openFilesOf = (files) =>
  new Map(Object.entries(files).map(([key, file]) => [key, { ...file, mtime: file.mtime || 0 }]));
const app = {
  projectSlug: "stock",
  settings: { project_state: scenario.state },
  openFiles: openFilesOf(scenario.restored),
  persistedOpenFiles: new Map(),
  openFilesPersistPromise: Promise.resolve(),
  owningProjectKey: (root) => (scenario.projects || {})[root] || "stock",
  projectStateKey: () => "stock",
  projectStateSearchParams: (projectKey) => new URLSearchParams({ project: projectKey, worktree_id: "root" }),
  $: () => ({ textContent: "" }),
  __METHODS__
};
// What the window restored is what the server already has; from here it writes what it opens and closes.
app.rememberPersistedOpenFiles();
for (const state of scenario.then || []) {
  app.openFiles = openFilesOf(state);
  app.persistOpenFiles();
  await app.openFilesPersistPromise;
}
process.stdout.write(JSON.stringify({ sent, state: app.settings.project_state }));
"""


def entry(root: str, path: str, mtime: str = "0", git_status: str = "") -> dict:
    return {"root": root, "path": path, "mtime": mtime, "git_status": git_status}


def files(*paths: str, root: str = "/repo", mtime: int = 0) -> dict:
    return {f"{root}|{path}": {"root": root, "path": path, "mtime": mtime} for path in paths}


class PersistOpenFilesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_settings_ui.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__", "\n  ".join(
            method_source(source, name) for name in
            ("openFilesByProject()", "rememberPersistedOpenFiles()", "forgetPersistedOpenFile(change)",
             "persistOpenFiles()")))

    def run_scenario(self, scenario: dict) -> dict:
        done = subprocess.run([self.node, "--input-type=module", "-e", self.harness],
                              capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_OPEN_FILES_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def window(self, restored: dict, saved: list[dict], then: list[dict], **scenario: object) -> dict:
        return self.run_scenario({"restored": restored, "state": {"stock": {"open_files": saved}},
                                  "then": then, **scenario})

    def written(self, result: dict) -> list[tuple[str, str]]:
        return [(request["method"], request["body"]["path"]) for request in result["sent"]]

    def test_opening_a_file_writes_that_file(self) -> None:
        result = self.window(files("a.py"), [entry("/repo", "a.py")], [files("a.py", "b.py")])

        self.assertEqual(self.written(result), [("POST", "b.py")])

    def test_closing_a_file_writes_that_file(self) -> None:
        result = self.window(files("a.py", "b.py"), [entry("/repo", "a.py"), entry("/repo", "b.py")],
                             [files("a.py")])

        self.assertEqual(self.written(result), [("DELETE", "b.py")])

    def test_a_file_another_window_opened_is_left_alone(self) -> None:
        # b.py is open in another window and was never open here, so this window has nothing to say
        # about it. Speaking for it is how a file opened in one deck was closed by the next save in
        # another.
        result = self.window(files("a.py"), [entry("/repo", "a.py"), entry("/repo", "b.py")],
                             [files("a.py", "c.py")])

        self.assertEqual(self.written(result), [("POST", "c.py")])
        self.assertEqual(sorted(file["path"] for file in result["state"]["stock"]["open_files"]),
                         ["a.py", "b.py", "c.py"])

    def test_another_projects_files_are_not_closed_by_opening_this_one(self) -> None:
        # A window restores the project it is on. Remembering everything that was ever saved -- other
        # projects, other worktrees -- made every one of those files read as closed here, and the next
        # save deleted them.
        result = self.run_scenario({
            "restored": {"/stock|a.py": {"root": "/stock", "path": "a.py"}},
            "state": {"stock": {"open_files": [entry("/stock", "a.py")]},
                      "other": {"open_files": [entry("/other", "b.py")]}},
            "projects": {"/stock": "stock", "/other": "other"},
            "then": [{"/stock|a.py": {"root": "/stock", "path": "a.py"}}]})

        self.assertEqual(result["sent"], [])
        self.assertEqual([file["path"] for file in result["state"]["other"]["open_files"]], ["b.py"])

    def test_a_file_the_restore_left_out_is_not_closed(self) -> None:
        # Only so many tabs are restored; the ones left behind were never open in this window.
        result = self.window(files("a.py"), [entry("/repo", "a.py"), entry("/repo", "over-the-limit.py")],
                             [files("a.py")])

        self.assertEqual(result["sent"], [])

    def test_nothing_changed_writes_nothing(self) -> None:
        result = self.window(files("a.py"), [entry("/repo", "a.py")], [files("a.py")])

        self.assertEqual(result["sent"], [])

    def test_a_changed_mtime_is_written(self) -> None:
        # The stamp is how the deck notices a file changed under it while it was closed.
        result = self.window(files("a.py"), [entry("/repo", "a.py")], [files("a.py", mtime=9)])

        self.assertEqual([(request["method"], request["body"]["mtime"]) for request in result["sent"]],
                         [("POST", "9")])

    def test_an_open_that_failed_is_written_again(self) -> None:
        result = self.window(files("a.py"), [entry("/repo", "a.py")],
                             [files("a.py", "b.py"), files("a.py", "b.py")], failUntil=1)

        self.assertEqual(self.written(result), [("POST", "b.py"), ("POST", "b.py")])

    def test_a_close_that_failed_is_written_again(self) -> None:
        # Forgetting the file outright would lose the close: the next save would see a file it never
        # had open and say nothing about it, and the tab would come back on the next load.
        result = self.window(files("a.py"), [entry("/repo", "a.py")], [{}, {}], failUntil=1)

        self.assertEqual(self.written(result), [("DELETE", "a.py"), ("DELETE", "a.py")])

    def test_the_writes_behind_a_failed_one_are_written_again_too(self) -> None:
        # The run stops at the first failure, so the ones behind it never went out at all.
        opened = files("a.py", "b.py", "c.py")
        result = self.window(files("a.py"), [entry("/repo", "a.py")], [opened, opened], failUntil=1)
        attempted = [request["body"]["path"] for request in result["sent"][:1]]
        retried = [request["body"]["path"] for request in result["sent"][1:]]

        self.assertEqual(len(attempted), 1, "the run stops at the failure")
        self.assertEqual(sorted(retried), ["b.py", "c.py"])

    def test_the_whole_list_is_never_written(self) -> None:
        result = self.window(files("a.py"), [entry("/repo", "a.py")], [files("a.py", "b.py")])

        for request in result["sent"]:
            self.assertIn("/api/open-files", request["url"])
            self.assertNotIn("project-state/open_files", request["url"])
            self.assertIn("path", request["body"])


if __name__ == "__main__":
    unittest.main()
