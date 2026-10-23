"""Opening several terminals at once from the new-terminal dialog, and opening one as a child."""

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from tests.test_terminal_cycle_order import method_source

HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_NEW_TERMINAL_SCENARIO);
const posted = [];
const calls = [];
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  posted.push(body);
  return { ok: true, json: async () => ({ session_id: `s${posted.length}`, project: "" }) };
};
globalThis.uiAlert = async (message) => calls.push(["alert", message]);
const elements = {
  "modal-model": { value: "codex" }, "modal-model-name": { value: "" }, "modal-additional-args": { value: "" },
  "modal-disable-effects": { checked: false }, "modal-disable-effects-field": { classList: { contains: () => true } },
  "modal-permission": { value: "default" }, "modal-session-title": { value: scenario.title },
  "modal-count": { value: scenario.count }, "modal-progress-label": { textContent: "" },
};
const app = {
  modalAfterSessionId: scenario.after, modalAsChild: scenario.asChild, modalGroupId: null, modalTopLevel: false,
  activeId: "active", projectSlug: "", settings: {}, vscodeMode: false, nativeVscodeMode: false,
  sessions: [{ session_id: "active" }, { session_id: "parent" }],
  $: (id) => elements[id],
  session(id) { return this.sessions.find((s) => s.session_id === id) || null; },
  modelNameWithEffort: () => "",
  resolveSessionNameAndReference: () => ({ title: scenario.ref ? "" : scenario.title, session_ref: scenario.ref || "" }),
  showModalDependencyError: (detail) => calls.push(["error", detail.message]),
  worktreeRoot: () => "/tmp", resolveVscodeDefaultCwd: () => "/tmp", stateWorktreeId: () => "root",
  saveSettings() {}, closeModal() {}, terminalGroups: () => [],
  async refresh() { posted.forEach((_body, index) => this.sessions.push({ session_id: `s${index + 1}` })); },
  async setSpawnedParent(ids, parent) { calls.push(["child", ids, parent]); },
  repositionSelectedSessions(ids, target, after) { calls.push(["after", ids, target, after]); },
  activate(id) { calls.push(["activate", id]); },
  __METHODS__
};
app.createSessionFromModal().then(() => {
  process.stdout.write(JSON.stringify({ titles: posted.map((body) => body.title), calls }));
});
"""


class NewTerminalCountTest(unittest.TestCase):
    """How many terminals the dialog opens, what they are called, and where they land."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (Path(__file__).resolve().parent.parent / "termdeck" / "static" / "app_settings_ui.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__", "\n  ".join(method_source(source, signature) for signature in (
            "async createSessionFromModal()",
            "async placeCreatedSessionByAnchor(createdSessionIds, anchorSessionId, asChild = false)")))

    def open(self, count="1", title="fix", after=None, as_child=False, ref=""):
        scenario = {"count": count, "title": title, "after": after, "asChild": as_child, "ref": ref}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_NEW_TERMINAL_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_several_are_numbered_and_land_together_after_the_selected_one(self) -> None:
        result = self.open(count="3")

        self.assertEqual(result["titles"], ["fix 1", "fix 2", "fix 3"])
        self.assertIn(["after", ["s1", "s2", "s3"], "active", True], result["calls"])
        self.assertIn(["activate", "s1"], result["calls"])

    def test_one_keeps_its_name(self) -> None:
        self.assertEqual(self.open(count="1")["titles"], ["fix"])

    def test_the_count_is_held_to_one_through_twenty(self) -> None:
        self.assertEqual(len(self.open(count="99")["titles"]), 20)
        self.assertEqual(len(self.open(count="")["titles"]), 1)

    def test_a_child_is_filed_under_the_terminal_it_was_asked_from(self) -> None:
        result = self.open(count="2", after="parent", as_child=True)

        self.assertIn(["child", ["s1", "s2"], "parent"], result["calls"])

    def test_resuming_opens_only_one(self) -> None:
        result = self.open(count="2", ref="agent-1")

        self.assertEqual(result["titles"], [])
        self.assertEqual(result["calls"][0][0], "error")


if __name__ == "__main__":
    unittest.main()
