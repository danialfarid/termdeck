"""The deck saves one field of the project state at a time.

A save that carried the whole state carried this window's copy of every other field with it, so
switching note also wrote the notes, the copied text and the layout as this window last saw them.
Each field goes out on its own now, and only when it changed.
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
const scenario = JSON.parse(process.env.TERMDECK_FIELD_SAVE_SCENARIO);
const sent = [];
const state = scenario.state;
const app = {
  notebookProjectStateKey: () => "stock",
  notebookProjectState: () => state,
  savedNotebookProjectFields: new Map(),
  applyLocalProjectStatePatch() {},
  queueProjectResourceRequest: (stateKey, path, method, body) => sent.push({ path, method, body }),
  __METHODS__
};
app.saveNotebookProjectState();
Object.assign(state, scenario.next || {});
if (scenario.next) app.saveNotebookProjectState();
process.stdout.write(JSON.stringify(sent));
"""


class NotebookStateSaveTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        methods = method_source((STATIC / "app_markdown_files.js").read_text(), "saveNotebookProjectState()")
        queue = method_source((STATIC / "app.js").read_text(), "queueProjectStatePatch(stateKey, patch)")
        cls.harness = HARNESS.replace("__METHODS__", f"{methods}\n  {queue.rstrip().rstrip(',')},")

    def save(self, **scenario: object) -> list[dict]:
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_FIELD_SAVE_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def state(self, note_id: str = "note-1", text: str = "first") -> dict:
        return {"notebook_active_note_id": note_id, "notebook_notes_initialized": True, "notebook_text": text}

    def test_each_field_goes_out_on_its_own(self) -> None:
        sent = self.save(state=self.state())

        self.assertEqual([request["path"] for request in sent],
                         ["/api/project-state/notebook_active_note_id",
                          "/api/project-state/notebook_notes_initialized",
                          "/api/project-state/notebook_text"])
        self.assertEqual([request["method"] for request in sent], ["PUT", "PUT", "PUT"])

    def test_a_field_carries_its_own_value_and_nothing_else(self) -> None:
        sent = self.save(state=self.state())

        self.assertEqual(sent[0]["body"], {"value": "note-1"})

    def test_switching_note_writes_which_note_and_nothing_else(self) -> None:
        # The other two fields did not change, so this window has nothing to say about them.
        sent = self.save(state=self.state(), next={"notebook_active_note_id": "note-2"})

        self.assertEqual([request["path"] for request in sent[3:]], ["/api/project-state/notebook_active_note_id"])
        self.assertEqual(sent[3]["body"], {"value": "note-2"})

    def test_saving_again_with_nothing_changed_writes_nothing(self) -> None:
        sent = self.save(state=self.state(), next={})

        self.assertEqual(len(sent), 3)

    def test_the_whole_state_is_never_sent(self) -> None:
        # The call that took every field at once is what a stale window overwrote the deck with.
        sent = self.save(state=self.state(), next={"notebook_text": "second"})

        for request in sent:
            self.assertNotIn("/api/terminal-layout", request["path"])
            self.assertEqual(len(request["body"]), 1)


class SharedListsAreRefusedByTheClientTest(unittest.TestCase):
    """The client's own guard, so a field write that would replace a shared list never leaves the page."""

    def setUp(self) -> None:
        source = (STATIC / "app.js").read_text()
        self.body = re.search(r"\n  patchProjectState\(patch\) \{(.*?)\n  \}", source, re.S).group(1)

    def test_the_lists_several_windows_add_to_are_named(self) -> None:
        for field in ("terminal_groups", "session_groups", "terminal_layout", "session_order", "unread_sessions",
                      "recently_opened_terminal_ids", "session_view_modes", "notebook_notes",
                      "selection_copy_history"):
            self.assertIn(f'"{field}"', self.body)

    def test_it_refuses_rather_than_sending_them(self) -> None:
        self.assertIn("throw new Error", self.body)


if __name__ == "__main__":
    unittest.main()
