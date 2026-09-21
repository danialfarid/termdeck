"""A window may only write a note from the copy it has.

Every window keeps its own copy of a note and writes the whole text back, so a window left open while
the note was edited somewhere else wrote its stale copy over the newer one on its next save. The newer
text was gone, and nothing anywhere held it. The write is refused now, and the window that made it is
locked out of that note until it has caught up.
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
  dirtyNotebookNoteIds: new Set(),
  handleRefusedNotebookWrite: (noteId, serverNote) => held.push({ noteId, serverNote }),
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
  dirtyNotebookNoteIds: new Set([scenario.note.note_id]),
  showNotebookError() {},
  createNotebookNoteId: () => "note-rescued",
  createNotebookNoteRecord: (note) => created.push(note),
  rescuedNotebookText: new Map(),
  renderNotebookTabs() {},
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


REFUSAL_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_REFUSAL_SCENARIO);
const errors = [];
const refreshed = [];
const rescuedNotes = [];
const state = { notebook_notes: [{ note_id: "note-1", text: scenario.typedHere || "typed here" }] };
const app = {
  statusWs: { readyState: scenario.connected ? 1 : 3 },
  notebookNoteConflicts: new Map(),
  showNotebookError: (message) => errors.push(message),
  refreshNotebookNote: (noteId, known) => { refreshed.push({ noteId, known }); },
  applyNotebookEditability() {},
  notebookProjectState: () => state,
  notebookEditorModels: new Map(),
  rescuedNotebookText: new Map(),
  createNotebookNoteId: () => "note-rescued",
  createNotebookNoteRecord: (note) => rescuedNotes.push(note),
  renderNotebookTabs() {},
  __METHODS__
};
global.WebSocket = { OPEN: 1 };
app.handleRefusedNotebookWrite("note-1", scenario.serverNote);
process.stdout.write(JSON.stringify({ errors, refreshed, rescuedNotes,
  locked: app.notebookNoteConflicts.has("note-1") }));
"""


class RefusedWriteTest(unittest.TestCase):
    """What a refused write does depends on whether the newer text can reach this window by itself."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = REFUSAL_HARNESS.replace("__METHODS__", "\n  ".join(
            method_source(source, name) for name in
            ("handleRefusedNotebookWrite(noteId, serverNote)", "notebookConnectedLive()",
             "rescueRefusedNotebookText(noteId, serverText)")))

    def refuse(self, connected: bool) -> dict:
        scenario = {"connected": connected, "serverNote": {"note_id": "note-1", "text": "newer"}}
        return run(self.harness, "TERMDECK_REFUSAL_SCENARIO", scenario, self.node)

    def test_a_connected_window_takes_the_newer_text_by_itself(self) -> None:
        # Nothing to ask: the newer text is on its way here anyway, so the note catches up and the
        # only thing to say is that this save did not land.
        result = self.refuse(connected=True)

        self.assertEqual(result["refreshed"], [{"noteId": "note-1", "known": {"note_id": "note-1", "text": "newer"}}])
        self.assertFalse(result["locked"])
        self.assertIn("could not save the note", result["errors"][0])

    def test_a_window_with_no_connection_is_told_and_held(self) -> None:
        # There is nothing to catch up from, so the note waits rather than pretending to save.
        result = self.refuse(connected=False)

        self.assertEqual(result["refreshed"], [])
        self.assertTrue(result["locked"])
        self.assertIn("rejected", result["errors"][0])

    def test_a_held_note_keeps_what_was_typed_somewhere_it_will_survive(self) -> None:
        # Refused text lives only in this browser; a reload would be the end of it.
        result = self.refuse(connected=False)

        self.assertEqual([note["text"] for note in result["rescuedNotes"]], ["typed here"])
        self.assertIn("your text is in a new note", result["errors"][0])


LIVE_TEXT_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_LIVE_SCENARIO);
const models = new Map(scenario.notes.map((note) => [note.note_id,
  { value: scenario.onScreen[note.note_id] ?? note.text, getValue() { return this.value; },
    setValue(next) { this.value = next; } }]));
const app = {
  notebookProjectState: () => ({ notebook_notes: scenario.notes }),
  notebookEditorModels: models,
  dirtyNotebookNoteIds: new Set(scenario.dirty || []),
  renderNotebookTabs() {},
  __METHODS__
};
app.applyArrivingNotebookText();
process.stdout.write(JSON.stringify(Object.fromEntries([...models].map(([id, model]) => [id, model.value]))));
"""


class ArrivingTextTest(unittest.TestCase):
    """A note changed elsewhere shows the change here as it arrives."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = LIVE_TEXT_HARNESS.replace(
            "__METHODS__", method_source(source, "applyArrivingNotebookText()"))

    def apply(self, notes: list, on_screen: dict, dirty: tuple = ()) -> dict:
        scenario = {"notes": notes, "onScreen": on_screen, "dirty": list(dirty)}
        return run(self.harness, "TERMDECK_LIVE_SCENARIO", scenario, self.node)

    def test_an_open_note_follows_the_newer_text(self) -> None:
        result = self.apply([{"note_id": "a", "text": "changed elsewhere"}], {"a": "what it said before"})

        self.assertEqual(result["a"], "changed elsewhere")

    def test_a_note_with_a_write_of_its_own_waiting_is_left_alone(self) -> None:
        # What is being typed here is what the server is about to judge; putting anything over it
        # would throw away the very text that has not been saved yet.
        result = self.apply([{"note_id": "a", "text": "changed elsewhere"}], {"a": "being typed"}, dirty=("a",))

        self.assertEqual(result["a"], "being typed")

    def test_a_note_that_already_agrees_is_untouched(self) -> None:
        result = self.apply([{"note_id": "a", "text": "same"}], {"a": "same"})

        self.assertEqual(result["a"], "same")


TYPING_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_TYPING_SCENARIO);
const saved = [];
const app = {
  dirtyNotebookNoteIds: new Set(),
  notebookProjectState: () => ({ notebook_active_note_id: scenario.note.note_id }),
  renderNotebookTabs() {},
  saveNotebookNote: (note) => saved.push(note.note_id),
  __METHODS__
};
app.setNotebookNoteText(scenario.note, scenario.text, scenario.save !== false, false);
process.stdout.write(JSON.stringify({ dirty: [...app.dirtyNotebookNoteIds], saved, text: scenario.note.text }));
"""


class TypingMarksTheNoteTest(unittest.TestCase):
    """Typing claims the note from the keystroke, not from the save that follows it."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = TYPING_HARNESS.replace(
            "__METHODS__", method_source(source, "setNotebookNoteText(note, text, save = true, renderTitle = true)"))

    def type(self, text: str, current: str = "before", save: bool = True) -> dict:
        scenario = {"note": {"note_id": "note-1", "text": current}, "text": text, "save": save}
        return run(self.harness, "TERMDECK_TYPING_SCENARIO", scenario, self.node)

    def test_a_keystroke_claims_the_note_before_any_save(self) -> None:
        # The editor writes on a timer; in between, arriving state saw a note with nothing outstanding
        # and put the server's older copy over what was being typed.
        result = self.type("being typed", save=False)

        self.assertEqual(result["dirty"], ["note-1"])
        self.assertEqual(result["saved"], [])

    def test_text_that_did_not_change_claims_nothing(self) -> None:
        result = self.type("before")

        self.assertEqual(result["dirty"], [])


class PageExitTest(unittest.TestCase):
    """A page on its way out writes the note it was in the middle of."""

    def setUp(self) -> None:
        self.source = (STATIC.parent.parent / "termdeck" / "static" / "app.js").read_text()

    def handler(self, name: str) -> str:
        match = re.search(rf'addEventListener\("{name}", \(\) => \{{(.*?)\n    \}}\)', self.source, re.S)
        self.assertIsNotNone(match, f"the {name} handler moved")
        return match.group(1)

    def test_closing_or_hiding_the_page_writes_the_note(self) -> None:
        # The editor saves on a timer; a page closed inside that window took the last thing typed
        # with it, while settings, files and search history were all written on the way out.
        for name in ("pagehide", "beforeunload"):
            self.assertIn("flushNotebook", self.handler(name), name)

    def test_the_tab_going_to_the_background_writes_it_too(self) -> None:
        hidden = re.search(r'visibilityState === "hidden"\) \{(.*?)\n      \}', self.source, re.S).group(1)

        self.assertIn("flushNotebook", hidden)


class RefreshKeepsWhatWasTypedTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = REFRESH_HARNESS.replace("__METHODS__", "\n  ".join(
            method_source(source, name) for name in
            ("async refreshNotebookNote(noteId, known = null)", "rescueRefusedNotebookText(noteId, serverText)")))

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
