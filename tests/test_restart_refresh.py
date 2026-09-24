"""What a page does when the server it was served by restarts.

Everything the page holds came from that server: the settings, the projects and their worktrees, the
state of the panel beside the terminals. Only the terminals were refreshed, so the rest of the deck
went on showing the old server's answers until the page was loaded again by hand -- and when the
restart was an upgrade, the page itself was the old server's and no refresh could fix that.
"""

import json
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"

HARNESS = r"""
const scenario = JSON.parse(process.env.TERMDECK_RESTART_SCENARIO);
const did = [];
globalThis.location = { reload: () => did.push("reload") };
const app = {
  serverInstanceId: scenario.knownInstance,
  serverVersion: scenario.knownVersion,
  views: new Map(),
  scheduleMobileConnectionWarning: () => did.push("mobile-warning"),
  reloadDeckAfterRestart: async () => { did.push("reload-deck-state"); },
  reconnectFocusedConnections: () => did.push("reconnect"),
  flushPendingSettingsSave: () => did.push("flush-settings"),
  flushNotebookOnPageExit: () => did.push("flush-notebook"),
  applySessionStatus() {},
  applyProjectStateEvent() {},
  handle(message) {
    __BRANCH__
  },
};
app.handle({ type: "server_instance", instance_id: scenario.instance, version: scenario.version });
process.stdout.write(JSON.stringify({ did, instance: app.serverInstanceId, version: app.serverVersion }));
"""


def branch_source() -> str:
    """The server_instance branch of the status socket, lifted from the shipped client."""
    source = (STATIC / "app.js").read_text()
    body = re.search(r'if \(message\.type === "server_instance"\) \{(.*?)\n        \}', source, re.S).group(1)
    return body.replace("return;", "return;")


class RestartHandlingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        cls.harness = HARNESS.replace("__BRANCH__", branch_source())

    def handle(self, **scenario: object) -> dict:
        scenario = {"knownInstance": "first", "knownVersion": "0.24.1", **scenario}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_RESTART_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_the_first_message_is_not_a_restart(self) -> None:
        result = self.handle(knownInstance="", knownVersion="", instance="first", version="0.24.1")

        self.assertEqual(result["did"], [])
        self.assertEqual(result["instance"], "first")
        self.assertEqual(result["version"], "0.24.1")

    def test_the_same_server_answering_again_changes_nothing(self) -> None:
        result = self.handle(instance="first", version="0.24.1")

        self.assertEqual(result["did"], [])

    def test_a_restart_reloads_the_whole_deck_rather_than_the_terminals_alone(self) -> None:
        result = self.handle(instance="second", version="0.24.1")

        self.assertIn("reload-deck-state", result["did"])
        self.assertIn("reconnect", result["did"])
        self.assertNotIn("reload", result["did"])

    def test_an_upgrade_loads_the_page_again(self) -> None:
        # The page is the old server's, code as much as state, and no refresh can replace that.
        result = self.handle(instance="second", version="0.25.0")

        self.assertIn("reload", result["did"])
        self.assertNotIn("reload-deck-state", result["did"])

    def test_what_was_typed_is_written_before_the_page_goes(self) -> None:
        result = self.handle(instance="second", version="0.25.0")

        self.assertLess(result["did"].index("flush-notebook"), result["did"].index("reload"))
        self.assertLess(result["did"].index("flush-settings"), result["did"].index("reload"))

    def test_a_server_that_says_no_version_is_treated_as_a_restart(self) -> None:
        # An older server answering a newer page says nothing about its version; refreshing the deck
        # is right for it, and reloading on nothing would be a loop.
        result = self.handle(instance="second", version="")

        self.assertIn("reload-deck-state", result["did"])
        self.assertNotIn("reload", result["did"])
        self.assertEqual(result["version"], "0.24.1")


class ServerSaysWhichVersionTest(unittest.TestCase):
    """The page cannot tell an upgrade from a restart unless the server says which version it is."""

    def test_the_first_frame_carries_the_instance_and_the_version(self) -> None:
        import asyncio
        from unittest.mock import MagicMock

        from fastapi import WebSocketDisconnect

        from termdeck import __version__
        from termdeck.server import TermdeckServer

        sent: list[str] = []

        class Socket:
            async def accept(self) -> None:
                return None

            async def send_text(self, text: str) -> None:
                sent.append(text)
                raise WebSocketDisconnect(1000)

        server = TermdeckServer.__new__(TermdeckServer)
        server.server_instance_id = "instance-1"
        server.manager = MagicMock()
        server.manager.attach_status_client.return_value = object()

        asyncio.run(server._ws_status(Socket()))
        frame = json.loads(sent[0])

        self.assertEqual(frame["type"], "server_instance")
        self.assertEqual(frame["instance_id"], "instance-1")
        self.assertEqual(frame["version"], __version__)


class DeckReloadShapeTest(unittest.TestCase):
    """What the refresh covers: the page's own load does the same things in the same order."""

    def setUp(self) -> None:
        source = (STATIC / "app.js").read_text()
        self.body = re.search(r"\n  async reloadDeckAfterRestart\(\) \{(.*?)\n  \}", source, re.S).group(1)

    def test_it_reloads_what_the_server_holds(self) -> None:
        for call in ("loadSettings()", "loadAgentSpecs()", "loadProjects()", "loadWorktrees()",
                     "refresh()", "refreshCurrentProjectState()"):
            self.assertIn(call, self.body, call)

    def test_it_redraws_what_those_answers_feed(self) -> None:
        for call in ("applySettings()", "renderTopbar()", "renderList()"):
            self.assertIn(call, self.body, call)

    def test_the_settings_are_applied_after_they_are_read(self) -> None:
        self.assertLess(self.body.index("loadSettings()"), self.body.index("applySettings()"))


if __name__ == "__main__":
    unittest.main()
