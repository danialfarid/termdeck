"""The file views show the project they are open on.

A terminal can run in a directory belonging to another project -- moved here, or started there -- and
the file tree followed whichever terminal was being looked at. A project created on one directory then
listed another project's files under its own name.
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
const scenario = JSON.parse(process.env.TERMDECK_FILE_ROOT_SCENARIO);
const app = {
  activeId: scenario.activeId || null,
  session: (id) => (id && scenario.cwd ? { session_id: id, cwd: scenario.cwd } : null),
  worktreeRoot: () => scenario.root,
  __METHODS__
};
process.stdout.write(JSON.stringify(app.activeFileRoot()));
"""


class ActiveFileRootTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__", "\n  ".join(
            method_source(source, name) for name in ("activeFileRoot()", "normalizedFileSystemPath(path)")))

    def root(self, project_root: str, cwd: str = "", active: str = "abc") -> str:
        scenario = {"root": project_root, "cwd": cwd, "activeId": active if cwd else ""}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_FILE_ROOT_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_a_terminal_in_the_project_gives_its_own_directory(self) -> None:
        # A terminal working in a subfolder is where the file tree is most useful.
        self.assertEqual(self.root("/workspace/termdeck", "/workspace/termdeck/docs"),
                         "/workspace/termdeck/docs")

    def test_a_terminal_at_the_project_root(self) -> None:
        self.assertEqual(self.root("/workspace/termdeck", "/workspace/termdeck"), "/workspace/termdeck")

    def test_a_terminal_working_somewhere_else_gives_the_project(self) -> None:
        # The terminal belongs to this project; the directory it runs in belongs to another one.
        self.assertEqual(self.root("/workspace/termdeck", "/workspace/stock"), "/workspace/termdeck")

    def test_a_directory_that_merely_starts_the_same_is_somewhere_else(self) -> None:
        # /workspace/termdeck-lsp is not inside /workspace/termdeck.
        self.assertEqual(self.root("/workspace/termdeck", "/workspace/termdeck-lsp"), "/workspace/termdeck")

    def test_no_terminal_gives_the_project(self) -> None:
        self.assertEqual(self.root("/workspace/termdeck"), "/workspace/termdeck")

    def test_a_trailing_slash_is_not_a_different_place(self) -> None:
        self.assertEqual(self.root("/workspace/termdeck/", "/workspace/termdeck/docs"),
                         "/workspace/termdeck/docs")


class WiredIntoTheFileViewsTest(unittest.TestCase):
    """Both places that decide what the tree shows ask the same question."""

    def test_reloading_the_tree_asks_it(self) -> None:
        source = (STATIC / "app_settings_ui.js").read_text()
        body = re.search(r"async reloadTree\(rootOverride\) \{(.*?)\n  \}", source, re.S).group(1)

        self.assertIn("this.treeRoot = rootOverride || this.activeFileRoot();", body)
        self.assertNotIn("s ? s.cwd", body)

    def test_opening_the_files_tab_asks_it(self) -> None:
        source = (STATIC / "app_search_git.js").read_text()

        self.assertIn("const expectedRoot = this.activeFileRoot();", source)


if __name__ == "__main__":
    unittest.main()
