"""A note this page has just made survives the project state that arrives next.

Project state arrives whole -- from a refetch, or from the broadcast every save anywhere in the deck
produces -- and the copy on the server is only as new as the last write to land. Taking it whole threw
away a note made a moment earlier: the note went from the list, the editor moved to another one, and
everything typed after that went there instead, which is what "the note was not saved" looked like.

The client has no JS harness; as in test_terminal_cycle_order the method is lifted out of the shipped
source and run under node against stubs.
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
const scenario = JSON.parse(process.env.TERMDECK_NOTE_SCENARIO);
const app = {
  settings: { project_state: { stock: scenario.current } },
  deletedNotebookNoteIds: new Set(scenario.deleted || []),
  unsavedNotebookNoteIds: new Set(scenario.unsaved || []),
  projectStateKey() { return "stock"; },
  __METHODS__
};
app.applyLocalProjectStatePatch(scenario.patch, "stock");
process.stdout.write(JSON.stringify({ state: app.settings.project_state.stock }));
"""


def note(note_id: str, text: str = "") -> dict:
    return {"note_id": note_id, "text": text}


class NotebookNoteMergeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__", "\n  ".join(
            method_source(source, name) for name in
            ("applyLocalProjectStatePatch(patch, stateKey = this.projectStateKey())",
             "notebookNotesPatch(patch, current)")))

    def apply(self, current, patch, deleted=(), unsaved=()):
        scenario = {"current": current, "patch": patch, "deleted": list(deleted), "unsaved": list(unsaved)}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_NOTE_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)["state"]

    def notes(self, current, patch, deleted=(), unsaved=()):
        return [entry["note_id"] for entry in self.apply(current, patch, deleted, unsaved)["notebook_notes"]]

    def test_a_note_whose_write_is_still_in_flight_is_kept(self) -> None:
        # The broadcast that overtook the write knows only the older list.
        kept = self.notes({"notebook_notes": [note("old"), note("just-made")]},
                          {"notebook_notes": [note("old")]}, unsaved=["just-made"])

        self.assertEqual(kept, ["old", "just-made"])

    def test_a_note_deleted_in_another_window_goes(self) -> None:
        # Once the server has acknowledged a note, its absence from what arrives is a delete, not a
        # write of ours that has not landed. Holding every note this page has meant a note deleted on
        # the laptop could never leave the phone.
        kept = self.notes({"notebook_notes": [note("old"), note("binned-elsewhere")]},
                          {"notebook_notes": [note("old")]})

        self.assertEqual(kept, ["old"])

    def test_the_note_this_window_is_looking_at_is_its_own_business(self) -> None:
        # Two windows each write their own, so following whatever arrived made the tabs jump to the
        # other window's note and back on every save: one tap read as two highlights.
        state = self.apply({"notebook_notes": [note("a"), note("b")], "notebook_active_note_id": "b",
                            "notebook_text": "mine"},
                           {"notebook_notes": [note("a"), note("b")], "notebook_active_note_id": "a",
                            "notebook_text": "theirs"})

        self.assertEqual(state["notebook_active_note_id"], "b")
        self.assertEqual(state["notebook_text"], "mine")

    def test_when_the_note_it_was_looking_at_is_gone_it_takes_what_arrived(self) -> None:
        state = self.apply({"notebook_notes": [note("a"), note("b")], "notebook_active_note_id": "b"},
                           {"notebook_notes": [note("a")], "notebook_active_note_id": "a"})

        self.assertEqual(state["notebook_active_note_id"], "a")

    def test_a_window_with_no_note_open_takes_what_arrived(self) -> None:
        state = self.apply({"notebook_notes": [], "notebook_active_note_id": ""},
                           {"notebook_notes": [note("a")], "notebook_active_note_id": "a"})

        self.assertEqual(state["notebook_active_note_id"], "a")

    def test_what_arrives_is_what_those_notes_say(self) -> None:
        # Only the ones it has not heard of are added back; for the rest the server's copy wins, or a
        # note edited in another window would keep this page's older text.
        state = self.apply({"notebook_notes": [note("shared", "mine")]},
                           {"notebook_notes": [note("shared", "theirs")]})

        self.assertEqual(state["notebook_notes"], [note("shared", "theirs")])

    def test_a_note_deleted_here_is_gone_even_while_state_still_carries_it(self) -> None:
        # The delete is in flight, so state written before it lands still has the note. Taking that
        # whole put the note back: its tab returned until something else redrew the strip, which is
        # what a delete that "did not take" looked like.
        kept = self.notes({"notebook_notes": [note("old"), note("binned")]},
                          {"notebook_notes": [note("old"), note("binned")]}, deleted=["binned"])

        self.assertEqual(kept, ["old"])

    def test_nor_resurrected_once_the_delete_has_landed(self) -> None:
        kept = self.notes({"notebook_notes": [note("old"), note("binned")]},
                          {"notebook_notes": [note("old")]}, deleted=["binned"])

        self.assertEqual(kept, ["old"])

    def test_state_carrying_no_notes_leaves_them_alone(self) -> None:
        # Most project state has nothing to do with the notebook.
        state = self.apply({"notebook_notes": [note("kept")], "active_session_id": "a"},
                           {"active_session_id": "b"})

        self.assertEqual([entry["note_id"] for entry in state["notebook_notes"]], ["kept"])
        self.assertEqual(state["active_session_id"], "b")

    def test_everything_else_still_arrives_whole(self) -> None:
        # The merge is for notes only: a list of sessions or groups is authoritative as it comes.
        state = self.apply({"session_order": ["a", "b"], "notebook_notes": []},
                           {"session_order": ["b"], "notebook_notes": []})

        self.assertEqual(state["session_order"], ["b"])

    def test_a_first_note_on_a_page_that_had_none_is_kept(self) -> None:
        kept = self.notes({"notebook_notes": [note("first")]}, {"notebook_notes": []}, unsaved=["first"])

        self.assertEqual(kept, ["first"])


REQUEST_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_REQUEST_SCENARIO);
const requests = [];
const app = {
  notebookProjectStateKey: () => "stock",
  notebookProjectState: () => ({ notebook_notes: scenario.notes }),
  unsavedNotebookNoteIds: new Set(),
  queueProjectResourceRequest: (stateKey, path, method, body) => requests.push({ stateKey, path, method, body }),
  __METHODS__
};
if (scenario.call === "saveNotebookNotes") app.saveNotebookNotes();
else app[scenario.call](scenario.notes[0]);
process.stdout.write(JSON.stringify({ requests }));
"""


class NotebookRequestTest(unittest.TestCase):
    """Which call goes out for which act, and that carrying old notes over still lands them."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = REQUEST_HARNESS.replace("__METHODS__", "\n  ".join(
            method_source(source, name) for name in
            ("createNotebookNoteRecord(note)", "saveNotebookNote(note)", "saveNotebookNotes()")))

    def requests(self, call: str, notes: list[dict]) -> list[dict]:
        scenario = {"call": call, "notes": notes}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_REQUEST_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)["requests"]

    def test_a_new_note_is_held_until_the_server_has_it(self) -> None:
        # What arriving state does not carry is either a note of ours in flight or a note deleted
        # somewhere else, and this is what tells them apart.
        scenario = {"call": "createNotebookNoteRecord", "notes": [note("note-new", "hello")]}
        done = subprocess.run([self.node, "-e", self.harness.replace(
            'process.stdout.write(JSON.stringify({ requests }));',
            'process.stdout.write(JSON.stringify({ unsaved: [...app.unsavedNotebookNoteIds] }));')],
            capture_output=True, text=True, check=False,
            env={**os.environ, "TERMDECK_REQUEST_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)

        self.assertEqual(json.loads(done.stdout)["unsaved"], ["note-new"])

    def test_a_new_note_is_created_at_the_id_the_page_gave_it(self) -> None:
        # The page has to show the note before the request comes back, so it names the note itself.
        sent = self.requests("createNotebookNoteRecord", [note("note-new", "hello")])

        self.assertEqual(sent, [{"stateKey": "stock", "path": "/api/notebook/notes", "method": "POST",
                                 "body": {"note_id": "note-new", "text": "hello"}}])

    def test_writing_a_note_writes_that_note_alone(self) -> None:
        sent = self.requests("saveNotebookNote", [note("note-mtem9cgd-w60jdb", "edited")])

        self.assertEqual(sent, [{"stateKey": "stock", "path": "/api/notebook/notes/note-mtem9cgd-w60jdb",
                                 "method": "PUT", "body": {"text": "edited"}}])

    def test_notes_carried_over_from_the_old_notebook_are_each_created(self) -> None:
        # The one time every note is written at once: bringing the notes of the old global notebook
        # into this project. Their ids are the old shape, and they must arrive intact.
        sent = self.requests("saveNotebookNotes",
                             [note("note-mtem9cgd-w60jdb", "old one"), note("note-mu2dqf8l-a5813r", "old two")])

        self.assertEqual([entry["method"] for entry in sent], ["POST", "POST"])
        self.assertEqual([entry["body"]["note_id"] for entry in sent],
                         ["note-mtem9cgd-w60jdb", "note-mu2dqf8l-a5813r"])


if __name__ == "__main__":
    unittest.main()
