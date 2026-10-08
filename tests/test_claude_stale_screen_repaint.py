"""A Claude pane restored without its composer and footer asks Claude to redraw.

After a server restart the pane is rebuilt from Claude's recording, and the recording can end short of
the live screen. What that leaves -- conversation with no composer or footer under it -- is not blank,
and the blank-screen check only looked further when a screen was empty, so for Claude it never asked
for the repaint that one resize would have produced. Codex and Muse already had this; Claude now does.

The check is lifted out of the shipped client and run under node against the shipped behaviour table.
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
const scenario = JSON.parse(process.env.TERMDECK_STALE_SCREEN_SCENARIO);
__BEHAVIORS__
const lines = scenario.screen;
const app = {
  agentBehavior: (kind) => AGENT_CLIENT_BEHAVIORS[kind],
  session: () => ({ agent_kind: scenario.agent }),
  __METHODS__
};
const view = {
  sessionId: "t1", closed: false,
  term: { rows: lines.length, buffer: { active: {
    baseY: scenario.scrollback, length: scenario.scrollback + lines.length,
    getLine: (row) => ({ translateToString: () => lines[row - scenario.scrollback] ?? "" }),
  } } },
};
process.stdout.write(JSON.stringify(app.terminalBlankScreenNeedsRepaint(view)));
"""

HEALTHY_IDLE = ["● Done. Both responses now match their titles.", "", "─" * 40, "❯ ", "─" * 40,
                "  ⏵⏵ bypass permissions on (shift+tab to cycle)"]
HEALTHY_DEFAULT = ["● Done.", "", "─" * 40, "> ", "─" * 40, "  ? for shortcuts"]
WORKING = ["● Reading files", "", "✻ Skedaddling… (24s · ↓ 17.0k tokens · esc to interrupt)", "─" * 40, "> "]
# What a restart left on screen: the recording's last paints, with the live region torn off.
STALE = ["● All seven relevant browser tests pass.", "", "● Bash(ls -la ~/.termdeck/diagnostics/)",
         "  ⎿  -rw-r--r--  1 dan  staff  1297 Aug 26 15:50", "", "*     1m 26s · timeout 10m)", "",
         "· Skedaddling…     50s · ↓ 29.8k tokens)"]


class StaleClaudeScreenTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        app_js = (STATIC / "app.js").read_text()
        behaviors = re.search(r"const AGENT_CLIENT_BEHAVIORS = \{.*?\n\};", app_js, re.S).group(0)
        settings_ui = (STATIC / "app_settings_ui.js").read_text()
        cls.harness = HARNESS.replace("__BEHAVIORS__", behaviors).replace(
            "__METHODS__", method_source(settings_ui, "terminalBlankScreenNeedsRepaint(view)"))

    def needs_repaint(self, screen: list[str], scrollback: int = 400, agent: str = "claude") -> bool:
        scenario = {"screen": screen, "scrollback": scrollback, "agent": agent}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_STALE_SCREEN_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_a_screen_restored_without_its_composer_and_footer(self) -> None:
        self.assertTrue(self.needs_repaint(STALE))

    def test_an_idle_screen_in_a_permission_mode_is_left_alone(self) -> None:
        self.assertFalse(self.needs_repaint(HEALTHY_IDLE))

    def test_an_idle_screen_in_the_default_mode_is_left_alone(self) -> None:
        self.assertFalse(self.needs_repaint(HEALTHY_DEFAULT))

    def test_a_screen_mid_turn_is_left_alone(self) -> None:
        self.assertFalse(self.needs_repaint(WORKING))

    def test_a_session_with_no_history_yet_is_just_starting(self) -> None:
        self.assertFalse(self.needs_repaint(STALE, scrollback=0))

    def test_an_empty_screen_over_history(self) -> None:
        self.assertTrue(self.needs_repaint([""] * 8))


if __name__ == "__main__":
    unittest.main()
