"""Slash commands confirm on the send, not on the transcript.

A "/" line the deck does not handle itself -- "/goal resume" on an agent with
no /goal command -- is still a command: the agent runs it without writing it
back as a user turn, so transcript matching could never confirm it and the
entry sat greyed as "not confirmed" until it aged out. These now resolve the
moment the prompt API accepts them, leaving a "sent to the agent terminal"
record behind; a send that fails still lands unconfirmed with its retry. A
path is not a command, and ordinary prompts still wait on the transcript.
"""

import json
import os
import re
import shutil
import subprocess
import time
import unittest
from pathlib import Path

from tests.test_terminal_cycle_order import method_source

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"

HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_SLASH_SCENARIO);
const PENDING_PROMPT_UNCONFIRMED_MS = __UNCONFIRMED__;
const PENDING_PROMPT_DISCARD_MS = __DISCARD__;
const PROMPT_SEND_TIMEOUT_MS = __SEND_TIMEOUT__;
global.window = { setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args), setInterval: () => 0, clearInterval: () => {} };
global.fetch = async () => ({ ok: scenario.fetchOk !== false, json: async () => scenario.fetchBody || {} });
const statusName = { textContent: "" };
const calls = { submitText: 0 };
const app = {
  activeId: "s1",
  historyOpen: false,
  processingStates: new Map(),
  historyPendingPrompts: new Map(),
  historyPendingPromptSequence: 1,
  historyLiveTurnsBySession: new Map(),
  historyTurnsBySession: new Map(),
  historyCommandResultsBySession: new Map(),
  historyPendingProcessing: new Map(),
  pendingPromptRecheckTimer: 0,
  settings: { prompt_history: {} },
  session() { return { agent_kind: "claude" }; },
  agentSpec() { return { transcript_commands: [{ command: "/model", description: "m" },
    { command: "/compact", description: "c" }] }; },
  $(id) {
    if (id === "status-name") return statusName;
    if (id === "history-prompt-history") return { classList: { contains: () => true } };
    return null;
  },
  projectStateKey() { return "test"; },
  saveSettings() {},
  renderHistoryPendingPromptState() {},
  applyHistoryTurns() {},
  combineHistoryWindow(sessionId, live) { return live; },
  applySessionStatus() {},
  submitHistoryPromptText() { calls.submitText += 1; return true; },
  persistMarkdownPromptDraft() {},
  showPromptDraft() {},
  __METHODS__
};
(async () => {
  let output;
  if (scenario.mode === "classify") {
    output = { results: scenario.texts.map((text) => app.historyTextIsUntrackedSlashCommand(text, "s1")) };
  } else if (scenario.mode === "submit") {
    const view = { sessionId: "s1", closed: false, promptApiSubmitting: false };
    const sent = await app.submitHistoryPromptViaApi(view, scenario.text, scenario.fromQueue ? { fromQueue: true } : {});
    output = {
      sent,
      pending: (app.historyPendingPrompts.get("s1") || []).map((item) => ({ text: item.text,
        delivery_state: item.delivery_state })),
      commandResults: (app.historyCommandResultsBySession.get("s1") || []).map((result) =>
        ({ title: result.title, text: result.text })),
      status: statusName.textContent,
      submitTextCalls: calls.submitText,
      history: app.settings.prompt_history.s1 || [],
    };
  } else if (scenario.mode === "merge") {
    app.historyPendingPrompts.set("s1", scenario.pending.map((item) => ({ ...item })));
    const merged = app.mergePendingHistoryPrompts("s1", scenario.turns || []);
    output = {
      merged: merged.map((turn) => ({ role: turn.role, text: turn.text, pending_id: turn.pending_id || null,
        pending_delivery_state: turn.pending_delivery_state || null })),
      remaining: (app.historyPendingPrompts.get("s1") || []).map((item) => ({ text: item.text,
        delivery_state: item.delivery_state })),
    };
  }
  process.stdout.write(JSON.stringify(output));
})();
"""

METHODS = (
    "historyTextIsUntrackedSlashCommand(text, sessionId = this.activeId)",
    "historySlashCommandForText(text, sessionId = this.activeId)",
    "mergePendingHistoryPrompts(sessionId, turns)",
    "historyAuthoritativePromptMatchesPending(authoritativeText, pendingText)",
    "historyPromptComparisonText(text)",
    "historyPromptLooseMatchText(text)",
    "historyTurnTimestampMillis(turn)",
    "async submitHistoryPromptViaApi(view, text, options = {})",
    "stageHistoryPendingPrompt(view, text)",
    "dismissHistoryPendingPrompt(sessionId, pendingId)",
    "setHistoryPendingPromptDeliveryState(sessionId, pendingId, deliveryState)",
    "showHistorySlashCommandResult(view, command, text)",
    "historyPendingPromptStorageKey(sessionId)",
    "persistedHistoryPendingPrompts(sessionId)",
    "persistHistoryPendingPrompts(sessionId, pending = this.historyPendingPrompts.get(sessionId) || [])",
    "syncPendingPromptRecheck(sessionId, pendingCount)",
    "recordPromptHistory(sessionId, text)",
)


class SlashCommandDeliveryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        app_source = (STATIC / "app.js").read_text()
        harness = HARNESS.replace(
            "__METHODS__", "\n  ".join(method_source(source, name) for name in METHODS))
        for placeholder, name in (("__UNCONFIRMED__", "PENDING_PROMPT_UNCONFIRMED_MS"),
                                  ("__DISCARD__", "PENDING_PROMPT_DISCARD_MS"),
                                  ("__SEND_TIMEOUT__", "PROMPT_SEND_TIMEOUT_MS")):
            match = re.search(rf"const {name} = (\d+);", app_source)
            assert match, f"{name} not found in app.js"
            harness = harness.replace(placeholder, match.group(1))
        cls.harness = harness

    def run_scenario(self, scenario: dict) -> dict:
        env = dict(os.environ, TERMDECK_SLASH_SCENARIO=json.dumps(scenario))
        completed = subprocess.run([self.node, "-e", self.harness], env=env,
                                   capture_output=True, text=True, timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stderr[-500:])
        return json.loads(completed.stdout)

    def test_untracked_slash_classification(self) -> None:
        output = self.run_scenario({"mode": "classify", "texts": [
            "/goal resume", "/model", "/compact now", "hello there",
            "/path/to/file explain this", "", "  /goal  ", "/help me",
        ]})
        self.assertEqual(output["results"],
                         [True, False, False, False, False, False, True, True])

    def test_slash_send_confirms_on_api_success(self) -> None:
        output = self.run_scenario({"mode": "submit", "text": "/goal resume"})
        self.assertTrue(output["sent"])
        self.assertEqual(output["pending"], [])
        self.assertEqual(len(output["commandResults"]), 1)
        self.assertEqual(output["commandResults"][0]["title"], "/goal")
        self.assertTrue(output["commandResults"][0]["text"].startswith(
            "/goal resume was sent to the agent terminal."))
        self.assertEqual(output["status"], "/goal sent")
        self.assertEqual(output["submitTextCalls"], 0)
        self.assertIn("/goal resume", output["history"])

    def test_slash_send_failure_stays_unconfirmed(self) -> None:
        output = self.run_scenario({"mode": "submit", "text": "/goal resume",
                                    "fetchOk": False, "fetchBody": {"detail": "nope"}})
        self.assertFalse(output["sent"])
        self.assertEqual(output["pending"],
                         [{"text": "/goal resume", "delivery_state": "unconfirmed"}])
        self.assertEqual(output["commandResults"], [])

    def test_a_prompt_that_did_not_go_in_is_kept(self) -> None:
        # The server says so when a dialog in the terminal would have taken it, or the terminal exited:
        # the message stays to be sent again, and why is shown.
        output = self.run_scenario({"mode": "submit", "text": "hello there", "fromQueue": True, "fetchBody": {
            "prompt_submitted": False, "delivery": "failed",
            "delivery_detail": "Codex is asking whether to update"}})
        self.assertFalse(output["sent"])
        self.assertEqual(output["pending"], [{"text": "hello there", "delivery_state": "unconfirmed"}])
        self.assertIn("Codex is asking whether to update", output["status"])
        self.assertEqual(output["submitTextCalls"], 0)

    def test_a_prompt_that_went_in_unseen_counts_as_sent(self) -> None:
        # Not seen to arrive is not the same as not sent: keeping it would have it sent twice.
        output = self.run_scenario({"mode": "submit", "text": "hello there", "fetchBody": {
            "prompt_submitted": True, "delivery": "unconfirmed", "delivery_detail": "not recorded"}})
        self.assertTrue(output["sent"])
        self.assertEqual(output["submitTextCalls"], 1)

    def test_normal_prompt_still_waits_on_transcript(self) -> None:
        output = self.run_scenario({"mode": "submit", "text": "hello there"})
        self.assertTrue(output["sent"])
        self.assertEqual(output["pending"],
                         [{"text": "hello there", "delivery_state": "awaiting_transcript"}])
        self.assertEqual(output["commandResults"], [])
        self.assertEqual(output["submitTextCalls"], 1)

    def test_merge_drops_legacy_sent_slash(self) -> None:
        # Thirty seconds old: past the unconfirmed threshold but nowhere near the
        # ten-minute discard, so only the send-confirmed branch can drop it.
        output = self.run_scenario({"mode": "merge", "turns": [], "pending": [
            {"text": "/goal resume", "beforeCount": 0, "pending_id": "p1",
             "timestamp": int(time.time() * 1000) - 30000, "delivery_state": "unconfirmed",
             "busy_at_submit": False, "idle_since": 0},
        ]})
        self.assertEqual(output["merged"], [])
        self.assertEqual(output["remaining"], [])

    def test_merge_keeps_slash_still_sending(self) -> None:
        output = self.run_scenario({"mode": "merge", "turns": [], "pending": [
            {"text": "/goal resume", "beforeCount": 0, "pending_id": "p1",
             "timestamp": 9999999999999, "delivery_state": "sending",
             "busy_at_submit": False, "idle_since": 0},
        ]})
        self.assertEqual(len(output["merged"]), 1)
        self.assertEqual(output["merged"][0]["pending_delivery_state"], "sending")
        self.assertEqual(len(output["remaining"]), 1)

    def test_merge_keeps_normal_pending(self) -> None:
        output = self.run_scenario({"mode": "merge", "turns": [], "pending": [
            {"text": "hello there", "beforeCount": 0, "pending_id": "p1",
             "timestamp": 9999999999999, "delivery_state": "awaiting_transcript",
             "busy_at_submit": False, "idle_since": 0},
        ]})
        self.assertEqual(len(output["merged"]), 1)
        self.assertEqual(output["merged"][0]["pending_delivery_state"], "awaiting_transcript")
        self.assertEqual(len(output["remaining"]), 1)
