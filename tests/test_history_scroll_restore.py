"""A tab's transcript reopens where the reader left it.

Switching tabs saves the transcript scroll position, but the returning
stream's first paint followed the latest output and stomped it, so every
return landed at the bottom. Now a stream opened by a tab switch (or by
reopening the transcript) restores the saved anchor on its first paint when
the anchor is already in, leaves the scroll alone when the anchor sits in a
chunk that has not arrived yet, and retries against the full window when the
snapshot completes. Same-session resyncs and manual refreshes keep following
the latest output as before.
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
const scenario = JSON.parse(process.env.TERMDECK_RESTORE_SCENARIO);
const body = { children: scenario.childKeys.map((key) => ({ dataset: { outlineKey: key } })) };
const calls = { apply: [], restore: 0 };
const app = {
  activeId: "s1",
  historyOpen: true,
  historyLoaded: scenario.historyLoaded,
  historyTurns: new Array(scenario.historyTurnsLen),
  historyStreamFresh: true,
  historyManualRefreshSessionId: "other",
  historyScrollBySession: new Map(scenario.saved ? [["s1", scenario.saved]] : []),
  historyOlderTurnsBySession: new Map(),
  historyCommandResultsBySession: new Map(),
  historyLiveTurnsBySession: new Map(),
  historyBeforeBySession: new Map(),
  historyHasMoreBySession: new Map(),
  $(id) { return id === "history-body" ? body : null; },
  applyHistoryTurns(sessionId, turns, options) {
    calls.apply.push({ preserve: !!options.preserveScroll, follow: !!options.followLatest,
      leave: !!options.leaveScroll });
  },
  restoreHistoryScroll(restoredBody, snapshot) { calls.restore += 1; },
  __METHODS__
};
const buffer = { latestFirst: true, turns: [{ t: 1 }], rendered: scenario.bufferRendered,
  restoreScroll: scenario.bufferRestore, before: null, hasMore: false };
app.renderHistorySnapshotProgress("s1", buffer);
process.stdout.write(JSON.stringify({ apply: calls.apply, restore: calls.restore,
  bufferRestoreAfter: buffer.restoreScroll, bufferRenderedAfter: buffer.rendered }));
"""

METHODS = (
    "renderHistorySnapshotProgress(sessionId, buffer)",
    "historyScrollAnchorPresent(body, snapshot)",
    "historyScrollElementKey(element)",
    "combineHistoryWindow(sessionId, liveTurns)",
)

SAVED_MID = {"top": 100, "atBottom": False, "anchorIndex": 0, "anchorKey": "k2",
             "anchorOccurrence": 0, "anchorOffset": 5}


class HistoryScrollRestoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = HARNESS.replace(
            "__METHODS__", "\n  ".join(method_source(source, name) for name in METHODS))
        cls.client = source
        cls.app_source = (STATIC / "app.js").read_text()

    def run_scenario(self, **scenario: object) -> dict:
        base = {"saved": None, "childKeys": ["k1", "k2", "k3"], "bufferRestore": True,
                "bufferRendered": False, "historyLoaded": False, "historyTurnsLen": 0}
        env = dict(os.environ, TERMDECK_RESTORE_SCENARIO=json.dumps({**base, **scenario}))
        completed = subprocess.run([self.node, "-e", self.harness], env=env,
                                   capture_output=True, text=True, timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stderr[-500:])
        return json.loads(completed.stdout)

    def test_first_paint_restores_a_present_anchor(self) -> None:
        output = self.run_scenario(saved=SAVED_MID)
        self.assertEqual(output["apply"],
                         [{"preserve": False, "follow": False, "leave": True}])
        self.assertEqual(output["restore"], 1)
        self.assertFalse(output["bufferRestoreAfter"])
        self.assertTrue(output["bufferRenderedAfter"])

    def test_first_paint_follows_without_a_saved_position(self) -> None:
        output = self.run_scenario(saved=None)
        self.assertEqual(output["apply"],
                         [{"preserve": False, "follow": True, "leave": False}])
        self.assertEqual(output["restore"], 0)

    def test_first_paint_waits_for_an_anchor_in_a_later_chunk(self) -> None:
        output = self.run_scenario(saved={**SAVED_MID, "anchorKey": "k9"})
        self.assertEqual(output["apply"],
                         [{"preserve": False, "follow": False, "leave": True}])
        self.assertEqual(output["restore"], 0)
        self.assertTrue(output["bufferRestoreAfter"])

    def test_resync_without_restore_intent_still_follows(self) -> None:
        output = self.run_scenario(saved=SAVED_MID, bufferRestore=False)
        self.assertEqual(output["apply"],
                         [{"preserve": False, "follow": True, "leave": False}])
        self.assertEqual(output["restore"], 0)

    def test_saved_bottom_restores_through_the_same_path(self) -> None:
        output = self.run_scenario(saved={**SAVED_MID, "atBottom": True})
        self.assertEqual(output["restore"], 1)
        self.assertFalse(output["bufferRestoreAfter"])

    def test_completed_snapshot_retries_an_unsettled_restore(self) -> None:
        self.assertIn("const restorePending = buffer.restoreScroll === true;", self.client)
        self.assertIn(
            "preserveScroll: !restorePending && this.historyLoaded && this.historyTurns.length > 0",
            self.client)

    def test_tab_switch_and_reopen_request_a_restore(self) -> None:
        self.assertIn("this.connectHistoryStream(historyId, "
                      "{ fresh: previousId !== id, restoreScroll: previousId !== id });", self.client)
        self.assertIn("this.connectHistoryStream(sessionId, { fresh: true, restoreScroll: true });",
                      self.client)
        self.assertIn("this.historyStreamRestoreScroll = options.restoreScroll === true;",
                      self.client)
        self.assertIn("restoreScroll: this.historyStreamRestoreScroll === true,", self.client)

    def test_apply_honors_leaving_the_scroll_alone(self) -> None:
        self.assertIn(
            "if (!options.leaveScroll) this.restoreHistoryScroll(body, scrollSnapshot, turns);",
            self.client)
