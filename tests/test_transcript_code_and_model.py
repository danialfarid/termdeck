"""Folded code edits, and the model on the transcript as a control.

A code edit is a wall of diff between one thing the agent said and the next, so it is folded and its own
line carries what a reader scanning for it needs: which file, and how much of it changed. The filter that
used to collapse them now expands them, since folded is what they are unless asked otherwise.

The model beside the composer is picked rather than typed into the terminal. The agent's own picker only
knows the models it lists, so a model from outside that list restarts the terminal on it instead.

The client has no JS harness; as in test_terminal_cycle_order the methods are lifted out of the shipped
source and run under node against stubs.
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

SUMMARY_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_EDIT_SUMMARY_SCENARIO);
const HISTORY_EDIT_SUMMARY_FILES = 2;
const HISTORY_EDIT_SUMMARY_PATH_SEGMENTS = 2;
const app = {
  activeId: "s1",
  session() { return { cwd: scenario.cwd }; },
  __METHODS__
};
process.stdout.write(JSON.stringify({ summary: app.historyEditSummary(scenario.turn) }));
"""


class FoldedEditSummaryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = SUMMARY_HARNESS.replace("__METHODS__", "\n  ".join(
            method_source(source, name) for name in ("historyEditSummary(turn)", "historyEditSummaryPath(path)",
                                                    "historyDiffPath(path)")))

    def summary(self, paths, additions=0, removals=0, cwd="/Users/dan/workspace/stock"):
        diff = [{"kind": "add"}] * additions + [{"kind": "remove"}] * removals
        turn = {"diff_files": [{"path": path} for path in paths], "diff": diff, "text": ""}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ,
                                   "TERMDECK_EDIT_SUMMARY_SCENARIO": json.dumps({"turn": turn, "cwd": cwd})})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)["summary"]

    def test_one_file_is_named_with_what_changed_in_it(self) -> None:
        # "1 file · +2 / −2 lines" was the old line, and it says nothing about which file.
        self.assertEqual(self.summary(["/Users/dan/workspace/stock/trainer/prep/feat_cache.py"], 2, 2),
                         "trainer/prep/feat_cache.py · +2 / −2 lines")

    def test_two_files_are_both_named(self) -> None:
        summary = self.summary(["/Users/dan/workspace/stock/a.py", "/Users/dan/workspace/stock/b.py"], 1, 0)

        self.assertEqual(summary, "a.py, b.py · +1 / −0 lines")

    def test_more_files_than_fit_are_counted_after_the_first_two(self) -> None:
        # The line has to stay one line.
        summary = self.summary([f"/Users/dan/workspace/stock/{name}.py" for name in "abcd"], 4, 1)

        self.assertEqual(summary, "a.py, b.py +2 more · +4 / −1 lines")

    def test_a_path_outside_the_terminal_s_directory_shows_its_tail(self) -> None:
        # An agent working outside its terminal's directory writes absolute paths, and two of those are
        # longer than the line they share. The whole path is in the diff underneath.
        summary = self.summary(["/Users/dan/workspace/termdeck/termdeck/static/dialogs.js"], 6, 1)

        self.assertEqual(summary, "…/static/dialogs.js · +6 / −1 lines")

    def test_a_short_path_outside_it_is_left_whole(self) -> None:
        self.assertEqual(self.summary(["/etc/hosts"], 1, 1), "/etc/hosts · +1 / −1 lines")

    def test_an_edit_with_no_files_says_so(self) -> None:
        self.assertEqual(self.summary([], 0, 0), "file details unavailable · +0 / −0 lines")


class CodeFoldedByDefaultTest(unittest.TestCase):
    """Folded unless asked otherwise, and the filter says "Expand code" rather than the opposite."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.app_js = (STATIC / "app.js").read_text()
        cls.markdown_js = (STATIC / "app_markdown_files.js").read_text()
        cls.index_html = (STATIC / "index.html").read_text()

    def test_code_edits_start_folded(self) -> None:
        self.assertRegex(self.app_js, r"this\.historyEditsCollapsed = true;")

    def test_the_filter_offers_expanding_them(self) -> None:
        self.assertIn('id="history-filter-expand-code"', self.index_html)
        self.assertIn("Expand code", self.index_html)
        self.assertNotIn("Collapse code edits", self.index_html)

    def test_ticking_it_expands_rather_than_collapses(self) -> None:
        # The box drives the same flag the toolbar button does, and that flag means collapsed.
        handler = re.search(r'\$\("history-filter-expand-code"\)\.onchange = \(event\) => \{(.*?)\};',
                            self.markdown_js, re.S)
        self.assertIsNotNone(handler, "the filter is not wired")
        self.assertIn("event.currentTarget.checked === this.historyEditsCollapsed", handler.group(1))

    def test_the_box_shows_ticked_only_while_they_are_expanded(self) -> None:
        self.assertIn("menuToggle.checked = !this.historyEditsCollapsed && hasEdits", self.markdown_js)


MODEL_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_MODEL_PICK_SCENARIO);
const HISTORY_MODEL_OTHER = "__termdeck_other_model__";
const asked = [];
global.uiSelect = async (message, options, config) => {
  asked.push({ kind: "select", title: config.title, current: config.currentValue,
               values: options.map((option) => option.value) });
  return scenario.answers.shift();
};
global.uiPrompt = async (message, value) => { asked.push({ kind: "prompt", value }); return scenario.typed; };
global.uiConfirm = async () => { asked.push({ kind: "confirm" }); return scenario.confirm !== false; };
const applied = [];
const app = {
  activeId: "s1",
  views: new Map(),
  sessionModelById: new Map(),
  historyTurnsBySession: new Map(),
  session() { return { session_id: "s1", agent_kind: "codex" }; },
  sessionInteractionState() { return null; },
  titlePresentation() { return { text: "a terminal" }; },
  historyModelDisplay() { return scenario.current || ""; },
  agentModelSuggestions() { return Promise.resolve(scenario.models); },
  applyHistoryModel(session, view, modelId, effort) { applied.push({ live: [modelId, effort] }); },
  restartSession(sessionId, permission, args, options) {
    applied.push({ restart: options.modelName });
    return Promise.resolve("");
  },
  $() { return { textContent: "" }; },
  __METHODS__
};
app.chooseHistoryModel().then(() => process.stdout.write(JSON.stringify({ asked, applied })));
"""

MODELS = [{"id": "gpt-6-astra", "efforts": ["low", "high", "max"], "defaultEffort": "high"},
          {"id": "gpt-5.6-sol", "efforts": [], "defaultEffort": ""}]


class TranscriptModelPickerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = MODEL_HARNESS.replace("__METHODS__", "\n  ".join(
            method_source(source, name) for name in
            ("async chooseHistoryModel()", "async restartHistoryModelByName(session, current)")))

    def pick(self, answers, current="gpt-5.6-sol", typed="", confirm=True):
        scenario = {"models": MODELS, "answers": answers, "current": current, "typed": typed,
                    "confirm": confirm}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_MODEL_PICK_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_the_level_is_asked_for_after_the_model(self) -> None:
        result = self.pick(["gpt-6-astra", "max"])

        self.assertEqual([step["title"] for step in result["asked"]], ["Change model", "Reasoning level"])
        self.assertEqual(result["applied"], [{"live": ["gpt-6-astra", "max"]}])

    def test_the_levels_offered_are_the_chosen_model_s(self) -> None:
        result = self.pick(["gpt-6-astra", "high"])

        self.assertEqual(result["asked"][1]["values"], ["low", "high", "max"])
        self.assertEqual(result["asked"][1]["current"], "high")

    def test_a_model_with_no_levels_is_applied_at_once(self) -> None:
        result = self.pick(["gpt-5.6-sol"])

        self.assertEqual([step["title"] for step in result["asked"]], ["Change model"])
        self.assertEqual(result["applied"], [{"live": ["gpt-5.6-sol", ""]}])

    def test_the_list_offers_typing_one_it_does_not_have(self) -> None:
        self.assertIn("__termdeck_other_model__", self.pick(["gpt-5.6-sol"])["asked"][0]["values"])

    def test_a_typed_model_restarts_the_terminal_on_it(self) -> None:
        # The agent's picker only knows what it lists, so this one cannot be applied to a running turn.
        result = self.pick(["__termdeck_other_model__"], typed="gpt-7-nova max")

        self.assertEqual(result["applied"], [{"restart": "gpt-7-nova max"}])
        self.assertEqual([step["kind"] for step in result["asked"]], ["select", "prompt", "confirm"])

    def test_declining_the_restart_changes_nothing(self) -> None:
        result = self.pick(["__termdeck_other_model__"], typed="gpt-7-nova", confirm=False)

        self.assertEqual(result["applied"], [])

    def test_typing_nothing_changes_nothing(self) -> None:
        result = self.pick(["__termdeck_other_model__"], typed="   ")

        self.assertEqual(result["applied"], [])

    def test_closing_the_list_changes_nothing(self) -> None:
        self.assertEqual(self.pick([None])["applied"], [])

    def test_closing_the_level_changes_nothing(self) -> None:
        # Half a choice is not a choice: the model alone would run at whatever level it defaults to.
        self.assertEqual(self.pick(["gpt-6-astra", None])["applied"], [])


if __name__ == "__main__":
    unittest.main()
