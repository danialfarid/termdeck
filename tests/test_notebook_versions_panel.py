"""Reading a note's earlier versions, and putting one back.

They open in the notebook itself: the versions down the left, the one being looked at on the right,
and one button to restore it. Restoring is an edit like any other, so the text it replaces becomes a
version of its own and nothing is spent.
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
const scenario = JSON.parse(process.env.TERMDECK_VERSIONS_SCENARIO);
const saved = [];
const model = { value: scenario.note.text, getValue() { return this.value; }, setValue(next) { this.value = next; } };
const state = { notebook_notes: [scenario.note], notebook_active_note_id: scenario.note.note_id };
const app = {
  notebookHistoryNoteId: scenario.note.note_id,
  notebookHistorySelectedId: scenario.selected,
  notebookHistoryPreview: scenario.preview,
  notebookHistoryOpen: true,
  notebookProjectState: () => state,
  notebookEditorModels: new Map([[scenario.note.note_id, model]]),
  setNotebookNoteText: (note, text) => { note.text = text; saved.push(text); },
  flushNotebook: async () => { saved.push("flushed"); },
  renderNotebook() {},
  mountNotebookEditor() {},
  $: () => ({ textContent: "" }),
  __METHODS__
};
await app.restoreNotebookNoteVersion();
process.stdout.write(JSON.stringify({ saved, model: model.value, text: state.notebook_notes[0].text,
  open: app.notebookHistoryOpen, noteId: app.notebookHistoryNoteId }));
"""


def run(scenario: dict, node: str, harness: str) -> dict:
    done = subprocess.run([node, "--input-type=module", "-e", harness], capture_output=True, text=True, check=False,
                          env={**os.environ, "TERMDECK_VERSIONS_SCENARIO": json.dumps(scenario)})
    if done.returncode != 0:
        raise AssertionError(done.stderr)
    return json.loads(done.stdout)


class RestoreVersionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__", "\n  ".join(
            method_source(source, name) for name in
            ("async restoreNotebookNoteVersion()", "closeNotebookNoteHistory()")))

    def restore(self, current: str, preview: str, selected: int = 7) -> dict:
        scenario = {"note": {"note_id": "note-1", "text": current, "revision": 3},
                    "preview": preview, "selected": selected}
        return run(scenario, self.node, self.harness)

    def test_the_version_goes_back_into_the_note(self) -> None:
        result = self.restore("what it says now", "what it said before")

        self.assertEqual(result["saved"], ["flushed", "what it said before"])
        self.assertEqual(result["text"], "what it said before")

    def test_what_is_in_the_note_is_saved_before_the_older_text_goes_in(self) -> None:
        # Otherwise restoring is itself a way to lose the paragraph someone was in the middle of: it
        # was never saved, so it is in no version either.
        result = self.restore("what it says now", "what it said before")

        self.assertEqual(result["saved"][0], "flushed")

    def test_the_editor_shows_it_too(self) -> None:
        # The model is what the person types into; leaving it on the old text would put that back on
        # the next keystroke.
        result = self.restore("what it says now", "what it said before")

        self.assertEqual(result["model"], "what it said before")

    def test_restoring_the_text_that_is_already_there_writes_nothing(self) -> None:
        result = self.restore("unchanged", "unchanged")

        self.assertEqual(result["saved"], [])

    def test_nothing_selected_restores_nothing(self) -> None:
        result = self.restore("what it says now", "what it said before", selected=0)

        self.assertEqual(result["saved"], [])

    def test_the_versions_view_closes_afterwards(self) -> None:
        result = self.restore("what it says now", "what it said before")

        self.assertFalse(result["open"])
        self.assertEqual(result["noteId"], "")


class VersionsPanelShapeTest(unittest.TestCase):
    """What the panel is made of, checked in the shipped page rather than guessed at."""

    def setUp(self) -> None:
        self.html = (STATIC / "index.html").read_text()
        self.css = (STATIC / "style.css").read_text()
        self.js = (STATIC / "app_markdown_files.js").read_text()

    def test_the_notebook_has_a_button_for_its_versions(self) -> None:
        # In the head but not among its buttons: it comes and goes with the note being read, and from
        # the row itself that moved every other button sideways each time.
        head = re.search(r'<div id="notebook-head">(.*?)\n  </div>', self.html, re.S).group(1)
        actions = re.search(r'<span id="notebook-actions">(.*?)\n    </span>', self.html, re.S).group(1)

        self.assertIn('id="notebook-history"', head)
        self.assertNotIn('id="notebook-history"', actions)
        self.assertRegex(self.css, r"#notebook-history \{[^}]*position: absolute")
        self.assertIn('this.$("notebook-history").onclick', self.js)

    def test_the_same_button_puts_the_note_back(self) -> None:
        # The way the Notes button itself works; there is no x to look for.
        self.assertIn('this.$("notebook-history").onclick = () => this.toggleNotebookNoteHistory();', self.js)
        self.assertNotIn("notebook-note-history-close", self.html)
        toggle = re.search(r"toggleNotebookNoteHistory\(\) \{(.*?)\n  \},", self.js, re.S).group(1)

        self.assertIn("closeNotebookNoteHistory", toggle)
        self.assertIn("openNotebookNoteHistory", toggle)

    def test_it_is_not_offered_on_the_copied_text_view(self) -> None:
        # Copies are not a note and have no versions; the button is only there for a note.
        render = re.search(r"renderNotebook\(\) \{(.*?)\n  \},", self.js, re.S).group(1)

        self.assertIn('historyButton.classList.toggle("hidden", this.notebookCopiesOpen)', render)

    def test_the_versions_open_in_the_notebook_rather_than_a_dialog(self) -> None:
        self.assertIn('id="notebook-note-history"', self.html)
        self.assertIn("notebook-history-open", self.css)
        # The editor gives way to them, as it does for the copied-text view.
        self.assertRegex(self.css, r"notebook-history-open #notebook-editor-host[^{]*\{[^}]*display: none")

    def test_one_of_them_can_be_put_back(self) -> None:
        self.assertIn('id="notebook-note-history-restore"', self.html)
        self.assertIn('this.$("notebook-note-history-restore").onclick', self.js)


class CopiedTextShapeTest(unittest.TestCase):
    """A copy says when it was made, under the button beside it, and offers only to be copied again."""

    def setUp(self) -> None:
        source = (STATIC / "app_markdown_files.js").read_text()
        self.render = re.search(r"renderNotebookRecentCopies\(\) \{(.*?)\n  \},", source, re.S).group(1)
        self.css = (STATIC / "style.css").read_text()

    def test_the_time_sits_with_the_buttons(self) -> None:
        # In front of the text it pushed the text out of the way; this column is otherwise empty.
        self.assertIn("actions.appendChild(stamp)", self.render)
        self.assertNotIn("content.appendChild(stamp)", self.render)

    def test_they_stack_rather_than_sitting_side_by_side(self) -> None:
        self.assertRegex(self.css, r"\.notebook-recent-copy-actions \{[^}]*flex-direction: column")

    def test_there_is_no_insert_button(self) -> None:
        self.assertNotIn("Insert into the active prompt", self.render)
        self.assertIn("Copy again", self.render)


if __name__ == "__main__":
    unittest.main()
