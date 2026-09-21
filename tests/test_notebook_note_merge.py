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

    def apply(self, current, patch, deleted=()):
        scenario = {"current": current, "patch": patch, "deleted": list(deleted)}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_NOTE_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)["state"]

    def notes(self, current, patch, deleted=()):
        return [entry["note_id"] for entry in self.apply(current, patch, deleted)["notebook_notes"]]

    def test_a_note_the_arriving_state_has_not_heard_of_is_kept(self) -> None:
        # The write for it is still in flight; the broadcast that overtook it knows only the older list.
        kept = self.notes({"notebook_notes": [note("old"), note("just-made")]},
                          {"notebook_notes": [note("old")]})

        self.assertEqual(kept, ["old", "just-made"])

    def test_what_arrives_is_what_those_notes_say(self) -> None:
        # Only the ones it has not heard of are added back; for the rest the server's copy wins, or a
        # note edited in another window would keep this page's older text.
        state = self.apply({"notebook_notes": [note("shared", "mine")]},
                           {"notebook_notes": [note("shared", "theirs")]})

        self.assertEqual(state["notebook_notes"], [note("shared", "theirs")])

    def test_a_note_deleted_here_is_not_put_back(self) -> None:
        # The delete is in flight too, so the state arriving can still carry it.
        kept = self.notes({"notebook_notes": [note("old"), note("binned")]},
                          {"notebook_notes": [note("old"), note("binned")]}, deleted=["binned"])

        self.assertEqual(kept, ["old", "binned"])

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
        kept = self.notes({"notebook_notes": [note("first")]}, {"notebook_notes": []})

        self.assertEqual(kept, ["first"])


if __name__ == "__main__":
    unittest.main()
