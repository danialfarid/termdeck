"""A window may only write a note from the copy it has.

Every window keeps its own copy of a note and writes the whole text back, so a window left open while
the note was edited somewhere else wrote its stale copy over the newer one on its next save. The newer
text was gone, and nothing anywhere held it. The write is refused now, and the window that made it is
locked out of that note until it has caught up.
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
const scenario = JSON.parse(process.env.TERMDECK_CONFLICT_SCENARIO);
const sent = [];
const held = [];
const app = {
  notebookProjectStateKey: () => "stock",
  notebookNoteConflicts: new Map(scenario.locked ? [[scenario.note.note_id, null]] : []),
  queueProjectResourceRequest: (stateKey, path, method, body, options) => {
    sent.push({ path, method, body: typeof body === "function" ? body() : body });
    if (scenario.refuse) {
      const handled = options.onRefused(scenario.refuse.status, scenario.refuse.detail);
      sent[sent.length - 1].refusalHandled = handled;
      return;
    }
    options.onSaved?.(scenario.saved || {});
  },
  holdNotebookNoteForRefresh: (noteId, serverNote) => held.push({ noteId, serverNote }),
  __METHODS__
};
const note = scenario.note;
app.saveNotebookNote(note);
process.stdout.write(JSON.stringify({ sent, held, revision: note.revision }));
"""

REFRESH_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_REFRESH_SCENARIO);
const created = [];
const state = { notebook_notes: [scenario.note], notebook_active_note_id: scenario.note.note_id, notebook_text: "" };
const model = { value: scenario.typedHere, getValue() { return this.value; }, setValue(next) { this.value = next; } };
global.fetch = async () => ({ ok: true, json: async () => scenario.serverNote });
const app = {
  notebookProjectStateKey: () => "stock",
  projectStateSearchParams: () => new URLSearchParams({ project: "stock" }),
  notebookProjectState: () => state,
  notebookEditorModels: new Map([[scenario.note.note_id, model]]),
  notebookNoteConflicts: new Map([[scenario.note.note_id, null]]),
  createNotebookNoteId: () => "note-rescued",
  createNotebookNoteRecord: (note) => created.push(note),
  applyNotebookEditability() {},
  renderNotebook() {},
  __METHODS__
};
await app.refreshNotebookNote(scenario.note.note_id);
process.stdout.write(JSON.stringify({ created, notes: state.notebook_notes, model: model.value,
  locked: app.notebookNoteConflicts.has(scenario.note.note_id) }));
"""


def run(harness: str, env_name: str, scenario: dict, node: str) -> dict:
    done = subprocess.run([node, "--input-type=module", "-e", harness], capture_output=True, text=True, check=False,
                          env={**os.environ, env_name: json.dumps(scenario)})
    if done.returncode != 0:
        raise AssertionError(done.stderr)
    return json.loads(done.stdout)


class SaveCarriesItsVersionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__", method_source(source, "saveNotebookNote(note)"))

    def save(self, **scenario: object) -> dict:
        base = {"note": {"note_id": "note-1", "text": "typed", "revision": 4}}
        return run(self.harness, "TERMDECK_CONFLICT_SCENARIO", {**base, **scenario}, self.node)

    def test_a_write_says_which_version_it_was_made_from(self) -> None:
        result = self.save()

        self.assertEqual(result["sent"][0]["body"], {"text": "typed", "base_revision": 4})

    def test_a_note_with_no_version_yet_says_so(self) -> None:
        # Made here a moment ago and not yet acknowledged: there is no version to be older than.
        result = self.save(note={"note_id": "note-1", "text": "typed"})

        self.assertIsNone(result["sent"][0]["body"]["base_revision"])

    def test_the_version_the_server_reports_is_kept_for_the_next_write(self) -> None:
        result = self.save(saved={"note": {"note_id": "note-1", "revision": 5}})

        self.assertEqual(result["revision"], 5)

    def test_a_refusal_locks_the_note_here(self) -> None:
        result = self.save(refuse={"status": 409, "detail": {"reason": "note_changed_elsewhere",
                                                             "note": {"note_id": "note-1", "text": "newer"}}})

        self.assertTrue(result["sent"][0]["refusalHandled"])
        self.assertEqual(result["held"], [{"noteId": "note-1", "serverNote": {"note_id": "note-1", "text": "newer"}}])

    def test_any_other_refusal_is_left_to_the_usual_reporting(self) -> None:
        result = self.save(refuse={"status": 500, "detail": {}})

        self.assertFalse(result["sent"][0]["refusalHandled"])
        self.assertEqual(result["held"], [])

    def test_a_locked_note_is_not_written_at_all(self) -> None:
        # Typing on top of a copy the server has moved past cannot be saved; letting the writes go out
        # only fills the queue with refusals.
        result = self.save(locked=True)

        self.assertEqual(result["sent"], [])


class RefreshKeepsWhatWasTypedTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = REFRESH_HARNESS.replace(
            "__METHODS__", method_source(source, "async refreshNotebookNote(noteId)"))

    def refresh(self, typed: str, server_text: str = "newer text") -> dict:
        scenario = {"note": {"note_id": "note-1", "text": typed, "revision": 1},
                    "typedHere": typed,
                    "serverNote": {"note_id": "note-1", "text": server_text, "revision": 7}}
        return run(self.harness, "TERMDECK_REFRESH_SCENARIO", scenario, self.node)

    def test_the_newer_text_lands_in_the_note(self) -> None:
        result = self.refresh("what this window typed")

        self.assertEqual(result["notes"][0]["text"], "newer text")
        self.assertEqual(result["notes"][0]["revision"], 7)
        self.assertEqual(result["model"], "newer text")

    def test_what_was_typed_here_is_kept_as_its_own_note(self) -> None:
        # It was refused, so it exists nowhere else; replacing it with the newer text would be the
        # very loss this is all about.
        result = self.refresh("what this window typed")

        self.assertEqual([note["text"] for note in result["created"]], ["what this window typed"])
        self.assertIn("what this window typed", [note["text"] for note in result["notes"]])

    def test_nothing_is_rescued_when_nothing_was_typed(self) -> None:
        result = self.refresh("newer text")

        self.assertEqual(result["created"], [])

    def test_the_note_is_editable_again(self) -> None:
        result = self.refresh("what this window typed")

        self.assertFalse(result["locked"])


if __name__ == "__main__":
    unittest.main()
