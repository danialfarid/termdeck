"""An open notebook follows what the project state says about it.

Nothing redrew the tab strip when notes changed under it, so a note deleted here kept its tab until
something else happened to render -- switching notes, usually. That is what made a delete look like it
had been ignored and then applied late.
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
const scenario = JSON.parse(process.env.TERMDECK_FOLLOW_SCENARIO);
const rendered = [];
let mounted = scenario.mounted !== false;
const app = {
  settings: { notebook_open: scenario.notebookOpen !== false },
  notebookProjectState: () => scenario.state,
  notebookNoteForEditorModel: () => (scenario.editorNoteIsGone ? null : { note_id: "shown" }),
  renderNotebook() { rendered.push({ mountedAtRender: mounted }); },
  get notebookMounted() { return mounted; },
  set notebookMounted(value) { mounted = value; },
  __METHODS__
};
const before = app.notebookSignature();
Object.assign(scenario.state, scenario.next);
app.reconcileNotebookAfterProjectState(before);
process.stdout.write(JSON.stringify({ rendered, mounted, signature: app.notebookSignature() }));
"""


def state(ids: list[str], active: str = "") -> dict:
    return {"notebook_notes": [{"note_id": note_id, "text": ""} for note_id in ids],
            "notebook_active_note_id": active}


class NotebookFollowsProjectStateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__", "\n  ".join(
            method_source(source, name) for name in
            ("notebookSignature()", "reconcileNotebookAfterProjectState(signatureBefore)")))

    def reconcile(self, **scenario: object) -> dict:
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_FOLLOW_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_a_note_that_went_away_redraws_the_tabs(self) -> None:
        result = self.reconcile(state=state(["a", "b"], "a"), next=state(["a"], "a"))

        self.assertEqual(len(result["rendered"]), 1)

    def test_a_note_that_arrived_redraws_them_too(self) -> None:
        # Another window, another device: a note made there should show up here without being asked.
        result = self.reconcile(state=state(["a"], "a"), next=state(["a", "new"], "a"))

        self.assertEqual(len(result["rendered"]), 1)

    def test_the_note_that_is_open_changing_redraws_them(self) -> None:
        result = self.reconcile(state=state(["a", "b"], "a"), next=state(["a", "b"], "b"))

        self.assertEqual(len(result["rendered"]), 1)

    def test_state_that_says_nothing_new_about_notes_redraws_nothing(self) -> None:
        # Project state arrives constantly; the notebook only cares about its own part of it.
        result = self.reconcile(state=state(["a", "b"], "a"), next=state(["a", "b"], "a"))

        self.assertEqual(result["rendered"], [])

    def test_a_closed_notebook_is_left_alone(self) -> None:
        result = self.reconcile(state=state(["a", "b"], "a"), next=state(["a"], "a"), notebookOpen=False)

        self.assertEqual(result["rendered"], [])

    def test_an_editor_left_on_a_note_that_is_gone_is_mounted_again(self) -> None:
        result = self.reconcile(state=state(["a", "b"], "a"), next=state(["b"], "b"), editorNoteIsGone=True)

        self.assertEqual(result["rendered"], [{"mountedAtRender": False}])

    def test_an_editor_on_a_note_that_is_still_there_keeps_what_is_being_typed(self) -> None:
        # Remounting throws away the cursor and the scroll position; a note added elsewhere must not
        # cost the person their place.
        result = self.reconcile(state=state(["a"], "a"), next=state(["a", "new"], "a"))

        self.assertEqual(result["rendered"], [{"mountedAtRender": True}])


class WiredIntoProjectStateTest(unittest.TestCase):
    """The two places project state is taken in both have to ask the notebook to catch up."""

    def setUp(self) -> None:
        self.source = (STATIC / "app.js").read_text()

    def callers(self) -> list[str]:
        return re.findall(r"\n  (?:async )?(\w+)\([^)]*\)\s*\{(?:(?!\n  \w).)*?reconcileNotebookAfterProjectState",
                          self.source, re.S)

    def test_a_broadcast_and_a_refetch_both_ask(self) -> None:
        self.assertEqual(sorted(self.callers()), ["applyProjectStateEvent", "refreshCurrentProjectState"])

    def test_the_signature_is_taken_before_the_state_is_applied(self) -> None:
        # Taken afterwards it would always match, and nothing would ever redraw.
        for caller in ("applyProjectStateEvent", "refreshCurrentProjectState"):
            body = re.search(rf"\n  (?:async )?{caller}\([^)]*\)\s*\{{(?:(?!\n  \w).)*", self.source, re.S).group(0)
            self.assertLess(body.index("notebookSignature()"), body.index("applyLocalProjectStatePatch"), caller)


if __name__ == "__main__":
    unittest.main()
