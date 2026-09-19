"""A live project-state broadcast reconciles the transcript/terminal surface.

Which surface a terminal opens on is project state, so it changes under an open window: from another
device, from a second window, or from the session-view-mode API. Only the refetch path reconciled it,
and that runs when the tab comes back to the front -- so a window that stayed open kept showing the
transcript for a terminal that had been moved to the terminal surface everywhere else.

The client has no JS harness; as in test_terminal_cycle_order, the methods are lifted out of the shipped
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
METHODS = ("applyProjectStateEvent(message)", "reconcileActiveSessionViewMode()",
           "selectedHistoryMode(session = this.session(this.activeId))",
           "sessionSupportsTranscript(session = this.session(this.activeId))")

HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_VIEW_MODE_SCENARIO);
const ALL_WORKTREES_ID = "all";

const app = {
  projectSlug: "stock",
  worktreeId: "root",
  activeId: scenario.activeId,
  activeFileKey: null,
  historyOpen: scenario.historyOpen,
  sessions: [{ session_id: "agent-1", agent_kind: "claude" }],
  closedSessions: [],
  views: new Map(),
  transcriptSessionStates: new Map(),
  agentSpecs: { claude: { is_agent: true } },
  settings: { transcript_first_surface: "terminal",
              project_state: { stock: { session_view_modes: scenario.currentModes } } },
  setHistoryModeCalls: [],

  agentSpec(kind) { return this.agentSpecs[kind]; },
  session(id) { return this.sessions.find((s) => s.session_id === id) || null; },
  getProjectState() { return this.settings.project_state[this.projectStateKey()] || {}; },
  projectStateKey() { return "stock"; },
  projectStateKeyFor(worktreeId) { return worktreeId === "root" ? "stock" : `stock::worktree:${worktreeId}`; },
  applyLocalProjectStatePatch(patch, stateKey) {
    this.settings.project_state[stateKey] = { ...(this.settings.project_state[stateKey] || {}), ...patch };
  },
  // Everything below is scenery: this test is about the surface, not about the list.
  applySessionOrder(sessions) { return sessions; },
  sessionListSignatureFor(sessions = this.sessions) { return sessions.map((s) => s.session_id).join("|"); },
  unreadSessionIdsForCurrentWorktreeView() { return new Set(); },
  refreshUnreadSessionsFromState() { this.unreadSessions = new Set(); },
  renderList() {},
  renderTopbar() {},
  refresh() {},
  destroyView() {},
  postVscodeNativeClose() {},
  touchMobileLayoutEnabled() { return scenario.touchMobile === true; },
  setHistoryMode(enabled, options) {
    this.setHistoryModeCalls.push({ enabled, options });
    this.historyOpen = enabled;
  },
  __METHODS__
};

app.applyProjectStateEvent(scenario.message);
process.stdout.write(JSON.stringify({ historyOpen: app.historyOpen, calls: app.setHistoryModeCalls }));
"""


class ViewModeReconcileTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = "\n".join((STATIC / name).read_text() for name in ("app.js", "app_markdown_files.js"))
        cls.harness = HARNESS.replace("__METHODS__",
                                      "\n  ".join(method_source(source, name) for name in METHODS))

    def broadcast(self, current_modes, broadcast_modes, history_open, touch_mobile=False,
                  active_id="agent-1"):
        scenario = {
            "activeId": active_id,
            "historyOpen": history_open,
            "currentModes": current_modes,
            "touchMobile": touch_mobile,
            "message": {"project": "stock", "worktree_id": "root",
                        "state": {"session_view_modes": broadcast_modes}},
        }
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_VIEW_MODE_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_a_broadcast_moving_the_terminal_off_the_transcript_is_followed(self) -> None:
        result = self.broadcast(current_modes={"agent-1": "markdown"},
                                broadcast_modes={"agent-1": "terminal"}, history_open=True)

        self.assertFalse(result["historyOpen"])

    def test_it_does_not_write_the_mode_back(self) -> None:
        # It is following what the project state already says. Persisting it again would race whoever
        # set it.
        result = self.broadcast(current_modes={"agent-1": "markdown"},
                                broadcast_modes={"agent-1": "terminal"}, history_open=True)

        self.assertEqual(result["calls"], [{"enabled": False, "options": {"persist": False}}])

    def test_a_broadcast_moving_it_onto_the_transcript_is_followed(self) -> None:
        result = self.broadcast(current_modes={"agent-1": "terminal"},
                                broadcast_modes={"agent-1": "markdown"}, history_open=False)

        self.assertTrue(result["historyOpen"])

    def test_a_broadcast_that_agrees_with_the_window_changes_nothing(self) -> None:
        # Project state is broadcast on every save anywhere in the deck, so this is the common case: it
        # must not touch the surface, which tears down the transcript stream and rebuilds the terminal.
        result = self.broadcast(current_modes={"agent-1": "markdown"},
                                broadcast_modes={"agent-1": "markdown", "other": "terminal"},
                                history_open=True)

        self.assertEqual(result["calls"], [])
        self.assertTrue(result["historyOpen"])

    def test_a_broadcast_about_another_terminal_leaves_this_one_alone(self) -> None:
        result = self.broadcast(current_modes={"agent-1": "markdown"},
                                broadcast_modes={"agent-1": "markdown", "other": "markdown"},
                                history_open=True)

        self.assertEqual(result["calls"], [])

    def test_on_a_phone_an_agent_stays_on_the_transcript(self) -> None:
        # There is no terminal surface for an agent on a phone, so a broadcast saying "terminal" -- which
        # a desktop window is entitled to write -- must not strand it on a surface it cannot show.
        result = self.broadcast(current_modes={"agent-1": "markdown"},
                                broadcast_modes={"agent-1": "terminal"}, history_open=True,
                                touch_mobile=True)

        self.assertTrue(result["historyOpen"])


if __name__ == "__main__":
    unittest.main()
