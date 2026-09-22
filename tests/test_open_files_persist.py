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
globalThis.fetch = async (url, options) => {
  sent.push({ url, method: options.method, body: JSON.parse(options.body) });
  return { ok: true, status: 200 };
};
const app = {
  projectSlug: "stock",
  settings: { project_state: scenario.state },
  openFiles: new Map(Object.entries(scenario.open).map(([key, file]) => [key, { ...file, mtime: file.mtime || 0 }])),
  persistedOpenFiles: new Map(),
  openFilesPersistPromise: Promise.resolve(),
  owningProjectKey: () => "stock",
  projectStateKey: () => "stock",
  projectStateSearchParams: () => new URLSearchParams({ project: "stock", worktree_id: "root" }),
  $: () => ({ textContent: "" }),
  __METHODS__
};
if (scenario.remember) app.rememberPersistedOpenFiles();
app.persistOpenFiles();
await app.openFilesPersistPromise;
process.stdout.write(JSON.stringify({ sent, state: app.settings.project_state }));
"""


def entry(root: str, path: str, mtime: str = "0", git_status: str = "") -> dict:
    return {"root": root, "path": path, "mtime": mtime, "git_status": git_status}


class PersistOpenFilesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_settings_ui.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__", "\n  ".join(
            method_source(source, name) for name in
            ("openFilesByProject()", "rememberPersistedOpenFiles()", "persistOpenFiles()")))

    def persist(self, open_files: dict, saved: list[dict], remember: bool = True) -> dict:
        scenario = {"open": open_files, "state": {"stock": {"open_files": saved}}, "remember": remember}
        done = subprocess.run([self.node, "--input-type=module", "-e", self.harness],
                              capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_OPEN_FILES_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_opening_a_file_writes_that_file(self) -> None:
        result = self.persist({"/repo|a.py": {"root": "/repo", "path": "a.py"},
                               "/repo|b.py": {"root": "/repo", "path": "b.py"}},
                              [entry("/repo", "a.py")])

        self.assertEqual([(request["method"], request["body"]["path"]) for request in result["sent"]],
                         [("POST", "b.py")])

    def test_closing_a_file_writes_that_file(self) -> None:
        result = self.persist({"/repo|a.py": {"root": "/repo", "path": "a.py"}},
                              [entry("/repo", "a.py"), entry("/repo", "b.py")])

        self.assertEqual([(request["method"], request["body"]["path"]) for request in result["sent"]],
                         [("DELETE", "b.py")])

    def test_a_file_another_window_opened_is_left_alone(self) -> None:
        # b.py is open in another window and was never open here, so this window has nothing to say
        # about it. Speaking for it is how a file opened in one deck was closed by the next save in
        # another.
        result = self.persist({"/repo|a.py": {"root": "/repo", "path": "a.py"}},
                              [entry("/repo", "a.py"), entry("/repo", "b.py")], remember=False)

        self.assertEqual([(request["method"], request["body"]["path"]) for request in result["sent"]],
                         [("POST", "a.py")])
        self.assertEqual(sorted(file["path"] for file in result["state"]["stock"]["open_files"]),
                         ["a.py", "b.py"])

    def test_what_arrived_from_another_window_stays_in_the_local_copy(self) -> None:
        result = self.persist({"/repo|a.py": {"root": "/repo", "path": "a.py"},
                               "/repo|c.py": {"root": "/repo", "path": "c.py"}},
                              [entry("/repo", "a.py"), entry("/repo", "b.py")], remember=False)

        self.assertEqual(sorted(file["path"] for file in result["state"]["stock"]["open_files"]),
                         ["a.py", "b.py", "c.py"])

    def test_nothing_changed_writes_nothing(self) -> None:
        result = self.persist({"/repo|a.py": {"root": "/repo", "path": "a.py"}}, [entry("/repo", "a.py")])

        self.assertEqual(result["sent"], [])

    def test_a_changed_mtime_is_written(self) -> None:
        # The stamp is how the deck notices a file changed under it while it was closed.
        result = self.persist({"/repo|a.py": {"root": "/repo", "path": "a.py", "mtime": 9}},
                              [entry("/repo", "a.py", mtime="3")])

        self.assertEqual([(request["method"], request["body"]["mtime"]) for request in result["sent"]],
                         [("POST", "9")])

    def test_the_whole_list_is_never_written(self) -> None:
        result = self.persist({"/repo|a.py": {"root": "/repo", "path": "a.py"}},
                              [entry("/repo", "b.py")])

        for request in result["sent"]:
            self.assertIn("/api/open-files", request["url"])
            self.assertNotIn("project-state/open_files", request["url"])
            self.assertIn("path", request["body"])


if __name__ == "__main__":
    unittest.main()
